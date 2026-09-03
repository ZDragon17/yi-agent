import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initLab, inspectLab, replayLab, runContinuous, runLab } from '../../src/application/agent-service.mjs';
import { LabStore } from '../../src/runtime/lab-store.mjs';
import {
  assertExactKeys,
  assertNonNegativeSafeInteger,
  assertNonEmptyString,
  assertSchemaVersion,
  createWorldPort,
  normalizeWorldFactoryOptions,
} from '../../src/worlds/world-port-base.mjs';
import { canonicalDigest, canonicalJson } from '../../src/runtime/schema.mjs';

test('application service runs a real closed loop and replays it without changing the lab', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'service-lab', worldId: 'temperature', seed: 'service-seed' });
    const result = await runLab({ labPath: lab, runId: 'run-1', steps: 3 });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.metrics.accepted, 3);
    const before = await snapshotFiles(lab);
    const replay = await replayLab({ labPath: lab, runId: 'run-1' });
    assert.equal(replay.verdict, 'CONSISTENT');
    assert.deepEqual(await snapshotFiles(lab), before);
    const inspection = await inspectLab({ labPath: lab });
    assert.equal(inspection.current.status, 'READY');
    assert.equal(inspection.inspectView.schemaVersion, 1);
    assert.equal(inspection.inspectView.run.runId, 'run-1');
    assert.equal(inspection.inspectView.recent.sequence, 4);
    assert.equal(
      Object.values(inspection.inspectView.hypotheses).reduce((sum, model) => sum + model.sampleCount, 0),
      3,
    );
    assert.ok(inspection.inspectView.facts.relationModelCount > 0);
    const actionInspection = await inspectLab({ labPath: lab, action: 'run-1:4' });
    assert.equal(actionInspection.inspectView.selectedAction.sequence, 4);
    assert.equal(actionInspection.inspectView.selectedAction.evidence, 'run-1:4');
  });
});

test('application service continues the verified state across run boundaries', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'continuity-lab', worldId: 'temperature', seed: 'continuity-seed' });
    const first = await runLab({ labPath: lab, runId: 'run-1', steps: 2 });
    const firstState = (await inspectLab({ labPath: lab })).current;
    const second = await runLab({ labPath: lab, runId: 'run-2', steps: 2, scenario: 'regime-shift' });
    const secondState = (await inspectLab({ labPath: lab })).current;
    assert.equal(first.status, 'COMPLETED');
    assert.equal(second.status, 'COMPLETED');
    assert.equal(secondState.kernelStep, firstState.kernelStep + 2);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-2' })).verdict, 'CONSISTENT');
    const historical = await inspectLab({ labPath: lab, action: 'run-1:2' });
    assert.equal(historical.inspectView.run.runId, 'run-1');
    assert.equal(historical.inspectView.selectedAction.sequence, 2);
  });
});

test('15 plus 15 steps has the same continuity projection as one 30-step run', async () => {
  await withLab(async (root) => {
    const splitLab = path.join(root, 'split');
    const wholeLab = path.join(root, 'whole');
    const init = { worldId: 'temperature', seed: 'projection-seed' };
    await initLab({ labPath: splitLab, labId: 'projection-lab', ...init });
    await initLab({ labPath: wholeLab, labId: 'projection-lab', ...init });
    await runLab({ labPath: splitLab, runId: 'run-1', steps: 15 });
    await runLab({ labPath: splitLab, runId: 'run-2', steps: 15 });
    await runLab({ labPath: wholeLab, runId: 'run-1', steps: 30 });
    const split = (await inspectLab({ labPath: splitLab })).current;
    const whole = (await inspectLab({ labPath: wholeLab })).current;
    assert.deepEqual(project(split), project(whole));
  });
});

test('application service halts without acting when every capability is unsafe', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'unsafe-lab', worldId: 'temperature', seed: 'unsafe-seed' });
    const result = await runLab({ labPath: lab, runId: 'run-1', steps: 3, scenario: 'all-unsafe' });
    assert.equal(result.status, 'HALTED');
    assert.equal(result.stopReason, 'NO_SAFE_ACTION');
    assert.equal(result.metrics.executed, 0);
    assert.equal((await inspectLab({ labPath: lab })).current.status, 'HALTED');
  });
});

test('application service records an execution rejection and handles desktop state through the same contract', async () => {
  await withLab(async (root) => {
    const temperatureLab = path.join(root, 'temperature');
    await initLab({ labPath: temperatureLab, labId: 'reject-lab', worldId: 'temperature', seed: 'reject-seed' });
    const rejected = await runLab({ labPath: temperatureLab, runId: 'run-1', steps: 3, scenario: 'execution-rejected' });
    assert.equal(rejected.stopReason, 'EXECUTION_REJECTED');
    assert.equal(rejected.metrics.rejected, 1);
    assert.equal((await replayLab({ labPath: temperatureLab, runId: 'run-1' })).verdict, 'CONSISTENT');

    const desktopLab = path.join(root, 'desktop');
    await initLab({ labPath: desktopLab, labId: 'desktop-lab', worldId: 'virtual-desktop', seed: 'desktop-seed' });
    const desktopResult = await runLab({ labPath: desktopLab, runId: 'run-1', steps: 2, scenario: 'new-files' });
    const current = (await inspectLab({ labPath: desktopLab })).current;
    const protectedItem = current.worldState.items.find((item) => item.protected);
    assert.equal(desktopResult.status, 'COMPLETED');
    assert.deepEqual({ x: protectedItem.x, y: protectedItem.y }, { x: 9, y: 9 });
    assert.equal((await replayLab({ labPath: desktopLab, runId: 'run-1' })).verdict, 'CONSISTENT');
  });
});

test('application service runs and replays two steps through a third-party generated registry', async () => {
  await withLab(async (lab) => {
    const registry = createGeneratedRegistry();
    await initLab({
      labPath: lab,
      labId: 'generated-lab',
      worldId: 'generated',
      seed: 'generated-seed',
      registry,
    });

    const result = await runLab({ labPath: lab, runId: 'run-1', steps: 2, scenario: 'generated', registry });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.metrics.accepted, 2);

    const inspection = await inspectLab({ labPath: lab, registry });
    assert.equal(inspection.current.kernelStep, 2);
    assert.equal(inspection.inspectView.run.runId, 'run-1');

    const storedRun = await (await LabStore.open({ labPath: lab })).readRun('run-1');
    const steps = storedRun.events.filter((event) => event.kind === 'STEP');
    assert.equal(steps.length, 2);
    assert.deepEqual(
      steps.map((event) => event.payload.externalInputs[0]?.payload),
      [{ generated: true, stepVersion: 'state:generated:0' }, { generated: true, stepVersion: 'state:generated:1' }],
    );

    const replay = await replayLab({ labPath: lab, runId: 'run-1', registry });
    assert.equal(replay.verdict, 'CONSISTENT');
  });
});

test('application service runs diverse built-in worlds through one runtime and replay contract', async () => {
  await withLab(async (root) => {
    const cases = [
      ['inventory', 3],
      ['grid', 4],
      ['queue', 3],
    ];

    for (const [worldId, observationDimensions] of cases) {
      const lab = path.join(root, worldId);
      await initLab({ labPath: lab, labId: `${worldId}-lab`, worldId, seed: `${worldId}-seed` });
      const result = await runLab({ labPath: lab, runId: 'run-1', steps: 2 });
      const inspection = await inspectLab({ labPath: lab });
      const storedRun = await (await LabStore.open({ labPath: lab })).readRun('run-1');
      const firstStep = storedRun.events.find((event) => event.kind === 'STEP');

      assert.ok(['COMPLETED', 'HALTED'].includes(result.status));
      assert.ok(result.metrics.executed >= 1, `${worldId} should record at least one step`);
      assert.equal(inspection.inspectView.lab.worldId, worldId);
      assert.equal(inspection.inspectView.recent !== null, true);
      assert.equal(inspection.inspectView.recent.token.startsWith('tok_'), true);
      assert.equal((await replayLab({ labPath: lab, runId: 'run-1' })).verdict, 'CONSISTENT');
      assert.equal(firstStep.payload.beforeObservation.vector.length, observationDimensions);
    }
  });
});

test('application service stops early when an explicit goal is reached', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'goal-lab', worldId: 'temperature', seed: 'goal-seed' });
    let callCount = 0;
    const fakeDigest = `sha256:${'a'.repeat(64)}`;
    const advisor = async ({ capabilities, step }) => {
      callCount += 1;
      const safe = capabilities.filter((c) => c.allowed && c.safe);
      const token = step === 0 ? safe[0].token : safe[1].token;
      return { model: 'test-advisor', token, responseDigest: fakeDigest };
    };
    const result = await runLab({
      labPath: lab,
      runId: 'run-1',
      steps: 10,
      goal: '保持温度在目标值',
      advisor,
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.stopReason, 'OBJECTIVE_REACHED');
    assert.equal(result.metrics.executed, 2);
    assert.equal(callCount, 2);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-1' })).verdict, 'CONSISTENT');
  });
});

test('application service runs full steps when no explicit goal is provided', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'nogoal-lab', worldId: 'temperature', seed: 'nogoal-seed' });
    let callCount = 0;
    const fakeDigest = `sha256:${'a'.repeat(64)}`;
    const advisor = async ({ capabilities, step }) => {
      callCount += 1;
      const safe = capabilities.filter((c) => c.allowed && c.safe);
      const token = step % 2 === 0 ? safe[0].token : safe[1].token;
      return { model: 'test-advisor', token, responseDigest: fakeDigest };
    };
    const result = await runLab({
      labPath: lab,
      runId: 'run-1',
      steps: 5,
      advisor,
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.stopReason, 'COMPLETED');
    assert.equal(result.metrics.executed, 5);
    assert.equal(callCount, 5);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-1' })).verdict, 'CONSISTENT');
  });
});

test('application rejects an isolated initial state on an existing lab', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'initial-state-boundary-lab', worldId: 'temperature', seed: 'initial-state-boundary-seed' });
    await runLab({ labPath: lab, runId: 'run-1', steps: 1 });
    const current = (await inspectLab({ labPath: lab })).current;
    const initialState = {
      worldState: current.worldState,
      memory: current.memory,
      rngState: current.rngState,
      kernelStep: current.kernelStep,
      changeSupervisor: current.changeSupervisor,
    };
    await assert.rejects(
      () => runLab({ labPath: lab, runId: 'run-2', steps: 1, initialState }),
      (error) => error.code === 'CONFLICT' && error.context.field === 'initialState',
    );
  });
});

test('lab continuation does not silently accept a different WorldPort implementation', async () => {
  await withLab(async (lab) => {
    const worldA = createGeneratedRegistry({ stepDelta: 1, worldVersion: 'generated.v1', worldImplementationDigest: `sha256:${'a'.repeat(64)}` });
    const worldB = createGeneratedRegistry({ stepDelta: 2, worldVersion: 'generated.v2', worldImplementationDigest: `sha256:${'b'.repeat(64)}` });
    await initLab({ labPath: lab, labId: 'world-identity-lab', worldId: 'generated', seed: 'world-identity-seed', registry: worldA });
    await runLab({ labPath: lab, runId: 'world-a', steps: 1, scenario: 'generated', registry: worldA });

    await assert.rejects(
      () => runLab({ labPath: lab, runId: 'world-b', steps: 1, scenario: 'generated', registry: worldB }),
      (error) => error.code === 'CONFLICT' && error.context.field === 'worldVersion',
    );
    assert.equal((await inspectLab({ labPath: lab, registry: worldA })).current.worldState.value, 1);
    await assert.rejects(
      () => replayLab({ labPath: lab, runId: 'world-a', registry: worldB }),
      (error) => error.code === 'CONFLICT' && error.context.field === 'worldVersion',
    );
  });
});

test('WorldPort implementation drift is rejected even when its version is unchanged', async () => {
  await withLab(async (lab) => {
    const worldA = createGeneratedRegistry({ stepDelta: 1, worldVersion: 'generated.v1', worldImplementationDigest: `sha256:${'a'.repeat(64)}` });
    const worldB = createGeneratedRegistry({ stepDelta: 2, worldVersion: 'generated.v1', worldImplementationDigest: `sha256:${'b'.repeat(64)}` });
    await initLab({ labPath: lab, labId: 'same-version-drift-lab', worldId: 'generated', seed: 'same-version-drift-seed', registry: worldA });
    await runLab({ labPath: lab, runId: 'world-a', steps: 1, scenario: 'generated', registry: worldA });

    await assert.rejects(
      () => runLab({ labPath: lab, runId: 'world-b', steps: 1, scenario: 'generated', registry: worldB }),
      (error) => error.code === 'CONFLICT' && error.context.field === 'worldImplementationDigest',
    );
    assert.equal((await inspectLab({ labPath: lab, registry: worldA })).current.worldState.value, 1);
  });
});

test('application persists rejection feedback and selects another action after a rejected Run', async () => {
  await withLab(async (lab) => {
    const registry = createRejectionRegistry();
    await initLab({ labPath: lab, labId: 'rejection-memory-lab', worldId: 'feedback', seed: 'rejection-memory-seed', registry });

    const first = await runLab({ labPath: lab, runId: 'run-1', steps: 1, scenario: 'feedback', registry });
    assert.equal(first.status, 'HALTED');
    assert.equal(first.stopReason, 'EXECUTION_REJECTED');
    const afterRejection = (await inspectLab({ labPath: lab, registry })).current;
    const rejectedToken = afterRejection.memory.rejectionModels[registry.rejectedToken];
    assert.equal(rejectedToken.rejected, true);
    assert.equal(rejectedToken.sampleCount, 1);
    const rejectionView = (await inspectLab({ labPath: lab, registry })).inspectView;
    assert.equal(rejectionView.facts.rejectionModelCount, 1);
    assert.equal(rejectionView.hypotheses[registry.rejectedToken].rejectionModel.rejected, true);

    const second = await runLab({ labPath: lab, runId: 'run-2', steps: 1, scenario: 'feedback', registry });
    assert.equal(second.status, 'COMPLETED');
    assert.equal(second.metrics.accepted, 1);
    const afterRecovery = (await inspectLab({ labPath: lab, registry })).current;
    assert.equal(afterRecovery.kernelStep, 2);
    assert.equal(afterRecovery.worldState.value, 1);
    const secondRun = await (await LabStore.open({ labPath: lab })).readRun('run-2');
    assert.equal(secondRun.events.find((event) => event.kind === 'STEP').payload.choice.token, registry.alternativeToken);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-1', registry })).verdict, 'CONSISTENT');
    assert.equal((await replayLab({ labPath: lab, runId: 'run-2', registry })).verdict, 'CONSISTENT');
  });
});

test('bounded planning is persisted at the step boundary and survives replay', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'planning-lab', worldId: 'temperature', seed: 'planning-seed' });
    await runLab({ labPath: lab, runId: 'run-1', steps: 3, planningHorizon: 2 });
    const run = await (await LabStore.open({ labPath: lab })).readRun('run-1');
    const step = run.events.find((event) => event.kind === 'STEP');
    assert.deepEqual(step.payload.boundary.planning, { schemaVersion: 1, horizon: 2, contextMode: 'context-v1', branchingMode: 'tree-v1' });
    assert.equal(step.payload.boundary.kernelLearningVersion, 24);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-1' })).verdict, 'CONSISTENT');
  });
});

test('replay preserves a pre-rejection-memory ledger without rewriting its historical update', async () => {
  await withLab(async (lab) => {
    const registry = createRejectionRegistry();
    await initLab({ labPath: lab, labId: 'legacy-rejection-lab', worldId: 'feedback', seed: 'legacy-rejection-seed', registry });
    await runLab({ labPath: lab, runId: 'run-1', steps: 1, scenario: 'feedback', registry });

    const store = await LabStore.open({ labPath: lab });
    const run = await store.readRun('run-1');
    const stepIndex = run.events.findIndex((event) => event.kind === 'STEP');
    const step = run.events[stepIndex];
    const legacyAfterState = { ...step.payload.afterState, memory: run.start.initialState.memory };
    const { kernelLearningVersion: _ignored, ...legacyBoundary } = step.payload.boundary;
    const legacyStep = {
      ...step,
      payload: {
        ...step.payload,
        boundary: legacyBoundary,
        update: {
          schemaVersion: 1,
          status: 'SKIPPED',
          token: step.payload.choice.token,
          nextMemory: run.start.initialState.memory,
        },
        afterState: legacyAfterState,
        afterDigest: canonicalDigest(legacyAfterState),
      },
    };
    const legacyTerminal = {
      ...run.events.at(-1),
      payload: {
        ...run.events.at(-1).payload,
        finalState: legacyAfterState,
        finalStateDigest: canonicalDigest(legacyAfterState),
      },
    };
    const rewrittenEvents = run.events.map((event, index) => index === stepIndex ? legacyStep : index === run.events.length - 1 ? legacyTerminal : event);
    let previousDigest = null;
    const chainedEvents = rewrittenEvents.map((event) => {
      const unsigned = { ...event, prevDigest: previousDigest };
      delete unsigned.digest;
      const chained = { ...unsigned, digest: canonicalDigest(unsigned) };
      previousDigest = chained.digest;
      return chained;
    });
    await writeFile(path.join(lab, 'runs', 'run-1', 'events.jsonl'), `${chainedEvents.map(canonicalJson).join('\n')}\n`);
    const endBase = {
      ...run.end,
      finalEventDigest: previousDigest,
      finalStateDigest: canonicalDigest(legacyAfterState),
    };
    delete endBase.selfDigest;
    await writeFile(path.join(lab, 'runs', 'run-1', 'end.json'), `${canonicalJson({ ...endBase, selfDigest: canonicalDigest(endBase) })}\n`);

    assert.equal((await replayLab({ labPath: lab, runId: 'run-1', registry })).verdict, 'CONSISTENT');
  });
});

test('application refreshes state-dependent capabilities before each step', async () => {
  await withLab(async (lab) => {
    const registry = createDynamicCapabilitiesRegistry();
    await initLab({ labPath: lab, labId: 'dynamic-capabilities-lab', worldId: 'dynamic-capabilities', seed: 'dynamic-capabilities-seed', registry });
    const first = await runLab({ labPath: lab, runId: 'run-1', steps: 1, scenario: 'dynamic', registry });
    assert.equal(first.status, 'COMPLETED');
    assert.equal(first.metrics.accepted, 1);
    const second = await runLab({ labPath: lab, runId: 'run-2', steps: 1, scenario: 'dynamic', registry });
    assert.equal(second.status, 'COMPLETED');
    assert.equal(second.metrics.accepted, 1);
    const current = (await inspectLab({ labPath: lab, registry })).current;
    assert.equal(current.worldState.value, 2);
    const historical = await inspectLab({ labPath: lab, action: 'run-1:2', registry });
    const historicalActions = historical.inspectView.constraints.actions;
    assert.equal(historicalActions.find((action) => action.token === registry.firstToken).safe, true);
    assert.equal(historicalActions.find((action) => action.token === registry.secondToken).safe, false);
    const historicalRun = await inspectLab({ labPath: lab, runId: 'run-1', registry });
    assert.equal(historicalRun.inspectView.facts.worldState.value, 1);
    assert.equal(historicalRun.inspectView.constraints.actions.find((action) => action.token === registry.firstToken).safe, false);
    assert.equal(historicalRun.inspectView.constraints.actions.find((action) => action.token === registry.secondToken).safe, true);
    const store = await LabStore.open({ labPath: lab });
    assert.equal((await store.readRun('run-1')).events.find((event) => event.kind === 'STEP').payload.choice.token, registry.firstToken);
    assert.equal((await store.readRun('run-2')).events.find((event) => event.kind === 'STEP').payload.choice.token, registry.secondToken);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-1', registry })).verdict, 'CONSISTENT');
    assert.equal((await replayLab({ labPath: lab, runId: 'run-2', registry })).verdict, 'CONSISTENT');
  });
});

test('continuous runner preserves one state across multiple committed run boundaries', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'continuous-lab', worldId: 'temperature', seed: 'continuous-seed' });
    const result = await runContinuous({ labPath: lab, stepsPerRun: 2, runs: 3, runId: 'loop' });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.runs, 3);
    assert.equal(result.metrics.executed, 6);
    const resumed = await runContinuous({ labPath: lab, stepsPerRun: 2, runs: 2, runId: 'loop' });
    assert.equal(resumed.runs, 2);
    assert.equal(resumed.metrics.executed, 4);
    const current = (await inspectLab({ labPath: lab })).current;
    assert.equal(current.kernelStep, 10);
    for (const run of result.results) {
      assert.equal((await replayLab({ labPath: lab, runId: run.runId })).verdict, 'CONSISTENT');
    }
  });
});

test('continuous planning configuration survives interruption and resume', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'planning-loop-lab', worldId: 'temperature', seed: 'planning-loop-seed' });
    let checks = 0;
    const interrupted = await runContinuous({
      labPath: lab,
      stepsPerRun: 1,
      runs: 2,
      planningHorizon: 2,
      shouldStop: () => checks++ > 0,
    });
    assert.equal(interrupted.stopReason, 'INTERRUPTED');
    const store = await LabStore.open({ labPath: lab });
    const continuation = await store.readLoopContinuation();
    assert.equal(continuation.planningHorizon, 2);
    assert.equal(continuation.planningBranchingMode, 'tree-v1');

    const resumed = await runContinuous({ labPath: lab, resume: true });
    assert.equal(resumed.status, 'COMPLETED');
    assert.equal(resumed.runs, 1);
    const run = await store.readRun(resumed.results[0].runId);
    assert.deepEqual(run.events.find((event) => event.kind === 'STEP').payload.boundary.planning, { schemaVersion: 1, horizon: 2, contextMode: 'context-v1', branchingMode: 'tree-v1' });
    assert.equal((await replayLab({ labPath: lab, runId: resumed.results[0].runId })).verdict, 'CONSISTENT');
  });
});

test('continuous runner persists recursive planning branching mode in run boundaries', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'recursive-planning-loop-lab', worldId: 'temperature', seed: 'recursive-planning-loop-seed' });
    const result = await runContinuous({
      labPath: lab,
      stepsPerRun: 1,
      runs: 2,
      planningBranchingMode: 'recursive-v1',
    });
    assert.equal(result.results.length, 2);
    const store = await LabStore.open({ labPath: lab });
    for (const item of result.results) {
      const run = await store.readRun(item.runId);
      const step = run.events.find((event) => event.kind === 'STEP');

      assert.equal(run.start.continuation.planningBranchingMode, 'recursive-v1');
      assert.equal(step.payload.boundary.planning.branchingMode, 'recursive-v1');
      assert.equal((await replayLab({ labPath: lab, runId: item.runId })).verdict, 'CONSISTENT');
    }
  });
});

test('continuous resume honors an objective reached before the persisted run budget', async () => {
  await withLab(async (lab) => {
    const registry = createGeneratedRegistry();
    await initLab({ labPath: lab, labId: 'objective-loop-lab', worldId: 'generated', seed: 'objective-loop-seed', registry });
    const first = await runContinuous({
      labPath: lab,
      stepsPerRun: 1,
      runs: 5,
      scenario: 'generated',
      goal: '推进生成计数器',
      registry,
    });
    assert.equal(first.runs, 2);
    assert.equal(first.results.at(-1).stopReason, 'OBJECTIVE_REACHED');

    const resumed = await runContinuous({ labPath: lab, resume: true, registry });
    assert.equal(resumed.status, 'COMPLETED');
    assert.equal(resumed.stopReason, 'OBJECTIVE_REACHED');
    assert.equal(resumed.runs, 0);
    assert.equal((await inspectLab({ labPath: lab, registry })).current.kernelStep, 2);
  });
});

test('a new continuous loop cannot orphan an unfinished loop continuation', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'single-loop-owner-lab', worldId: 'temperature', seed: 'single-loop-owner-seed' });
    let stopChecks = 0;
    const interrupted = await runContinuous({
      labPath: lab,
      stepsPerRun: 1,
      runs: 3,
      shouldStop: () => stopChecks++ > 0,
    });
    assert.equal(interrupted.stopReason, 'INTERRUPTED');
    await assert.rejects(
      () => runContinuous({ labPath: lab, stepsPerRun: 1, runs: 3 }),
      (error) => error.code === 'CONFLICT' && error.context.continuationId === interrupted.continuationId,
    );
  });
});

test('explicit goal activation persists across a later run that omits the goal', async () => {
  await withLab(async (root) => {
    const lab = path.join(root, 'goal-continuity-lab');
    const registry = createGeneratedRegistry();
    await initLab({ labPath: lab, labId: 'goal-continuity-lab', worldId: 'generated', seed: 'goal-continuity-seed', registry });
    const first = await runLab({ labPath: lab, runId: 'run-1', steps: 1, scenario: 'generated', goal: '推进生成计数器', registry });
    assert.equal(first.stopReason, 'COMPLETED');
    const second = await runLab({ labPath: lab, runId: 'run-2', steps: 5, scenario: 'generated', registry });
    assert.equal(second.status, 'COMPLETED');
    assert.equal(second.stopReason, 'OBJECTIVE_REACHED');
    assert.equal(second.metrics.executed, 1);
    assert.equal((await inspectLab({ labPath: lab, registry })).current.changeSupervisor.enabled, true);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-2', registry })).verdict, 'CONSISTENT');
  });
});

test('a previously untracked lab can acquire a persistent explicit goal on a later run', async () => {
  await withLab(async (root) => {
    const lab = path.join(root, 'late-goal-lab');
    const registry = createGeneratedRegistry();
    await initLab({ labPath: lab, labId: 'late-goal-lab', worldId: 'generated', seed: 'late-goal-seed', registry });
    const first = await runLab({ labPath: lab, runId: 'run-1', steps: 1, scenario: 'generated', registry });
    assert.equal(first.stopReason, 'COMPLETED');
    const second = await runLab({ labPath: lab, runId: 'run-2', steps: 5, scenario: 'generated', goal: '开始监督生成计数器', registry });
    assert.equal(second.stopReason, 'OBJECTIVE_REACHED');
    assert.equal(second.metrics.executed, 1);
    const current = (await inspectLab({ labPath: lab, registry })).current;
    assert.equal(current.changeSupervisor.enabled, true);
    assert.equal(current.changeSupervisor.plan.rootGoal, '开始监督生成计数器');
  });
});

test('application persists and replays a multi-stage goal plan on an opaque WorldPort', async () => {
  await withLab(async (root) => {
    const lab = path.join(root, 'planned-goal-lab');
    const registry = createGeneratedRegistry();
    const goalPlan = {
      schemaVersion: 1,
      rootGoal: '完成生成计数器目标',
      stages: [
        { id: 'first', goal: '先完成第一步', objective: { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [1] } },
        { id: 'final', goal: '再完成最终值', objective: { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [2] } },
      ],
    };
    const stageTargets = [];
    const advisor = async ({ capabilities, valueSpec }) => {
      stageTargets.push([...valueSpec.target]);
      return {
        model: 'planned-test-advisor',
        token: capabilities.find((capability) => capability.allowed && capability.safe).token,
        responseDigest: `sha256:${'b'.repeat(64)}`,
      };
    };
    await initLab({ labPath: lab, labId: 'planned-goal-lab', worldId: 'generated', seed: 'planned-goal-seed', registry });
    const result = await runLab({
      labPath: lab,
      runId: 'run-1',
      steps: 5,
      scenario: 'generated',
      goalPlan,
      advisor,
      registry,
    });
    assert.equal(result.stopReason, 'OBJECTIVE_REACHED');
    assert.equal(result.metrics.executed, 2);
    assert.deepEqual(stageTargets, [[1], [2]]);
    const current = (await inspectLab({ labPath: lab, registry })).current;
    assert.equal(current.changeSupervisor.plan.activeStageId, 'final');
    assert.equal(current.changeSupervisor.plan.revision, 1);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-1', registry })).verdict, 'CONSISTENT');
  });
});

test('continuous runner preserves a goal plan across multiple Run boundaries', async () => {
  await withLab(async (root) => {
    const lab = path.join(root, 'planned-loop-lab');
    const registry = createGeneratedRegistry();
    const goalPlan = {
      schemaVersion: 1,
      rootGoal: '分阶段推进计数器',
      stages: [
        { id: 'first', goal: '第一阶段', objective: { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [1] } },
        { id: 'final', goal: '第二阶段', objective: { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [2] } },
      ],
    };
    await initLab({ labPath: lab, labId: 'planned-loop-lab', worldId: 'generated', seed: 'planned-loop-seed', registry });
    const result = await runContinuous({
      labPath: lab,
      stepsPerRun: 1,
      runs: 2,
      scenario: 'generated',
      goalPlan,
      registry,
    });
    assert.equal(result.runs, 2);
    assert.equal(result.metrics.executed, 2);
    assert.equal(result.results[1].stopReason, 'OBJECTIVE_REACHED');
    assert.equal((await replayLab({ labPath: lab, runId: result.results[0].runId, registry })).verdict, 'CONSISTENT');
    assert.equal((await replayLab({ labPath: lab, runId: result.results[1].runId, registry })).verdict, 'CONSISTENT');
  });
});

test('large compressed plan histories remain inspectable across Run boundaries', async () => {
  await withLab(async (root) => {
    const lab = path.join(root, 'combined-plan-memory-lab');
    const registry = createGeneratedRegistry({ capabilityCount: 128, target: 1000 });
    const goalPlan = {
      schemaVersion: 1,
      rootGoal: '大计划与记忆共同增长',
      stages: Array.from({ length: 128 }, (_, index) => ({
        id: `stage-${index}`,
        goal: 'x'.repeat(4096),
      })),
    };
    goalPlan.stages[0].objective = { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [1000] };
    await initLab({ labPath: lab, labId: 'combined-plan-memory-lab', worldId: 'generated', seed: 'combined-plan-memory-seed', registry });
    const first = await runLab({ labPath: lab, runId: 'run-1', steps: 1, scenario: 'generated', goalPlan, registry });
    const second = await runLab({ labPath: lab, runId: 'run-2', steps: 1000, scenario: 'generated', registry });
    assert.equal(first.status, 'COMPLETED');
    assert.equal(second.status, 'COMPLETED');
    const current = (await inspectLab({ labPath: lab, registry })).current;
    assert.equal(current.status, 'READY');
    assert.equal(current.changeSupervisor.plan.stages.length, 128);
    assert.equal(current.kernelStep, 1001);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-2', registry })).verdict, 'CONSISTENT');
  });
});

test('automatic planner is called once, persists its validated plan, and is not needed after restart', async () => {
  await withLab(async (root) => {
    const lab = path.join(root, 'auto-planned-lab');
    const registry = createGeneratedRegistry();
    let plannerCalls = 0;
    const planner = async ({ goal, observation }) => {
      plannerCalls += 1;
      assert.equal(goal, '自动推进生成计数器');
      assert.deepEqual(observation.vector, [0]);
      return {
        model: 'test-planner',
        responseDigest: `sha256:${'c'.repeat(64)}`,
        plan: {
          rootGoal: goal,
          stages: [
            { id: 'first', goal: '先推进一次', target: [1] },
            { id: 'final', goal: '再推进一次', target: [2] },
          ],
        },
      };
    };
    await initLab({ labPath: lab, labId: 'auto-planned-lab', worldId: 'generated', seed: 'auto-planned-seed', registry });
    const first = await runLab({ labPath: lab, runId: 'run-1', steps: 1, scenario: 'generated', goal: '自动推进生成计数器', planner, registry });
    assert.equal(first.metrics.executed, 1);
    assert.equal(plannerCalls, 1);
    const firstRun = await (await LabStore.open({ labPath: lab })).readRun('run-1');
    assert.equal(firstRun.events.find((event) => event.kind === 'STEP').payload.boundary.goalActivation.planEvidence.applied, true);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-1', registry })).verdict, 'CONSISTENT');

    const second = await runLab({ labPath: lab, runId: 'run-2', steps: 1, scenario: 'generated', registry });
    assert.equal(second.stopReason, 'OBJECTIVE_REACHED');
    assert.equal(plannerCalls, 1);
    const current = (await inspectLab({ labPath: lab, registry })).current;
    assert.equal(current.changeSupervisor.plan.revision, 1);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-2', registry })).verdict, 'CONSISTENT');
  });
});

test('application forwards bounded WorldPort evidence and its truncation marker to custom planners and advisors', async () => {
  await withLab(async (lab) => {
    const registry = createGeneratedRegistry({ evidenceCount: 40 });
    let plannerInput;
    let advisorInput;
    const planner = async (input) => {
      plannerInput = input;
      return {
        model: 'boundary-planner',
        responseDigest: `sha256:${'b'.repeat(64)}`,
        plan: {
          rootGoal: input.goal,
          stages: [{ id: 'advance', goal: '推进到目标', target: [2] }],
        },
      };
    };
    const advisor = async (input) => {
      advisorInput = input;
      return {
        model: 'boundary-advisor',
        responseDigest: `sha256:${'c'.repeat(64)}`,
        observationDigest: `sha256:${'d'.repeat(64)}`,
        token: 'tok_GENERATED01',
        reason: null,
      };
    };
    await initLab({ labPath: lab, labId: 'boundary-lab', worldId: 'generated', seed: 'boundary-seed', registry });
    const result = await runLab({
      labPath: lab,
      runId: 'run-1',
      steps: 1,
      scenario: 'generated',
      goal: '推进到目标',
      planner,
      advisor,
      registry,
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(plannerInput.observationEvidence.length, 32);
    assert.equal(plannerInput.observationEvidenceTruncated, true);
    assert.equal(advisorInput.observationEvidence.length, 32);
    assert.equal(advisorInput.observationEvidenceTruncated, true);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-1', registry })).verdict, 'CONSISTENT');
  });
});

test('model advisor failure is isolated, falls back to the kernel, and remains replayable', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'advisor-outage-lab', worldId: 'temperature', seed: 'advisor-outage-seed' });
    const result = await runLab({
      labPath: lab,
      runId: 'run-1',
      steps: 3,
      advisor: async () => {
        throw new Error('provider outage');
      },
    });
    assert.equal(result.status, 'COMPLETED');
    const run = await (await LabStore.open({ labPath: lab })).readRun('run-1');
    const policyEvidence = run.events.find((event) => event.kind === 'STEP').payload.policyEvidence;
    assert.equal(policyEvidence.model, 'unknown');
    assert.equal(policyEvidence.token, null);
    assert.equal(policyEvidence.applied, false);
    assert.equal(policyEvidence.reason, 'MODEL_UNAVAILABLE');
    assert.equal((await replayLab({ labPath: lab, runId: 'run-1' })).verdict, 'CONSISTENT');
  });
});

test('invalid model advisor output is rejected at the application boundary and remains replayable', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'invalid-advisor-lab', worldId: 'temperature', seed: 'invalid-advisor-seed' });
    const result = await runLab({
      labPath: lab,
      runId: 'run-1',
      steps: 1,
      advisor: async () => ({
        model: 'untrusted-advisor',
        token: 'not-a-capability',
        responseDigest: 'not-a-digest',
      }),
    });
    assert.equal(result.status, 'COMPLETED');
    const run = await (await LabStore.open({ labPath: lab })).readRun('run-1');
    const policyEvidence = run.events.find((event) => event.kind === 'STEP').payload.policyEvidence;
    assert.equal(policyEvidence.token, null);
    assert.equal(policyEvidence.applied, false);
    assert.equal(policyEvidence.reason, 'INVALID_ADVISOR_RESULT');
    assert.match(policyEvidence.responseDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-1' })).verdict, 'CONSISTENT');
  });
});

test('invalid automatic planner proposals fall back to one validated root stage and remain replayable', async () => {
  await withLab(async (root) => {
    const lab = path.join(root, 'invalid-auto-plan-lab');
    const registry = createGeneratedRegistry();
    await initLab({ labPath: lab, labId: 'invalid-auto-plan-lab', worldId: 'generated', seed: 'invalid-auto-plan-seed', registry });
    const result = await runLab({
      labPath: lab,
      runId: 'run-1',
      steps: 1,
      scenario: 'generated',
      goal: '拒绝非法自动计划',
      planner: async () => ({
        model: 'bad-planner',
        responseDigest: `sha256:${'d'.repeat(64)}`,
        observationDigest: 'not-a-digest',
        plan: { rootGoal: '拒绝非法自动计划', stages: [{ id: 'wrong', goal: '错误维度', target: [1, 2] }] },
      }),
      registry,
    });
    assert.equal(result.status, 'COMPLETED');
    const run = await (await LabStore.open({ labPath: lab })).readRun('run-1');
    const activation = run.events.find((event) => event.kind === 'STEP').payload.boundary.goalActivation;
    assert.equal(activation.planEvidence.applied, false);
    assert.equal(activation.planEvidence.reason, 'PLAN_REJECTED');
    assert.equal(Object.hasOwn(activation.planEvidence, 'observationDigest'), false);
    assert.equal((await inspectLab({ labPath: lab, registry })).current.changeSupervisor.plan.stages.length, 1);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-1', registry })).verdict, 'CONSISTENT');
  });
});

test('automatic replanning revises only the unfinished plan and is frozen for Replay', async () => {
  await withLab(async (lab) => {
    let plannerCalls = 0;
    const goal = '在混杂中持续调整';
    const planner = async ({ plan }) => {
      plannerCalls += 1;
      const target = plan === null ? [30] : [25];
      return {
        model: 'replanning-test-planner',
        responseDigest: `sha256:${'e'.repeat(64)}`,
        plan: {
          rootGoal: goal,
          stages: [{ id: 'active', goal: '调整当前阶段', target }],
        },
      };
    };
    await initLab({ labPath: lab, labId: 'replanning-lab', worldId: 'temperature', seed: 'replanning-seed' });
    const result = await runLab({
      labPath: lab,
      runId: 'run-1',
      steps: 2,
      scenario: 'external-during-step',
      goal,
      planner,
      stagnationLimit: 2,
    });
    assert.equal(result.metrics.executed, 2);
    assert.equal(plannerCalls, 2);
    const run = await (await LabStore.open({ labPath: lab })).readRun('run-1');
    const steps = run.events.filter((event) => event.kind === 'STEP');
    assert.equal(steps[0].payload.boundary.goalActivation.planEvidence.applied, true);
    assert.equal(steps[1].payload.boundary.goalReplan.planEvidence.applied, true);
    assert.equal(steps[1].payload.boundary.goalReplan.plan.stages[0].objective.target[0], 25);
    assert.equal((await inspectLab({ labPath: lab })).current.changeSupervisor.plan.revision, 1);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-1' })).verdict, 'CONSISTENT');

    const resumed = await runLab({
      labPath: lab,
      runId: 'run-2',
      steps: 2,
      scenario: 'external-during-step',
      planner,
      autoPlan: false,
    });
    assert.equal(resumed.metrics.executed, 2);
    assert.equal(plannerCalls, 3);
    const resumedRun = await (await LabStore.open({ labPath: lab })).readRun('run-2');
    assert.equal(resumedRun.events.some((event) => event.kind === 'STEP' && event.payload.boundary.goalReplan?.planEvidence.applied === true), true);
    assert.equal((await inspectLab({ labPath: lab })).current.changeSupervisor.plan.revision, 2);
    assert.equal((await replayLab({ labPath: lab, runId: 'run-2' })).verdict, 'CONSISTENT');
  });
});

test('offline continuation records unavailable planner evidence when a persisted plan needs replanning', async () => {
  await withLab(async (lab) => {
    const goal = '离线恢复后保留重规划证据';
    const planner = async ({ plan }) => ({
      model: 'offline-replanning-planner',
      responseDigest: `sha256:${'f'.repeat(64)}`,
      plan: {
        rootGoal: goal,
        stages: [{ id: 'active', goal: '保持当前阶段', target: plan === null ? [30] : [25] }],
      },
    });
    await initLab({ labPath: lab, labId: 'offline-replanning-lab', worldId: 'temperature', seed: 'offline-replanning-seed' });
    await runLab({
      labPath: lab,
      runId: 'run-1',
      steps: 1,
      scenario: 'external-during-step',
      goal,
      autoPlan: true,
      planner,
      stagnationLimit: 2,
    });
    const resumed = await runLab({
      labPath: lab,
      runId: 'run-2',
      steps: 1,
      scenario: 'external-during-step',
    });
    assert.equal(resumed.metrics.executed, 1);
    const run = await (await LabStore.open({ labPath: lab })).readRun('run-2');
    const replan = run.events.find((event) => event.kind === 'STEP').payload.boundary.goalReplan;
    assert.equal(replan.planEvidence.applied, false);
    assert.equal(replan.planEvidence.reason, 'PLANNER_UNAVAILABLE');
    assert.equal((await replayLab({ labPath: lab, runId: 'run-2' })).verdict, 'CONSISTENT');
  });
});

test('an explicit goal plan takes precedence over an inactive persisted planner policy', async () => {
  await withLab(async (lab) => {
    const planner = async () => ({
      model: 'inactive-planner',
      responseDigest: `sha256:${'a'.repeat(64)}`,
      plan: {
        rootGoal: '旧自动目标',
        stages: [{ id: 'old', goal: '旧自动阶段', target: [30] }],
      },
    });
    await initLab({ labPath: lab, labId: 'explicit-plan-lab', worldId: 'temperature', seed: 'explicit-plan-seed' });
    await runLab({
      labPath: lab,
      runId: 'run-1',
      steps: 1,
      scenario: 'all-unsafe',
      goal: '旧自动目标',
      autoPlan: true,
      planner,
    });
    const explicitPlan = {
      schemaVersion: 1,
      rootGoal: '显式目标',
      stages: [{
        id: 'explicit',
        goal: '显式阶段',
        objective: { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [22], tolerance: 0 },
      }],
    };
    await runLab({ labPath: lab, runId: 'run-2', steps: 1, goalPlan: explicitPlan });
    const current = (await inspectLab({ labPath: lab })).current.changeSupervisor;
    assert.equal(current.goal, '显式目标');
    assert.equal(current.plan.rootGoal, '显式目标');
    assert.equal(current.plan.stages[0].id, 'explicit');
  });
});

test('bounded dynamics memory adapts across scenario boundaries and remains replayable', async () => {
  await withLab(async (lab) => {
    const registry = createGeneratedRegistry({ adaptive: true });
    await initLab({ labPath: lab, labId: 'adaptive-lab', worldId: 'generated', seed: 'adaptive-seed', registry });
    await runLab({ labPath: lab, runId: 'baseline', steps: 12, scenario: 'baseline', registry });
    await runLab({ labPath: lab, runId: 'shifted', steps: 1, scenario: 'shifted', registry });

    const current = (await inspectLab({ labPath: lab, registry })).current;
    const model = current.memory.actionModels.tok_GENERATED01;
    assert.equal(model.sampleCount, 13);
    assert.deepEqual(model.meanDelta, [2.125]);
    assert.equal((await replayLab({ labPath: lab, runId: 'baseline', registry })).verdict, 'CONSISTENT');
    assert.equal((await replayLab({ labPath: lab, runId: 'shifted', registry })).verdict, 'CONSISTENT');
  });
});

test('continuous runner can stop a forever policy only between committed runs', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'forever-lab', worldId: 'temperature', seed: 'forever-seed' });
    let stopChecks = 0;
    const result = await runContinuous({
      labPath: lab,
      stepsPerRun: 2,
      forever: true,
      shouldStop: () => stopChecks++ > 0,
      runId: 'forever',
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.stopReason, 'INTERRUPTED');
    assert.equal(result.runs, 1);
    assert.equal(result.metrics.executed, 2);
    assert.equal((await inspectLab({ labPath: lab })).current.kernelStep, 2);
    assert.equal((await replayLab({ labPath: lab, runId: result.results[0].runId })).verdict, 'CONSISTENT');
  });
});

test('forever runner keeps in-memory result retention bounded across many run boundaries', async () => {
  await withLab(async (lab) => {
    await initLab({ labPath: lab, labId: 'forever-retention-lab', worldId: 'temperature', seed: 'forever-retention-seed' });
    let stopChecks = 0;
    const result = await runContinuous({
      labPath: lab,
      stepsPerRun: 1,
      forever: true,
      shouldStop: () => stopChecks++ >= 60,
    });
    assert.ok(result.runs >= 30, `expected many committed runs, got ${result.runs}`);
    assert.equal(result.results.length, 1);
    assert.equal(result.metrics.executed, result.runs);
    assert.equal((await inspectLab({ labPath: lab })).current.kernelStep, result.runs);
  });
});

test('forever runner keeps continuation lookup bounded across a thousand run boundaries', async () => {
  await withLab(async (lab) => {
    const registry = createGeneratedRegistry({ stepDelta: 0 });
    await initLab({ labPath: lab, labId: 'forever-scale-lab', worldId: 'generated', seed: 'forever-scale-seed', registry });
    let stopChecks = 0;
    const result = await runContinuous({
      labPath: lab,
      stepsPerRun: 1,
      forever: true,
      scenario: 'generated',
      shouldStop: () => stopChecks++ >= 2000,
      registry,
    });
    assert.equal(result.runs, 1000);
    assert.equal(result.metrics.executed, 1000);
    assert.equal(result.results.length, 1);
    assert.equal((await inspectLab({ labPath: lab, registry })).current.kernelStep, 1000);

    let resumeChecks = 0;
    const resumed = await runContinuous({
      labPath: lab,
      resume: true,
      shouldStop: () => resumeChecks++ >= 2,
      registry,
    });
    assert.equal(resumed.runs, 1);
    assert.equal(resumed.metrics.executed, 1);
    assert.equal((await inspectLab({ labPath: lab, registry })).current.kernelStep, 1001);
  });
});

test('forever runner preserves the common boundary contract across built-in WorldPorts', async () => {
  await withLab(async (root) => {
    for (const worldId of ['temperature', 'virtual-desktop', 'inventory', 'grid', 'queue']) {
      const lab = path.join(root, worldId);
      await initLab({ labPath: lab, labId: `forever-${worldId}`, worldId, seed: `forever-${worldId}` });
      let stopChecks = 0;
      const result = await runContinuous({
        labPath: lab,
        stepsPerRun: 1,
        forever: true,
        shouldStop: () => stopChecks++ >= 8,
      });
      const current = (await inspectLab({ labPath: lab })).current;
      assert.equal(result.results.length, 1, worldId);
      assert.equal(result.metrics.executed, result.runs, worldId);
      assert.equal(current.kernelStep, result.runs, worldId);
      if (worldId === 'grid') {
        assert.equal(result.status, 'HALTED', worldId);
        assert.equal(result.stopReason, 'EXECUTION_REJECTED', worldId);
        assert.equal(result.runs, 1, worldId);
      } else {
        assert.equal(result.status, 'COMPLETED', worldId);
        assert.equal(result.stopReason, 'INTERRUPTED', worldId);
        assert.equal(result.runs, 4, worldId);
      }
    }
  });
});

test('split and whole runs preserve the same continuity projection across every WorldPort', async () => {
  await withLab(async (root) => {
    for (const worldId of ['temperature', 'virtual-desktop', 'inventory', 'grid', 'queue']) {
      const splitLab = path.join(root, `${worldId}-split`);
      const wholeLab = path.join(root, `${worldId}-whole`);
      const init = { worldId, seed: `${worldId}-projection` };
      await initLab({ labPath: splitLab, labId: `${worldId}-projection`, ...init });
      await initLab({ labPath: wholeLab, labId: `${worldId}-projection`, ...init });
      if (worldId === 'grid') {
        const splitResult = await runLab({ labPath: splitLab, runId: 'run-1', steps: 1 });
        const wholeResult = await runLab({ labPath: wholeLab, runId: 'run-1', steps: 1 });
        assert.equal(splitResult.stopReason, wholeResult.stopReason, worldId);
        assert.deepEqual(project((await inspectLab({ labPath: splitLab })).current), project((await inspectLab({ labPath: wholeLab })).current), worldId);
        assert.equal((await replayLab({ labPath: splitLab, runId: 'run-1' })).verdict, 'CONSISTENT');
        continue;
      }
      await runLab({ labPath: splitLab, runId: 'run-1', steps: 2 });
      await runLab({ labPath: splitLab, runId: 'run-2', steps: 3 });
      await runLab({ labPath: wholeLab, runId: 'run-1', steps: 5 });
      assert.deepEqual(project((await inspectLab({ labPath: splitLab })).current), project((await inspectLab({ labPath: wholeLab })).current), worldId);
      assert.equal((await replayLab({ labPath: splitLab, runId: 'run-2' })).verdict, 'CONSISTENT');
      assert.equal((await replayLab({ labPath: wholeLab, runId: 'run-1' })).verdict, 'CONSISTENT');
    }
  });
});

async function withLab(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-service-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function snapshotFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else files.push([path.relative(root, target), await readFile(target, 'utf8')]);
    }
  }
  await visit(root);
  return files.sort((left, right) => left[0].localeCompare(right[0]));
}

function project(current) {
  return {
    worldState: current.worldState,
    memory: current.memory,
    rngState: current.rngState,
    kernelStep: current.kernelStep,
    changeSupervisor: current.changeSupervisor,
  };
}

function createGeneratedRegistry({ adaptive = false, evidenceCount = 0, stepDelta = 1, target = 2, capabilityCount = 1, worldVersion, worldImplementationDigest } = {}) {
  const worldId = 'generated';
  const scenarioIds = adaptive ? ['baseline', 'shifted'] : ['generated'];
  const capabilityIds = capabilityCount === 1
    ? ['generated.advance']
    : Array.from({ length: capabilityCount }, (_, index) => `generated.advance${index}`);
  const valueSpec = { observationDimensions: 1, weights: [1], target: [target] };

  function createWorld(manifest, scenario = scenarioIds[0]) {
    const options = normalizeWorldFactoryOptions({ manifest, scenario }, worldId, scenarioIds);
    return createWorldPort({
      worldId,
      manifest: {
        schemaVersion: options.manifest.schemaVersion,
        tokenMap: options.manifest.tokenMap,
        authorityPolicy: options.manifest.authorityPolicy,
      },
      scenario: options.scenario,
      capabilityIds,
      makeInitialDomainState: () => ({ value: 0 }),
      normalizeState: (value) => {
        const state = assertExactKeys(
          value,
          ['schemaVersion', 'stateVersion', 'revision', 'value', 'usedExecutionNonces'],
          `${worldId}.state`,
        );
        return {
          schemaVersion: assertSchemaVersion(state.schemaVersion, `${worldId}.state.schemaVersion`),
          stateVersion: assertNonEmptyString(state.stateVersion, `${worldId}.state.stateVersion`),
          revision: assertNonNegativeSafeInteger(state.revision, `${worldId}.state.revision`),
          value: assertNonNegativeSafeInteger(state.value, `${worldId}.state.value`),
          usedExecutionNonces: [...state.usedExecutionNonces],
        };
      },
      observeVector: (state) => [state.value],
      scenarioEvidence: () => Array.from({ length: evidenceCount }, (_, index) => ({ kind: `signal-${index}` })),
      projectCapability: ({ authority, capabilityId, state }) => ({
        allowed: authority.allowed,
        safe: capabilityIds.length === 1 || state?.revision % capabilityIds.length === Number.parseInt(capabilityId.replace(`${worldId}.advance`, ''), 10),
      }),
      applyEffect: ({ state, scenario: activeScenario }) => ({
        accepted: true,
        patch: { value: state.value + (adaptive && activeScenario === 'shifted' ? 10 : stepDelta) },
      }),
    });
  }

  return {
    worldDefinition(requestedWorldId) {
      if (requestedWorldId !== worldId) throw new Error(`Unsupported world: ${requestedWorldId}`);
      return {
        scenarioIds: [...scenarioIds],
        ...(worldVersion === undefined ? {} : { worldVersion }),
        ...(worldImplementationDigest === undefined ? {} : { worldImplementationDigest }),
      };
    },
    createWorld,
    createManifestParts({ labId, seed, worldId: requestedWorldId }) {
      if (requestedWorldId !== worldId) throw new Error(`Unsupported world: ${requestedWorldId}`);
      const entries = capabilityIds.map((capabilityId, index) => ({
        token: capabilityIds.length === 1 ? 'tok_GENERATED01' : `tok_GENERATED${index.toString().padStart(3, '0')}`,
        capabilityId,
      }));
      const tokenMap = {
        schemaVersion: 1,
        entries,
        digest: `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`,
      };
      return {
        scenarioIds: [...scenarioIds],
        ...(worldVersion === undefined ? {} : { worldVersion }),
        ...(worldImplementationDigest === undefined ? {} : { worldImplementationDigest }),
        tokenMap,
        authorityPolicy: {
          schemaVersion: 1,
          policyVersion: `policy:${worldId}:1`,
          constraintsDigest: `sha256:${createHash('sha256').update(`${labId}|${seed}|${worldId}|constraints`).digest('hex')}`,
          capabilities: Object.fromEntries(capabilityIds.map((capabilityId) => [capabilityId, { allowed: true, safe: true, cost: 1 }])),
        },
      };
    },
    valueSpec(requestedWorldId) {
      if (requestedWorldId !== worldId) throw new Error(`Unsupported world: ${requestedWorldId}`);
      return { schemaVersion: 1, ...valueSpec };
    },
    scenarioExternalInputs(requestedWorldId, scenario, stateVersion) {
      if (adaptive || requestedWorldId !== worldId || scenario !== 'generated') return [];
      const payload = { generated: true, stepVersion: stateVersion };
      const input = { schemaVersion: 1, source: 'scenario', kind: scenario, payload, appliedBeforeVersion: stateVersion };
      return [{ ...input, digest: canonicalDigest(input) }];
    },
  };
}

function createRejectionRegistry() {
  const worldId = 'feedback';
  const rejectedCapability = 'feedback.reject';
  const alternativeCapability = 'feedback.advance';
  const rejectedToken = 'tok_FEEDBACKREJECT01';
  const alternativeToken = 'tok_FEEDBACKADVANCE1';
  const capabilityIds = [rejectedCapability, alternativeCapability];
  const scenarioIds = ['feedback'];
  const valueSpec = { observationDimensions: 1, weights: [1], target: [2] };

  function createWorld(manifest, scenario = 'feedback') {
    const options = normalizeWorldFactoryOptions({ manifest, scenario }, worldId, scenarioIds);
    return createWorldPort({
      worldId,
      manifest: {
        schemaVersion: options.manifest.schemaVersion,
        tokenMap: options.manifest.tokenMap,
        authorityPolicy: options.manifest.authorityPolicy,
      },
      scenario: options.scenario,
      capabilityIds,
      makeInitialDomainState: () => ({ value: 0 }),
      normalizeState: (value) => {
        const state = assertExactKeys(value, ['schemaVersion', 'stateVersion', 'revision', 'value', 'usedExecutionNonces'], `${worldId}.state`);
        return {
          schemaVersion: assertSchemaVersion(state.schemaVersion, `${worldId}.state.schemaVersion`),
          stateVersion: assertNonEmptyString(state.stateVersion, `${worldId}.state.stateVersion`),
          revision: assertNonNegativeSafeInteger(state.revision, `${worldId}.state.revision`),
          value: assertNonNegativeSafeInteger(state.value, `${worldId}.state.value`),
          usedExecutionNonces: [...state.usedExecutionNonces],
        };
      },
      observeVector: (state) => [state.value],
      scenarioEvidence: () => [],
      projectCapability: ({ authority }) => ({ allowed: authority.allowed, safe: authority.safe }),
      applyEffect: ({ state, capabilityId }) => capabilityId === rejectedCapability
        ? { accepted: false, rejectionReason: 'TEMPORARY_CONSTRAINT' }
        : { accepted: true, patch: { value: state.value + 1 } },
    });
  }

  const registry = {
    rejectedToken,
    alternativeToken,
    worldDefinition(requestedWorldId) {
      if (requestedWorldId !== worldId) throw new Error(`Unsupported world: ${requestedWorldId}`);
      return { scenarioIds: [...scenarioIds] };
    },
    createWorld,
    createManifestParts({ labId, seed, worldId: requestedWorldId }) {
      if (requestedWorldId !== worldId) throw new Error(`Unsupported world: ${requestedWorldId}`);
      const entries = [
        { token: rejectedToken, capabilityId: rejectedCapability },
        { token: alternativeToken, capabilityId: alternativeCapability },
      ];
      const tokenMap = {
        schemaVersion: 1,
        entries,
        digest: `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`,
      };
      return {
        scenarioIds: [...scenarioIds],
        tokenMap,
        authorityPolicy: {
          schemaVersion: 1,
          policyVersion: `policy:${worldId}:1`,
          constraintsDigest: `sha256:${createHash('sha256').update(`${labId}|${seed}|${worldId}|constraints`).digest('hex')}`,
          capabilities: {
            [rejectedCapability]: { allowed: true, safe: true, cost: 0 },
            [alternativeCapability]: { allowed: true, safe: true, cost: 10 },
          },
        },
      };
    },
    valueSpec(requestedWorldId) {
      if (requestedWorldId !== worldId) throw new Error(`Unsupported world: ${requestedWorldId}`);
      return { schemaVersion: 1, ...valueSpec };
    },
    scenarioExternalInputs() {
      return [];
    },
  };
  return registry;
}

function createDynamicCapabilitiesRegistry() {
  const worldId = 'dynamic-capabilities';
  const firstCapability = 'dynamic.first';
  const secondCapability = 'dynamic.second';
  const firstToken = 'tok_DYNAMICFIRST01';
  const secondToken = 'tok_DYNAMICSECOND1';
  const scenarioIds = ['dynamic'];

  function createWorld(manifest, scenario = 'dynamic') {
    const options = normalizeWorldFactoryOptions({ manifest, scenario }, worldId, scenarioIds);
    return createWorldPort({
      worldId,
      manifest: {
        schemaVersion: options.manifest.schemaVersion,
        tokenMap: options.manifest.tokenMap,
        authorityPolicy: options.manifest.authorityPolicy,
      },
      scenario: options.scenario,
      capabilityIds: [firstCapability, secondCapability],
      makeInitialDomainState: () => ({ value: 0 }),
      normalizeState: (value) => {
        const state = assertExactKeys(value, ['schemaVersion', 'stateVersion', 'revision', 'value', 'usedExecutionNonces'], `${worldId}.state`);
        return {
          schemaVersion: assertSchemaVersion(state.schemaVersion, `${worldId}.state.schemaVersion`),
          stateVersion: assertNonEmptyString(state.stateVersion, `${worldId}.state.stateVersion`),
          revision: assertNonNegativeSafeInteger(state.revision, `${worldId}.state.revision`),
          value: assertNonNegativeSafeInteger(state.value, `${worldId}.state.value`),
          usedExecutionNonces: [...state.usedExecutionNonces],
        };
      },
      observeVector: (state) => [state.value],
      scenarioEvidence: () => [],
      projectCapability: ({ capabilityId, authority, state }) => capabilityId === firstCapability
        ? { allowed: authority.allowed, safe: state?.value === 0 }
        : { allowed: authority.allowed, safe: state?.value >= 1 },
      applyEffect: ({ state, capabilityId }) => capabilityId === firstCapability && state.value > 0
        ? { accepted: false, rejectionReason: 'DYNAMIC_CONSTRAINT' }
        : { accepted: true, patch: { value: state.value + 1 } },
    });
  }

  return {
    firstToken,
    secondToken,
    worldDefinition(requestedWorldId) {
      if (requestedWorldId !== worldId) throw new Error(`Unsupported world: ${requestedWorldId}`);
      return { scenarioIds: [...scenarioIds] };
    },
    createWorld,
    createManifestParts({ labId, seed, worldId: requestedWorldId }) {
      if (requestedWorldId !== worldId) throw new Error(`Unsupported world: ${requestedWorldId}`);
      const entries = [
        { token: firstToken, capabilityId: firstCapability },
        { token: secondToken, capabilityId: secondCapability },
      ];
      const tokenMap = {
        schemaVersion: 1,
        entries,
        digest: `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`,
      };
      return {
        scenarioIds: [...scenarioIds],
        tokenMap,
        authorityPolicy: {
          schemaVersion: 1,
          policyVersion: `policy:${worldId}:1`,
          constraintsDigest: `sha256:${createHash('sha256').update(`${labId}|${seed}|${worldId}|constraints`).digest('hex')}`,
          capabilities: {
            [firstCapability]: { allowed: true, safe: true, cost: 0 },
            [secondCapability]: { allowed: true, safe: true, cost: 1 },
          },
        },
      };
    },
    valueSpec(requestedWorldId) {
      if (requestedWorldId !== worldId) throw new Error(`Unsupported world: ${requestedWorldId}`);
      return { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [2] };
    },
    scenarioExternalInputs() {
      return [];
    },
  };
}

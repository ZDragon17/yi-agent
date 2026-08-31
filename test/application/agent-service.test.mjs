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
        plan: { rootGoal: '拒绝非法自动计划', stages: [{ id: 'wrong', goal: '错误维度', target: [1, 2] }] },
      }),
      registry,
    });
    assert.equal(result.status, 'COMPLETED');
    const run = await (await LabStore.open({ labPath: lab })).readRun('run-1');
    const activation = run.events.find((event) => event.kind === 'STEP').payload.boundary.goalActivation;
    assert.equal(activation.planEvidence.applied, false);
    assert.equal(activation.planEvidence.reason, 'PLAN_REJECTED');
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

function createGeneratedRegistry({ adaptive = false } = {}) {
  const worldId = 'generated';
  const scenarioIds = adaptive ? ['baseline', 'shifted'] : ['generated'];
  const capabilityId = 'generated.advance';
  const valueSpec = { observationDimensions: 1, weights: [1], target: [2] };

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
      capabilityIds: [capabilityId],
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
      scenarioEvidence: () => [],
      projectCapability: ({ authority }) => ({ allowed: authority.allowed, safe: authority.safe }),
      applyEffect: ({ state, scenario: activeScenario }) => ({
        accepted: true,
        patch: { value: state.value + (adaptive && activeScenario === 'shifted' ? 10 : 1) },
      }),
    });
  }

  return {
    worldDefinition(requestedWorldId) {
      if (requestedWorldId !== worldId) throw new Error(`Unsupported world: ${requestedWorldId}`);
      return { scenarioIds: [...scenarioIds] };
    },
    createWorld,
    createManifestParts({ labId, seed, worldId: requestedWorldId }) {
      if (requestedWorldId !== worldId) throw new Error(`Unsupported world: ${requestedWorldId}`);
      const entries = [{ token: 'tok_GENERATED01', capabilityId }];
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
          capabilities: { [capabilityId]: { allowed: true, safe: true, cost: 1 } },
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

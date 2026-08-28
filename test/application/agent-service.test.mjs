import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initLab, inspectLab, replayLab, runLab } from '../../src/application/agent-service.mjs';
import { LabStore } from '../../src/runtime/lab-store.mjs';
import {
  assertExactKeys,
  assertNonNegativeSafeInteger,
  assertNonEmptyString,
  assertSchemaVersion,
  createWorldPort,
  normalizeWorldFactoryOptions,
} from '../../src/worlds/world-port-base.mjs';
import { canonicalDigest } from '../../src/runtime/schema.mjs';

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

function createGeneratedRegistry() {
  const worldId = 'generated';
  const scenarioIds = ['generated'];
  const capabilityId = 'generated.advance';
  const valueSpec = { observationDimensions: 1, weights: [1], target: [2] };

  function createWorld(manifest, scenario = 'generated') {
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
      applyEffect: ({ state }) => ({ accepted: true, patch: { value: state.value + 1 } }),
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
      if (requestedWorldId !== worldId || scenario !== 'generated') return [];
      const payload = { generated: true, stepVersion: stateVersion };
      const input = { schemaVersion: 1, source: 'scenario', kind: scenario, payload, appliedBeforeVersion: stateVersion };
      return [{ ...input, digest: canonicalDigest(input) }];
    },
  };
}

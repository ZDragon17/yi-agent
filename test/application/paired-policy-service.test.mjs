import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initLab, inspectLab, runLab } from '../../src/application/agent-service.mjs';
import { runPairedPolicies } from '../../src/application/paired-policy-service.mjs';
import { projectModelObservation } from '../../src/agent/observation-context.mjs';
import { builtInWorldRegistry } from '../../src/application/world-registry.mjs';
import { LabStore } from '../../src/runtime/lab-store.mjs';

test('paired policy re-observes each step and resumes with the same policy evidence', async () => {
  await withTemp(async (root) => {
    const parent = path.join(root, 'parent');
    const output = path.join(root, 'policy');
    await initLab({ labPath: parent, labId: 'policy-service-lab', worldId: 'temperature', seed: 'policy-service-seed' });
    const parentStore = await LabStore.open({ labPath: parent });
    const tokens = parentStore.manifest.tokenMap.entries.map((entry) => entry.token);
    await runLab({ labPath: parent, runId: 'run-1', steps: 1 });
    const parentInspection = await inspectLab({ labPath: parent });
    const world = builtInWorldRegistry.createWorld(parentStore.manifest, 'steady');
    const contextDigest = projectModelObservation(world.observe(parentInspection.current.worldState)).digest;

    const result = await runPairedPolicies({
      labPath: parent,
      outputPath: output,
      steps: 2,
      leftPolicy: { schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken: tokens[0], rules: [{ observationDigest: contextDigest, token: tokens[1] }] },
      rightPolicy: { schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken: tokens[1], rules: [{ observationDigest: contextDigest, token: tokens[0] }] },
      scenario: 'steady',
    });

    assert.equal(result.verdict, 'PASS');
    assert.equal(result.comparison.pair, 'same-initial-state-policy-v1');
    assert.deepEqual(result.traces.left, [tokens[1], tokens[0]]);
    assert.deepEqual(result.traces.right, [tokens[0], tokens[1]]);
    assert.deepEqual(result.replayVerdicts.left, ['CONSISTENT', 'CONSISTENT']);
    assert.deepEqual(result.replayVerdicts.right, ['CONSISTENT', 'CONSISTENT']);

    const resumed = await runPairedPolicies({ labPath: parent, outputPath: output, resume: true });
    assert.deepEqual(resumed, result);
  });
});

test('paired policy resumes after a committed branch step without repeating its Run', async () => {
  await withTemp(async (root) => {
    const parent = path.join(root, 'parent');
    const output = path.join(root, 'policy');
    await initLab({ labPath: parent, labId: 'policy-recovery-lab', worldId: 'temperature', seed: 'policy-recovery-seed' });
    const parentStore = await LabStore.open({ labPath: parent });
    const tokens = parentStore.manifest.tokenMap.entries.map((entry) => entry.token);
    await runLab({ labPath: parent, runId: 'run-1', steps: 1 });
    const policy = { schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken: tokens[0], rules: [] };

    await assert.rejects(
      () => runPairedPolicies({ labPath: parent, outputPath: output, steps: 2, leftPolicy: policy, rightPolicy: { ...policy, defaultToken: tokens[1] }, failpoint: (point) => point === 'paired-policy:left:after-1' }),
      (error) => error.code === 'INJECTED_FAILURE',
    );
    const resumed = await runPairedPolicies({ labPath: parent, outputPath: output, resume: true });
    assert.equal(resumed.verdict, 'PASS');
    assert.deepEqual(resumed.replayVerdicts.left, ['CONSISTENT', 'CONSISTENT']);
    assert.deepEqual(resumed.replayVerdicts.right, ['CONSISTENT', 'CONSISTENT']);
  });
});

async function withTemp(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-paired-policy-test-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

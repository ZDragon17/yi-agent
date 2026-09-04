import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initLab, inspectLab, runLab } from '../../src/application/agent-service.mjs';
import { runPairedTrajectories } from '../../src/application/paired-trajectory-service.mjs';
import { LabStore } from '../../src/runtime/lab-store.mjs';
import { canonicalDigest } from '../../src/runtime/schema.mjs';

test('paired trajectory runs two bounded token sequences and resumes without repeating committed steps', async () => {
  await withTemp(async (root) => {
    const parent = path.join(root, 'parent');
    const output = path.join(root, 'trajectory');
    await initLab({ labPath: parent, labId: 'trajectory-service-lab', worldId: 'temperature', seed: 'trajectory-service-seed' });
    const parentStore = await LabStore.open({ labPath: parent });
    const tokens = parentStore.manifest.tokenMap.entries.map((entry) => entry.token);
    await runLab({ labPath: parent, runId: 'run-1', steps: 1, advisor: fixedAdvisor(tokens[1], 'parent') });
    const before = (await inspectLab({ labPath: parent })).current.selfDigest;

    const result = await runPairedTrajectories({
      labPath: parent,
      outputPath: output,
      leftTokens: [tokens[0], tokens[0]],
      rightTokens: [tokens[1], tokens[1]],
      scenario: 'steady',
    });

    assert.equal(result.verdict, 'PASS');
    assert.equal(result.comparison.metric, 'terminalGoalDistance');
    assert.equal(result.comparison.verdict, 'LEFT_BETTER');
    assert.deepEqual(result.replayVerdicts.left, ['CONSISTENT', 'CONSISTENT']);
    assert.deepEqual(result.replayVerdicts.right, ['CONSISTENT', 'CONSISTENT']);
    assert.equal((await inspectLab({ labPath: parent })).current.selfDigest, before);

    const resumed = await runPairedTrajectories({ labPath: parent, outputPath: output, resume: true });
    assert.deepEqual(resumed, result);
  });
});

test('paired trajectory resumes after the first left step is durably committed', async () => {
  await withTemp(async (root) => {
    const parent = path.join(root, 'parent');
    const output = path.join(root, 'trajectory');
    await initLab({ labPath: parent, labId: 'trajectory-recovery-lab', worldId: 'temperature', seed: 'trajectory-recovery-seed' });
    const parentStore = await LabStore.open({ labPath: parent });
    const tokens = parentStore.manifest.tokenMap.entries.map((entry) => entry.token);
    await runLab({ labPath: parent, runId: 'run-1', steps: 1, advisor: fixedAdvisor(tokens[1], 'parent') });

    await assert.rejects(
      () => runPairedTrajectories({
        labPath: parent,
        outputPath: output,
        leftTokens: [tokens[0], tokens[0]],
        rightTokens: [tokens[1], tokens[1]],
        failpoint: (point) => point === 'paired-trajectory:left:after-1',
      }),
      (error) => error.code === 'INJECTED_FAILURE' && error.context.point === 'paired-trajectory:left:after-1',
    );

    const resumed = await runPairedTrajectories({ labPath: parent, outputPath: output, resume: true });
    assert.equal(resumed.verdict, 'PASS');
    assert.deepEqual(resumed.replayVerdicts.left, ['CONSISTENT', 'CONSISTENT']);
    assert.deepEqual(resumed.replayVerdicts.right, ['CONSISTENT', 'CONSISTENT']);
  });
});

function fixedAdvisor(token, side) {
  return async () => ({
    model: `trajectory-service-${side}`,
    token,
    responseDigest: canonicalDigest({ token, side }),
    reason: null,
  });
}

async function withTemp(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-paired-trajectory-test-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

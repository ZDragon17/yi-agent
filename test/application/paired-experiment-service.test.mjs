import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initLab, runLab, inspectLab } from '../../src/application/agent-service.mjs';
import { runPairedCandidates } from '../../src/application/paired-experiment-service.mjs';
import { LabStore } from '../../src/runtime/lab-store.mjs';
import { canonicalDigest } from '../../src/runtime/schema.mjs';

test('paired experiment persists two isolated branches and is idempotent on resume', async () => {
  await withTemp(async (root) => {
    const parent = path.join(root, 'parent');
    const output = path.join(root, 'experiment');
    await initLab({ labPath: parent, labId: 'paired-service-lab', worldId: 'temperature', seed: 'paired-service-seed' });
    const parentManifest = (await LabStore.open({ labPath: parent })).manifest;
    const parentToken = parentManifest.tokenMap.entries[0].token;
    await runLab({
      labPath: parent,
      runId: 'run-1',
      steps: 1,
      advisor: fixedAdvisor(parentToken, 'parent'),
    });
    const before = (await inspectLab({ labPath: parent })).current.selfDigest;
    const leftToken = parentManifest.tokenMap.entries[0].token;
    const rightToken = parentManifest.tokenMap.entries[1].token;

    const result = await runPairedCandidates({
      labPath: parent,
      outputPath: output,
      leftToken,
      rightToken,
      scenario: 'regime-shift',
    });

    assert.equal(result.verdict, 'PASS');
    assert.equal(result.comparison.verdict, 'RIGHT_BETTER');
    assert.equal(result.replayVerdicts.left, 'CONSISTENT');
    assert.equal(result.replayVerdicts.right, 'CONSISTENT');
    assert.equal((await inspectLab({ labPath: parent })).current.selfDigest, before);
    assert.match(result.comparison.beforeStateDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(await readFile(path.join(output, 'pair.start.json'), 'utf8').then((value) => value.endsWith('\n')), true);
    assert.equal(await readFile(path.join(output, 'pair.end.json'), 'utf8').then((value) => value.endsWith('\n')), true);

    const resumed = await runPairedCandidates({ labPath: parent, outputPath: output, resume: true });
    assert.deepEqual(resumed, result);
  });
});

test('paired experiment rejects a parent without a terminal Run', async () => {
  await withTemp(async (root) => {
    const parent = path.join(root, 'empty-parent');
    await initLab({ labPath: parent, labId: 'paired-empty-lab', worldId: 'temperature', seed: 'paired-empty-seed' });
    await assert.rejects(
      () => runPairedCandidates({
        labPath: parent,
        outputPath: path.join(root, 'experiment'),
        leftToken: `tok_${'A'.repeat(8)}`,
        rightToken: `tok_${'B'.repeat(8)}`,
      }),
      (error) => error.code === 'CONFLICT' && error.context.field === 'labPath',
    );
  });
});

test('paired experiment resumes after the left branch completed and the process stopped', async () => {
  await withTemp(async (root) => {
    const parent = path.join(root, 'parent');
    const output = path.join(root, 'experiment');
    await initLab({ labPath: parent, labId: 'paired-recovery-lab', worldId: 'temperature', seed: 'paired-recovery-seed' });
    const parentStore = await LabStore.open({ labPath: parent });
    const parentManifest = parentStore.manifest;
    const parentToken = parentManifest.tokenMap.entries[0].token;
    await runLab({
      labPath: parent,
      runId: 'run-1',
      steps: 1,
      advisor: fixedAdvisor(parentToken, 'parent'),
    });
    const leftToken = parentManifest.tokenMap.entries[0].token;
    const rightToken = parentManifest.tokenMap.entries[1].token;

    await assert.rejects(
      () => runPairedCandidates({
        labPath: parent,
        outputPath: output,
        leftToken,
        rightToken,
        scenario: 'regime-shift',
        failpoint: (point) => point === 'paired:after-left',
      }),
      (error) => error.code === 'INJECTED_FAILURE' && error.context.point === 'paired:after-left',
    );
    assert.equal(await readFile(path.join(output, 'pair.start.json'), 'utf8').then((value) => value.endsWith('\n')), true);
    assert.equal((await inspectLab({ labPath: path.join(output, 'left') })).current.lastRunId, 'run-1');

    const resumed = await runPairedCandidates({ labPath: parent, outputPath: output, resume: true });
    assert.equal(resumed.verdict, 'PASS');
    assert.equal(resumed.comparison.verdict, 'RIGHT_BETTER');
    assert.equal(resumed.replayVerdicts.left, 'CONSISTENT');
    assert.equal(resumed.replayVerdicts.right, 'CONSISTENT');
  });
});

test('paired experiment rejects a candidate outside the parent token map before creating output', async () => {
  await withTemp(async (root) => {
    const parent = path.join(root, 'parent');
    const output = path.join(root, 'experiment');
    await initLab({ labPath: parent, labId: 'paired-token-boundary-lab', worldId: 'temperature', seed: 'paired-token-boundary-seed' });
    const parentManifest = (await LabStore.open({ labPath: parent })).manifest;
    const parentToken = parentManifest.tokenMap.entries[0].token;
    await runLab({
      labPath: parent,
      runId: 'run-1',
      steps: 1,
      advisor: fixedAdvisor(parentToken, 'parent'),
    });

    await assert.rejects(
      () => runPairedCandidates({
        labPath: parent,
        outputPath: output,
        leftToken: parentToken,
        rightToken: `tok_${'Z'.repeat(8)}`,
      }),
      (error) => error.code === 'INVALID_INPUT' && error.context.fields.includes('rightToken'),
    );
    await assert.rejects(() => lstat(output), (error) => error.code === 'ENOENT');
  });
});

test('paired experiment revalidates referenced branch evidence when resuming a completed result', async () => {
  await withTemp(async (root) => {
    const parent = path.join(root, 'parent');
    const output = path.join(root, 'experiment');
    await initLab({ labPath: parent, labId: 'paired-integrity-lab', worldId: 'temperature', seed: 'paired-integrity-seed' });
    const parentStore = await LabStore.open({ labPath: parent });
    const parentManifest = parentStore.manifest;
    const parentToken = parentManifest.tokenMap.entries[0].token;
    await runLab({ labPath: parent, runId: 'run-1', steps: 1, advisor: fixedAdvisor(parentToken, 'parent') });
    await runPairedCandidates({
      labPath: parent,
      outputPath: output,
      leftToken: parentManifest.tokenMap.entries[0].token,
      rightToken: parentManifest.tokenMap.entries[1].token,
      scenario: 'steady',
    });

    const currentPath = path.join(output, 'left', 'state', 'current.json');
    const current = JSON.parse(await readFile(currentPath, 'utf8'));
    current.worldState.temperatureC += 1;
    await writeFile(currentPath, `${JSON.stringify(current)}\n`, 'utf8');

    await assert.rejects(
      () => runPairedCandidates({ labPath: parent, outputPath: output, resume: true }),
      (error) => error.code === 'CORRUPT' && error.context.labPath === path.resolve(output, 'left'),
    );
  });
});

function fixedAdvisor(token, side) {
  return async () => ({
    model: `paired-service-${side}`,
    token,
    responseDigest: canonicalDigest({ token, side }),
    reason: null,
  });
}

async function withTemp(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-paired-service-test-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

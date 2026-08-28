import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { challenge } from '../../src/application/challenge-service.mjs';
import { initLab } from '../../src/application/agent-service.mjs';

test('challenge suite runs all registered cases in isolated labs', async () => {
  await withTemp(async (root) => {
    const mainLab = path.join(root, 'main');
    await initLab({ labPath: mainLab, labId: 'main-lab', worldId: 'temperature', seed: 'main-seed' });
    const before = await readFile(path.join(mainLab, 'state/current.json'), 'utf8');
    const result = await challenge({ labPath: mainLab });
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.cases.length, 9);
    assert.ok(result.cases.every((item) => item.verdict === 'PASS'));
    assert.equal(await readFile(path.join(mainLab, 'state/current.json'), 'utf8'), before);
  });
});

test('challenge can run one named case without creating evidence in the main lab', async () => {
  const result = await challenge({ caseId: 'all-unsafe' });
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.cases.map((item) => item.id), ['all-unsafe']);
});

async function withTemp(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-challenge-test-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

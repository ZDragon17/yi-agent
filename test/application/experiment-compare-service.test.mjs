import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runExperimentCompare } from '../../src/application/experiment-compare-service.mjs';
import { projectExperimentMemory } from '../../src/runtime/experiment-policy.mjs';

test('experiment memory projections preserve valid shapes and isolate selected model families', () => {
  const memory = {
    schemaVersion: 1,
    actionModels: {},
    relationModels: {},
    beliefModels: {},
    contextModels: {},
    recentHistory: [],
    historyClock: 0,
    historyAccumulator: '0'.repeat(64),
    lastVerifiedSteps: {},
    lastProbeSteps: {},
    modelClock: 0,
    modelAges: { schemaVersion: 1, actionModels: [], relationModels: [], beliefModels: [], contextModels: [] },
  };
  const fixed = projectExperimentMemory(memory, 'fixed');
  assert.equal(fixed.historyAccumulator.length, 64);
  assert.equal(Object.hasOwn(fixed, 'modelAges'), false);
  assert.deepEqual(projectExperimentMemory(memory, 'without-relation').relationModels, {});
  assert.deepEqual(projectExperimentMemory(memory, 'without-belief').beliefModels, {});
  assert.deepEqual(projectExperimentMemory(memory, 'without-context').contextModels, {});
  assert.deepEqual(memory.relationModels, {});
});

test('experiment compare creates real per-strategy records and consistent Replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-compare-test-'));
  try {
    const result = await runExperimentCompare({
      world: 'temperature',
      scenario: 'steady',
      seeds: ['test-seed-1'],
      steps: 3,
      strategies: ['fixed', 'learned', 'without-relation'],
      outputPath: path.join(root, 'out'),
    });
    assert.equal(result.records, 3);
    assert.equal(result.allReplayConsistent, true);
    const lines = (await readFile(path.join(root, 'out', 'results.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 3);
    for (const line of lines) {
      const row = JSON.parse(line);
      assert.equal(row.worldId, 'temperature');
      assert.equal(row.seed, 'test-seed-1');
      assert.equal(row.replay, 'CONSISTENT');
      assert.ok(typeof row.experimentSourceDigest === 'string');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeR15PairedRuns } from '../../scripts/curriculum/r15-chain-effect-statistics.mjs';

const pairedRuns = ({ baseTraceOf = (index) => `base-${index}`, delta = () => -2 } = {}) =>
  Array.from({ length: 20 }, (_, index) => ({
    baseTraceDigest: baseTraceOf(index),
    chainTraceDigest: `chain-${index}`,
    deltaYuan: delta(index),
  }));

test('R15 permits an interval-based decision when all paired control trajectories are distinct', () => {
  const result = summarizeR15PairedRuns(pairedRuns());

  assert.equal(result.nSeedPairs, 20);
  assert.equal(result.meanDeltaYuan, -2);
  assert.deepEqual(result.nominalCi95Yuan, { low: -2, high: -2 });
  assert.equal(result.uniqueBaseActionTraces, 20);
  assert.equal(result.ciStatus, 'VALID_DISTINCT_BASE_TRACES');
  assert.equal(result.decision, 'CHAIN_BENEFIT');
});

test('R15 refuses an inferential decision when paired seeds repeat control trajectories', () => {
  const result = summarizeR15PairedRuns(pairedRuns({
    baseTraceOf: (index) => index < 10 ? 'base-a' : 'base-b',
  }));

  assert.equal(result.meanDeltaYuan, -2);
  assert.equal(result.uniqueBaseActionTraces, 2);
  assert.equal(result.uniqueChainActionTraces, 20);
  assert.equal(result.uniquePairedActionTraces, 20);
  assert.equal(result.ciStatus, 'INVALID_DUPLICATE_BASE_TRACES');
  assert.equal(result.decision, 'INCONCLUSIVE_DUPLICATE_BASE_TRAJECTORIES');
  assert.equal(result.baseTraceClusters.length, 2);
  assert.deepEqual(result.baseTraceClusters.map((cluster) => cluster.meanDeltaYuan), [-2, -2]);
});

test('R15 rejects a sample that differs from the pre-registered 20 paired seeds', () => {
  assert.throws(() => summarizeR15PairedRuns(pairedRuns().slice(0, 19)), /exactly 20/u);
});

test('R15 rejects non-finite paired outcomes', () => {
  const runs = pairedRuns();
  runs[0].deltaYuan = Number.NaN;
  assert.throws(() => summarizeR15PairedRuns(runs), /finite/u);
});

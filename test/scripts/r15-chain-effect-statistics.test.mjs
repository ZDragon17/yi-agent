import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeR15PairedRuns } from '../../scripts/curriculum/r15-chain-effect-statistics.mjs';

const pairedRuns = ({ baseTraceOf = (index) => `base-${index}`, delta = () => -2 } = {}) =>
  Array.from({ length: 20 }, (_, index) => ({
    baseTraceDigest: baseTraceOf(index),
    chainTraceDigest: `chain-${index}`,
    initialRngState: 1000 + index,
    deltaYuan: delta(index),
  }));

test('R15 reports the fixed seed-sweep interval as exploratory even with distinct traces', () => {
  const result = summarizeR15PairedRuns(pairedRuns());

  assert.equal(result.nSeedPairs, 20);
  assert.equal(result.meanDeltaYuan, -2);
  assert.deepEqual(result.nominalCi95Yuan, { low: -2, high: -2 });
  assert.equal(result.uniqueBaseActionTraces, 20);
  assert.equal(result.uniqueInitialRngStates, 20);
  assert.deepEqual(result.initialRngStateRange, { min: 1000, max: 1019 });
  assert.equal(result.ciStatus, 'EXPLORATORY_FIXED_SEED_SWEEP');
  assert.equal(result.decision, 'INCONCLUSIVE_FIXED_SEED_SWEEP');
});

test('R15 reports repeated traces as coverage while fixed-seed inference stays inconclusive', () => {
  const result = summarizeR15PairedRuns(pairedRuns({
    baseTraceOf: (index) => index < 10 ? 'base-a' : 'base-b',
  }));

  assert.equal(result.meanDeltaYuan, -2);
  assert.equal(result.uniqueBaseActionTraces, 2);
  assert.equal(result.uniqueChainActionTraces, 20);
  assert.equal(result.uniquePairedActionTraces, 20);
  assert.equal(result.ciStatus, 'EXPLORATORY_FIXED_SEED_SWEEP');
  assert.equal(result.decision, 'INCONCLUSIVE_FIXED_SEED_SWEEP');
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

test('R15 rejects a paired run without a recorded initial RNG state', () => {
  const runs = pairedRuns();
  runs[0].initialRngState = null;
  assert.throws(() => summarizeR15PairedRuns(runs), /RNG states/u);
});

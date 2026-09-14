import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeR16PairedRuns } from '../../scripts/curriculum/r16-chain-effect-statistics.mjs';

const pairedRuns = () => Array.from({ length: 20 }, (_, index) => {
  const deltaYuan = index - 10;
  const initialRngState = 1000 + index;
  return {
    seedLabel: `r16-seed-${index}`,
    treatmentOrder: index % 2 === 0
      ? ['utility-base', 'utility-pair']
      : ['utility-pair', 'utility-base'],
    base: {
      initialRngState,
      costYuan: 12000,
      actionTraceDigest: `base-${index}`,
      replay: 'CONSISTENT',
    },
    chain: {
      initialRngState,
      costYuan: 12000 + deltaYuan,
      actionTraceDigest: `chain-${index}`,
      replay: 'CONSISTENT',
    },
    deltaYuan,
  };
});

test('R16 estimates paired cost effect from unique CSPRNG-derived states', () => {
  const result = summarizeR16PairedRuns(pairedRuns());

  assert.equal(result.nSeedPairs, 20);
  assert.equal(result.meanDeltaYuan, -0.5);
  assert.equal(result.medianDeltaYuan, -0.5);
  assert.deepEqual(result.nominalCi95Yuan, { low: -3.27, high: 2.27 });
  assert.equal(result.chainLowerCost, 10);
  assert.equal(result.chainHigherCost, 9);
  assert.equal(result.ties, 1);
  assert.equal(result.uniqueInitialRngStates, 20);
  assert.deepEqual(result.initialRngStateRange, { min: 1000, max: 1019 });
  assert.equal(result.ciStatus, 'APPROXIMATE_RANDOM_SEED_SAMPLE');
  assert.equal(result.decision, 'INCONCLUSIVE_RANDOM_SEED_SWEEP');
});

test('R16 retains repeated action traces as coverage rather than treating them as duplicate samples', () => {
  const pairs = pairedRuns();
  for (const pair of pairs) pair.base.actionTraceDigest = 'same-base-trace';

  const result = summarizeR16PairedRuns(pairs);

  assert.equal(result.uniqueBaseActionTraces, 1);
  assert.equal(result.uniqueInitialRngStates, 20);
});

test('R16 rejects duplicate derived states and mismatched paired states', () => {
  const duplicateStatePairs = pairedRuns();
  duplicateStatePairs[1].base.initialRngState = duplicateStatePairs[0].base.initialRngState;
  duplicateStatePairs[1].chain.initialRngState = duplicateStatePairs[0].chain.initialRngState;
  assert.throws(() => summarizeR16PairedRuns(duplicateStatePairs), /unique labels and initial RNG states/u);

  const mismatchedPair = pairedRuns();
  mismatchedPair[0].chain.initialRngState += 1;
  assert.throws(() => summarizeR16PairedRuns(mismatchedPair), /unique labels and initial RNG states/u);
});

test('R16 requires completed replay-consistent pairs and the planned sample size', () => {
  assert.throws(() => summarizeR16PairedRuns(pairedRuns().slice(0, 19)), /exactly 20/u);

  const incomplete = pairedRuns();
  incomplete[0].chain.replay = 'INCONSISTENT';
  assert.throws(() => summarizeR16PairedRuns(incomplete), /consistent Replay results/u);
});

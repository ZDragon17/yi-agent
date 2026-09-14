import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeR20FactorialRuns } from '../../scripts/curriculum/r20-dynamics-interaction-statistics.mjs';

function factorialRuns() {
  return Array.from({ length: 20 }, (_, index) => {
    const baselineDelta = index - 10;
    const dynamicDelta = baselineDelta + 2;
    const initialRngState = 3000 + index;
    const run = (label, costYuan) => ({
      condition: label,
      costYuan,
      initialRngState,
      replay: 'CONSISTENT',
      actionTraceDigest: `${label}-${index}`,
    });
    return {
      seedLabel: `r20-seed-${index}`,
      baselineBase: run('baseline-base', 12000),
      baselineChain: run('baseline-chain', 12000 + baselineDelta),
      dynamicBase: run('dynamic-base', 12000),
      dynamicChain: run('dynamic-chain', 12000 + dynamicDelta),
    };
  });
}

test('R20 estimates dynamics interaction from same-seed four-cell outcomes', () => {
  const result = summarizeR20FactorialRuns(factorialRuns());

  assert.equal(result.nSeedRuns, 20);
  assert.equal(result.meanBaselineChainDeltaYuan, -0.5);
  assert.equal(result.meanDynamicChainDeltaYuan, 1.5);
  assert.equal(result.meanInteractionDeltaYuan, 2);
  assert.equal(result.medianInteractionDeltaYuan, 2);
  assert.deepEqual(result.nominalCi95InteractionYuan, { low: 2, high: 2 });
  assert.equal(result.uniqueInitialRngStates, 20);
  assert.equal(result.uniqueSeedLabels, 20);
  assert.equal(result.decision, 'EVIDENCE_DYNAMICS_STRESS_INCREASES_CHAIN_COST');
});

test('R20 pairs dynamics deltas within each seed and requires consistent Replay', () => {
  const mismatchedState = factorialRuns();
  mismatchedState[0].dynamicChain.initialRngState += 1;
  assert.throws(() => summarizeR20FactorialRuns(mismatchedState), /same initial RNG state/u);

  const duplicateSeed = factorialRuns();
  duplicateSeed[1].seedLabel = duplicateSeed[0].seedLabel;
  assert.throws(() => summarizeR20FactorialRuns(duplicateSeed), /unique seed labels/u);

  const inconsistent = factorialRuns();
  inconsistent[0].baselineChain.replay = 'INCONSISTENT';
  assert.throws(() => summarizeR20FactorialRuns(inconsistent), /consistent Replay/u);
});

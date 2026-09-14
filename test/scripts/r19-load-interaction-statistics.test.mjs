import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeR19FactorialRuns } from '../../scripts/curriculum/r19-load-interaction-statistics.mjs';

function factorialRuns() {
  return Array.from({ length: 20 }, (_, index) => {
    const normalDelta = index - 10;
    const stressDelta = normalDelta + 2;
    const initialRngState = 2000 + index;
    const run = (label, costYuan) => ({
      condition: label,
      costYuan,
      initialRngState,
      replay: 'CONSISTENT',
      actionTraceDigest: `${label}-${index}`,
    });
    return {
      seedLabel: `r19-seed-${index}`,
      normalBase: run('normal-base', 12000),
      normalChain: run('normal-chain', 12000 + normalDelta),
      stressBase: run('stress-base', 12000),
      stressChain: run('stress-chain', 12000 + stressDelta),
    };
  });
}

test('R19 estimates load stress interaction from same-seed four-cell outcomes', () => {
  const result = summarizeR19FactorialRuns(factorialRuns());

  assert.equal(result.nSeedRuns, 20);
  assert.equal(result.meanNormalChainDeltaYuan, -0.5);
  assert.equal(result.meanStressChainDeltaYuan, 1.5);
  assert.equal(result.meanInteractionDeltaYuan, 2);
  assert.equal(result.medianInteractionDeltaYuan, 2);
  assert.deepEqual(result.nominalCi95InteractionYuan, { low: 2, high: 2 });
  assert.equal(result.uniqueInitialRngStates, 20);
  assert.equal(result.uniqueSeedLabels, 20);
  assert.equal(result.decision, 'EVIDENCE_LOAD_STRESS_INCREASES_CHAIN_COST');
});

test('R19 pairs load deltas within each seed and requires consistent Replay', () => {
  const mismatchedState = factorialRuns();
  mismatchedState[0].stressChain.initialRngState += 1;
  assert.throws(() => summarizeR19FactorialRuns(mismatchedState), /same initial RNG state/u);

  const duplicateSeed = factorialRuns();
  duplicateSeed[1].seedLabel = duplicateSeed[0].seedLabel;
  assert.throws(() => summarizeR19FactorialRuns(duplicateSeed), /unique seed labels/u);

  const inconsistent = factorialRuns();
  inconsistent[0].normalChain.replay = 'INCONSISTENT';
  assert.throws(() => summarizeR19FactorialRuns(inconsistent), /consistent Replay/u);
});

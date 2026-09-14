import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeR18FactorialRuns } from '../../scripts/curriculum/r18-chain-tariff-interaction-statistics.mjs';

function factorialRuns() {
  return Array.from({ length: 20 }, (_, index) => {
    const staticDelta = index - 10;
    const flipDelta = staticDelta + 2;
    const initialRngState = 1000 + index;
    const run = (label, costYuan) => ({
      condition: label,
      costYuan,
      initialRngState,
      replay: 'CONSISTENT',
      actionTraceDigest: `${label}-${index}`,
    });
    return {
      seedLabel: `r18-seed-${index}`,
      staticBase: run('static-base', 12000),
      staticChain: run('static-chain', 12000 + staticDelta),
      flipBase: run('flip-base', 12000),
      flipChain: run('flip-chain', 12000 + flipDelta),
    };
  });
}

test('R18 estimates tariff interaction from same-seed four-cell outcomes', () => {
  const result = summarizeR18FactorialRuns(factorialRuns());

  assert.equal(result.nSeedRuns, 20);
  assert.equal(result.meanStaticChainDeltaYuan, -0.5);
  assert.equal(result.meanFlipChainDeltaYuan, 1.5);
  assert.equal(result.meanInteractionDeltaYuan, 2);
  assert.equal(result.medianInteractionDeltaYuan, 2);
  assert.deepEqual(result.nominalCi95InteractionYuan, { low: 2, high: 2 });
  assert.equal(result.uniqueInitialRngStates, 20);
  assert.equal(result.uniqueSeedLabels, 20);
  assert.equal(result.decision, 'EVIDENCE_TARIFF_INTERACTION_INCREASES_CHAIN_COST');
});

test('R18 keeps regime deltas paired within each seed and requires consistent Replay', () => {
  const mismatchedState = factorialRuns();
  mismatchedState[0].flipChain.initialRngState += 1;
  assert.throws(() => summarizeR18FactorialRuns(mismatchedState), /same initial RNG state/u);

  const duplicateSeed = factorialRuns();
  duplicateSeed[1].seedLabel = duplicateSeed[0].seedLabel;
  assert.throws(() => summarizeR18FactorialRuns(duplicateSeed), /unique seed labels/u);

  const inconsistent = factorialRuns();
  inconsistent[0].staticChain.replay = 'INCONSISTENT';
  assert.throws(() => summarizeR18FactorialRuns(inconsistent), /consistent Replay/u);
});

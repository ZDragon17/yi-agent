import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeR21FactorialRuns } from '../../scripts/curriculum/r21-power-grid-statistics.mjs';

function result(condition, cost, initialRngState) {
  return { condition, costYuan: cost, initialRngState, replay: 'CONSISTENT' };
}

function fixture(interactions = 0) {
  return Array.from({ length: 20 }, (_, index) => {
    const base3 = 100 + index;
    const chain3 = base3 + 2;
    const base5 = 200 + index;
    const chain5 = base5 + 2 + interactions;
    const state = index + 1;
    return {
      seedLabel: `seed-${index}`,
      base3: result('base-3', base3, state),
      chain3: result('chain-3', chain3, state),
      base5: result('base-5', base5, state),
      chain5: result('chain-5', chain5, state),
    };
  });
}

test('R21 statistics computes the power-grid by chain interaction', () => {
  const summary = summarizeR21FactorialRuns(fixture(3));
  assert.equal(summary.meanBase3ChainDeltaYuan, 2);
  assert.equal(summary.meanBase5ChainDeltaYuan, 5);
  assert.equal(summary.meanInteractionDeltaYuan, 3);
  assert.equal(summary.decision, 'EVIDENCE_POWER_GRID_INCREASES_CHAIN_COST');
});

test('R21 statistics rejects mismatched paired initial states', () => {
  const runs = fixture();
  runs[0].chain5.initialRngState = 999;
  assert.throws(() => summarizeR21FactorialRuns(runs), /same initial RNG state/u);
});

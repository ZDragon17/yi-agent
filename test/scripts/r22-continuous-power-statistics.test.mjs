import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeR22PairedRuns } from '../../scripts/curriculum/r22-continuous-power-statistics.mjs';

function result(condition, cost, state) { return { condition, costYuan: cost, initialRngState: state, replay: 'CONSISTENT' }; }
function fixture(delta = -3) {
  return Array.from({ length: 20 }, (_, index) => ({
    seedLabel: `seed-${index}`,
    continuousBase: result('continuous-base', 100 + index, index + 1),
    continuousChain: result('continuous-chain', 100 + index + delta, index + 1),
  }));
}

test('R22 statistics computes paired continuous chain cost', () => {
  const summary = summarizeR22PairedRuns(fixture());
  assert.equal(summary.meanChainDeltaYuan, -3);
  assert.equal(summary.medianChainDeltaYuan, -3);
  assert.equal(summary.decision, 'EVIDENCE_CONTINUOUS_CHAIN_REDUCES_COST');
});

test('R22 statistics rejects a duplicated paired initial state', () => {
  const runs = fixture();
  runs[1].continuousChain.initialRngState = runs[0].continuousBase.initialRngState;
  assert.throws(() => summarizeR22PairedRuns(runs), /matching initial states|unique initial RNG states/u);
});

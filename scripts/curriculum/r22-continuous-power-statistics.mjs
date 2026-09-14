const SAMPLE_SIZE = 20;
const T_CRITICAL_95_DF_19 = 2.093024054;

export function summarizeR22PairedRuns(runs) {
  validateRuns(runs);
  const deltas = runs.map((run) => run.continuousChain.costYuan - run.continuousBase.costYuan);
  const interval = confidenceInterval(deltas);
  return {
    nSeedRuns: SAMPLE_SIZE,
    meanChainDeltaYuan: round2(mean(deltas)),
    medianChainDeltaYuan: round2(median(deltas)),
    sampleStdDevChainDeltaYuan: round2(sampleStdDev(deltas)),
    nominalCi95ChainDeltaYuan: interval,
    lowerCost: deltas.filter((value) => value < 0).length,
    higherCost: deltas.filter((value) => value > 0).length,
    ties: deltas.filter((value) => value === 0).length,
    uniqueInitialRngStates: new Set(runs.map((run) => run.continuousBase.initialRngState)).size,
    uniqueSeedLabels: new Set(runs.map((run) => run.seedLabel)).size,
    decision: decisionFor(interval),
  };
}

function validateRuns(runs) {
  if (!Array.isArray(runs) || runs.length !== SAMPLE_SIZE) throw new TypeError(`R22 requires exactly ${SAMPLE_SIZE} same-seed paired runs.`);
  const labels = new Set();
  const states = new Set();
  for (const run of runs) {
    if (run === null || typeof run !== 'object' || typeof run.seedLabel !== 'string' || run.seedLabel.length === 0 || labels.has(run.seedLabel)) throw new TypeError('R22 requires unique seed labels.');
    const base = run.continuousBase;
    const chain = run.continuousChain;
    if (base?.condition !== 'continuous-base' || chain?.condition !== 'continuous-chain' ||
        !Number.isFinite(base.costYuan) || !Number.isFinite(chain.costYuan) ||
        !validRngState(base.initialRngState) || !validRngState(chain.initialRngState) ||
        base.initialRngState !== chain.initialRngState || base.replay !== 'CONSISTENT' || chain.replay !== 'CONSISTENT') {
      throw new TypeError('R22 requires paired continuous runs with matching initial states and consistent Replay.');
    }
    if (states.has(base.initialRngState)) throw new TypeError('R22 requires unique initial RNG states across seed runs.');
    labels.add(run.seedLabel);
    states.add(base.initialRngState);
  }
}

function validRngState(state) { return Number.isInteger(state) && state > 0 && state <= 0xffffffff; }
function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function sampleStdDev(values) { const average = mean(values); return Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1)); }
function confidenceInterval(values) { const average = mean(values); const margin = T_CRITICAL_95_DF_19 * sampleStdDev(values) / Math.sqrt(values.length); return { low: round2(average - margin), high: round2(average + margin) }; }
function decisionFor(interval) { if (interval.low > 0) return 'EVIDENCE_CONTINUOUS_CHAIN_INCREASES_COST'; if (interval.high < 0) return 'EVIDENCE_CONTINUOUS_CHAIN_REDUCES_COST'; return 'INCONCLUSIVE_CONTINUOUS_CHAIN_EFFECT'; }
function median(values) { const sorted = [...values].sort((left, right) => left - right); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]; }
function round2(value) { return Math.round(value * 100) / 100; }

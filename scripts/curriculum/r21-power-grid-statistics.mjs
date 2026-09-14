const SAMPLE_SIZE = 20;
const T_CRITICAL_95_DF_19 = 2.093024054;
const CONDITIONS = [
  ['base3', 'base-3'],
  ['chain3', 'chain-3'],
  ['base5', 'base-5'],
  ['chain5', 'chain-5'],
];

export function summarizeR21FactorialRuns(runs) {
  validateRuns(runs);
  const base3ChainDelta = runs.map((run) => run.chain3.costYuan - run.base3.costYuan);
  const base5ChainDelta = runs.map((run) => run.chain5.costYuan - run.base5.costYuan);
  const interactions = runs.map((run) =>
    (run.chain5.costYuan - run.base5.costYuan) - (run.chain3.costYuan - run.base3.costYuan));
  const interval = confidenceInterval(interactions);
  return {
    nSeedRuns: SAMPLE_SIZE,
    meanBase3ChainDeltaYuan: round2(mean(base3ChainDelta)),
    meanBase5ChainDeltaYuan: round2(mean(base5ChainDelta)),
    meanInteractionDeltaYuan: round2(mean(interactions)),
    medianInteractionDeltaYuan: round2(median(interactions)),
    sampleStdDevInteractionYuan: round2(sampleStdDev(interactions)),
    nominalCi95InteractionYuan: interval,
    interactionLowerCost: interactions.filter((value) => value < 0).length,
    interactionHigherCost: interactions.filter((value) => value > 0).length,
    interactionTies: interactions.filter((value) => value === 0).length,
    uniqueInitialRngStates: new Set(runs.map((run) => run.base3.initialRngState)).size,
    uniqueSeedLabels: new Set(runs.map((run) => run.seedLabel)).size,
    decision: decisionFor(interval),
  };
}

function validateRuns(runs) {
  if (!Array.isArray(runs) || runs.length !== SAMPLE_SIZE) throw new TypeError(`R21 requires exactly ${SAMPLE_SIZE} same-seed factorial runs.`);
  const labels = new Set();
  const states = new Set();
  for (const run of runs) {
    if (run === null || typeof run !== 'object' || typeof run.seedLabel !== 'string' || run.seedLabel.length === 0 || labels.has(run.seedLabel)) {
      throw new TypeError('R21 requires unique seed labels.');
    }
    const initialStates = new Set();
    for (const [key, condition] of CONDITIONS) {
      const result = run[key];
      if (result === null || typeof result !== 'object' || result.condition !== condition ||
          !Number.isFinite(result.costYuan) || !validRngState(result.initialRngState) || result.replay !== 'CONSISTENT') {
        throw new TypeError('R21 requires four condition runs with finite costs, valid initial RNG states, and consistent Replay.');
      }
      initialStates.add(result.initialRngState);
    }
    if (initialStates.size !== 1) throw new TypeError('R21 conditions must share the same initial RNG state.');
    const initialState = run.base3.initialRngState;
    if (states.has(initialState)) throw new TypeError('R21 requires unique initial RNG states across seed runs.');
    labels.add(run.seedLabel);
    states.add(initialState);
  }
}

function validRngState(state) { return Number.isInteger(state) && state > 0 && state <= 0xffffffff; }
function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function sampleStdDev(values) {
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1));
}
function confidenceInterval(values) {
  const average = mean(values);
  const margin = T_CRITICAL_95_DF_19 * sampleStdDev(values) / Math.sqrt(values.length);
  return { low: round2(average - margin), high: round2(average + margin) };
}
function decisionFor(interval) {
  if (interval.low > 0) return 'EVIDENCE_POWER_GRID_INCREASES_CHAIN_COST';
  if (interval.high < 0) return 'EVIDENCE_POWER_GRID_REDUCES_CHAIN_COST';
  return 'INCONCLUSIVE_POWER_GRID_INTERACTION';
}
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
function round2(value) { return Math.round(value * 100) / 100; }

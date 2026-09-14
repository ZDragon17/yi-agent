const SAMPLE_SIZE = 20;
const T_CRITICAL_95_DF_19 = 2.093024054;
const CONDITIONS = [
  ['staticBase', 'static-base'],
  ['staticChain', 'static-chain'],
  ['flipBase', 'flip-base'],
  ['flipChain', 'flip-chain'],
];

export function summarizeR18FactorialRuns(runs) {
  validateRuns(runs);

  const staticDeltas = runs.map((run) => run.staticChain.costYuan - run.staticBase.costYuan);
  const flipDeltas = runs.map((run) => run.flipChain.costYuan - run.flipBase.costYuan);
  const interactions = runs.map((run) =>
    (run.flipChain.costYuan - run.flipBase.costYuan) -
    (run.staticChain.costYuan - run.staticBase.costYuan));

  return {
    nSeedRuns: SAMPLE_SIZE,
    meanStaticChainDeltaYuan: round2(mean(staticDeltas)),
    medianStaticChainDeltaYuan: round2(median(staticDeltas)),
    meanFlipChainDeltaYuan: round2(mean(flipDeltas)),
    medianFlipChainDeltaYuan: round2(median(flipDeltas)),
    meanInteractionDeltaYuan: round2(mean(interactions)),
    medianInteractionDeltaYuan: round2(median(interactions)),
    sampleStdDevInteractionYuan: round2(sampleStdDev(interactions)),
    nominalCi95InteractionYuan: confidenceInterval(interactions),
    interactionLowerCost: interactions.filter((value) => value < 0).length,
    interactionHigherCost: interactions.filter((value) => value > 0).length,
    interactionTies: interactions.filter((value) => value === 0).length,
    uniqueInitialRngStates: new Set(runs.map((run) => run.staticBase.initialRngState)).size,
    uniqueSeedLabels: new Set(runs.map((run) => run.seedLabel)).size,
    decision: decisionFor(confidenceInterval(interactions)),
  };
}

function validateRuns(runs) {
  if (!Array.isArray(runs) || runs.length !== SAMPLE_SIZE) {
    throw new TypeError(`R18 requires exactly ${SAMPLE_SIZE} same-seed factorial runs.`);
  }

  const seedLabels = new Set();
  const initialStates = new Set();
  for (const run of runs) {
    if (run === null || typeof run !== 'object' ||
        typeof run.seedLabel !== 'string' || run.seedLabel.length === 0 || seedLabels.has(run.seedLabel)) {
      throw new TypeError('R18 requires unique seed labels.');
    }

    const states = new Set();
    for (const [key, condition] of CONDITIONS) {
      const result = run[key];
      if (result === null || typeof result !== 'object' || result.condition !== condition ||
          !Number.isFinite(result.costYuan) || !validRngState(result.initialRngState) ||
          result.replay !== 'CONSISTENT') {
        throw new TypeError('R18 requires four condition runs with finite costs, valid initial RNG states, and consistent Replay.');
      }
      states.add(result.initialRngState);
    }
    if (states.size !== 1) throw new TypeError('R18 conditions must share the same initial RNG state.');
    const initialState = run.staticBase.initialRngState;
    if (initialStates.has(initialState)) {
      throw new TypeError('R18 requires unique initial RNG states across seed runs.');
    }
    seedLabels.add(run.seedLabel);
    initialStates.add(initialState);
  }
}

function validRngState(state) {
  return Number.isInteger(state) && state > 0 && state <= 0xffffffff;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

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
  if (interval.low > 0) return 'EVIDENCE_TARIFF_INTERACTION_INCREASES_CHAIN_COST';
  if (interval.high < 0) return 'EVIDENCE_TARIFF_INTERACTION_REDUCES_CHAIN_COST';
  return 'INCONCLUSIVE_TARIFF_INTERACTION';
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

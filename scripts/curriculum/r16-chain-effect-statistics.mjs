const SAMPLE_SIZE = 20;
const T_CRITICAL_95_DF_19 = 2.093024054;
const CONDITIONS = new Set(['utility-base', 'utility-pair']);

export function summarizeR16PairedRuns(pairs) {
  validatePairs(pairs);

  const deltas = pairs.map((pair) => pair.deltaYuan);
  const mean = deltas.reduce((sum, delta) => sum + delta, 0) / SAMPLE_SIZE;
  const variance = deltas.reduce((sum, delta) => sum + ((delta - mean) ** 2), 0) / (SAMPLE_SIZE - 1);
  const standardDeviation = Math.sqrt(variance);
  const margin = T_CRITICAL_95_DF_19 * standardDeviation / Math.sqrt(SAMPLE_SIZE);
  const low = mean - margin;
  const high = mean + margin;
  const baseClusters = new Map();
  for (const pair of pairs) {
    const cluster = baseClusters.get(pair.base.actionTraceDigest) ?? [];
    cluster.push(pair.deltaYuan);
    baseClusters.set(pair.base.actionTraceDigest, cluster);
  }

  return {
    nSeedPairs: SAMPLE_SIZE,
    meanDeltaYuan: round2(mean),
    medianDeltaYuan: round2(median(deltas)),
    sampleStdDevYuan: round2(standardDeviation),
    nominalCi95Yuan: { low: round2(low), high: round2(high) },
    chainLowerCost: deltas.filter((delta) => delta < 0).length,
    chainHigherCost: deltas.filter((delta) => delta > 0).length,
    ties: deltas.filter((delta) => delta === 0).length,
    uniqueInitialRngStates: new Set(pairs.map((pair) => pair.base.initialRngState)).size,
    initialRngStateRange: {
      min: Math.min(...pairs.map((pair) => pair.base.initialRngState)),
      max: Math.max(...pairs.map((pair) => pair.base.initialRngState)),
    },
    uniqueSeedLabels: new Set(pairs.map((pair) => pair.seedLabel)).size,
    uniqueBaseActionTraces: baseClusters.size,
    uniqueChainActionTraces: new Set(pairs.map((pair) => pair.chain.actionTraceDigest)).size,
    uniquePairedActionTraces: new Set(pairs.map((pair) =>
      `${pair.base.actionTraceDigest}|${pair.chain.actionTraceDigest}`)).size,
    baseTraceClusters: [...baseClusters]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([traceDigest, clusterDeltas]) => ({
        traceDigest,
        nSeedPairs: clusterDeltas.length,
        meanDeltaYuan: round2(clusterDeltas.reduce((sum, delta) => sum + delta, 0) / clusterDeltas.length),
      })),
    ciStatus: 'APPROXIMATE_RANDOM_SEED_SAMPLE',
    decision: low > 0
      ? 'EVIDENCE_CHAIN_INCREASES_MEAN_COST'
      : high < 0
        ? 'EVIDENCE_CHAIN_REDUCES_MEAN_COST'
        : 'INCONCLUSIVE_RANDOM_SEED_SWEEP',
  };
}

function validatePairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length !== SAMPLE_SIZE) {
    throw new TypeError(`R16 requires exactly ${SAMPLE_SIZE} accepted seed pairs.`);
  }
  const seedLabels = new Set();
  const initialStates = new Set();
  for (const pair of pairs) {
    if (pair === null || typeof pair !== 'object' ||
        typeof pair.seedLabel !== 'string' || pair.seedLabel.length === 0 ||
        seedLabels.has(pair.seedLabel) ||
        !Array.isArray(pair.treatmentOrder) || pair.treatmentOrder.length !== 2 ||
        new Set(pair.treatmentOrder).size !== 2 || pair.treatmentOrder.some((condition) => !CONDITIONS.has(condition)) ||
        !Number.isFinite(pair.deltaYuan) ||
        pair.base === null || typeof pair.base !== 'object' ||
        pair.chain === null || typeof pair.chain !== 'object' ||
        !Number.isFinite(pair.base.costYuan) || !Number.isFinite(pair.chain.costYuan) ||
        pair.deltaYuan !== pair.chain.costYuan - pair.base.costYuan ||
        pair.base.replay !== 'CONSISTENT' || pair.chain.replay !== 'CONSISTENT' ||
        typeof pair.base.actionTraceDigest !== 'string' || pair.base.actionTraceDigest.length === 0 ||
        typeof pair.chain.actionTraceDigest !== 'string' || pair.chain.actionTraceDigest.length === 0 ||
        !validRngState(pair.base.initialRngState) ||
        pair.base.initialRngState !== pair.chain.initialRngState ||
        initialStates.has(pair.base.initialRngState)) {
      throw new TypeError('R16 requires unique labels and initial RNG states, matched paired runs, valid randomized order, finite costs, and consistent Replay results.');
    }
    seedLabels.add(pair.seedLabel);
    initialStates.add(pair.base.initialRngState);
  }
}

function validRngState(state) {
  return Number.isInteger(state) && state > 0 && state <= 0xffffffff;
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

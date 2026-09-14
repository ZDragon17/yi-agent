const SAMPLE_SIZE = 20;
const T_CRITICAL_95_DF_19 = 2.093024054;

export function summarizeR15PairedRuns(pairs) {
  if (!Array.isArray(pairs) || pairs.length !== SAMPLE_SIZE || pairs.some((pair) =>
    pair === null || typeof pair !== 'object' ||
    typeof pair.baseTraceDigest !== 'string' || pair.baseTraceDigest.length === 0 ||
    typeof pair.chainTraceDigest !== 'string' || pair.chainTraceDigest.length === 0 ||
    !Number.isFinite(pair.deltaYuan))) {
    throw new TypeError('R15 requires exactly 20 paired runs with finite deltas and trace digests.');
  }

  const deltas = pairs.map((pair) => pair.deltaYuan);
  const mean = deltas.reduce((sum, delta) => sum + delta, 0) / SAMPLE_SIZE;
  const variance = deltas.reduce((sum, delta) => sum + ((delta - mean) ** 2), 0) / (SAMPLE_SIZE - 1);
  const standardDeviation = Math.sqrt(variance);
  const margin = T_CRITICAL_95_DF_19 * standardDeviation / Math.sqrt(SAMPLE_SIZE);
  const low = mean - margin;
  const high = mean + margin;
  const baseClusters = new Map();
  for (const pair of pairs) {
    const cluster = baseClusters.get(pair.baseTraceDigest) ?? [];
    cluster.push(pair.deltaYuan);
    baseClusters.set(pair.baseTraceDigest, cluster);
  }
  const uniqueBaseActionTraces = baseClusters.size;
  const ciStatus = uniqueBaseActionTraces === SAMPLE_SIZE
    ? 'VALID_DISTINCT_BASE_TRACES'
    : 'INVALID_DUPLICATE_BASE_TRACES';

  return {
    nSeedPairs: SAMPLE_SIZE,
    meanDeltaYuan: round2(mean),
    sampleStdDevYuan: round2(standardDeviation),
    nominalCi95Yuan: { low: round2(low), high: round2(high) },
    chainLowerCost: deltas.filter((delta) => delta < 0).length,
    chainHigherCost: deltas.filter((delta) => delta > 0).length,
    ties: deltas.filter((delta) => delta === 0).length,
    uniqueBaseActionTraces,
    uniqueChainActionTraces: new Set(pairs.map((pair) => pair.chainTraceDigest)).size,
    uniquePairedActionTraces: new Set(pairs.map((pair) => `${pair.baseTraceDigest}|${pair.chainTraceDigest}`)).size,
    baseTraceClusters: [...baseClusters]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([traceDigest, clusterDeltas]) => ({
        traceDigest,
        nSeedPairs: clusterDeltas.length,
        meanDeltaYuan: round2(clusterDeltas.reduce((sum, delta) => sum + delta, 0) / clusterDeltas.length),
      })),
    ciStatus,
    decision: ciStatus !== 'VALID_DISTINCT_BASE_TRACES'
      ? 'INCONCLUSIVE_DUPLICATE_BASE_TRAJECTORIES'
      : high < 0 ? 'CHAIN_BENEFIT' : low > 0 ? 'CHAIN_HARM' : 'INCONCLUSIVE',
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

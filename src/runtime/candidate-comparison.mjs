const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function comparePairedCandidates(left, right) {
  if (!isCandidateEntry(left) || !isCandidateEntry(right) ||
      left.candidateOutcome.candidateDigest === right.candidateOutcome.candidateDigest ||
      left.worldVersion !== right.worldVersion ||
      left.tokenMapDigest !== right.tokenMapDigest ||
      left.scenario !== right.scenario ||
      left.beforeStateDigest !== right.beforeStateDigest) {
    return null;
  }
  const metric = comparableMetric(left.quality, right.quality);
  if (metric === null) return null;
  const delta = metric.leftValue - metric.rightValue;
  if (!Number.isFinite(delta)) return null;
  return {
    pair: 'same-before-state-v1',
    beforeStateDigest: left.beforeStateDigest,
    metric: metric.name,
    leftCandidateDigest: left.candidateOutcome.candidateDigest,
    rightCandidateDigest: right.candidateOutcome.candidateDigest,
    leftValue: metric.leftValue,
    rightValue: metric.rightValue,
    delta,
    verdict: delta < 0 ? 'LEFT_BETTER' : delta > 0 ? 'RIGHT_BETTER' : 'TIE',
  };
}

function isCandidateEntry(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.worldVersion === 'string' && value.worldVersion.length > 0 &&
    DIGEST_PATTERN.test(value.tokenMapDigest ?? '') &&
    typeof value.scenario === 'string' && value.scenario.length > 0 &&
    DIGEST_PATTERN.test(value.beforeStateDigest ?? '') &&
    value.candidateOutcome !== null && typeof value.candidateOutcome === 'object' &&
    !Array.isArray(value.candidateOutcome) &&
    DIGEST_PATTERN.test(value.candidateOutcome.candidateDigest ?? '');
}

function comparableMetric(left, right) {
  if (!isVerifiedQuality(left) || !isVerifiedQuality(right)) return null;
  if (Number.isFinite(left.goalDistanceAfter) && Number.isFinite(right.goalDistanceAfter)) {
    return { name: 'goalDistanceAfter', leftValue: left.goalDistanceAfter, rightValue: right.goalDistanceAfter };
  }
  if (Number.isFinite(left.errorMagnitude) && Number.isFinite(right.errorMagnitude)) {
    return { name: 'errorMagnitude', leftValue: left.errorMagnitude, rightValue: right.errorMagnitude };
  }
  return null;
}

function isVerifiedQuality(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    value.verified === true &&
    (!Object.hasOwn(value, 'goalDistanceAfter') ||
      (Number.isFinite(value.goalDistanceAfter) && value.goalDistanceAfter >= 0)) &&
    (!Object.hasOwn(value, 'errorMagnitude') ||
      (Number.isFinite(value.errorMagnitude) && value.errorMagnitude >= 0));
}

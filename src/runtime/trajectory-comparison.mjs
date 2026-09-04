const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function comparePairedTrajectories(input) {
  if (!isRecord(input) ||
      !isNonEmptyText(input.worldVersion) ||
      !isDigest(input.tokenMapDigest) ||
      !isNonEmptyText(input.scenario) ||
      !isDigest(input.initialStateDigest) ||
      !isTrajectoryEvidence(input.left) ||
      !isTrajectoryEvidence(input.right) ||
      input.left.trajectoryDigest === input.right.trajectoryDigest) {
    return null;
  }
  const metric = comparableMetric(input.left.quality, input.right.quality);
  if (metric === null) return null;
  const delta = metric.leftValue - metric.rightValue;
  if (!Number.isFinite(delta)) return null;
  return {
    pair: 'same-initial-state-trajectory-v1',
    initialStateDigest: input.initialStateDigest,
    metric: metric.name,
    leftTrajectoryDigest: input.left.trajectoryDigest,
    rightTrajectoryDigest: input.right.trajectoryDigest,
    leftTerminalDigest: input.left.terminalDigest,
    rightTerminalDigest: input.right.terminalDigest,
    leftValue: metric.leftValue,
    rightValue: metric.rightValue,
    delta,
    verdict: delta < 0 ? 'LEFT_BETTER' : delta > 0 ? 'RIGHT_BETTER' : 'TIE',
  };
}

function isTrajectoryEvidence(value) {
  return isRecord(value) && isDigest(value.trajectoryDigest) && isDigest(value.terminalDigest) &&
    isRecord(value.quality);
}

function comparableMetric(left, right) {
  if (left.verified !== true || right.verified !== true) return null;
  if (finiteNonNegative(left.goalDistanceAfter) && finiteNonNegative(right.goalDistanceAfter)) {
    return { name: 'terminalGoalDistance', leftValue: left.goalDistanceAfter, rightValue: right.goalDistanceAfter };
  }
  if (finiteNonNegative(left.errorMagnitude) && finiteNonNegative(right.errorMagnitude)) {
    return { name: 'terminalErrorMagnitude', leftValue: left.errorMagnitude, rightValue: right.errorMagnitude };
  }
  return null;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyText(value) {
  return typeof value === 'string' && value.length > 0;
}

function isDigest(value) {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

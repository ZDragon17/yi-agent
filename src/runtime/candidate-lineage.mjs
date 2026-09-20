const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function acceptedSupersessionDigest({
  requestedDigest,
  history,
  worldId,
  worldVersion,
  worldImplementationDigest,
  tokenMapDigest,
  scenario,
} = {}) {
  if (!DIGEST_PATTERN.test(requestedDigest ?? '') ||
      !Array.isArray(history) ||
      typeof worldVersion !== 'string' || worldVersion.length === 0 ||
      typeof tokenMapDigest !== 'string' || !DIGEST_PATTERN.test(tokenMapDigest) ||
      typeof scenario !== 'string' || scenario.length === 0) {
    return null;
  }
  return history.some((entry) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry) &&
    entry.worldVersion === worldVersion &&
    entry.tokenMapDigest === tokenMapDigest &&
    entry.scenario === scenario &&
    sameWorldPort(entry, { worldId, worldImplementationDigest }) &&
    entry.candidateOutcome !== null && typeof entry.candidateOutcome === 'object' &&
    !Array.isArray(entry.candidateOutcome) &&
    entry.candidateOutcome.candidateDigest === requestedDigest,
  ) ? requestedDigest : null;
}

function sameWorldPort(left, right) {
  const hasIdentity = Object.hasOwn(left, 'worldId') || Object.hasOwn(left, 'worldImplementationDigest') ||
    right.worldId !== undefined || right.worldImplementationDigest !== undefined;
  return !hasIdentity ||
    left.worldId === right.worldId && left.worldImplementationDigest === right.worldImplementationDigest;
}

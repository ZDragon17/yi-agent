const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function acceptedSupersessionDigest({
  requestedDigest,
  history,
  worldVersion,
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
    entry.candidateOutcome !== null && typeof entry.candidateOutcome === 'object' &&
    !Array.isArray(entry.candidateOutcome) &&
    entry.candidateOutcome.candidateDigest === requestedDigest,
  ) ? requestedDigest : null;
}

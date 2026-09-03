import { canonicalDigest } from './schema.mjs';

export function annotateCandidateHistory(history) {
  if (!Array.isArray(history)) return [];
  const attempts = new Map();
  return history.map((entry) => {
    const scope = candidateScope(entry);
    const quality = predictionQuality(entry.candidateOutcome);
    const enriched = {
      ...entry,
      ...(quality === null ? {} : { quality }),
    };
    if (scope === null) return enriched;
    const attempt = (attempts.get(scope) ?? 0) + 1;
    attempts.set(scope, attempt);
    return {
      ...enriched,
      candidateScopeDigest: scope,
      attempt,
    };
  });
}

export function candidateScopeDigest({ worldVersion, tokenMapDigest, scenario, candidateDigest } = {}) {
  if (typeof worldVersion !== 'string' || worldVersion.length === 0 ||
      typeof tokenMapDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(tokenMapDigest) ||
      typeof scenario !== 'string' || scenario.length === 0 ||
      typeof candidateDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(candidateDigest)) {
    return null;
  }
  return canonicalDigest({ worldVersion, tokenMapDigest, scenario, candidateDigest });
}

function candidateScope(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const outcome = entry.candidateOutcome;
  return candidateScopeDigest({
    worldVersion: entry.worldVersion,
    tokenMapDigest: entry.tokenMapDigest,
    scenario: entry.scenario,
    candidateDigest: outcome?.candidateDigest,
  });
}

function predictionQuality(outcome) {
  const verification = outcome?.verification;
  if (outcome?.status !== 'APPLIED' || verification === null ||
      typeof verification !== 'object' || Array.isArray(verification) ||
      !Array.isArray(verification.error) || verification.error.length === 0 ||
      verification.error.some((value) => !Number.isFinite(value))) return null;
  let total = 0;
  for (const value of verification.error) total += Math.abs(value);
  return {
    errorMagnitude: total / verification.error.length,
    verified: verification.attribution === 'ACTION' && verification.learnable === true,
  };
}

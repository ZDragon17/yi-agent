import { canonicalDigest } from './schema.mjs';

export function annotateCandidateHistory(history) {
  if (!Array.isArray(history)) return [];
  const attempts = new Map();
  return history.map((entry) => {
    const scope = candidateScope(entry);
    if (scope === null) return { ...entry };
    const attempt = (attempts.get(scope) ?? 0) + 1;
    attempts.set(scope, attempt);
    return {
      ...entry,
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

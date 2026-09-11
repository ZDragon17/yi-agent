import { canonicalDigest } from './schema.mjs';
import { comparePairedCandidates } from './candidate-comparison.mjs';

export function annotateCandidateHistory(history) {
  if (!Array.isArray(history)) return [];
  const annotator = createCandidateHistoryAnnotator();
  return history.map((entry) => annotator.push(entry));
}

export function createCandidateHistoryAnnotator({ relevance = null } = {}) {
  const attempts = new Map();
  const contextAttempts = new Map();
  const supersededCandidates = new Map();
  const pairedCandidates = new Map();
  let previousKernelStep = null;
  return {
    push(entry, { emit = true } = {}) {
      const scope = candidateScope(entry);
      const decisionContext = decisionContextDigest(entry);
      const quality = predictionQuality(entry?.candidateOutcome, entry);
      const referenceQuality = quality ?? entry?.quality ?? null;
      const previousSuperseded = findLatestSupersededCandidate(supersededCandidates, entry);
      const supersededStepDistance = stepsSinceSupersededCandidate(previousSuperseded, entry);
      const supersededQuality = compareSupersededQuality(previousSuperseded?.quality, quality);
      const previousPaired = findPreviousPairedCandidate(pairedCandidates, entry);
      const pairedComparison = compareWithPreviousPairedCandidate(previousPaired, entry);
      const kernelStep = Number.isSafeInteger(entry?.kernelStep) && entry.kernelStep >= 0 ? entry.kernelStep : null;
      const stepGap = kernelStep !== null && previousKernelStep !== null && kernelStep >= previousKernelStep
        ? kernelStep - previousKernelStep
        : null;
      if (kernelStep !== null) previousKernelStep = kernelStep;
      const scopeRelevant = relevance === null || (scope !== null && relevance.scopes.has(scope));
      const contextRelevant = relevance === null ||
        (decisionContext !== null && relevance.contexts.has(decisionContext));
      if (scopeRelevant && scope !== null) attempts.set(scope, (attempts.get(scope) ?? 0) + 1);
      if (contextRelevant && decisionContext !== null) {
        contextAttempts.set(decisionContext, (contextAttempts.get(decisionContext) ?? 0) + 1);
      }
      const result = !emit
        ? undefined
        : (() => {
            const { valueSpec: _valueSpec, beforeVector: _beforeVector, afterVector: _afterVector, ...publicEntry } = entry ?? {};
            const enriched = {
              ...publicEntry,
              ...(quality === null ? {} : { quality }),
              ...(stepGap === null ? {} : { stepsSincePreviousCandidate: stepGap }),
              ...(supersededStepDistance === null ? {} : { stepsSinceSupersededCandidate: supersededStepDistance }),
              ...(supersededQuality === null ? {} : supersededQuality),
              ...(pairedComparison === null ? {} : { pairedComparison }),
            };
            const annotated = scope === null
              ? enriched
              : { ...enriched, candidateScopeDigest: scope, attempt: attempts.get(scope) };
            return decisionContext === null
              ? annotated
              : { ...annotated, decisionContextDigest: decisionContext, contextAttempt: contextAttempts.get(decisionContext) };
          })();
      rememberCandidate(supersededCandidates, entry, referenceQuality, relevance);
      rememberPairedCandidate(pairedCandidates, entry, referenceQuality, relevance);
      return result;
    },
  };
}

export function candidateHistoryRelevance(history) {
  const relevance = {
    scopes: new Set(),
    contexts: new Set(),
    supersededCandidateKeys: new Set(),
    pairedCandidateKeys: new Set(),
  };
  if (!Array.isArray(history)) return relevance;
  for (const entry of history) {
    const decisionContext = decisionContextDigest(entry);
    if (decisionContext !== null) relevance.contexts.add(decisionContext);
    const scope = candidateScope(entry);
    if (scope === null) continue;
    relevance.scopes.add(scope);
    const supersededDigest = entry?.supersedesCandidateDigest;
    if (typeof supersededDigest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(supersededDigest)) {
      relevance.supersededCandidateKeys.add(candidateReferenceKey(entry, supersededDigest));
    }
    if (typeof entry.beforeStateDigest === 'string') {
      relevance.pairedCandidateKeys.add(candidateReferenceKey(entry, entry.beforeStateDigest));
    }
  }
  return relevance;
}

function compareWithPreviousPairedCandidate(previous, entry) {
  return previous === undefined ? null : comparePairedCandidates(previous, entry);
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

export function decisionContextDigest({ worldVersion, tokenMapDigest, scenario, observationDigest } = {}) {
  if (typeof worldVersion !== 'string' || worldVersion.length === 0 ||
      typeof tokenMapDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(tokenMapDigest) ||
      typeof scenario !== 'string' || scenario.length === 0 ||
      typeof observationDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(observationDigest)) {
    return null;
  }
  return canonicalDigest({ worldVersion, tokenMapDigest, scenario, observationDigest });
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

function stepsSinceSupersededCandidate(previous, entry) {
  const currentStep = kernelStep(entry);
  const previousStep = kernelStep(previous);
  return previousStep !== null && currentStep >= previousStep ? currentStep - previousStep : null;
}

function compareSupersededQuality(previousQuality, quality) {
  const currentDistance = quality?.goalDistanceAfter;
  if (!Number.isFinite(currentDistance)) return null;
  const previousDistance = previousQuality?.goalDistanceAfter;
  if (!Number.isFinite(previousDistance)) return null;
  const delta = previousDistance - currentDistance;
  if (!Number.isFinite(delta)) return null;
  return {
    goalDistanceDeltaFromSuperseded: delta,
    goalImprovedFromSuperseded: delta > 0,
  };
}

function findLatestSupersededCandidate(candidates, entry) {
  const requestedDigest = entry?.supersedesCandidateDigest;
  if (!isObjectRecord(entry) || typeof requestedDigest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/u.test(requestedDigest)) return null;
  return nestedMapGet(candidates, [...worldPortScopeKeys(entry), requestedDigest]) ?? null;
}

function findPreviousPairedCandidate(candidates, entry) {
  if (!isObjectRecord(entry)) return null;
  const state = nestedMapGet(candidates, [...worldPortScopeKeys(entry), entry.beforeStateDigest]);
  if (state === undefined) return null;
  const candidateDigest = entry?.candidateOutcome?.candidateDigest;
  return state.latest?.candidateOutcome?.candidateDigest !== candidateDigest
    ? state.latest
    : state.previousDistinct;
}

function rememberCandidate(candidates, entry, quality, relevance) {
  if (!isObjectRecord(entry)) return;
  const candidateKey = candidateReferenceKey(entry, entry?.candidateOutcome?.candidateDigest);
  if (relevance !== null && !relevance.supersededCandidateKeys.has(candidateKey)) return;
  nestedMapSet(candidates, [
    ...worldPortScopeKeys(entry),
    entry?.candidateOutcome?.candidateDigest,
  ], candidateReference(entry, quality));
}

function rememberPairedCandidate(candidates, entry, quality, relevance) {
  if (!isObjectRecord(entry)) return;
  const keys = [...worldPortScopeKeys(entry), entry.beforeStateDigest];
  if (relevance !== null && !relevance.pairedCandidateKeys.has(candidateReferenceKey(entry, entry.beforeStateDigest))) return;
  const state = nestedMapGet(candidates, keys);
  const candidateDigest = entry?.candidateOutcome?.candidateDigest;
  if (state === undefined) {
    nestedMapSet(candidates, keys, { latest: candidateReference(entry, quality), previousDistinct: null });
    return;
  }
  if (state.latest?.candidateOutcome?.candidateDigest === candidateDigest) {
    state.latest = candidateReference(entry, quality);
    return;
  }
  nestedMapSet(candidates, keys, { latest: candidateReference(entry, quality), previousDistinct: state.latest });
}

function candidateReference(entry, quality) {
  return {
    worldVersion: entry.worldVersion,
    tokenMapDigest: entry.tokenMapDigest,
    scenario: entry.scenario,
    beforeStateDigest: entry.beforeStateDigest,
    kernelStep: kernelStep(entry),
    candidateOutcome: { candidateDigest: entry?.candidateOutcome?.candidateDigest },
    quality,
  };
}

function candidateReferenceKey(entry, value) {
  return JSON.stringify([...worldPortScopeKeys(entry), value]);
}

function nestedMapGet(root, keys) {
  let current = root;
  for (const key of keys) {
    if (!current.has(key)) return undefined;
    current = current.get(key);
  }
  return current;
}

function nestedMapSet(root, keys, value) {
  let current = root;
  for (const key of keys.slice(0, -1)) {
    if (!current.has(key)) current.set(key, new Map());
    current = current.get(key);
  }
  current.set(keys.at(-1), value);
}

function worldPortScopeKeys(entry) {
  return [entry.worldVersion, entry.tokenMapDigest, entry.scenario];
}

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function kernelStep(entry) {
  return Number.isSafeInteger(entry?.kernelStep) && entry.kernelStep >= 0 ? entry.kernelStep : null;
}

function predictionQuality(outcome, entry) {
  const verification = outcome?.verification;
  if (outcome?.status !== 'APPLIED' || verification === null ||
      typeof verification !== 'object' || Array.isArray(verification) ||
      !Array.isArray(verification.error) || verification.error.length === 0 ||
      verification.error.some((value) => !Number.isFinite(value))) return null;
  let total = 0;
  for (const value of verification.error) total += Math.abs(value);
  const quality = {
    errorMagnitude: total / verification.error.length,
    verified: verification.attribution === 'ACTION' && verification.learnable === true,
  };
  const goalQuality = goalDistanceQuality(entry);
  return goalQuality === null ? quality : { ...quality, ...goalQuality };
}

function goalDistanceQuality(entry) {
  const valueSpec = entry?.valueSpec;
  const before = entry?.beforeVector;
  const after = entry?.afterVector;
  if (valueSpec === null || typeof valueSpec !== 'object' || Array.isArray(valueSpec) ||
      valueSpec.valueMode !== 'distance-v2' ||
      !Number.isSafeInteger(valueSpec.observationDimensions) || valueSpec.observationDimensions < 1 ||
      !Array.isArray(valueSpec.weights) || !Array.isArray(valueSpec.target) ||
      valueSpec.weights.length !== valueSpec.observationDimensions ||
      valueSpec.target.length !== valueSpec.observationDimensions ||
      !Array.isArray(before) || !Array.isArray(after) ||
      before.length !== valueSpec.observationDimensions || after.length !== valueSpec.observationDimensions ||
      before.some((value) => !Number.isFinite(value)) || after.some((value) => !Number.isFinite(value)) ||
      valueSpec.weights.some((value) => !Number.isFinite(value)) ||
      valueSpec.target.some((value) => !Number.isFinite(value)) ||
      !Number.isFinite(valueSpec.tolerance) || valueSpec.tolerance < 0) return null;
  const beforeDistance = weightedTargetDistance(before, valueSpec);
  const afterDistance = weightedTargetDistance(after, valueSpec);
  if (beforeDistance === null || afterDistance === null) return null;
  return {
    goalDistanceBefore: beforeDistance,
    goalDistanceAfter: afterDistance,
    goalProgress: beforeDistance - afterDistance,
    goalReached: afterDistance === 0,
  };
}

function weightedTargetDistance(vector, valueSpec) {
  let distance = 0;
  for (let index = 0; index < vector.length; index += 1) {
    distance += Math.abs(valueSpec.weights[index]) *
      Math.max(0, Math.abs(vector[index] - valueSpec.target[index]) - valueSpec.tolerance);
    if (!Number.isFinite(distance)) return null;
  }
  return distance;
}

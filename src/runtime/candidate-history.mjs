import { canonicalDigest } from './schema.mjs';
import { comparePairedCandidates } from './candidate-comparison.mjs';

export function annotateCandidateHistory(history) {
  if (!Array.isArray(history)) return [];
  const attempts = new Map();
  const contextAttempts = new Map();
  let previousKernelStep = null;
  return history.map((entry, index) => {
    const scope = candidateScope(entry);
    const decisionContext = decisionContextDigest(entry);
    const quality = predictionQuality(entry.candidateOutcome, entry);
    const supersededStepDistance = stepsSinceSupersededCandidate(history, index, entry);
    const supersededQuality = compareSupersededQuality(history, index, entry, quality);
    const pairedComparison = compareWithPreviousPairedCandidate(history, index, entry);
    const { valueSpec: _valueSpec, beforeVector: _beforeVector, afterVector: _afterVector, ...publicEntry } = entry ?? {};
    const kernelStep = Number.isSafeInteger(entry?.kernelStep) && entry.kernelStep >= 0 ? entry.kernelStep : null;
    const stepGap = kernelStep !== null && previousKernelStep !== null && kernelStep >= previousKernelStep
      ? kernelStep - previousKernelStep
      : null;
    const enriched = {
      ...publicEntry,
      ...(quality === null ? {} : { quality }),
      ...(stepGap === null ? {} : { stepsSincePreviousCandidate: stepGap }),
      ...(supersededStepDistance === null ? {} : { stepsSinceSupersededCandidate: supersededStepDistance }),
      ...(supersededQuality === null ? {} : supersededQuality),
      ...(pairedComparison === null ? {} : { pairedComparison }),
    };
    if (kernelStep !== null) previousKernelStep = kernelStep;
    const annotated = scope === null
      ? enriched
      : {
          ...enriched,
          candidateScopeDigest: scope,
          attempt: (attempts.get(scope) ?? 0) + 1,
        };
    if (scope !== null) attempts.set(scope, annotated.attempt);
    if (decisionContext === null) return annotated;
    const contextAttempt = (contextAttempts.get(decisionContext) ?? 0) + 1;
    contextAttempts.set(decisionContext, contextAttempt);
    return { ...annotated, decisionContextDigest: decisionContext, contextAttempt };
  });
}

function compareWithPreviousPairedCandidate(history, index, entry) {
  const previous = history.slice(0, index).findLast((candidate) =>
    sameWorldPortScope(candidate, entry) &&
    candidate.beforeStateDigest === entry?.beforeStateDigest &&
    candidate?.candidateOutcome?.candidateDigest !== entry?.candidateOutcome?.candidateDigest,
  );
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

function stepsSinceSupersededCandidate(history, index, entry) {
  const currentStep = kernelStep(entry);
  if (currentStep === null) return null;
  const previous = findSupersededCandidate(history, index, entry);
  const previousStep = kernelStep(previous);
  return previousStep !== null && currentStep >= previousStep ? currentStep - previousStep : null;
}

function compareSupersededQuality(history, index, entry, quality) {
  const currentDistance = quality?.goalDistanceAfter;
  if (!Number.isFinite(currentDistance)) return null;
  const previous = findSupersededCandidate(history, index, entry);
  const previousQuality = predictionQuality(previous?.candidateOutcome, previous);
  const previousDistance = previousQuality?.goalDistanceAfter;
  if (!Number.isFinite(previousDistance)) return null;
  const delta = previousDistance - currentDistance;
  if (!Number.isFinite(delta)) return null;
  return {
    goalDistanceDeltaFromSuperseded: delta,
    goalImprovedFromSuperseded: delta > 0,
  };
}

function findSupersededCandidate(history, index, entry) {
  const requestedDigest = entry?.supersedesCandidateDigest;
  if (typeof requestedDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(requestedDigest)) return null;
  return history.slice(0, index).findLast((candidate) =>
    sameWorldPortScope(candidate, entry) && candidate?.candidateOutcome?.candidateDigest === requestedDigest,
  ) ?? null;
}

function sameWorldPortScope(left, right) {
  return left !== null && typeof left === 'object' && !Array.isArray(left) &&
    right !== null && typeof right === 'object' && !Array.isArray(right) &&
    left.worldVersion === right.worldVersion &&
    left.tokenMapDigest === right.tokenMapDigest &&
    left.scenario === right.scenario;
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

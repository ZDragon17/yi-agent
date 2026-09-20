import { canonicalDigest } from './schema.mjs';

const SCHEMA_VERSION = 1;
const EVALUATION_TYPE = 'counterfactual-policy-evaluation';
const EVALUATION_VERSION = 2;
// Every counterfactual is anchored at one recorded step: we substitute only
// the candidate choice of that single step. Anything beyond one step would
// require world states the ledger never observed, which this module refuses
// to fabricate.
const EVALUATION_MODE = 'history-anchored-one-step-v2';
// Within one lab the recorded before-state digest never repeats (it hashes
// the monotonic kernelStep) and the model observation digest never repeats
// either (world-port-base bumps stateVersion on every transition). The only
// transferable equivalence on real single-lab history is the observable
// vector recorded before the step, so evidence binds on vector equality.
// STRICT keeps the exact before-state anchor for cross-lab corpora where it
// can actually occur.
const POLICY_TYPE = 'candidate-policy';
const POLICY_VERSION = 1;
const BINDING_MODES = ['vector', 'strict'];
const TOKEN_PATTERN = /^tok_[A-Z0-9]{8,128}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_DIVERGENCE_SAMPLES = 16;

export function evaluateCounterfactualPolicy({ history, policy, binding = 'vector' } = {}) {
  const normalizedPolicy = requirePolicy(policy);
  const entries = requireHistory(history);
  const normalizedBinding = requireBinding(binding);
  const rules = new Map(normalizedPolicy.rules.map((rule) => [rule.observationDigest, rule.token]));
  const index = buildOutcomeIndex(entries);
  const counters = { steps: 0, matched: 0, opaque: 0, diverged: 0, strict: 0, vector: 0, unevaluable: 0 };
  const bindingDeltas = [];
  const samples = [];
  for (const entry of entries) {
    const recordedToken = entry?.candidateOutcome?.token;
    const observationDigest = entry?.observationDigest;
    if (!TOKEN_PATTERN.test(recordedToken ?? '') ||
        typeof observationDigest !== 'string' || !DIGEST_PATTERN.test(observationDigest)) {
      counters.opaque += 1;
      continue;
    }
    counters.steps += 1;
    const counterfactualToken = rules.get(observationDigest) ?? normalizedPolicy.defaultToken;
    if (counterfactualToken === recordedToken) {
      counters.matched += 1;
      continue;
    }
    counters.diverged += 1;
    const sample = {
      kernelStep: kernelStep(entry),
      runId: typeof entry?.runId === 'string' ? entry.runId : null,
      recordedToken,
      counterfactualToken,
    };
    const recordedDistance = verifiedGoalDistance(entry);
    if (recordedDistance === null) {
      counters.unevaluable += 1;
      pushSample(samples, { ...sample, classification: 'UNEVALUABLE', reason: 'RECORDED_OUTCOME_UNVERIFIED' });
      continue;
    }
    const vectorKey = observableVectorKey(entry);
    const recorded = vectorKey === null ? undefined : index.get(vectorKey)?.get(counterfactualToken);
    if (vectorKey === null || recorded === undefined || recorded.length === 0) {
      counters.unevaluable += 1;
      pushSample(samples, { ...sample, classification: 'UNEVALUABLE', reason: 'NO_RECORDED_OUTCOME' });
      continue;
    }
    const sameState = lastOutcomeAtState(recorded, entry?.beforeStateDigest);
    const counterfactual = sameState ?? (normalizedBinding === 'vector' ? recorded.at(-1) : undefined);
    if (counterfactual === undefined) {
      counters.unevaluable += 1;
      pushSample(samples, { ...sample, classification: 'UNEVALUABLE', reason: 'NO_STRICT_OUTCOME' });
      continue;
    }
    const delta = recordedDistance - counterfactual.goalDistanceAfter;
    bindingDeltas.push(delta);
    if (sameState !== null) {
      counters.strict += 1;
      pushSample(samples, { ...sample, classification: 'STRICT', sameBeforeState: true, delta });
    } else {
      counters.vector += 1;
      pushSample(samples, {
        ...sample,
        classification: 'VECTOR',
        sameBeforeState: false,
        counterfactualGoalDistanceAfter: counterfactual.goalDistanceAfter,
        delta,
      });
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    type: EVALUATION_TYPE,
    version: EVALUATION_VERSION,
    mode: EVALUATION_MODE,
    binding: normalizedBinding,
    policyDigest: canonicalDigest(normalizedPolicy),
    basis: { steps: counters.steps, opaque: counters.opaque, vectorStates: index.size, recordedOutcomes: outcomeCount(index) },
    agreement: {
      matched: counters.matched,
      diverged: counters.diverged,
      agreementRate: counters.steps === 0 ? null : counters.matched / counters.steps,
    },
    divergence: {
      evaluated: counters.strict + counters.vector,
      strict: counters.strict,
      vector: counters.vector,
      unevaluable: counters.unevaluable,
    },
    outcome: outcomeSummary(bindingDeltas),
    samples,
  };
}

function buildOutcomeIndex(entries) {
  const index = new Map();
  for (const entry of entries) {
    const goalDistanceAfter = verifiedGoalDistance(entry);
    if (goalDistanceAfter === null) continue;
    const token = entry?.candidateOutcome?.token;
    const vectorKey = observableVectorKey(entry);
    if (!TOKEN_PATTERN.test(token ?? '') || vectorKey === null) continue;
    if (!index.has(vectorKey)) index.set(vectorKey, new Map());
    const byToken = index.get(vectorKey);
    if (!byToken.has(token)) byToken.set(token, []);
    byToken.get(token).push({
      beforeStateDigest: typeof entry?.beforeStateDigest === 'string' ? entry.beforeStateDigest : null,
      goalDistanceAfter,
    });
  }
  return index;
}

function observableVectorKey(entry) {
  const digest = typeof entry?.beforeVectorDigest === 'string' && DIGEST_PATTERN.test(entry.beforeVectorDigest)
    ? entry.beforeVectorDigest
    : rawVectorDigest(entry?.beforeVector);
  if (digest === null) return null;
  // The vector equivalence is scoped to one WorldPort identity and scenario:
  // the same numeric vector under different dynamics is not the same state.
  const scoped = canonicalDigest({
    ...worldPortIdentity(entry),
    worldVersion: typeof entry?.worldVersion === 'string' ? entry.worldVersion : null,
    tokenMapDigest: typeof entry?.tokenMapDigest === 'string' ? entry.tokenMapDigest : null,
    scenario: typeof entry?.scenario === 'string' ? entry.scenario : null,
    beforeVectorDigest: digest,
  });
  return scoped;
}

function worldPortIdentity(entry) {
  const worldId = typeof entry?.worldId === 'string' && entry.worldId.length > 0 ? entry.worldId : null;
  const worldImplementationDigest = typeof entry?.worldImplementationDigest === 'string' &&
    DIGEST_PATTERN.test(entry.worldImplementationDigest)
    ? entry.worldImplementationDigest
    : null;
  if (worldId === null && worldImplementationDigest === null) return {};
  return { worldId, worldImplementationDigest };
}

function rawVectorDigest(vector) {
  if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) return null;
  return canonicalDigest(vector);
}

function outcomeSummary(bindingDeltas) {
  const summary = { verdict: bindingDeltas.length === 0 ? 'INSUFFICIENT_EVIDENCE' : bindingVerdict(bindingDeltas), bindingCount: bindingDeltas.length };
  if (bindingDeltas.length === 0) return summary;
  let total = 0;
  let min = bindingDeltas[0];
  let max = bindingDeltas[0];
  for (const delta of bindingDeltas) {
    total += delta;
    if (delta < min) min = delta;
    if (delta > max) max = delta;
  }
  summary.minDelta = min;
  summary.maxDelta = max;
  summary.meanDelta = total / bindingDeltas.length;
  return summary;
}

function bindingVerdict(bindingDeltas) {
  if (bindingDeltas.some((delta) => delta < 0)) return 'COUNTERFACTUAL_WORSE';
  return bindingDeltas.some((delta) => delta > 0) ? 'COUNTERFACTUAL_BETTER' : 'TIE';
}

function verifiedGoalDistance(entry) {
  const quality = entry?.quality;
  if (quality === null || typeof quality !== 'object' || Array.isArray(quality)) return null;
  if (quality.verified !== true) return null;
  const distance = quality.goalDistanceAfter;
  return Number.isFinite(distance) && distance >= 0 ? distance : null;
}

function lastOutcomeAtState(recorded, beforeStateDigest) {
  if (typeof beforeStateDigest !== 'string') return null;
  let found = null;
  for (const outcome of recorded) {
    if (outcome.beforeStateDigest === beforeStateDigest) found = outcome;
  }
  return found;
}

function pushSample(samples, sample) {
  if (samples.length < MAX_DIVERGENCE_SAMPLES) samples.push(sample);
}

function outcomeCount(index) {
  let total = 0;
  for (const byToken of index.values()) total += byToken.size;
  return total;
}

function kernelStep(entry) {
  return Number.isSafeInteger(entry?.kernelStep) && entry.kernelStep >= 0 ? entry.kernelStep : null;
}

function requirePolicy(policy) {
  if (!isRecord(policy) || policy.schemaVersion !== SCHEMA_VERSION || policy.type !== POLICY_TYPE ||
      policy.version !== POLICY_VERSION || !TOKEN_PATTERN.test(policy.defaultToken ?? '')) {
    throw evaluationError('Counterfactual evaluation requires a normalized candidate policy.');
  }
  if (!Array.isArray(policy.rules)) {
    throw evaluationError('Counterfactual evaluation requires a normalized candidate policy.');
  }
  for (const rule of policy.rules) {
    if (!isRecord(rule) || !DIGEST_PATTERN.test(rule.observationDigest ?? '') || !TOKEN_PATTERN.test(rule.token ?? '')) {
      throw evaluationError('Counterfactual evaluation requires a normalized candidate policy.');
    }
  }
  return policy;
}

function requireBinding(value) {
  if (!BINDING_MODES.includes(value)) {
    throw evaluationError('Counterfactual binding must be vector or strict.');
  }
  return value;
}

function requireHistory(history) {
  if (!Array.isArray(history)) {
    throw evaluationError('Counterfactual evaluation requires a candidate outcome history array.');
  }
  return history;
}

function evaluationError(message) {
  return Object.assign(new Error(message), { code: 'INVALID_INPUT', context: { field: 'policy' } });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

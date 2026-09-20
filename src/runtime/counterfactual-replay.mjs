import { canonicalDigest } from './schema.mjs';

const SCHEMA_VERSION = 1;
const EVALUATION_TYPE = 'counterfactual-policy-evaluation';
const EVALUATION_VERSION = 2;
const CORPUS_EVALUATION_TYPE = 'counterfactual-policy-corpus-evaluation';
const CORPUS_EVALUATION_VERSION = 1;
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
  const scope = historyScope(entries);
  if (scope.status !== 'UNIFORM') {
    return insufficientScopeEvaluation({ normalizedPolicy, normalizedBinding, scope, historyLength: entries.length });
  }
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
    const counterfactual = sameState ?? (normalizedBinding === 'vector' ? meanOutcome(recorded) : undefined);
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
    scope,
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

// A corpus is an evidence report over independent histories. Histories may
// share verified outcomes only after they resolve to the same WorldPort scope;
// a different scope is kept in its own group and cannot affect the verdict.
export function evaluateCounterfactualPolicyCorpus({ histories, policy, binding = 'vector', scopeHints } = {}) {
  if (!Array.isArray(histories)) {
    throw evaluationError('Counterfactual evaluation requires a history corpus array.', { field: 'histories' });
  }
  if (scopeHints !== undefined && (!Array.isArray(scopeHints) || scopeHints.length !== histories.length)) {
    throw evaluationError('Counterfactual scope hints must match the history corpus.', { field: 'scopeHints' });
  }
  const normalizedPolicy = requirePolicy(policy);
  const normalizedBinding = requireBinding(binding);
  const partitions = histories.map((history, historyIndex) => ({
    historyIndex,
    ...evaluateCounterfactualPolicy({
      history,
      policy: normalizedPolicy,
      binding: normalizedBinding,
    }),
  }));
  const scope = corpusScope(partitions, scopeHints);
  const scopeEvaluations = evaluateScopeGroups({ histories, partitions, policy: normalizedPolicy, binding: normalizedBinding, scopeHints });
  const basis = scopeEvaluations.reduce((total, evaluation) => ({
    historyCount: total.historyCount,
    steps: total.steps + evaluation.basis.steps,
    opaque: total.opaque + evaluation.basis.opaque,
    evaluated: total.evaluated + evaluation.divergence.evaluated,
    strict: total.strict + evaluation.divergence.strict,
    vector: total.vector + evaluation.divergence.vector,
    unevaluable: total.unevaluable + evaluation.divergence.unevaluable,
    recordedOutcomes: total.recordedOutcomes + evaluation.basis.recordedOutcomes,
  }), {
    historyCount: partitions.length,
    steps: 0,
    opaque: 0,
    evaluated: 0,
    strict: 0,
    vector: 0,
    unevaluable: 0,
    recordedOutcomes: 0,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    type: CORPUS_EVALUATION_TYPE,
    version: CORPUS_EVALUATION_VERSION,
    binding: normalizedBinding,
    policyDigest: canonicalDigest(normalizedPolicy),
    scope,
    basis,
    outcome: scope.status === 'UNIFORM'
      ? corpusOutcomeSummary(scopeEvaluations)
      : { verdict: 'INSUFFICIENT_EVIDENCE', bindingCount: 0 },
    partitions,
    scopeEvaluations,
  };
}

function evaluateScopeGroups({ histories, partitions, policy, binding, scopeHints }) {
  const groups = new Map();
  for (let index = 0; index < histories.length; index += 1) {
    const keyInfo = scopeKeyInfo(partitions[index], index, scopeHints);
    const groupKey = keyInfo.key ?? `partition:${index}`;
    const group = groups.get(groupKey) ?? { scopeKey: keyInfo.key, historyIndexes: [], histories: [] };
    group.historyIndexes.push(index);
    group.histories.push(histories[index]);
    groups.set(groupKey, group);
  }
  return [...groups.values()].map((group) => ({
    scopeKey: group.scopeKey,
    historyIndexes: group.historyIndexes,
    ...evaluateCounterfactualPolicy({
      history: group.histories.flat(),
      policy,
      binding,
    }),
  }));
}

function scopeKeyInfo(partition, index, scopeHints) {
  if (partition.scope.status !== 'UNIFORM') return { key: null, invalid: false };
  if (scopeHints === undefined) return { key: partition.scope.key, invalid: partition.scope.key === null };
  const hintKey = historyScopeKey(scopeHints[index]);
  if (hintKey.invalid) return { key: null, invalid: true };
  if (partition.scope.key !== null && partition.scope.key !== hintKey.digest) return { key: null, invalid: false };
  return { key: hintKey.digest, invalid: false };
}

function corpusScope(partitions, scopeHints) {
  const scopes = partitions.map((partition) => partition.scope);
  if (scopes.some((partitionScope) => partitionScope.status === 'INVALID')) {
    return { status: 'INVALID', partitionCount: 0 };
  }
  if (scopes.some((partitionScope) => partitionScope.status !== 'UNIFORM')) {
    return { status: 'MIXED', partitionCount: scopes.length };
  }
  const keyInfos = partitions.map((partition, index) => scopeKeyInfo(partition, index, scopeHints));
  if (keyInfos.some((info) => info.invalid)) return { status: 'INVALID', partitionCount: 0 };
  if (keyInfos.some((info) => info.key === null)) return { status: 'MIXED', partitionCount: scopes.length };
  const keys = new Set(keyInfos.map((info) => info.key));
  return {
    status: keys.size > 1 ? 'MIXED' : 'UNIFORM',
    partitionCount: keys.size,
  };
}

function corpusOutcomeSummary(partitions) {
  const evaluated = partitions.filter((partition) => partition.outcome.bindingCount > 0);
  const bindingCount = evaluated.reduce((total, partition) => total + partition.outcome.bindingCount, 0);
  if (bindingCount === 0) return { verdict: 'INSUFFICIENT_EVIDENCE', bindingCount: 0 };

  let total = 0;
  let min = Infinity;
  let max = -Infinity;
  let hasNegative = false;
  let hasPositive = false;
  for (const partition of evaluated) {
    const outcome = partition.outcome;
    total += outcome.meanDelta * outcome.bindingCount;
    min = Math.min(min, outcome.minDelta);
    max = Math.max(max, outcome.maxDelta);
    hasNegative ||= outcome.minDelta < 0;
    hasPositive ||= outcome.maxDelta > 0;
  }
  const verdict = hasNegative && hasPositive
    ? 'MIXED_EVIDENCE'
    : hasNegative
      ? 'COUNTERFACTUAL_WORSE'
      : hasPositive
        ? 'COUNTERFACTUAL_BETTER'
        : 'TIE';
  return {
    verdict,
    bindingCount,
    minDelta: min,
    maxDelta: max,
    meanDelta: total / bindingCount,
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
    ...seedIdentity(entry?.seed),
    worldVersion: typeof entry?.worldVersion === 'string' ? entry.worldVersion : null,
    tokenMapDigest: typeof entry?.tokenMapDigest === 'string' ? entry.tokenMapDigest : null,
    scenario: typeof entry?.scenario === 'string' ? entry.scenario : null,
    valueSpecDigest: typeof entry?.valueSpecDigest === 'string' ? entry.valueSpecDigest : null,
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

function seedIdentity(value) {
  return typeof value === 'string' && value.length > 0 ? { seed: value } : {};
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

function meanOutcome(recorded) {
  if (recorded.length === 1) return recorded[0];
  const total = recorded.reduce((sum, outcome) => sum + outcome.goalDistanceAfter, 0);
  return {
    beforeStateDigest: null,
    goalDistanceAfter: total / recorded.length,
  };
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

function historyScope(entries) {
  const keys = entries.map(historyScopeKey);
  const scopes = new Set(keys.map((key) => key.digest));
  if (keys.some((key) => key.invalid)) return { status: 'INVALID', partitionCount: scopes.size, key: null };
  return {
    status: scopes.size > 1 ? 'MIXED' : 'UNIFORM',
    partitionCount: scopes.size,
    key: scopes.size === 1 ? keys[0].digest : null,
  };
}

function insufficientScopeEvaluation({ normalizedPolicy, normalizedBinding, scope, historyLength }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: EVALUATION_TYPE,
    version: EVALUATION_VERSION,
    mode: EVALUATION_MODE,
    binding: normalizedBinding,
    scope,
    policyDigest: canonicalDigest(normalizedPolicy),
    basis: { steps: 0, opaque: historyLength, vectorStates: 0, recordedOutcomes: 0 },
    agreement: { matched: 0, diverged: 0, agreementRate: null },
    divergence: { evaluated: 0, strict: 0, vector: 0, unevaluable: 0 },
    outcome: { verdict: 'INSUFFICIENT_EVIDENCE', bindingCount: 0 },
    samples: [],
  };
}

function historyScopeKey(entry) {
  const fields = {
    worldId: scopeField(entry?.worldId, (value) => typeof value === 'string' && value.length > 0),
    worldVersion: scopeField(entry?.worldVersion, (value) => typeof value === 'string' && value.length > 0),
    worldImplementationDigest: scopeField(
      entry?.worldImplementationDigest,
      (value) => typeof value === 'string' && DIGEST_PATTERN.test(value),
    ),
    scenario: scopeField(entry?.scenario, (value) => typeof value === 'string' && value.length > 0),
    tokenMapDigest: scopeField(
      entry?.tokenMapDigest,
      (value) => typeof value === 'string' && DIGEST_PATTERN.test(value),
    ),
    valueSpecDigest: scopeField(
      entry?.valueSpecDigest,
      (value) => typeof value === 'string' && DIGEST_PATTERN.test(value),
    ),
  };
  return {
    digest: canonicalDigest(fields),
    invalid: Object.values(fields).some((field) => field.status === 'invalid'),
  };
}

function scopeField(value, isValid) {
  if (value === undefined) return { status: 'missing', value: null };
  if (isValid(value)) return { status: 'valid', value };
  return { status: 'invalid', value: typeof value === 'string' ? value : typeof value };
}

function evaluationError(message, context = { field: 'policy' }) {
  return Object.assign(new Error(message), { code: 'INVALID_INPUT', context });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

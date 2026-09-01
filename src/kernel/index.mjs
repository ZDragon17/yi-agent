import { canonicalDigest } from '../runtime/schema.mjs';

const SCHEMA_VERSION = 1;
const CONTRACT_ERROR_CODE = 'KERNEL_CONTRACT_VIOLATION';
const TOKEN_PATTERN = /^tok_[A-Z0-9]{8,128}$/u;
const MAX_VECTOR_DIMENSIONS = 1024;
const MAX_CAPABILITIES = 4096;
const MAX_ACTION_MODELS = 8192;
const MAX_RELATION_MODELS = 8192;
const MAX_RELATION_KEY_LENGTH = MAX_VECTOR_DIMENSIONS + 3;
const ADAPTATION_WINDOW = 8;
const MAX_PLANNING_HORIZON = 8;
const MAX_PLANNING_CANDIDATES = 64;
const PLANNING_INFORMATION_MODES = ['belief-v1', 'belief-v2', 'legacy-v1'];
const MAX_PENDING_CREDITS = 64;
const MAX_FEEDBACK_ITEMS = 64;
const MAX_EXECUTION_NONCE_LENGTH = 256;
const MAX_SETTLED_FEEDBACK = 64;
const MAX_PENDING_CREDIT_AGE = 8;
const MAX_BELIEF_MODELS = 8192;
const MAX_BELIEF_SAMPLES = 8;
const MAX_RECENT_HISTORY = 2;
const MAX_CONTEXT_MODELS = 8192;
// A long-context key is an exact fingerprint, so its cache must stay tiny;
// h1 remains the reusable generalization layer for ordinary continuous runs.
const MAX_LONG_CONTEXTS = 1;
const MAX_CONTEXT_KEY_LENGTH = 4096;
const OVERALL_BELIEF_CONTEXT = 'overall';
const HISTORY_ACCUMULATOR_HEX_LENGTH = 64;
const HISTORY_ACCUMULATOR_PATTERN = /^[0-9a-f]{64}$/u;
const HISTORY_ACCUMULATOR_MASK = (1n << 256n) - 1n;
const HISTORY_ACCUMULATOR_BASE = 0x9e3779b185ebca87f4a7c15f39cc0605n;
const FEEDBACK_ORDER_MODES = ['arrival-v1', 'pending-v2'];
const FEEDBACK_CAUSALITY_MODES = ['legacy-v1', 'boundary-v2'];

const STEP_INPUT_KEYS = [
  'observation',
  'memory',
  'valueSpec',
  'capabilities',
  'rngState',
  'strategy',
  'planning',
];
const STEP_INPUT_REQUIRED_KEYS = STEP_INPUT_KEYS.filter((key) => key !== 'strategy' && key !== 'planning');
const VERIFY_INPUT_KEYS = ['intent', 'receipt', 'postObservation'];
const LEARN_INPUT_KEYS = [
  'memory',
  'intent',
  'receipt',
  'postObservation',
  'verification',
  'feedbackOrder',
  'feedbackCausality',
];
const LEARN_INPUT_REQUIRED_KEYS = LEARN_INPUT_KEYS.filter((key) => !['feedbackOrder', 'feedbackCausality'].includes(key));
const VERIFICATION_KEYS = [
  'schemaVersion',
  'error',
  'attribution',
  'confidence',
  'learnable',
];
const OBSERVATION_KEYS = [
  'schemaVersion',
  'vector',
  'stateVersion',
  'intervalId',
  'feedback',
];
const VALUE_SPEC_KEYS = [
  'schemaVersion',
  'observationDimensions',
  'weights',
  'target',
  'tolerance',
  'valueMode',
];
const VALUE_MODES = ['signed-v1', 'distance-v2'];
const MEMORY_KEYS = ['schemaVersion', 'actionModels', 'relationModels', 'rejectionModels', 'pendingCredits', 'settledFeedback', 'pendingCreditPolicy', 'beliefModels', 'contextModels', 'recentHistory', 'historyClock', 'historyAccumulator'];
const ACTION_MODEL_KEYS = [
  'schemaVersion',
  'sampleCount',
  'meanDelta',
  'uncertainty',
];
const REJECTION_MODEL_KEYS = ['schemaVersion', 'sampleCount', 'rejected', 'relationKey'];
const CAPABILITY_KEYS = [
  'schemaVersion',
  'token',
  'cost',
  'allowed',
  'safe',
];
const RNG_STATE_KEYS = ['schemaVersion', 'algorithm', 'state'];
const STRATEGY_KEYS = ['schemaVersion', 'mode', 'revision', 'reason'];
const INTENT_KEYS = [
  'schemaVersion',
  'status',
  'expectation',
  'choice',
  'nextRngState',
];
const EXPECTATION_KEYS = [
  'schemaVersion',
  'token',
  'expectedDelta',
  'predictedObservation',
  'relationKey',
  'score',
  'sampleCount',
  'uncertainty',
];
const CHOICE_KEYS = [
  'schemaVersion',
  'token',
  'score',
  'expectedValue',
  'cost',
  'allowed',
  'safe',
];
const RECEIPT_KEYS = [
  'schemaVersion',
  'status',
  'token',
  'basedOnVersion',
  'policyVersion',
  'constraintsDigest',
  'executionNonce',
  'effectDigest',
  'rejectionReason',
  'attributionWindowComplete',
  'confounderCount',
];
const FEEDBACK_KEYS = [
  'schemaVersion',
  'executionNonce',
  'stateVersion',
  'intervalId',
  'vector',
  'confounderCount',
];
const PENDING_CREDIT_KEYS = [
  'schemaVersion',
  'executionNonce',
  'token',
  'beforeStateVersion',
  'beforeIntervalId',
  'beforeVector',
  'expectedDelta',
  'relationKey',
  'contextKey',
  'contextKeys',
  'historyOrder',
  'age',
];
const PENDING_CREDIT_POLICY_KEYS = ['schemaVersion', 'maxAge'];
const BELIEF_MODEL_KEYS = ['schemaVersion', 'sampleCount', 'samples'];
const HISTORY_ENTRY_KEYS = ['schemaVersion', 'token', 'actualDelta', 'historyOrder'];

export function step(input) {
  return stepWithPreference(input, null);
}

export function mergeObservationFeedback(before, after) {
  const first = normalizeObservation(before, 'beforeObservation');
  const second = normalizeObservation(after, 'postObservation');
  if (first.vector.length !== second.vector.length) {
    contractViolation('kernel feedback observations have different dimensions', {
      field: 'postObservation.vector',
    });
  }
  const feedback = [...(first.feedback ?? [])];
  for (const item of second.feedback ?? []) {
    const existing = feedback.find((candidate) => candidate.executionNonce === item.executionNonce);
    if (existing === undefined) {
      feedback.push(item);
    } else if (!feedbackEqual(existing, item)) {
      contractViolation('kernel feedback for an execution nonce is contradictory', {
        field: 'postObservation.feedback',
        executionNonce: item.executionNonce,
      });
    }
  }
  return {
    ...cloneObservation(second),
    ...(feedback.length === 0 ? {} : { feedback: feedback.map(cloneFeedback) }),
  };
}

export function validateObservationFeedback(memoryValue, observationValue) {
  const observation = normalizeObservation(observationValue, 'observation');
  const memory = normalizeMemory(memoryValue, 'memory', observation.vector.length);
  settlePendingCredits(
    cloneMemory(memory),
    observation,
    observation.vector.length,
    'observation.feedback',
  );
}

// A model may suggest a token, but it cannot change the kernel's prediction,
// safety checks, verification contract, or learning rules.
export function stepWithPreference(input, preference = null) {
  const normalized = normalizeStepInput(input);
  const normalizedPreference = normalizePreference(preference);
  const predictions = buildPredictions(normalized);
  const safePredictions = predictions.filter(
    (item) => item.choice.allowed && item.choice.safe,
  );

  if (safePredictions.length === 0) {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: 'HALTED',
      stopReason: 'NO_SAFE_ACTION',
      expectation: null,
      choice: null,
      nextRngState: cloneRngState(normalized.rngState),
    };
  }

  const rng = advanceRng(normalized.rngState);
  const nonRejectedPredictions = safePredictions.filter((item) => !item.rejectedRecently);
  const untriedPredictions = safePredictions.filter(
    (item) => item.expectation.sampleCount === 0 && !item.rejectedRecently,
  );
  const selectionPool = untriedPredictions.length > 0
    ? untriedPredictions
    : nonRejectedPredictions.length > 0
      ? nonRejectedPredictions
      : safePredictions;
  const preferred = normalizedPreference === null
    ? null
    : safePredictions.find((item) => item.choice.token === normalizedPreference.token &&
      (!item.rejectedRecently || nonRejectedPredictions.length === 0));
  const selected = preferred ?? (normalized.planning.horizon > 1 && untriedPredictions.length === 0
    ? chooseByPlanning(selectionPool, normalized, rng.unit)
    : chooseByStrategy(selectionPool, normalized.strategy, rng.unit));

  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'READY',
    expectation: cloneExpectation(selected.expectation),
    choice: cloneChoice(selected.choice),
    nextRngState: rng.nextState,
  };
}

function normalizePreference(value) {
  if (value === null || value === undefined) return null;
  const source = assertPlainRecord(value, 'stepPreference', ['schemaVersion', 'token']);
  return {
    schemaVersion: requireSchemaVersion(source, 'stepPreference'),
    token: assertOpaqueToken(source.token, 'stepPreference.token'),
  };
}

export function verify(input) {
  const source = assertPlainRecord(input, 'verifyInput', VERIFY_INPUT_KEYS);
  const intent = normalizeIntent(source.intent, 'verifyInput.intent');
  const receipt = normalizeReceipt(source.receipt, 'verifyInput.receipt');
  const postObservation = normalizeObservation(
    source.postObservation,
    'verifyInput.postObservation',
  );

  assertIntentReceiptConsistency(intent, receipt);

  if (
    receipt.status === 'ACCEPTED' &&
    postObservation.stateVersion === receipt.basedOnVersion
  ) {
    contractViolation('accepted action requires a new post-observation version', {
      field: 'verifyInput.postObservation.stateVersion',
    });
  }

  if (postObservation.vector.length !== intent.expectation.expectedDelta.length) {
    contractViolation('kernel verify postObservation dimension mismatch', {
      field: 'verifyInput.postObservation.vector',
      expectedLength: intent.expectation.expectedDelta.length,
      actualLength: postObservation.vector.length,
    });
  }

  const error = subtractVectors(
    postObservation.vector,
    intent.expectation.predictedObservation.vector,
    'verifyInput.error',
  );

  if (receipt.status === 'REJECTED') {
    return verificationResult({
      error,
      attribution: 'EXECUTION_REJECTED',
      confidence: 0,
      learnable: false,
    });
  }

  if (
    receipt.attributionWindowComplete !== true ||
    receipt.confounderCount > 0
  ) {
    return verificationResult({
      error,
      attribution: 'AMBIGUOUS',
      confidence: 0,
      learnable: false,
    });
  }

  return verificationResult({
    error,
    attribution: 'ACTION',
    confidence: confidenceFromError(error),
    learnable: true,
  });
}

export function learn(input) {
  const source = assertPlainRecord(input, 'learnInput', LEARN_INPUT_KEYS, LEARN_INPUT_REQUIRED_KEYS);
  const feedbackOrder = source.feedbackOrder === undefined
    ? 'pending-v2'
    : assertOneOf(source.feedbackOrder, FEEDBACK_ORDER_MODES, 'learnInput.feedbackOrder');
  const feedbackCausality = source.feedbackCausality === undefined
    ? 'boundary-v2'
    : assertOneOf(source.feedbackCausality, FEEDBACK_CAUSALITY_MODES, 'learnInput.feedbackCausality');
  const intent = normalizeIntent(source.intent, 'learnInput.intent');
  const dimensions = intent.expectation.expectedDelta.length;
  const memory = normalizeMemory(source.memory, 'learnInput.memory', dimensions);
  const claimedVerification = normalizeVerification(
    source.verification,
    'learnInput.verification',
    dimensions,
  );
  const postObservation = normalizeObservation(
    source.postObservation,
    'learnInput.postObservation',
  );
  const verification = verify({
    intent: source.intent,
    receipt: source.receipt,
    postObservation,
  });
  assertVerificationMatches(claimedVerification, verification);
  assertIntentIsExecutable(intent, 'learnInput.intent.choice');

  const nextMemory = cloneMemory(memory);
  const contextKeys = contextKeysForMemory(memory);
  const settlement = settlePendingCredits(
    nextMemory,
    postObservation,
    dimensions,
    'learnInput.postObservation.feedback',
    feedbackOrder,
    feedbackCausality,
  );
  const settled = settlement.entries;

  if (!verification.learnable || verification.attribution !== 'ACTION') {
    if (verification.attribution === 'EXECUTION_REJECTED' && source.receipt.status === 'REJECTED') {
      const token = intent.choice.token;
      const rejectionModels = nextMemory.rejectionModels ?? {};
      if (rejectionModels[token] === undefined && Object.keys(rejectionModels).length >= MAX_ACTION_MODELS) {
        contractViolation('kernel learning would exceed the rejection-model limit', {
          field: 'learnOutput.nextMemory.rejectionModels',
        });
      }
      rejectionModels[token] = updateRejectionModel(
        rejectionModels[token],
        true,
        intent.expectation.relationKey,
        `learnOutput.nextMemory.rejectionModels.${token}`,
      );
      nextMemory.rejectionModels = rejectionModels;
      return {
        schemaVersion: SCHEMA_VERSION,
        status: 'REJECTION_RECORDED',
        token,
        nextMemory,
        ...(settled.length === 0 ? {} : { settled }),
      };
    }
    if (source.receipt.status === 'ACCEPTED' &&
        source.receipt.attributionWindowComplete === false &&
        source.receipt.confounderCount === 0) {
      addPendingCredit(
        nextMemory,
        intent,
        source.receipt.executionNonce,
        pendingBaselineObservation(intent, settlement.cleanDeltas),
        contextKeys,
        nextHistoryOrder(nextMemory),
        'learnOutput.nextMemory.pendingCredits',
      );
      return {
        schemaVersion: SCHEMA_VERSION,
        status: 'DEFERRED',
        token: intent.choice.token,
        nextMemory,
        ...(settled.length === 0 ? {} : { settled }),
      };
    }
    if (settled.length > 0) {
      return {
        schemaVersion: SCHEMA_VERSION,
        status: 'SKIPPED',
        token: intent.choice.token,
        nextMemory,
        settled,
      };
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      status: 'SKIPPED',
      token: intent.choice.token,
      nextMemory,
      ...(settled.length === 0 ? {} : { settled }),
    };
  }

  if (settlement.hasFeedbackSettlement) {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: 'SKIPPED',
      token: intent.choice.token,
      nextMemory,
      settled,
    };
  }

  const token = intent.choice.token;
  const historyOrder = nextHistoryOrder(nextMemory);
  const actualDelta = addVectors(
    intent.expectation.expectedDelta,
    verification.error,
    'learnOutput.actualDelta',
  );
  let totalError = 0;
  for (let index = 0; index < verification.error.length; index += 1) {
    totalError = assertComputedFiniteNumber(
      totalError + Math.abs(verification.error[index]),
      `learnOutput.errorMagnitude[${index}]`,
    );
  }
  const errorMagnitude = totalError / dimensions;
  recordActionEvidence(nextMemory, {
    token,
    relationKey: intent.expectation.relationKey,
    contextKeys,
    historyOrder,
    actualDelta,
    errorMagnitude,
    dimensions,
    field: 'learnOutput.nextMemory',
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'UPDATED',
    token,
    nextMemory,
    ...(settled.length === 0 ? {} : { settled }),
  };
}

function settlePendingCredits(
  memory,
  postObservation,
  dimensions,
  field,
  feedbackOrder = 'pending-v2',
  feedbackCausality = 'boundary-v2',
) {
  const feedback = postObservation.feedback ?? [];
  const pendingCredits = memory.pendingCredits ?? [];
  const pendingByNonce = new Map(pendingCredits.map((credit) => [credit.executionNonce, credit]));
  const settledFeedback = memory.settledFeedback ?? [];
  const settledFeedbackByNonce = new Map(settledFeedback.map((item) => [item.executionNonce, item]));
  const settled = [];
  const cleanDeltas = [];
  const remaining = [];
  const settledNonces = new Set();
  const feedbackNonces = new Set(feedback.map((item) => item.executionNonce));
  // Feedback is a set of nonce-bound facts; current transport order must not leak into memory.
  const pendingOrder = new Map(pendingCredits.map((credit, index) => [credit.executionNonce, index]));
  const orderedFeedback = feedbackOrder === 'arrival-v1'
    ? feedback
    : [...feedback].sort((left, right) => {
      const leftOrder = pendingOrder.get(left.executionNonce) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = pendingOrder.get(right.executionNonce) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.executionNonce.localeCompare(right.executionNonce);
    });
  const freshBoundaryCounts = new Map();
  if (feedbackCausality === 'boundary-v2') {
    for (const item of orderedFeedback) {
      if (pendingByNonce.has(item.executionNonce) && !settledFeedbackByNonce.has(item.executionNonce)) {
        const boundary = feedbackBoundaryKey(item);
        freshBoundaryCounts.set(boundary, (freshBoundaryCounts.get(boundary) ?? 0) + 1);
      }
    }
  }
  let hasFeedbackSettlement = false;

  for (const credit of pendingCredits) {
    if (feedbackNonces.has(credit.executionNonce)) continue;
    if (memory.pendingCreditPolicy === undefined) {
      remaining.push(credit);
      continue;
    }
    const age = (credit.age ?? 0) + 1;
    if (age >= memory.pendingCreditPolicy.maxAge) {
      settled.push({
        schemaVersion: SCHEMA_VERSION,
        executionNonce: credit.executionNonce,
        token: credit.token,
        attribution: 'UNRESOLVED',
        confidence: 0,
        learnable: false,
        error: null,
        reason: 'FEEDBACK_TIMEOUT',
      });
      continue;
    }
    remaining.push({ ...credit, age });
  }

  for (const item of orderedFeedback) {
    const pending = pendingByNonce.get(item.executionNonce);
    const prior = settledFeedbackByNonce.get(item.executionNonce);
    if (pending === undefined) {
      if (prior !== undefined && feedbackEqual(prior, item)) continue;
      contractViolation('kernel feedback references no pending action', { field, executionNonce: item.executionNonce });
    }
    if (prior !== undefined) {
      contractViolation('kernel feedback is contradictory for an already settled action', {
        field,
        executionNonce: item.executionNonce,
      });
    }
    if (settledNonces.has(item.executionNonce)) {
      contractViolation('kernel feedback contains a duplicate execution nonce', { field, executionNonce: item.executionNonce });
    }
    settledNonces.add(item.executionNonce);
    if (item.stateVersion === pending.beforeStateVersion || item.intervalId === pending.beforeIntervalId) {
      contractViolation('kernel feedback is stale for its pending action', {
        field,
        executionNonce: item.executionNonce,
      });
    }
    const sharedObservationBoundary = feedbackCausality === 'boundary-v2' &&
      freshBoundaryCounts.get(feedbackBoundaryKey(item)) > 1;
    if (item.confounderCount > 0 || sharedObservationBoundary) {
      hasFeedbackSettlement = true;
      rememberSettledFeedback(memory, item);
      settled.push({
        schemaVersion: SCHEMA_VERSION,
        executionNonce: item.executionNonce,
        token: pending.token,
        attribution: 'AMBIGUOUS',
        confidence: 0,
        learnable: false,
        error: subtractVectors(item.vector, addVectors(pending.beforeVector, pending.expectedDelta, `${field}.${item.executionNonce}.predictedVector`), `${field}.${item.executionNonce}.error`),
      });
      continue;
    }
    const actualDelta = subtractVectors(
      item.vector,
      pending.beforeVector,
      `${field}.${item.executionNonce}.actualDelta`,
    );
    const error = subtractVectors(
      actualDelta,
      pending.expectedDelta,
      `${field}.${item.executionNonce}.error`,
    );
    let totalError = 0;
    for (const value of error) totalError = assertComputedFiniteNumber(totalError + Math.abs(value), `${field}.${item.executionNonce}.errorMagnitude`);
    const errorMagnitude = totalError / dimensions;
    recordActionEvidence(memory, {
      token: pending.token,
      relationKey: pending.relationKey,
      contextKeys: pending.contextKeys ?? (pending.contextKey === undefined ? undefined : [pending.contextKey]),
      historyOrder: pending.historyOrder,
      actualDelta,
      errorMagnitude,
      dimensions,
      field: `learnOutput.nextMemory.settled.${item.executionNonce}`,
    });
    hasFeedbackSettlement = true;
    rememberSettledFeedback(memory, item);
    cleanDeltas.push(actualDelta);
    settled.push({
      schemaVersion: SCHEMA_VERSION,
      executionNonce: item.executionNonce,
      token: pending.token,
      attribution: 'ACTION',
      confidence: confidenceFromError(error),
      learnable: true,
      error,
    });
  }

  if (memory.pendingCredits !== undefined || feedback.length > 0) memory.pendingCredits = remaining;
  return { entries: settled, cleanDeltas, hasFeedbackSettlement };
}

function feedbackBoundaryKey(feedback) {
  return `${feedback.stateVersion.length}:${feedback.stateVersion}${feedback.intervalId.length}:${feedback.intervalId}`;
}

function rememberSettledFeedback(memory, feedback) {
  // Older ledgers do not carry a receipt window. Preserve their memory shape
  // so replaying them does not manufacture a new learning field.
  if (memory.settledFeedback === undefined) return;
  const settledFeedback = memory.settledFeedback ?? [];
  if (settledFeedback.some((item) => item.executionNonce === feedback.executionNonce)) return;
  if (settledFeedback.length >= MAX_SETTLED_FEEDBACK) settledFeedback.shift();
  settledFeedback.push(cloneFeedback(feedback));
  memory.settledFeedback = settledFeedback;
}

function pendingBaselineObservation(intent, cleanDeltas) {
  const predicted = intent.expectation.predictedObservation;
  let vector = subtractVectors(
    predicted.vector,
    intent.expectation.expectedDelta,
    'learnOutput.nextMemory.pendingCredits.beforeVector',
  );
  for (const delta of cleanDeltas) {
    vector = addVectors(
      vector,
      delta,
      'learnOutput.nextMemory.pendingCredits.beforeVector',
    );
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    vector,
    stateVersion: predicted.stateVersion,
    intervalId: predicted.intervalId,
  };
}

function addPendingCredit(memory, intent, executionNonce, baselineObservation, contextKeys, historyOrder, field) {
  const pendingCredits = memory.pendingCredits ?? [];
  if (pendingCredits.some((item) => item.executionNonce === executionNonce)) {
    contractViolation('kernel pending credits contain a reused execution nonce', { field });
  }
  if (pendingCredits.length >= MAX_PENDING_CREDITS) {
    contractViolation('kernel pending-credit limit exceeded', { field });
  }
  memory.pendingCredits = pendingCredits;
  pendingCredits.push({
    schemaVersion: SCHEMA_VERSION,
    executionNonce,
    token: intent.choice.token,
    beforeStateVersion: baselineObservation.stateVersion,
    beforeIntervalId: baselineObservation.intervalId,
    beforeVector: cloneVector(baselineObservation.vector),
    expectedDelta: cloneVector(intent.expectation.expectedDelta),
    ...(intent.expectation.relationKey === undefined ? {} : { relationKey: intent.expectation.relationKey }),
    ...(contextKeys === undefined ? {} : {
      contextKeys: [...contextKeys],
      ...(contextKeys[0] === undefined ? {} : { contextKey: contextKeys[0] }),
    }),
    ...(historyOrder === undefined ? {} : { historyOrder }),
    ...(memory.pendingCreditPolicy === undefined ? {} : { age: 0 }),
  });
}

function assertVerificationMatches(claimed, recomputed) {
  const scalarFields = ['attribution', 'confidence', 'learnable'];
  for (const field of scalarFields) {
    if (!Object.is(claimed[field], recomputed[field])) {
      contractViolation('kernel learning verification does not match its evidence', {
        field: `learnInput.verification.${field}`,
      });
    }
  }
  for (let index = 0; index < claimed.error.length; index += 1) {
    if (!Object.is(claimed.error[index], recomputed.error[index])) {
      contractViolation('kernel learning error does not match its evidence', {
        field: `learnInput.verification.error[${index}]`,
      });
    }
  }
}

function normalizeStepInput(input) {
  const source = assertPlainRecord(input, 'stepInput', STEP_INPUT_KEYS, STEP_INPUT_REQUIRED_KEYS);
  const observation = normalizeObservation(source.observation, 'stepInput.observation');
  const valueSpec = normalizeValueSpec(
    source.valueSpec,
    'stepInput.valueSpec',
    observation.vector.length,
  );
  const memory = normalizeMemory(
    source.memory,
    'stepInput.memory',
    observation.vector.length,
  );
  const capabilities = normalizeCapabilities(
    source.capabilities,
    'stepInput.capabilities',
  );
  const rngState = normalizeRngState(source.rngState, 'stepInput.rngState');
  const strategy = normalizeStrategy(source.strategy, 'stepInput.strategy');
  const planning = normalizePlanning(source.planning, 'stepInput.planning');

  return {
    observation,
    memory,
    valueSpec,
    capabilities,
    rngState,
    strategy,
    planning,
  };
}

function normalizePlanning(value, field) {
  if (value === undefined) {
    return { schemaVersion: SCHEMA_VERSION, horizon: 1, informationMode: 'belief-v2' };
  }
  const source = assertPlainRecord(
    value,
    field,
    ['schemaVersion', 'horizon', 'informationMode'],
    ['schemaVersion', 'horizon'],
  );
  const horizon = assertPositiveInteger(source.horizon, `${field}.horizon`);
  if (horizon > MAX_PLANNING_HORIZON) {
    contractViolation('kernel planning horizon exceeds its size limit', {
      field: `${field}.horizon`,
      max: MAX_PLANNING_HORIZON,
      actual: horizon,
    });
  }
  return {
    schemaVersion: requireSchemaVersion(source, field),
    horizon,
    informationMode: source.informationMode === undefined ? 'belief-v2' :
      assertOneOf(source.informationMode, PLANNING_INFORMATION_MODES, `${field}.informationMode`),
  };
}

function normalizeStrategy(value, field) {
  if (value === undefined) {
    return { schemaVersion: SCHEMA_VERSION, mode: 'BALANCED', revision: 0, reason: null };
  }
  const source = assertPlainRecord(value, field, STRATEGY_KEYS);
  if (requireSchemaVersion(source, field) !== SCHEMA_VERSION ||
      !['BALANCED', 'EXPLORATORY'].includes(source.mode) ||
      !Number.isSafeInteger(source.revision) || source.revision < 0 ||
      typeof source.reason !== 'string' && source.reason !== null) {
    contractViolation('kernel strategy is invalid', { field });
  }
  if (source.reason !== null && source.reason.length === 0) {
    contractViolation('kernel strategy reason must not be empty', { field: `${field}.reason` });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: source.mode,
    revision: source.revision,
    reason: source.reason,
  };
}

function normalizeObservation(value, field) {
  const source = assertPlainRecord(
    value,
    field,
    OBSERVATION_KEYS,
    OBSERVATION_KEYS.filter((key) => key !== 'feedback'),
  );
  const vector = assertFiniteVector(source.vector, `${field}.vector`);
  const stateVersion = assertNonEmptyString(source.stateVersion, `${field}.stateVersion`);
  const intervalId = assertNonEmptyString(source.intervalId, `${field}.intervalId`);
  const feedback = source.feedback === undefined
    ? undefined
    : normalizeFeedback(source.feedback, `${field}.feedback`, vector.length);

  return {
    schemaVersion: requireSchemaVersion(source, field),
    vector,
    stateVersion,
    intervalId,
    ...(feedback === undefined ? {} : { feedback }),
  };
}

function normalizeFeedback(value, field, dimensions) {
  const items = assertArray(value, field);
  assertCollectionLimit(items.length, MAX_FEEDBACK_ITEMS, field);
  const seen = new Set();
  return items.map((item, index) => {
    const source = assertPlainRecord(item, `${field}[${index}]`, FEEDBACK_KEYS);
    const executionNonce = assertBoundedString(
      source.executionNonce,
      `${field}[${index}].executionNonce`,
      MAX_EXECUTION_NONCE_LENGTH,
    );
    if (seen.has(executionNonce)) {
      contractViolation('kernel feedback contains a duplicate execution nonce', {
        field: `${field}[${index}].executionNonce`,
      });
    }
    seen.add(executionNonce);
    return {
      schemaVersion: requireSchemaVersion(source, `${field}[${index}]`),
      executionNonce,
      stateVersion: assertNonEmptyString(source.stateVersion, `${field}[${index}].stateVersion`),
      intervalId: assertNonEmptyString(source.intervalId, `${field}[${index}].intervalId`),
      vector: assertFiniteVector(source.vector, `${field}[${index}].vector`, dimensions),
      confounderCount: assertNonNegativeInteger(source.confounderCount, `${field}[${index}].confounderCount`),
    };
  });
}

function feedbackEqual(left, right) {
  return left.schemaVersion === right.schemaVersion &&
    left.executionNonce === right.executionNonce &&
    left.stateVersion === right.stateVersion &&
    left.intervalId === right.intervalId &&
    left.confounderCount === right.confounderCount &&
    left.vector.length === right.vector.length &&
    left.vector.every((value, index) => Object.is(value, right.vector[index]));
}

function cloneFeedback(value) {
  return {
    schemaVersion: SCHEMA_VERSION,
    executionNonce: value.executionNonce,
    stateVersion: value.stateVersion,
    intervalId: value.intervalId,
    vector: cloneVector(value.vector),
    confounderCount: value.confounderCount,
  };
}

function normalizeValueSpec(value, field, dimensions) {
  const source = assertPlainRecord(
    value,
    field,
    VALUE_SPEC_KEYS,
    VALUE_SPEC_KEYS.filter((key) => key !== 'tolerance' && key !== 'valueMode'),
  );
  const observationDimensions = assertPositiveInteger(
    source.observationDimensions,
    `${field}.observationDimensions`,
  );
  const weights = assertFiniteVector(source.weights, `${field}.weights`, dimensions);
  const target = assertFiniteVector(source.target, `${field}.target`, dimensions);

  if (observationDimensions !== dimensions) {
    contractViolation('kernel valueSpec dimension mismatch', {
      field: `${field}.observationDimensions`,
      expected: dimensions,
      actual: observationDimensions,
    });
  }

  return {
    schemaVersion: requireSchemaVersion(source, field),
    observationDimensions,
    weights,
    target,
    tolerance: source.tolerance === undefined
      ? 0
      : assertNonNegativeFiniteNumber(source.tolerance, `${field}.tolerance`),
    valueMode: source.valueMode === undefined
      ? 'signed-v1'
      : assertOneOf(source.valueMode, VALUE_MODES, `${field}.valueMode`),
  };
}

function normalizeMemory(value, field, dimensions) {
  const source = assertPlainRecord(value, field, MEMORY_KEYS, ['schemaVersion', 'actionModels']);
  const actionModels = assertDynamicRecord(
    source.actionModels,
    `${field}.actionModels`,
    MAX_ACTION_MODELS,
  );
  const normalizedModels = Object.create(null);

  for (const [token, model] of Object.entries(actionModels)) {
    assertOpaqueToken(token, `${field}.actionModels token`);
    normalizedModels[token] = normalizeActionModel(
      model,
      `${field}.actionModels.${token}`,
      dimensions,
    );
  }

  const normalizedRelations = source.relationModels === undefined
    ? undefined
    : normalizeRelationModels(source.relationModels, `${field}.relationModels`, dimensions);
  const normalizedRejections = source.rejectionModels === undefined
    ? undefined
    : normalizeRejectionModels(source.rejectionModels, `${field}.rejectionModels`, dimensions);
  const normalizedPendingCredits = source.pendingCredits === undefined
    ? undefined
    : normalizePendingCredits(source.pendingCredits, `${field}.pendingCredits`, dimensions);
  const normalizedSettledFeedback = source.settledFeedback === undefined
    ? undefined
    : normalizeSettledFeedback(source.settledFeedback, `${field}.settledFeedback`, dimensions);
  const normalizedPendingCreditPolicy = source.pendingCreditPolicy === undefined
    ? undefined
    : normalizePendingCreditPolicy(source.pendingCreditPolicy, `${field}.pendingCreditPolicy`);
  const normalizedBeliefs = source.beliefModels === undefined
    ? undefined
    : normalizeBeliefModels(source.beliefModels, `${field}.beliefModels`, dimensions);
  const normalizedContextModels = source.contextModels === undefined
    ? undefined
    : normalizeContextModels(source.contextModels, `${field}.contextModels`, dimensions);
  const normalizedRecentHistory = source.recentHistory === undefined
    ? undefined
    : normalizeRecentHistory(source.recentHistory, `${field}.recentHistory`, dimensions);
  const historyClock = source.historyClock === undefined
    ? undefined
    : assertNonNegativeInteger(source.historyClock, `${field}.historyClock`);
  const historyAccumulator = source.historyAccumulator === undefined
    ? undefined
    : assertHistoryAccumulator(source.historyAccumulator, `${field}.historyAccumulator`);
  if (historyAccumulator !== undefined && historyClock === undefined) {
    contractViolation('kernel history accumulator requires a history clock', {
      field: `${field}.historyAccumulator`,
    });
  }
  validateHistoryOrdering(
    normalizedRecentHistory,
    normalizedPendingCredits,
    historyClock,
    field,
  );
  return {
    schemaVersion: requireSchemaVersion(source, field),
    actionModels: normalizedModels,
    ...(normalizedRelations === undefined ? {} : { relationModels: normalizedRelations }),
    ...(normalizedRejections === undefined ? {} : { rejectionModels: normalizedRejections }),
    ...(normalizedPendingCredits === undefined ? {} : { pendingCredits: normalizedPendingCredits }),
    ...(normalizedSettledFeedback === undefined ? {} : { settledFeedback: normalizedSettledFeedback }),
    ...(normalizedPendingCreditPolicy === undefined ? {} : { pendingCreditPolicy: normalizedPendingCreditPolicy }),
    ...(normalizedBeliefs === undefined ? {} : { beliefModels: normalizedBeliefs }),
    ...(normalizedContextModels === undefined ? {} : { contextModels: normalizedContextModels }),
    ...(normalizedRecentHistory === undefined ? {} : { recentHistory: normalizedRecentHistory }),
    ...(historyClock === undefined ? {} : { historyClock }),
    ...(historyAccumulator === undefined ? {} : { historyAccumulator }),
  };
}

function normalizeContextModels(value, field, dimensions) {
  const source = assertDynamicRecord(value, field, MAX_CONTEXT_MODELS);
  const normalized = Object.create(null);
  let modelCount = 0;
  let longContextCount = 0;
  for (const [contextKey, models] of Object.entries(source)) {
    assertContextKey(contextKey, `${field}.${contextKey}`);
    if (contextKey.startsWith('h2:')) {
      longContextCount += 1;
      if (longContextCount > MAX_LONG_CONTEXTS) {
        contractViolation('kernel long-context memory exceeds its size limit', { field });
      }
    }
    const modelSource = assertDynamicRecord(models, `${field}.${contextKey}`, MAX_ACTION_MODELS);
    const contextModels = Object.create(null);
    for (const [token, model] of Object.entries(modelSource)) {
      modelCount += 1;
      if (modelCount > MAX_CONTEXT_MODELS) {
        contractViolation('kernel context memory exceeds its size limit', { field });
      }
      assertOpaqueToken(token, `${field}.${contextKey} token`);
      contextModels[token] = normalizeActionModel(
        model,
        `${field}.${contextKey}.${token}`,
        dimensions,
      );
    }
    normalized[contextKey] = contextModels;
  }
  return normalized;
}

function normalizeRecentHistory(value, field, dimensions) {
  const items = assertArray(value, field);
  if (items.length > MAX_RECENT_HISTORY) {
    contractViolation('kernel recent history exceeds its size limit', {
      field,
      max: MAX_RECENT_HISTORY,
      actual: items.length,
    });
  }
  return items.map((item, index) => {
    const itemField = `${field}[${index}]`;
    const source = assertPlainRecord(
      item,
      itemField,
      HISTORY_ENTRY_KEYS,
      HISTORY_ENTRY_KEYS.filter((key) => key !== 'historyOrder'),
    );
    return {
      schemaVersion: requireSchemaVersion(source, itemField),
      token: assertOpaqueToken(source.token, `${itemField}.token`),
      actualDelta: cloneVector(assertFiniteVector(source.actualDelta, `${itemField}.actualDelta`, dimensions)),
      ...(source.historyOrder === undefined ? {} : {
        historyOrder: assertPositiveInteger(source.historyOrder, `${itemField}.historyOrder`),
      }),
    };
  });
}

function validateHistoryOrdering(history, pendingCredits, historyClock, field) {
  if (historyClock === undefined) return;
  const seen = new Set();
  for (const entry of [...(history ?? []), ...(pendingCredits ?? [])]) {
    if (entry.historyOrder === undefined) {
      contractViolation('kernel ordered history requires an action order', { field });
    }
    if (seen.has(entry.historyOrder)) {
      contractViolation('kernel history contains a duplicate action order', {
        field,
        historyOrder: entry.historyOrder,
      });
    }
    if (entry.historyOrder > historyClock) {
      contractViolation('kernel history action order exceeds its clock', {
        field,
        historyOrder: entry.historyOrder,
        historyClock,
      });
    }
    seen.add(entry.historyOrder);
  }
}

function normalizeContextKeys(value, field) {
  const items = assertArray(value, field);
  if (items.length === 0 || items.length > 2) {
    contractViolation('kernel context key list has an invalid size', {
      field,
      max: 2,
      actual: items.length,
    });
  }
  const seen = new Set();
  return items.map((item, index) => {
    const key = assertContextKey(item, `${field}[${index}]`);
    if (seen.has(key)) contractViolation('kernel context key list contains a duplicate', { field });
    seen.add(key);
    return key;
  });
}

function assertHistoryAccumulator(value, field) {
  if (typeof value !== 'string' || !HISTORY_ACCUMULATOR_PATTERN.test(value)) {
    contractViolation('kernel history accumulator is invalid', {
      field,
      expectedLength: HISTORY_ACCUMULATOR_HEX_LENGTH,
    });
  }
  return value;
}

function normalizeBeliefModels(value, field, dimensions) {
  const source = assertDynamicRecord(value, field, MAX_ACTION_MODELS);
  const normalized = Object.create(null);
  let modelCount = 0;
  for (const [token, contexts] of Object.entries(source)) {
    assertOpaqueToken(token, `${field} token`);
    const contextSource = assertDynamicRecord(contexts, `${field}.${token}`, MAX_RELATION_MODELS);
    const normalizedContexts = Object.create(null);
    for (const [contextKey, model] of Object.entries(contextSource)) {
      modelCount += 1;
      if (modelCount > MAX_BELIEF_MODELS) {
        contractViolation('kernel belief memory exceeds its size limit', { field });
      }
      assertBeliefContextKey(contextKey, `${field}.${token}.${contextKey}`, dimensions);
      normalizedContexts[contextKey] = normalizeBeliefModel(
        model,
        `${field}.${token}.${contextKey}`,
        dimensions,
      );
    }
    normalized[token] = normalizedContexts;
  }
  return normalized;
}

function normalizeBeliefModel(value, field, dimensions) {
  const source = assertPlainRecord(value, field, BELIEF_MODEL_KEYS);
  const samples = assertArray(source.samples, `${field}.samples`);
  if (samples.length > MAX_BELIEF_SAMPLES) {
    contractViolation('kernel belief samples exceed their size limit', { field });
  }
  return {
    schemaVersion: requireSchemaVersion(source, field),
    sampleCount: assertNonNegativeInteger(source.sampleCount, `${field}.sampleCount`),
    samples: samples.map((sample, index) =>
      cloneVector(assertFiniteVector(sample, `${field}.samples[${index}]`, dimensions))),
  };
}

function normalizePendingCreditPolicy(value, field) {
  const source = assertPlainRecord(value, field, PENDING_CREDIT_POLICY_KEYS, PENDING_CREDIT_POLICY_KEYS);
  const maxAge = assertPositiveInteger(source.maxAge, `${field}.maxAge`);
  if (maxAge > MAX_PENDING_CREDIT_AGE) {
    contractViolation('kernel pending-credit policy exceeds its age limit', {
      field: `${field}.maxAge`,
      max: MAX_PENDING_CREDIT_AGE,
      actual: maxAge,
    });
  }
  return {
    schemaVersion: requireSchemaVersion(source, field),
    maxAge,
  };
}

function normalizeSettledFeedback(value, field, dimensions) {
  const items = assertArray(value, field);
  assertCollectionLimit(items.length, MAX_SETTLED_FEEDBACK, field);
  const normalized = normalizeFeedback(items, field, dimensions);
  return normalized;
}

function normalizePendingCredits(value, field, dimensions) {
  const items = assertArray(value, field);
  assertCollectionLimit(items.length, MAX_PENDING_CREDITS, field);
  const seen = new Set();
  return items.map((item, index) => {
    const itemField = `${field}[${index}]`;
    const source = assertPlainRecord(
      item,
      itemField,
      PENDING_CREDIT_KEYS,
      PENDING_CREDIT_KEYS.filter((key) => key !== 'relationKey' && key !== 'contextKey' && key !== 'contextKeys' && key !== 'historyOrder' && key !== 'age'),
    );
    const executionNonce = assertBoundedString(source.executionNonce, `${itemField}.executionNonce`, MAX_EXECUTION_NONCE_LENGTH);
    if (seen.has(executionNonce)) {
      contractViolation('kernel pending credits contain a duplicate execution nonce', { field: itemField });
    }
    seen.add(executionNonce);
    const relationKey = source.relationKey === undefined
      ? undefined
      : assertRelationKey(source.relationKey, `${itemField}.relationKey`, dimensions);
    const contextKey = source.contextKey === undefined
      ? undefined
      : assertContextKey(source.contextKey, `${itemField}.contextKey`);
    const contextKeys = source.contextKeys === undefined
      ? undefined
      : normalizeContextKeys(source.contextKeys, `${itemField}.contextKeys`);
    if (contextKey !== undefined && contextKeys !== undefined && contextKeys[0] !== contextKey) {
      contractViolation('kernel pending credit context keys disagree with its primary context key', {
        field: `${itemField}.contextKeys`,
      });
    }
    const age = source.age === undefined
      ? undefined
      : assertNonNegativeInteger(source.age, `${itemField}.age`);
    if (age !== undefined && age >= MAX_PENDING_CREDIT_AGE) {
      contractViolation('kernel pending-credit age exceeds its limit', {
        field: `${itemField}.age`,
        max: MAX_PENDING_CREDIT_AGE - 1,
        actual: age,
      });
    }
    return {
      schemaVersion: requireSchemaVersion(source, itemField),
      executionNonce,
      token: assertOpaqueToken(source.token, `${itemField}.token`),
      beforeStateVersion: assertNonEmptyString(source.beforeStateVersion, `${itemField}.beforeStateVersion`),
      beforeIntervalId: assertNonEmptyString(source.beforeIntervalId, `${itemField}.beforeIntervalId`),
      beforeVector: assertFiniteVector(source.beforeVector, `${itemField}.beforeVector`, dimensions),
      expectedDelta: assertFiniteVector(source.expectedDelta, `${itemField}.expectedDelta`, dimensions),
      ...(relationKey === undefined ? {} : { relationKey }),
      ...(contextKey === undefined ? {} : { contextKey }),
      ...(contextKeys === undefined ? {} : { contextKeys }),
      ...(source.historyOrder === undefined ? {} : {
        historyOrder: assertPositiveInteger(source.historyOrder, `${itemField}.historyOrder`),
      }),
      ...(age === undefined ? {} : { age }),
    };
  });
}

function normalizeRejectionModels(value, field, dimensions) {
  const source = assertDynamicRecord(value, field, MAX_ACTION_MODELS);
  const normalized = Object.create(null);
  for (const [token, model] of Object.entries(source)) {
    assertOpaqueToken(token, `${field} token`);
    const modelSource = assertPlainRecord(model, `${field}.${token}`, REJECTION_MODEL_KEYS, ['schemaVersion', 'sampleCount', 'rejected']);
    const relationKey = modelSource.relationKey === undefined
      ? undefined
      : assertRelationKey(modelSource.relationKey, `${field}.${token}.relationKey`, dimensions);
    normalized[token] = {
      schemaVersion: requireSchemaVersion(modelSource, `${field}.${token}`),
      sampleCount: assertNonNegativeInteger(modelSource.sampleCount, `${field}.${token}.sampleCount`),
      rejected: assertBoolean(modelSource.rejected, `${field}.${token}.rejected`),
      ...(relationKey === undefined ? {} : { relationKey }),
    };
  }
  return normalized;
}

function normalizeRelationModels(value, field, dimensions) {
  const source = assertDynamicRecord(value, field, MAX_ACTION_MODELS);
  const normalized = Object.create(null);
  let relationCount = 0;
  for (const [token, relations] of Object.entries(source)) {
    assertOpaqueToken(token, `${field} token`);
    const relationSource = assertDynamicRecord(relations, `${field}.${token}`, MAX_RELATION_MODELS);
    const relationModels = Object.create(null);
    for (const [relationKey, model] of Object.entries(relationSource)) {
      relationCount += 1;
      if (relationCount > MAX_RELATION_MODELS) {
        contractViolation('kernel relation-model memory exceeds its size limit', { field });
      }
      assertRelationKey(relationKey, `${field}.${token}.${relationKey}`, dimensions);
      relationModels[relationKey] = normalizeActionModel(
        model,
        `${field}.${token}.${relationKey}`,
        dimensions,
      );
    }
    normalized[token] = relationModels;
  }
  return normalized;
}

function normalizeActionModel(value, field, dimensions) {
  const source = assertPlainRecord(value, field, ACTION_MODEL_KEYS);

  return {
    schemaVersion: requireSchemaVersion(source, field),
    sampleCount: assertNonNegativeInteger(source.sampleCount, `${field}.sampleCount`),
    meanDelta: assertFiniteVector(source.meanDelta, `${field}.meanDelta`, dimensions),
    uncertainty: assertNonNegativeFiniteNumber(
      source.uncertainty,
      `${field}.uncertainty`,
    ),
  };
}

function updateActionModel(current, actualDelta, errorMagnitude, dimensions, field) {
  if (current.sampleCount === Number.MAX_SAFE_INTEGER) {
    contractViolation('kernel action-model sample count cannot be incremented safely', {
      field: `${field}.sampleCount`,
    });
  }
  const nextSampleCount = current.sampleCount + 1;
  // A changing world must be able to outweigh stale evidence. The window is
  // a domain-neutral memory bound, not a world-specific rule.
  const effectiveSampleCount = Math.min(nextSampleCount, ADAPTATION_WINDOW);
  const nextMean = current.meanDelta.map((mean, index) =>
    assertComputedFiniteNumber(
      mean + (actualDelta[index] - mean) / effectiveSampleCount,
      `${field}.meanDelta[${index}]`,
    ),
  );
  const nextUncertainty = assertComputedFiniteNumber(
    current.uncertainty + (errorMagnitude - current.uncertainty) / effectiveSampleCount,
    `${field}.uncertainty`,
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    sampleCount: nextSampleCount,
    meanDelta: nextMean,
    uncertainty: nextUncertainty,
  };
}

function updateBeliefModel(current, actualDelta, dimensions, field) {
  const sampleCount = current?.sampleCount ?? 0;
  if (sampleCount === Number.MAX_SAFE_INTEGER) {
    contractViolation('kernel belief sample count cannot be incremented safely', {
      field: `${field}.sampleCount`,
    });
  }
  const samples = (current?.samples ?? []).map(cloneVector);
  if (samples.length >= MAX_BELIEF_SAMPLES) samples.shift();
  samples.push(cloneVector(assertFiniteVector(actualDelta, `${field}.samples`, dimensions)));
  return {
    schemaVersion: SCHEMA_VERSION,
    sampleCount: sampleCount + 1,
    samples,
  };
}

function updateRejectionModel(current, rejected, relationKey, field) {
  const sampleCount = current?.sampleCount ?? 0;
  if (rejected && sampleCount === Number.MAX_SAFE_INTEGER) {
    contractViolation('kernel rejection-model sample count cannot be incremented safely', {
      field: `${field}.sampleCount`,
    });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    sampleCount: rejected ? sampleCount + 1 : sampleCount,
    rejected,
    ...(relationKey === undefined ? {} : { relationKey }),
  };
}

function countRelationModels(value) {
  return Object.values(value).reduce(
    (sum, relations) => sum + Object.keys(relations).length,
    0,
  );
}

function recordActionEvidence(memory, {
  token,
  relationKey,
  contextKeys,
  historyOrder,
  actualDelta,
  errorMagnitude,
  dimensions,
  field,
}) {
  const existing = memory.actionModels[token];
  if (!existing && Object.keys(memory.actionModels).length >= MAX_ACTION_MODELS) {
    contractViolation('kernel learning would exceed the action-model limit', {
      field: `${field}.actionModels`,
    });
  }
  if (memory.rejectionModels?.[token] !== undefined) {
    memory.rejectionModels[token] = updateRejectionModel(
      memory.rejectionModels[token],
      false,
      relationKey,
      `${field}.rejectionModels.${token}`,
    );
  }
  memory.actionModels[token] = updateActionModel(
    existing ?? defaultActionModel(dimensions),
    actualDelta,
    errorMagnitude,
    dimensions,
    `${field}.actionModels.${token}`,
  );
  recordBeliefEvidence(memory, {
    token,
    relationKey,
    actualDelta,
    dimensions,
    field,
  });
  for (const contextKey of contextKeys ?? []) {
    recordContextEvidence(memory, {
      contextKey,
      token,
      actualDelta,
      errorMagnitude,
      dimensions,
      field,
    });
  }
  appendRecentHistory(memory, { token, actualDelta, historyOrder, dimensions, field });
  appendHistoryAccumulator(memory, { token, actualDelta, historyOrder, field });
  if (relationKey === undefined) return;

  const relationModels = memory.relationModels ?? {};
  const tokenRelations = { ...(relationModels[token] ?? {}) };
  const existingRelation = tokenRelations[relationKey];
  if (existingRelation === undefined && countRelationModels(relationModels) >= MAX_RELATION_MODELS) {
    contractViolation('kernel learning would exceed the relation-model limit', {
      field: `${field}.relationModels.${token}.${relationKey}`,
    });
  }
  tokenRelations[relationKey] = updateActionModel(
    existingRelation ?? defaultActionModel(dimensions),
    actualDelta,
    errorMagnitude,
    dimensions,
    `${field}.relationModels.${token}.${relationKey}`,
  );
  memory.relationModels = {
    ...relationModels,
    [token]: tokenRelations,
  };
}

function recordContextEvidence(memory, {
  contextKey,
  token,
  actualDelta,
  errorMagnitude,
  dimensions,
  field,
}) {
  if (memory.contextModels === undefined || contextKey === undefined) return;
  let contexts = memory.contextModels;
  let models = { ...(contexts[contextKey] ?? {}) };
  let existing = models[token];
  if (existing === undefined && contextKey.startsWith('h2:') &&
      countLongContexts(contexts) >= MAX_LONG_CONTEXTS) {
    const evictableKey = oldestLongContextKey(contexts);
    if (evictableKey === undefined) {
      contractViolation('kernel learning has no evictable long-context model', {
        field: `${field}.contextModels.${contextKey}.${token}`,
      });
    }
    contexts = { ...contexts };
    delete contexts[evictableKey];
    models = { ...(contexts[contextKey] ?? {}) };
    existing = models[token];
  }
  if (existing === undefined && countContextModels(contexts) >= MAX_CONTEXT_MODELS) {
    if (!contextKey.startsWith('h2:')) {
      contractViolation('kernel learning would exceed the context-model limit', {
        field: `${field}.contextModels.${contextKey}.${token}`,
      });
    }
    const evictableKey = oldestLongContextKey(contexts);
    if (evictableKey === undefined) {
      contractViolation('kernel learning has no evictable long-context model', {
        field: `${field}.contextModels.${contextKey}.${token}`,
      });
    }
    const withoutEvicted = { ...contexts };
    delete withoutEvicted[evictableKey];
    contexts = withoutEvicted;
    models = { ...(contexts[contextKey] ?? {}) };
    existing = models[token];
  }
  models[token] = updateActionModel(
    existing ?? defaultActionModel(dimensions),
    actualDelta,
    errorMagnitude,
    dimensions,
    `${field}.contextModels.${contextKey}.${token}`,
  );
  memory.contextModels = { ...contexts, [contextKey]: models };
}

function countContextModels(value) {
  return Object.values(value).reduce((sum, models) => sum + Object.keys(models).length, 0);
}

function countLongContexts(value) {
  return Object.keys(value).filter((contextKey) => contextKey.startsWith('h2:')).length;
}

function oldestLongContextKey(value) {
  return Object.keys(value).find((contextKey) => contextKey.startsWith('h2:'));
}

function appendRecentHistory(memory, { token, actualDelta, historyOrder, dimensions, field }) {
  if (memory.recentHistory === undefined) return;
  const entry = {
    schemaVersion: SCHEMA_VERSION,
    token,
    actualDelta: cloneVector(assertFiniteVector(actualDelta, `${field}.recentHistory.actualDelta`, dimensions)),
    ...(historyOrder === undefined ? {} : { historyOrder }),
  };
  if (historyOrder === undefined || memory.recentHistory.some((item) => item.historyOrder === undefined)) {
    memory.recentHistory = [...memory.recentHistory.slice(-MAX_RECENT_HISTORY + 1), entry];
    return;
  }
  memory.recentHistory = [...memory.recentHistory, entry]
    .sort((left, right) => left.historyOrder - right.historyOrder)
    .slice(-MAX_RECENT_HISTORY);
}

function appendHistoryAccumulator(memory, { token, actualDelta, historyOrder, field }) {
  if (memory.historyAccumulator === undefined) return;
  if (historyOrder === undefined) {
    contractViolation('kernel history accumulator requires an action order', { field });
  }
  const eventNumber = BigInt(`0x${canonicalDigest({ token, actualDelta }).slice('sha256:'.length)}`);
  const contribution = (eventNumber * modularPower(HISTORY_ACCUMULATOR_BASE, BigInt(historyOrder))) &
    HISTORY_ACCUMULATOR_MASK;
  const accumulator = BigInt(`0x${memory.historyAccumulator}`);
  memory.historyAccumulator = ((accumulator + contribution) & HISTORY_ACCUMULATOR_MASK)
    .toString(16)
    .padStart(HISTORY_ACCUMULATOR_HEX_LENGTH, '0');
}

function recordBeliefEvidence(memory, {
  token,
  relationKey,
  actualDelta,
  dimensions,
  field,
}) {
  if (memory.beliefModels === undefined) return;
  const contextKey = relationKey ?? OVERALL_BELIEF_CONTEXT;
  const beliefs = memory.beliefModels;
  const tokenBeliefs = { ...(beliefs[token] ?? {}) };
  const existing = tokenBeliefs[contextKey];
  if (existing === undefined && countBeliefModels(beliefs) >= MAX_BELIEF_MODELS) {
    contractViolation('kernel learning would exceed the belief-model limit', {
      field: `${field}.beliefModels.${token}.${contextKey}`,
    });
  }
  tokenBeliefs[contextKey] = updateBeliefModel(
    existing,
    actualDelta,
    dimensions,
    `${field}.beliefModels.${token}.${contextKey}`,
  );
  memory.beliefModels = { ...beliefs, [token]: tokenBeliefs };
}

function countBeliefModels(value) {
  return Object.values(value).reduce((sum, contexts) => sum + Object.keys(contexts).length, 0);
}

function normalizeCapabilities(value, field) {
  const items = assertArray(value, field);
  assertCollectionLimit(items.length, MAX_CAPABILITIES, field);
  const seenTokens = new Set();

  return items.map((item, index) => {
    const itemField = `${field}[${index}]`;
    const source = assertPlainRecord(item, itemField, CAPABILITY_KEYS);

    const capability = {
      schemaVersion: requireSchemaVersion(source, itemField),
      token: assertOpaqueToken(source.token, `${itemField}.token`),
      cost: assertNonNegativeFiniteNumber(source.cost, `${itemField}.cost`),
      allowed: assertBoolean(source.allowed, `${itemField}.allowed`),
      safe: assertBoolean(source.safe, `${itemField}.safe`),
    };
    if (seenTokens.has(capability.token)) {
      contractViolation('kernel capabilities contain a duplicate token', {
        field: `${itemField}.token`,
      });
    }
    seenTokens.add(capability.token);
    return capability;
  });
}

function normalizeRngState(value, field) {
  const source = assertPlainRecord(value, field, RNG_STATE_KEYS);
  const state = assertNonNegativeInteger(source.state, `${field}.state`);

  if (source.algorithm !== 'xorshift32') {
    contractViolation('kernel rngState algorithm is unsupported', {
      field: `${field}.algorithm`,
      expected: 'xorshift32',
      actual: source.algorithm,
    });
  }

  if (state > 0xffffffff) {
    contractViolation('kernel rngState state is out of range', {
      field: `${field}.state`,
      max: 0xffffffff,
      actual: state,
    });
  }

  return {
    schemaVersion: requireSchemaVersion(source, field),
    algorithm: source.algorithm,
    state,
  };
}

function normalizeIntent(value, field) {
  const source = assertPlainRecord(value, field, INTENT_KEYS);
  const intent = {
    schemaVersion: requireSchemaVersion(source, field),
    status: assertOneOf(source.status, ['READY'], `${field}.status`),
    expectation: normalizeExpectation(source.expectation, `${field}.expectation`),
    choice: normalizeChoice(source.choice, `${field}.choice`),
    nextRngState: normalizeRngState(source.nextRngState, `${field}.nextRngState`),
  };

  assertIntentInternalConsistency(intent, field);
  return intent;
}

function normalizeVerification(value, field, dimensions) {
  const source = assertPlainRecord(value, field, VERIFICATION_KEYS);
  const confidence = assertNonNegativeFiniteNumber(
    source.confidence,
    `${field}.confidence`,
  );
  if (confidence > 1) {
    contractViolation('kernel verification confidence must not exceed one', {
      field: `${field}.confidence`,
    });
  }
  return {
    schemaVersion: requireSchemaVersion(source, field),
    error: assertFiniteVector(source.error, `${field}.error`, dimensions),
    attribution: assertOneOf(
      source.attribution,
      ['ACTION', 'AMBIGUOUS', 'EXECUTION_REJECTED'],
      `${field}.attribution`,
    ),
    confidence,
    learnable: assertBoolean(source.learnable, `${field}.learnable`),
  };
}

function normalizeExpectation(value, field) {
  const source = assertPlainRecord(value, field, EXPECTATION_KEYS, EXPECTATION_KEYS.filter((key) => key !== 'relationKey'));
  const predictedObservation = normalizeObservation(
    source.predictedObservation,
    `${field}.predictedObservation`,
  );
  const expectedDelta = assertFiniteVector(
    source.expectedDelta,
    `${field}.expectedDelta`,
    predictedObservation.vector.length,
  );
  const relationKey = source.relationKey === undefined
    ? undefined
    : assertRelationKey(source.relationKey, `${field}.relationKey`, predictedObservation.vector.length);

  return {
    schemaVersion: requireSchemaVersion(source, field),
    token: assertOpaqueToken(source.token, `${field}.token`),
    expectedDelta,
    predictedObservation,
    ...(relationKey === undefined ? {} : { relationKey }),
    score: assertFiniteNumber(source.score, `${field}.score`),
    sampleCount: assertNonNegativeInteger(source.sampleCount, `${field}.sampleCount`),
    uncertainty: assertNonNegativeFiniteNumber(
      source.uncertainty,
      `${field}.uncertainty`,
    ),
  };
}

function normalizeChoice(value, field) {
  const source = assertPlainRecord(value, field, CHOICE_KEYS);

  return {
    schemaVersion: requireSchemaVersion(source, field),
    token: assertOpaqueToken(source.token, `${field}.token`),
    score: assertFiniteNumber(source.score, `${field}.score`),
    expectedValue: assertFiniteNumber(source.expectedValue, `${field}.expectedValue`),
    cost: assertNonNegativeFiniteNumber(source.cost, `${field}.cost`),
    allowed: assertBoolean(source.allowed, `${field}.allowed`),
    safe: assertBoolean(source.safe, `${field}.safe`),
  };
}

function normalizeReceipt(value, field) {
  const source = assertPlainRecord(value, field, RECEIPT_KEYS);
  const status = assertOneOf(source.status, ['ACCEPTED', 'REJECTED'], `${field}.status`);

  return {
    schemaVersion: requireSchemaVersion(source, field),
    status,
    token: assertOpaqueToken(source.token, `${field}.token`),
    basedOnVersion: assertNonEmptyString(
      source.basedOnVersion,
      `${field}.basedOnVersion`,
    ),
    policyVersion: assertNonEmptyString(
      source.policyVersion,
      `${field}.policyVersion`,
    ),
    constraintsDigest: assertNonEmptyString(
      source.constraintsDigest,
      `${field}.constraintsDigest`,
    ),
    executionNonce: assertBoundedString(
      source.executionNonce,
      `${field}.executionNonce`,
      MAX_EXECUTION_NONCE_LENGTH,
    ),
    effectDigest: assertNonEmptyString(source.effectDigest, `${field}.effectDigest`),
    rejectionReason: normalizeRejectionReason(
      source.rejectionReason,
      `${field}.rejectionReason`,
    ),
    attributionWindowComplete: assertBoolean(
      source.attributionWindowComplete,
      `${field}.attributionWindowComplete`,
    ),
    confounderCount: assertNonNegativeInteger(
      source.confounderCount,
      `${field}.confounderCount`,
    ),
  };
}

function normalizeRejectionReason(value, field) {
  if (value === null) {
    return null;
  }

  return assertNonEmptyString(value, field);
}

function assertIntentReceiptConsistency(intent, receipt) {
  const token = intent.expectation.token;
  if (intent.choice.token !== token || receipt.token !== token) {
    contractViolation('kernel intent and receipt action tokens do not match', {
      field: 'verifyInput.intent',
    });
  }

  assertIntentIsExecutable(intent, 'verifyInput.intent.choice');

  if (receipt.basedOnVersion !== intent.expectation.predictedObservation.stateVersion) {
    contractViolation('kernel receipt is based on a different observation version', {
      field: 'verifyInput.receipt.basedOnVersion',
    });
  }

  if (receipt.status === 'ACCEPTED' && receipt.rejectionReason !== null) {
    contractViolation('accepted kernel receipt must not contain a rejection reason', {
      field: 'verifyInput.receipt.rejectionReason',
    });
  }

  if (receipt.status === 'REJECTED' && receipt.rejectionReason === null) {
    contractViolation('rejected kernel receipt must contain a rejection reason', {
      field: 'verifyInput.receipt.rejectionReason',
    });
  }
}

function assertIntentInternalConsistency(intent, field) {
  if (intent.expectation.score !== intent.choice.score) {
    contractViolation('kernel intent expectation and choice scores do not match', {
      field,
    });
  }

  const scoreUpperBound = assertComputedFiniteNumber(
    intent.choice.expectedValue - intent.choice.cost,
    `${field}.choice.scoreUpperBound`,
  );
  if (intent.choice.score > scoreUpperBound) {
    contractViolation('kernel intent score exceeds expected value minus cost', {
      field: `${field}.choice.score`,
    });
  }
  if (
    intent.expectation.uncertainty === 0 &&
    intent.choice.score !== scoreUpperBound
  ) {
    contractViolation('zero-uncertainty kernel intent has an inconsistent score', {
      field: `${field}.choice.score`,
    });
  }
}

function assertIntentIsExecutable(intent, field) {
  if (!intent.choice.allowed || !intent.choice.safe) {
    contractViolation('kernel cannot process an unsafe or disallowed intent', {
      field,
    });
  }
}

function buildPredictions(input) {
  const contextKeys = contextKeysForMemory(input.memory);
  return input.capabilities.map((capability) => {
    const relationKey = input.memory.relationModels === undefined
      ? undefined
      : relationKeyFor(input.observation.vector, input.valueSpec);
    const rejectionModel = input.memory.rejectionModels?.[capability.token];
    const rejectedRecently = rejectionModel?.rejected === true &&
      rejectionModel.relationKey === relationKey;
    const model =
      contextKeys
        ?.map((contextKey) => input.memory.contextModels?.[contextKey]?.[capability.token])
        .find((candidate) => candidate !== undefined) ??
      input.memory.relationModels?.[capability.token]?.[relationKey] ??
      input.memory.actionModels[capability.token] ??
      defaultActionModel(input.observation.vector.length);
    const beliefModel = input.memory.beliefModels?.[capability.token]?.[
      relationKey ?? OVERALL_BELIEF_CONTEXT
    ];
    const uncertainty = beliefUncertainty(
      model,
      beliefModel,
      input.observation.vector.length,
    );
    const expectedDelta = cloneVector(model.meanDelta);
    const predictedVector = addVectors(
      input.observation.vector,
      expectedDelta,
      'stepOutput.expectation.predictedObservation.vector',
    );
    const predictedObservation = {
      schemaVersion: SCHEMA_VERSION,
      vector: predictedVector,
      stateVersion: input.observation.stateVersion,
      intervalId: input.observation.intervalId,
    };
    const expectedValue = valueObservation(predictedVector, input.valueSpec);
    const score = assertComputedFiniteNumber(
      expectedValue -
      capability.cost -
      uncertaintyPenalty(uncertainty, input.valueSpec.weights),
      'stepOutput.choice.score',
    );

    return {
      expectation: {
        schemaVersion: SCHEMA_VERSION,
        token: capability.token,
        expectedDelta,
        predictedObservation,
        ...(relationKey === undefined ? {} : { relationKey }),
        score,
        sampleCount: model.sampleCount,
        uncertainty,
      },
      choice: {
        schemaVersion: SCHEMA_VERSION,
        token: capability.token,
        score,
        expectedValue,
        cost: capability.cost,
        allowed: capability.allowed,
        safe: capability.safe,
      },
      rejectedRecently,
    };
  });
}

function beliefUncertainty(model, beliefModel, dimensions) {
  if (beliefModel === undefined || beliefModel.samples.length === 0) {
    return model.uncertainty;
  }
  let spread = 0;
  for (const sample of beliefModel.samples) {
    for (let index = 0; index < dimensions; index += 1) {
      spread = assertComputedFiniteNumber(
        spread + Math.abs(sample[index] - model.meanDelta[index]),
        'stepOutput.expectation.beliefSpread',
      );
    }
  }
  spread = assertComputedFiniteNumber(
    spread / (beliefModel.samples.length * dimensions),
    'stepOutput.expectation.beliefUncertainty',
  );
  return Math.max(model.uncertainty, spread);
}

function choosePredictionIndex(predictions, unit) {
  let bestScore = -Infinity;
  const bestIndexes = [];

  predictions.forEach((prediction, index) => {
    if (prediction.choice.score > bestScore) {
      bestScore = prediction.choice.score;
      bestIndexes.length = 0;
      bestIndexes.push(index);
      return;
    }

    if (Object.is(prediction.choice.score, bestScore)) {
      bestIndexes.push(index);
    }
  });

  if (bestIndexes.length === 1) {
    return bestIndexes[0];
  }

  return bestIndexes[Math.floor(unit * bestIndexes.length)];
}

function chooseByStrategy(predictions, strategy, unit) {
  if (strategy.mode !== 'EXPLORATORY') {
    return predictions[choosePredictionIndex(predictions, unit)];
  }
  let highestExploration = -Infinity;
  const candidates = [];
  predictions.forEach((prediction, index) => {
    const exploration = prediction.expectation.uncertainty / (1 + prediction.expectation.sampleCount);
    if (exploration > highestExploration) {
      highestExploration = exploration;
      candidates.length = 0;
      candidates.push(index);
    } else if (Object.is(exploration, highestExploration)) {
      candidates.push(index);
    }
  });
  return predictions[candidates[Math.floor(unit * candidates.length)]];
}

// Planning is deliberately bounded and model-only. It projects the current
// learned transition model forward, and when verified belief samples exist it
// branches only on the first action's bounded outcomes. The current information
// rule also requires those branches to produce different next decisions; raw
// variance is not evidence that the observation can change what the agent
// should do. This does not claim a hidden-state model or move speculative state
// across the WorldPort safety boundary.
function chooseByPlanning(predictions, input, unit) {
  const candidatePool = boundedPlanningPredictions(predictions);
  const rolloutInput = {
    ...input,
    capabilities: boundedPlanningCapabilities(input.capabilities, candidatePool),
  };
  let bestUtility = -Infinity;
  const candidates = [];
  for (const prediction of candidatePool) {
    const utility = rolloutUtility(prediction, rolloutInput, input.planning.horizon, unit);
    if (utility > bestUtility) {
      bestUtility = utility;
      candidates.length = 0;
      candidates.push(prediction);
    } else if (Object.is(utility, bestUtility)) {
      candidates.push(prediction);
    }
  }
  return candidates[Math.floor(unit * candidates.length)];
}

function boundedPlanningPredictions(predictions) {
  if (predictions.length <= MAX_PLANNING_CANDIDATES) return predictions;
  return [...predictions]
    .sort((left, right) => right.choice.score - left.choice.score)
    .slice(0, MAX_PLANNING_CANDIDATES);
}

function boundedPlanningCapabilities(capabilities, predictions) {
  if (capabilities.length <= MAX_PLANNING_CANDIDATES) return capabilities;
  const tokens = new Set(predictions.map((prediction) => prediction.choice.token));
  return capabilities.filter((capability) => tokens.has(capability.token));
}

function rolloutUtility(firstPrediction, input, horizon, unit) {
  const firstUncertaintyCost = uncertaintyPenalty(
    firstPrediction.expectation.uncertainty,
    input.valueSpec.weights,
  );
  const outcomes = predictionOutcomeVectors(
    firstPrediction,
    input,
    input.planning.informationMode !== 'legacy-v1',
  );
  const outcomeVectors = outcomes.vectors;
  let expectedUtility = 0;
  const nextDecisions = [];
  const nextUncertainties = [];

  for (const outcomeVector of outcomeVectors) {
    let predictedVector = outcomeVector;
    let totalCost = firstPrediction.choice.cost + firstUncertaintyCost;
    let nextUncertainty = firstPrediction.expectation.uncertainty;
    for (let depth = 1; depth < horizon; depth += 1) {
      const futurePredictions = buildPredictions({
        ...input,
        observation: {
          ...input.observation,
          vector: predictedVector,
        },
      }).filter((item) => item.choice.allowed && item.choice.safe);
      if (futurePredictions.length === 0) break;
      const futurePool = selectionPoolFor(futurePredictions);
      const future = chooseByStrategy(futurePool, input.strategy, unit);
      if (depth === 1) {
        nextUncertainty = future.expectation.uncertainty;
        nextDecisions.push(future);
        nextUncertainties.push(nextUncertainty);
      }
      predictedVector = future.expectation.predictedObservation.vector;
      totalCost += future.choice.cost +
        uncertaintyPenalty(future.expectation.uncertainty, input.valueSpec.weights);
    }
    const informationValue = outcomes.sampled && input.planning.informationMode === 'belief-v1'
      ? uncertaintyReduction(
          firstPrediction.expectation.uncertainty,
          nextUncertainty,
          input.valueSpec.weights,
        )
      : 0;
    expectedUtility += (
      valueObservation(predictedVector, input.valueSpec) - totalCost + informationValue
    ) / outcomeVectors.length;
  }

  if (outcomes.sampled && input.planning.informationMode === 'belief-v2' &&
      hasDiverseNextDecisions(nextDecisions)) {
    const averageNextUncertainty = nextUncertainties.reduce(
      (total, value) => total + value,
      0,
    ) / nextUncertainties.length;
    expectedUtility += uncertaintyReduction(
      firstPrediction.expectation.uncertainty,
      averageNextUncertainty,
      input.valueSpec.weights,
    );
  }

  return assertComputedFiniteNumber(expectedUtility, 'stepOutput.planning.utility');
}

function hasDiverseNextDecisions(decisions) {
  if (decisions.length < 2) return false;
  const signatures = new Set(decisions.map((decision) => canonicalDigest({
    token: decision.expectation.token,
    expectedDelta: decision.expectation.expectedDelta,
  })));
  return signatures.size > 1;
}

function predictionOutcomeVectors(prediction, input, allowBeliefBranches) {
  const contextKey = prediction.expectation.relationKey ?? OVERALL_BELIEF_CONTEXT;
  const samples = input.memory.beliefModels?.[prediction.choice.token]?.[contextKey]?.samples;
  if (!allowBeliefBranches || samples === undefined || samples.length === 0) {
    return {
      vectors: [cloneVector(prediction.expectation.predictedObservation.vector)],
      sampled: false,
    };
  }
  return {
    vectors: samples.map((sample) => addVectors(
      input.observation.vector,
      sample,
      'stepOutput.planning.outcomeVector',
    )),
    sampled: true,
  };
}

function uncertaintyReduction(current, future, weights) {
  return Math.max(
    0,
    uncertaintyPenalty(current, weights) - uncertaintyPenalty(future, weights),
  );
}

function selectionPoolFor(predictions) {
  const nonRejected = predictions.filter((item) => !item.rejectedRecently);
  const untried = nonRejected.filter((item) => item.expectation.sampleCount === 0);
  return untried.length > 0 ? untried : nonRejected.length > 0 ? nonRejected : predictions;
}

function defaultActionModel(dimensions) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sampleCount: 0,
    meanDelta: Array.from({ length: dimensions }, () => 0),
    uncertainty: 1,
  };
}

function valueObservation(vector, valueSpec) {
  let total = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const difference = vector[index] - valueSpec.target[index];
    const distance = Math.max(0, Math.abs(difference) - valueSpec.tolerance);
    const contribution = valueSpec.valueMode === 'distance-v2'
      ? -distance * Math.abs(valueSpec.weights[index])
      : difference * valueSpec.weights[index];
    total = assertComputedFiniteNumber(
      total + contribution,
      `stepOutput.choice.expectedValue[${index}]`,
    );
  }
  return total;
}

function uncertaintyPenalty(uncertainty, weights) {
  let weightNorm = 0;
  for (let index = 0; index < weights.length; index += 1) {
    weightNorm = assertComputedFiniteNumber(
      weightNorm + Math.abs(weights[index]),
      `stepOutput.choice.uncertaintyWeightNorm[${index}]`,
    );
  }
  return assertComputedFiniteNumber(
    uncertainty * weightNorm,
    'stepOutput.choice.uncertaintyPenalty',
  );
}

function confidenceFromError(error) {
  let magnitude = 0;
  for (let index = 0; index < error.length; index += 1) {
    magnitude = assertComputedFiniteNumber(
      magnitude + Math.abs(error[index]),
      `verifyOutput.confidenceMagnitude[${index}]`,
    );
  }

  return Math.max(0, 1 - Math.min(1, magnitude));
}

function advanceRng(rngState) {
  let value = rngState.state >>> 0;
  value ^= (value << 13) >>> 0;
  value ^= value >>> 17;
  value ^= (value << 5) >>> 0;
  value >>>= 0;

  if (value === 0) {
    value = 0x6d2b79f5;
  }

  return {
    value,
    unit: value / 0x100000000,
    nextState: {
      schemaVersion: SCHEMA_VERSION,
      algorithm: 'xorshift32',
      state: value,
    },
  };
}

function verificationResult({ error, attribution, confidence, learnable }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    error,
    attribution,
    confidence,
    learnable,
  };
}

function addVectors(left, right, field) {
  return left.map((value, index) =>
    assertComputedFiniteNumber(value + right[index], `${field}[${index}]`),
  );
}

function subtractVectors(left, right, field) {
  return left.map((value, index) =>
    assertComputedFiniteNumber(value - right[index], `${field}[${index}]`),
  );
}

function assertComputedFiniteNumber(value, field) {
  if (!Number.isFinite(value)) {
    contractViolation('kernel arithmetic result must be finite', { field });
  }
  return value;
}

function cloneVector(value) {
  return [...value];
}

function cloneRngState(value) {
  return {
    schemaVersion: SCHEMA_VERSION,
    algorithm: value.algorithm,
    state: value.state,
  };
}

function cloneMemory(value) {
  const actionModels = {};
  for (const [token, model] of Object.entries(value.actionModels)) {
    actionModels[token] = {
      schemaVersion: SCHEMA_VERSION,
      sampleCount: model.sampleCount,
      meanDelta: cloneVector(model.meanDelta),
      uncertainty: model.uncertainty,
    };
  }
  const cloned = {
    schemaVersion: SCHEMA_VERSION,
    actionModels,
  };
  if (value.pendingCreditPolicy !== undefined) {
    cloned.pendingCreditPolicy = {
      schemaVersion: SCHEMA_VERSION,
      maxAge: value.pendingCreditPolicy.maxAge,
    };
  }
  if (value.relationModels !== undefined) {
    cloned.relationModels = Object.fromEntries(
      Object.entries(value.relationModels).map(([token, relations]) => [
        token,
        Object.fromEntries(Object.entries(relations).map(([relationKey, model]) => [relationKey, {
          schemaVersion: SCHEMA_VERSION,
          sampleCount: model.sampleCount,
          meanDelta: cloneVector(model.meanDelta),
          uncertainty: model.uncertainty,
        }])),
      ]),
    );
  }
  if (value.rejectionModels !== undefined) {
    cloned.rejectionModels = Object.fromEntries(
      Object.entries(value.rejectionModels).map(([token, model]) => [token, {
        schemaVersion: SCHEMA_VERSION,
        sampleCount: model.sampleCount,
        rejected: model.rejected,
        ...(model.relationKey === undefined ? {} : { relationKey: model.relationKey }),
      }]),
    );
  }
  if (value.pendingCredits !== undefined) {
    cloned.pendingCredits = value.pendingCredits.map((credit) => ({
      schemaVersion: SCHEMA_VERSION,
      executionNonce: credit.executionNonce,
      token: credit.token,
      beforeStateVersion: credit.beforeStateVersion,
      beforeIntervalId: credit.beforeIntervalId,
      beforeVector: cloneVector(credit.beforeVector),
      expectedDelta: cloneVector(credit.expectedDelta),
      ...(credit.relationKey === undefined ? {} : { relationKey: credit.relationKey }),
      ...(credit.contextKey === undefined ? {} : { contextKey: credit.contextKey }),
      ...(credit.contextKeys === undefined ? {} : { contextKeys: [...credit.contextKeys] }),
      ...(credit.historyOrder === undefined ? {} : { historyOrder: credit.historyOrder }),
      ...(credit.age === undefined ? {} : { age: credit.age }),
    }));
  }
  if (value.settledFeedback !== undefined) {
    cloned.settledFeedback = value.settledFeedback.map(cloneFeedback);
  }
  if (value.beliefModels !== undefined) {
    cloned.beliefModels = Object.fromEntries(
      Object.entries(value.beliefModels).map(([token, contexts]) => [
        token,
        Object.fromEntries(Object.entries(contexts).map(([contextKey, model]) => [contextKey, {
          schemaVersion: SCHEMA_VERSION,
          sampleCount: model.sampleCount,
          samples: model.samples.map(cloneVector),
        }])),
      ]),
    );
  }
  if (value.contextModels !== undefined) {
    cloned.contextModels = Object.fromEntries(
      Object.entries(value.contextModels).map(([contextKey, models]) => [
        contextKey,
        Object.fromEntries(Object.entries(models).map(([token, model]) => [token, {
          schemaVersion: SCHEMA_VERSION,
          sampleCount: model.sampleCount,
          meanDelta: cloneVector(model.meanDelta),
          uncertainty: model.uncertainty,
        }])),
      ]),
    );
  }
  if (value.recentHistory !== undefined) {
    cloned.recentHistory = value.recentHistory.map((entry) => ({
      schemaVersion: SCHEMA_VERSION,
      token: entry.token,
      actualDelta: cloneVector(entry.actualDelta),
      ...(entry.historyOrder === undefined ? {} : { historyOrder: entry.historyOrder }),
    }));
  }
  if (value.historyClock !== undefined) cloned.historyClock = value.historyClock;
  if (value.historyAccumulator !== undefined) cloned.historyAccumulator = value.historyAccumulator;
  return cloned;
}

function cloneObservation(value) {
  const cloned = {
    schemaVersion: SCHEMA_VERSION,
    vector: cloneVector(value.vector),
    stateVersion: value.stateVersion,
    intervalId: value.intervalId,
  };
  if (value.feedback !== undefined) {
    cloned.feedback = value.feedback.map((item) => ({
      schemaVersion: SCHEMA_VERSION,
      executionNonce: item.executionNonce,
      stateVersion: item.stateVersion,
      intervalId: item.intervalId,
      vector: cloneVector(item.vector),
      confounderCount: item.confounderCount,
    }));
  }
  return cloned;
}

function cloneExpectation(value) {
  return {
    schemaVersion: SCHEMA_VERSION,
    token: value.token,
    expectedDelta: cloneVector(value.expectedDelta),
    predictedObservation: cloneObservation(value.predictedObservation),
    ...(value.relationKey === undefined ? {} : { relationKey: value.relationKey }),
    score: value.score,
    sampleCount: value.sampleCount,
    uncertainty: value.uncertainty,
  };
}

function cloneChoice(value) {
  return {
    schemaVersion: SCHEMA_VERSION,
    token: value.token,
    score: value.score,
    expectedValue: value.expectedValue,
    cost: value.cost,
    allowed: value.allowed,
    safe: value.safe,
  };
}

function assertPlainRecord(value, field, allowedKeys, requiredKeys = allowedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    contractViolation('kernel input field must be a plain record', {
      field,
      actualType: Array.isArray(value) ? 'array' : typeof value,
    });
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    contractViolation('kernel input record must not inherit data', { field });
  }

  const allowed = new Set(allowedKeys);
  const names = new Set();
  const snapshot = {};

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') {
      contractViolation('kernel input record contains a symbol key', { field });
    }

    if (key === '__proto__') {
      contractViolation('kernel input record contains __proto__', {
        field: `${field}.__proto__`,
      });
    }

    if (!allowed.has(key)) {
      contractViolation('kernel input record contains an undeclared field', {
        field: `${field}.${key}`,
      });
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    snapshot[key] = assertOwnDataDescriptor(descriptor, `${field}.${key}`);
    names.add(key);
  }

  for (const key of requiredKeys) {
    if (!names.has(key)) {
      contractViolation('kernel input record is missing a required field', {
        field: `${field}.${key}`,
      });
    }
  }

  if (names.size < requiredKeys.length || names.size > allowedKeys.length) {
    contractViolation('kernel input record field count mismatch', { field });
  }

  return snapshot;
}

function assertDynamicRecord(value, field, maxEntries = undefined) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    contractViolation('kernel input field must be a record', {
      field,
      actualType: Array.isArray(value) ? 'array' : typeof value,
    });
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    contractViolation('kernel input record must not inherit data', { field });
  }

  let entryCount = 0;
  const snapshot = {};
  for (const key of Reflect.ownKeys(value)) {
    entryCount += 1;
    if (maxEntries !== undefined && entryCount > maxEntries) {
      contractViolation('kernel input record exceeds its entry limit', { field });
    }
    if (typeof key === 'symbol') {
      contractViolation('kernel input record contains a symbol key', { field });
    }

    if (key === '__proto__') {
      contractViolation('kernel input record contains __proto__', {
        field: `${field}.__proto__`,
      });
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    snapshot[key] = assertOwnDataDescriptor(descriptor, `${field}.${key}`);
  }

  return snapshot;
}

function assertArray(value, field) {
  if (!Array.isArray(value)) {
    contractViolation('kernel input field must be an array', {
      field,
      actualType: typeof value,
    });
  }

  if (Object.getPrototypeOf(value) !== Array.prototype) {
    contractViolation('kernel input array must use Array.prototype', { field });
  }

  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !('value' in lengthDescriptor)) {
    contractViolation('kernel input array length must be a data property', {
      field: `${field}.length`,
    });
  }
  const length = lengthDescriptor.value;
  const snapshot = new Array(length);
  const seenIndexes = new Set();

  for (const key of keys) {
    if (typeof key === 'symbol') {
      contractViolation('kernel input array contains a symbol key', {
        field: `${field}.${String(key)}`,
      });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (key === 'length') {
      continue;
    }

    if (!isArrayIndexKey(key) || Number(key) >= length) {
      contractViolation('kernel input array contains an undeclared field', {
        field: `${field}.${key}`,
      });
    }

    snapshot[Number(key)] = assertOwnDataDescriptor(descriptor, `${field}[${key}]`);
    seenIndexes.add(Number(key));
  }

  for (let index = 0; index < length; index += 1) {
    if (!seenIndexes.has(index)) {
      contractViolation('kernel input array contains a hole', {
        field: `${field}[${index}]`,
      });
    }
  }

  return snapshot;
}

function assertOwnDataDescriptor(descriptor, field) {
  if (!descriptor || !('value' in descriptor)) {
    contractViolation('kernel input field must be an own data property', { field });
  }

  if (!descriptor.enumerable) {
    contractViolation('kernel input field must be enumerable', { field });
  }

  if (descriptor.value === undefined) {
    contractViolation('kernel input field must not be undefined', { field });
  }

  return descriptor.value;
}

function isArrayIndexKey(key) {
  if (!/^(0|[1-9]\d*)$/u.test(key)) {
    return false;
  }

  const value = Number(key);

  return Number.isSafeInteger(value) && value >= 0 && value < 0xffffffff - 1;
}

function requireSchemaVersion(value, field) {
  if (value.schemaVersion !== SCHEMA_VERSION) {
    contractViolation('kernel schemaVersion is unsupported', {
      field: `${field}.schemaVersion`,
      expected: SCHEMA_VERSION,
      actual: value.schemaVersion,
    });
  }

  return SCHEMA_VERSION;
}

function assertFiniteVector(value, field, expectedLength = undefined) {
  const items = assertArray(value, field);
  assertCollectionLimit(items.length, MAX_VECTOR_DIMENSIONS, field);

  if (expectedLength !== undefined && items.length !== expectedLength) {
    contractViolation('kernel vector dimension mismatch', {
      field,
      expectedLength,
      actualLength: items.length,
    });
  }

  return items.map((item, index) => assertFiniteNumber(item, `${field}[${index}]`));
}

function assertCollectionLimit(actual, max, field) {
  if (actual > max) {
    contractViolation('kernel input collection exceeds its size limit', {
      field,
      max,
      actual,
    });
  }
}

function assertFiniteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    contractViolation('kernel input field must be a finite number', {
      field,
      actual: value,
    });
  }

  return value;
}

function assertNonNegativeFiniteNumber(value, field) {
  const number = assertFiniteNumber(value, field);

  if (number < 0) {
    contractViolation('kernel input field must be non-negative', {
      field,
      actual: value,
    });
  }

  return number;
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    contractViolation('kernel input field must be a positive integer', {
      field,
      actual: value,
    });
  }

  return value;
}

function assertNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    contractViolation('kernel input field must be a non-negative integer', {
      field,
      actual: value,
    });
  }

  return value;
}

function assertBoolean(value, field) {
  if (typeof value !== 'boolean') {
    contractViolation('kernel input field must be boolean', {
      field,
      actual: value,
    });
  }

  return value;
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    contractViolation('kernel input field must be a non-empty string', {
      field,
      actual: value,
    });
  }

  return value;
}

function assertBoundedString(value, field, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    contractViolation('kernel input field must be a bounded non-empty string', {
      field,
      actual: value,
      maximum,
    });
  }

  return value;
}

function assertOpaqueToken(value, field) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    contractViolation('kernel action token is not opaque', { field });
  }

  return value;
}

function relationKeyFor(vector, valueSpec) {
  return `r1:${vector.map((value, index) => {
    const difference = valueSpec.target[index] - value;
    return valueSpec.valueMode === 'distance-v2' && Math.abs(difference) <= valueSpec.tolerance
      ? '0'
      : difference > 0 ? '+' : '-';
  }).join('')}`;
}

function assertRelationKey(value, field, dimensions) {
  if (typeof value !== 'string' || value.length > MAX_RELATION_KEY_LENGTH ||
      !/^r1:[+\-0]+$/u.test(value) || value.length !== dimensions + 3) {
    contractViolation('kernel relation key is invalid', { field });
  }
  return value;
}

function assertBeliefContextKey(value, field, dimensions) {
  if (value === OVERALL_BELIEF_CONTEXT) return value;
  return assertRelationKey(value, field, dimensions);
}

function contextKeysForMemory(memory) {
  const keys = [];
  if (memory.historyAccumulator !== undefined) {
    keys.push(`h2:${canonicalDigest({ historyAccumulator: memory.historyAccumulator })}`);
  }
  const recentKey = contextKeyForHistory(memory.recentHistory);
  if (recentKey !== undefined && !keys.includes(recentKey)) keys.push(recentKey);
  return keys.length === 0 ? undefined : keys;
}

function contextKeyForHistory(history) {
  if (history === undefined) return undefined;
  return `h1:${canonicalDigest(orderedHistory(history).map((entry) => ({
    token: entry.token,
    actualDelta: entry.actualDelta,
  })))}`;
}

function orderedHistory(history) {
  if (!history.some((entry) => entry.historyOrder !== undefined)) return history;
  return history
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => (left.entry.historyOrder ?? left.index) -
      (right.entry.historyOrder ?? right.index))
    .map(({ entry }) => entry);
}

function nextHistoryOrder(memory) {
  if (memory.historyClock === undefined) return undefined;
  if (memory.historyClock === Number.MAX_SAFE_INTEGER) {
    contractViolation('kernel history clock cannot be incremented safely', {
      field: 'learnOutput.nextMemory.historyClock',
    });
  }
  memory.historyClock += 1;
  return memory.historyClock;
}

function modularPower(base, exponent) {
  let result = 1n;
  let factor = base;
  let remaining = exponent;
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) result = (result * factor) & HISTORY_ACCUMULATOR_MASK;
    factor = (factor * factor) & HISTORY_ACCUMULATOR_MASK;
    remaining >>= 1n;
  }
  return result;
}

function assertContextKey(value, field) {
  const bounded = assertBoundedString(value, field, MAX_CONTEXT_KEY_LENGTH);
  if (!/^h[12]:sha256:[0-9a-f]{64}$/u.test(bounded)) {
    contractViolation('kernel context key is invalid', { field });
  }
  return bounded;
}

function assertOneOf(value, options, field) {
  if (!options.includes(value)) {
    contractViolation('kernel input field has an unsupported value', {
      field,
      actual: value,
    });
  }

  return value;
}

function contractViolation(message, context = {}) {
  const error = new TypeError(message);
  error.code = CONTRACT_ERROR_CODE;
  error.context = context;
  throw error;
}

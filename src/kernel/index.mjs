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
];
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
const MEMORY_KEYS = ['schemaVersion', 'actionModels', 'relationModels', 'rejectionModels'];
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

export function step(input) {
  return stepWithPreference(input, null);
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
  const source = assertPlainRecord(input, 'learnInput', LEARN_INPUT_KEYS);
  const intent = normalizeIntent(source.intent, 'learnInput.intent');
  const dimensions = intent.expectation.expectedDelta.length;
  const memory = normalizeMemory(source.memory, 'learnInput.memory', dimensions);
  const claimedVerification = normalizeVerification(
    source.verification,
    'learnInput.verification',
    dimensions,
  );
  const verification = verify({
    intent: source.intent,
    receipt: source.receipt,
    postObservation: source.postObservation,
  });
  assertVerificationMatches(claimedVerification, verification);
  assertIntentIsExecutable(intent, 'learnInput.intent.choice');

  if (!verification.learnable || verification.attribution !== 'ACTION') {
    if (verification.attribution === 'EXECUTION_REJECTED' && source.receipt.status === 'REJECTED') {
      const token = intent.choice.token;
      const nextMemory = cloneMemory(memory);
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
      };
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      status: 'SKIPPED',
      token: intent.choice.token,
      nextMemory: cloneMemory(memory),
    };
  }

  const token = intent.choice.token;
  const existing = memory.actionModels[token];
  if (!existing && Object.keys(memory.actionModels).length >= MAX_ACTION_MODELS) {
    contractViolation('kernel learning would exceed the action-model limit', {
      field: 'learnInput.memory.actionModels',
    });
  }
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
  const nextMemory = cloneMemory(memory);
  if (memory.rejectionModels?.[token] !== undefined) {
    nextMemory.rejectionModels[token] = updateRejectionModel(
      memory.rejectionModels[token],
      false,
      intent.expectation.relationKey,
      `learnOutput.nextMemory.rejectionModels.${token}`,
    );
  }
  nextMemory.actionModels[token] = updateActionModel(
    existing ?? defaultActionModel(dimensions),
    actualDelta,
    errorMagnitude,
    dimensions,
    `learnOutput.nextMemory.actionModels.${token}`,
  );
  const relationKey = intent.expectation.relationKey;
  if (relationKey !== undefined) {
    const relationModels = nextMemory.relationModels ?? {};
    const tokenRelations = { ...(relationModels[token] ?? {}) };
    const existingRelation = tokenRelations[relationKey];
    if (existingRelation === undefined && countRelationModels(relationModels) >= MAX_RELATION_MODELS) {
      contractViolation('kernel learning would exceed the relation-model limit', {
        field: `learnInput.memory.relationModels.${token}.${relationKey}`,
      });
    }
    tokenRelations[relationKey] = updateActionModel(
      existingRelation ?? defaultActionModel(dimensions),
      actualDelta,
      errorMagnitude,
      dimensions,
      `learnOutput.nextMemory.relationModels.${token}.${relationKey}`,
    );
    nextMemory.relationModels = {
      ...relationModels,
      [token]: tokenRelations,
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'UPDATED',
    token,
    nextMemory,
  };
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
    return { schemaVersion: SCHEMA_VERSION, horizon: 1 };
  }
  const source = assertPlainRecord(value, field, ['schemaVersion', 'horizon']);
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
  const source = assertPlainRecord(value, field, OBSERVATION_KEYS);
  const vector = assertFiniteVector(source.vector, `${field}.vector`);

  return {
    schemaVersion: requireSchemaVersion(source, field),
    vector,
    stateVersion: assertNonEmptyString(source.stateVersion, `${field}.stateVersion`),
    intervalId: assertNonEmptyString(source.intervalId, `${field}.intervalId`),
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
  return {
    schemaVersion: requireSchemaVersion(source, field),
    actionModels: normalizedModels,
    ...(normalizedRelations === undefined ? {} : { relationModels: normalizedRelations }),
    ...(normalizedRejections === undefined ? {} : { rejectionModels: normalizedRejections }),
  };
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
    executionNonce: assertNonEmptyString(
      source.executionNonce,
      `${field}.executionNonce`,
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
  return input.capabilities.map((capability) => {
    const relationKey = input.memory.relationModels === undefined
      ? undefined
      : relationKeyFor(input.observation.vector, input.valueSpec);
    const rejectionModel = input.memory.rejectionModels?.[capability.token];
    const rejectedRecently = rejectionModel?.rejected === true &&
      rejectionModel.relationKey === relationKey;
    const model =
      input.memory.relationModels?.[capability.token]?.[relationKey] ??
      input.memory.actionModels[capability.token] ??
      defaultActionModel(input.observation.vector.length);
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
      uncertaintyPenalty(model.uncertainty, input.valueSpec.weights),
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
        uncertainty: model.uncertainty,
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
// learned transition model forward, then lets the normal kernel policy choose
// each simulated follow-up action. The real WorldPort is still re-observed at
// the next committed step, so speculative state never crosses the safety
// boundary.
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
  let predictedVector = firstPrediction.expectation.predictedObservation.vector;
  let totalCost = firstPrediction.choice.cost +
    uncertaintyPenalty(firstPrediction.expectation.uncertainty, input.valueSpec.weights);
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
    predictedVector = future.expectation.predictedObservation.vector;
    totalCost += future.choice.cost +
      uncertaintyPenalty(future.expectation.uncertainty, input.valueSpec.weights);
  }
  return assertComputedFiniteNumber(
    valueObservation(predictedVector, input.valueSpec) - totalCost,
    'stepOutput.planning.utility',
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
  return cloned;
}

function cloneObservation(value) {
  return {
    schemaVersion: SCHEMA_VERSION,
    vector: cloneVector(value.vector),
    stateVersion: value.stateVersion,
    intervalId: value.intervalId,
  };
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

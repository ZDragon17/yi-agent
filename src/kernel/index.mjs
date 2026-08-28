const SCHEMA_VERSION = 1;
const CONTRACT_ERROR_CODE = 'KERNEL_CONTRACT_VIOLATION';
const TOKEN_PATTERN = /^tok_[A-Z0-9]{8,128}$/u;
const MAX_VECTOR_DIMENSIONS = 1024;
const MAX_CAPABILITIES = 4096;
const MAX_ACTION_MODELS = 8192;

const STEP_INPUT_KEYS = [
  'observation',
  'memory',
  'valueSpec',
  'capabilities',
  'rngState',
];
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
];
const MEMORY_KEYS = ['schemaVersion', 'actionModels'];
const ACTION_MODEL_KEYS = [
  'schemaVersion',
  'sampleCount',
  'meanDelta',
  'uncertainty',
];
const CAPABILITY_KEYS = [
  'schemaVersion',
  'token',
  'cost',
  'allowed',
  'safe',
];
const RNG_STATE_KEYS = ['schemaVersion', 'algorithm', 'state'];
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
  const normalized = normalizeStepInput(input);
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
  const untriedPredictions = safePredictions.filter(
    (item) => item.expectation.sampleCount === 0,
  );
  const selectionPool =
    untriedPredictions.length > 0 ? untriedPredictions : safePredictions;
  const selected = selectionPool[choosePredictionIndex(selectionPool, rng.unit)];

  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'READY',
    expectation: cloneExpectation(selected.expectation),
    choice: cloneChoice(selected.choice),
    nextRngState: rng.nextState,
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
  const current = existing ?? defaultActionModel(dimensions);
  if (current.sampleCount === Number.MAX_SAFE_INTEGER) {
    contractViolation('kernel action-model sample count cannot be incremented safely', {
      field: `learnInput.memory.actionModels.${token}.sampleCount`,
    });
  }
  const nextSampleCount = current.sampleCount + 1;
  const actualDelta = addVectors(
    intent.expectation.expectedDelta,
    verification.error,
    'learnOutput.actualDelta',
  );
  const nextMean = current.meanDelta.map((mean, index) =>
    assertComputedFiniteNumber(
      mean + (actualDelta[index] - mean) / nextSampleCount,
      `learnOutput.nextMemory.actionModels.${token}.meanDelta[${index}]`,
    ),
  );
  let totalError = 0;
  for (let index = 0; index < verification.error.length; index += 1) {
    totalError = assertComputedFiniteNumber(
      totalError + Math.abs(verification.error[index]),
      `learnOutput.errorMagnitude[${index}]`,
    );
  }
  const errorMagnitude = totalError / dimensions;
  const nextUncertainty = assertComputedFiniteNumber(
    (current.uncertainty * current.sampleCount + errorMagnitude) /
      nextSampleCount,
    `learnOutput.nextMemory.actionModels.${token}.uncertainty`,
  );
  const nextMemory = cloneMemory(memory);
  nextMemory.actionModels[token] = {
    schemaVersion: SCHEMA_VERSION,
    sampleCount: nextSampleCount,
    meanDelta: nextMean,
    uncertainty: nextUncertainty,
  };

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
  const source = assertPlainRecord(input, 'stepInput', STEP_INPUT_KEYS);
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

  return {
    observation,
    memory,
    valueSpec,
    capabilities,
    rngState,
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
  const source = assertPlainRecord(value, field, VALUE_SPEC_KEYS);
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
  };
}

function normalizeMemory(value, field, dimensions) {
  const source = assertPlainRecord(value, field, MEMORY_KEYS);
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

  return {
    schemaVersion: requireSchemaVersion(source, field),
    actionModels: normalizedModels,
  };
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
  const source = assertPlainRecord(value, field, EXPECTATION_KEYS);
  const predictedObservation = normalizeObservation(
    source.predictedObservation,
    `${field}.predictedObservation`,
  );
  const expectedDelta = assertFiniteVector(
    source.expectedDelta,
    `${field}.expectedDelta`,
    predictedObservation.vector.length,
  );

  return {
    schemaVersion: requireSchemaVersion(source, field),
    token: assertOpaqueToken(source.token, `${field}.token`),
    expectedDelta,
    predictedObservation,
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
    const model =
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
    const contribution =
      (vector[index] - valueSpec.target[index]) * valueSpec.weights[index];
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
  return {
    schemaVersion: SCHEMA_VERSION,
    actionModels,
  };
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

function assertPlainRecord(value, field, allowedKeys) {
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

  for (const key of allowedKeys) {
    if (!names.has(key)) {
      contractViolation('kernel input record is missing a required field', {
        field: `${field}.${key}`,
      });
    }
  }

  if (names.size !== allowedKeys.length) {
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

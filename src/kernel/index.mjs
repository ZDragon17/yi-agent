import {
  MAX_BOUNDARY_IDENTIFIER_LENGTH,
  MAX_EXECUTION_NONCE_LENGTH,
  MAX_PERSISTED_MEMORY_BYTES,
  canonicalDigest,
  canonicalJson,
} from '../runtime/schema.mjs';

const SCHEMA_VERSION = 1;
const CONTRACT_ERROR_CODE = 'KERNEL_CONTRACT_VIOLATION';
const TOKEN_PATTERN = /^tok_[A-Z0-9]{8,128}$/u;
const MAX_VECTOR_DIMENSIONS = 1024;
const MAX_CAPABILITIES = 4096;
const MAX_ACTION_MODELS = 8192;
const MAX_RELATION_MODELS = 8192;
const MAX_RELATION_KEY_LENGTH = MAX_VECTOR_DIMENSIONS + 3;
const ADAPTATION_WINDOW = 8;
const REVALIDATION_INTERVAL = 8;
const MAX_PLANNING_HORIZON = 8;
const MAX_PLANNING_CANDIDATES = 64;
const PLANNING_INFORMATION_MODES = ['belief-v1', 'belief-v2', 'belief-v3', 'legacy-v1'];
const PLANNING_CONTEXT_MODES = ['context-v1', 'legacy-v1'];
const PLANNING_BRANCHING_MODES = ['tree-v1', 'recursive-v1', 'legacy-v1'];
const MAX_PLANNING_ROLLOUTS = 128;
const MAX_PENDING_CREDITS = 64;
const MAX_FEEDBACK_ITEMS = 64;
const MAX_SETTLED_FEEDBACK = 64;
const MAX_PENDING_CREDIT_AGE = 8;
const MAX_BELIEF_MODELS = 8192;
const MAX_BELIEF_SAMPLES = 8;
// v26 起 recentHistory 保留最近 8 条已验证变化：h1 键取最近 2 条，h2 窗口键取
// 全部 8 条；旧账本最多只有 2 条，切片在旧记忆上数学等价，回放不受影响。
const MAX_RECENT_HISTORY = 8;
const H1_CONTEXT_WINDOW = 2;
const MAX_CONTEXT_MODELS = 8192;
// v26 起 h2 键来自最近 8 条已验证变化的窗口摘要：周期-7 碰撞反证显示窗口-1/2
// 在碰撞相位上信息不足，而周期 < 8 的轨道每个相位拥有唯一的窗口摘要。
const LONG_CONTEXT_KEY_WINDOW = 8;
const MAX_LONG_CONTEXTS = 8;
const MAX_CONTEXT_KEY_LENGTH = 4096;
const PERSISTED_MEMORY_TRIM_BATCH = 64;
const CURRENT_LEARNING_VERSION = 26;
export const KERNEL_LEARNING_VERSIONS = Object.freeze({
  settledFeedback: 3,
  pendingCreditExpiry: 4,
  belief: 5,
  canonicalFeedbackOrder: 6,
  sharedFeedbackBoundary: 7,
  supervisorFeedbackAlignment: 8,
  historyAccumulator: 11,
  activeInformationPlanning: 12,
  decisionDivergenceInformationPlanning: 13,
  valueRelevantInformationPlanning: 14,
  revalidation: 15,
  contextPlanning: 16,
  recursivePlanning: 17,
  treePlanning: 18,
  modelAge: 21,
  persistedMemoryBudget: 22,
  modelRecency: 23,
  modelQualityRetention: 24,
  multiScaleContext: 25,
  longContextWindow: 26,
  current: CURRENT_LEARNING_VERSION,
});
const MODEL_RECENCY_LEARNING_VERSION = KERNEL_LEARNING_VERSIONS.modelRecency;
const MODEL_QUALITY_RETENTION_LEARNING_VERSION = KERNEL_LEARNING_VERSIONS.modelQualityRetention;
const PERSISTED_MEMORY_BUDGET_LEARNING_VERSION = KERNEL_LEARNING_VERSIONS.persistedMemoryBudget;
const MULTI_SCALE_CONTEXT_LEARNING_VERSION = KERNEL_LEARNING_VERSIONS.multiScaleContext;
const LONG_CONTEXT_WINDOW_LEARNING_VERSION = KERNEL_LEARNING_VERSIONS.longContextWindow;
const OVERALL_BELIEF_CONTEXT = 'overall';
const HISTORY_ACCUMULATOR_HEX_LENGTH = 64;
const HISTORY_ACCUMULATOR_PATTERN = /^[0-9a-f]{64}$/u;
const HISTORY_ACCUMULATOR_MASK = (1n << 256n) - 1n;
const HISTORY_ACCUMULATOR_BASE = 0x9e3779b185ebca87f4a7c15f39cc0605n;
const FEEDBACK_ORDER_MODES = ['arrival-v1', 'pending-v2'];
const FEEDBACK_CAUSALITY_MODES = ['legacy-v1', 'boundary-v2'];
const TOP_LEVEL_MODEL_COUNTS = new WeakMap();
const NESTED_MODEL_COUNTS = new WeakMap();

const STEP_INPUT_KEYS = [
  'observation',
  'memory',
  'valueSpec',
  'capabilities',
  'rngState',
  'strategy',
  'planning',
  'learningVersion',
];
const STEP_INPUT_REQUIRED_KEYS = STEP_INPUT_KEYS.filter((key) => key !== 'strategy' && key !== 'planning' && key !== 'learningVersion');
const VERIFY_INPUT_KEYS = ['intent', 'receipt', 'postObservation'];
const LEARN_INPUT_KEYS = [
  'memory',
  'intent',
  'receipt',
  'postObservation',
  'verification',
  'feedbackOrder',
  'feedbackCausality',
  'learningVersion',
];
const LEARN_INPUT_REQUIRED_KEYS = LEARN_INPUT_KEYS.filter((key) => !['feedbackOrder', 'feedbackCausality', 'learningVersion'].includes(key));
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
const MEMORY_KEYS = ['schemaVersion', 'actionModels', 'relationModels', 'rejectionModels', 'pendingCredits', 'settledFeedback', 'pendingCreditPolicy', 'beliefModels', 'contextModels', 'recentHistory', 'historyClock', 'historyAccumulator', 'lastVerifiedSteps', 'lastProbeSteps', 'modelClock', 'modelAges', 'contextKeyScale'];
const ACTION_MODEL_KEYS = [
  'schemaVersion',
  'sampleCount',
  'meanDelta',
  'uncertainty',
  'modelAge',
];
const REJECTION_MODEL_KEYS = ['schemaVersion', 'sampleCount', 'rejected', 'relationKey', 'modelAge'];
const CAPABILITY_KEYS = [
  'schemaVersion',
  'token',
  'cost',
  'allowed',
  'safe',
];
const RNG_STATE_KEYS = ['schemaVersion', 'algorithm', 'state'];
const STRATEGY_KEYS = ['schemaVersion', 'mode', 'revision', 'reason', 'explorationMode'];
const EXPLORATION_MODES = ['uncertainty-v1', 'coverage-v1'];
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
  'verificationAge',
];
const CHOICE_KEYS = [
  'schemaVersion',
  'token',
  'score',
  'expectedValue',
  'cost',
  'allowed',
  'safe',
  'contextProbe',
];
// contextProbe 只出现在 v25+ 的探测选择里，历史账本的 choice 没有该字段。
const CHOICE_REQUIRED_KEYS = CHOICE_KEYS.filter((key) => key !== 'contextProbe');
// 上下文反事实探测的复验间隔：同一候选两次探测之间至少间隔的已验证动作数。
const CONTEXT_PROBE_INTERVAL = 8;
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
const BELIEF_MODEL_KEYS = ['schemaVersion', 'sampleCount', 'samples', 'modelAge'];
const MODEL_AGE_KEYS = ['schemaVersion', 'actionModels', 'relationModels', 'rejectionModels', 'beliefModels', 'contextModels'];
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
  if ((observation.feedback?.length ?? 0) === 0) return;
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
  // v26 起强制重验只针对「信念上仍不劣于任何候选」的过期行动：隐藏漂移只能
  // 靠真实重验发现，而全局证据已判劣的冷门候选由上下文反事实探测负责取证，
  // freshness 不再为它们打破已收敛的上下文轨道。v25 及更早的无条件语义按
  // 学习版本原样保留。
  const believedEffectOf = (prediction) => prediction.expectation.expectedDelta
    .reduce((sum, value) => sum + value, 0);
  const bestBelievedEffect = Math.max(...safePredictions.map(believedEffectOf));
  const overduePool = untriedPredictions.length === 0
    ? revalidationCandidatePool(
        nonRejectedPredictions.length > 0 ? nonRejectedPredictions : safePredictions,
        normalized.memory,
      )
    : [];
  const revalidationPool = overduePool.filter((prediction) =>
    normalized.learningVersion < LONG_CONTEXT_WINDOW_LEARNING_VERSION ||
    believedEffectOf(prediction) >= bestBelievedEffect);
  const selected = normalizedPreference?.required === true
    ? preferred ?? chooseByStrategy(selectionPool, normalized.strategy, rng.unit)
    : revalidationPool.length > 0
      ? chooseByStrategy(revalidationPool, normalized.strategy, rng.unit)
      : preferred ?? (normalized.planning.horizon > 1 && untriedPredictions.length === 0
        ? chooseByPlanning(selectionPool, normalized, rng.unit)
        : withContextualProbe(selectionPool, chooseByStrategy(selectionPool, normalized.strategy, rng.unit), normalized.memory));

  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'READY',
    expectation: cloneExpectation(selected.expectation),
    choice: cloneChoice(selected.choice),
    nextRngState: rng.nextState,
  };
}

// 上下文反事实探测：当价值最优的选择依赖本上下文的证据，而另一安全候选
// 在本上下文从未取得过自己的证据时，有界地探一次该候选。全局证据可能被
// 早期混合样本毒化，不能作为「该候选在此上下文无用」的依据；上下文证据
// 只能靠一次真实的 verify→learn 取得。探测只改写本步选择，不扩大权限。
function withContextualProbe(selectionPool, selected, memory) {
  if (memory.contextKeyScale === undefined || memory.historyClock === undefined) return selected;
  if (selected?.contextResolved !== true) return selected;
  let probe = undefined;
  for (const prediction of selectionPool) {
    if (prediction === selected || prediction.contextResolved) continue;
    const lastProbe = memory.lastProbeSteps?.[prediction.choice.token];
    if (lastProbe !== undefined && memory.historyClock - lastProbe < CONTEXT_PROBE_INTERVAL) continue;
    if (probe === undefined || prediction.choice.score > probe.choice.score) {
      probe = prediction;
    }
  }
  if (probe === undefined) return selected;
  return {
    ...selected,
    expectation: probe.expectation,
    choice: { ...probe.choice, contextProbe: true },
  };
}

function normalizePreference(value) {
  if (value === null || value === undefined) return null;
  const source = assertPlainRecord(value, 'stepPreference', ['schemaVersion', 'token', 'required'], ['schemaVersion', 'token']);
  return {
    schemaVersion: requireSchemaVersion(source, 'stepPreference'),
    token: assertOpaqueToken(source.token, 'stepPreference.token'),
    required: source.required === undefined ? false : assertBoolean(source.required, 'stepPreference.required'),
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
  const learningVersion = source.learningVersion === undefined
    ? CURRENT_LEARNING_VERSION
    : assertLearningVersion(source.learningVersion, 'learnInput.learningVersion');
  const enforcePersistedMemoryBudget = learningVersion >= PERSISTED_MEMORY_BUDGET_LEARNING_VERSION;
  const refreshModelAge = learningVersion >= MODEL_RECENCY_LEARNING_VERSION;
  const retentionMode = learningVersion >= MODEL_QUALITY_RETENTION_LEARNING_VERSION
    ? 'pareto-v1'
    : 'recency-v1';
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

  const nextMemory = cloneMemory(memory, { compactAges: false });
  // 上下文证据的写入按学习版本门控：h0 只对 v25+ 写入；h2 在 v26 起改用窗口基，
  // v25 及更早的 Replay 继续写累加器键，历史账本的记忆形状保持原样。
  const contextKeys = contextKeysForMemory(memory, {
    includeShortContext: learningVersion >= MULTI_SCALE_CONTEXT_LEARNING_VERSION,
    longContextWindow: learningVersion >= LONG_CONTEXT_WINDOW_LEARNING_VERSION,
  });
  const settlement = settlePendingCredits(
    nextMemory,
    postObservation,
    dimensions,
    'learnInput.postObservation.feedback',
    feedbackOrder,
    feedbackCausality,
    refreshModelAge,
  );
  const settled = settlement.entries;

  if (!verification.learnable || verification.attribution !== 'ACTION') {
    if (verification.attribution === 'EXECUTION_REJECTED' && source.receipt.status === 'REJECTED') {
      const token = intent.choice.token;
      const rejectionModels = nextMemory.rejectionModels ?? {};
      let existingRejection = rejectionModels[token];
      let rejectionModelCount = existingRejection === undefined
        ? cachedTopLevelModelCount(rejectionModels)
        : null;
      if (existingRejection === undefined && rejectionModelCount >= MAX_ACTION_MODELS) {
        const evictedToken = evictOldestTopLevelModel(rejectionModels);
        if (evictedToken === undefined) {
          contractViolation('kernel learning has no evictable rejection model', {
            field: 'learnOutput.nextMemory.rejectionModels',
          });
        }
        rejectionModelCount -= 1;
        existingRejection = rejectionModels[token];
      }
      if (existingRejection === undefined && rejectionModelCount >= MAX_ACTION_MODELS) {
        contractViolation('kernel learning would exceed the rejection-model limit', {
          field: 'learnOutput.nextMemory.rejectionModels',
        });
      }
      const rejectionModelAge = modelAgeFor(
        nextMemory,
        existingRejection,
        `learnOutput.nextMemory.rejectionModels.${token}.modelAge`,
        refreshModelAge,
      );
      rejectionModels[token] = updateRejectionModel(
        existingRejection,
        true,
        intent.expectation.relationKey,
        `learnOutput.nextMemory.rejectionModels.${token}`,
        rejectionModelAge,
      );
      nextMemory.rejectionModels = rejectionModels;
      if (existingRejection === undefined) {
        TOP_LEVEL_MODEL_COUNTS.set(rejectionModels, rejectionModelCount + 1);
      }
      return {
        schemaVersion: SCHEMA_VERSION,
        status: 'REJECTION_RECORDED',
        token,
        nextMemory: cloneMemory(nextMemory, {
          enforcePersistedBudget: enforcePersistedMemoryBudget,
          retentionMode,
        }),
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
        nextMemory: cloneMemory(nextMemory, {
          enforcePersistedBudget: enforcePersistedMemoryBudget,
          retentionMode,
        }),
        ...(settled.length === 0 ? {} : { settled }),
      };
    }
    if (settled.length > 0) {
      return {
        schemaVersion: SCHEMA_VERSION,
        status: 'SKIPPED',
        token: intent.choice.token,
        nextMemory: cloneMemory(nextMemory, {
          enforcePersistedBudget: enforcePersistedMemoryBudget,
          retentionMode,
        }),
        settled,
      };
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      status: 'SKIPPED',
      token: intent.choice.token,
      nextMemory: cloneMemory(nextMemory, {
        enforcePersistedBudget: enforcePersistedMemoryBudget,
        retentionMode,
      }),
      ...(settled.length === 0 ? {} : { settled }),
    };
  }

  if (settlement.hasFeedbackSettlement) {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: 'SKIPPED',
      token: intent.choice.token,
      nextMemory: cloneMemory(nextMemory, {
        enforcePersistedBudget: enforcePersistedMemoryBudget,
        retentionMode,
      }),
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
    refreshModelAge,
    contextProbe: intent.choice.contextProbe === true,
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'UPDATED',
    token,
    nextMemory: cloneMemory(nextMemory, {
      enforcePersistedBudget: enforcePersistedMemoryBudget,
      retentionMode,
    }),
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
  refreshModelAge = false,
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
      refreshModelAge,
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
  const learningVersion = source.learningVersion === undefined
    ? CURRENT_LEARNING_VERSION
    : assertLearningVersion(source.learningVersion, 'stepInput.learningVersion');

  return {
    observation,
    memory,
    valueSpec,
    capabilities,
    rngState,
    strategy,
    planning,
    learningVersion,
  };
}

function normalizePlanning(value, field) {
  if (value === undefined) {
    return {
      schemaVersion: SCHEMA_VERSION,
      horizon: 1,
      informationMode: 'belief-v3',
      contextMode: 'context-v1',
      branchingMode: 'tree-v1',
    };
  }
  const source = assertPlainRecord(
    value,
    field,
    ['schemaVersion', 'horizon', 'informationMode', 'contextMode', 'branchingMode'],
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
    informationMode: source.informationMode === undefined ? 'belief-v3' :
      assertOneOf(source.informationMode, PLANNING_INFORMATION_MODES, `${field}.informationMode`),
    contextMode: source.contextMode === undefined ? 'context-v1' :
      assertOneOf(source.contextMode, PLANNING_CONTEXT_MODES, `${field}.contextMode`),
    branchingMode: source.branchingMode === undefined ? 'tree-v1' :
      assertOneOf(source.branchingMode, PLANNING_BRANCHING_MODES, `${field}.branchingMode`),
  };
}

function normalizeStrategy(value, field) {
  if (value === undefined) {
    return { schemaVersion: SCHEMA_VERSION, mode: 'BALANCED', revision: 0, reason: null };
  }
  const source = assertPlainRecord(value, field, STRATEGY_KEYS, ['schemaVersion', 'mode', 'revision', 'reason']);
  if (requireSchemaVersion(source, field) !== SCHEMA_VERSION ||
      !['BALANCED', 'EXPLORATORY'].includes(source.mode) ||
      !Number.isSafeInteger(source.revision) || source.revision < 0 ||
      typeof source.reason !== 'string' && source.reason !== null ||
      source.explorationMode !== undefined && !EXPLORATION_MODES.includes(source.explorationMode)) {
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
    explorationMode: source.explorationMode === undefined ? 'uncertainty-v1' :
      assertOneOf(source.explorationMode, EXPLORATION_MODES, `${field}.explorationMode`),
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
  const stateVersion = assertBoundedString(
    source.stateVersion,
    `${field}.stateVersion`,
    MAX_BOUNDARY_IDENTIFIER_LENGTH,
  );
  const intervalId = assertBoundedString(
    source.intervalId,
    `${field}.intervalId`,
    MAX_BOUNDARY_IDENTIFIER_LENGTH,
  );
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
      stateVersion: assertBoundedString(
        source.stateVersion,
        `${field}[${index}].stateVersion`,
        MAX_BOUNDARY_IDENTIFIER_LENGTH,
      ),
      intervalId: assertBoundedString(
        source.intervalId,
        `${field}[${index}].intervalId`,
        MAX_BOUNDARY_IDENTIFIER_LENGTH,
      ),
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
  TOP_LEVEL_MODEL_COUNTS.set(normalizedModels, Object.keys(normalizedModels).length);

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
  const lastVerifiedSteps = source.lastVerifiedSteps === undefined
    ? undefined
    : normalizeLastVerifiedSteps(source.lastVerifiedSteps, `${field}.lastVerifiedSteps`);
  const lastProbeSteps = source.lastProbeSteps === undefined
    ? undefined
    : normalizeLastProbeSteps(source.lastProbeSteps, `${field}.lastProbeSteps`);
  const modelClock = source.modelClock === undefined
    ? undefined
    : assertNonNegativeInteger(source.modelClock, `${field}.modelClock`);
  const contextKeyScale = source.contextKeyScale === undefined
    ? undefined
    : assertContextKeyScale(source.contextKeyScale, `${field}.contextKeyScale`);
  if (source.modelAges !== undefined) {
    applyCompactModelAges(
      source.modelAges,
      normalizedModels,
      normalizedRelations,
      normalizedRejections,
      normalizedBeliefs,
      normalizedContextModels,
      `${field}.modelAges`,
    );
  }
  if (modelClock === undefined && (
    source.modelAges !== undefined ||
    hasModelAge(normalizedModels) ||
    hasNestedModelAge(normalizedRelations) ||
    hasModelAge(normalizedRejections) ||
    hasNestedModelAge(normalizedBeliefs) ||
    hasNestedModelAge(normalizedContextModels)
  )) {
    contractViolation('kernel model age state requires a model clock', {
      field: `${field}.modelClock`,
    });
  }
  if (historyAccumulator !== undefined && historyClock === undefined) {
    contractViolation('kernel history accumulator requires a history clock', {
      field: `${field}.historyAccumulator`,
    });
  }
  if (lastVerifiedSteps !== undefined && historyClock === undefined) {
    contractViolation('kernel verification freshness requires a history clock', {
      field: `${field}.lastVerifiedSteps`,
    });
  }
  if (lastVerifiedSteps !== undefined && Object.values(lastVerifiedSteps).some((step) => step > historyClock)) {
    contractViolation('kernel verification freshness cannot point beyond the history clock', {
      field: `${field}.lastVerifiedSteps`,
    });
  }
  if (lastProbeSteps !== undefined && historyClock === undefined) {
    contractViolation('kernel context probe freshness requires a history clock', {
      field: `${field}.lastProbeSteps`,
    });
  }
  if (lastProbeSteps !== undefined && Object.values(lastProbeSteps).some((step) => step > historyClock)) {
    contractViolation('kernel context probe freshness cannot point beyond the history clock', {
      field: `${field}.lastProbeSteps`,
    });
  }
  validateHistoryOrdering(
    normalizedRecentHistory,
    normalizedPendingCredits,
    historyClock,
    field,
  );
  validateModelAgeCoverage(
    modelClock,
    normalizedModels,
    normalizedRelations,
    normalizedRejections,
    normalizedBeliefs,
    normalizedContextModels,
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
    ...(lastVerifiedSteps === undefined ? {} : { lastVerifiedSteps }),
    ...(lastProbeSteps === undefined ? {} : { lastProbeSteps }),
    ...(modelClock === undefined ? {} : { modelClock }),
    ...(contextKeyScale === undefined ? {} : { contextKeyScale }),
  };
}

function normalizeLastProbeSteps(value, field) {
  const source = assertDynamicRecord(value, field, MAX_ACTION_MODELS);
  const normalized = Object.create(null);
  for (const [token, step] of Object.entries(source)) {
    assertOpaqueToken(token, `${field} token`);
    normalized[token] = assertNonNegativeInteger(step, `${field}.${token}`);
  }
  return normalized;
}

// 上下文键把浮点重构残差（如 0 的 -3.7e-17 表示）量化到固定十进制精度，
// 使语义相同的已验证变化落入同一键；缺失该字段的旧记忆按原始字节键回放。
function assertContextKeyScale(value, field) {
  const scale = assertNonNegativeInteger(value, field);
  if (scale < 1 || scale > 15) {
    contractViolation('kernel context key scale must be between 1 and 15 decimal digits', {
      field,
    });
  }
  return scale;
}

function hasModelAge(models) {
  return Object.values(models ?? {}).some((model) => model.modelAge !== undefined);
}

function hasNestedModelAge(models) {
  return Object.values(models ?? {}).some((nested) => hasModelAge(nested));
}

function applyCompactModelAges(value, actionModels, relationModels, rejectionModels, beliefModels, contextModels, field) {
  const source = assertPlainRecord(value, field, MODEL_AGE_KEYS, ['schemaVersion']);
  applyTopLevelModelAges(actionModels, source.actionModels, `${field}.actionModels`);
  applyTopLevelModelAges(rejectionModels, source.rejectionModels, `${field}.rejectionModels`);
  applyNestedModelAges(relationModels, source.relationModels, `${field}.relationModels`);
  applyNestedModelAges(beliefModels, source.beliefModels, `${field}.beliefModels`);
  applyNestedModelAges(contextModels, source.contextModels, `${field}.contextModels`);
}

function applyTopLevelModelAges(models, ages, field) {
  if (ages === undefined) return;
  const values = decodeCompactModelAges(ages, field);
  const keys = Object.keys(models ?? {}).sort();
  if (values.length !== keys.length) {
    contractViolation('kernel compact model ages do not match its model record', { field });
  }
  for (let index = 0; index < keys.length; index += 1) {
    setModelAge(models[keys[index]], values[index], `${field}[${index}]`);
  }
}

function applyNestedModelAges(models, ages, field) {
  if (ages === undefined) return;
  const values = assertArray(ages, field);
  const outerKeys = Object.keys(models ?? {}).sort();
  if (values.length !== outerKeys.length) {
    contractViolation('kernel compact nested model ages do not match its model record', { field });
  }
  for (let outerIndex = 0; outerIndex < outerKeys.length; outerIndex += 1) {
    const outerKey = outerKeys[outerIndex];
    const innerAges = decodeCompactModelAges(values[outerIndex], `${field}[${outerIndex}]`);
    const innerKeys = Object.keys(models[outerKey]).sort();
    if (innerAges.length !== innerKeys.length) {
      contractViolation('kernel compact nested model ages do not match its model record', { field });
    }
    for (let innerIndex = 0; innerIndex < innerKeys.length; innerIndex += 1) {
      setModelAge(
        models[outerKey][innerKeys[innerIndex]],
        innerAges[innerIndex],
        `${field}[${outerIndex}][${innerIndex}]`,
      );
    }
  }
}

function decodeCompactModelAges(value, field) {
  if (Array.isArray(value)) {
    return value.map((age, index) => assertNonNegativeInteger(age, `${field}[${index}]`));
  }
  if (typeof value !== 'string') {
    contractViolation('kernel compact model ages must be a base36 string or an array', { field });
  }
  if (value.length === 0) return [];
  return value.split(',').map((encoded, index) => {
    if (!/^[0-9a-z]+$/u.test(encoded)) {
      contractViolation('kernel compact model age is invalid', { field: `${field}[${index}]` });
    }
    const age = Number.parseInt(encoded, 36);
    return assertNonNegativeInteger(age, `${field}[${index}]`);
  });
}

function setModelAge(model, value, field) {
  const age = assertNonNegativeInteger(value, field);
  if (model.modelAge !== undefined && model.modelAge !== age) {
    contractViolation('kernel model age has contradictory representations', { field });
  }
  model.modelAge = age;
}

function normalizeLastVerifiedSteps(value, field) {
  const source = assertDynamicRecord(value, field, MAX_ACTION_MODELS);
  const normalized = Object.create(null);
  for (const [token, step] of Object.entries(source)) {
    assertOpaqueToken(token, `${field} token`);
    normalized[token] = assertPositiveInteger(step, `${field}.${token}`);
  }
  return normalized;
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
  NESTED_MODEL_COUNTS.set(normalized, modelCount);
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
  // v25 起接受至多 3 个键（h2 + h1 + h0）；历史账本至多 2 个仍合法。
  if (items.length === 0 || items.length > 3) {
    contractViolation('kernel context key list has an invalid size', {
      field,
      max: 3,
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
  NESTED_MODEL_COUNTS.set(normalized, modelCount);
  return normalized;
}

function normalizeBeliefModel(value, field, dimensions) {
  const source = assertPlainRecord(
    value,
    field,
    BELIEF_MODEL_KEYS,
    BELIEF_MODEL_KEYS.filter((key) => key !== 'modelAge'),
  );
  const samples = assertArray(source.samples, `${field}.samples`);
  if (samples.length > MAX_BELIEF_SAMPLES) {
    contractViolation('kernel belief samples exceed their size limit', { field });
  }
  return {
    schemaVersion: requireSchemaVersion(source, field),
    sampleCount: assertNonNegativeInteger(source.sampleCount, `${field}.sampleCount`),
    samples: samples.map((sample, index) =>
      cloneVector(assertFiniteVector(sample, `${field}.samples[${index}]`, dimensions))),
    ...(source.modelAge === undefined ? {} : {
      modelAge: assertNonNegativeInteger(source.modelAge, `${field}.modelAge`),
    }),
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
      beforeStateVersion: assertBoundedString(
        source.beforeStateVersion,
        `${itemField}.beforeStateVersion`,
        MAX_BOUNDARY_IDENTIFIER_LENGTH,
      ),
      beforeIntervalId: assertBoundedString(
        source.beforeIntervalId,
        `${itemField}.beforeIntervalId`,
        MAX_BOUNDARY_IDENTIFIER_LENGTH,
      ),
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
      ...(modelSource.modelAge === undefined ? {} : {
        modelAge: assertNonNegativeInteger(modelSource.modelAge, `${field}.${token}.modelAge`),
      }),
    };
  }
  TOP_LEVEL_MODEL_COUNTS.set(normalized, Object.keys(normalized).length);
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
  NESTED_MODEL_COUNTS.set(normalized, relationCount);
  return normalized;
}

function normalizeActionModel(value, field, dimensions) {
  const source = assertPlainRecord(
    value,
    field,
    ACTION_MODEL_KEYS,
    ACTION_MODEL_KEYS.filter((key) => key !== 'modelAge'),
  );

  return {
    schemaVersion: requireSchemaVersion(source, field),
    sampleCount: assertNonNegativeInteger(source.sampleCount, `${field}.sampleCount`),
    meanDelta: assertFiniteVector(source.meanDelta, `${field}.meanDelta`, dimensions),
    uncertainty: assertNonNegativeFiniteNumber(
      source.uncertainty,
      `${field}.uncertainty`,
    ),
    ...(source.modelAge === undefined ? {} : {
      modelAge: assertNonNegativeInteger(source.modelAge, `${field}.modelAge`),
    }),
    ...(source.verificationAge === undefined
      ? {}
      : { verificationAge: source.verificationAge === null
          ? null
          : assertNonNegativeInteger(source.verificationAge, `${field}.verificationAge`) }),
  };
}

function validateModelAgeCoverage(
  modelClock,
  actionModels,
  relationModels,
  rejectionModels,
  beliefModels,
  contextModels,
  field,
) {
  if (modelClock === undefined) return;
  const check = (model, modelField) => {
    if (model.modelAge === undefined) {
      contractViolation('kernel model clock requires an age for every model', { field: modelField });
    }
    if (model.modelAge > modelClock) {
      contractViolation('kernel model age cannot exceed its model clock', { field: modelField });
    }
  };
  for (const [token, model] of Object.entries(actionModels)) check(model, `${field}.actionModels.${token}.modelAge`);
  for (const [token, model] of Object.entries(rejectionModels ?? {})) check(model, `${field}.rejectionModels.${token}.modelAge`);
  for (const [token, relations] of Object.entries(relationModels ?? {})) {
    for (const [relationKey, model] of Object.entries(relations)) check(model, `${field}.relationModels.${token}.${relationKey}.modelAge`);
  }
  for (const [token, contexts] of Object.entries(beliefModels ?? {})) {
    for (const [contextKey, model] of Object.entries(contexts)) check(model, `${field}.beliefModels.${token}.${contextKey}.modelAge`);
  }
  for (const [contextKey, models] of Object.entries(contextModels ?? {})) {
    for (const [token, model] of Object.entries(models)) check(model, `${field}.contextModels.${contextKey}.${token}.modelAge`);
  }
}

function updateActionModel(current, actualDelta, errorMagnitude, dimensions, field, modelAge) {
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
    ...(current.modelAge === undefined && modelAge === undefined
      ? {}
      : { modelAge: modelAge ?? current.modelAge }),
  };
}

function updateBeliefModel(current, actualDelta, dimensions, field, modelAge) {
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
    ...(current?.modelAge === undefined && modelAge === undefined
      ? {}
      : { modelAge: modelAge ?? current?.modelAge }),
  };
}

function updateRejectionModel(current, rejected, relationKey, field, modelAge) {
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
    ...(current?.modelAge === undefined && modelAge === undefined
      ? {}
      : { modelAge: modelAge ?? current?.modelAge }),
  };
}

function nextModelAge(memory, field) {
  if (memory.modelClock === undefined) return undefined;
  if (memory.modelClock === Number.MAX_SAFE_INTEGER) {
    contractViolation('kernel model clock cannot be incremented safely', { field });
  }
  memory.modelClock += 1;
  return memory.modelClock;
}

function modelAgeFor(memory, existing, field, refresh) {
  return refresh || existing === undefined
    ? nextModelAge(memory, field)
    : existing.modelAge;
}

function countRelationModels(value) {
  return cachedNestedModelCount(value, () => Object.values(value).reduce(
    (sum, relations) => sum + Object.keys(relations).length,
    0,
  ));
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
  refreshModelAge = false,
  contextProbe = false,
}) {
  let existing = memory.actionModels[token];
  let actionModelCount = existing === undefined ? cachedTopLevelModelCount(memory.actionModels) : null;
  if (existing === undefined && actionModelCount >= MAX_ACTION_MODELS) {
    const evictedToken = evictOldestTopLevelModel(memory.actionModels);
    if (evictedToken === undefined) {
      contractViolation('kernel learning has no evictable action model', {
        field: `${field}.actionModels`,
      });
    }
    actionModelCount -= 1;
    existing = memory.actionModels[token];
  }
  if (existing === undefined && actionModelCount >= MAX_ACTION_MODELS) {
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
      modelAgeFor(
        memory,
        memory.rejectionModels[token],
        `${field}.rejectionModels.${token}.modelAge`,
        refreshModelAge,
      ),
    );
  }
  memory.actionModels[token] = updateActionModel(
    existing ?? defaultActionModel(dimensions),
    actualDelta,
    errorMagnitude,
    dimensions,
    `${field}.actionModels.${token}`,
    modelAgeFor(
      memory,
      existing,
      `${field}.actionModels.${token}.modelAge`,
      refreshModelAge,
    ),
  );
  if (existing === undefined) {
    TOP_LEVEL_MODEL_COUNTS.set(memory.actionModels, actionModelCount + 1);
  }
  recordBeliefEvidence(memory, {
    token,
    relationKey,
    actualDelta,
    dimensions,
    field,
    refreshModelAge,
  });
  for (const contextKey of contextKeys ?? []) {
    recordContextEvidence(memory, {
      contextKey,
      token,
      actualDelta,
      errorMagnitude,
      dimensions,
      field,
      refreshModelAge,
    });
  }
  appendRecentHistory(memory, { token, actualDelta, historyOrder, dimensions, field });
  appendHistoryAccumulator(memory, { token, actualDelta, historyOrder, field });
  if (memory.lastVerifiedSteps !== undefined) {
    if (historyOrder === undefined) {
      contractViolation('kernel verification freshness requires an action order', { field });
    }
    memory.lastVerifiedSteps[token] = historyOrder;
  }
  if (contextProbe === true && memory.contextKeyScale !== undefined) {
    memory.lastProbeSteps = { ...(memory.lastProbeSteps ?? {}), [token]: historyOrder };
  }
  if (relationKey === undefined) return;

  let relationModels = memory.relationModels ?? {};
  let tokenRelations = { ...(relationModels[token] ?? {}) };
  let existingRelation = tokenRelations[relationKey];
  let relationModelCount = existingRelation === undefined ? countRelationModels(relationModels) : null;
  if (existingRelation === undefined && relationModelCount >= MAX_RELATION_MODELS) {
    const evicted = evictOldestNestedModel(relationModels);
    if (!evicted) {
      contractViolation('kernel learning has no evictable relation model', {
        field: `${field}.relationModels.${token}.${relationKey}`,
      });
    }
    relationModelCount -= 1;
    tokenRelations = { ...(relationModels[token] ?? {}) };
    existingRelation = tokenRelations[relationKey];
  }
  if (existingRelation === undefined && relationModelCount >= MAX_RELATION_MODELS) {
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
    modelAgeFor(
      memory,
      existingRelation,
      `${field}.relationModels.${token}.${relationKey}.modelAge`,
      refreshModelAge,
    ),
  );
  memory.relationModels = {
    ...relationModels,
    [token]: tokenRelations,
  };
  NESTED_MODEL_COUNTS.set(memory.relationModels, existingRelation === undefined
    ? relationModelCount + 1
    : countRelationModels(relationModels));
}

function recordContextEvidence(memory, {
  contextKey,
  token,
  actualDelta,
  errorMagnitude,
  dimensions,
  field,
  refreshModelAge = false,
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
    const evictedLongModelCount = Object.keys(contexts[evictableKey] ?? {}).length;
    delete contexts[evictableKey];
    const cachedContextModelCount = NESTED_MODEL_COUNTS.get(contexts);
    if (cachedContextModelCount !== undefined) {
      NESTED_MODEL_COUNTS.set(contexts, cachedContextModelCount - evictedLongModelCount);
    }
    models = { ...(contexts[contextKey] ?? {}) };
    existing = models[token];
  }
  let contextModelCount = existing === undefined ? countContextModels(contexts) : null;
  if (existing === undefined && contextModelCount >= MAX_CONTEXT_MODELS) {
    const evicted = evictOldestNestedModel(contexts);
    if (!evicted) {
      contractViolation('kernel learning has no evictable context model', {
        field: `${field}.contextModels.${contextKey}.${token}`,
      });
    }
    contextModelCount -= 1;
    models = { ...(contexts[contextKey] ?? {}) };
    existing = models[token];
  }
  models[token] = updateActionModel(
    existing ?? defaultActionModel(dimensions),
    actualDelta,
    errorMagnitude,
    dimensions,
    `${field}.contextModels.${contextKey}.${token}`,
    modelAgeFor(
      memory,
      existing,
      `${field}.contextModels.${contextKey}.${token}.modelAge`,
      refreshModelAge,
    ),
  );
  memory.contextModels = { ...contexts, [contextKey]: models };
  NESTED_MODEL_COUNTS.set(memory.contextModels, existing === undefined
    ? contextModelCount + 1
    : countContextModels(contexts));
}

function countContextModels(value) {
  return cachedNestedModelCount(value, () => Object.values(value).reduce(
    (sum, models) => sum + Object.keys(models).length,
    0,
  ));
}

function countLongContexts(value) {
  return Object.keys(value).filter((contextKey) => contextKey.startsWith('h2:')).length;
}

function oldestLongContextKey(value) {
  const entries = Object.entries(value).filter(([contextKey]) => contextKey.startsWith('h2:'));
  if (entries.length === 0) return undefined;
  if (entries.every(([, models]) => Object.values(models).every((model) => model.modelAge !== undefined))) {
    return entries.reduce((oldest, current) => {
      const oldestAge = Math.min(...Object.values(oldest[1]).map((model) => model.modelAge));
      const currentAge = Math.min(...Object.values(current[1]).map((model) => model.modelAge));
      return currentAge < oldestAge || (currentAge === oldestAge && current[0] < oldest[0]) ? current : oldest;
    })[0];
  }
  return entries[0][0];
}

function evictOldestNestedModel(value) {
  const candidates = [];
  for (const [outerKey, models] of Object.entries(value)) {
    for (const [innerKey, model] of Object.entries(models)) {
      candidates.push({ outerKey, innerKey, model });
    }
  }
  if (candidates.length === 0) return false;
  const allHaveAge = candidates.every((candidate) => candidate.model.modelAge !== undefined);
  const oldest = allHaveAge
    ? candidates.reduce((current, candidate) => {
        const currentIdentity = `${current.outerKey}\u0000${current.innerKey}`;
        const candidateIdentity = `${candidate.outerKey}\u0000${candidate.innerKey}`;
        return candidate.model.modelAge < current.model.modelAge ||
          (candidate.model.modelAge === current.model.modelAge && candidateIdentity < currentIdentity)
          ? candidate
          : current;
      })
    : candidates[0];
  const currentModels = value[oldest.outerKey];
  delete currentModels[oldest.innerKey];
  if (Object.keys(currentModels).length === 0) delete value[oldest.outerKey];
  return true;
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
  refreshModelAge = false,
}) {
  if (memory.beliefModels === undefined) return;
  const contextKey = relationKey ?? OVERALL_BELIEF_CONTEXT;
  let beliefs = memory.beliefModels;
  let tokenBeliefs = { ...(beliefs[token] ?? {}) };
  let existing = tokenBeliefs[contextKey];
  let beliefModelCount = existing === undefined ? countBeliefModels(beliefs) : null;
  if (existing === undefined && beliefModelCount >= MAX_BELIEF_MODELS) {
    const evicted = evictOldestNestedModel(beliefs);
    if (!evicted) {
      contractViolation('kernel learning has no evictable belief model', {
        field: `${field}.beliefModels.${token}.${contextKey}`,
      });
    }
    beliefModelCount -= 1;
    tokenBeliefs = { ...(beliefs[token] ?? {}) };
    existing = tokenBeliefs[contextKey];
  }
  if (existing === undefined && beliefModelCount >= MAX_BELIEF_MODELS) {
    contractViolation('kernel learning would exceed the belief-model limit', {
      field: `${field}.beliefModels.${token}.${contextKey}`,
    });
  }
  tokenBeliefs[contextKey] = updateBeliefModel(
    existing,
    actualDelta,
    dimensions,
    `${field}.beliefModels.${token}.${contextKey}`,
    modelAgeFor(
      memory,
      existing,
      `${field}.beliefModels.${token}.${contextKey}.modelAge`,
      refreshModelAge,
    ),
  );
  memory.beliefModels = { ...beliefs, [token]: tokenBeliefs };
  NESTED_MODEL_COUNTS.set(memory.beliefModels, existing === undefined
    ? beliefModelCount + 1
    : countBeliefModels(beliefs));
}

function countBeliefModels(value) {
  return cachedNestedModelCount(value, () => Object.values(value).reduce(
    (sum, contexts) => sum + Object.keys(contexts).length,
    0,
  ));
}

function cachedTopLevelModelCount(value) {
  const cached = TOP_LEVEL_MODEL_COUNTS.get(value);
  if (cached !== undefined) return cached;
  const count = Object.keys(value).length;
  TOP_LEVEL_MODEL_COUNTS.set(value, count);
  return count;
}

function evictOldestTopLevelModel(value) {
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  const allHaveAge = entries.every(([, model]) => model.modelAge !== undefined);
  const oldestKey = allHaveAge
    ? entries.reduce((current, candidate) => {
        const [currentKey, currentModel] = current;
        const [candidateKey, candidateModel] = candidate;
        return candidateModel.modelAge < currentModel.modelAge ||
          (candidateModel.modelAge === currentModel.modelAge && candidateKey < currentKey)
          ? candidate
          : current;
      })[0]
    : entries[0][0];
  if (oldestKey === undefined) return undefined;
  delete value[oldestKey];
  const cached = TOP_LEVEL_MODEL_COUNTS.get(value);
  if (cached !== undefined) TOP_LEVEL_MODEL_COUNTS.set(value, cached - 1);
  return oldestKey;
}

function cachedNestedModelCount(value, compute) {
  const cached = NESTED_MODEL_COUNTS.get(value);
  if (cached !== undefined) return cached;
  const count = compute();
  NESTED_MODEL_COUNTS.set(value, count);
  return count;
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
  const source = assertPlainRecord(
    value,
    field,
    EXPECTATION_KEYS,
    EXPECTATION_KEYS.filter((key) => key !== 'relationKey' && key !== 'verificationAge'),
  );
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
  const source = assertPlainRecord(value, field, CHOICE_KEYS, CHOICE_REQUIRED_KEYS);

  return {
    schemaVersion: requireSchemaVersion(source, field),
    token: assertOpaqueToken(source.token, `${field}.token`),
    score: assertFiniteNumber(source.score, `${field}.score`),
    expectedValue: assertFiniteNumber(source.expectedValue, `${field}.expectedValue`),
    cost: assertNonNegativeFiniteNumber(source.cost, `${field}.cost`),
    allowed: assertBoolean(source.allowed, `${field}.allowed`),
    safe: assertBoolean(source.safe, `${field}.safe`),
    ...(source.contextProbe === undefined ? {} : { contextProbe: assertBoolean(source.contextProbe, `${field}.contextProbe`) }),
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
  // 读取始终使用窗口 h2 基：旧记忆的累加器 h2 模型本就永不可读，行为无差异；
  // h0 键只在其模型存在时才会命中，旧账本记忆不含 h0 模型，同样无差异。
  const contextKeys = contextKeysForMemory(input.memory, {
    includeShortContext: true,
    longContextWindow: true,
  });
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
    const contextModel = contextKeys
      ?.map((contextKey) => input.memory.contextModels?.[contextKey]?.[capability.token])
      .find((candidate) => candidate !== undefined);
    const contextResolved = contextModel !== undefined;
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
    const verificationAge = verificationAgeFor(input.memory, capability.token);

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
        ...(verificationAge === undefined ? {} : { verificationAge }),
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
      contextResolved,
      contextModelAge: contextModel?.modelAge,
    };
  });
}

function verificationAgeFor(memory, token) {
  if (memory.lastVerifiedSteps === undefined) return undefined;
  const lastVerifiedStep = memory.lastVerifiedSteps[token];
  return lastVerifiedStep === undefined ? null : memory.historyClock - lastVerifiedStep;
}

function revalidationCandidatePool(predictions, memory) {
  if (memory.lastVerifiedSteps === undefined || memory.historyClock === undefined) return [];
  const overdue = predictions.filter((prediction) =>
    prediction.expectation.verificationAge !== null &&
    prediction.expectation.verificationAge !== undefined &&
    prediction.expectation.verificationAge >= REVALIDATION_INTERVAL,
  );
  if (overdue.length === 0) return [];
  const oldestAge = Math.max(...overdue.map((prediction) => prediction.expectation.verificationAge));
  return overdue.filter((prediction) => prediction.expectation.verificationAge === oldestAge);
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
  return chooseByUncertainty(strategyCandidatePool(predictions, strategy), unit);
}

function strategyCandidatePool(predictions, strategy) {
  if (strategy.mode !== 'EXPLORATORY' || strategy.explorationMode !== 'coverage-v1') {
    return predictions;
  }
  const leastSampleCount = Math.min(...predictions.map((prediction) => prediction.expectation.sampleCount));
  return predictions.filter((prediction) => prediction.expectation.sampleCount === leastSampleCount);
}

function chooseByUncertainty(predictions, unit) {
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
// branches on bounded outcomes at every recursively evaluated action. The
// current information rule also requires those branches to produce different
// value-relevant next effects; raw variance or an irrelevant-coordinate change
// is not evidence that the observation can change what the agent should do.
// This does not claim a hidden-state model or move speculative state across the
// WorldPort safety boundary.
function chooseByPlanning(predictions, input, unit) {
  const candidatePool = boundedPlanningPredictions(
    strategyCandidatePool(predictions, input.strategy),
  );
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
  if (input.planning.branchingMode === 'tree-v1') {
    return rolloutUtilityTree(firstPrediction, input, horizon, unit);
  }
  if (input.planning.branchingMode === 'recursive-v1') {
    return rolloutUtilityRecursive(firstPrediction, input, horizon, unit);
  }
  return rolloutUtilityStatic(firstPrediction, input, horizon, unit);
}

function rolloutUtilityStatic(firstPrediction, input, horizon, unit) {
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
    let planningMemory = input.memory;
    if (input.planning.contextMode !== 'legacy-v1' && horizon > 1) {
      planningMemory = planningMemoryAfterAction(
        input.memory,
        firstPrediction.choice.token,
        subtractVectors(
          outcomeVector,
          input.observation.vector,
          'stepOutput.planning.firstActionDelta',
        ),
        input.observation.vector.length,
      );
    }
    let totalCost = firstPrediction.choice.cost + firstUncertaintyCost;
    let nextUncertainty = firstPrediction.expectation.uncertainty;
    for (let depth = 1; depth < horizon; depth += 1) {
      const futurePredictions = buildPredictions({
        ...input,
        memory: planningMemory,
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
      if (input.planning.contextMode !== 'legacy-v1') {
        planningMemory = planningMemoryAfterAction(
          planningMemory,
          future.choice.token,
          future.expectation.expectedDelta,
          input.observation.vector.length,
        );
      }
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

  if (outcomes.sampled && input.planning.informationMode === 'belief-v3' &&
      hasValueRelevantNextDecisions(nextDecisions, input.valueSpec)) {
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

function rolloutUtilityTree(firstPrediction, input, horizon, unit) {
  return rolloutUtilityBranching(firstPrediction, input, horizon, unit, 'tree');
}

function rolloutUtilityRecursive(firstPrediction, input, horizon, unit) {
  return rolloutUtilityBranching(firstPrediction, input, horizon, unit, 'greedy');
}

function rolloutUtilityBranching(firstPrediction, input, horizon, unit, searchMode) {
  const firstUncertaintyCost = uncertaintyPenalty(
    firstPrediction.expectation.uncertainty,
    input.valueSpec.weights,
  );
  const outcomes = predictionOutcomeVectors(
    firstPrediction,
    input,
    input.planning.informationMode !== 'legacy-v1',
  );
  const outcomeVectors = boundedPlanningOutcomeVectors(
    outcomes.vectors,
    MAX_PLANNING_ROLLOUTS,
  );
  let expectedUtility = 0;
  const nextDecisions = [];
  const nextUncertainties = [];

  for (const outcomeVector of outcomeVectors) {
    let planningMemory = input.memory;
    if (input.planning.contextMode !== 'legacy-v1' && horizon > 1) {
      planningMemory = planningMemoryAfterAction(
        input.memory,
        firstPrediction.choice.token,
        subtractVectors(
          outcomeVector,
          input.observation.vector,
          'stepOutput.planning.firstActionDelta',
        ),
        input.observation.vector.length,
      );
    }
    const rollout = rolloutFutureUtility({
      input,
      predictedVector: outcomeVector,
      planningMemory,
      depth: 1,
      horizon,
      totalCost: firstPrediction.choice.cost + firstUncertaintyCost,
      unit,
      budget: MAX_PLANNING_ROLLOUTS,
      searchMode,
    });
    expectedUtility += rollout.utility / outcomeVectors.length;
    if (rollout.firstDecision !== null) {
      nextDecisions.push(rollout.firstDecision);
      nextUncertainties.push(rollout.firstUncertainty);
    }
  }

  if (outcomes.sampled && input.planning.informationMode === 'belief-v1' &&
      nextUncertainties.length > 0) {
    expectedUtility += uncertaintyReduction(
      firstPrediction.expectation.uncertainty,
      nextUncertainties.reduce((total, value) => total + value, 0) / nextUncertainties.length,
      input.valueSpec.weights,
    );
  }

  if (outcomes.sampled && input.planning.informationMode === 'belief-v2' &&
      hasDiverseNextDecisions(nextDecisions)) {
    expectedUtility += uncertaintyReduction(
      firstPrediction.expectation.uncertainty,
      nextUncertainties.reduce((total, value) => total + value, 0) / nextUncertainties.length,
      input.valueSpec.weights,
    );
  }

  if (outcomes.sampled && input.planning.informationMode === 'belief-v3' &&
      hasValueRelevantNextDecisions(nextDecisions, input.valueSpec)) {
    expectedUtility += uncertaintyReduction(
      firstPrediction.expectation.uncertainty,
      nextUncertainties.reduce((total, value) => total + value, 0) / nextUncertainties.length,
      input.valueSpec.weights,
    );
  }

  return assertComputedFiniteNumber(expectedUtility, 'stepOutput.planning.utility');
}

function rolloutFutureUtility({ input, predictedVector, planningMemory, depth, horizon, totalCost, unit, budget, searchMode = 'greedy' }) {
  if (depth >= horizon) {
    return {
      utility: valueObservation(predictedVector, input.valueSpec) - totalCost,
      firstDecision: null,
      firstUncertainty: null,
    };
  }
  if (searchMode === 'tree' && budget <= 1) {
    return {
      utility: valueObservation(predictedVector, input.valueSpec) - totalCost,
      firstDecision: null,
      firstUncertainty: null,
    };
  }

  const futureInput = {
    ...input,
    memory: planningMemory,
    observation: {
      ...input.observation,
      vector: predictedVector,
    },
  };
  const futurePredictions = buildPredictions(futureInput).filter(
    (item) => item.choice.allowed && item.choice.safe,
  );
  if (futurePredictions.length === 0) {
    return {
      utility: valueObservation(predictedVector, input.valueSpec) - totalCost,
      firstDecision: null,
      firstUncertainty: null,
    };
  }

  const futurePool = boundedPlanningPredictions(selectionPoolFor(futurePredictions));
  if (searchMode === 'greedy') {
    const future = chooseByStrategy(futurePool, input.strategy, unit);
    const rollout = rolloutActionTree({
      input,
      predictedVector,
      planningMemory,
      depth,
      horizon,
      totalCost,
      unit,
      budget,
      prediction: future,
      index: 0,
      searchMode,
    });
    return {
      utility: rollout.utility,
      firstDecision: future,
      firstUncertainty: future.expectation.uncertainty,
    };
  }
  const actionBudget = Math.max(1, Math.floor(budget / futurePool.length));
  const evaluated = futurePool.map((future, index) => rolloutActionTree({
    input,
    predictedVector,
    planningMemory,
    depth,
    horizon,
    totalCost,
    unit,
    budget: actionBudget,
    prediction: future,
    index,
    searchMode,
  }));
  let bestUtility = -Infinity;
  const bestIndexes = [];
  evaluated.forEach((result, index) => {
    if (result.utility > bestUtility) {
      bestUtility = result.utility;
      bestIndexes.length = 0;
      bestIndexes.push(index);
    } else if (Object.is(result.utility, bestUtility)) {
      bestIndexes.push(index);
    }
  });
  const selected = evaluated[bestIndexes[Math.floor(unit * bestIndexes.length)]];
  return {
    utility: selected.utility,
    firstDecision: futurePool[selected.index],
    firstUncertainty: futurePool[selected.index].expectation.uncertainty,
  };
}

function rolloutActionTree({ input, predictedVector, planningMemory, depth, horizon, totalCost, unit, budget, prediction, index, searchMode }) {
  const outcomes = predictionOutcomeVectors(
    prediction,
    {
      ...input,
      memory: planningMemory,
      observation: {
        ...input.observation,
        vector: predictedVector,
      },
    },
    input.planning.informationMode !== 'legacy-v1',
  );
  const outcomeVectors = boundedPlanningOutcomeVectors(outcomes.vectors, budget);
  const childBudget = searchMode === 'tree'
    ? Math.max(1, Math.floor(budget / outcomeVectors.length / 2))
    : Math.max(1, Math.floor(budget / outcomeVectors.length));
  let expectedUtility = 0;

  for (const outcomeVector of outcomeVectors) {
    let nextMemory = planningMemory;
    if (input.planning.contextMode !== 'legacy-v1') {
      nextMemory = planningMemoryAfterAction(
        planningMemory,
        prediction.choice.token,
        subtractVectors(
          outcomeVector,
          predictedVector,
          'stepOutput.planning.futureActionDelta',
        ),
        input.observation.vector.length,
      );
    }
    expectedUtility += rolloutFutureUtility({
      input,
      predictedVector: outcomeVector,
      planningMemory: nextMemory,
      depth: depth + 1,
      horizon,
      totalCost: totalCost + prediction.choice.cost +
        uncertaintyPenalty(prediction.expectation.uncertainty, input.valueSpec.weights),
      unit,
      budget: childBudget,
      searchMode,
    }).utility / outcomeVectors.length;
  }

  return {
    index,
    utility: expectedUtility,
  };
}

function boundedPlanningOutcomeVectors(vectors, limit) {
  if (vectors.length <= limit) return vectors;
  return Array.from({ length: limit }, (_, index) =>
    vectors[Math.floor(index * vectors.length / limit)],
  );
}

function planningMemoryAfterAction(memory, token, actualDelta, dimensions) {
  const projected = cloneMemory(memory);
  const historyOrder = nextHistoryOrder(projected);
  appendRecentHistory(projected, {
    token,
    actualDelta,
    historyOrder,
    dimensions,
    field: 'stepOutput.planning.history',
  });
  appendHistoryAccumulator(projected, {
    token,
    actualDelta,
    historyOrder,
    field: 'stepOutput.planning.history',
  });
  return projected;
}

function hasDiverseNextDecisions(decisions) {
  if (decisions.length < 2) return false;
  const signatures = new Set(decisions.map((decision) => canonicalDigest({
    token: decision.expectation.token,
    expectedDelta: decision.expectation.expectedDelta,
  })));
  return signatures.size > 1;
}

function hasValueRelevantNextDecisions(decisions, valueSpec) {
  if (decisions.length < 2) return false;
  const signatures = new Set(decisions.map((decision) => canonicalDigest(
    decision.expectation.expectedDelta.map((delta, index) => delta * (
      valueSpec.valueMode === 'distance-v2'
        ? Math.abs(valueSpec.weights[index])
        : valueSpec.weights[index]
    )),
  )));
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

function compactModelAgeState(value) {
  const actionModels = compactTopLevelModelAges(value.actionModels);
  const relationModels = compactNestedModelAges(value.relationModels);
  const rejectionModels = compactTopLevelModelAges(value.rejectionModels);
  const beliefModels = compactNestedModelAges(value.beliefModels);
  const contextModels = compactNestedModelAges(value.contextModels);
  const states = [actionModels, relationModels, rejectionModels, beliefModels, contextModels];
  if (states.some((state) => state === null)) return undefined;
  if (value.modelClock === undefined && states.every((state) => state === undefined)) return undefined;
  return {
    schemaVersion: SCHEMA_VERSION,
    ...(actionModels === undefined ? {} : { actionModels }),
    ...(relationModels === undefined ? {} : { relationModels }),
    ...(rejectionModels === undefined ? {} : { rejectionModels }),
    ...(beliefModels === undefined ? {} : { beliefModels }),
    ...(contextModels === undefined ? {} : { contextModels }),
  };
}

function compactTopLevelModelAges(models) {
  if (models === undefined) return undefined;
  const keys = Object.keys(models).sort();
  if (keys.length === 0) return undefined;
  if (keys.some((key) => models[key].modelAge === undefined)) return null;
  return keys.map((key) => models[key].modelAge.toString(36)).join(',');
}

function compactNestedModelAges(models) {
  if (models === undefined) return undefined;
  const outerKeys = Object.keys(models).sort();
  if (outerKeys.length === 0) return undefined;
  const result = [];
  for (const outerKey of outerKeys) {
    const innerKeys = Object.keys(models[outerKey]).sort();
    if (innerKeys.some((innerKey) => models[outerKey][innerKey].modelAge === undefined)) return null;
    result.push(innerKeys.map((innerKey) => models[outerKey][innerKey].modelAge.toString(36)).join(','));
  }
  return result;
}

function cloneMemory(
  value,
  { compactAges = true, enforcePersistedBudget = compactAges, retentionMode = 'recency-v1' } = {},
) {
  const actionModels = {};
  for (const [token, model] of Object.entries(value.actionModels)) {
    actionModels[token] = {
      schemaVersion: SCHEMA_VERSION,
      sampleCount: model.sampleCount,
      meanDelta: cloneVector(model.meanDelta),
      uncertainty: model.uncertainty,
      ...(model.modelAge === undefined ? {} : { modelAge: model.modelAge }),
    };
  }
  const cloned = {
    schemaVersion: SCHEMA_VERSION,
    actionModels,
  };
  TOP_LEVEL_MODEL_COUNTS.set(cloned.actionModels, Object.keys(actionModels).length);
  if (value.modelClock !== undefined) cloned.modelClock = value.modelClock;
  if (value.contextKeyScale !== undefined) cloned.contextKeyScale = value.contextKeyScale;
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
          ...(model.modelAge === undefined ? {} : { modelAge: model.modelAge }),
        }])),
      ]),
    );
    NESTED_MODEL_COUNTS.set(cloned.relationModels, countRelationModels(value.relationModels));
  }
  if (value.rejectionModels !== undefined) {
    cloned.rejectionModels = Object.fromEntries(
      Object.entries(value.rejectionModels).map(([token, model]) => [token, {
        schemaVersion: SCHEMA_VERSION,
        sampleCount: model.sampleCount,
        rejected: model.rejected,
        ...(model.relationKey === undefined ? {} : { relationKey: model.relationKey }),
        ...(model.modelAge === undefined ? {} : { modelAge: model.modelAge }),
      }]),
    );
    TOP_LEVEL_MODEL_COUNTS.set(cloned.rejectionModels, Object.keys(value.rejectionModels).length);
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
          ...(model.modelAge === undefined ? {} : { modelAge: model.modelAge }),
        }])),
      ]),
    );
    NESTED_MODEL_COUNTS.set(cloned.beliefModels, countBeliefModels(value.beliefModels));
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
          ...(model.modelAge === undefined ? {} : { modelAge: model.modelAge }),
        }])),
      ]),
    );
    NESTED_MODEL_COUNTS.set(cloned.contextModels, countContextModels(value.contextModels));
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
  if (value.lastVerifiedSteps !== undefined) cloned.lastVerifiedSteps = { ...value.lastVerifiedSteps };
  if (value.lastProbeSteps !== undefined) cloned.lastProbeSteps = { ...value.lastProbeSteps };
  pruneOrphanedVerificationSteps(cloned);
  if (compactAges) {
    if (enforcePersistedBudget) {
      compactPersistedMemory(cloned, { retentionMode });
    } else {
      const compactModelAges = compactModelAgeState(cloned);
      if (compactModelAges !== undefined && compactModelAges !== null) {
        stripModelAges(cloned);
        cloned.modelAges = compactModelAges;
      }
    }
  }
  return cloned;
}

function compactPersistedMemory(memory, { retentionMode = 'recency-v1' } = {}) {
  const candidates = persistedModelCandidates(memory, { retentionMode });
  const ageByIdentity = new Map(candidates.map((candidate) => [candidate.identity, candidate.age]));
  const compactModelAges = compactModelAgeState(memory);
  const canCompactAges = compactModelAges !== undefined && compactModelAges !== null;
  if (canCompactAges) {
    stripModelAges(memory);
    memory.modelAges = compactModelAges;
  }
  let persistedBytes = Buffer.byteLength(canonicalJson(memory), 'utf8');
  while (persistedBytes > MAX_PERSISTED_MEMORY_BYTES && candidates.length > 0) {
    for (let index = 0; index < PERSISTED_MEMORY_TRIM_BATCH && candidates.length > 0; index += 1) {
      const candidate = candidates.shift();
      delete candidate.parent[candidate.key];
      if (candidate.outerParent !== undefined && Object.keys(candidate.parent).length === 0) {
        delete candidate.outerParent[candidate.outerKey];
      }
    }
    if (canCompactAges) {
      const nextModelAges = compactPersistedModelAges(memory, ageByIdentity);
      if (nextModelAges === undefined) delete memory.modelAges;
      else memory.modelAges = nextModelAges;
    }
    persistedBytes = Buffer.byteLength(canonicalJson(memory), 'utf8');
  }
  pruneOrphanedVerificationSteps(memory);
}

function compactPersistedModelAges(memory, ageByIdentity) {
  const topLevel = (family, models) => {
    const keys = Object.keys(models ?? {}).sort();
    if (keys.length === 0) return undefined;
    const ages = keys.map((key) => ageByIdentity.get(`${family}:${key}`));
    return ages.some((age) => age === undefined)
      ? null
      : ages.map((age) => age.toString(36)).join(',');
  };
  const nested = (family, models) => {
    const outerKeys = Object.keys(models ?? {}).sort();
    if (outerKeys.length === 0) return undefined;
    const result = [];
    for (const outerKey of outerKeys) {
      const innerKeys = Object.keys(models[outerKey]).sort();
      const ages = innerKeys.map((innerKey) => ageByIdentity.get(`${family}:${outerKey}:${innerKey}`));
      if (ages.some((age) => age === undefined)) return null;
      result.push(ages.map((age) => age.toString(36)).join(','));
    }
    return result;
  };
  const states = {
    actionModels: topLevel('action', memory.actionModels),
    relationModels: nested('relation', memory.relationModels),
    rejectionModels: topLevel('rejection', memory.rejectionModels),
    beliefModels: nested('belief', memory.beliefModels),
    contextModels: nested('context', memory.contextModels),
  };
  if (Object.values(states).some((state) => state === null)) return undefined;
  if (memory.modelClock === undefined && Object.values(states).every((state) => state === undefined)) return undefined;
  return {
    schemaVersion: SCHEMA_VERSION,
    ...Object.fromEntries(Object.entries(states).filter(([, state]) => state !== undefined)),
  };
}

function persistedModelCandidates(memory, { retentionMode = 'recency-v1' } = {}) {
  const candidates = [];
  const addTopLevel = (family, models) => {
    for (const [token, model] of Object.entries(models ?? {})) {
      candidates.push({
        family,
        parent: models,
        key: token,
        age: model.modelAge,
        model,
        identity: `${family}:${token}`,
      });
    }
  };
  const addNested = (family, models) => {
    for (const [outerKey, nested] of Object.entries(models ?? {})) {
      for (const [innerKey, model] of Object.entries(nested)) {
        candidates.push({
          family,
          parent: nested,
          key: innerKey,
          outerParent: models,
          outerKey,
          age: model.modelAge,
          model,
          identity: `${family}:${outerKey}:${innerKey}`,
        });
      }
    }
  };

  addTopLevel('action', memory.actionModels);
  addTopLevel('rejection', memory.rejectionModels);
  addNested('relation', memory.relationModels);
  addNested('belief', memory.beliefModels);
  addNested('context', memory.contextModels);
  if (!candidates.every((candidate) => candidate.age !== undefined)) return candidates;
  if (retentionMode === 'pareto-v1') {
    markDominatedPredictionModels(candidates);
  }
  return candidates.sort((left, right) => {
    return Number(right.dominated === true) - Number(left.dominated === true) ||
      left.age - right.age || left.identity.localeCompare(right.identity);
  });
}

function markDominatedPredictionModels(candidates) {
  const comparable = candidates.filter(isComparablePredictionModel);
  const familyGroups = new Map();
  for (const candidate of comparable) {
    const uncertainty = candidate.model.uncertainty;
    const groups = familyGroups.get(candidate.family) ?? new Map();
    const group = groups.get(uncertainty) ?? { maxSampleCount: 0, lowerMaxSampleCount: -1 };
    group.maxSampleCount = Math.max(group.maxSampleCount, candidate.model.sampleCount);
    groups.set(uncertainty, group);
    familyGroups.set(candidate.family, groups);
  }
  for (const groups of familyGroups.values()) {
    let lowerMaxSampleCount = -1;
    for (const uncertainty of [...groups.keys()].sort((left, right) => left - right)) {
      const group = groups.get(uncertainty);
      group.lowerMaxSampleCount = lowerMaxSampleCount;
      lowerMaxSampleCount = Math.max(lowerMaxSampleCount, group.maxSampleCount);
    }
  }
  for (const candidate of comparable) {
    const group = familyGroups.get(candidate.family).get(candidate.model.uncertainty);
    candidate.dominated = group.lowerMaxSampleCount >= candidate.model.sampleCount ||
      group.maxSampleCount > candidate.model.sampleCount;
  }
}

function isComparablePredictionModel(candidate) {
  return ['action', 'relation', 'context'].includes(candidate.family) &&
    Number.isSafeInteger(candidate.model.sampleCount) &&
    Number.isFinite(candidate.model.uncertainty);
}

function stripModelAges(memory) {
  const stripTopLevel = (models) => {
    for (const model of Object.values(models ?? {})) delete model.modelAge;
  };
  const stripNested = (models) => {
    for (const nested of Object.values(models ?? {})) stripTopLevel(nested);
  };

  stripTopLevel(memory.actionModels);
  stripTopLevel(memory.rejectionModels);
  stripNested(memory.relationModels);
  stripNested(memory.beliefModels);
  stripNested(memory.contextModels);
}

function pruneOrphanedVerificationSteps(memory) {
  if (memory.lastVerifiedSteps !== undefined) {
    for (const token of Object.keys(memory.lastVerifiedSteps)) {
      if (!hasReusableModelEvidence(memory, token)) delete memory.lastVerifiedSteps[token];
    }
  }
  if (memory.lastProbeSteps !== undefined) {
    for (const token of Object.keys(memory.lastProbeSteps)) {
      if (!hasReusableModelEvidence(memory, token)) delete memory.lastProbeSteps[token];
    }
  }
}

function hasReusableModelEvidence(memory, token) {
  return Object.hasOwn(memory.actionModels, token) ||
    Object.keys(memory.relationModels?.[token] ?? {}).length > 0 ||
    Object.keys(memory.beliefModels?.[token] ?? {}).length > 0 ||
    Object.values(memory.contextModels ?? {}).some((models) => Object.hasOwn(models, token));
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
    ...(value.verificationAge === undefined ? {} : { verificationAge: value.verificationAge }),
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
    ...(value.contextProbe === undefined ? {} : { contextProbe: value.contextProbe }),
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

function assertLearningVersion(value, field) {
  const version = assertPositiveInteger(value, field);
  if (version > CURRENT_LEARNING_VERSION) {
    contractViolation('kernel learning version is newer than this kernel', {
      field,
      actual: version,
      maxSupported: CURRENT_LEARNING_VERSION,
    });
  }
  return version;
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

function contextKeysForMemory(memory, {
  includeShortContext = false,
  longContextWindow = false,
} = {}) {
  const keys = [];
  if (longContextWindow) {
    const longKey = longContextKeyForHistory(memory.recentHistory, memory.contextKeyScale);
    if (longKey !== undefined && !keys.includes(longKey)) keys.push(longKey);
  } else if (memory.historyAccumulator !== undefined) {
    keys.push(`h2:${canonicalDigest({ historyAccumulator: memory.historyAccumulator })}`);
  }
  const scale = memory.contextKeyScale;
  const recentKey = contextKeyForHistory(memory.recentHistory, scale);
  if (recentKey !== undefined && !keys.includes(recentKey)) keys.push(recentKey);
  if (includeShortContext) {
    const shortKey = shortContextKeyForHistory(memory.recentHistory, scale);
    if (shortKey !== undefined && !keys.includes(shortKey)) keys.push(shortKey);
  }
  return keys.length === 0 ? undefined : keys;
}

// 窗口-8 长上下文键：周期 < 8 的轨道每个相位拥有唯一的窗口摘要，可表达
// 窗口-1/2 无法区分的碰撞相位。它取代按构造永不复现的累加器键成为 h2 的
// 读取与写入基础；累加器字段本身仍按原样维护，仅作审计。
function longContextKeyForHistory(history, contextKeyScale = undefined) {
  const ordered = orderedHistory(history ?? []);
  if (ordered.length === 0) return undefined;
  return `h2:${canonicalDigest(ordered.slice(-LONG_CONTEXT_KEY_WINDOW).map((entry) => ({
    token: entry.token,
    actualDelta: canonicalContextDelta(entry.actualDelta, contextKeyScale),
  })))}`;
}

function contextKeyForHistory(history, contextKeyScale = undefined) {
  if (history === undefined) return undefined;
  // 空历史保持历史怪癖：键为 digest([]) 而非 undefined，旧账本首个 STEP 依赖该形状。
  const ordered = orderedHistory(history).slice(-H1_CONTEXT_WINDOW);
  return `h1:${canonicalDigest(ordered.map((entry) => ({
    token: entry.token,
    actualDelta: canonicalContextDelta(entry.actualDelta, contextKeyScale),
  })))}`;
}

// 窗口-1 上下文：相位类周期里最近一条已验证变化就足以区分状态，
// 更粗的键在上下文碎片化时比窗口-2 键更早积累出可复用样本。
function shortContextKeyForHistory(history, contextKeyScale = undefined) {
  const ordered = orderedHistory(history ?? []);
  if (ordered.length === 0) return undefined;
  const last = ordered.at(-1);
  return `h0:${canonicalDigest([{ token: last.token, actualDelta: canonicalContextDelta(last.actualDelta, contextKeyScale) }])}`;
}

function canonicalContextDelta(vector, contextKeyScale) {
  if (contextKeyScale === undefined) return vector;
  const factor = 10 ** contextKeyScale;
  return vector.map((component) => {
    if (!Number.isFinite(component)) return component;
    return Math.round(component * factor) / factor;
  });
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
  if (!/^h[012]:sha256:[0-9a-f]{64}$/u.test(bounded)) {
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

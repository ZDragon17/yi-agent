const SCHEMA_VERSION = 1;
const MAX_GOAL_LENGTH = 4096;
const MAX_DIMENSIONS = 1024;
const MAX_CYCLES = 1_000_000;
const MAX_STAGNATION = 100_000;
const MAX_STAGES = 128;
const OBJECTIVE_KEYS = [
  'schemaVersion',
  'observationDimensions',
  'weights',
  'target',
  'tolerance',
];
const OBSERVATION_KEYS = ['schemaVersion', 'stateVersion', 'intervalId', 'vector'];
const VERIFICATION_KEYS = [
  'schemaVersion',
  'error',
  'attribution',
  'confidence',
  'learnable',
];
const STATE_KEYS = [
  'schemaVersion',
  'status',
  'enabled',
  'goal',
  'plan',
  'objective',
  'maxCycles',
  'stagnationLimit',
  'cycle',
  'bestDistance',
  'stagnation',
  'replanCount',
  'strategy',
  'lastChange',
];
const LAST_CHANGE_KEYS = [
  'schemaVersion',
  'beforeStateVersion',
  'afterStateVersion',
  'beforeDistance',
  'afterDistance',
  'progress',
  'evidence',
  'confirmed',
  'improved',
  'decision',
  'stopReason',
  'replanReason',
];
const STRATEGY_KEYS = ['schemaVersion', 'mode', 'revision', 'reason'];
const STRATEGY_MODES = ['BALANCED', 'EXPLORATORY'];
const PLAN_KEYS = ['schemaVersion', 'rootGoal', 'revision', 'activeStageId', 'stages'];
const STAGE_KEYS = ['schemaVersion', 'id', 'goal', 'objective', 'status', 'attempts'];
const STAGE_STATUSES = ['PENDING', 'ACTIVE', 'COMPLETED'];

const STATUS_DECISIONS = Object.freeze({
  ACTIVE: 'CONTINUE',
  REPLAN_REQUIRED: 'REPLAN',
  COMPLETED: 'STOP',
  HALTED: 'STOP',
});

export function createChangeSupervisor({
  goal,
  enabled = true,
  plan,
  valueSpec,
  maxCycles = 100,
  stagnationLimit = 3,
  tolerance,
} = {}) {
  const normalizedGoal = requireGoal(goal);
  const objective = normalizeObjective(valueSpec, tolerance);
  const normalizedMaxCycles = requireBoundedInteger(maxCycles, 1, MAX_CYCLES, 'maxCycles');
  const normalizedStagnationLimit = requireBoundedInteger(
    stagnationLimit,
    1,
    MAX_STAGNATION,
    'stagnationLimit',
  );
  const normalizedPlan = createPlan(plan, normalizedGoal, objective, hasPlanProgress(plan));

  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'ACTIVE',
    enabled: requireBoolean(enabled, 'enabled'),
    goal: normalizedGoal,
    objective: normalizedPlan.stages[0].objective,
    plan: normalizedPlan,
    maxCycles: normalizedMaxCycles,
    stagnationLimit: normalizedStagnationLimit,
    cycle: 0,
    bestDistance: null,
    stagnation: 0,
    replanCount: 0,
    strategy: createStrategy(),
    lastChange: null,
  };
}

export function advanceChangeSupervisor(state, {
  beforeObservation,
  postObservation,
  verification,
} = {}) {
  const current = normalizeState(state);
  if (current.status !== 'ACTIVE') {
    throw new Error('ChangeSupervisor can advance only while ACTIVE.');
  }
  const before = normalizeObservation(beforeObservation, 'beforeObservation', current.objective.target.length);
  const after = normalizeObservation(postObservation, 'postObservation', current.objective.target.length);
  const evidence = normalizeVerification(
    verification,
    current.objective.target.length,
  );
  const activeStage = current.plan === undefined ? null : activePlanStage(current.plan);
  const objective = activeStage?.objective ?? current.objective;
  const beforeDistance = weightedDistance(before.vector, objective);
  const afterDistance = weightedDistance(after.vector, objective);
  const currentBest = current.bestDistance ?? beforeDistance;
  const confirmed = evidence.attribution === 'ACTION' && evidence.learnable === true;
  const improved = confirmed && afterDistance < beforeDistance;
  const nextCycle = current.cycle + 1;
  let nextStagnation = improved ? 0 : current.stagnation + 1;
  let bestDistance = confirmed
    ? Math.min(currentBest, afterDistance)
    : current.bestDistance;

  let status = 'ACTIVE';
  let stopReason = null;
  let nextPlan = current.plan;
  let nextObjective = current.objective;
  let stageAdvanced = false;
  if (afterDistance <= objective.tolerance && current.plan !== undefined && activeStage !== null) {
    const activeIndex = current.plan.stages.findIndex((stage) => stage.id === current.plan.activeStageId);
    if (activeIndex < current.plan.stages.length - 1) {
      nextPlan = advancePlan(current.plan, activeIndex);
      nextObjective = nextPlan.stages.find((stage) => stage.id === nextPlan.activeStageId).objective;
      nextStagnation = 0;
      bestDistance = null;
      stageAdvanced = true;
    }
  }
  if (afterDistance <= objective.tolerance && !stageAdvanced) {
    status = 'COMPLETED';
    stopReason = 'OBJECTIVE_REACHED';
  } else if (nextCycle >= current.maxCycles) {
    status = 'HALTED';
    stopReason = 'MAX_CYCLES';
  } else if (nextStagnation >= current.stagnationLimit) {
    status = 'REPLAN_REQUIRED';
    stopReason = 'STAGNATION';
  }

  return {
    ...current,
    status,
    objective: nextObjective,
    ...(nextPlan === undefined ? {} : { plan: nextPlan }),
    cycle: nextCycle,
    bestDistance,
    stagnation: nextStagnation,
    lastChange: {
      schemaVersion: SCHEMA_VERSION,
      beforeStateVersion: before.stateVersion,
      afterStateVersion: after.stateVersion,
      beforeDistance,
      afterDistance,
      progress: beforeDistance - afterDistance,
      evidence: evidenceKind(evidence),
      confirmed,
      improved,
      decision: STATUS_DECISIONS[status],
      stopReason,
    },
  };
}

export function acknowledgeReplan(state, reason = 'strategy-change') {
  const current = normalizeState(state);
  if (current.status !== 'REPLAN_REQUIRED') {
    throw new Error('ChangeSupervisor can acknowledge a replan only after REPLAN_REQUIRED.');
  }
  const normalizedReason = requireGoal(reason);
  const strategy = nextStrategy(current.strategy ?? createStrategy(), normalizedReason);
  return {
    ...current,
    status: 'ACTIVE',
    stagnation: 0,
    replanCount: current.replanCount + 1,
    strategy,
    lastChange: {
      ...current.lastChange,
      replanReason: normalizedReason,
    },
  };
}

export function enableGoal(state, goal, plan) {
  const current = normalizeState(state);
  const normalizedGoal = requireGoal(goal);
  if (current.enabled && current.goal !== normalizedGoal) {
    throw new Error('ChangeSupervisor cannot replace an enabled goal without a new lab.');
  }
  if (current.enabled && plan !== undefined) {
    const candidate = createPlan(plan, normalizedGoal, current.objective, hasPlanProgress(plan));
    if (current.plan === undefined || !samePlanDefinition(current.plan, candidate)) {
      throw new Error('ChangeSupervisor cannot replace an enabled goal plan without a new lab.');
    }
    return current;
  }
  const nextPlan = plan === undefined
    ? current.enabled ? current.plan : createPlan(undefined, normalizedGoal, current.objective)
    : createPlan(plan, normalizedGoal, current.objective, hasPlanProgress(plan));
  const activeStage = nextPlan === undefined ? null : activePlanStage(nextPlan);
  return {
    ...current,
    enabled: true,
    goal: normalizedGoal,
    ...(nextPlan === undefined ? {} : { plan: nextPlan, objective: activeStage.objective }),
  };
}

export function goalPlanForActivation(state) {
  const current = normalizeState(state);
  return current.plan === undefined ? undefined : current.plan;
}

function createStrategy() {
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: 'BALANCED',
    revision: 0,
    reason: null,
  };
}

function nextStrategy(strategy, reason) {
  const current = normalizeStrategy(strategy, 'strategy');
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: current.mode === 'BALANCED' ? 'EXPLORATORY' : 'BALANCED',
    revision: current.revision + 1,
    reason,
  };
}

export function normalizeChangeSupervisorState(value) {
  return normalizeState(value);
}

export function resumeChangeSupervisor(state, reason = 'runtime-continuation') {
  const current = normalizeState(state);
  if (current.status === 'ACTIVE') return current;
  const normalizedReason = requireGoal(reason);
  return {
    ...current,
    status: 'ACTIVE',
    stagnation: 0,
    replanCount: current.status === 'REPLAN_REQUIRED' ? current.replanCount + 1 : current.replanCount,
    lastChange: current.lastChange === null
      ? null
      : { ...current.lastChange, replanReason: normalizedReason },
  };
}

export function weightedDistance(vector, objective) {
  const normalizedObjective = normalizeObjective(objective);
  const source = normalizeVector(
    vector,
    'vector',
    normalizedObjective.target.length,
  );
  let distance = 0;
  for (let index = 0; index < source.length; index += 1) {
    distance += Math.abs(normalizedObjective.weights[index]) *
      Math.abs(source[index] - normalizedObjective.target[index]);
  }
  if (!Number.isFinite(distance)) throw new Error('ChangeSupervisor distance overflowed.');
  return distance;
}

function normalizeState(value) {
  const source = snapshotRecord(
    value,
    STATE_KEYS,
    STATE_KEYS.filter((key) => !['strategy', 'enabled', 'plan'].includes(key)),
    'state',
  );
  if (source.schemaVersion !== SCHEMA_VERSION ||
      !['ACTIVE', 'REPLAN_REQUIRED', 'COMPLETED', 'HALTED'].includes(source.status)) {
    throw new Error('ChangeSupervisor state is invalid.');
  }
  const objective = normalizeObjective(source.objective);
  const normalizedGoal = requireGoal(source.goal);
  const normalizedPlan = source.plan === undefined
    ? undefined
    : normalizePlan(source.plan, normalizedGoal, objective);
  if (normalizedPlan !== undefined && !sameObjective(normalizedPlan.stages.find(
    (stage) => stage.id === normalizedPlan.activeStageId,
  ).objective, objective)) {
    throw new Error('ChangeSupervisor plan active objective must equal state objective.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    status: source.status,
    enabled: source.enabled === undefined
      ? source.goal !== '逼近 ValueSpec 目标'
      : requireBoolean(source.enabled, 'enabled'),
    goal: normalizedGoal,
    objective,
    maxCycles: requireBoundedInteger(source.maxCycles, 1, MAX_CYCLES, 'maxCycles'),
    stagnationLimit: requireBoundedInteger(source.stagnationLimit, 1, MAX_STAGNATION, 'stagnationLimit'),
    cycle: requireBoundedInteger(source.cycle, 0, MAX_CYCLES, 'cycle'),
    bestDistance: source.bestDistance === null ? null : requireFinite(source.bestDistance, 'bestDistance'),
    stagnation: requireBoundedInteger(source.stagnation, 0, MAX_STAGNATION, 'stagnation'),
    replanCount: requireBoundedInteger(source.replanCount, 0, MAX_CYCLES, 'replanCount'),
    lastChange: source.lastChange === null ? null : normalizeLastChange(source.lastChange),
    ...(source.strategy === undefined ? {} : { strategy: normalizeStrategy(source.strategy, 'state.strategy') }),
    ...(normalizedPlan === undefined ? {} : { plan: normalizedPlan }),
  };
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw new Error(`ChangeSupervisor ${field} must be a boolean.`);
  return value;
}

function createPlan(value, rootGoal, fallbackObjective, preserveProgress = false) {
  if (value === undefined) {
    return {
      schemaVersion: SCHEMA_VERSION,
      rootGoal,
      revision: 0,
      activeStageId: 'root',
      stages: [{
        schemaVersion: SCHEMA_VERSION,
        id: 'root',
        goal: rootGoal,
        objective: fallbackObjective,
        status: 'ACTIVE',
        attempts: 0,
      }],
    };
  }
  return normalizePlan(value, rootGoal, fallbackObjective, preserveProgress);
}

function normalizePlan(value, rootGoal, fallbackObjective, preserveProgress = true) {
  const source = snapshotRecord(value, PLAN_KEYS, ['stages'], 'plan');
  if (source.schemaVersion !== undefined && source.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('ChangeSupervisor plan schema is unsupported.');
  }
  const rawStages = snapshotArray(source.stages, 'plan.stages');
  if (rawStages.length < 1 || rawStages.length > MAX_STAGES) {
    throw new Error('ChangeSupervisor plan must contain 1 to 128 stages.');
  }
  const baseDimensions = fallbackObjective.observationDimensions;
  const stages = rawStages.map((rawStage, index) => {
    const stage = snapshotRecord(rawStage, STAGE_KEYS, ['id', 'goal'], `plan.stages[${index}]`);
    const objective = stage.objective === undefined
      ? fallbackObjective
      : normalizeObjective(stage.objective);
    if (objective.observationDimensions !== baseDimensions) {
      throw new Error('ChangeSupervisor plan stage dimensions must match the WorldPort observation.');
    }
    const status = preserveProgress && stage.status !== undefined
      ? stage.status
      : index === 0 ? 'ACTIVE' : 'PENDING';
    const attempts = preserveProgress && stage.attempts !== undefined ? stage.attempts : 0;
    if (!STAGE_STATUSES.includes(status) || !Number.isSafeInteger(attempts) || attempts < 0 || attempts > MAX_CYCLES) {
      throw new Error('ChangeSupervisor plan stage state is invalid.');
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      id: requireStageId(stage.id),
      goal: requireGoal(stage.goal),
      objective,
      status,
      attempts,
    };
  });
  if (new Set(stages.map((stage) => stage.id)).size !== stages.length) {
    throw new Error('ChangeSupervisor plan stage ids must be unique.');
  }
  const activeStages = stages.filter((stage) => stage.status === 'ACTIVE');
  const activeStageId = source.activeStageId ?? activeStages[0]?.id ?? stages[0].id;
  if (typeof activeStageId !== 'string' || activeStages.length !== 1 || activeStages[0].id !== activeStageId) {
    throw new Error('ChangeSupervisor plan must have exactly one active stage.');
  }
  const activeIndex = stages.findIndex((stage) => stage.id === activeStageId);
  if (stages.some((stage, index) => stage.status !== (index < activeIndex ? 'COMPLETED' : index === activeIndex ? 'ACTIVE' : 'PENDING'))) {
    throw new Error('ChangeSupervisor plan stages must advance in order.');
  }
  const normalizedRootGoal = requireGoal(source.rootGoal ?? rootGoal);
  if (normalizedRootGoal !== rootGoal) {
    throw new Error('ChangeSupervisor plan rootGoal must equal the supervisor goal.');
  }
  const revision = source.revision ?? 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    rootGoal: normalizedRootGoal,
    revision: requireBoundedInteger(revision, 0, MAX_CYCLES, 'plan.revision'),
    activeStageId,
    stages,
  };
}

function advancePlan(plan, activeIndex) {
  const nextStageId = plan.stages[activeIndex + 1].id;
  return {
    ...plan,
    revision: requireBoundedInteger(plan.revision + 1, 0, MAX_CYCLES, 'plan.revision'),
    activeStageId: nextStageId,
    stages: plan.stages.map((stage, index) => ({
      ...stage,
      status: index <= activeIndex ? 'COMPLETED' : index === activeIndex + 1 ? 'ACTIVE' : 'PENDING',
      attempts: index === activeIndex + 1
        ? requireBoundedInteger(stage.attempts + 1, 0, MAX_CYCLES, 'plan.stage.attempts')
        : stage.attempts,
    })),
  };
}

function activePlanStage(plan) {
  return plan.stages.find((stage) => stage.id === plan.activeStageId);
}

function sameObjective(left, right) {
  return left.schemaVersion === right.schemaVersion &&
    left.observationDimensions === right.observationDimensions &&
    left.tolerance === right.tolerance &&
    left.weights.every((value, index) => value === right.weights[index]) &&
    left.target.every((value, index) => value === right.target[index]);
}

function samePlanDefinition(left, right) {
  return left.rootGoal === right.rootGoal &&
    left.stages.length === right.stages.length &&
    left.stages.every((stage, index) => {
      const candidate = right.stages[index];
      return stage.id === candidate.id && stage.goal === candidate.goal && sameObjective(stage.objective, candidate.objective);
    });
}

function hasPlanProgress(value) {
  return value !== null && typeof value === 'object' &&
    (Object.hasOwn(value, 'activeStageId') ||
      (Array.isArray(value.stages) && value.stages.some((stage) => stage?.status !== undefined || stage?.attempts !== undefined)));
}

function requireStageId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_GOAL_LENGTH) {
    throw new Error('ChangeSupervisor plan stage id must be a bounded non-empty string.');
  }
  return value;
}

function normalizeStrategy(value, field) {
  const source = snapshotRecord(value, STRATEGY_KEYS, STRATEGY_KEYS, field);
  if (source.schemaVersion !== SCHEMA_VERSION ||
      !STRATEGY_MODES.includes(source.mode) ||
      !Number.isSafeInteger(source.revision) || source.revision < 0 || source.revision > MAX_CYCLES ||
      (source.reason !== null && (typeof source.reason !== 'string' || source.reason.length === 0 || source.reason.length > MAX_GOAL_LENGTH))) {
    throw new Error('ChangeSupervisor strategy is invalid.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: source.mode,
    revision: source.revision,
    reason: source.reason,
  };
}

function normalizeObjective(value, tolerance) {
  const source = snapshotRecord(
    value,
    OBJECTIVE_KEYS,
    ['schemaVersion', 'observationDimensions', 'weights', 'target'],
    'valueSpec',
  );
  if (source.schemaVersion !== SCHEMA_VERSION ||
      !Number.isSafeInteger(source.observationDimensions) ||
      source.observationDimensions < 1 ||
      source.observationDimensions > MAX_DIMENSIONS) {
    throw new Error('ChangeSupervisor valueSpec is invalid.');
  }
  const weights = normalizeVector(source.weights, 'valueSpec.weights', source.observationDimensions);
  const target = normalizeVector(source.target, 'valueSpec.target', source.observationDimensions);
  const normalizedTolerance = requireNonNegativeFinite(
    tolerance === undefined ? source.tolerance ?? 0 : tolerance,
    'tolerance',
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    observationDimensions: source.observationDimensions,
    weights,
    target,
    tolerance: normalizedTolerance,
  };
}

function normalizeObservation(value, field, dimensions) {
  const source = snapshotRecord(value, OBSERVATION_KEYS, OBSERVATION_KEYS, field);
  if (source.schemaVersion !== SCHEMA_VERSION ||
      typeof source.stateVersion !== 'string' || source.stateVersion.length === 0 ||
      typeof source.intervalId !== 'string' || source.intervalId.length === 0) {
    throw new Error(`ChangeSupervisor ${field} is invalid.`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    vector: normalizeVector(source.vector, `${field}.vector`, dimensions),
    stateVersion: source.stateVersion,
    intervalId: source.intervalId,
  };
}

function normalizeVerification(value, dimensions) {
  const source = snapshotRecord(value, VERIFICATION_KEYS, VERIFICATION_KEYS, 'verification');
  if (source.schemaVersion !== SCHEMA_VERSION ||
      !['ACTION', 'AMBIGUOUS', 'EXECUTION_REJECTED'].includes(source.attribution) ||
      !Number.isFinite(source.confidence) ||
      source.confidence < 0 ||
      source.confidence > 1 ||
      typeof source.learnable !== 'boolean') {
    throw new Error('ChangeSupervisor verification is invalid.');
  }
  return {
    attribution: source.attribution,
    confidence: source.confidence,
    error: normalizeVector(source.error, 'verification.error', dimensions),
    learnable: source.learnable,
  };
}

function normalizeLastChange(value) {
  const source = snapshotRecord(
    value,
    LAST_CHANGE_KEYS,
    LAST_CHANGE_KEYS.slice(0, 11),
    'state.lastChange',
  );
  if (source.schemaVersion !== SCHEMA_VERSION ||
      typeof source.beforeStateVersion !== 'string' ||
      source.beforeStateVersion.length === 0 ||
      typeof source.afterStateVersion !== 'string' ||
      source.afterStateVersion.length === 0 ||
      !Number.isFinite(source.beforeDistance) ||
      !Number.isFinite(source.afterDistance) ||
      !Number.isFinite(source.progress) ||
      !['CONFIRMED_ACTION', 'AMBIGUOUS', 'REJECTED'].includes(source.evidence) ||
      typeof source.confirmed !== 'boolean' ||
      typeof source.improved !== 'boolean' ||
      !['CONTINUE', 'REPLAN', 'STOP'].includes(source.decision) ||
      (source.stopReason !== null &&
        !['OBJECTIVE_REACHED', 'MAX_CYCLES', 'STAGNATION'].includes(source.stopReason)) ||
      (source.replanReason !== undefined &&
        (typeof source.replanReason !== 'string' || source.replanReason.length === 0 ||
          source.replanReason.length > MAX_GOAL_LENGTH))) {
    throw new Error('ChangeSupervisor state.lastChange is invalid.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    beforeStateVersion: source.beforeStateVersion,
    afterStateVersion: source.afterStateVersion,
    beforeDistance: source.beforeDistance,
    afterDistance: source.afterDistance,
    progress: source.progress,
    evidence: source.evidence,
    confirmed: source.confirmed,
    improved: source.improved,
    decision: source.decision,
    stopReason: source.stopReason,
    ...(source.replanReason === undefined ? {} : { replanReason: source.replanReason }),
  };
}

function evidenceKind(value) {
  if (value.attribution === 'ACTION' && value.learnable) return 'CONFIRMED_ACTION';
  if (value.attribution === 'EXECUTION_REJECTED') return 'REJECTED';
  return 'AMBIGUOUS';
}

function normalizeVector(value, field, dimensions) {
  const source = snapshotArray(value, field);
  if (source.length !== dimensions || source.some((item) => !Number.isFinite(item))) {
    throw new Error(`${field} must contain ${dimensions} finite numbers.`);
  }
  return source;
}

function snapshotRecord(value, allowedKeys, requiredKeys, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`ChangeSupervisor ${field} must be an object.`);
  }
  let ownKeys;
  let descriptors;
  try {
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new Error(`ChangeSupervisor ${field} could not be inspected: ${errorName(error)}.`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`ChangeSupervisor ${field} must be a plain object.`);
  }
  if (ownKeys.some((key) => typeof key !== 'string' ||
      (allowedKeys !== null && !allowedKeys.includes(key))) ||
      requiredKeys.some((key) => !ownKeys.includes(key))) {
    throw new Error(`ChangeSupervisor ${field} fields are invalid.`);
  }
  const snapshot = {};
  for (const key of ownKeys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`ChangeSupervisor ${field}.${String(key)} must be a data property.`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotArray(value, field) {
  if (!Array.isArray(value)) {
    throw new Error(`ChangeSupervisor ${field} must be an array.`);
  }
  let ownKeys;
  let descriptors;
  try {
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new Error(`ChangeSupervisor ${field} could not be inspected: ${errorName(error)}.`);
  }
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor?.value;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(length) || length < 0 ||
      ownKeys.length !== length + 1) {
    throw new Error(`ChangeSupervisor ${field} is not a dense array.`);
  }
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`ChangeSupervisor ${field} must be a dense data array.`);
    }
    snapshot.push(descriptor.value);
  }
  if (!ownKeys.includes('length') || ownKeys.some((key) =>
      key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key) ||
        Number(key) >= length))) {
    throw new Error(`ChangeSupervisor ${field} contains invalid keys.`);
  }
  return snapshot;
}

function errorName(error) {
  return error instanceof Error ? error.name : 'NonErrorThrow';
}

function requireGoal(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_GOAL_LENGTH) {
    throw new Error('ChangeSupervisor goal/reason must be a bounded non-empty string.');
  }
  return value;
}

function requireBoundedInteger(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`ChangeSupervisor ${field} is out of bounds.`);
  }
  return value;
}

function requireFinite(value, field) {
  if (!Number.isFinite(value)) throw new Error(`ChangeSupervisor ${field} must be finite.`);
  return value;
}

function requireNonNegativeFinite(value, field) {
  const normalized = requireFinite(value, field);
  if (normalized < 0) throw new Error(`ChangeSupervisor ${field} must not be negative.`);
  return normalized;
}

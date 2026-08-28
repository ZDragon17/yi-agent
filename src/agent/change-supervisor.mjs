const SCHEMA_VERSION = 1;
const MAX_GOAL_LENGTH = 4096;
const MAX_DIMENSIONS = 1024;
const MAX_CYCLES = 1_000_000;
const MAX_STAGNATION = 100_000;
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
  'goal',
  'objective',
  'maxCycles',
  'stagnationLimit',
  'cycle',
  'bestDistance',
  'stagnation',
  'replanCount',
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

const STATUS_DECISIONS = Object.freeze({
  ACTIVE: 'CONTINUE',
  REPLAN_REQUIRED: 'REPLAN',
  COMPLETED: 'STOP',
  HALTED: 'STOP',
});

export function createChangeSupervisor({
  goal,
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

  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'ACTIVE',
    goal: normalizedGoal,
    objective,
    maxCycles: normalizedMaxCycles,
    stagnationLimit: normalizedStagnationLimit,
    cycle: 0,
    bestDistance: null,
    stagnation: 0,
    replanCount: 0,
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
  const beforeDistance = weightedDistance(before.vector, current.objective);
  const afterDistance = weightedDistance(after.vector, current.objective);
  const currentBest = current.bestDistance ?? beforeDistance;
  const confirmed = evidence.attribution === 'ACTION' && evidence.learnable === true;
  const improved = confirmed && afterDistance < beforeDistance;
  const nextCycle = current.cycle + 1;
  const nextStagnation = improved ? 0 : current.stagnation + 1;
  const bestDistance = confirmed
    ? Math.min(currentBest, afterDistance)
    : current.bestDistance;

  let status = 'ACTIVE';
  let stopReason = null;
  if (afterDistance <= current.objective.tolerance) {
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
  return {
    ...current,
    status: 'ACTIVE',
    stagnation: 0,
    replanCount: current.replanCount + 1,
    lastChange: {
      ...current.lastChange,
      replanReason: normalizedReason,
    },
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
  const source = snapshotRecord(value, STATE_KEYS, STATE_KEYS, 'state');
  if (source.schemaVersion !== SCHEMA_VERSION ||
      !['ACTIVE', 'REPLAN_REQUIRED', 'COMPLETED', 'HALTED'].includes(source.status)) {
    throw new Error('ChangeSupervisor state is invalid.');
  }
  const objective = normalizeObjective(source.objective);
  return {
    schemaVersion: SCHEMA_VERSION,
    status: source.status,
    goal: requireGoal(source.goal),
    objective,
    maxCycles: requireBoundedInteger(source.maxCycles, 1, MAX_CYCLES, 'maxCycles'),
    stagnationLimit: requireBoundedInteger(source.stagnationLimit, 1, MAX_STAGNATION, 'stagnationLimit'),
    cycle: requireBoundedInteger(source.cycle, 0, MAX_CYCLES, 'cycle'),
    bestDistance: source.bestDistance === null ? null : requireFinite(source.bestDistance, 'bestDistance'),
    stagnation: requireBoundedInteger(source.stagnation, 0, MAX_STAGNATION, 'stagnation'),
    replanCount: requireBoundedInteger(source.replanCount, 0, MAX_CYCLES, 'replanCount'),
    lastChange: source.lastChange === null ? null : normalizeLastChange(source.lastChange),
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

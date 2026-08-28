import {
  assertExactKeys,
  assertNonNegativeSafeInteger,
  assertSchemaVersion,
  contractViolation,
  createWorldPort,
  normalizeWorldFactoryOptions,
} from './world-port-base.mjs';

const WORLD_ID = 'queue';
const CAPABILITY_IDS = [
  'queue.serve',
  'queue.admit',
  'queue.clear',
];
const SCENARIOS = [
  'steady',
  'burst',
  'external-during-step',
  'execution-rejected',
  'all-unsafe',
];
const STATE_KEYS = [
  'schemaVersion',
  'stateVersion',
  'revision',
  'queueLength',
  'servedCount',
  'capacity',
  'usedExecutionNonces',
];
const MAX_CAPACITY = 100;
const MAX_SERVED = 1_000_000;

export function createQueueWorld(options) {
  const { manifest, scenario } = normalizeWorldFactoryOptions(options, WORLD_ID, SCENARIOS);
  return createWorldPort({
    worldId: WORLD_ID,
    manifest,
    scenario,
    capabilityIds: CAPABILITY_IDS,
    makeInitialDomainState: () => ({
      queueLength: 3,
      servedCount: 0,
      capacity: 5,
    }),
    normalizeState: normalizeQueueState,
    observeVector: (state) => [state.queueLength, state.servedCount, state.capacity],
    scenarioEvidence: queueEvidence,
    projectCapability: ({ capabilityId, authority, scenario: activeScenario }) => ({
      allowed: authority.allowed,
      safe: authority.safe && activeScenario !== 'all-unsafe' && capabilityId !== 'queue.clear',
    }),
    applyEffect: applyQueueEffect,
  });
}

function normalizeQueueState(value) {
  const state = assertExactKeys(value, STATE_KEYS, `${WORLD_ID}.state`);
  if (!Array.isArray(state.usedExecutionNonces)) {
    contractViolation('queue used execution nonces must be an array', {
      field: `${WORLD_ID}.state.usedExecutionNonces`,
    });
  }
  const capacity = bounded(state.capacity, MAX_CAPACITY, `${WORLD_ID}.state.capacity`);
  const queueLength = bounded(state.queueLength, capacity, `${WORLD_ID}.state.queueLength`);
  return {
    schemaVersion: assertSchemaVersion(state.schemaVersion, `${WORLD_ID}.state.schemaVersion`),
    stateVersion: state.stateVersion,
    revision: assertNonNegativeSafeInteger(state.revision, `${WORLD_ID}.state.revision`),
    queueLength,
    servedCount: bounded(state.servedCount, MAX_SERVED, `${WORLD_ID}.state.servedCount`),
    capacity,
    usedExecutionNonces: [...state.usedExecutionNonces],
  };
}

function applyQueueEffect({ state, capabilityId, scenario }) {
  if (capabilityId === 'queue.clear') return rejected('QUEUE_CLEAR_FORBIDDEN');
  if (capabilityId === 'queue.serve') {
    if (state.queueLength === 0) return rejected('QUEUE_EMPTY');
    if (state.servedCount >= MAX_SERVED) return rejected('QUEUE_SERVED_COUNT_CAPACITY');
    const arrivals = scenario === 'burst' || scenario === 'external-during-step' ? 1 : 0;
    if (state.queueLength - 1 + arrivals > state.capacity) return rejected('QUEUE_CAPACITY');
    return {
      accepted: true,
      patch: { queueLength: state.queueLength - 1 + arrivals, servedCount: state.servedCount + 1 },
    };
  }
  if (state.queueLength >= state.capacity) return rejected('QUEUE_CAPACITY');
  return { accepted: true, patch: { queueLength: state.queueLength + 1 } };
}

function queueEvidence({ state, scenario }) {
  if (scenario === 'steady') return [];
  const common = {
    schemaVersion: 1,
    kind: scenario,
    worldId: WORLD_ID,
    stateVersion: state.stateVersion,
  };
  if (scenario === 'burst') return [{ ...common, arrivalRate: 1 }];
  if (scenario === 'external-during-step') {
    return [{ ...common, attributionWindowComplete: false, confounderCount: 1 }];
  }
  if (scenario === 'execution-rejected') return [{ ...common, executed: false }];
  return [{ ...common, safeCandidateCount: 0 }];
}

function bounded(value, maximum, field) {
  const result = assertNonNegativeSafeInteger(value, field);
  if (result > maximum) contractViolation('queue value exceeds its bound', { field });
  return result;
}

function rejected(rejectionReason) {
  return { accepted: false, rejectionReason };
}

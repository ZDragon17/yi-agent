import {
  assertExactKeys,
  assertNonNegativeSafeInteger,
  assertSchemaVersion,
  contractViolation,
  createWorldPort,
  normalizeWorldFactoryOptions,
} from './world-port-base.mjs';

const WORLD_ID = 'inventory';
const CAPABILITY_IDS = [
  'inventory.restock-a',
  'inventory.restock-b',
  'inventory.fulfill',
];
const SCENARIOS = [
  'steady',
  'supply-shock',
  'external-during-step',
  'execution-rejected',
  'all-unsafe',
];
const STATE_KEYS = [
  'schemaVersion',
  'stateVersion',
  'revision',
  'stockA',
  'stockB',
  'backlog',
  'usedExecutionNonces',
];
const MAX_STOCK = 100;
const MAX_BACKLOG = 100;

export function createInventoryWorld(options) {
  const { manifest, scenario } = normalizeWorldFactoryOptions(
    options,
    WORLD_ID,
    SCENARIOS,
  );

  return createWorldPort({
    worldId: WORLD_ID,
    manifest,
    scenario,
    capabilityIds: CAPABILITY_IDS,
    makeInitialDomainState: () => ({
      stockA: 3,
      stockB: 2,
      backlog: 4,
    }),
    normalizeState: normalizeInventoryState,
    observeVector: (state) => [state.stockA, state.stockB, state.backlog],
    scenarioEvidence: inventoryEvidence,
    projectCapability: ({ authority, scenario: activeScenario }) => ({
      allowed: authority.allowed,
      safe: authority.safe && activeScenario !== 'all-unsafe',
    }),
    applyEffect: applyInventoryEffect,
  });
}

function normalizeInventoryState(value) {
  const state = assertExactKeys(value, STATE_KEYS, `${WORLD_ID}.state`);
  if (!Array.isArray(state.usedExecutionNonces)) {
    contractViolation('inventory used execution nonces must be an array', {
      field: `${WORLD_ID}.state.usedExecutionNonces`,
    });
  }
  return {
    schemaVersion: assertSchemaVersion(state.schemaVersion, `${WORLD_ID}.state.schemaVersion`),
    stateVersion: state.stateVersion,
    revision: assertNonNegativeSafeInteger(state.revision, `${WORLD_ID}.state.revision`),
    stockA: boundedInteger(state.stockA, MAX_STOCK, `${WORLD_ID}.state.stockA`),
    stockB: boundedInteger(state.stockB, MAX_STOCK, `${WORLD_ID}.state.stockB`),
    backlog: boundedInteger(state.backlog, MAX_BACKLOG, `${WORLD_ID}.state.backlog`),
    usedExecutionNonces: [...state.usedExecutionNonces],
  };
}

function applyInventoryEffect({ state, capabilityId, scenario }) {
  if (capabilityId === 'inventory.restock-a') {
    const amount = scenario === 'supply-shock' ? 1 : 2;
    return state.stockA + amount > MAX_STOCK
      ? rejected('INVENTORY_STOCK_A_CAPACITY')
      : { accepted: true, patch: { stockA: state.stockA + amount } };
  }
  if (capabilityId === 'inventory.restock-b') {
    const amount = scenario === 'supply-shock' ? 1 : 2;
    return state.stockB + amount > MAX_STOCK
      ? rejected('INVENTORY_STOCK_B_CAPACITY')
      : { accepted: true, patch: { stockB: state.stockB + amount } };
  }
  if (state.stockA < 1 || state.stockB < 1 || state.backlog < 1) {
    return rejected('INVENTORY_INSUFFICIENT_FULFILLMENT_STOCK');
  }

  const backlog = state.backlog - 1 + (scenario === 'external-during-step' ? 1 : 0);
  if (backlog > MAX_BACKLOG) return rejected('INVENTORY_BACKLOG_CAPACITY');
  return {
    accepted: true,
    patch: {
      stockA: state.stockA - 1,
      stockB: state.stockB - 1,
      backlog,
    },
  };
}

function inventoryEvidence({ state, scenario }) {
  if (scenario === 'steady') return [];
  const common = {
    schemaVersion: 1,
    kind: scenario,
    worldId: WORLD_ID,
    stateVersion: state.stateVersion,
  };
  if (scenario === 'supply-shock') return [{ ...common, restockMultiplier: 0.5 }];
  if (scenario === 'external-during-step') {
    return [{ ...common, attributionWindowComplete: false, confounderCount: 1 }];
  }
  if (scenario === 'execution-rejected') return [{ ...common, executed: false }];
  return [{ ...common, safeCandidateCount: 0 }];
}

function boundedInteger(value, maximum, field) {
  const result = assertNonNegativeSafeInteger(value, field);
  if (result > maximum) contractViolation('inventory value exceeds its bound', { field });
  return result;
}

function rejected(rejectionReason) {
  return { accepted: false, rejectionReason };
}

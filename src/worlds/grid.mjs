import {
  assertExactKeys,
  assertNonNegativeSafeInteger,
  assertSchemaVersion,
  contractViolation,
  createWorldPort,
  normalizeWorldFactoryOptions,
} from './world-port-base.mjs';

const WORLD_ID = 'grid';
const CAPABILITY_IDS = [
  'grid.move-south',
  'grid.move-east',
  'grid.move-north',
  'grid.move-west',
  'grid.teleport',
];
const SCENARIOS = [
  'steady',
  'blocked-route',
  'external-during-step',
  'execution-rejected',
  'all-unsafe',
];
const STATE_KEYS = [
  'schemaVersion',
  'stateVersion',
  'revision',
  'x',
  'y',
  'goalX',
  'goalY',
  'obstacles',
  'usedExecutionNonces',
];
const POINT_KEYS = ['x', 'y'];
const GRID_SIZE = 4;

export function createGridWorld(options) {
  const { manifest, scenario } = normalizeWorldFactoryOptions(options, WORLD_ID, SCENARIOS);
  return createWorldPort({
    worldId: WORLD_ID,
    manifest,
    scenario,
    capabilityIds: CAPABILITY_IDS,
    makeInitialDomainState: () => ({
      x: 0,
      y: 0,
      goalX: 2,
      goalY: 2,
      obstacles: [{ x: 1, y: 0 }, { x: 1, y: 1 }],
    }),
    normalizeState: normalizeGridState,
    observeVector: (state) => [state.x, state.y, state.goalX, state.goalY],
    scenarioEvidence: gridEvidence,
    projectCapability: ({ capabilityId, authority, scenario: activeScenario }) => ({
      allowed: authority.allowed,
      safe: authority.safe && activeScenario !== 'all-unsafe' && capabilityId !== 'grid.teleport',
    }),
    applyEffect: applyGridEffect,
  });
}

function normalizeGridState(value) {
  const state = assertExactKeys(value, STATE_KEYS, `${WORLD_ID}.state`);
  if (!Array.isArray(state.obstacles) || !Array.isArray(state.usedExecutionNonces)) {
    contractViolation('grid obstacles and used execution nonces must be arrays', {
      field: `${WORLD_ID}.state`,
    });
  }
  const obstacles = state.obstacles.map((point, index) => normalizePoint(point, `${WORLD_ID}.state.obstacles[${index}]`));
  if (new Set(obstacles.map((point) => `${point.x}:${point.y}`)).size !== obstacles.length) {
    contractViolation('grid obstacles must be unique', { field: `${WORLD_ID}.state.obstacles` });
  }
  const normalized = {
    schemaVersion: assertSchemaVersion(state.schemaVersion, `${WORLD_ID}.state.schemaVersion`),
    stateVersion: state.stateVersion,
    revision: assertNonNegativeSafeInteger(state.revision, `${WORLD_ID}.state.revision`),
    x: gridCoordinate(state.x, `${WORLD_ID}.state.x`),
    y: gridCoordinate(state.y, `${WORLD_ID}.state.y`),
    goalX: gridCoordinate(state.goalX, `${WORLD_ID}.state.goalX`),
    goalY: gridCoordinate(state.goalY, `${WORLD_ID}.state.goalY`),
    obstacles,
    usedExecutionNonces: [...state.usedExecutionNonces],
  };
  if (normalized.obstacles.some((point) => point.x === normalized.x && point.y === normalized.y)) {
    contractViolation('grid current position cannot be an obstacle', { field: `${WORLD_ID}.state.obstacles` });
  }
  return normalized;
}

function applyGridEffect({ state, capabilityId }) {
  if (capabilityId === 'grid.teleport') return rejected('GRID_TELEPORT_FORBIDDEN');
  const delta = {
    'grid.move-south': [0, 1],
    'grid.move-east': [1, 0],
    'grid.move-north': [0, -1],
    'grid.move-west': [-1, 0],
  }[capabilityId];
  const next = { x: state.x + delta[0], y: state.y + delta[1] };
  if (next.x < 0 || next.x >= GRID_SIZE || next.y < 0 || next.y >= GRID_SIZE) {
    return rejected('GRID_BOUNDARY');
  }
  if (state.obstacles.some((point) => point.x === next.x && point.y === next.y)) {
    return rejected('GRID_OBSTACLE');
  }
  return { accepted: true, patch: next };
}

function gridEvidence({ state, scenario }) {
  if (scenario === 'steady') return [];
  const common = {
    schemaVersion: 1,
    kind: scenario,
    worldId: WORLD_ID,
    stateVersion: state.stateVersion,
  };
  if (scenario === 'blocked-route') return [{ ...common, obstacleCount: state.obstacles.length }];
  if (scenario === 'external-during-step') {
    return [{ ...common, attributionWindowComplete: false, confounderCount: 1 }];
  }
  if (scenario === 'execution-rejected') return [{ ...common, executed: false }];
  return [{ ...common, safeCandidateCount: 0 }];
}

function normalizePoint(value, field) {
  const point = assertExactKeys(value, POINT_KEYS, field);
  return {
    x: gridCoordinate(point.x, `${field}.x`),
    y: gridCoordinate(point.y, `${field}.y`),
  };
}

function gridCoordinate(value, field) {
  const result = assertNonNegativeSafeInteger(value, field);
  if (result >= GRID_SIZE) contractViolation('grid coordinate is outside the board', { field });
  return result;
}

function rejected(rejectionReason) {
  return { accepted: false, rejectionReason };
}

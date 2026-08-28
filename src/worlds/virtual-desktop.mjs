import {
  assertBoolean,
  assertExactKeys,
  assertNonEmptyString,
  assertNonNegativeSafeInteger,
  assertOneOf,
  assertSchemaVersion,
  contractViolation,
  createWorldPort,
  normalizeWorldFactoryOptions,
} from './world-port-base.mjs';

const WORLD_ID = 'virtual-desktop';
const CAPABILITY_IDS = [
  'desktop.move-report',
  'desktop.move-protected',
];
const SCENARIOS = [
  'steady',
  'new-files',
  'external-during-step',
  'execution-rejected',
  'all-unsafe',
];
const STATE_KEYS = [
  'schemaVersion',
  'stateVersion',
  'revision',
  'items',
  'nextSyntheticId',
  'usedExecutionNonces',
];
const ITEM_KEYS = ['id', 'kind', 'protected', 'x', 'y'];
const MAX_ITEMS = 10_000;
const MAX_POSITION = 1_000_000;

export function createVirtualDesktopWorld(options) {
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
      items: [
        {
          id: 'report.txt',
          kind: 'report',
          protected: false,
          x: 0,
          y: 0,
        },
        {
          id: 'system-protected.link',
          kind: 'protected',
          protected: true,
          x: 9,
          y: 9,
        },
      ],
      nextSyntheticId: 1,
    }),
    normalizeState: normalizeDesktopState,
    observeVector: desktopVector,
    scenarioEvidence: desktopEvidence,
    projectCapability: ({ capabilityId, authority, scenario: activeScenario }) => ({
      allowed: authority.allowed,
      safe:
        authority.safe &&
        activeScenario !== 'all-unsafe' &&
        capabilityId !== 'desktop.move-protected',
    }),
    applyEffect: applyDesktopEffect,
  });
}

function normalizeDesktopState(value) {
  const state = assertExactKeys(value, STATE_KEYS, `${WORLD_ID}.state`);
  if (!Array.isArray(state.items) || state.items.length > MAX_ITEMS) {
    contractViolation('desktop items must be a bounded array', {
      field: `${WORLD_ID}.state.items`,
    });
  }
  if (!Array.isArray(state.usedExecutionNonces)) {
    contractViolation('desktop usedExecutionNonces must be an array', {
      field: `${WORLD_ID}.state.usedExecutionNonces`,
    });
  }

  const items = state.items.map(normalizeDesktopItem);
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    contractViolation('desktop item ids must be unique', {
      field: `${WORLD_ID}.state.items`,
    });
  }
  if (
    items.filter((item) => item.kind === 'report').length !== 1 ||
    items.filter((item) => item.kind === 'protected').length !== 1
  ) {
    contractViolation('desktop must contain exactly one report and protected item', {
      field: `${WORLD_ID}.state.items`,
    });
  }

  return {
    schemaVersion: assertSchemaVersion(
      state.schemaVersion,
      `${WORLD_ID}.state.schemaVersion`,
    ),
    stateVersion: assertNonEmptyString(
      state.stateVersion,
      `${WORLD_ID}.state.stateVersion`,
    ),
    revision: assertNonNegativeSafeInteger(
      state.revision,
      `${WORLD_ID}.state.revision`,
    ),
    items,
    nextSyntheticId: assertNonNegativeSafeInteger(
      state.nextSyntheticId,
      `${WORLD_ID}.state.nextSyntheticId`,
    ),
    usedExecutionNonces: [...state.usedExecutionNonces],
  };
}

function normalizeDesktopItem(value, index) {
  const item = assertExactKeys(
    value,
    ITEM_KEYS,
    `${WORLD_ID}.state.items[${index}]`,
  );
  const kind = assertOneOf(
    item.kind,
    ['report', 'protected', 'synthetic'],
    `${WORLD_ID}.state.items[${index}].kind`,
  );
  const isProtected = assertBoolean(
    item.protected,
    `${WORLD_ID}.state.items[${index}].protected`,
  );
  if (isProtected !== (kind === 'protected')) {
    contractViolation('desktop protected marker must match the item kind', {
      field: `${WORLD_ID}.state.items[${index}].protected`,
    });
  }

  return {
    id: assertNonEmptyString(
      item.id,
      `${WORLD_ID}.state.items[${index}].id`,
    ),
    kind,
    protected: isProtected,
    x: assertPosition(item.x, `${WORLD_ID}.state.items[${index}].x`),
    y: assertPosition(item.y, `${WORLD_ID}.state.items[${index}].y`),
  };
}

function applyDesktopEffect({ state, capabilityId, scenario }) {
  if (capabilityId === 'desktop.move-protected') {
    return { accepted: false, rejectionReason: 'PROTECTED_ITEM_IMMOVABLE' };
  }

  const report = state.items.find((item) => item.kind === 'report');
  if (report.x >= MAX_POSITION) {
    return { accepted: false, rejectionReason: 'DESKTOP_POSITION_BOUNDARY' };
  }

  const items = state.items.map((item) =>
    item.kind === 'report' ? { ...item, x: item.x + 1 } : { ...item },
  );
  let nextSyntheticId = state.nextSyntheticId;

  if (scenario === 'new-files' || scenario === 'external-during-step') {
    if (items.length >= MAX_ITEMS) {
      return { accepted: false, rejectionReason: 'DESKTOP_ITEM_CAPACITY_REACHED' };
    }
    if (nextSyntheticId === Number.MAX_SAFE_INTEGER) {
      return { accepted: false, rejectionReason: 'DESKTOP_ID_CAPACITY_REACHED' };
    }
    const prefix = scenario === 'new-files' ? 'incoming' : 'external';
    items.push({
      id: `${prefix}-${nextSyntheticId}.tmp`,
      kind: 'synthetic',
      protected: false,
      x: nextSyntheticId % 10,
      y: Math.floor(nextSyntheticId / 10) % 10,
    });
    nextSyntheticId += 1;
  }

  return { accepted: true, patch: { items, nextSyntheticId } };
}

function desktopVector(state) {
  const report = state.items.find((item) => item.kind === 'report');
  const protectedItem = state.items.find((item) => item.kind === 'protected');
  return [
    report.x,
    report.y,
    protectedItem.x,
    protectedItem.y,
    state.items.length,
  ];
}

function desktopEvidence({ state, scenario }) {
  if (scenario === 'steady') {
    return [];
  }

  const common = {
    schemaVersion: 1,
    kind: scenario,
    worldId: WORLD_ID,
    stateVersion: state.stateVersion,
  };

  if (scenario === 'new-files') {
    return [{
      ...common,
      syntheticFileCount: state.items.filter((item) => item.kind === 'synthetic').length,
    }];
  }
  if (scenario === 'external-during-step') {
    return [{
      ...common,
      attributionWindowComplete: false,
      confounderCount: 1,
    }];
  }
  if (scenario === 'execution-rejected') {
    return [{ ...common, executed: false }];
  }
  return [{ ...common, safeCandidateCount: 0 }];
}

function assertPosition(value, field) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_POSITION) {
    contractViolation('desktop position must be a bounded safe integer', { field });
  }
  return value;
}

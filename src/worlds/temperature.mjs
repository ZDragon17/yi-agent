import {
  assertExactKeys,
  assertFiniteNumber,
  assertNonEmptyString,
  assertNonNegativeSafeInteger,
  assertOneOf,
  assertSchemaVersion,
  contractViolation,
  createWorldPort,
  normalizeWorldFactoryOptions,
} from './world-port-base.mjs';

const WORLD_ID = 'temperature';
const CAPABILITY_IDS = [
  'temperature.increase',
  'temperature.decrease',
];
const SCENARIOS = [
  'steady',
  'regime-shift',
  'external-during-step',
  'execution-rejected',
  'all-unsafe',
];
const STATE_KEYS = [
  'schemaVersion',
  'stateVersion',
  'revision',
  'temperatureC',
  'regime',
  'usedExecutionNonces',
];
const MIN_TEMPERATURE_C = 5;
const MAX_TEMPERATURE_C = 35;

export function createTemperatureWorld(options) {
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
      temperatureC: 22,
      regime: 'baseline',
    }),
    normalizeState: normalizeTemperatureState,
    observeVector: (state) => [state.temperatureC],
    scenarioEvidence: temperatureEvidence,
    projectCapability: ({ authority, scenario: activeScenario }) => ({
      allowed: authority.allowed,
      safe: authority.safe && activeScenario !== 'all-unsafe',
    }),
    applyEffect: applyTemperatureEffect,
  });
}

function normalizeTemperatureState(value) {
  const state = assertExactKeys(value, STATE_KEYS, `${WORLD_ID}.state`);
  const temperatureC = assertFiniteNumber(
    state.temperatureC,
    `${WORLD_ID}.state.temperatureC`,
  );
  if (temperatureC < MIN_TEMPERATURE_C || temperatureC > MAX_TEMPERATURE_C) {
    contractViolation('temperature state is outside the supported range', {
      field: `${WORLD_ID}.state.temperatureC`,
    });
  }

  if (!Array.isArray(state.usedExecutionNonces)) {
    contractViolation('temperature usedExecutionNonces must be an array', {
      field: `${WORLD_ID}.state.usedExecutionNonces`,
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
    temperatureC,
    regime: assertOneOf(
      state.regime,
      ['baseline', 'shifted'],
      `${WORLD_ID}.state.regime`,
    ),
    usedExecutionNonces: [...state.usedExecutionNonces],
  };
}

function applyTemperatureEffect({ state, capabilityId, scenario }) {
  let actionDelta = capabilityId === 'temperature.increase' ? 0.5 : -0.5;
  let regime = state.regime;

  if (scenario === 'regime-shift') {
    actionDelta = capabilityId === 'temperature.increase' ? 1.25 : -0.25;
    regime = 'shifted';
  }

  const externalDelta = scenario === 'external-during-step' ? 0.2 : 0;
  const nextTemperatureC = roundTemperature(
    state.temperatureC + actionDelta + externalDelta,
  );

  if (
    nextTemperatureC < MIN_TEMPERATURE_C ||
    nextTemperatureC > MAX_TEMPERATURE_C
  ) {
    return {
      accepted: false,
      rejectionReason: 'TEMPERATURE_SAFETY_BOUNDARY',
    };
  }

  return {
    accepted: true,
    patch: { temperatureC: nextTemperatureC, regime },
  };
}

function temperatureEvidence({ state, scenario }) {
  if (scenario === 'steady') {
    return [];
  }

  const common = {
    schemaVersion: 1,
    kind: scenario,
    worldId: WORLD_ID,
    stateVersion: state.stateVersion,
  };

  if (scenario === 'regime-shift') {
    return [{ ...common, regime: state.regime }];
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

function roundTemperature(value) {
  return Math.round(value * 1_000) / 1_000;
}

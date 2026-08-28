import { learn, step, verify } from '../kernel/index.mjs';
import {
  SCHEMA_VERSION,
  canonicalDigest,
  canonicalJson,
  cloneJson,
  verifySelfDigest,
} from './schema.mjs';
import {
  isValidEvidencePublicKey,
  verifyExternalInputAttestation,
} from './external-evidence.mjs';

const TERMINAL_KINDS = new Set(['RUN_COMPLETED', 'RUN_HALTED']);
const REQUIRED_BOUNDARY_KEYS = ['schemaVersion', 'valueSpec'];
const MAX_SCENARIO_IDS = 256;
const MAX_SCENARIO_ID_LENGTH = 4096;

export class ReplayError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'ReplayError';
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export function replayRun(input) {
  try {
    return replayRunInternal(input);
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    throw new ReplayError('CORRUPT', 'Replay input or deterministic execution is invalid.', {}, { cause: error });
  }
}

function replayRunInternal(input) {
  const source = requireRecord(input, 'replay input');
  const manifest = cloneReplayValue(source.manifest, 'manifest');
  const start = cloneReplayValue(source.start, 'run start');
  const events = cloneReplayValue(source.events, 'events');
  const end = cloneReplayValue(source.end, 'run end');
  const worldFactories = source.worldFactories;
  const kernel = source.kernel ?? { step, verify, learn };

  validateManifest(manifest);
  validateStart(start, manifest);
  if (!Array.isArray(events) || events.length === 0) corrupt('Replay requires a non-empty event ledger.');
  if (!isRecord(worldFactories) || typeof worldFactories[start.worldId] !== 'function') {
    corrupt('Replay has no factory for the immutable run world.', { worldId: start.worldId });
  }
  if (!isRecord(kernel) || typeof kernel.step !== 'function' || typeof kernel.verify !== 'function' || typeof kernel.learn !== 'function') {
    invalid('Replay kernel must expose step, verify, and learn functions.');
  }

  validateLedgerEnvelope(events, start);
  validateEndEnvelope(end, start, events);

  const worldManifest = {
    schemaVersion: SCHEMA_VERSION,
    tokenMap: manifest.tokenMap,
    authorityPolicy: manifest.authorityPolicy,
  };
  let world;
  try {
    world = worldFactories[start.worldId]({ manifest: worldManifest, scenario: start.scenario });
  } catch (error) {
    corrupt('Immutable run world or scenario cannot be reconstructed.', {
      worldId: start.worldId,
      scenario: start.scenario,
      cause: errorName(error),
    });
  }
  if (!isRecord(world) || typeof world.initialState !== 'function' || typeof world.observe !== 'function' ||
      typeof world.actions !== 'function' || typeof world.transition !== 'function') {
    corrupt('Replay world factory did not return the WorldPort contract.', { worldId: start.worldId });
  }

  let state = cloneJson(start.initialState);
  for (const event of events.slice(1)) {
    if (event.kind === 'STEP') {
      const replay = replayStep({ event, state, manifest: worldManifest, adapter: manifest.adapter, world, kernel });
      if (replay.difference) return inconsistent(start.runId, replay.difference, state);
      state = cloneJson(replay.nextState);
      continue;
    }
    if (TERMINAL_KINDS.has(event.kind)) {
      const difference = compareValue(
        event.payload.finalState,
        state,
        'payload.finalState',
        event.sequence,
      );
      if (difference) return inconsistent(start.runId, difference, state);
    }
  }

  const terminal = events.at(-1);
  if (!TERMINAL_KINDS.has(terminal.kind)) corrupt('Replay requires a terminal ledger event.');
  const endDifference = compareValue(end.finalStateDigest, terminal.payload.finalStateDigest, 'end.finalStateDigest', terminal.sequence)
    ?? compareValue(end.finalSequence, terminal.sequence, 'end.finalSequence', terminal.sequence)
    ?? compareValue(end.finalEventDigest, terminal.digest, 'end.finalEventDigest', terminal.sequence)
    ?? compareValue(end.terminalStatus, terminal.payload.terminalStatus, 'end.terminalStatus', terminal.sequence);
  if (endDifference) return inconsistent(start.runId, endDifference, state);
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: start.runId,
    verdict: 'CONSISTENT',
    firstDifference: null,
    checkedSequences: events.length,
    finalState: cloneJson(state),
  };
}

function replayStep({ event, state, manifest, adapter, world, kernel }) {
  const payload = event.payload;
  if (!isRecord(payload.boundary) || payload.boundary.schemaVersion !== SCHEMA_VERSION ||
      REQUIRED_BOUNDARY_KEYS.some((key) => !(key in payload.boundary))) {
    corrupt('STEP is missing immutable replay decision input.', { sequence: event.sequence });
  }
  if (payload.boundary.externalInputsDigest !== undefined &&
      (typeof payload.boundary.externalInputsDigest !== 'string' ||
        payload.boundary.externalInputsDigest !== canonicalDigest(payload.externalInputs))) {
    corrupt('STEP external input binding is invalid.', { sequence: event.sequence });
  }
  if (adapter !== undefined &&
      (typeof payload.boundary.externalInputsDigest !== 'string' ||
        payload.boundary.externalInputsDigest !== canonicalDigest(payload.externalInputs) ||
        !Array.isArray(payload.externalInputs) ||
        payload.externalInputs.some((input) => !verifyExternalInputAttestation(input, adapter.evidencePublicKey)))) {
    corrupt('STEP external evidence attestation is invalid.', { sequence: event.sequence });
  }
  const valueSpec = cloneJson(payload.boundary.valueSpec);
  let capabilities;
  let beforeObservation;
  try {
    capabilities = world.actions(manifest);
    beforeObservation = projectObservation(world.observe(state.worldState));
  } catch (error) {
    corrupt('Replay could not observe the world before a STEP.', { sequence: event.sequence, cause: errorName(error) });
  }
  let difference = compareValue(payload.beforeDigest, canonicalDigest(state), 'payload.beforeDigest', event.sequence)
    ?? compareValue(payload.rngBefore, state.rngState, 'payload.rngBefore', event.sequence);
  if (!difference && payload.boundary.capabilities !== undefined) {
    difference = compareValue(payload.boundary.capabilities, capabilities, 'payload.boundary.capabilities', event.sequence);
  }
  if (!difference) difference = compareValue(payload.beforeObservation, beforeObservation, 'payload.beforeObservation', event.sequence);
  if (difference) return { difference };

  let intent;
  try {
    intent = kernel.step({
      observation: beforeObservation,
      memory: state.memory,
      valueSpec,
      capabilities,
      rngState: state.rngState,
    });
  } catch (error) {
    corrupt('Replay kernel.step failed.', { sequence: event.sequence, cause: errorName(error) });
  }
  difference = compareValue(payload.expectation, intent.expectation, 'payload.expectation', event.sequence)
    ?? compareValue(payload.choice, intent.choice, 'payload.choice', event.sequence);
  if (difference) return { difference };

  let transition;
  try {
    transition = world.transition(state.worldState, {
      schemaVersion: SCHEMA_VERSION,
      token: intent.choice.token,
      basedOnVersion: beforeObservation.stateVersion,
      policyVersion: manifest.authorityPolicy.policyVersion,
      constraintsDigest: manifest.authorityPolicy.constraintsDigest,
      executionNonce: payload.receipt.executionNonce,
    });
  } catch (error) {
    corrupt('Replay world transition failed.', { sequence: event.sequence, cause: errorName(error) });
  }
  const postObservation = projectObservation(transition.postObservation);
  const receipt = payload.externalInputs.length === 0
    ? transition.receipt
    : {
        ...transition.receipt,
        attributionWindowComplete: false,
        confounderCount: Math.max(1, transition.receipt.confounderCount),
      };
  difference = compareValue(payload.receipt, receipt, 'payload.receipt', event.sequence)
    ?? compareValue(payload.postObservation, postObservation, 'payload.postObservation', event.sequence);
  if (difference) return { difference };

  let verification;
  let update;
  try {
    verification = kernel.verify({ intent, receipt, postObservation });
    update = kernel.learn({
      memory: state.memory,
      intent,
      receipt,
      postObservation,
      verification,
    });
  } catch (error) {
    corrupt('Replay kernel verification or learning failed.', { sequence: event.sequence, cause: errorName(error) });
  }
  difference = compareValue(payload.verification, verification, 'payload.verification', event.sequence)
    ?? compareValue(payload.update, update, 'payload.update', event.sequence)
    ?? compareValue(payload.rngAfter, intent.nextRngState, 'payload.rngAfter', event.sequence);
  const nextState = {
    worldState: transition.nextWorldState,
    memory: update.nextMemory,
    rngState: intent.nextRngState,
    kernelStep: state.kernelStep + 1,
  };
  if (!difference) {
    difference = compareValue(payload.afterDigest, canonicalDigest(nextState), 'payload.afterDigest', event.sequence)
      ?? compareValue(payload.afterState, nextState, 'payload.afterState', event.sequence);
  }
  return difference ? { difference } : { nextState };
}

function validateManifest(manifest) {
  if (!isRecord(manifest) || manifest.schemaVersion !== SCHEMA_VERSION || !verifySelfDigestSafe(manifest)) {
    corrupt('Replay manifest schema or digest is invalid.');
  }
  if (!isRecord(manifest.tokenMap) || !isRecord(manifest.authorityPolicy) || typeof manifest.tokenMap.digest !== 'string') {
    corrupt('Replay manifest is incomplete.');
  }
  if (manifest.scenarioIds !== undefined && !isValidScenarioIds(manifest.scenarioIds)) {
    corrupt('Replay manifest scenario contract is invalid.');
  }
  if (manifest.adapter !== undefined && !isValidAdapterMetadata(manifest.adapter)) {
    corrupt('Replay manifest adapter contract is invalid.');
  }
}

function validateStart(start, manifest) {
  if (!isRecord(start) || start.schemaVersion !== SCHEMA_VERSION || !verifySelfDigestSafe(start) ||
      typeof start.runId !== 'string' || typeof start.worldId !== 'string' || typeof start.scenario !== 'string' ||
      start.worldId !== manifest.worldId ||
      (Array.isArray(manifest.scenarioIds) && !manifest.scenarioIds.includes(start.scenario)) ||
      (start.manifestDigest !== undefined && start.manifestDigest !== manifest.selfDigest) ||
      start.tokenMapDigest !== manifest.tokenMap.digest || !isRecord(start.initialState)) {
    corrupt('Immutable run start is invalid.');
  }
  if (!isRecord(start.initialState.worldState) || !isRecord(start.initialState.memory) ||
      !isRecord(start.initialState.rngState) || !Number.isSafeInteger(start.initialState.kernelStep) ||
      start.initialState.kernelStep < 0) {
    corrupt('Immutable run start continuity state is invalid.', { runId: start.runId });
  }
}

function validateLedgerEnvelope(events, start) {
  let previousDigest = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const sequence = index + 1;
    if (!isRecord(event) || event.schemaVersion !== SCHEMA_VERSION || event.runId !== start.runId ||
        event.sequence !== sequence || event.prevDigest !== previousDigest || typeof event.digest !== 'string' ||
        event.digest !== digestWithoutSelf(event)) {
      corrupt('Replay ledger sequence or digest chain is invalid.', { runId: start.runId, sequence });
    }
    if (index === 0 && (event.kind !== 'RUN_STARTED' || event.payload?.startDigest !== start.selfDigest ||
        event.payload?.worldId !== start.worldId || event.payload?.scenario !== start.scenario)) {
      corrupt('RUN_STARTED does not bind immutable replay start.', { runId: start.runId });
    }
    if (TERMINAL_KINDS.has(event.kind)) {
      const expectedStatus = event.kind === 'RUN_COMPLETED' ? 'COMPLETED' : 'HALTED';
      if (event.payload?.terminalStatus !== expectedStatus) {
        corrupt('Terminal event kind and status do not match.', { runId: start.runId, sequence });
      }
    }
    if (index > 0 && event.kind !== 'STEP' && !TERMINAL_KINDS.has(event.kind)) {
      corrupt('Replay ledger contains an unsupported event kind.', { runId: start.runId, sequence });
    }
    previousDigest = event.digest;
  }
  const terminalIndexes = events
    .map((event, index) => TERMINAL_KINDS.has(event.kind) ? index : -1)
    .filter((index) => index >= 0);
  if (terminalIndexes.length !== 1 || terminalIndexes[0] !== events.length - 1) {
    corrupt('Replay ledger must contain exactly one terminal event at its end.', { runId: start.runId });
  }
}

function isValidScenarioIds(value) {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_SCENARIO_IDS &&
    value.every((scenario) => typeof scenario === 'string' && scenario.length > 0 && scenario.length <= MAX_SCENARIO_ID_LENGTH) &&
    new Set(value).size === value.length;
}

function isValidAdapterMetadata(value) {
  return isRecord(value) &&
    value.schemaVersion === SCHEMA_VERSION &&
    value.protocol === 'yi-world-cli' &&
    value.version === 1 &&
    typeof value.adapterId === 'string' && value.adapterId.length > 0 && value.adapterId.length <= 4096 &&
    typeof value.worldVersion === 'string' && value.worldVersion.length > 0 && value.worldVersion.length <= 4096 &&
    isValidValueSpec(value.valueSpec) &&
    isValidEvidencePublicKey(value.evidencePublicKey) &&
    typeof value.descriptorDigest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value.descriptorDigest) &&
    typeof value.launchDigest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value.launchDigest);
}

function isValidValueSpec(value) {
  return isRecord(value) && value.schemaVersion === SCHEMA_VERSION &&
    Number.isSafeInteger(value.observationDimensions) && value.observationDimensions >= 1 && value.observationDimensions <= 1024 &&
    Array.isArray(value.weights) && value.weights.length === value.observationDimensions &&
    Array.isArray(value.target) && value.target.length === value.observationDimensions &&
    value.weights.every((item) => Number.isFinite(item)) && value.target.every((item) => Number.isFinite(item));
}

function validateEndEnvelope(end, start, events) {
  if (!isRecord(end) || end.schemaVersion !== SCHEMA_VERSION || !verifySelfDigestSafe(end) ||
      end.runId !== start.runId || end.finalSequence !== events.at(-1).sequence ||
      end.finalEventDigest !== events.at(-1).digest ||
      typeof end.finalStateDigest !== 'string' ||
      end.finalStateDigest !== events.at(-1).payload?.finalStateDigest ||
      end.finalStateDigest !== canonicalDigest(events.at(-1).payload?.finalState)) {
    corrupt('Immutable run end does not bind the replay ledger.', { runId: start.runId });
  }
}

function compareValue(expected, actual, path, sequence) {
  if (safeJson(expected) !== safeJson(actual)) {
    return {
      sequence,
      path,
      expected: cloneForOutput(expected),
      actual: cloneForOutput(actual),
    };
  }
  return null;
}

function inconsistent(runId, firstDifference, state) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    verdict: 'INCONSISTENT',
    firstDifference,
    checkedSequences: firstDifference.sequence,
    finalState: cloneJson(state),
  };
}

function projectObservation(observation) {
  if (!isRecord(observation)) corrupt('World observation is not a record.');
  return {
    schemaVersion: observation.schemaVersion,
    vector: cloneJson(observation.vector),
    stateVersion: observation.stateVersion,
    intervalId: observation.intervalId,
  };
}

function digestWithoutSelf(value) {
  const copy = { ...value };
  delete copy.digest;
  return canonicalDigest(copy);
}

function cloneReplayValue(value, label) {
  try {
    return cloneJson(value);
  } catch (error) {
    corrupt(`${label} is not canonical JSON.`, { cause: errorName(error) });
  }
}

function safeJson(value) {
  try {
    return canonicalJson(value);
  } catch (error) {
    corrupt('Replay comparison encountered non-canonical data.', { cause: errorName(error) });
  }
}

function cloneForOutput(value) {
  try {
    return cloneJson(value);
  } catch {
    return null;
  }
}

function verifySelfDigestSafe(value) {
  try {
    return verifySelfDigest(value);
  } catch {
    return false;
  }
}

function requireRecord(value, field) {
  if (!isRecord(value)) invalid(`${field} must be a record.`);
  return value;
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function corrupt(message, context = {}) {
  throw new ReplayError('CORRUPT', message, context);
}

function invalid(message, context = {}) {
  throw new ReplayError('INVALID_INPUT', message, context);
}

function errorName(error) {
  return error instanceof Error ? error.name : 'NonErrorThrow';
}

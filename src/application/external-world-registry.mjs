import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  canonicalDigest,
  canonicalJson,
  MAX_BOUNDARY_IDENTIFIER_LENGTH,
  MAX_EXECUTION_NONCE_LENGTH,
  MAX_PERSISTED_EXTERNAL_INPUT_BYTES,
  MAX_PERSISTED_WORLD_STATE_BYTES,
  SCHEMA_VERSION,
} from '../runtime/schema.mjs';
import {
  externalInputUnsigned,
  isValidEvidencePublicKey,
  verifyExternalInputAttestation,
} from '../runtime/external-evidence.mjs';
import { LabStoreError } from '../runtime/lab-store.mjs';
import {
  assertExactKeys,
  assertFiniteNumber,
  assertNonNegativeSafeInteger,
  assertSchemaVersion,
  createWorldPort,
  normalizeWorldFactoryOptions,
} from '../worlds/world-port-base.mjs';
import { createWorldRegistry } from './world-registry.mjs';

const PROTOCOL = 'yi-world-cli';
const PROTOCOL_VERSION = 1;
const TOKEN_PATTERN = /^tok_[A-Z0-9]{8,128}$/u;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_EXTERNAL_INPUTS = 64;
const MAX_EVIDENCE_ITEMS = 128;
const MAX_SCENARIO_ID_LENGTH = 4096;

export class ExternalWorldProtocolError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'ExternalWorldProtocolError';
    this.code = 'WORLD_ADAPTER_PROTOCOL';
    this.context = Object.freeze({ ...context });
  }
}

export function loadExternalWorldRegistry(configPath, { probe = true } = {}) {
  const resolvedConfigPath = resolveConfigPath(configPath);
  const configBytes = readBoundedFile(resolvedConfigPath, 'adapter config');
  let config;
  try {
    config = JSON.parse(configBytes.toString('utf8'));
  } catch (error) {
    throw new LabStoreError('INVALID_INPUT', 'Adapter config is not valid JSON.', { field: 'adapter' }, { cause: error });
  }
  const normalizedConfig = normalizeConfig(config, resolvedConfigPath);
  if (!probe) return createIdentityOnlyRegistry(normalizedConfig);
  const client = createAdapterClient(normalizedConfig);
  const descriptor = validateDescriptor(client.request('hello', {}), normalizedConfig);
  const adapterMetadata = {
    schemaVersion: SCHEMA_VERSION,
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    adapterId: descriptor.adapterId,
    worldVersion: descriptor.worldVersion,
    valueSpec: descriptor.valueSpec,
    evidencePublicKey: descriptor.evidencePublicKey,
    descriptorDigest: descriptor.descriptorDigest,
    launchDigest: normalizedConfig.launchDigest,
    ...(descriptor.supportsIdempotentTransitions === undefined
      ? {}
      : { supportsIdempotentTransitions: descriptor.supportsIdempotentTransitions }),
    ...(descriptor.supportsReconciliation === undefined
      ? {}
      : { supportsReconciliation: descriptor.supportsReconciliation }),
  };

  const definition = {
    worldVersion: descriptor.worldVersion,
    worldImplementationDigest: descriptor.descriptorDigest,
    capabilities: descriptor.capabilityIds,
    scenarioIds: descriptor.scenarioIds,
    valueSpec: descriptor.valueSpec,
    factory: (options) => {
      const { manifest, scenario } = normalizeWorldFactoryOptions(
        options,
        descriptor.worldId,
        descriptor.scenarioIds,
      );
      return createExternalWorldPort({
        client,
        descriptor,
        manifest,
        scenario,
      });
    },
    scenarioExternalInputs: ({ scenario, stateVersion }) => {
      const response = client.request('externalInputs', {
        worldId: descriptor.worldId,
        scenario,
        stateVersion,
      });
      return validateExternalInputs(response.inputs, descriptor, scenario, stateVersion);
    },
  };
  const base = createWorldRegistry({ [descriptor.worldId]: definition });

  return Object.freeze({
    ...base,
    createManifestParts(input) {
      return {
        ...base.createManifestParts(input),
        adapter: adapterMetadata,
      };
    },
    assertManifest(manifest) {
      if (manifest.adapter === undefined || canonicalJson(manifest.adapter) !== canonicalJson(adapterMetadata)) {
        throw new LabStoreError('CONFLICT', 'The supplied adapter does not match the lab adapter contract.', {
          field: 'adapter',
        });
      }
      if (manifest.worldVersion !== undefined && manifest.worldVersion !== descriptor.worldVersion) {
        throw new LabStoreError('CONFLICT', 'The supplied WorldPort does not match the lab world contract.', {
          field: 'worldVersion',
          expected: descriptor.worldVersion,
          actual: manifest.worldVersion,
        });
      }
      if (manifest.worldImplementationDigest !== undefined &&
          manifest.worldImplementationDigest !== descriptor.descriptorDigest) {
        throw new LabStoreError('CONFLICT', 'The supplied WorldPort implementation does not match the lab world contract.', {
          field: 'worldImplementationDigest',
          expected: descriptor.descriptorDigest,
          actual: manifest.worldImplementationDigest,
        });
      }
    },
  });
}

function createIdentityOnlyRegistry(config) {
  let boundValueSpec = null;
  const unsupported = () => {
    throw new LabStoreError('CONFLICT', 'This adapter was loaded for a read-only evidence operation.', {});
  };
  return Object.freeze({
    assertManifest(manifest) {
      const adapter = manifest?.adapter;
      if (manifest?.worldId !== config.worldId ||
          adapter?.schemaVersion !== SCHEMA_VERSION ||
          adapter?.protocol !== PROTOCOL ||
          adapter?.version !== PROTOCOL_VERSION ||
          adapter?.adapterId !== config.adapterId ||
          (manifest.worldVersion !== undefined && manifest.worldVersion !== adapter?.worldVersion) ||
          (manifest.worldImplementationDigest !== undefined && manifest.worldImplementationDigest !== adapter?.descriptorDigest) ||
          adapter?.launchDigest !== config.launchDigest ||
          !isValidEvidencePublicKey(adapter?.evidencePublicKey) ||
          !isValueSpec(adapter?.valueSpec)) {
        throw new LabStoreError('CONFLICT', 'The supplied adapter does not match the lab adapter contract.', {
          field: 'adapter',
        });
      }
      boundValueSpec = structuredClone(adapter.valueSpec);
    },
    worldDefinition: unsupported,
    createWorld: unsupported,
    createManifestParts: unsupported,
    valueSpec() {
      if (boundValueSpec === null) unsupported();
      return structuredClone(boundValueSpec);
    },
    scenarioExternalInputs: () => [],
  });
}

export function createReplayWorld(run) {
  const start = run?.start;
  const steps = Array.isArray(run?.events)
    ? run.events.filter((event) => event?.kind === 'STEP')
    : [];
  let cursor = 0;

  function currentStep() {
    const event = steps[cursor];
    if (!event) throw new Error('Replay evidence tape has no STEP at the current cursor.');
    return event;
  }

  function expectedState() {
    return cursor === 0
      ? start.initialState.worldState
      : steps[cursor - 1].payload.afterState.worldState;
  }

  return {
    initialState() {
      return structuredClone(start.initialState.worldState);
    },
    actions() {
      const capabilities = currentStep().payload.boundary?.capabilities;
      if (!Array.isArray(capabilities)) throw new Error('Replay evidence tape is missing capabilities.');
      return structuredClone(capabilities);
    },
    observe(state) {
      const event = currentStep();
      if (canonicalJson(state) !== canonicalJson(expectedState())) {
        throw new Error('Replay evidence tape state cursor does not match.');
      }
      return structuredClone(event.payload.beforeObservation);
    },
    transition(state, request) {
      const event = currentStep();
      const payload = event.payload;
      if (canonicalJson(state) !== canonicalJson(expectedState()) ||
          request.executionNonce !== payload.receipt.executionNonce ||
          request.token !== payload.receipt.token) {
        throw new Error('Replay evidence tape transition request does not match.');
      }
      cursor += 1;
      return {
        nextWorldState: structuredClone(payload.afterState.worldState),
        receipt: structuredClone(payload.receipt),
        postObservation: structuredClone(payload.postObservation),
      };
    },
  };
}

function createAdapterClient(config) {
  let requestNumber = 0;
  return {
    request(op, payload) {
      requestNumber += 1;
      const request = {
        protocol: PROTOCOL,
        version: PROTOCOL_VERSION,
        id: String(requestNumber),
        op,
        payload,
      };
      let result;
      try {
        result = spawnSync(config.executable, config.args, {
          input: `${JSON.stringify(request)}\n`,
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
          detached: false,
          timeout: config.timeoutMs,
          maxBuffer: Math.max(MAX_STDOUT_BYTES, MAX_STDERR_BYTES),
          env: safeAdapterEnvironment(),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        throw new ExternalWorldProtocolError('External WorldPort process could not be started.', {
          op,
          cause: errorName(error),
        });
      }
      if (result.error || result.status !== 0 || result.signal !== null) {
        throw new ExternalWorldProtocolError('External WorldPort process failed.', {
          op,
          status: result.status,
          signal: result.signal,
          cause: errorName(result.error),
        });
      }
      const stdout = typeof result.stdout === 'string' ? result.stdout : '';
      if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
        throw new ExternalWorldProtocolError('External WorldPort response exceeded the output limit.', { op });
      }
      const lines = stdout.split(/\r?\n/u);
      const nonEmpty = lines.filter((line) => line.length > 0);
      if (nonEmpty.length !== 1 || (lines.length > 2 && lines.slice(1, -1).some((line) => line.length > 0))) {
        throw new ExternalWorldProtocolError('External WorldPort stdout must contain exactly one JSONL response.', { op });
      }
      let response;
      try {
        response = JSON.parse(nonEmpty[0]);
      } catch (error) {
        throw new ExternalWorldProtocolError('External WorldPort response is not valid JSON.', { op, cause: errorName(error) });
      }
      validateResponseEnvelope(response, request.id, op);
      if (response.ok !== true) {
        throw new ExternalWorldProtocolError('External WorldPort rejected a request.', { op });
      }
      return response.result;
    },
  };
}

function createExternalWorldPort({ client, descriptor, manifest, scenario }) {
  const worldManifest = {
    schemaVersion: manifest.schemaVersion,
    tokenMap: manifest.tokenMap,
    authorityPolicy: manifest.authorityPolicy,
  };
  const capturedManifest = canonicalJson(worldManifest);

  return {
    supportsIdempotentTransitions: descriptor.supportsIdempotentTransitions === true,
    supportsExternalReconciliation: descriptor.supportsReconciliation === true,
    initialState() {
      const response = client.request('initialState', {
        worldId: descriptor.worldId,
        scenario,
        seed: manifest.seed,
        manifest: worldManifest,
      });
      return normalizeExternalState(response.state, descriptor.worldId, 'initialState');
    },
    observe(state) {
      const response = client.request('observe', { worldId: descriptor.worldId, scenario, state });
      return normalizeExternalObservation(
        response.observation,
        descriptor.worldId,
        'observe',
        state.stateVersion,
        descriptor.valueSpec.observationDimensions,
      );
    },
    actions(suppliedManifest, state = undefined) {
      if (canonicalJson(suppliedManifest) !== capturedManifest) {
        throw new ExternalWorldProtocolError('External WorldPort received a different manifest.', { op: 'actions' });
      }
      const response = client.request('actions', {
        worldId: descriptor.worldId,
        scenario,
        manifest: worldManifest,
        ...(descriptor.supportsStateDependentActions === true && state !== undefined
          ? { state: structuredClone(state) }
          : {}),
      });
      return normalizeExternalActions(response.actions, worldManifest, descriptor);
    },
    transition(state, request) {
      const response = client.request('transition', {
        worldId: descriptor.worldId,
        scenario,
        state,
        request,
      });
      return normalizeExternalTransition(
        response,
        state,
        request,
        descriptor.worldId,
        descriptor.valueSpec.observationDimensions,
      );
    },
    reconcile(state, request) {
      if (descriptor.supportsReconciliation !== true) {
        throw new ExternalWorldProtocolError('External WorldPort does not support reconciliation.', { op: 'reconcile' });
      }
      const response = client.request('reconcile', {
        worldId: descriptor.worldId,
        scenario,
        state,
        request,
      });
      return normalizeExternalReconciliation(
        response,
        state,
        request,
        descriptor.worldId,
        descriptor.valueSpec.observationDimensions,
      );
    },
  };
}

function normalizeExternalState(value, worldId, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ExternalWorldProtocolError('External WorldPort state must be a plain object.', { field });
  }
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new ExternalWorldProtocolError('External WorldPort state contains a reserved field.', { field });
    }
  }
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    !isBoundedIdentifier(value.stateVersion) ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    !Array.isArray(value.usedExecutionNonces) || value.usedExecutionNonces.length > 8 ||
    value.usedExecutionNonces.some((nonce) => !isBoundedExecutionNonce(nonce)) ||
    new Set(value.usedExecutionNonces).size !== value.usedExecutionNonces.length
  ) {
    throw new ExternalWorldProtocolError('External WorldPort state violates the base state contract.', { field });
  }
  let stateBytes;
  try {
    stateBytes = Buffer.byteLength(canonicalJson(value), 'utf8');
  } catch (error) {
    throw new ExternalWorldProtocolError('External WorldPort state is not canonical JSON.', {
      field,
      cause: error instanceof Error ? error.name : 'NonErrorThrow',
    });
  }
  if (stateBytes > MAX_PERSISTED_WORLD_STATE_BYTES) {
    throw new ExternalWorldProtocolError('External WorldPort state exceeds the persistence budget.', {
      field,
      maxBytes: MAX_PERSISTED_WORLD_STATE_BYTES,
      actualBytes: stateBytes,
    });
  }
  return structuredClone(value);
}

function normalizeExternalObservation(value, worldId, field, expectedStateVersion, expectedDimensions) {
  const source = assertExactKeys(
    value,
    ['schemaVersion', 'vector', 'stateVersion', 'intervalId', 'evidence', 'feedback'],
    field,
    ['schemaVersion', 'vector', 'stateVersion', 'intervalId', 'evidence'],
  );
  assertSchemaVersion(source.schemaVersion, field);
  if (!Array.isArray(source.vector) ||
      source.vector.length === 0 ||
      (expectedDimensions !== undefined && source.vector.length !== expectedDimensions) ||
      source.vector.some((item) => !Number.isFinite(item)) ||
      (expectedStateVersion !== undefined && source.stateVersion !== expectedStateVersion)) {
    throw new ExternalWorldProtocolError('External WorldPort observation vector is invalid.', { field });
  }
  assertBoundedIdentifier(source.stateVersion, `${field}.stateVersion`);
  assertBoundedIdentifier(source.intervalId, `${field}.intervalId`);
  if (!Array.isArray(source.evidence) || source.evidence.length > MAX_EVIDENCE_ITEMS) {
    throw new ExternalWorldProtocolError('External WorldPort observation evidence is invalid.', { field });
  }
  if (source.feedback !== undefined) validateExternalFeedback(source.feedback, field, expectedDimensions);
  return structuredClone(source);
}

function validateExternalFeedback(value, field, expectedDimensions) {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_ITEMS) {
    throw new ExternalWorldProtocolError('External WorldPort observation feedback is invalid.', { field });
  }
  const seen = new Set();
  value.forEach((item, index) => {
    const itemField = `${field}.feedback[${index}]`;
    const source = assertExactKeys(item, [
      'schemaVersion', 'executionNonce', 'stateVersion', 'intervalId', 'vector', 'confounderCount',
    ], itemField);
    if (source.schemaVersion !== SCHEMA_VERSION ||
        !isBoundedExecutionNonce(source.executionNonce) ||
        seen.has(source.executionNonce) ||
        !isBoundedIdentifier(source.stateVersion) ||
        !isBoundedIdentifier(source.intervalId) ||
        !Array.isArray(source.vector) || source.vector.length === 0 ||
        (expectedDimensions !== undefined && source.vector.length !== expectedDimensions) ||
        source.vector.some((number) => !Number.isFinite(number)) ||
        !Number.isSafeInteger(source.confounderCount) || source.confounderCount < 0) {
      throw new ExternalWorldProtocolError('External WorldPort observation feedback is invalid.', { field: itemField });
    }
    seen.add(source.executionNonce);
  });
}

function isBoundedIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_BOUNDARY_IDENTIFIER_LENGTH;
}

function isBoundedExecutionNonce(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_EXECUTION_NONCE_LENGTH;
}

function assertBoundedIdentifier(value, field) {
  if (!isBoundedIdentifier(value)) {
    throw new ExternalWorldProtocolError('External WorldPort boundary identifier is invalid.', { field });
  }
  return value;
}

function normalizeExternalActions(value, manifest, descriptor) {
  if (!Array.isArray(value) || value.length !== descriptor.capabilityIds.length) {
    throw new ExternalWorldProtocolError('External WorldPort actions do not cover the descriptor capability set.', { op: 'actions' });
  }
  const expected = new Map(manifest.tokenMap.entries.map((entry) => [entry.token, entry]));
  const seen = new Set();
  return value.map((item, index) => {
    const source = assertExactKeys(item, ['schemaVersion', 'token', 'cost', 'allowed', 'safe'], `actions[${index}]`);
    assertSchemaVersion(source.schemaVersion, `actions[${index}]`);
    if (!TOKEN_PATTERN.test(source.token) || !expected.has(source.token) || seen.has(source.token) ||
        !Number.isFinite(source.cost) || source.cost < 0 || typeof source.allowed !== 'boolean' || typeof source.safe !== 'boolean') {
      throw new ExternalWorldProtocolError('External WorldPort returned an invalid action set.', { op: 'actions' });
    }
    seen.add(source.token);
    const policy = manifest.authorityPolicy.capabilities[expected.get(source.token).capabilityId];
    return {
      schemaVersion: SCHEMA_VERSION,
      token: source.token,
      cost: policy.cost,
      allowed: policy.allowed && source.allowed,
      safe: policy.safe && source.safe,
    };
  });
}

function normalizeExternalTransition(value, state, request, worldId, expectedDimensions) {
  const source = assertExactKeys(value, ['nextWorldState', 'receipt', 'postObservation'], 'transition');
  const nextWorldState = normalizeExternalState(source.nextWorldState, worldId, 'transition.nextWorldState');
  const receipt = normalizeExternalReceipt(source.receipt, request, 'transition.receipt');
  const postObservation = normalizeExternalObservation(
    source.postObservation,
    worldId,
    'transition.postObservation',
    nextWorldState.stateVersion,
    expectedDimensions,
  );
  if (receipt.status === 'ACCEPTED') {
    if (nextWorldState.revision !== state.revision + 1 ||
        nextWorldState.usedExecutionNonces.at(-1) !== request.executionNonce ||
        nextWorldState.usedExecutionNonces.length > 8 ||
        !hasNonceWindowPrefix(state.usedExecutionNonces, nextWorldState.usedExecutionNonces)) {
      throw new ExternalWorldProtocolError('Accepted external transition does not advance state and nonce.', { op: 'transition' });
    }
    if (receipt.effectDigest !== canonicalDigest(nextWorldState)) {
      throw new ExternalWorldProtocolError('Accepted external transition effect digest is not state-bound.', { op: 'transition' });
    }
  } else if (canonicalJson(nextWorldState) !== canonicalJson(state)) {
    throw new ExternalWorldProtocolError('Rejected external transition changed state.', { op: 'transition' });
  } else if (receipt.effectDigest !== canonicalDigest(state)) {
    throw new ExternalWorldProtocolError('Rejected external transition effect digest is not state-bound.', { op: 'transition' });
  }
  return { nextWorldState, receipt, postObservation };
}

function normalizeExternalReconciliation(value, state, request, worldId, expectedDimensions) {
  const source = assertExactKeys(value, ['status', 'transition'], 'reconcile', ['status']);
  if (!['APPLIED', 'ABSENT', 'UNKNOWN'].includes(source.status)) {
    throw new ExternalWorldProtocolError('External WorldPort reconciliation status is invalid.', { op: 'reconcile' });
  }
  if (source.status !== 'APPLIED') {
    if (source.transition !== undefined) {
      throw new ExternalWorldProtocolError('A non-applied reconciliation cannot contain a transition result.', { op: 'reconcile' });
    }
    return { status: source.status };
  }
  if (source.transition === null || typeof source.transition !== 'object' || Array.isArray(source.transition)) {
    throw new ExternalWorldProtocolError('Applied reconciliation must contain a transition result.', { op: 'reconcile' });
  }
  const transition = normalizeExternalTransition(
    source.transition,
    state,
    request,
    worldId,
    expectedDimensions,
  );
  if (transition.receipt.status !== 'ACCEPTED') {
    throw new ExternalWorldProtocolError('Applied reconciliation must contain an accepted transition.', { op: 'reconcile' });
  }
  return {
    status: 'APPLIED',
    transition,
  };
}

function hasNonceWindowPrefix(previous, next) {
  if (next.length < 1 || next.at(-1) === undefined) return false;
  const expected = [...previous, next.at(-1)].slice(-8);
  return canonicalJson(next) === canonicalJson(expected);
}

function normalizeExternalReceipt(value, request, field) {
  const source = assertExactKeys(value, [
    'schemaVersion', 'status', 'token', 'basedOnVersion', 'policyVersion', 'constraintsDigest',
    'executionNonce', 'effectDigest', 'rejectionReason', 'attributionWindowComplete', 'confounderCount',
  ], field);
  if (
    source.schemaVersion !== SCHEMA_VERSION || !['ACCEPTED', 'REJECTED'].includes(source.status) ||
    source.token !== request.token || source.basedOnVersion !== request.basedOnVersion ||
    source.policyVersion !== request.policyVersion || source.constraintsDigest !== request.constraintsDigest ||
    source.executionNonce !== request.executionNonce || !/^sha256:[0-9a-f]{64}$/u.test(source.effectDigest) ||
    (source.status === 'ACCEPTED' ? source.rejectionReason !== null : typeof source.rejectionReason !== 'string' || source.rejectionReason.length === 0) ||
    typeof source.attributionWindowComplete !== 'boolean' || !Number.isSafeInteger(source.confounderCount) || source.confounderCount < 0
  ) {
    throw new ExternalWorldProtocolError('External WorldPort receipt is not bound to the request.', { field });
  }
  return structuredClone(source);
}

function validateDescriptor(value, config) {
  const source = assertExactKeys(value, [
    'adapterId', 'worldId', 'worldVersion', 'capabilityIds', 'scenarioIds', 'valueSpec', 'evidencePublicKey',
    'supportsStateDependentActions', 'supportsIdempotentTransitions', 'supportsReconciliation', 'descriptorDigest',
  ], 'hello.result', [
    'adapterId', 'worldId', 'worldVersion', 'capabilityIds', 'scenarioIds', 'valueSpec', 'evidencePublicKey', 'descriptorDigest',
  ]);
  if (source.adapterId !== config.adapterId || source.worldId !== config.worldId ||
      typeof source.worldVersion !== 'string' || source.worldVersion.length === 0 || source.worldVersion.length > 4096 ||
      !validStringList(source.capabilityIds, 'capabilityIds') || !validStringList(source.scenarioIds, 'scenarioIds') ||
      !isValueSpec(source.valueSpec) || !isValidEvidencePublicKey(source.evidencePublicKey) ||
      (source.supportsStateDependentActions !== undefined && typeof source.supportsStateDependentActions !== 'boolean') ||
      (source.supportsIdempotentTransitions !== undefined && typeof source.supportsIdempotentTransitions !== 'boolean') ||
      (source.supportsReconciliation !== undefined && typeof source.supportsReconciliation !== 'boolean') ||
      source.descriptorDigest !== canonicalDigest({
        adapterId: source.adapterId,
        worldId: source.worldId,
        worldVersion: source.worldVersion,
        capabilityIds: source.capabilityIds,
        scenarioIds: source.scenarioIds,
        valueSpec: source.valueSpec,
        evidencePublicKey: source.evidencePublicKey,
        ...(source.supportsStateDependentActions === undefined
          ? {}
          : { supportsStateDependentActions: source.supportsStateDependentActions }),
        ...(source.supportsIdempotentTransitions === undefined
          ? {}
          : { supportsIdempotentTransitions: source.supportsIdempotentTransitions }),
        ...(source.supportsReconciliation === undefined
          ? {}
          : { supportsReconciliation: source.supportsReconciliation }),
      })) {
    throw new ExternalWorldProtocolError('External WorldPort hello descriptor is invalid.', { op: 'hello' });
  }
  return source;
}

function validateExternalInputs(value, descriptor, scenario, stateVersion) {
  if (!Array.isArray(value) || value.length > MAX_EXTERNAL_INPUTS) {
    throw new ExternalWorldProtocolError('External WorldPort externalInputs are invalid.', { op: 'externalInputs' });
  }
  const normalized = value.map((item, index) => {
    const source = assertExactKeys(item, ['schemaVersion', 'source', 'kind', 'payload', 'appliedBeforeVersion', 'digest', 'attestation'], `externalInputs[${index}]`);
    if (source.schemaVersion !== SCHEMA_VERSION || source.source !== 'scenario' || source.kind !== scenario ||
        source.appliedBeforeVersion !== stateVersion || source.payload === null || typeof source.payload !== 'object' || Array.isArray(source.payload) ||
        source.digest !== canonicalDigest(externalInputUnsigned(source)) ||
        !verifyExternalInputAttestation(source, descriptor.evidencePublicKey)) {
      throw new ExternalWorldProtocolError('External WorldPort external input is not canonical.', { op: 'externalInputs' });
    }
    return structuredClone(source);
  });
  let inputBytes;
  try {
    inputBytes = Buffer.byteLength(canonicalJson(normalized), 'utf8');
  } catch (error) {
    throw new ExternalWorldProtocolError('External WorldPort externalInputs are not canonical JSON.', {
      op: 'externalInputs',
      cause: error instanceof Error ? error.name : 'NonErrorThrow',
    });
  }
  if (inputBytes > MAX_PERSISTED_EXTERNAL_INPUT_BYTES) {
    throw new ExternalWorldProtocolError('External WorldPort externalInputs exceed the persistence budget.', {
      op: 'externalInputs',
      maxBytes: MAX_PERSISTED_EXTERNAL_INPUT_BYTES,
      actualBytes: inputBytes,
    });
  }
  return normalized;
}

function normalizeConfig(value, configPath) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LabStoreError('INVALID_INPUT', 'Adapter config must be an object.', { field: 'adapter' });
  }
  const allowed = new Set(['executable', 'args', 'adapterId', 'worldId', 'timeoutMs']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new LabStoreError('INVALID_INPUT', 'Adapter config contains an unsupported field.', { field: 'adapter' });
  }
  if (typeof value.executable !== 'string' || !path.isAbsolute(value.executable) || /(?:cmd|powershell)(?:\.exe)?$/iu.test(path.basename(value.executable))) {
    throw new LabStoreError('INVALID_INPUT', 'Adapter executable must be an absolute non-shell executable path.', { field: 'adapter.executable' });
  }
  let executableStatus;
  try {
    executableStatus = lstatSync(value.executable);
  } catch (error) {
    throw new LabStoreError('INVALID_INPUT', 'Adapter executable does not exist.', { field: 'adapter.executable' }, { cause: error });
  }
  if (!executableStatus.isFile() || executableStatus.isSymbolicLink() || !statSync(value.executable).isFile()) {
    throw new LabStoreError('INVALID_INPUT', 'Adapter executable must be a regular non-symlink file.', { field: 'adapter.executable' });
  }
  if (!Array.isArray(value.args) || value.args.length === 0 || value.args.length > 64 || value.args.some((arg) => typeof arg !== 'string' || arg.length > 4096)) {
    throw new LabStoreError('INVALID_INPUT', 'Adapter args must be a bounded string array.', { field: 'adapter.args' });
  }
  if (typeof value.adapterId !== 'string' || value.adapterId.length === 0 || value.adapterId.length > 4096 ||
      typeof value.worldId !== 'string' || value.worldId.length === 0 || value.worldId.length > 4096) {
    throw new LabStoreError('INVALID_INPUT', 'Adapter identity is invalid.', { field: 'adapter' });
  }
  const timeoutMs = value.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new LabStoreError('INVALID_INPUT', 'Adapter timeoutMs must be between 100 and 30000.', { field: 'adapter.timeoutMs' });
  }
  const launchDigest = digestLaunch(configPath, value.executable, value.args);
  return { executable: value.executable, args: [...value.args], adapterId: value.adapterId, worldId: value.worldId, timeoutMs, launchDigest };
}

function digestLaunch(configPath, executable, args) {
  const hash = createHash('sha256');
  hash.update(readBoundedFile(configPath, 'adapter config'));
  hash.update(readBoundedFile(executable, 'adapter executable', MAX_EXECUTABLE_BYTES));
  for (const arg of args) {
    hash.update(Buffer.from(`\0${arg}`, 'utf8'));
  }
  return `sha256:${hash.digest('hex')}`;
}

function resolveConfigPath(value) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new LabStoreError('INVALID_INPUT', 'adapter must be an absolute config path.', { field: 'adapter' });
  }
  return path.normalize(value);
}

function readBoundedFile(filePath, label, maxBytes = MAX_CONFIG_BYTES) {
  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    throw new LabStoreError('INVALID_INPUT', `${label} could not be read.`, { field: 'adapter' }, { cause: error });
  }
  if (bytes.length > maxBytes) {
    throw new LabStoreError('INVALID_INPUT', `${label} exceeds the size limit.`, { field: 'adapter' });
  }
  return bytes;
}

function validateResponseEnvelope(value, id, op) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value.protocol !== PROTOCOL || value.version !== PROTOCOL_VERSION || value.id !== id ||
      typeof value.ok !== 'boolean' ||
      (value.ok ? !Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error') : !Object.hasOwn(value, 'error') || typeof value.error !== 'string')) {
    throw new ExternalWorldProtocolError('External WorldPort response envelope is invalid.', { op });
  }
}

function safeAdapterEnvironment() {
  const environment = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

function validStringList(value, field) {
  return Array.isArray(value) && value.length > 0 && value.length <= 256 &&
    value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_SCENARIO_ID_LENGTH) &&
    new Set(value).size === value.length;
}

function isValueSpec(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(value.observationDimensions) || value.observationDimensions < 1 || value.observationDimensions > 1024 ||
      !Array.isArray(value.weights) || !Array.isArray(value.target) || value.weights.length !== value.observationDimensions || value.target.length !== value.observationDimensions) return false;
  return value.weights.every((item) => Number.isFinite(item)) && value.target.every((item) => Number.isFinite(item));
}

function errorName(error) {
  return error instanceof Error ? error.name : 'NonErrorThrow';
}

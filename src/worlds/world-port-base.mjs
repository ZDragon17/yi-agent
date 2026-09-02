import { createHash } from 'node:crypto';
import { MAX_PERSISTED_WORLD_STATE_BYTES } from '../runtime/schema.mjs';

const SCHEMA_VERSION = 1;
const TOKEN_PATTERN = /^tok_[A-Z0-9]{8,128}$/u;
const ACTION_REQUEST_KEYS = [
  'schemaVersion',
  'token',
  'basedOnVersion',
  'policyVersion',
  'constraintsDigest',
  'executionNonce',
];
const RECEIPT_FALLBACK_TOKEN = 'tok_REJECTED000';
const MAX_TEXT_LENGTH = 512;
const MAX_RECENT_NONCES = 8;

export class WorldPortContractError extends Error {
  constructor(message, context) {
    super(message);
    this.name = 'WorldPortContractError';
    this.code = 'WORLD_PORT_CONTRACT_VIOLATION';
    this.context = { ...context };
  }
}

export function normalizeWorldFactoryOptions(options, worldId, scenarios) {
  const source = snapshotClosedRecord(
    options,
    ['manifest', 'scenario'],
    ['manifest'],
    `${worldId}.factoryOptions`,
  );

  const scenario = source.scenario ?? 'steady';
  if (typeof scenario !== 'string' || !scenarios.includes(scenario)) {
    contractViolation('world factory scenario is not supported', {
      field: `${worldId}.factoryOptions.scenario`,
    });
  }

  return { manifest: source.manifest, scenario };
}

export function createWorldPort({
  worldId,
  manifest,
  scenario,
  capabilityIds,
  makeInitialDomainState,
  normalizeState,
  observeVector,
  scenarioEvidence,
  projectCapability,
  applyEffect,
}) {
  const capturedManifest = normalizeManifest(manifest, capabilityIds, worldId);
  const manifestFingerprint = canonicalJson(capturedManifest);

  function initialState() {
    const state = {
      schemaVersion: SCHEMA_VERSION,
      stateVersion: formatStateVersion(worldId, 0),
      revision: 0,
      ...makeInitialDomainState(),
      usedExecutionNonces: [],
    };

    return normalizeAndCheckState(state);
  }

  function observe(state) {
    return buildObservation(normalizeAndCheckState(state));
  }

  function actions(suppliedManifest, suppliedState = undefined) {
    const normalizedManifest = normalizeManifest(
      suppliedManifest,
      capabilityIds,
      worldId,
    );

    if (canonicalJson(normalizedManifest) !== manifestFingerprint) {
      contractViolation('actions manifest does not match the world manifest', {
        field: `${worldId}.actions.manifest`,
      });
    }

    const state = suppliedState === undefined
      ? undefined
      : normalizeAndCheckState(suppliedState);

    return capabilityIds.map((capabilityId) => {
      const entry = normalizedManifest.tokenMap.entries.find(
        (candidate) => candidate.capabilityId === capabilityId,
      );
      const policy = effectivePolicy(normalizedManifest, capabilityId, state);

      return {
        schemaVersion: SCHEMA_VERSION,
        token: entry.token,
        cost: policy.cost,
        allowed: policy.allowed,
        safe: policy.safe,
      };
    });
  }

  function transition(state, request) {
    const currentState = normalizeAndCheckState(state);
    const requestResult = normalizeActionRequest(request);

    if (!requestResult.ok) {
      return rejectedTransition(
        currentState,
        requestResult.receiptFields,
        'MALFORMED_REQUEST',
        null,
      );
    }

    const normalizedRequest = requestResult.value;
    const tokenEntry = capturedManifest.tokenMap.entries.find(
      (entry) => entry.token === normalizedRequest.token,
    );

    if (!tokenEntry) {
      return rejectedTransition(
        currentState,
        normalizedRequest,
        'UNKNOWN_TOKEN',
        null,
      );
    }

    const capabilityId = tokenEntry.capabilityId;
    if (normalizedRequest.basedOnVersion !== currentState.stateVersion) {
      return rejectedTransition(
        currentState,
        normalizedRequest,
        'STALE_STATE_VERSION',
        capabilityId,
      );
    }

    if (
      normalizedRequest.policyVersion !==
      capturedManifest.authorityPolicy.policyVersion
    ) {
      return rejectedTransition(
        currentState,
        normalizedRequest,
        'STALE_POLICY_VERSION',
        capabilityId,
      );
    }

    if (
      normalizedRequest.constraintsDigest !==
      capturedManifest.authorityPolicy.constraintsDigest
    ) {
      return rejectedTransition(
        currentState,
        normalizedRequest,
        'CONSTRAINTS_DIGEST_MISMATCH',
        capabilityId,
      );
    }

    if (currentState.usedExecutionNonces.includes(normalizedRequest.executionNonce)) {
      return rejectedTransition(
        currentState,
        normalizedRequest,
        'REUSED_EXECUTION_NONCE',
        capabilityId,
      );
    }

    const policy = effectivePolicy(capturedManifest, capabilityId, currentState);
    if (!policy.allowed) {
      return rejectedTransition(
        currentState,
        normalizedRequest,
        'ACTION_NOT_ALLOWED',
        capabilityId,
      );
    }

    if (!policy.safe) {
      return rejectedTransition(
        currentState,
        normalizedRequest,
        'ACTION_UNSAFE',
        capabilityId,
      );
    }

    if (scenario === 'execution-rejected') {
      return rejectedTransition(
        currentState,
        normalizedRequest,
        'SCENARIO_EXECUTION_REJECTED',
        capabilityId,
      );
    }

    const effect = applyEffect({
      state: cloneData(currentState),
      capabilityId,
      scenario,
    });
    const normalizedEffect = normalizeEffect(effect, worldId);

    if (!normalizedEffect.accepted) {
      return rejectedTransition(
        currentState,
        normalizedRequest,
        normalizedEffect.rejectionReason,
        capabilityId,
      );
    }

    if (currentState.revision === Number.MAX_SAFE_INTEGER) {
      contractViolation('world state revision cannot be incremented safely', {
        field: `${worldId}.state.revision`,
      });
    }

    const revision = currentState.revision + 1;
    const nextWorldState = normalizeAndCheckState({
      ...cloneData(currentState),
      ...normalizedEffect.patch,
      stateVersion: formatStateVersion(worldId, revision),
      revision,
      usedExecutionNonces: [
        ...currentState.usedExecutionNonces.slice(-(MAX_RECENT_NONCES - 1)),
        normalizedRequest.executionNonce,
      ],
    });
    const receipt = buildReceipt({
      request: normalizedRequest,
      status: 'ACCEPTED',
      rejectionReason: null,
      effectDigest: digestEffect({
        worldId,
        scenario,
        capabilityId,
        status: 'ACCEPTED',
        basedOnVersion: currentState.stateVersion,
        nextWorldState,
      }),
    });

    return {
      nextWorldState,
      receipt,
      postObservation: buildObservation(nextWorldState),
    };
  }

  function normalizeAndCheckState(state) {
    const normalized = normalizeState(state);
    assertSchemaVersion(normalized.schemaVersion, `${worldId}.state.schemaVersion`);
    assertNonNegativeSafeInteger(normalized.revision, `${worldId}.state.revision`);
    assertNonEmptyString(normalized.stateVersion, `${worldId}.state.stateVersion`);

    if (normalized.stateVersion !== formatStateVersion(worldId, normalized.revision)) {
      contractViolation('world state version does not match its revision', {
        field: `${worldId}.state.stateVersion`,
      });
    }

    normalized.usedExecutionNonces = normalizeUsedExecutionNonces(
      normalized.usedExecutionNonces,
      `${worldId}.state.usedExecutionNonces`,
    );
    const stateBytes = Buffer.byteLength(canonicalJson(normalized), 'utf8');
    if (stateBytes > MAX_PERSISTED_WORLD_STATE_BYTES) {
      contractViolation('world state exceeds the persistence budget', {
        field: `${worldId}.state`,
        maxBytes: MAX_PERSISTED_WORLD_STATE_BYTES,
        actualBytes: stateBytes,
      });
    }
    return normalized;
  }

  function buildObservation(state) {
    const vector = observeVector(cloneData(state));
    if (
      !Array.isArray(vector) ||
      vector.length === 0 ||
      !vector.every(Number.isFinite)
    ) {
      contractViolation('world observation vector must contain finite numbers', {
        field: `${worldId}.observation.vector`,
      });
    }

    const evidence = scenarioEvidence({ state: cloneData(state), scenario });
    if (!Array.isArray(evidence)) {
      contractViolation('world observation evidence must be an array', {
        field: `${worldId}.observation.evidence`,
      });
    }
    for (const [index, item] of evidence.entries()) {
      assertPlainRecord(item, `${worldId}.observation.evidence[${index}]`);
      assertNonEmptyString(
        item.kind,
        `${worldId}.observation.evidence[${index}].kind`,
      );
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      vector: [...vector],
      stateVersion: state.stateVersion,
      intervalId: `${worldId}:interval:${state.revision}`,
      evidence: cloneData(evidence),
    };
  }

  function effectivePolicy(normalizedManifest, capabilityId, state = undefined) {
    const authority = normalizedManifest.authorityPolicy.capabilities[capabilityId];
    const projected = projectCapability({
      capabilityId,
      authority: { ...authority },
      ...(state === undefined ? {} : { state: cloneData(state) }),
      scenario,
    });
    const projection = assertExactKeys(
      projected,
      ['allowed', 'safe'],
      `${worldId}.capabilityProjection`,
    );

    return {
      cost: authority.cost,
      allowed: assertBoolean(
        projection.allowed,
        `${worldId}.capabilityProjection.allowed`,
      ),
      safe: assertBoolean(
        projection.safe,
        `${worldId}.capabilityProjection.safe`,
      ),
    };
  }

  function rejectedTransition(currentState, requestFields, reason, capabilityId) {
    const nextWorldState = cloneData(currentState);
    const receipt = buildReceipt({
      request: requestFields,
      status: 'REJECTED',
      rejectionReason: reason,
      effectDigest: digestEffect({
        worldId,
        scenario,
        capabilityId,
        status: 'REJECTED',
        basedOnVersion: currentState.stateVersion,
        rejectionReason: reason,
        nextWorldState,
      }),
    });

    return {
      nextWorldState,
      receipt,
      postObservation: buildObservation(currentState),
    };
  }

  function buildReceipt({ request, status, rejectionReason, effectDigest }) {
    return {
      schemaVersion: SCHEMA_VERSION,
      status,
      token: request.token,
      basedOnVersion: request.basedOnVersion,
      policyVersion: request.policyVersion,
      constraintsDigest: request.constraintsDigest,
      executionNonce: request.executionNonce,
      effectDigest,
      rejectionReason,
      attributionWindowComplete: scenario !== 'external-during-step',
      confounderCount: scenario === 'external-during-step' ? 1 : 0,
    };
  }

  return { initialState, observe, actions, transition };
}

export function assertPlainRecord(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    contractViolation('expected a plain record', { field });
  }

  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch (error) {
    contractViolation('plain-record prototype inspection failed', {
      field,
      cause: errorName(error),
    });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    contractViolation('expected a plain record', { field });
  }

  return value;
}

export function assertExactKeys(value, expectedKeys, field, requiredKeys = expectedKeys) {
  return snapshotClosedRecord(value, expectedKeys, requiredKeys, field);
}

export function assertSchemaVersion(value, field) {
  if (value !== SCHEMA_VERSION) {
    contractViolation('unsupported schema version', { field });
  }
  return value;
}

export function assertNonEmptyString(value, field) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TEXT_LENGTH
  ) {
    contractViolation('expected a bounded non-empty string', { field });
  }
  return value;
}

export function assertBoolean(value, field) {
  if (typeof value !== 'boolean') {
    contractViolation('expected a boolean', { field });
  }
  return value;
}

export function assertFiniteNumber(value, field) {
  if (!Number.isFinite(value)) {
    contractViolation('expected a finite number', { field });
  }
  return value;
}

export function assertNonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    contractViolation('expected a non-negative safe integer', { field });
  }
  return value;
}

export function assertOneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    contractViolation('value is outside the closed set', { field });
  }
  return value;
}

export function contractViolation(message, context) {
  throw new WorldPortContractError(message, context);
}

function normalizeManifest(value, capabilityIds, worldId) {
  const source = assertExactKeys(
    value,
    ['schemaVersion', 'tokenMap', 'authorityPolicy'],
    `${worldId}.manifest`,
  );
  assertSchemaVersion(source.schemaVersion, `${worldId}.manifest.schemaVersion`);

  const tokenMap = assertExactKeys(
    source.tokenMap,
    ['schemaVersion', 'entries', 'digest'],
    `${worldId}.manifest.tokenMap`,
  );
  assertSchemaVersion(
    tokenMap.schemaVersion,
    `${worldId}.manifest.tokenMap.schemaVersion`,
  );
  if (!Array.isArray(tokenMap.entries) || tokenMap.entries.length !== capabilityIds.length) {
    contractViolation('token map must cover the capability closed set exactly', {
      field: `${worldId}.manifest.tokenMap.entries`,
    });
  }

  const entries = tokenMap.entries.map((valueEntry, index) => {
    const entry = assertExactKeys(
      valueEntry,
      ['token', 'capabilityId'],
      `${worldId}.manifest.tokenMap.entries[${index}]`,
    );
    const token = assertOpaqueToken(
      entry.token,
      `${worldId}.manifest.tokenMap.entries[${index}].token`,
    );
    const capabilityId = assertNonEmptyString(
      entry.capabilityId,
      `${worldId}.manifest.tokenMap.entries[${index}].capabilityId`,
    );
    return { token, capabilityId };
  });

  if (
    new Set(entries.map((entry) => entry.token)).size !== entries.length ||
    new Set(entries.map((entry) => entry.capabilityId)).size !== entries.length ||
    capabilityIds.some(
      (capabilityId) => !entries.some((entry) => entry.capabilityId === capabilityId),
    )
  ) {
    contractViolation('token map contains duplicates or unknown capabilities', {
      field: `${worldId}.manifest.tokenMap.entries`,
    });
  }

  const tokenMapDigest = assertNonEmptyString(
    tokenMap.digest,
    `${worldId}.manifest.tokenMap.digest`,
  );
  if (tokenMapDigest !== `sha256:${hashText(JSON.stringify(entries))}`) {
    contractViolation('token map digest does not match its entries', {
      field: `${worldId}.manifest.tokenMap.digest`,
    });
  }

  const authorityPolicy = assertExactKeys(
    source.authorityPolicy,
    ['schemaVersion', 'policyVersion', 'constraintsDigest', 'capabilities'],
    `${worldId}.manifest.authorityPolicy`,
  );
  assertSchemaVersion(
    authorityPolicy.schemaVersion,
    `${worldId}.manifest.authorityPolicy.schemaVersion`,
  );
  const authorityCapabilities = assertExactKeys(
    authorityPolicy.capabilities,
    capabilityIds,
    `${worldId}.manifest.authorityPolicy.capabilities`,
  );
  const capabilities = Object.fromEntries(
    capabilityIds.map((capabilityId) => {
      const policy = assertExactKeys(
        authorityCapabilities[capabilityId],
        ['allowed', 'safe', 'cost'],
        `${worldId}.manifest.authorityPolicy.capabilities.${capabilityId}`,
      );
      const cost = assertFiniteNumber(
        policy.cost,
        `${worldId}.manifest.authorityPolicy.capabilities.${capabilityId}.cost`,
      );
      if (cost < 0) {
        contractViolation('capability cost cannot be negative', {
          field: `${worldId}.manifest.authorityPolicy.capabilities.${capabilityId}.cost`,
        });
      }

      return [
        capabilityId,
        {
          allowed: assertBoolean(
            policy.allowed,
            `${worldId}.manifest.authorityPolicy.capabilities.${capabilityId}.allowed`,
          ),
          safe: assertBoolean(
            policy.safe,
            `${worldId}.manifest.authorityPolicy.capabilities.${capabilityId}.safe`,
          ),
          cost,
        },
      ];
    }),
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    tokenMap: {
      schemaVersion: SCHEMA_VERSION,
      entries,
      digest: tokenMapDigest,
    },
    authorityPolicy: {
      schemaVersion: SCHEMA_VERSION,
      policyVersion: assertNonEmptyString(
        authorityPolicy.policyVersion,
        `${worldId}.manifest.authorityPolicy.policyVersion`,
      ),
      constraintsDigest: assertNonEmptyString(
        authorityPolicy.constraintsDigest,
        `${worldId}.manifest.authorityPolicy.constraintsDigest`,
      ),
      capabilities,
    },
  };
}

function normalizeActionRequest(value) {
  const fallback = receiptFallbackFields(value);
  let source;
  try {
    source = snapshotClosedRecord(
      value,
      ACTION_REQUEST_KEYS,
      ACTION_REQUEST_KEYS,
      'transition.request',
    );
  } catch (error) {
    if (!(error instanceof WorldPortContractError)) {
      throw error;
    }
    return { ok: false, receiptFields: fallback };
  }

  if (
    source.schemaVersion !== SCHEMA_VERSION ||
    !TOKEN_PATTERN.test(source.token) ||
    !isBoundedNonEmptyString(source.basedOnVersion) ||
    !isBoundedNonEmptyString(source.policyVersion) ||
    !isBoundedNonEmptyString(source.constraintsDigest) ||
    !isBoundedNonEmptyString(source.executionNonce)
  ) {
    return { ok: false, receiptFields: fallback };
  }

  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      token: source.token,
      basedOnVersion: source.basedOnVersion,
      policyVersion: source.policyVersion,
      constraintsDigest: source.constraintsDigest,
      executionNonce: source.executionNonce,
    },
  };
}

function receiptFallbackFields(value) {
  const source = Object.fromEntries(
    ACTION_REQUEST_KEYS.map((key) => [key, safeOwnDataValue(value, key)]),
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    token: typeof source.token === 'string' && TOKEN_PATTERN.test(source.token)
      ? source.token
      : RECEIPT_FALLBACK_TOKEN,
    basedOnVersion: isBoundedNonEmptyString(source.basedOnVersion)
      ? source.basedOnVersion
      : 'state:invalid-request',
    policyVersion: isBoundedNonEmptyString(source.policyVersion)
      ? source.policyVersion
      : 'policy:invalid-request',
    constraintsDigest: isBoundedNonEmptyString(source.constraintsDigest)
      ? source.constraintsDigest
      : 'sha256:invalid-request',
    executionNonce: isBoundedNonEmptyString(source.executionNonce)
      ? source.executionNonce
      : 'nonce:invalid-request',
  };
}

function normalizeEffect(value, worldId) {
  const source = assertPlainRecord(value, `${worldId}.effect`);
  if (source.accepted === false) {
    const rejected = assertExactKeys(
      source,
      ['accepted', 'rejectionReason'],
      `${worldId}.effect`,
    );
    return {
      accepted: false,
      rejectionReason: assertNonEmptyString(
        rejected.rejectionReason,
        `${worldId}.effect.rejectionReason`,
      ),
    };
  }

  const accepted = assertExactKeys(
    source,
    ['accepted', 'patch'],
    `${worldId}.effect`,
  );
  if (accepted.accepted !== true) {
    contractViolation('world effect accepted flag must be boolean', {
      field: `${worldId}.effect.accepted`,
    });
  }
  const patch = assertPlainRecord(accepted.patch, `${worldId}.effect.patch`);
  for (const reserved of [
    'schemaVersion',
    'stateVersion',
    'revision',
    'usedExecutionNonces',
  ]) {
    if (Object.hasOwn(patch, reserved)) {
      contractViolation('domain effect attempted to replace a base state field', {
        field: `${worldId}.effect.patch`,
      });
    }
  }
  return { accepted: true, patch: cloneData(patch) };
}

function normalizeUsedExecutionNonces(value, field) {
  if (!Array.isArray(value) || value.length > MAX_RECENT_NONCES) {
    contractViolation('used execution nonces must be a bounded array', { field });
  }
  const normalized = value.map((nonce, index) =>
    assertNonEmptyString(nonce, `${field}[${index}]`),
  );
  if (new Set(normalized).size !== normalized.length) {
    contractViolation('used execution nonces must be unique', { field });
  }
  return normalized;
}

function assertOpaqueToken(value, field) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    contractViolation('expected an opaque action token', { field });
  }
  return value;
}

function formatStateVersion(worldId, revision) {
  return `state:${worldId}:${revision}`;
}

function digestEffect(value) {
  return `sha256:${hashText(canonicalJson(value))}`;
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isBoundedNonEmptyString(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TEXT_LENGTH
  );
}

function cloneData(value) {
  return structuredClone(value);
}

function snapshotClosedRecord(value, allowedKeys, requiredKeys, field) {
  const source = assertPlainRecord(value, field);
  let ownKeys;
  let descriptors;
  try {
    ownKeys = Reflect.ownKeys(source);
    descriptors = Object.getOwnPropertyDescriptors(source);
  } catch (error) {
    contractViolation('record descriptor inspection failed', {
      field,
      cause: errorName(error),
    });
  }

  if (
    ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !ownKeys.includes(key))
  ) {
    contractViolation('record fields do not match the closed contract', { field });
  }

  const snapshot = {};
  for (const key of ownKeys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      contractViolation('record fields must be enumerable data properties', {
        field: `${field}.${key}`,
      });
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function safeOwnDataValue(value, key) {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function errorName(error) {
  return error instanceof Error ? error.name : 'NonErrorThrow';
}

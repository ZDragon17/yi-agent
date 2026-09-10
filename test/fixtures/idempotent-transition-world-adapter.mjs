import readline from 'node:readline';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalDigest } from '../../src/runtime/schema.mjs';
import { reconciliationUnsigned } from '../../src/runtime/reconciliation-attestation.mjs';
import { attestationFor, ED25519_PUBLIC_KEY } from './ed25519-proof.mjs';

const WORLD_ID = 'idempotent-transition';
const CAPABILITY_ID = 'idempotent-transition.advance';
const SECOND_CAPABILITY_ID = 'idempotent-transition.alternate';
const VALUE_SPEC = { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [1] };
const dropResponse = process.argv.includes('--drop-response');
const holdResponse = process.argv.includes('--hold-response');
const releaseFileIndex = process.argv.indexOf('--release-file');
const releaseFile = releaseFileIndex === -1 ? null : process.argv[releaseFileIndex + 1] ?? null;
const supportsIdempotentTransitions = !process.argv.includes('--non-idempotent');
const lieAboutIdempotency = process.argv.includes('--lie-about-idempotency');
const supportsReconciliation = process.argv.includes('--reconcilable');
const reconciliationAttested = process.argv.includes('--reconciliation-attested');
const tamperReconciliationAttestation = process.argv.includes('--tamper-reconciliation-attestation');
const omitReconciliationAttestation = process.argv.includes('--omit-reconciliation-attestation');
const reconciliationObserver = process.argv.includes('--reconciliation-observer');
const executionAuthority = process.argv.includes('--execution-authority');
const executionObserver = process.argv.includes('--execution-observer');
const observerMismatch = process.argv.includes('--observer-mismatch');
const observerCallFileIndex = process.argv.indexOf('--observer-call-file');
const observerCallFile = observerCallFileIndex === -1 ? null : process.argv[observerCallFileIndex + 1] ?? null;
const osEffect = process.argv.includes('--os-effect');
const skipOsEffect = process.argv.includes('--skip-os-effect');
const twoActions = process.argv.includes('--two-actions');
const bothSafe = process.argv.includes('--both-safe');
const effectFileIndex = process.argv.indexOf('--effect-file');
const effectFile = effectFileIndex === -1 ? null : process.argv[effectFileIndex + 1] ?? null;
const osEffectRootIndex = process.argv.indexOf('--os-effect-root');
const osEffectRoot = osEffectRootIndex === -1 ? null : process.argv[osEffectRootIndex + 1] ?? null;
const startFileIndex = process.argv.indexOf('--start-file');
const startFile = startFileIndex === -1 ? null : process.argv[startFileIndex + 1] ?? null;
const authorityEffectFileIndex = process.argv.indexOf('--authority-effect-file');
const authorityEffectFile = authorityEffectFileIndex === -1 ? null : process.argv[authorityEffectFileIndex + 1] ?? null;
const dropExecutionResponseOnce = process.argv.includes('--drop-execution-response-once');
const observerDropMarkerIndex = process.argv.indexOf('--observer-drop-marker');
const observerDropMarker = observerDropMarkerIndex === -1 ? null : process.argv[observerDropMarkerIndex + 1] ?? null;

if (effectFile === null) throw new Error('--effect-file is required');
if (osEffect && osEffectRoot === null) throw new Error('--os-effect-root is required with --os-effect');
if (startFile !== null) appendFileSync(startFile, `${process.pid}\n`, 'utf8');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.protocol !== 'yi-world-cli' || request.version !== 1) {
    return respond(request.id, false, 'unsupported protocol');
  }
  try {
    return respond(request.id, true, dispatch(request.op, request.payload ?? {}));
  } catch (error) {
    return respond(request.id, false, error instanceof Error ? error.message : String(error));
  }
});

function dispatch(op, payload) {
  if (op === 'hello') {
    const descriptor = {
      adapterId: executionAuthority
        ? 'idempotent-execution-authority-v1'
        : executionObserver
          ? 'idempotent-execution-observer-v1'
          : reconciliationObserver
            ? 'idempotent-reconciliation-observer-v1'
          : 'idempotent-transition-adapter-v1',
      worldId: WORLD_ID,
      worldVersion: 'idempotent-transition-1',
      capabilityIds: twoActions ? [CAPABILITY_ID, SECOND_CAPABILITY_ID] : [CAPABILITY_ID],
      scenarioIds: ['idempotent', 'alternate'],
      valueSpec: VALUE_SPEC,
      evidencePublicKey: ED25519_PUBLIC_KEY,
      supportsStateDependentActions: true,
      ...(supportsIdempotentTransitions ? { supportsIdempotentTransitions: true } : {}),
      ...(supportsReconciliation ? { supportsReconciliation: true } : {}),
      ...(reconciliationAttested ? { reconciliationPublicKey: ED25519_PUBLIC_KEY } : {}),
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: state(0) };
  if (executionAuthority) {
    if (op === 'executeExecution') return executeExecution(payload);
    if (op === 'reconcileExecution') return reconcileExecution(payload);
    throw new Error(`unsupported execution authority operation: ${op}`);
  }
  if (executionObserver) {
    if (op !== 'observeExecution') throw new Error(`unsupported execution observer operation: ${op}`);
    return observeExecution(payload);
  }
  if (reconciliationObserver) {
    if (op !== 'observeReconciliation') throw new Error(`unsupported reconciliation observer operation: ${op}`);
    return observeReconciliation(payload);
  }
  if (op === 'actions') {
    if (payload.state === undefined) throw new Error('state-dependent actions require state');
    const hasCommittedEffect = readEffect() !== null;
    return {
      actions: [
        {
          schemaVersion: 1,
          token: payload.manifest.tokenMap.entries[0].token,
          cost: 1,
          allowed: true,
          safe: bothSafe || (twoActions ? !hasCommittedEffect && payload.state.value === 0 : payload.state.value === 0),
        },
        ...(twoActions ? [{
          schemaVersion: 1,
          token: payload.manifest.tokenMap.entries[1].token,
          cost: 1,
          allowed: true,
          safe: bothSafe || hasCommittedEffect,
        }] : []),
      ],
    };
  }
  if (op === 'observe') return { observation: observation(payload.state) };
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'transition') return transition(payload.state, payload.request);
  if (op === 'reconcile') return reconcile(payload.state, payload.request);
  throw new Error(`unsupported operation: ${op}`);
}

function executeExecution(payload) {
  if (authorityEffectFile !== null) {
    const stored = readAuthorityEffect();
    if (stored !== null) {
      if (stored.executionNonce !== payload.executionNonce) throw new Error('a different execution nonce cannot reuse the authority effect');
      return stored.result;
    }
    const result = {
      schemaVersion: 1,
      status: 'EXECUTED',
      executionNonce: payload.executionNonce,
      token: payload.token,
      basedOnVersion: payload.basedOnVersion,
      beforeStateDigest: payload.beforeStateDigest,
      afterStateDigest: canonicalDigest(state(1, payload.executionNonce)),
    };
    writeFileSync(authorityEffectFile, JSON.stringify({
      executionNonce: payload.executionNonce,
      effectCount: 1,
      result,
    }));
    if (dropExecutionResponseOnce) process.exit(17);
    return result;
  }
  if (osEffect && !skipOsEffect) writeOsMarker(payload.executionNonce);
  return {
    schemaVersion: 1,
    status: 'EXECUTED',
    executionNonce: payload.executionNonce,
    token: payload.token,
    basedOnVersion: payload.basedOnVersion,
    beforeStateDigest: payload.beforeStateDigest,
    afterStateDigest: canonicalDigest(state(1, payload.executionNonce)),
  };
}

function readAuthorityEffect() {
  if (!existsSync(authorityEffectFile)) return null;
  return JSON.parse(readFileSync(authorityEffectFile, 'utf8'));
}

function reconcileExecution(payload) {
  if (osEffect && readOsMarker(payload.executionNonce) !== payload.executionNonce) {
    throw new Error('authority effect is not present during reconciliation');
  }
  return {
    schemaVersion: 1,
    status: 'RECONCILED',
    executionNonce: payload.executionNonce,
    token: payload.token,
    basedOnVersion: payload.basedOnVersion,
    beforeStateDigest: payload.beforeStateDigest,
    afterStateDigest: canonicalDigest(state(1, payload.executionNonce)),
  };
}

function transition(prior, request) {
  const stored = readEffect();
  if (stored !== null && supportsIdempotentTransitions && !lieAboutIdempotency) {
    if (stored.executionNonce !== request.executionNonce) {
      throw new Error('a different execution nonce cannot reuse the committed effect');
    }
    return stored.result;
  }

  const next = state(prior.value + 1, request.executionNonce, prior.usedExecutionNonces);
  const result = {
    nextWorldState: next,
    receipt: {
      ...request,
      schemaVersion: 1,
      status: 'ACCEPTED',
      rejectionReason: null,
      effectDigest: canonicalDigest(next),
      attributionWindowComplete: true,
      confounderCount: 0,
    },
    postObservation: observation(next),
  };
  writeFileSync(effectFile, JSON.stringify({
    executionNonce: request.executionNonce,
    effectCount: (stored?.effectCount ?? 0) + 1,
    result,
  }));
  if (osEffect && !skipOsEffect) writeOsMarker(request.executionNonce);
  if (dropResponse && stored === null) process.exit(17);
  if (holdResponse && stored === null) holdResponseUntilReleased();
  return result;
}

function observeExecution(payload) {
  if (osEffect) {
    const observed = readOsMarker(payload.executionNonce) === payload.executionNonce;
    return {
      schemaVersion: 1,
      status: 'OBSERVED',
      executionNonce: payload.executionNonce,
      token: payload.token,
      basedOnVersion: payload.basedOnVersion,
      beforeStateDigest: payload.beforeStateDigest,
      afterStateDigest: observed && !observerMismatch
        ? canonicalDigest(state(1, payload.executionNonce))
        : canonicalDigest({ wrong: true }),
    };
  }
  const stored = readEffect();
  if (stored === null || stored.result?.receipt?.executionNonce !== payload.executionNonce) {
    throw new Error('execution effect was not observed');
  }
  if (observerDropMarker !== null && !existsSync(observerDropMarker)) {
    writeFileSync(observerDropMarker, 'dropped', 'utf8');
    process.exit(17);
  }
  return {
    schemaVersion: 1,
    status: 'OBSERVED',
    executionNonce: payload.executionNonce,
    token: stored.result.receipt.token,
    basedOnVersion: payload.basedOnVersion,
    beforeStateDigest: payload.beforeStateDigest,
    afterStateDigest: observerMismatch
      ? canonicalDigest({ wrong: true })
      : canonicalDigest(stored.result.nextWorldState),
  };
}

function writeOsMarker(executionNonce) {
  const marker = osMarkerPath(executionNonce);
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, executionNonce, 'utf8');
}

function readOsMarker(executionNonce) {
  try {
    return readFileSync(osMarkerPath(executionNonce), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function osMarkerPath(executionNonce) {
  return path.join(osEffectRoot, 'applied', `${canonicalDigest(executionNonce).slice('sha256:'.length)}.marker`);
}

function holdResponseUntilReleased() {
  if (releaseFile === null) throw new Error('--release-file is required with --hold-response');
  const deadline = Date.now() + 15_000;
  const timer = setInterval(() => {
    if (existsSync(releaseFile) || Date.now() >= deadline) {
      clearInterval(timer);
      process.exit(17);
    }
  }, 25);
}

function reconcile(prior, request) {
  if (!supportsReconciliation) throw new Error('reconciliation is not supported');
  const stored = readEffect();
  const status = stored === null
    ? 'ABSENT'
    : stored.executionNonce !== request.executionNonce
      ? 'UNKNOWN'
      : 'APPLIED';
  const transition = status === 'APPLIED' ? stored.result : undefined;
  return {
    status,
    ...(transition === undefined ? {} : { transition }),
    ...(reconciliationAttested && !omitReconciliationAttestation
      ? { reconciliationAttestation: createReconciliationAttestation(prior, request, status, transition) }
      : {}),
  };
}

function observeReconciliation(request) {
  if (observerCallFile !== null) appendFileSync(observerCallFile, `${request.executionNonce}\n`, 'utf8');
  const stored = readEffect();
  const observedStatus = stored === null
    ? 'ABSENT'
    : stored.executionNonce !== request.executionNonce
      ? 'UNKNOWN'
      : 'APPLIED';
  const reconciliationStatus = observerMismatch
    ? (observedStatus === 'APPLIED' ? 'ABSENT' : 'APPLIED')
    : observedStatus;
  const afterStateDigest = observedStatus === 'APPLIED'
    ? canonicalDigest(stored.result.nextWorldState)
    : request.beforeStateDigest;
  return {
    schemaVersion: 1,
    status: 'OBSERVED',
    reconciliationStatus,
    executionNonce: request.executionNonce,
    token: request.token,
    basedOnVersion: request.basedOnVersion,
    beforeStateDigest: request.beforeStateDigest,
    afterStateDigest,
  };
}

function createReconciliationAttestation(prior, request, status, transition) {
  const unsigned = reconciliationUnsigned({ worldId: WORLD_ID, scenario: 'idempotent', state: prior, request, status, transition });
  const { requestDigest, resultDigest } = unsigned;
  const digest = canonicalDigest(unsigned);
  const signature = attestationFor({ ...unsigned, digest });
  if (!tamperReconciliationAttestation) {
    return { schemaVersion: 1, type: unsigned.type, algorithm: unsigned.algorithm, requestDigest, resultDigest, digest, signature };
  }
  return { schemaVersion: 1, type: unsigned.type, algorithm: unsigned.algorithm, requestDigest, resultDigest, digest, signature: `${signature.slice(0, -2)}xx` };
}

function readEffect() {
  try {
    return JSON.parse(readFileSync(effectFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function state(value, executionNonce = null, priorNonces = []) {
  const usedExecutionNonces = executionNonce === null
    ? [...priorNonces]
    : [...priorNonces.slice(-7), executionNonce];
  return {
    schemaVersion: 1,
    stateVersion: `state:${WORLD_ID}:${value}`,
    revision: value,
    value,
    usedExecutionNonces,
  };
}

function observation(current) {
  return {
    schemaVersion: 1,
    vector: [current.value],
    stateVersion: current.stateVersion,
    intervalId: `${WORLD_ID}:interval:${current.revision}`,
    evidence: [],
  };
}

function respond(id, ok, result) {
  if (!ok) {
    process.stdout.write(`${JSON.stringify({ protocol: 'yi-world-cli', version: 1, id, ok: false, error: result })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ protocol: 'yi-world-cli', version: 1, id, ok: true, result })}\n`);
}

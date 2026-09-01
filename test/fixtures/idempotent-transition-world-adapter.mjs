import readline from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { canonicalDigest } from '../../src/runtime/schema.mjs';
import { ED25519_PUBLIC_KEY } from './ed25519-proof.mjs';

const WORLD_ID = 'idempotent-transition';
const CAPABILITY_ID = 'idempotent-transition.advance';
const SECOND_CAPABILITY_ID = 'idempotent-transition.alternate';
const VALUE_SPEC = { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [1] };
const dropResponse = process.argv.includes('--drop-response');
const holdResponse = process.argv.includes('--hold-response');
const releaseFileIndex = process.argv.indexOf('--release-file');
const releaseFile = releaseFileIndex === -1 ? null : process.argv[releaseFileIndex + 1] ?? null;
const supportsIdempotentTransitions = !process.argv.includes('--non-idempotent');
const supportsReconciliation = process.argv.includes('--reconcilable');
const twoActions = process.argv.includes('--two-actions');
const bothSafe = process.argv.includes('--both-safe');
const effectFileIndex = process.argv.indexOf('--effect-file');
const effectFile = effectFileIndex === -1 ? null : process.argv[effectFileIndex + 1] ?? null;

if (effectFile === null) throw new Error('--effect-file is required');

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
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: WORLD_ID,
      worldVersion: 'idempotent-transition-1',
      capabilityIds: twoActions ? [CAPABILITY_ID, SECOND_CAPABILITY_ID] : [CAPABILITY_ID],
      scenarioIds: ['idempotent', 'alternate'],
      valueSpec: VALUE_SPEC,
      evidencePublicKey: ED25519_PUBLIC_KEY,
      supportsStateDependentActions: true,
      ...(supportsIdempotentTransitions ? { supportsIdempotentTransitions: true } : {}),
      ...(supportsReconciliation ? { supportsReconciliation: true } : {}),
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: state(0) };
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

function transition(prior, request) {
  const stored = readEffect();
  if (stored !== null && supportsIdempotentTransitions) {
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
  if (dropResponse && stored === null) process.exit(17);
  if (holdResponse && stored === null) holdResponseUntilReleased();
  return result;
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
  if (stored === null) return { status: 'ABSENT' };
  if (stored.executionNonce !== request.executionNonce) return { status: 'UNKNOWN' };
  return { status: 'APPLIED', transition: stored.result };
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

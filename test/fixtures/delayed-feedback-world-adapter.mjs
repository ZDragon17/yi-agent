import readline from 'node:readline';
import { canonicalDigest } from '../../src/runtime/schema.mjs';
import { ED25519_PUBLIC_KEY } from './ed25519-proof.mjs';

const WORLD_ID = 'delayed-feedback';
const CAPABILITY_ID = 'delayed-feedback.advance';
const VALUE_SPEC = { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [1] };

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
      adapterId: 'delayed-feedback-adapter-v1',
      worldId: WORLD_ID,
      worldVersion: 'delayed-feedback-1',
      capabilityIds: [CAPABILITY_ID],
      scenarioIds: ['delayed'],
      valueSpec: VALUE_SPEC,
      evidencePublicKey: ED25519_PUBLIC_KEY,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: state(0) };
  if (op === 'actions') {
    return {
      actions: [{
        schemaVersion: 1,
        token: payload.manifest.tokenMap.entries[0].token,
        cost: 1,
        allowed: true,
        safe: true,
      }],
    };
  }
  if (op === 'observe') return { observation: observation(payload.state) };
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'transition') return transition(payload.state, payload.request);
  throw new Error(`unsupported operation: ${op}`);
}

function transition(prior, request) {
  const delayedNonce = prior.pendingExecutionNonce ?? null;
  const nextValue = delayedNonce === null ? prior.value : prior.value + 1;
  const next = state(
    nextValue,
    prior.revision + 1,
    request.executionNonce,
    [...prior.usedExecutionNonces, request.executionNonce].slice(-8),
  );
  const result = {
    nextWorldState: next,
    receipt: {
      ...request,
      schemaVersion: 1,
      status: 'ACCEPTED',
      rejectionReason: null,
      effectDigest: canonicalDigest(next),
      attributionWindowComplete: false,
      confounderCount: 0,
    },
    postObservation: observation(next, delayedNonce === null ? null : {
      schemaVersion: 1,
      executionNonce: delayedNonce,
      stateVersion: next.stateVersion,
      intervalId: `${WORLD_ID}:interval:${next.revision}`,
      vector: [next.value],
      confounderCount: 0,
    }),
  };
  return result;
}

function state(value, revision = 0, pendingExecutionNonce = null, usedExecutionNonces = []) {
  return {
    schemaVersion: 1,
    stateVersion: `state:${WORLD_ID}:${revision}`,
    revision,
    value,
    pendingExecutionNonce,
    usedExecutionNonces,
  };
}

function observation(current, feedback = null) {
  return {
    schemaVersion: 1,
    vector: [current.value],
    stateVersion: current.stateVersion,
    intervalId: `${WORLD_ID}:interval:${current.revision}`,
    evidence: [],
    ...(feedback === null ? {} : { feedback: [feedback] }),
  };
}

function respond(id, ok, result) {
  process.stdout.write(`${JSON.stringify({ protocol: 'yi-world-cli', version: 1, id, ok, result })}\n`);
}

import readline from 'node:readline';
import { canonicalDigest } from '../../src/runtime/schema.mjs';
import { ED25519_PUBLIC_KEY } from './ed25519-proof.mjs';

const WORLD_ID = 'overlap-feedback';
const CAPABILITY_ID = 'overlap.advance';
const REVERSE_FEEDBACK = process.argv.includes('--reverse-feedback');
const capabilityToken = (payload) => payload.manifest.tokenMap.entries[0].token;

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
      adapterId: 'overlap-feedback-adapter-v1',
      worldId: WORLD_ID,
      worldVersion: 'overlap-feedback-1',
      capabilityIds: [CAPABILITY_ID],
      scenarioIds: ['overlap'],
      valueSpec: { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [2] },
      evidencePublicKey: ED25519_PUBLIC_KEY,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: state(0, 0, [], []) };
  if (op === 'actions') return {
    actions: [{
      schemaVersion: 1,
      token: capabilityToken(payload),
      cost: 1,
      allowed: true,
      safe: true,
    }],
  };
  if (op === 'observe') return { observation: observation(payload.state) };
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'transition') return transition(payload.state, payload.request);
  throw new Error(`unsupported operation: ${op}`);
}

function transition(prior, request) {
  const waiting = Array.isArray(prior.pendingExecutionNonces)
    ? prior.pendingExecutionNonces
    : [];
  const releases = waiting.length >= 2 ? waiting.slice(0, 2) : [];
  const nextRevision = prior.revision + 1;
  const nextValue = releases.length === 0 ? prior.value : prior.value + 1;
  const nextPending = releases.length === 0 ? [...waiting, request.executionNonce] : [request.executionNonce];
  const next = state(nextValue, nextRevision, nextPending, [
    ...(Array.isArray(prior.usedExecutionNonces) ? prior.usedExecutionNonces.slice(-7) : []),
    request.executionNonce,
  ]);
  const feedback = releases.map((executionNonce) => ({
    schemaVersion: 1,
    executionNonce,
    stateVersion: next.stateVersion,
    intervalId: `${WORLD_ID}:interval:${next.revision}`,
    vector: [next.value],
    // Deliberately claims clean attribution. The Kernel must reject the
    // shared observation boundary without trusting this declaration alone.
    confounderCount: 0,
  }));
  if (REVERSE_FEEDBACK) feedback.reverse();
  return {
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
    postObservation: observation(next, feedback),
  };
}

function state(value, revision, pendingExecutionNonces, usedExecutionNonces) {
  return {
    schemaVersion: 1,
    stateVersion: `state:${WORLD_ID}:${revision}`,
    revision,
    value,
    pendingExecutionNonces,
    usedExecutionNonces,
  };
}

function observation(current, feedback = []) {
  return {
    schemaVersion: 1,
    vector: [current.value],
    stateVersion: current.stateVersion,
    intervalId: `${WORLD_ID}:interval:${current.revision}`,
    evidence: [],
    ...(feedback.length === 0 ? {} : { feedback }),
  };
}

function respond(id, ok, result) {
  process.stdout.write(`${JSON.stringify({ protocol: 'yi-world-cli', version: 1, id, ok, result })}\n`);
}

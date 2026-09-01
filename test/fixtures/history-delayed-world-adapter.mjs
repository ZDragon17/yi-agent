import readline from 'node:readline';
import { canonicalDigest } from '../../src/runtime/schema.mjs';
import { ED25519_PUBLIC_KEY } from './ed25519-proof.mjs';

const WORLD_ID = 'history-delayed';
const CAPABILITIES = [
  'history-delayed.action-a',
  'history-delayed.action-b',
  'history-delayed.action-c',
  'history-delayed.action-d',
];

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
      adapterId: 'history-delayed-adapter-v1',
      worldId: WORLD_ID,
      worldVersion: 'history-delayed-1',
      capabilityIds: CAPABILITIES,
      scenarioIds: ['delayed-history'],
      supportsStateDependentActions: true,
      valueSpec: {
        schemaVersion: 1,
        observationDimensions: 1,
        weights: [1],
        target: [1],
      },
      evidencePublicKey: ED25519_PUBLIC_KEY,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return {
    state: state(
      'a',
      0,
      0,
      [],
      payload.manifest.tokenMap.entries.map((entry) => ({ ...entry })),
    ),
  };
  if (op === 'actions') {
    const phaseCapability = {
      a: CAPABILITIES[0],
      b: CAPABILITIES[1],
      c: CAPABILITIES[2],
      done: CAPABILITIES[3],
    }[payload.state.phase];
    return {
      actions: payload.manifest.tokenMap.entries.map((entry) => ({
        schemaVersion: 1,
        token: entry.token,
        cost: 1,
        allowed: true,
        safe: entry.capabilityId === phaseCapability,
      })),
    };
  }
  if (op === 'observe') return { observation: observation(payload.state) };
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'transition') return transition(payload.state, payload.request);
  throw new Error(`unsupported operation: ${op}`);
}

function transition(prior, request) {
  const capabilityId = prior.actionTokens.find((entry) => entry.token === request.token)?.capabilityId;
  const expected = {
    a: CAPABILITIES[0],
    b: CAPABILITIES[1],
    c: CAPABILITIES[2],
    done: CAPABILITIES[3],
  }[prior.phase];
  if (capabilityId !== expected) throw new Error('transition action is not safe for the current phase');

  const nextPhase = { a: 'b', b: 'c', c: 'done', done: 'done' }[prior.phase];
  const next = state(nextPhase, prior.value + (prior.phase === 'c' ? 1 : 0), prior.revision + 1, [
    ...prior.usedExecutionNonces.slice(-7),
    request.executionNonce,
  ], prior.actionTokens);
  const feedback = prior.phase === 'c' ? [{
    schemaVersion: 1,
    executionNonce: prior.usedExecutionNonces[0],
    stateVersion: next.stateVersion,
    intervalId: `history-delayed:interval:${next.revision}`,
    vector: [next.value],
    confounderCount: 0,
  }] : [];
  return {
    nextWorldState: next,
    receipt: {
      ...request,
      schemaVersion: 1,
      status: 'ACCEPTED',
      rejectionReason: null,
      effectDigest: canonicalDigest(next),
      attributionWindowComplete: prior.phase !== 'a',
      confounderCount: 0,
    },
    postObservation: observation(next, feedback),
  };
}

function state(phase, value, revision, usedExecutionNonces, actionTokens = []) {
  return {
    schemaVersion: 1,
    stateVersion: `${WORLD_ID}:${revision}`,
    phase,
    value,
    revision,
    usedExecutionNonces,
    actionTokens,
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
  process.stdout.write(`${JSON.stringify({ protocol: 'yi-world-cli', version: 1, id, ok, ...(ok ? { result } : { error: result }) })}\n`);
}

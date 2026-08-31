import readline from 'node:readline';
import { canonicalDigest } from './schema-bridge.mjs';
import { ED25519_PUBLIC_KEY } from './ed25519-proof.mjs';

const WORLD_ID = 'metamorphic';
const CAPABILITY_IDS = [
  'metamorphic.advance-a',
  'metamorphic.advance-b',
  'metamorphic.advance-c',
  'metamorphic.advance-d',
];
const LOGICAL_VALUE_SPEC = {
  schemaVersion: 1,
  observationDimensions: 4,
  weights: [1, 2, 3, 4],
  target: [4, 3, 2, 1],
};
const permutation = process.argv.includes('--reverse') ? [3, 2, 1, 0] : [0, 1, 2, 3];
const valueSpec = {
  ...LOGICAL_VALUE_SPEC,
  weights: permute(LOGICAL_VALUE_SPEC.weights),
  target: permute(LOGICAL_VALUE_SPEC.target),
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.protocol !== 'yi-world-cli' || request.version !== 1) {
    return respond(request.id, false, null);
  }
  return respond(request.id, true, dispatch(request.op, request.payload ?? {}));
});

function dispatch(op, payload) {
  if (op === 'hello') {
    const descriptor = {
      adapterId: 'metamorphic-adapter-v1',
      worldId: WORLD_ID,
      worldVersion: 'metamorphic-1',
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: ['steady', 'metamorphic'],
      valueSpec,
      evidencePublicKey: ED25519_PUBLIC_KEY,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: state(0, permute([0, 1, 2, 3])) };
  if (op === 'actions') {
    return {
      actions: payload.manifest.tokenMap.entries.map((entry) => ({
        schemaVersion: 1,
        token: entry.token,
        cost: 1,
        allowed: true,
        safe: true,
      })),
    };
  }
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'observe') {
    return { observation: observation(payload.state) };
  }
  if (op === 'transition') {
    const prior = payload.state;
    const logical = unpermute(prior.vector);
    logical[tokenSlot(payload.request.token)] += 1;
    const next = state(prior.revision + 1, permute(logical), [
      ...prior.usedExecutionNonces.slice(-7),
      payload.request.executionNonce,
    ]);
    return {
      nextWorldState: next,
      receipt: {
        ...payload.request,
        status: 'ACCEPTED',
        rejectionReason: null,
        effectDigest: canonicalDigest(next),
        attributionWindowComplete: true,
        confounderCount: 0,
      },
      postObservation: observation(next),
    };
  }
  return null;
}

function state(revision, vector, usedExecutionNonces = []) {
  return {
    schemaVersion: 1,
    stateVersion: `state:${WORLD_ID}:${revision}`,
    revision,
    vector,
    usedExecutionNonces,
  };
}

function observation(current) {
  return {
    schemaVersion: 1,
    vector: [...current.vector],
    stateVersion: current.stateVersion,
    intervalId: `${WORLD_ID}:interval:${current.revision}`,
    evidence: [],
  };
}

function tokenSlot(token) {
  let hash = 0;
  for (const character of token) hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  return hash % CAPABILITY_IDS.length;
}

function permute(vector) {
  return permutation.map((index) => vector[index]);
}

function unpermute(vector) {
  const result = Array(vector.length);
  for (const [physicalIndex, logicalIndex] of permutation.entries()) result[logicalIndex] = vector[physicalIndex];
  return result;
}

function respond(id, ok, result) {
  process.stdout.write(`${JSON.stringify({ protocol: 'yi-world-cli', version: 1, id, ok, result })}\n`);
}

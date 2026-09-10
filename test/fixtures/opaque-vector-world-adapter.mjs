import readline from 'node:readline';
import { canonicalDigest } from '../../src/runtime/schema.mjs';
import { ED25519_PUBLIC_KEY } from './ed25519-proof.mjs';

const ADAPTER_ID = 'opaque-vector-adapter-v1';
const WORLD_ID = 'opaque-vector';
const WORLD_VERSION = 'opaque-vector-1';
const CAPABILITY_IDS = ['c0', 'c1', 'c2', 'c3'];
const SCENARIO_IDS = ['steady'];
const VALUE_SPEC = {
  schemaVersion: 1,
  observationDimensions: 6,
  weights: [1, 2, 3, 5, 7, 11],
  target: [3, 3, 3, 3, 3, 3],
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return respond(null, false, null);
  }
  if (request.protocol !== 'yi-world-cli' || request.version !== 1) {
    return respond(request.id, false, null);
  }
  try {
    return respond(request.id, true, dispatch(request.op, request.payload ?? {}));
  } catch (error) {
    return respond(request.id, false, null, error?.message ?? 'adapter error');
  }
});

function dispatch(op, payload) {
  if (op === 'hello') {
    const descriptor = {
      adapterId: ADAPTER_ID,
      worldId: WORLD_ID,
      worldVersion: WORLD_VERSION,
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: SCENARIO_IDS,
      valueSpec: VALUE_SPEC,
      evidencePublicKey: ED25519_PUBLIC_KEY,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: makeState(0, [0, 0, 0, 0, 0, 0]) };
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
  if (op === 'observe') return { observation: observe(payload.state) };
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'transition') return transition(payload);
  throw new Error(`unsupported operation: ${op}`);
}

function transition({ manifest, state, request }) {
  const actionIndex = manifest.tokenMap.entries.findIndex((entry) => entry.token === request.token);
  if (actionIndex < 0) throw new Error('unknown action token');
  const coordinates = [...state.coordinates];
  coordinates[actionIndex] += 1;
  const next = makeState(state.revision + 1, coordinates, request.executionNonce, state.usedExecutionNonces);
  return {
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
    postObservation: observe(next),
  };
}

function makeState(revision, coordinates, executionNonce = null, priorNonces = []) {
  return {
    schemaVersion: 1,
    stateVersion: `${WORLD_ID}:${revision}`,
    revision,
    coordinates,
    usedExecutionNonces: executionNonce === null
      ? []
      : [...priorNonces.slice(-7), executionNonce],
  };
}

function observe(state) {
  return {
    schemaVersion: 1,
    vector: [...state.coordinates],
    stateVersion: state.stateVersion,
    intervalId: `${WORLD_ID}:interval:${state.revision}`,
    evidence: [],
  };
}

function respond(id, ok, result, error = null) {
  process.stdout.write(`${JSON.stringify({
    protocol: 'yi-world-cli',
    version: 1,
    id,
    ok,
    ...(ok ? { result } : { error: { message: error } }),
  })}\n`);
}

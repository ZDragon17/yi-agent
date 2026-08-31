import readline from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalDigest } from '../../src/runtime/schema.mjs';
import { ED25519_PUBLIC_KEY } from './ed25519-proof.mjs';

const WORLD_ID = 'stateful-capabilities';
const CAPABILITY_IDS = [
  'stateful-capabilities.advance-first',
  'stateful-capabilities.advance-second',
];
const VALUE_SPEC = { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [2] };
const memoryFileIndex = process.argv.indexOf('--memory-file');
const memoryFile = memoryFileIndex === -1 ? null : process.argv[memoryFileIndex + 1] ?? null;

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
  try {
    return respond(request.id, true, dispatch(request.op, request.payload ?? {}));
  } catch (error) {
    return respond(request.id, false, { message: error instanceof Error ? error.message : String(error) });
  }
});

function dispatch(op, payload) {
  if (op === 'hello') {
    const descriptor = {
      adapterId: 'stateful-capabilities-adapter-v1',
      worldId: WORLD_ID,
      worldVersion: 'stateful-capabilities-1',
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: ['stateful'],
      valueSpec: VALUE_SPEC,
      evidencePublicKey: ED25519_PUBLIC_KEY,
      supportsStateDependentActions: true,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: state(0) };
  if (op === 'actions') {
    if (payload.state === undefined) throw new Error('state-dependent actions require state');
    const value = payload.state.value;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('state-dependent actions received an invalid value');
    return {
      actions: payload.manifest.tokenMap.entries.map((entry, index) => ({
        schemaVersion: 1,
        token: entry.token,
        cost: 1,
        allowed: true,
        safe: index === (value === 0 ? 0 : 1),
      })),
    };
  }
  if (op === 'observe') return { observation: observation(payload.state) };
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'transition') {
    const prior = payload.state;
    const request = payload.request;
    const firstToken = readFirstToken();
    if (prior.value === 0 && memoryFile !== null) writeFileSync(memoryFile, request.token);
    if (prior.value > 0 && request.token === firstToken) {
      return {
        nextWorldState: state(prior.value),
        receipt: {
          ...request,
          schemaVersion: 1,
          status: 'REJECTED',
          rejectionReason: 'STATE_DEPENDENT_CAPABILITY_MISMATCH',
          effectDigest: canonicalDigest(prior),
          attributionWindowComplete: true,
          confounderCount: 0,
        },
        postObservation: observation(prior),
      };
    }
    const next = state(prior.value + 1, request.executionNonce, prior.usedExecutionNonces);
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
      postObservation: observation(next),
    };
  }
  throw new Error(`unsupported operation: ${op}`);
}

function readFirstToken() {
  if (memoryFile === null) return null;
  try {
    return readFileSync(memoryFile, 'utf8').trim() || null;
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
  process.stdout.write(`${JSON.stringify({ protocol: 'yi-world-cli', version: 1, id, ok, result })}\n`);
}

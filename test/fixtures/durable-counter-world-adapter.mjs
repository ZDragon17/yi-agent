import readline from 'node:readline';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { canonicalDigest } from '../../src/runtime/schema.mjs';
import { ED25519_PUBLIC_KEY } from './ed25519-proof.mjs';

const WORLD_ID = 'durable-counter';
const CAPABILITY_ID = 'durable-counter.advance';
const VERSION = 1;
const dropResponseOnce = process.argv.includes('--drop-response-once');
const stateFileIndex = process.argv.indexOf('--state-file');
const stateFile = stateFileIndex === -1 ? null : process.argv[stateFileIndex + 1] ?? null;
if (stateFile === null) throw new Error('--state-file is required');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return respond(null, false, 'request is not JSON');
  }
  if (request.protocol !== 'yi-world-cli' || request.version !== VERSION) {
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
      adapterId: 'durable-counter-adapter-v1',
      worldId: WORLD_ID,
      worldVersion: 'durable-counter-1',
      capabilityIds: [CAPABILITY_ID],
      scenarioIds: ['steady'],
      valueSpec: { schemaVersion: VERSION, observationDimensions: 1, weights: [1], target: [2] },
      evidencePublicKey: ED25519_PUBLIC_KEY,
      supportsIdempotentTransitions: true,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: state(0) };
  if (op === 'actions') {
    const token = payload.manifest?.tokenMap?.entries?.[0]?.token;
    if (typeof token !== 'string') throw new Error('manifest token is missing');
    return { actions: [{ schemaVersion: VERSION, token, cost: 1, allowed: true, safe: true }] };
  }
  if (op === 'observe') return { observation: observation(payload.state) };
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'transition') return transition(payload.state, payload.request);
  throw new Error(`unsupported operation: ${op}`);
}

function transition(prior, request) {
  const stored = readStore();
  const existing = stored.effects.find((effect) => effect.executionNonce === request.executionNonce);
  if (existing !== undefined) return existing.result;

  const next = state(prior.value + 1, request.executionNonce, prior.usedExecutionNonces);
  const result = {
    nextWorldState: next,
    receipt: {
      ...request,
      schemaVersion: VERSION,
      status: 'ACCEPTED',
      rejectionReason: null,
      effectDigest: canonicalDigest(next),
      attributionWindowComplete: true,
      confounderCount: 0,
    },
    postObservation: observation(next),
  };
  const shouldDrop = dropResponseOnce && !stored.responseDropped;
  writeStore({
    value: next.value,
    responseDropped: stored.responseDropped || shouldDrop,
    effects: [...stored.effects, { executionNonce: request.executionNonce, result }],
  });
  if (shouldDrop) process.exit(17);
  return result;
}

function readStore() {
  if (!existsSync(stateFile)) return { value: 0, responseDropped: false, effects: [] };
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}

function writeStore(value) {
  mkdirSync(dirname(stateFile), { recursive: true });
  const temporary = join(dirname(stateFile), `.${stateFile.split(/[\\/]/u).at(-1)}.tmp-${process.pid}`);
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, stateFile);
}

function state(value, executionNonce = null, previousNonces = []) {
  return {
    schemaVersion: VERSION,
    stateVersion: `state:${WORLD_ID}:${value}`,
    revision: value,
    value,
    usedExecutionNonces: executionNonce === null
      ? [...previousNonces]
      : [...previousNonces.slice(-7), executionNonce],
  };
}

function observation(current) {
  return {
    schemaVersion: VERSION,
    vector: [current.value],
    stateVersion: current.stateVersion,
    intervalId: `${WORLD_ID}:interval:${current.revision}`,
    evidence: [],
  };
}

function respond(id, ok, result) {
  const envelope = ok
    ? { protocol: 'yi-world-cli', version: VERSION, id, ok: true, result }
    : { protocol: 'yi-world-cli', version: VERSION, id, ok: false, error: result };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

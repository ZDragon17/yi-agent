import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import { ED25519_PUBLIC_KEY } from './ed25519-proof.mjs';

const VERSION = 1;
const WORLD_ID = 'hidden-state';
const CAPABILITY_IDS = [
  'hidden-state.flip',
  'hidden-state.advance',
  'hidden-state.reset',
];
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
      adapterId: 'hidden-state-adapter-v1',
      worldId: WORLD_ID,
      worldVersion: 'hidden-state-1',
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: ['steady'],
      valueSpec: { schemaVersion: VERSION, observationDimensions: 1, weights: [1], target: [2] },
      evidencePublicKey: ED25519_PUBLIC_KEY,
      supportsStateDependentActions: true,
      supportsIdempotentTransitions: true,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: stateFromStore(readStore()) };
  if (op === 'actions') {
    const entries = payload.manifest?.tokenMap?.entries;
    if (!Array.isArray(entries) || entries.length !== CAPABILITY_IDS.length) throw new Error('manifest token map is missing');
    const stored = readStore();
    if (stored.tokenMap.length === 0) writeStore({ ...stored, tokenMap: entries });
    else if (canonicalJson(stored.tokenMap) !== canonicalJson(entries)) throw new Error('manifest token map changed');
    const safeCapability = safeCapabilityForPhase(stored.phase);
    return {
      actions: entries.map((entry) => ({
        schemaVersion: VERSION,
        token: entry.token,
        cost: 1,
        allowed: true,
        safe: entry.capabilityId === safeCapability,
      })),
    };
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
  if (prior.revision !== stored.revision || prior.value !== stored.value || prior.hiddenMode !== stored.hiddenMode || prior.phase !== stored.phase) {
    throw new Error('transition state does not match durable hidden state');
  }

  const capabilityId = stored.tokenMap.find((entry) => entry.token === request.token)?.capabilityId;
  const expectedCapability = safeCapabilityForPhase(prior.phase);
  if (capabilityId !== expectedCapability) throw new Error('transition action is not safe for the hidden phase');
  const delta = capabilityId === 'hidden-state.advance'
    ? (prior.hiddenMode === 'A' ? 1 : -1)
    : capabilityId === 'hidden-state.reset'
      ? -prior.value
      : 0;
  const next = {
    value: prior.value + delta,
    hiddenMode: capabilityId === 'hidden-state.flip'
      ? (prior.hiddenMode === 'A' ? 'B' : 'A')
      : prior.hiddenMode,
    phase: nextPhase(prior.phase),
    revision: prior.revision + 1,
    usedExecutionNonces: [...prior.usedExecutionNonces.slice(-7), request.executionNonce],
    tokenMap: stored.tokenMap,
  };
  const nextState = stateFromStore(next);
  const result = {
    nextWorldState: nextState,
    receipt: {
      ...request,
      schemaVersion: VERSION,
      status: 'ACCEPTED',
      rejectionReason: null,
      effectDigest: canonicalDigest(nextState),
      attributionWindowComplete: true,
      confounderCount: 0,
    },
    postObservation: observation(nextState),
  };
  writeStore({ ...next, effects: [...stored.effects, { executionNonce: request.executionNonce, result }] });
  return result;
}

function stateFromStore(source) {
  return {
    schemaVersion: VERSION,
    stateVersion: `opaque-state:${source.revision}`,
    revision: source.revision,
    value: source.value,
    hiddenMode: source.hiddenMode,
    phase: source.phase,
    usedExecutionNonces: [...source.usedExecutionNonces],
  };
}

function safeCapabilityForPhase(phase) {
  return {
    'flip-first': 'hidden-state.flip',
    'advance-first': 'hidden-state.advance',
    'reset-first': 'hidden-state.reset',
    'flip-second': 'hidden-state.flip',
    'advance-second': 'hidden-state.advance',
    'reset-second': 'hidden-state.reset',
    'flip-third': 'hidden-state.flip',
    'advance-third': 'hidden-state.advance',
    'reset-third': 'hidden-state.reset',
    'flip-fourth': 'hidden-state.flip',
    'advance-fourth': 'hidden-state.advance',
  }[phase];
}

function nextPhase(phase) {
  const phases = [
    'flip-first', 'advance-first', 'reset-first',
    'flip-second', 'advance-second', 'reset-second',
    'flip-third', 'advance-third', 'reset-third',
    'flip-fourth', 'advance-fourth', 'reset-second',
  ];
  const index = phases.indexOf(phase);
  if (index === -1) throw new Error(`unknown hidden phase: ${phase}`);
  return phases[(index + 1) % phases.length];
}

function observation(current) {
  return {
    schemaVersion: VERSION,
    vector: [current.value],
    stateVersion: current.stateVersion,
    intervalId: `opaque-boundary:${current.revision}`,
    evidence: [],
  };
}

function readStore() {
  if (!existsSync(stateFile)) {
    return {
      value: 0,
      hiddenMode: 'A',
      phase: 'flip-first',
      revision: 0,
      usedExecutionNonces: [],
      tokenMap: [],
      effects: [],
    };
  }
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}

function writeStore(value) {
  mkdirSync(dirname(stateFile), { recursive: true });
  const temporary = join(dirname(stateFile), `.${stateFile.split(/[\\/]/u).at(-1)}.tmp-${process.pid}`);
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, stateFile);
}

function respond(id, ok, result) {
  process.stdout.write(`${JSON.stringify({ protocol: 'yi-world-cli', version: VERSION, id, ok, ...(ok ? { result } : { error: result }) })}\n`);
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import { ED25519_PUBLIC_KEY } from './ed25519-proof.mjs';

const VERSION = 1;
const WORLD_ID = 'history-conditioned';
const CAPABILITY_IDS = [
  'history-conditioned.probe',
  'history-conditioned.clear',
  'history-conditioned.target-a',
  'history-conditioned.target-b',
  'history-conditioned.reset',
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
      adapterId: 'history-conditioned-adapter-v1',
      worldId: WORLD_ID,
      worldVersion: 'history-conditioned-1',
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: ['steady'],
      valueSpec: { schemaVersion: VERSION, observationDimensions: 1, weights: [1], target: [1] },
      evidencePublicKey: ED25519_PUBLIC_KEY,
      supportsStateDependentActions: true,
      supportsIdempotentTransitions: true,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: stateFromStore(readStore()) };
  if (op === 'actions') {
    const stored = readStore();
    const entries = payload.manifest?.tokenMap?.entries;
    if (stored.tokenMap.length === 0) writeStore({ ...stored, tokenMap: entries });
    else if (canonicalJson(stored.tokenMap) !== canonicalJson(entries)) throw new Error('manifest token map changed');
    return { actions: actions(entries, stored.phase) };
  }
  if (op === 'observe') return { observation: observation(payload.state) };
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'transition') return transition(payload.state, payload.request);
  throw new Error(`unsupported operation: ${op}`);
}

function actions(entries, phase) {
  if (!Array.isArray(entries) || entries.length !== CAPABILITY_IDS.length) throw new Error('manifest token map is missing');
  const safeCapability = {
    probe: 'history-conditioned.probe',
    clear: 'history-conditioned.clear',
    reset: 'history-conditioned.reset',
    target: null,
  }[phase];
  return entries.map((entry) => ({
    schemaVersion: VERSION,
    token: entry.token,
    cost: 1,
    allowed: true,
    safe: safeCapability === null
      ? entry.capabilityId === 'history-conditioned.target-a' || entry.capabilityId === 'history-conditioned.target-b'
      : entry.capabilityId === safeCapability,
  }));
}

function transition(prior, request) {
  const stored = readStore();
  const existing = stored.effects.find((effect) => effect.executionNonce === request.executionNonce);
  if (existing !== undefined) return existing.result;
  if (prior.revision !== stored.revision || prior.value !== stored.value || prior.phase !== stored.phase) {
    throw new Error('transition state does not match durable history state');
  }
  const capabilityId = stored.tokenMap.find((entry) => entry.token === request.token)?.capabilityId;
  const expectedCapability = {
    probe: 'history-conditioned.probe',
    clear: 'history-conditioned.clear',
    reset: 'history-conditioned.reset',
    target: capabilityId,
  }[stored.phase];
  if (stored.phase === 'target' && !['history-conditioned.target-a', 'history-conditioned.target-b'].includes(capabilityId)) {
    throw new Error('transition action is not a target capability');
  }
  if (capabilityId !== expectedCapability) throw new Error('transition action is not safe for the current phase');

  const delta = stored.phase === 'probe'
    ? (stored.mode === 'A' ? 1 : -1)
    : stored.phase === 'clear'
      ? -prior.value
      : stored.phase === 'reset'
        ? -prior.value
        : capabilityId === `history-conditioned.target-${stored.mode.toLowerCase()}` ? 1 : -1;
  const next = {
    value: prior.value + delta,
    phase: stored.phase === 'probe'
      ? 'clear'
      : stored.phase === 'clear'
        ? 'target'
        : stored.phase === 'target'
          ? 'reset'
          : 'probe',
    mode: stored.phase === 'target' ? nextMode(stored.episode) : stored.mode,
    episode: stored.phase === 'target' ? stored.episode + 1 : stored.episode,
    revision: stored.revision + 1,
    usedExecutionNonces: [...prior.usedExecutionNonces.slice(-7), request.executionNonce],
    tokenMap: stored.tokenMap,
    effects: stored.effects,
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

function nextMode(episode) {
  return ['A', 'A', 'B', 'A', 'B', 'A', 'B'][episode + 1] ?? (episode % 2 === 0 ? 'B' : 'A');
}

function stateFromStore(source) {
  return {
    schemaVersion: VERSION,
    stateVersion: `history-conditioned:${source.revision}`,
    revision: source.revision,
    value: source.value,
    phase: source.phase,
    usedExecutionNonces: [...source.usedExecutionNonces],
  };
}

function observation(current) {
  return {
    schemaVersion: VERSION,
    vector: [current.value],
    stateVersion: current.stateVersion,
    intervalId: `history-conditioned:${current.revision}`,
    evidence: [],
  };
}

function readStore() {
  if (!existsSync(stateFile)) {
    return {
      value: 0,
      phase: 'probe',
      mode: 'A',
      episode: 0,
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

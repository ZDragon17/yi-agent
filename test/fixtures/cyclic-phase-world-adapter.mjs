import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ED25519_PUBLIC_KEY } from './ed25519-proof.mjs';

const VERSION = 1;
const PROTOCOL = 'yi-world-cli';
const WORLD_ID = 'cyclic-phase';
const CAPABILITY_IDS = ['cyclic-phase.alpha', 'cyclic-phase.beta', 'cyclic-phase.gamma'];
const stateFileIndex = process.argv.indexOf('--state-file');
const stateFile = stateFileIndex === -1 ? null : process.argv[stateFileIndex + 1] ?? null;
if (stateFile === null) throw new Error('state-file is required');

const input = readFileSync(0, 'utf8').split(/\r?\n/u).find((line) => line.length > 0);
if (input === undefined) process.exit(64);

let request;
try {
  request = JSON.parse(input);
} catch {
  respond(null, false, 'request is not JSON');
  process.exit(0);
}

if (request.protocol !== PROTOCOL || request.version !== VERSION || typeof request.id !== 'string') {
  respond(request.id ?? null, false, 'unsupported protocol');
  process.exit(0);
}

try {
  respond(request.id, true, dispatch(request.op, request.payload ?? {}));
} catch (error) {
  respond(request.id, false, error instanceof Error ? error.message : String(error));
}

function dispatch(op, payload) {
  if (op === 'hello') {
    const descriptor = {
      adapterId: 'cyclic-phase-adapter-v1',
      worldId: WORLD_ID,
      worldVersion: 'cyclic-phase-1',
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: ['steady'],
      valueSpec: { schemaVersion: VERSION, observationDimensions: 1, weights: [1], target: [400] },
      evidencePublicKey: ED25519_PUBLIC_KEY,
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
    return {
      actions: entries.map((entry) => ({
        schemaVersion: VERSION,
        token: entry.token,
        cost: 1,
        allowed: true,
        safe: true,
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
  if (prior.revision !== stored.revision || prior.value !== stored.value || prior.phase !== stored.phase) {
    throw new Error('transition state does not match durable cyclic state');
  }
  const entry = stored.tokenMap.find((candidate) => candidate.token === request.token);
  if (entry === undefined) throw new Error('unknown action token');
  const actionIndex = CAPABILITY_IDS.indexOf(entry.capabilityId);
  if (actionIndex === -1) throw new Error('unknown action capability');
  const delta = deltaForPhase(stored.phase, actionIndex);
  const next = {
    value: prior.value + delta,
    revision: prior.revision + 1,
    phase: (prior.phase + 1) % 3,
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

// 隐藏相位只存在于世界内部：每个接受的动作把相位推进一格，
// 当前相位上的赢家 +1、次者 0、其余 -1；观测向量不携带任何相位信息。
function deltaForPhase(phase, actionIndex) {
  if (actionIndex === phase % 3) return 1;
  if (actionIndex === (phase + 1) % 3) return 0;
  return -1;
}

function stateFromStore(source) {
  return {
    schemaVersion: VERSION,
    stateVersion: `cyclic-phase:${source.revision}`,
    revision: source.revision,
    value: source.value,
    phase: source.phase,
    usedExecutionNonces: [...source.usedExecutionNonces],
  };
}

function observation(state) {
  return {
    schemaVersion: VERSION,
    vector: [state.value],
    stateVersion: state.stateVersion,
    intervalId: `cyclic-phase:${state.revision}`,
    evidence: [],
  };
}

function readStore() {
  if (!existsSync(stateFile)) {
    return { value: 0, revision: 0, phase: 0, usedExecutionNonces: [], tokenMap: [], effects: [] };
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
  process.stdout.write(`${JSON.stringify({ protocol: PROTOCOL, version: VERSION, id, ok, ...(ok ? { result } : { error: result }) })}\n`);
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

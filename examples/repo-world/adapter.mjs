#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PROTOCOL = 'yi-world-cli';
const VERSION = 1;
const ADAPTER_ID = 'repo-readonly-example-v1';
const WORLD_ID = 'repo';
const CAPABILITY_IDS = ['repo.read-file', 'repo.run-tests'];
const VALUE_SPEC = {
  schemaVersion: VERSION,
  observationDimensions: 3,
  weights: [1, 1, 1],
  target: [0, 1, 1],
};
const EVIDENCE_PUBLIC_KEY =
  'MCowBQYDK2VwAyEA2R0znN74/jSx8OPrwSEnDH8UKEKU4l0es4XeSwfuOEY=';
const MAX_FILES = 512;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TREE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;

const repositoryRoot = path.resolve(process.argv[2] ?? '.');
const readPath = process.argv[3] ?? 'README.md';
const testPath = process.argv[4] ?? 'test/agent/model-advisor.test.mjs';
const rootRealPath = realpathSync(repositoryRoot);

const line = readFileSync(0, 'utf8').split(/\r?\n/u).find((item) => item.length > 0);
if (line === undefined) process.exit(64);

let request;
try {
  request = JSON.parse(line);
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
  respond(request.id, false, error instanceof Error ? error.message : 'adapter error');
}

function dispatch(op, payload) {
  if (op === 'hello') {
    const descriptor = {
      adapterId: ADAPTER_ID,
      worldId: WORLD_ID,
      worldVersion: 'repo-readonly-1',
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: ['working-tree'],
      valueSpec: VALUE_SPEC,
      evidencePublicKey: EVIDENCE_PUBLIC_KEY,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: makeState(0, scanRepository()) };
  if (op === 'actions') return { actions: actionsFor(payload.manifest) };
  if (op === 'observe') return { observation: observation(payload.state) };
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'transition') return transition(payload.state, payload.request, payload.manifest);
  throw new Error(`unsupported operation: ${op}`);
}

function actionsFor(manifest) {
  const entries = manifest?.tokenMap?.entries;
  if (!Array.isArray(entries) || entries.length !== CAPABILITY_IDS.length) {
    throw new Error('manifest token map is missing');
  }
  const byCapability = new Map(entries.map((entry) => [entry.capabilityId, entry.token]));
  return CAPABILITY_IDS.map((capabilityId) => {
    const token = byCapability.get(capabilityId);
    if (typeof token !== 'string') throw new Error(`manifest token is missing for ${capabilityId}`);
    return { schemaVersion: VERSION, token, cost: 1, allowed: true, safe: true };
  });
}

function transition(previous, request, manifest) {
  const capabilityId = new Map(
    (manifest?.tokenMap?.entries ?? []).map((entry) => [entry.token, entry.capabilityId]),
  ).get(request.token);
  if (!CAPABILITY_IDS.includes(capabilityId)) throw new Error('transition token is not a repo capability');

  let testCount = previous.testCount;
  let next;
  if (capabilityId === 'repo.read-file') {
    const content = readRepositoryFile(readPath);
    next = makeState(previous.revision + 1, null, request.executionNonce, previous.usedExecutionNonces, testCount);
    next.lastReadPath = normalizeRelative(readPath);
    next.lastReadDigest = canonicalDigest({ bytes: content.length, content });
  } else {
    const result = runTests();
    testCount += 1;
    next = makeState(previous.revision + 1, null, request.executionNonce, previous.usedExecutionNonces, testCount);
    next.lastTestStatus = result.status;
    next.lastTestExitCode = result.exitCode;
    next.lastTestOutputDigest = canonicalDigest(result.output);
  }
  const nextRepository = scanRepository();
  next.rootDigest = nextRepository.rootDigest;
  next.fileCount = nextRepository.fileCount;
  next.lastAction = capabilityId;
  next.stateVersion = `state:${WORLD_ID}:${next.revision}:${nextRepository.rootDigest.slice(7, 19)}`;
  return {
    nextWorldState: next,
    receipt: {
      schemaVersion: VERSION,
      status: 'ACCEPTED',
      token: request.token,
      basedOnVersion: request.basedOnVersion,
      policyVersion: request.policyVersion,
      constraintsDigest: request.constraintsDigest,
      executionNonce: request.executionNonce,
      effectDigest: canonicalDigest(next),
      rejectionReason: null,
      attributionWindowComplete: true,
      confounderCount: 0,
    },
    postObservation: observation(next),
  };
}

function makeState(revision, repository, executionNonce = null, previousNonces = [], testCount = 0) {
  return {
    schemaVersion: VERSION,
    stateVersion: repository === null
      ? `state:${WORLD_ID}:${revision}:pending`
      : `state:${WORLD_ID}:${revision}:${repository.rootDigest.slice(7, 19)}`,
    revision,
    usedExecutionNonces: executionNonce === null
      ? [...previousNonces]
      : [...previousNonces, executionNonce].slice(-8),
    rootDigest: repository?.rootDigest ?? null,
    fileCount: repository?.fileCount ?? 0,
    testCount,
    lastAction: null,
    lastReadPath: null,
    lastReadDigest: null,
    lastTestStatus: 'NOT_RUN',
    lastTestExitCode: null,
    lastTestOutputDigest: null,
  };
}

function observation(state) {
  return {
    schemaVersion: VERSION,
    vector: [state.fileCount, state.testCount, state.lastTestStatus === 'PASS' ? 1 : 0],
    stateVersion: state.stateVersion,
    intervalId: `${WORLD_ID}:interval:${state.revision}`,
    evidence: [
      { kind: 'repo-tree', rootDigest: state.rootDigest, fileCount: state.fileCount },
      { kind: 'repo-action', action: state.lastAction, readPath: state.lastReadPath, testStatus: state.lastTestStatus },
    ],
  };
}

function scanRepository() {
  const files = [];
  let totalBytes = 0;
  walk(rootRealPath, rootRealPath, files, (bytes) => {
    totalBytes += bytes;
    if (totalBytes > MAX_TREE_BYTES) throw new Error('repository content exceeds the read-only example limit');
  });
  if (files.length > MAX_FILES) throw new Error('repository file count exceeds the read-only example limit');
  const entries = files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    rootDigest: canonicalDigest(entries),
    fileCount: entries.length,
  };
}

function walk(currentPath, rootPath, files, countByte) {
  for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const fullPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootPath, fullPath).replaceAll(path.sep, '/');
    if (entry.isDirectory()) {
      walk(fullPath, rootPath, files, countByte);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = statSync(fullPath);
    const record = { path: relativePath, bytes: stat.size };
    if (stat.size <= MAX_FILE_BYTES) {
      const content = readFileSync(fullPath);
      record.digest = canonicalDigest({ content });
      countByte(content.length);
    } else {
      record.digest = null;
    }
    files.push(record);
    if (files.length > MAX_FILES) throw new Error('repository file count exceeds the read-only example limit');
  }
}

function readRepositoryFile(relativePath) {
  const target = resolveRepositoryPath(relativePath);
  const status = lstatSync(target);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error('read-file only permits regular files');
  const content = readFileSync(target, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('read-file exceeds the example limit');
  return content;
}

function runTests() {
  const target = resolveRepositoryPath(testPath);
  const status = lstatSync(target);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error('run-tests only permits a regular test file');
  const relativeTestPath = path.relative(rootRealPath, target);
  const result = spawnSync(process.execPath, ['--test', relativeTestPath], {
    cwd: rootRealPath,
    env: safeEnvironment(),
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    timeout: 30_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(0, MAX_OUTPUT_BYTES);
  return {
    status: result.status === 0 && result.signal === null && result.error === undefined ? 'PASS' : 'FAIL',
    exitCode: Number.isInteger(result.status) ? result.status : null,
    output,
  };
}

function resolveRepositoryPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error('repo paths must be non-empty relative paths');
  }
  const target = path.resolve(rootRealPath, relativePath);
  const relative = path.relative(rootRealPath, target);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('repo path escapes the configured repository root');
  }
  const targetRealPath = realpathSync(target);
  const realRelative = path.relative(rootRealPath, targetRealPath);
  if (realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error('repo path resolves outside the configured repository root');
  }
  return target;
}

function normalizeRelative(value) {
  return value.replaceAll('\\', '/');
}

function safeEnvironment() {
  const environment = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

function respond(id, ok, result) {
  const envelope = ok
    ? { protocol: PROTOCOL, version: VERSION, id, ok: true, result }
    : { protocol: PROTOCOL, version: VERSION, id, ok: false, error: result };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function canonicalJson(value, ancestors = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError('canonical JSON does not support this value');
  if (ancestors.has(value)) throw new TypeError('canonical JSON does not support cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

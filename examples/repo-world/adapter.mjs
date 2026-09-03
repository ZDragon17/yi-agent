#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PROTOCOL = 'yi-world-cli';
const VERSION = 1;
const WORLD_ID = 'repo';
const READONLY_ADAPTER_ID = 'repo-readonly-example-v1';
const WRITABLE_ADAPTER_ID = 'repo-writable-example-v1';
const READONLY_WORLD_VERSION = 'repo-readonly-1';
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
const MAX_PATCH_BYTES = 128 * 1024;
const MAX_NONCE_JOURNAL_BYTES = 2 * 1024 * 1024;

const repositoryRoot = path.resolve(process.argv[2] ?? '.');
const readPath = process.argv[3] ?? 'README.md';
const testPath = process.argv[4] ?? 'test/agent/model-advisor.test.mjs';
const patchSpecPath = process.argv[5] ?? null;
const nonceJournalPath = process.argv[6] ?? null;
const rootRealPath = realpathSync(repositoryRoot);
if ((patchSpecPath === null) !== (nonceJournalPath === null)) {
  throw new Error('writable repo mode requires both a patch spec and a nonce journal');
}
const patchSpec = patchSpecPath === null ? null : readPatchSpec(patchSpecPath);
const dropPatchResponse = process.argv.includes('--drop-patch-response');
if (nonceJournalPath !== null && isInsideRepository(nonceJournalPath)) {
  throw new Error('nonce journal must be outside the scanned repository');
}
const CAPABILITY_IDS = patchSpec === null
  ? ['repo.read-file', 'repo.run-tests']
  : ['repo.read-file', 'repo.run-tests', 'repo.apply-patch'];
const ADAPTER_ID = patchSpec === null ? READONLY_ADAPTER_ID : WRITABLE_ADAPTER_ID;
const WORLD_VERSION = patchSpec === null
  ? READONLY_WORLD_VERSION
  : `repo-writable-1-${patchSpec.digest.slice('sha256:'.length, 'sha256:'.length + 12)}`;

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
      worldVersion: WORLD_VERSION,
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: ['working-tree'],
      valueSpec: VALUE_SPEC,
      evidencePublicKey: EVIDENCE_PUBLIC_KEY,
      ...(patchSpec === null ? {} : { supportsIdempotentTransitions: true }),
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
  const preparedPatch = capabilityId === 'repo.apply-patch'
    ? prepareOrResumePatch(request)
    : null;
  if (preparedPatch?.kind === 'COMMITTED') return preparedPatch.result;
  const patchResult = preparedPatch;
  let next;
  if (capabilityId === 'repo.read-file') {
    const content = readRepositoryFile(readPath);
    next = makeState(previous.revision + 1, null, request.executionNonce, previous.usedExecutionNonces, testCount);
    next.lastReadPath = normalizeRelative(readPath);
    next.lastReadDigest = canonicalDigest({ bytes: content.length, content });
  } else if (capabilityId === 'repo.run-tests') {
    const result = runTests();
    testCount += 1;
    next = makeState(previous.revision + 1, null, request.executionNonce, previous.usedExecutionNonces, testCount);
    next.lastTestStatus = result.status;
    next.lastTestExitCode = result.exitCode;
    next.lastTestOutputDigest = canonicalDigest(result.output);
  } else {
    next = makeState(previous.revision + 1, null, request.executionNonce, previous.usedExecutionNonces, testCount);
    next.lastPatchPath = patchSpec.targetPath;
    next.lastPatchBeforeDigest = patchResult.beforeDigest;
    next.lastPatchAfterDigest = patchResult.afterDigest;
  }
  const nextRepository = scanRepository();
  next.rootDigest = nextRepository.rootDigest;
  next.fileCount = nextRepository.fileCount;
  next.lastAction = capabilityId;
  next.stateVersion = `state:${WORLD_ID}:${next.revision}:${nextRepository.rootDigest.slice(7, 19)}`;
  const response = {
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
  if (patchResult !== null) persistAppliedPatch(request, response);
  if (patchResult !== null && dropPatchResponse) process.exit(17);
  return response;
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
    lastPatchPath: null,
    lastPatchBeforeDigest: null,
    lastPatchAfterDigest: null,
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
      {
        kind: 'repo-action',
        action: state.lastAction,
        readPath: state.lastReadPath,
        testStatus: state.lastTestStatus,
        patchPath: state.lastPatchPath,
        patchBeforeDigest: state.lastPatchBeforeDigest,
        patchAfterDigest: state.lastPatchAfterDigest,
      },
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

function readPatchSpec(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.length > MAX_PATCH_BYTES) throw new Error('patch spec exceeds the writable example limit');
  let source;
  try {
    source = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('patch spec is not valid JSON');
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source) ||
      source.schemaVersion !== VERSION ||
      typeof source.targetPath !== 'string' || source.targetPath.length === 0 || source.targetPath.length > 4096 ||
      typeof source.expectedBeforeDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(source.expectedBeforeDigest) ||
      typeof source.replacement !== 'string' || Buffer.byteLength(source.replacement, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('patch spec is invalid');
  }
  const normalized = {
    schemaVersion: VERSION,
    targetPath: normalizeRelative(source.targetPath),
    expectedBeforeDigest: source.expectedBeforeDigest,
    replacement: source.replacement,
  };
  if (normalized.targetPath.includes('\0') || path.isAbsolute(normalized.targetPath)) {
    throw new Error('patch target must be a relative path');
  }
  return Object.freeze({
    ...normalized,
    afterDigest: contentDigest(normalized.replacement),
    digest: canonicalDigest(normalized),
  });
}

function prepareOrResumePatch(request) {
  if (patchSpec === null || nonceJournalPath === null) throw new Error('repo.apply-patch is not enabled');
  const requestDigest = canonicalDigest(request);
  const records = readNonceJournal();
  const existing = records.find((record) => record.executionNonce === request.executionNonce) ?? null;
  if (existing !== null) {
    if (existing.requestDigest !== requestDigest || existing.patchDigest !== patchSpec.digest) {
      throw new Error('execution nonce is already bound to a different patch request');
    }
    if (existing.status === 'APPLIED') return { kind: 'COMMITTED', result: existing.result };
    if (existing.status !== 'PREPARED') throw new Error('patch nonce journal status is invalid');
    return completePreparedPatch(existing);
  }

  const target = resolveRepositoryPath(patchSpec.targetPath);
  const before = readFileSync(target, 'utf8');
  const beforeDigest = contentDigest(before);
  if (beforeDigest !== patchSpec.expectedBeforeDigest) {
    throw new Error('patch target does not match its expected before digest');
  }
  const prepared = {
    schemaVersion: VERSION,
    status: 'PREPARED',
    executionNonce: request.executionNonce,
    requestDigest,
    patchDigest: patchSpec.digest,
    targetPath: patchSpec.targetPath,
    beforeDigest,
    afterDigest: patchSpec.afterDigest,
  };
  appendNonceRecord(prepared);
  return completePreparedPatch(prepared);
}

function completePreparedPatch(prepared) {
  const target = resolveRepositoryPath(prepared.targetPath);
  const status = lstatSync(target);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error('patch target must remain a regular file');
  const current = readFileSync(target, 'utf8');
  const currentDigest = contentDigest(current);
  if (currentDigest === prepared.afterDigest && current === patchSpec.replacement) {
    return { beforeDigest: prepared.beforeDigest, afterDigest: prepared.afterDigest };
  }
  if (currentDigest !== prepared.beforeDigest) {
    throw new Error('patch target changed after the prepared write boundary');
  }
  atomicReplace(target, patchSpec.replacement, status.mode);
  const after = readFileSync(target, 'utf8');
  const afterDigest = contentDigest(after);
  if (after !== patchSpec.replacement || afterDigest !== prepared.afterDigest) {
    throw new Error('patch target did not reach its expected after content');
  }
  return { beforeDigest: prepared.beforeDigest, afterDigest };
}

function persistAppliedPatch(request, result) {
  const requestDigest = canonicalDigest(request);
  const records = readNonceJournal();
  const index = records.findIndex((record) => record.executionNonce === request.executionNonce);
  if (index === -1) throw new Error('patch nonce journal entry disappeared');
  const existing = records[index];
  if (existing.requestDigest !== requestDigest || existing.patchDigest !== patchSpec.digest) {
    throw new Error('patch nonce journal request changed');
  }
  if (existing.status === 'APPLIED') {
    if (canonicalJson(existing.result) !== canonicalJson(result)) throw new Error('patch nonce journal result changed');
    return;
  }
  appendNonceRecord({ ...existing, status: 'APPLIED', result });
}

function readNonceJournal() {
  if (nonceJournalPath === null) return [];
  let source;
  try {
    const bytes = readFileSync(nonceJournalPath);
    if (bytes.length > MAX_NONCE_JOURNAL_BYTES) throw new Error('nonce journal exceeds the writable example limit');
    source = bytes.toString('utf8').trim();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (error?.message?.includes('exceeds the writable example limit')) throw error;
    throw new Error('nonce journal is not valid JSON');
  }
  if (source.length === 0) return [];
  const records = new Map();
  for (const line of source.split(/\r?\n/u)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error('nonce journal contains an incomplete record');
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record) ||
        record.schemaVersion !== VERSION || !['PREPARED', 'APPLIED'].includes(record.status) ||
        typeof record.executionNonce !== 'string' || typeof record.requestDigest !== 'string' ||
        typeof record.patchDigest !== 'string' || typeof record.targetPath !== 'string' ||
        typeof record.beforeDigest !== 'string' || typeof record.afterDigest !== 'string' ||
        (record.status === 'APPLIED' && (record.result === null || typeof record.result !== 'object'))) {
      throw new Error('nonce journal contains an invalid record');
    }
    records.set(record.executionNonce, record);
    if (records.size > 64) throw new Error('nonce journal contains too many records');
  }
  return [...records.values()];
}

function appendNonceRecord(record) {
  const handle = openSync(nonceJournalPath, 'a', 0o600);
  try {
    const buffer = Buffer.from(`${canonicalJson(record)}\n`, 'utf8');
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(handle, buffer, offset, buffer.length - offset);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function atomicReplace(target, content, mode) {
  atomicWriteText(target, content, mode);
}

function atomicWriteText(target, content, mode) {
  const temporary = `${target}.yi-agent-write-${process.pid}-${randomUUID()}`;
  let handle = null;
  try {
    handle = openSync(temporary, 'wx', 0o600);
    const buffer = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(handle, buffer, offset, buffer.length - offset);
    chmodSync(temporary, mode & 0o7777);
    fsyncSync(handle);
    closeSync(handle);
    handle = null;
    renameSync(temporary, target);
  } catch (error) {
    if (handle !== null) closeSync(handle);
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function contentDigest(content) {
  return canonicalDigest({ content });
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

function isInsideRepository(candidatePath) {
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(rootRealPath, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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

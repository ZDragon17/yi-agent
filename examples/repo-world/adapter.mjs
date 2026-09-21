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
const TEST_TIMEOUT_MS = 30_000;
const MAX_MODEL_READ_PATH_BYTES = 4 * 1024;
const MAX_MODEL_TEST_PATH_BYTES = 4 * 1024;
const MAX_PATCH_BYTES = 128 * 1024;
const MAX_PATCH_PATHS = 64;
const MAX_PROPOSAL_BYTES = 64 * 1024;
const MAX_MODEL_READ_CONTENT = 2 * 1024;
const MAX_FAILED_TESTS = 8;
const MAX_FAILED_TEST_NAME_BYTES = 256;
const MAX_NONCE_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_EXPERIENCE_BYTES = 64 * 1024;
const MAX_EXPERIENCE_ENTRIES = 32;
const MAX_EXPERIENCE_STEPS = 24;
const BEFORE_DIGEST_MODES = new Set(['fixed', 'current']);

const positionalArgs = collectPositionalArgs(process.argv.slice(2));
const repositoryRoot = path.resolve(positionalArgs[0] ?? '.');
const readPath = positionalArgs[1] ?? 'README.md';
const testPath = positionalArgs[2] ?? 'test/agent/model-advisor.test.mjs';
const patchSpecPath = positionalArgs[3] ?? null;
const nonceJournalPath = positionalArgs[4] ?? null;
const rootRealPath = realpathSync(repositoryRoot);
if ((patchSpecPath === null) !== (nonceJournalPath === null)) {
  throw new Error('writable repo mode requires both a patch spec and a nonce journal');
}
const patchSpec = patchSpecPath === null ? null : readPatchSpec(patchSpecPath);
const discoveryEnabled = process.argv.includes('--discover');
const dropPatchResponse = process.argv.includes('--drop-patch-response');
const maxTestExecutions = readOptionalBoundedOption('--max-tests', 1, 4);
const experienceLedgerPath = readOptionalAbsolutePathOption('--experience-ledger');
if (patchSpec?.targetPath === null && !discoveryEnabled) {
  throw new Error('dynamic patch policy requires discovery mode');
}
if (nonceJournalPath !== null && isInsideRepository(nonceJournalPath)) {
  throw new Error('nonce journal must be outside the scanned repository');
}
const CAPABILITY_IDS = [
  ...(discoveryEnabled ? ['repo.list-files'] : []),
  'repo.read-file',
  'repo.run-tests',
  ...(patchSpec === null ? [] : ['repo.apply-patch']),
];
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
    const selectedReadPath = readPathForRequest(request);
    const content = readRepositoryFile(selectedReadPath);
    next = makeState(previous.revision + 1, null, request.executionNonce, previous.usedExecutionNonces, testCount);
    next.lastReadPath = normalizeRelative(selectedReadPath);
    next.lastReadDigest = canonicalDigest({ bytes: content.length, content });
    next.lastReadContent = content.slice(0, MAX_MODEL_READ_CONTENT);
    next.lastReadContentTruncated = content.length > MAX_MODEL_READ_CONTENT;
  } else if (capabilityId === 'repo.list-files') {
    const repository = scanRepository();
    next = makeState(previous.revision + 1, null, request.executionNonce, previous.usedExecutionNonces, testCount);
    next.filePaths = repository.paths;
  } else if (capabilityId === 'repo.run-tests') {
    if (maxTestExecutions !== null && testCount >= maxTestExecutions) {
      throw new Error('repo.run-tests execution budget exhausted');
    }
    const result = runTests(testPathForRequest(request));
    testCount += 1;
    next = makeState(previous.revision + 1, null, request.executionNonce, previous.usedExecutionNonces, testCount);
    next.lastTestStatus = result.status;
    next.lastTestExitCode = result.exitCode;
    next.lastTestOutputDigest = canonicalDigest(result.output);
    next.lastTestDiagnostic = result.diagnostic;
  } else {
    next = makeState(previous.revision + 1, null, request.executionNonce, previous.usedExecutionNonces, testCount);
    next.lastPatchPath = patchResult.targetPath;
    next.lastPatchBeforeDigest = patchResult.beforeDigest;
    next.lastPatchAfterDigest = patchResult.afterDigest;
  }
  if (capabilityId !== 'repo.run-tests') {
    next.lastTestStatus = previous.lastTestStatus;
    next.lastTestExitCode = previous.lastTestExitCode;
    next.lastTestOutputDigest = previous.lastTestOutputDigest;
    next.lastTestDiagnostic = previous.lastTestDiagnostic;
  }
  const nextRepository = scanRepository();
  next.rootDigest = nextRepository.rootDigest;
  next.fileCount = nextRepository.fileCount;
  next.filePaths = discoveryEnabled ? nextRepository.paths : [];
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
    lastReadContent: null,
    lastReadContentTruncated: false,
    filePaths: discoveryEnabled ? repository?.paths ?? [] : [],
    lastTestStatus: 'NOT_RUN',
    lastTestExitCode: null,
    lastTestOutputDigest: null,
    lastTestDiagnostic: null,
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
      ...(discoveryEnabled ? [{
        kind: 'repo-file-list',
        paths: state.filePaths,
        truncated: false,
      }] : []),
      ...(discoveryEnabled ? [{
        kind: 'repo-read-policy',
        defaultPath: normalizeRelative(readPath),
        proposalSchema: {
          schemaVersion: VERSION,
          fields: ['path'],
          maxPathBytes: MAX_MODEL_READ_PATH_BYTES,
        },
      }] : []),
      {
        kind: 'repo-test-policy',
        testPath: normalizeRelative(testPath),
        ...(discoveryEnabled ? {
          allowedPaths: testPathsForPolicy(),
          proposalSchema: {
            schemaVersion: VERSION,
            fields: ['path'],
            maxPathBytes: MAX_MODEL_TEST_PATH_BYTES,
          },
        } : {}),
        timeoutMs: TEST_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        ...(maxTestExecutions === null ? {} : { maxExecutions: maxTestExecutions }),
      },
      {
        kind: 'repo-action',
        action: state.lastAction,
        readPath: state.lastReadPath,
        readFileDigest: state.lastReadDigest,
        readFileContent: state.lastReadContent,
        readFileContentTruncated: state.lastReadContentTruncated,
        testStatus: state.lastTestStatus,
        patchPath: state.lastPatchPath,
        patchBeforeDigest: state.lastPatchBeforeDigest,
        patchAfterDigest: state.lastPatchAfterDigest,
      },
      ...(patchSpec === null ? [] : [{
        kind: 'repo-patch-policy',
        ...(patchSpec.targetPath === null
          ? { allowedPaths: patchPolicyEntries() }
          : {
              targetPath: patchSpec.targetPath,
              expectedBeforeDigest: expectedBeforeDigestForPolicy(),
            }),
        ...(patchSpec.beforeDigestMode === undefined ? {} : { beforeDigestMode: patchSpec.beforeDigestMode }),
        proposalSchema: {
          schemaVersion: VERSION,
          fields: ['schemaVersion', 'targetPath', 'expectedBeforeDigest', 'replacement'],
          replacementEncoding: 'utf8',
          maxReplacementBytes: MAX_FILE_BYTES,
        },
      }]),
      ...(state.lastTestDiagnostic === null ? [] : [{
        kind: 'repo-test-result',
        ...state.lastTestDiagnostic,
      }]),
      ...(experienceLedgerPath === null ? [] : [{
        kind: 'repo-experience',
        ...readExperienceLedger(),
      }]),
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
    paths: entries.map((entry) => entry.path),
  };
}

function walk(currentPath, rootPath, files, countByte) {
  for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
    // The agent's own ledger is runtime state, not repository source. Scanning
    // it would make the adapter observe or reject its own growing history.
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.yi-agent') continue;
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

function readPathForRequest(request) {
  if (!discoveryEnabled || request.proposal === undefined) return readPath;
  if (request.proposal === null || typeof request.proposal !== 'object' || Array.isArray(request.proposal)) {
    throw new Error('repo read proposal must be an object');
  }
  const proposedPath = request.proposal.path;
  if (typeof proposedPath !== 'string' || proposedPath.length === 0) {
    throw new Error('repo read proposal path must be a non-empty string');
  }
  if (Buffer.byteLength(proposedPath, 'utf8') > MAX_MODEL_READ_PATH_BYTES) {
    throw new Error('repo read proposal path exceeds the example limit');
  }
  const normalized = normalizeRelative(proposedPath);
  if (!scanRepository().paths.includes(normalized)) {
    throw new Error('repo read proposal path is not in the discovery listing');
  }
  return normalized;
}

function testPathForRequest(request) {
  if (!discoveryEnabled || request.proposal === undefined) return testPath;
  if (request.proposal === null || typeof request.proposal !== 'object' || Array.isArray(request.proposal)) {
    throw new Error('repo test proposal must be an object');
  }
  const proposedPath = request.proposal.path;
  if (typeof proposedPath !== 'string' || proposedPath.length === 0) {
    throw new Error('repo test proposal path must be a non-empty string');
  }
  if (Buffer.byteLength(proposedPath, 'utf8') > MAX_MODEL_TEST_PATH_BYTES) {
    throw new Error('repo test proposal path exceeds the example limit');
  }
  const normalized = normalizeRelative(proposedPath);
  if (!testPathsForPolicy().includes(normalized)) {
    throw new Error('repo test proposal path is not in the test policy');
  }
  return normalized;
}

function testPathsForPolicy() {
  return scanRepository().paths.filter((candidate) => (
    /^(?:test|tests)\/.*(?:\.test|\.spec)\.(?:mjs|cjs|js)$/u.test(candidate)
  ));
}

function readOptionalBoundedOption(name, minimum, maximum) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!/^\d+$/u.test(value ?? '')) throw new Error(`${name} requires an integer value`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function readOptionalAbsolutePathOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--') || !path.isAbsolute(value)) {
    throw new Error(`${name} requires an absolute path`);
  }
  const normalized = path.normalize(value);
  const status = lstatSync(normalized);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`${name} must reference a regular file`);
  return normalized;
}

function readExperienceLedger() {
  const bytes = readFileSync(experienceLedgerPath);
  if (bytes.length > MAX_EXPERIENCE_BYTES) throw new Error('experience ledger exceeds the example limit');
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('experience ledger is not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value.schemaVersion !== VERSION || value.type !== 'repo-experience' ||
      !Array.isArray(value.entries) || value.entries.length > MAX_EXPERIENCE_ENTRIES) {
    throw new Error('experience ledger is invalid');
  }
  const entries = value.entries.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some((key) => !['taskId', 'workflow', 'testExecutions', 'replayVerdict'].includes(key)) ||
        typeof entry.taskId !== 'string' || entry.taskId.length === 0 ||
        entry.taskId.length > 64 ||
        !Array.isArray(entry.workflow) || entry.workflow.length > MAX_EXPERIENCE_STEPS ||
        entry.workflow.some((capabilityId) => typeof capabilityId !== 'string' || capabilityId.length === 0 || capabilityId.length > 128) ||
        !Number.isSafeInteger(entry.testExecutions) || entry.testExecutions < 0 || entry.testExecutions > 4 ||
        entry.replayVerdict !== 'CONSISTENT') {
      throw new Error('experience ledger entry is invalid');
    }
    return {
      taskId: entry.taskId,
      workflow: [...entry.workflow],
      testExecutions: entry.testExecutions,
      replayVerdict: entry.replayVerdict,
    };
  });
  return { schemaVersion: VERSION, type: 'repo-experience', entries };
}

function collectPositionalArgs(args) {
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--max-tests') {
      index += 1;
      continue;
    }
    if (argument === '--experience-ledger') {
      index += 1;
      continue;
    }
    if (!argument.startsWith('--')) positional.push(argument);
  }
  return positional;
}

function runTests(selectedTestPath = testPath) {
  const target = resolveRepositoryPath(selectedTestPath);
  const status = lstatSync(target);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error('run-tests only permits a regular test file');
  const relativeTestPath = path.relative(rootRealPath, target);
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', relativeTestPath], {
    cwd: rootRealPath,
    env: safeEnvironment(),
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    timeout: TEST_TIMEOUT_MS,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(0, MAX_OUTPUT_BYTES);
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const testStatus = result.status === 0 && result.signal === null && result.error === undefined ? 'PASS' : 'FAIL';
  return {
    status: testStatus,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    output,
    diagnostic: {
      status: testStatus,
      exitCode: Number.isInteger(result.status) ? result.status : null,
      timedOut,
      signal: result.signal ?? null,
      failedTests: testStatus === 'PASS' ? [] : failedTestNames(output),
    },
  };
}

function failedTestNames(output) {
  const names = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^not ok \d+ - (.+)$/u.exec(line);
    if (match === null) continue;
    const name = match[1].replaceAll(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, MAX_FAILED_TEST_NAME_BYTES);
    if (name.length > 0 && !names.includes(name)) names.push(name);
    if (names.length >= MAX_FAILED_TESTS) break;
  }
  return names;
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
  const fixedTarget = typeof source?.targetPath === 'string';
  const dynamicTargets = Array.isArray(source?.allowedPaths);
  if (source === null || typeof source !== 'object' || Array.isArray(source) ||
      source.schemaVersion !== VERSION || fixedTarget === dynamicTargets ||
      (fixedTarget && (source.targetPath.length === 0 || source.targetPath.length > 4096 ||
        typeof source.expectedBeforeDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(source.expectedBeforeDigest))) ||
      (dynamicTargets && (source.allowedPaths.length === 0 || source.allowedPaths.length > MAX_PATCH_PATHS ||
        source.allowedPaths.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 4096))) ||
      (source.beforeDigestMode !== undefined && !BEFORE_DIGEST_MODES.has(source.beforeDigestMode)) ||
      (dynamicTargets && source.beforeDigestMode !== undefined && source.beforeDigestMode !== 'current')) {
    throw new Error('patch spec is invalid');
  }
  const normalized = {
    schemaVersion: VERSION,
    targetPath: fixedTarget ? normalizeRelative(source.targetPath) : null,
    ...(fixedTarget ? { expectedBeforeDigest: source.expectedBeforeDigest } : {
      allowedPaths: [...new Set(source.allowedPaths.map((item) => normalizeRelative(item)))].sort(),
      beforeDigestMode: 'current',
    }),
    ...(fixedTarget && source.beforeDigestMode === undefined ? {} :
      fixedTarget ? { beforeDigestMode: source.beforeDigestMode } : {}),
  };
  if (normalized.targetPath !== null && (normalized.targetPath.includes('\0') || path.isAbsolute(normalized.targetPath))) {
    throw new Error('patch target must be a relative path');
  }
  if (normalized.allowedPaths?.some((item) => item.includes('\0') || path.isAbsolute(item))) {
    throw new Error('patch target must be a relative path');
  }
  return Object.freeze({
    ...normalized,
    digest: canonicalDigest(normalized),
  });
}

function expectedBeforeDigestForPolicy() {
  if (patchSpec.targetPath === null) throw new Error('dynamic patch policy requires a selected target');
  if (patchSpec.beforeDigestMode !== 'current') return patchSpec.expectedBeforeDigest;
  return expectedBeforeDigestForTarget(patchSpec.targetPath);
}

function expectedBeforeDigestForTarget(targetPath) {
  const target = resolveRepositoryPath(targetPath);
  const status = lstatSync(target);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error('patch target must remain a regular file');
  return contentDigest(readFileSync(target, 'utf8'));
}

function patchPolicyEntries() {
  if (patchSpec.targetPath !== null) return undefined;
  const listedPaths = new Set(scanRepository().paths);
  return patchSpec.allowedPaths.map((targetPath) => {
    if (!listedPaths.has(targetPath)) throw new Error('dynamic patch target is not in the discovery listing');
    return {
      path: targetPath,
      expectedBeforeDigest: expectedBeforeDigestForTarget(targetPath),
    };
  });
}

function prepareOrResumePatch(request) {
  if (patchSpec === null || nonceJournalPath === null) throw new Error('repo.apply-patch is not enabled');
  const proposal = readPatchProposal(request.proposal);
  const proposalDigest = canonicalDigest(proposal);
  const requestDigest = canonicalDigest(request);
  const records = readNonceJournal();
  const existing = records.find((record) => record.executionNonce === request.executionNonce) ?? null;
  if (existing !== null) {
    if (existing.requestDigest !== requestDigest || existing.patchDigest !== proposalDigest) {
      throw new Error('execution nonce is already bound to a different patch request');
    }
    if (existing.status === 'APPLIED') return { kind: 'COMMITTED', result: existing.result };
    if (existing.status !== 'PREPARED') throw new Error('patch nonce journal status is invalid');
    return completePreparedPatch(existing, proposal);
  }

  const target = resolveRepositoryPath(proposal.targetPath);
  const before = readFileSync(target, 'utf8');
  const beforeDigest = contentDigest(before);
  const authorizedBeforeDigest = patchSpec.targetPath === null
    ? expectedBeforeDigestForTarget(proposal.targetPath)
    : expectedBeforeDigestForPolicy();
  if (proposal.expectedBeforeDigest !== authorizedBeforeDigest || beforeDigest !== authorizedBeforeDigest) {
    throw new Error('patch target does not match its expected before digest');
  }
  const prepared = {
    schemaVersion: VERSION,
    status: 'PREPARED',
    executionNonce: request.executionNonce,
    requestDigest,
    patchDigest: proposalDigest,
    targetPath: proposal.targetPath,
    beforeDigest,
    afterDigest: contentDigest(proposal.replacement),
  };
  appendNonceRecord(prepared);
  return completePreparedPatch(prepared, proposal);
}

function completePreparedPatch(prepared, proposal) {
  const target = resolveRepositoryPath(prepared.targetPath);
  const status = lstatSync(target);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error('patch target must remain a regular file');
  const current = readFileSync(target, 'utf8');
  const currentDigest = contentDigest(current);
  if (currentDigest === prepared.afterDigest && current === proposal.replacement) {
    return {
      targetPath: prepared.targetPath,
      beforeDigest: prepared.beforeDigest,
      afterDigest: prepared.afterDigest,
    };
  }
  if (currentDigest !== prepared.beforeDigest) {
    throw new Error('patch target changed after the prepared write boundary');
  }
  atomicReplace(target, proposal.replacement, status.mode);
  const after = readFileSync(target, 'utf8');
  const afterDigest = contentDigest(after);
  if (after !== proposal.replacement || afterDigest !== prepared.afterDigest) {
    throw new Error('patch target did not reach its expected after content');
  }
  return {
    targetPath: prepared.targetPath,
    beforeDigest: prepared.beforeDigest,
    afterDigest,
  };
}

function persistAppliedPatch(request, result) {
  const proposalDigest = canonicalDigest(readPatchProposal(request.proposal));
  const requestDigest = canonicalDigest(request);
  const records = readNonceJournal();
  const index = records.findIndex((record) => record.executionNonce === request.executionNonce);
  if (index === -1) throw new Error('patch nonce journal entry disappeared');
  const existing = records[index];
  if (existing.requestDigest !== requestDigest || existing.patchDigest !== proposalDigest) {
    throw new Error('patch nonce journal request changed');
  }
  if (existing.status === 'APPLIED') {
    if (canonicalJson(existing.result) !== canonicalJson(result)) throw new Error('patch nonce journal result changed');
    return;
  }
  appendNonceRecord({ ...existing, status: 'APPLIED', result });
}

function readPatchProposal(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value.schemaVersion !== VERSION || typeof value.targetPath !== 'string' ||
      typeof value.expectedBeforeDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.expectedBeforeDigest) ||
      typeof value.replacement !== 'string' || Buffer.byteLength(value.replacement, 'utf8') > MAX_FILE_BYTES ||
      Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_PROPOSAL_BYTES) {
    throw new Error('repo.apply-patch proposal is invalid');
  }
  const normalized = {
    schemaVersion: VERSION,
    targetPath: normalizeRelative(value.targetPath),
    expectedBeforeDigest: value.expectedBeforeDigest,
    replacement: value.replacement,
  };
  const authorized = patchSpec.targetPath === null
    ? patchSpec.allowedPaths.includes(normalized.targetPath)
    : normalized.targetPath === patchSpec.targetPath;
  if (!authorized || normalized.targetPath.includes('\0') || path.isAbsolute(normalized.targetPath)) {
    throw new Error('repo.apply-patch proposal is not authorized by the patch policy');
  }
  return normalized;
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

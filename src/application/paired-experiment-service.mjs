import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { LabStore, LabStoreError } from '../runtime/lab-store.mjs';
import { annotateCandidateHistory } from '../runtime/candidate-history.mjs';
import { canonicalDigest, canonicalJson, SCHEMA_VERSION, verifySelfDigest, withSelfDigest } from '../runtime/schema.mjs';
import { initLab, inspectLab, replayLab, runLab } from './agent-service.mjs';
import { builtInWorldRegistry } from './world-registry.mjs';

const TOKEN_PATTERN = /^tok_[A-Z0-9]{8,128}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EXPERIMENT_TYPE = 'paired-candidate-experiment';

export async function runPairedCandidates(input) {
  const source = requireRecord(input, 'paired experiment input');
  const parentLabPath = await existingPath(requireText(source.labPath, 'labPath'), 'labPath');
  const outputPath = path.resolve(requireAbsoluteText(source.outputPath, 'outputPath'));
  const resume = source.resume === true;
  const failpoint = typeof source.failpoint === 'function' ? source.failpoint : undefined;
  const registry = source.registry ?? builtInWorldRegistry;
  const parentStore = await LabStore.open({ labPath: parentLabPath });
  const parentInspection = await parentStore.inspect();
  if (parentStore.manifest.adapter !== undefined) {
    throw new LabStoreError('CONFLICT', 'Paired candidate experiments require an isolated built-in WorldPort.', {
      field: 'adapter',
    });
  }
  registry.assertManifest(parentStore.manifest);

  const pairStartPath = path.join(outputPath, 'pair.start.json');
  const pairEndPath = path.join(outputPath, 'pair.end.json');
  let existingStart = await readOptionalPair(pairStartPath, 'pair start');
  const existingEnd = await readOptionalPair(pairEndPath, 'pair end');
  if (existingEnd !== null) {
    if (existingStart === null) {
      throw new LabStoreError('CORRUPT', 'Paired experiment end evidence has no start evidence.', {
        field: 'pair.start.json',
      });
    }
    validatePairStart(existingStart, parentLabPath, parentStore.manifest, parentInspection.current);
    validatePairParent(existingEnd, existingStart, parentInspection.current);
    return existingEnd;
  }
  if (existingStart !== null) {
    if (!resume) {
      throw new LabStoreError('CONFLICT', 'An incomplete paired experiment exists; use --resume.', {
        field: 'resume',
      });
    }
    validatePairStart(existingStart, parentLabPath, parentStore.manifest, parentInspection.current);
  } else {
    if (resume) {
      throw new LabStoreError('NOT_FOUND', 'Paired experiment start evidence was not found.', {
        field: 'outputPath',
      });
    }
    if (parentInspection.current.lastRunId === null || parentInspection.current.status === 'RUNNING' ||
        parentInspection.current.status === 'CORRUPT') {
      throw new LabStoreError('CONFLICT', 'A paired experiment requires a terminal parent Run.', {
        field: 'labPath',
      });
    }
    const leftToken = requireToken(source.leftToken, 'leftToken');
    const rightToken = requireToken(source.rightToken, 'rightToken');
    if (leftToken === rightToken) {
      throw new LabStoreError('INVALID_INPUT', 'leftToken and rightToken must differ.', {
        fields: ['leftToken', 'rightToken'],
      });
    }
    if (!tokenInManifest(parentStore.manifest, leftToken) || !tokenInManifest(parentStore.manifest, rightToken)) {
      throw new LabStoreError('INVALID_INPUT', 'Paired experiment candidates must be part of the parent token map.', {
        fields: ['leftToken', 'rightToken'],
      });
    }
    const scenario = source.scenario ?? 'steady';
    const worldDefinition = registry.worldDefinition(parentStore.manifest.worldId);
    if (!Array.isArray(parentStore.manifest.scenarioIds) || !parentStore.manifest.scenarioIds.includes(scenario)) {
      throw new LabStoreError('INVALID_INPUT', 'Paired experiment scenario is unsupported.', { field: 'scenario' });
    }
    const parentState = continuityState(parentInspection.current);
    existingStart = withSelfDigest({
      schemaVersion: SCHEMA_VERSION,
      type: EXPERIMENT_TYPE,
      version: 1,
      createdAt: new Date().toISOString(),
      parentLabPath,
      parentManifestDigest: parentStore.manifest.selfDigest,
      parentCurrentDigest: parentInspection.current.selfDigest,
      worldId: parentStore.manifest.worldId,
      worldVersion: parentStore.manifest.worldVersion ?? worldDefinition?.worldVersion ?? null,
      tokenMapDigest: parentStore.manifest.tokenMap.digest,
      scenario,
      initialStateDigest: canonicalDigest(parentState),
      candidates: { leftToken, rightToken },
      branches: { left: 'left', right: 'right' },
      runIds: { left: 'run-1', right: 'run-1' },
    });
    await ensureNewExperimentDirectory(outputPath, pairStartPath);
    await writeExclusiveJson(pairStartPath, existingStart);
  }

  const parentState = continuityState(parentInspection.current);
  if (canonicalDigest(parentState) !== existingStart.initialStateDigest) {
    throw new LabStoreError('CONFLICT', 'Parent continuity state changed after the paired experiment was created.', {
      field: 'parentCurrentDigest',
    });
  }
  const branchResults = {};
  for (const side of ['left', 'right']) {
    branchResults[side] = await ensureBranch({
      outputPath,
      side,
      parent: parentStore.manifest,
      initialState: parentState,
      scenario: existingStart.scenario,
      token: existingStart.candidates[`${side}Token`],
      runId: existingStart.runIds[side],
      registry,
    });
    if (side === 'left' && failpoint?.('paired:after-left') === true) {
      throw new LabStoreError('INJECTED_FAILURE', 'Injected failure after the left paired branch.', {
        point: 'paired:after-left',
      });
    }
  }

  const leftHistory = await branchResults.left.store.readCandidateOutcomes();
  const rightHistory = await branchResults.right.store.readCandidateOutcomes();
  const pairedHistory = annotateCandidateHistory([...leftHistory, ...rightHistory]);
  const comparison = pairedHistory.at(-1)?.pairedComparison;
  if (comparison === undefined) {
    throw new LabStoreError('CONFLICT', 'Paired branches did not produce a comparable verified outcome.', {
      field: 'candidateHistory',
    });
  }
  const replayVerdicts = {
    left: (await replayLab({ labPath: branchResults.left.path, runId: existingStart.runIds.left, registry })).verdict,
    right: (await replayLab({ labPath: branchResults.right.path, runId: existingStart.runIds.right, registry })).verdict,
  };
  if (replayVerdicts.left !== 'CONSISTENT' || replayVerdicts.right !== 'CONSISTENT') {
    throw new LabStoreError('CONFLICT', 'A paired branch failed Replay consistency.', { field: 'replayVerdicts' });
  }
  const finalParent = await parentStore.inspect();
  if (finalParent.current.selfDigest !== existingStart.parentCurrentDigest) {
    throw new LabStoreError('CONFLICT', 'Parent continuity state changed during the paired experiment.', {
      field: 'parentCurrentDigest',
    });
  }
  const end = withSelfDigest({
    schemaVersion: SCHEMA_VERSION,
    type: EXPERIMENT_TYPE,
    version: 1,
    startDigest: existingStart.selfDigest,
    completedAt: new Date().toISOString(),
    verdict: 'PASS',
    comparison,
    replayVerdicts,
    parentCurrentDigest: existingStart.parentCurrentDigest,
    branches: {
      left: { path: path.join(outputPath, 'left'), runId: existingStart.runIds.left },
      right: { path: path.join(outputPath, 'right'), runId: existingStart.runIds.right },
    },
  });
  await writeExclusiveJson(pairEndPath, end);
  return end;
}

async function ensureBranch({ outputPath, side, parent, initialState, scenario, token, runId, registry }) {
  const branchPath = path.join(outputPath, side);
  if (!tokenInManifest(parent, token)) {
    throw new LabStoreError('CORRUPT', `${side} branch candidate is not part of the parent token map.`, {
      field: `${side}Token`,
    });
  }
  await initLab({
    labPath: branchPath,
    labId: parent.labId,
    worldId: parent.worldId,
    seed: parent.seed,
    registry,
  });
  const store = await LabStore.open({ labPath: branchPath });
  registry.assertManifest(store.manifest);
  if (store.manifest.tokenMap.digest !== parent.tokenMap.digest ||
      store.manifest.worldVersion !== parent.worldVersion ||
      store.manifest.worldImplementationDigest !== parent.worldImplementationDigest) {
    throw new LabStoreError('CONFLICT', 'Paired branch WorldPort identity differs from the parent.', {
      field: 'manifest',
    });
  }
  let inspection = await store.inspect();
  if (inspection.current.status === 'RUNNING') {
    await LabStore.recover({ labPath: branchPath });
    inspection = await store.inspect();
  }
  if (inspection.current.lastRunId === null) {
    await runLab({
      labPath: branchPath,
      runId,
      steps: 1,
      scenario,
      registry,
      initialState,
      advisor: fixedAdvisor(token, side),
    });
  } else {
    const run = await store.readRun(runId);
    if (canonicalDigest(run.start.initialState) !== canonicalDigest(initialState) || run.start.scenario !== scenario) {
      throw new LabStoreError('CONFLICT', `${side} branch does not continue the paired initial state.`, {
        field: `${side}.start`,
      });
    }
  }
  return { path: branchPath, store: await LabStore.open({ labPath: branchPath }) };
}

function fixedAdvisor(token, side) {
  return async () => ({
    model: `paired-experiment-${side}`,
    token,
    responseDigest: canonicalDigest({ token, side }),
    reason: null,
  });
}

function continuityState(current) {
  return {
    worldState: current.worldState,
    memory: current.memory,
    rngState: current.rngState,
    kernelStep: current.kernelStep,
    ...(current.changeSupervisor === undefined ? {} : { changeSupervisor: current.changeSupervisor }),
  };
}

function validatePairStart(start, parentLabPath, manifest, current) {
  if (start.type !== EXPERIMENT_TYPE || start.version !== 1 ||
      start.parentLabPath !== parentLabPath || start.parentManifestDigest !== manifest.selfDigest ||
      start.parentCurrentDigest !== current.selfDigest || start.worldId !== manifest.worldId ||
      start.worldVersion !== (manifest.worldVersion ?? null) || start.tokenMapDigest !== manifest.tokenMap.digest ||
       !scenarioAllowed(manifest, start.scenario) || !DIGEST_PATTERN.test(start.initialStateDigest ?? '') ||
       !isCandidateToken(start.candidates?.leftToken) || !isCandidateToken(start.candidates?.rightToken) ||
       !tokenInManifest(manifest, start.candidates.leftToken) || !tokenInManifest(manifest, start.candidates.rightToken) ||
       start.candidates.leftToken === start.candidates.rightToken ||
      start.branches?.left !== 'left' || start.branches?.right !== 'right' ||
      start.runIds?.left !== 'run-1' || start.runIds?.right !== 'run-1') {
    throw new LabStoreError('CORRUPT', 'Paired experiment start evidence does not match the current parent.', {
      field: 'pair.start.json',
    });
  }
}

function validatePairParent(end, start, current) {
  if (end.type !== EXPERIMENT_TYPE || end.version !== 1 || end.startDigest !== start.selfDigest ||
      end.parentCurrentDigest !== current.selfDigest || end.verdict !== 'PASS' ||
      end.replayVerdicts?.left !== 'CONSISTENT' || end.replayVerdicts?.right !== 'CONSISTENT' ||
      end.comparison?.pair !== 'same-before-state-v1' ||
      end.comparison.beforeStateDigest !== start.initialStateDigest ||
      !DIGEST_PATTERN.test(end.comparison.leftCandidateDigest ?? '') ||
      !DIGEST_PATTERN.test(end.comparison.rightCandidateDigest ?? '')) {
    throw new LabStoreError('CORRUPT', 'Paired experiment end evidence does not match its start and parent.', {
      field: 'pair.end.json',
    });
  }
}

async function ensureNewExperimentDirectory(outputPath, pairStartPath) {
  try {
    const stats = await lstat(outputPath);
    if (!stats.isDirectory()) throw new LabStoreError('CONFLICT', 'outputPath is not a directory.', { field: 'outputPath' });
    const entries = await readdir(outputPath);
    if (entries.length > 0 || await pathExists(pairStartPath)) {
      throw new LabStoreError('CONFLICT', 'outputPath already contains an experiment.', { field: 'outputPath' });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(outputPath, { recursive: false });
  }
}

async function writeExclusiveJson(filePath, value) {
  await writeFile(filePath, `${canonicalJson(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

async function readOptionalPair(filePath, label) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new LabStoreError('CORRUPT', `${label} is not valid JSON.`, { filePath }, { cause: error });
  }
  if (!verifySelfDigest(value)) throw new LabStoreError('CORRUPT', `${label} digest is invalid.`, { filePath });
  return value;
}

async function existingPath(value, field) {
  try {
    return await realpath(path.resolve(value));
  } catch (error) {
    throw new LabStoreError('NOT_FOUND', `${field} does not exist.`, { field }, { cause: error });
  }
}

async function pathExists(value) {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function requireToken(value, field) {
  if (!isCandidateToken(value)) {
    throw new LabStoreError('INVALID_INPUT', `${field} must be a valid opaque token.`, { field });
  }
  return value;
}

function isCandidateToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function scenarioAllowed(manifest, scenario) {
  return Array.isArray(manifest.scenarioIds) && manifest.scenarioIds.includes(scenario);
}

function tokenInManifest(manifest, token) {
  return Array.isArray(manifest.tokenMap?.entries) && manifest.tokenMap.entries.some((entry) => entry.token === token);
}

function requireAbsoluteText(value, field) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new LabStoreError('INVALID_INPUT', `${field} must be an absolute path.`, { field });
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LabStoreError('INVALID_INPUT', `${field} must be a non-empty string.`, { field });
  }
  return value;
}

function requireRecord(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LabStoreError('INVALID_INPUT', `${field} must be an object.`, { field });
  }
  return value;
}

import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { LabStore, LabStoreError } from '../runtime/lab-store.mjs';
import { comparePairedTrajectories } from '../runtime/trajectory-comparison.mjs';
import { canonicalDigest, canonicalJson, SCHEMA_VERSION, verifySelfDigest, withSelfDigest } from '../runtime/schema.mjs';
import { initLab, replayLab, runLab } from './agent-service.mjs';
import { builtInWorldRegistry } from './world-registry.mjs';

const TOKEN_PATTERN = /^tok_[A-Z0-9]{8,128}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TRAJECTORY_TYPE = 'paired-trajectory-experiment';
const TRAJECTORY_MODE = 'open-loop-token-trajectory-v1';
const MAX_TRAJECTORY_STEPS = 8;

export async function runPairedTrajectories(input) {
  const source = requireRecord(input, 'paired trajectory input');
  const parentLabPath = await existingPath(requireText(source.labPath, 'labPath'), 'labPath');
  const outputPath = path.resolve(requireAbsoluteText(source.outputPath, 'outputPath'));
  const resume = source.resume === true;
  const failpoint = typeof source.failpoint === 'function' ? source.failpoint : undefined;
  const registry = source.registry ?? builtInWorldRegistry;
  const parentStore = await LabStore.open({ labPath: parentLabPath });
  const parentInspection = await parentStore.inspect();
  if (parentStore.manifest.adapter !== undefined) {
    throw new LabStoreError('CONFLICT', 'Paired trajectories require an isolated built-in WorldPort.', { field: 'adapter' });
  }
  registry.assertManifest(parentStore.manifest);

  const pairStartPath = path.join(outputPath, 'trajectory.start.json');
  const pairEndPath = path.join(outputPath, 'trajectory.end.json');
  let existingStart = await readOptionalEvidence(pairStartPath, 'trajectory start');
  const existingEnd = await readOptionalEvidence(pairEndPath, 'trajectory end');
  if (existingEnd !== null) {
    if (existingStart === null) {
      throw new LabStoreError('CORRUPT', 'Trajectory end evidence has no start evidence.', { field: 'trajectory.start.json' });
    }
    validateTrajectoryStart(existingStart, parentLabPath, parentStore.manifest, parentInspection.current);
    validateTrajectoryEnd(existingEnd, existingStart, parentInspection.current);
    const branches = await validatePersistedBranches({
      end: existingEnd,
      start: existingStart,
      outputPath,
      manifest: parentStore.manifest,
      registry,
    });
    const comparison = await trajectoryComparison(existingStart, branches);
    if (canonicalJson(comparison) !== canonicalJson(existingEnd.comparison)) {
      throw new LabStoreError('CORRUPT', 'Trajectory end comparison no longer matches branch evidence.', {
        field: 'trajectory.end.json.comparison',
      });
    }
    return existingEnd;
  }
  if (existingStart !== null) {
    if (!resume) {
      throw new LabStoreError('CONFLICT', 'An incomplete trajectory experiment exists; use --resume.', { field: 'resume' });
    }
    validateTrajectoryStart(existingStart, parentLabPath, parentStore.manifest, parentInspection.current);
  } else {
    if (resume) {
      throw new LabStoreError('NOT_FOUND', 'Trajectory experiment start evidence was not found.', { field: 'outputPath' });
    }
    requireTerminalParent(parentInspection.current);
    const leftTokens = requireTrajectory(source.leftTokens, 'leftTokens', parentStore.manifest);
    const rightTokens = requireTrajectory(source.rightTokens, 'rightTokens', parentStore.manifest);
    if (leftTokens.length !== rightTokens.length || canonicalDigest(leftTokens) === canonicalDigest(rightTokens)) {
      throw new LabStoreError('INVALID_INPUT', 'Paired trajectories must have equal lengths and differ.', {
        fields: ['leftTokens', 'rightTokens'],
      });
    }
    const scenario = source.scenario ?? 'steady';
    if (!scenarioAllowed(parentStore.manifest, scenario)) {
      throw new LabStoreError('INVALID_INPUT', 'Paired trajectory scenario is unsupported.', { field: 'scenario' });
    }
    const parentState = continuityState(parentInspection.current);
    existingStart = withSelfDigest({
      schemaVersion: SCHEMA_VERSION,
      type: TRAJECTORY_TYPE,
      version: 1,
      mode: TRAJECTORY_MODE,
      createdAt: new Date().toISOString(),
      parentLabPath,
      parentManifestDigest: parentStore.manifest.selfDigest,
      parentCurrentDigest: parentInspection.current.selfDigest,
      worldId: parentStore.manifest.worldId,
      worldVersion: parentStore.manifest.worldVersion,
      tokenMapDigest: parentStore.manifest.tokenMap.digest,
      scenario,
      initialStateDigest: canonicalDigest(parentState),
      initialKernelStep: parentState.kernelStep,
      trajectories: { left: leftTokens, right: rightTokens },
      runIds: {
        left: leftTokens.map((_, index) => `run-${index + 1}`),
        right: rightTokens.map((_, index) => `run-${index + 1}`),
      },
    });
    await ensureNewExperimentDirectory(outputPath, pairStartPath);
    await writeExclusiveJson(pairStartPath, existingStart);
  }

  const parentState = continuityState(parentInspection.current);
  if (canonicalDigest(parentState) !== existingStart.initialStateDigest) {
    throw new LabStoreError('CONFLICT', 'Parent continuity state changed after the trajectory experiment was created.', {
      field: 'parentCurrentDigest',
    });
  }
  const branches = {};
  for (const side of ['left', 'right']) {
    branches[side] = await ensureTrajectoryBranch({
      outputPath,
      side,
      parent: parentStore.manifest,
      initialState: parentState,
      tokens: existingStart.trajectories[side],
      runIds: existingStart.runIds[side],
      scenario: existingStart.scenario,
      registry,
      failpoint,
    });
  }
  const comparison = await trajectoryComparison(existingStart, branches);
  const replayVerdicts = {
    left: await replayRuns(branches.left.path, existingStart.runIds.left, registry),
    right: await replayRuns(branches.right.path, existingStart.runIds.right, registry),
  };
  if (replayVerdicts.left.some((verdict) => verdict !== 'CONSISTENT') ||
      replayVerdicts.right.some((verdict) => verdict !== 'CONSISTENT')) {
    throw new LabStoreError('CONFLICT', 'A paired trajectory branch failed Replay consistency.', { field: 'replayVerdicts' });
  }
  const finalParent = await parentStore.inspect();
  if (finalParent.current.selfDigest !== existingStart.parentCurrentDigest) {
    throw new LabStoreError('CONFLICT', 'Parent continuity state changed during the trajectory experiment.', {
      field: 'parentCurrentDigest',
    });
  }
  const end = withSelfDigest({
    schemaVersion: SCHEMA_VERSION,
    type: TRAJECTORY_TYPE,
    version: 1,
    mode: TRAJECTORY_MODE,
    startDigest: existingStart.selfDigest,
    completedAt: new Date().toISOString(),
    verdict: 'PASS',
    comparison,
    replayVerdicts,
    parentCurrentDigest: existingStart.parentCurrentDigest,
    branches: {
      left: await collectBranchEvidence(branches.left, existingStart.runIds.left),
      right: await collectBranchEvidence(branches.right, existingStart.runIds.right),
    },
  });
  await writeExclusiveJson(pairEndPath, end);
  return end;
}

async function ensureTrajectoryBranch({ outputPath, side, parent, initialState, tokens, runIds, scenario, registry, failpoint }) {
  const branchPath = path.join(outputPath, side);
  if (!tokens.every((token) => tokenInManifest(parent, token))) {
    throw new LabStoreError('CORRUPT', `${side} trajectory contains a token outside the parent token map.`, {
      field: `${side}Tokens`,
    });
  }
  await initLab({ labPath: branchPath, labId: parent.labId, worldId: parent.worldId, seed: parent.seed, registry });
  const store = await LabStore.open({ labPath: branchPath });
  registry.assertManifest(store.manifest);
  if (store.manifest.tokenMap.digest !== parent.tokenMap.digest ||
      store.manifest.worldVersion !== parent.worldVersion ||
      store.manifest.worldImplementationDigest !== parent.worldImplementationDigest) {
    throw new LabStoreError('CONFLICT', 'Paired trajectory WorldPort identity differs from the parent.', { field: 'manifest' });
  }
  let inspection = await store.inspect();
  if (inspection.current.status === 'RUNNING') {
    await LabStore.recover({ labPath: branchPath });
    inspection = await store.inspect();
  }
  const fresh = inspection.current.lastRunId === null;
  let completed = fresh ? 0 : inspection.current.kernelStep - initialState.kernelStep;
  if (!Number.isSafeInteger(completed) || completed < 0 || completed > tokens.length ||
      (fresh && inspection.current.kernelStep !== 0) ||
      (!fresh && inspection.current.kernelStep < initialState.kernelStep)) {
    throw new LabStoreError('CORRUPT', `${side} trajectory progress is invalid.`, { field: `${side}.current.kernelStep` });
  }
  for (; completed < tokens.length; completed += 1) {
    const result = await runLab({
      labPath: branchPath,
      runId: runIds[completed],
      steps: 1,
      scenario,
      registry,
      ...(completed === 0 && fresh ? { initialState } : {}),
      advisor: fixedAdvisor(tokens[completed], `${side}-${completed + 1}`),
    });
    if (result.status !== 'COMPLETED') {
      throw new LabStoreError('CONFLICT', `${side} trajectory stopped before completion.`, {
        field: `${side}.run-${completed + 1}`,
        stopReason: result.stopReason,
      });
    }
    inspection = await store.inspect();
    if (inspection.current.kernelStep !== initialState.kernelStep + completed + 1) {
      throw new LabStoreError('CORRUPT', `${side} trajectory did not advance one kernel step.`, {
        field: `${side}.current.kernelStep`,
      });
    }
    if (failpoint?.(`paired-trajectory:${side}:after-${completed + 1}`) === true) {
      throw new LabStoreError('INJECTED_FAILURE', `Injected failure after the ${side} trajectory step.`, {
        point: `paired-trajectory:${side}:after-${completed + 1}`,
      });
    }
  }
  return { path: branchPath, store: await LabStore.open({ labPath: branchPath }) };
}

async function trajectoryComparison(start, branches) {
  const leftHistory = branches.left.history ?? await branches.left.store.readCandidateOutcomes();
  const rightHistory = branches.right.history ?? await branches.right.store.readCandidateOutcomes();
  const leftInspection = branches.left.inspection ?? await branches.left.store.inspect();
  const rightInspection = branches.right.inspection ?? await branches.right.store.inspect();
  const leftFinal = leftHistory.at(-1);
  const rightFinal = rightHistory.at(-1);
  const comparison = comparePairedTrajectories({
    worldVersion: start.worldVersion,
    tokenMapDigest: start.tokenMapDigest,
    scenario: start.scenario,
    initialStateDigest: start.initialStateDigest,
    left: {
      trajectoryDigest: canonicalDigest(start.trajectories.left),
      terminalDigest: leftInspection.current.selfDigest,
      quality: leftFinal?.quality,
    },
    right: {
      trajectoryDigest: canonicalDigest(start.trajectories.right),
      terminalDigest: rightInspection.current.selfDigest,
      quality: rightFinal?.quality,
    },
  });
  if (comparison === null) {
    throw new LabStoreError('CONFLICT', 'Paired trajectories did not produce comparable verified terminal outcomes.', {
      field: 'candidateHistory',
    });
  }
  return comparison;
}

async function validatePersistedBranches({ end, start, outputPath, manifest, registry }) {
  const branches = {};
  for (const side of ['left', 'right']) {
    const expectedPath = path.resolve(path.join(outputPath, side));
    const reference = end.branches?.[side];
    try {
      if (reference === null || typeof reference !== 'object' || Array.isArray(reference) ||
          reference.path !== expectedPath || !Array.isArray(reference.runIds) ||
          canonicalJson(reference.runIds) !== canonicalJson(start.runIds[side]) ||
          !DIGEST_PATTERN.test(reference.manifestDigest ?? '') || !DIGEST_PATTERN.test(reference.currentDigest ?? '')) {
        throw new LabStoreError('CORRUPT', 'Trajectory branch reference is invalid.', { field: `branches.${side}` });
      }
      const store = await LabStore.open({ labPath: expectedPath });
      registry.assertManifest(store.manifest);
      if (store.manifest.worldId !== manifest.worldId || store.manifest.worldVersion !== manifest.worldVersion ||
          store.manifest.tokenMap.digest !== manifest.tokenMap.digest || store.manifest.selfDigest !== reference.manifestDigest) {
        throw new LabStoreError('CORRUPT', 'Trajectory branch manifest drifted.', { field: `branches.${side}.manifestDigest` });
      }
      const inspection = await store.inspect();
      if (inspection.current.selfDigest !== reference.currentDigest ||
          inspection.current.kernelStep !== start.initialKernelStep + start.trajectories[side].length) {
        throw new LabStoreError('CORRUPT', 'Trajectory branch current state drifted.', { field: `branches.${side}.currentDigest` });
      }
      const replayVerdicts = await replayRuns(expectedPath, reference.runIds, registry);
      if (replayVerdicts.some((verdict) => verdict !== 'CONSISTENT')) {
        throw new LabStoreError('CORRUPT', 'Trajectory branch Replay is no longer consistent.', { field: `branches.${side}.replay` });
      }
      branches[side] = { path: expectedPath, store, inspection, history: await store.readCandidateOutcomes() };
    } catch (error) {
      throw new LabStoreError('CORRUPT', 'Trajectory branch evidence cannot be revalidated.', {
        field: `branches.${side}`,
        labPath: expectedPath,
      }, { cause: error });
    }
  }
  return branches;
}

async function replayRuns(labPath, runIds, registry) {
  const verdicts = [];
  for (const runId of runIds) {
    verdicts.push((await replayLab({ labPath, runId, registry })).verdict);
  }
  return verdicts;
}

async function collectBranchEvidence(branch, runIds) {
  const inspection = await branch.store.inspect();
  return {
    path: branch.path,
    runIds,
    manifestDigest: branch.store.manifest.selfDigest,
    currentDigest: inspection.current.selfDigest,
  };
}

function fixedAdvisor(token, side) {
  return async () => ({ model: `paired-trajectory-${side}`, token, responseDigest: canonicalDigest({ token, side }), reason: null });
}

function validateTrajectoryStart(start, parentLabPath, manifest, current) {
  if (start.type !== TRAJECTORY_TYPE || start.version !== 1 || start.mode !== TRAJECTORY_MODE ||
      start.parentLabPath !== parentLabPath || start.parentManifestDigest !== manifest.selfDigest ||
      start.parentCurrentDigest !== current.selfDigest || start.worldId !== manifest.worldId ||
      start.worldVersion !== manifest.worldVersion || start.tokenMapDigest !== manifest.tokenMap.digest ||
      !DIGEST_PATTERN.test(start.initialStateDigest ?? '') || !Number.isSafeInteger(start.initialKernelStep) ||
      start.initialKernelStep < 0 || !scenarioAllowed(manifest, start.scenario) ||
      !validTrajectoryPair(start.trajectories, manifest) || !validRunIds(start.runIds, start.trajectories) ||
      canonicalDigest(start.trajectories.left) === canonicalDigest(start.trajectories.right)) {
    throw new LabStoreError('CORRUPT', 'Trajectory start evidence does not match the current parent.', {
      field: 'trajectory.start.json',
    });
  }
}

function validateTrajectoryEnd(end, start, current) {
  if (end.type !== TRAJECTORY_TYPE || end.version !== 1 || end.mode !== TRAJECTORY_MODE ||
      end.startDigest !== start.selfDigest || end.parentCurrentDigest !== current.selfDigest || end.verdict !== 'PASS' ||
      !Array.isArray(end.replayVerdicts?.left) || !Array.isArray(end.replayVerdicts?.right) ||
      end.replayVerdicts.left.length !== start.trajectories.left.length ||
      end.replayVerdicts.right.length !== start.trajectories.right.length ||
      end.replayVerdicts.left.some((value) => value !== 'CONSISTENT') ||
      end.replayVerdicts.right.some((value) => value !== 'CONSISTENT') ||
      end.comparison?.pair !== 'same-initial-state-trajectory-v1') {
    throw new LabStoreError('CORRUPT', 'Trajectory end evidence does not match its start and parent.', {
      field: 'trajectory.end.json',
    });
  }
}

function validTrajectoryPair(trajectories, manifest) {
  return requireTrajectoryShape(trajectories?.left, manifest) && requireTrajectoryShape(trajectories?.right, manifest) &&
    trajectories.left.length === trajectories.right.length;
}

function validRunIds(runIds, trajectories) {
  return ['left', 'right'].every((side) => Array.isArray(runIds?.[side]) &&
    runIds[side].length === trajectories[side].length &&
    runIds[side].every((value, index) => value === `run-${index + 1}`));
}

function requireTrajectory(value, field, manifest) {
  if (!requireTrajectoryShape(value, manifest)) {
    throw new LabStoreError('INVALID_INPUT', `${field} must contain 1 to ${MAX_TRAJECTORY_STEPS} parent capabilities.`, { field });
  }
  return [...value];
}

function requireTrajectoryShape(value, manifest) {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_TRAJECTORY_STEPS &&
    value.every((token) => TOKEN_PATTERN.test(token) && tokenInManifest(manifest, token));
}

function tokenInManifest(manifest, token) {
  return Array.isArray(manifest.tokenMap?.entries) && manifest.tokenMap.entries.some((entry) => entry.token === token);
}

function scenarioAllowed(manifest, scenario) {
  return Array.isArray(manifest.scenarioIds) && manifest.scenarioIds.includes(scenario);
}

function requireTerminalParent(current) {
  if (current.lastRunId === null || current.status === 'RUNNING' || current.status === 'CORRUPT') {
    throw new LabStoreError('CONFLICT', 'A paired trajectory requires a terminal parent Run.', { field: 'labPath' });
  }
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

async function ensureNewExperimentDirectory(outputPath, startPath) {
  try {
    const stats = await lstat(outputPath);
    if (!stats.isDirectory()) throw new LabStoreError('CONFLICT', 'outputPath is not a directory.', { field: 'outputPath' });
    const entries = await readdir(outputPath);
    if (entries.length > 0 || await pathExists(startPath)) {
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

async function readOptionalEvidence(filePath, label) {
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

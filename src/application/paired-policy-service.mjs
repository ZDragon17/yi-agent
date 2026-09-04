import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { initLab, replayLab, runLab } from './agent-service.mjs';
import { builtInWorldRegistry } from './world-registry.mjs';
import { LabStore, LabStoreError } from '../runtime/lab-store.mjs';
import { normalizeCandidatePolicy, createCandidatePolicyAdvisor } from '../runtime/candidate-policy.mjs';
import { comparePairedPolicies } from '../runtime/policy-comparison.mjs';
import { canonicalDigest, canonicalJson, SCHEMA_VERSION, verifySelfDigest, withSelfDigest } from '../runtime/schema.mjs';

const POLICY_EXPERIMENT_TYPE = 'paired-policy-experiment';
const POLICY_EXPERIMENT_MODE = 'closed-loop-observable-policy-v1';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TOKEN_PATTERN = /^tok_[A-Z0-9]{8,128}$/u;

export async function runPairedPolicies(input) {
  const source = requireRecord(input, 'paired policy input');
  const parentLabPath = await existingPath(requireText(source.labPath, 'labPath'), 'labPath');
  const outputPath = path.resolve(requireAbsoluteText(source.outputPath, 'outputPath'));
  const resume = source.resume === true;
  const registry = source.registry ?? builtInWorldRegistry;
  const failpoint = typeof source.failpoint === 'function' ? source.failpoint : undefined;
  const parentStore = await LabStore.open({ labPath: parentLabPath });
  const parentInspection = await parentStore.inspect();
  if (parentStore.manifest.adapter !== undefined) {
    throw new LabStoreError('CONFLICT', 'Paired policies require an isolated built-in WorldPort.', { field: 'adapter' });
  }
  registry.assertManifest(parentStore.manifest);

  const startPath = path.join(outputPath, 'policy.start.json');
  const endPath = path.join(outputPath, 'policy.end.json');
  let start = await readOptionalEvidence(startPath, 'policy start');
  const end = await readOptionalEvidence(endPath, 'policy end');
  if (end !== null) {
    if (start === null) throw new LabStoreError('CORRUPT', 'Policy end evidence has no start evidence.', { field: 'policy.start.json' });
    validateStart(start, parentLabPath, parentStore.manifest, parentInspection.current);
    validateEnd(end, start, parentInspection.current);
    const branches = await validatePersistedBranches({ end, start, outputPath, manifest: parentStore.manifest, registry });
    const comparison = policyComparison(start, branches);
    if (canonicalJson(comparison) !== canonicalJson(end.comparison) ||
        canonicalJson(branches.left.trace) !== canonicalJson(end.traces.left) ||
        canonicalJson(branches.right.trace) !== canonicalJson(end.traces.right)) {
      throw new LabStoreError('CORRUPT', 'Policy end evidence no longer matches branch evidence.', { field: 'policy.end.json' });
    }
    return end;
  }
  if (start !== null) {
    if (!resume) throw new LabStoreError('CONFLICT', 'An incomplete policy experiment exists; use --resume.', { field: 'resume' });
    validateStart(start, parentLabPath, parentStore.manifest, parentInspection.current);
  } else {
    if (resume) throw new LabStoreError('NOT_FOUND', 'Policy experiment start evidence was not found.', { field: 'outputPath' });
    requireTerminalParent(parentInspection.current);
    const steps = requireSteps(source.steps);
    const allowedTokens = new Set(parentStore.manifest.tokenMap.entries.map((entry) => entry.token));
    const leftPolicy = normalizeCandidatePolicy(source.leftPolicy, allowedTokens);
    const rightPolicy = normalizeCandidatePolicy(source.rightPolicy, allowedTokens);
    if (canonicalDigest(leftPolicy) === canonicalDigest(rightPolicy)) {
      throw new LabStoreError('INVALID_INPUT', 'Paired policies must differ.', { fields: ['leftPolicy', 'rightPolicy'] });
    }
    const scenario = source.scenario ?? 'steady';
    if (!scenarioAllowed(parentStore.manifest, scenario)) {
      throw new LabStoreError('INVALID_INPUT', 'Paired policy scenario is unsupported.', { field: 'scenario' });
    }
    const parentState = continuityState(parentInspection.current);
    start = withSelfDigest({
      schemaVersion: SCHEMA_VERSION,
      type: POLICY_EXPERIMENT_TYPE,
      version: 1,
      mode: POLICY_EXPERIMENT_MODE,
      createdAt: new Date().toISOString(),
      parentLabPath,
      parentManifestDigest: parentStore.manifest.selfDigest,
      parentCurrentDigest: parentInspection.current.selfDigest,
      worldId: parentStore.manifest.worldId,
      worldVersion: parentStore.manifest.worldVersion,
      tokenMapDigest: parentStore.manifest.tokenMap.digest,
      scenario,
      steps,
      initialStateDigest: canonicalDigest(parentState),
      initialKernelStep: parentState.kernelStep,
      policies: { left: leftPolicy, right: rightPolicy },
      runIds: { left: runIds(steps), right: runIds(steps) },
    });
    await ensureNewExperimentDirectory(outputPath);
    await writeExclusiveJson(startPath, start);
  }

  const parentState = continuityState(parentInspection.current);
  if (canonicalDigest(parentState) !== start.initialStateDigest) {
    throw new LabStoreError('CONFLICT', 'Parent continuity state changed after the policy experiment was created.', { field: 'parentCurrentDigest' });
  }
  const branches = {};
  for (const side of ['left', 'right']) {
    branches[side] = await ensurePolicyBranch({
      outputPath,
      side,
      parent: parentStore.manifest,
      initialState: parentState,
      policy: start.policies[side],
      steps: start.steps,
      runIds: start.runIds[side],
      scenario: start.scenario,
      registry,
      failpoint,
    });
  }
  const comparison = policyComparison(start, branches);
  const replayVerdicts = {
    left: await replayRuns(branches.left.path, start.runIds.left, registry),
    right: await replayRuns(branches.right.path, start.runIds.right, registry),
  };
  if (replayVerdicts.left.some((value) => value !== 'CONSISTENT') || replayVerdicts.right.some((value) => value !== 'CONSISTENT')) {
    throw new LabStoreError('CONFLICT', 'A paired policy branch failed Replay consistency.', { field: 'replayVerdicts' });
  }
  const finalParent = await parentStore.inspect();
  if (finalParent.current.selfDigest !== start.parentCurrentDigest) {
    throw new LabStoreError('CONFLICT', 'Parent continuity state changed during the policy experiment.', { field: 'parentCurrentDigest' });
  }
  const endEvidence = withSelfDigest({
    schemaVersion: SCHEMA_VERSION,
    type: POLICY_EXPERIMENT_TYPE,
    version: 1,
    mode: POLICY_EXPERIMENT_MODE,
    startDigest: start.selfDigest,
    completedAt: new Date().toISOString(),
    verdict: 'PASS',
    comparison,
    traces: { left: branches.left.trace, right: branches.right.trace },
    replayVerdicts,
    parentCurrentDigest: start.parentCurrentDigest,
    branches: {
      left: await collectBranchEvidence(branches.left, start.runIds.left),
      right: await collectBranchEvidence(branches.right, start.runIds.right),
    },
  });
  await writeExclusiveJson(endPath, endEvidence);
  return endEvidence;
}

async function ensurePolicyBranch({ outputPath, side, parent, initialState, policy, steps, runIds: expectedRunIds, scenario, registry, failpoint }) {
  const branchPath = path.join(outputPath, side);
  await initLab({ labPath: branchPath, labId: parent.labId, worldId: parent.worldId, seed: parent.seed, registry });
  const store = await LabStore.open({ labPath: branchPath });
  registry.assertManifest(store.manifest);
  if (store.manifest.tokenMap.digest !== parent.tokenMap.digest ||
      store.manifest.worldVersion !== parent.worldVersion ||
      store.manifest.worldImplementationDigest !== parent.worldImplementationDigest) {
    throw new LabStoreError('CONFLICT', 'Paired policy WorldPort identity differs from the parent.', { field: 'manifest' });
  }
  let inspection = await store.inspect();
  if (inspection.current.status === 'RUNNING') {
    await LabStore.recover({ labPath: branchPath });
    inspection = await store.inspect();
  }
  const fresh = inspection.current.lastRunId === null;
  let completed = fresh ? 0 : inspection.current.kernelStep - initialState.kernelStep;
  if (!Number.isSafeInteger(completed) || completed < 0 || completed > steps ||
      (fresh && inspection.current.kernelStep !== 0) || (!fresh && inspection.current.kernelStep < initialState.kernelStep)) {
    throw new LabStoreError('CORRUPT', `${side} policy progress is invalid.`, { field: `${side}.current.kernelStep` });
  }
  if (canonicalJson(await listRunIds(store.root)) !== canonicalJson(expectedRunIds.slice(0, completed))) {
    throw new LabStoreError('CORRUPT', `${side} policy Run set does not match its durable progress.`, { field: `${side}.runs` });
  }
  const advisor = createCandidatePolicyAdvisor(policy);
  let needsInitialState = fresh;
  for (; completed < steps; completed += 1) {
    const result = await runLab({
      labPath: branchPath,
      runId: expectedRunIds[completed],
      steps: 1,
      scenario,
      registry,
      advisor,
      ...(needsInitialState ? { initialState } : {}),
    });
    if (result.status !== 'COMPLETED') {
      throw new LabStoreError('CONFLICT', `${side} policy stopped before completion.`, { field: `${side}.run-${completed + 1}`, stopReason: result.stopReason });
    }
    needsInitialState = false;
    inspection = await store.inspect();
    if (inspection.current.kernelStep !== initialState.kernelStep + completed + 1) {
      throw new LabStoreError('CORRUPT', `${side} policy did not advance one kernel step.`, { field: `${side}.current.kernelStep` });
    }
    if (failpoint?.(`paired-policy:${side}:after-${completed + 1}`) === true) {
      throw new LabStoreError('INJECTED_FAILURE', `Injected failure after the ${side} policy step.`, { point: `paired-policy:${side}:after-${completed + 1}` });
    }
  }
  const final = await LabStore.open({ labPath: branchPath });
  return hydrateBranch(final, branchPath);
}

async function hydrateBranch(store, branchPath) {
  const inspection = await store.inspect();
  return { path: branchPath, store, inspection, history: await store.readCandidateOutcomes(), trace: await readPolicyTrace(store) };
}

async function validatePersistedBranches({ end, start, outputPath, manifest, registry }) {
  const branches = {};
  for (const side of ['left', 'right']) {
    const expectedPath = path.resolve(path.join(outputPath, side));
    const reference = end.branches?.[side];
    try {
      if (!isRecord(reference) || reference.path !== expectedPath || !validRunIds(reference.runIds, start.steps) ||
          !isDigest(reference.manifestDigest) || !isDigest(reference.currentDigest) || !isDigest(reference.traceDigest)) {
        throw new LabStoreError('CORRUPT', 'Policy branch reference is invalid.', { field: `branches.${side}` });
      }
      const store = await LabStore.open({ labPath: expectedPath });
      registry.assertManifest(store.manifest);
      if (store.manifest.worldId !== manifest.worldId || store.manifest.worldVersion !== manifest.worldVersion ||
          store.manifest.tokenMap.digest !== manifest.tokenMap.digest || store.manifest.selfDigest !== reference.manifestDigest) {
        throw new LabStoreError('CORRUPT', 'Policy branch manifest drifted.', { field: `branches.${side}.manifestDigest` });
      }
      const inspection = await store.inspect();
      if (inspection.current.selfDigest !== reference.currentDigest || inspection.current.kernelStep !== start.initialKernelStep + start.steps) {
        throw new LabStoreError('CORRUPT', 'Policy branch current state drifted.', { field: `branches.${side}.currentDigest` });
      }
      if (canonicalJson(await listRunIds(store.root)) !== canonicalJson(reference.runIds)) {
        throw new LabStoreError('CORRUPT', 'Policy branch Run set drifted.', { field: `branches.${side}.runIds` });
      }
      const trace = await readPolicyTrace(store);
      if (canonicalDigest(trace) !== reference.traceDigest || canonicalJson(trace) !== canonicalJson(end.traces?.[side])) {
        throw new LabStoreError('CORRUPT', 'Policy branch trace drifted.', { field: `branches.${side}.traceDigest` });
      }
      const replayVerdicts = await replayRuns(expectedPath, reference.runIds, registry);
      if (replayVerdicts.some((value) => value !== 'CONSISTENT')) {
        throw new LabStoreError('CORRUPT', 'Policy branch Replay is no longer consistent.', { field: `branches.${side}.replay` });
      }
      branches[side] = { path: expectedPath, store, inspection, history: await store.readCandidateOutcomes(), trace };
    } catch (error) {
      throw new LabStoreError('CORRUPT', 'Policy branch evidence cannot be revalidated.', { field: `branches.${side}`, labPath: expectedPath }, { cause: error });
    }
  }
  return branches;
}

function policyComparison(start, branches) {
  const left = branches.left.history.at(-1);
  const right = branches.right.history.at(-1);
  const comparison = comparePairedPolicies({
    worldVersion: start.worldVersion,
    tokenMapDigest: start.tokenMapDigest,
    scenario: start.scenario,
    initialStateDigest: start.initialStateDigest,
    left: {
      policyDigest: canonicalDigest(start.policies.left),
      traceDigest: canonicalDigest(branches.left.trace),
      terminalDigest: branches.left.inspection.current.selfDigest,
      quality: left?.quality,
    },
    right: {
      policyDigest: canonicalDigest(start.policies.right),
      traceDigest: canonicalDigest(branches.right.trace),
      terminalDigest: branches.right.inspection.current.selfDigest,
      quality: right?.quality,
    },
  });
  if (comparison === null) throw new LabStoreError('CONFLICT', 'Paired policies did not produce comparable verified terminal outcomes.', { field: 'candidateHistory' });
  return comparison;
}

async function readPolicyTrace(store) {
  const runIds = await listRunIds(store.root);
  const trace = [];
  for (const runId of runIds) {
    const run = await store.readRun(runId);
    for (const event of run.events) {
      if (event.kind !== 'STEP') continue;
      const token = event.payload.policyEvidence?.token;
      if (!TOKEN_PATTERN.test(token ?? '')) throw new LabStoreError('CORRUPT', 'Policy trace contains no valid selected token.', { runId, sequence: event.sequence });
      trace.push(token);
    }
  }
  return trace;
}

async function replayRuns(labPath, runIds, registry) {
  const verdicts = [];
  for (const runId of runIds) verdicts.push((await replayLab({ labPath, runId, registry })).verdict);
  return verdicts;
}

async function collectBranchEvidence(branch, runIds) {
  const inspection = await branch.store.inspect();
  return { path: branch.path, runIds, traceDigest: canonicalDigest(branch.trace), manifestDigest: branch.store.manifest.selfDigest, currentDigest: inspection.current.selfDigest };
}

function validateStart(start, parentLabPath, manifest, current) {
  const allowedTokens = new Set(manifest.tokenMap.entries.map((entry) => entry.token));
  let policiesValid = false;
  try {
    policiesValid = ['left', 'right'].every((side) => canonicalJson(normalizeCandidatePolicy(start.policies?.[side], allowedTokens)) === canonicalJson(start.policies[side]));
  } catch {
    policiesValid = false;
  }
  if (start.type !== POLICY_EXPERIMENT_TYPE || start.version !== 1 || start.mode !== POLICY_EXPERIMENT_MODE ||
      start.parentLabPath !== parentLabPath || start.parentManifestDigest !== manifest.selfDigest || start.parentCurrentDigest !== current.selfDigest ||
      start.worldId !== manifest.worldId || start.worldVersion !== manifest.worldVersion || start.tokenMapDigest !== manifest.tokenMap.digest ||
      !DIGEST_PATTERN.test(start.initialStateDigest ?? '') || !Number.isSafeInteger(start.initialKernelStep) || start.initialKernelStep < 0 ||
      !Number.isSafeInteger(start.steps) || start.steps < 1 || start.steps > 8 || !scenarioAllowed(manifest, start.scenario) ||
      !policiesValid || canonicalDigest(start.policies.left) === canonicalDigest(start.policies.right) ||
      !validRunIds(start.runIds?.left, start.steps) || !validRunIds(start.runIds?.right, start.steps)) {
    throw new LabStoreError('CORRUPT', 'Policy start evidence does not match the current parent.', { field: 'policy.start.json' });
  }
}

function validateEnd(end, start, current) {
  if (end.type !== POLICY_EXPERIMENT_TYPE || end.version !== 1 || end.mode !== POLICY_EXPERIMENT_MODE || end.startDigest !== start.selfDigest ||
      end.parentCurrentDigest !== current.selfDigest || end.verdict !== 'PASS' || !isRecord(end.traces) ||
      !Array.isArray(end.traces.left) || !Array.isArray(end.traces.right) || end.traces.left.length !== start.steps || end.traces.right.length !== start.steps ||
      !Array.isArray(end.replayVerdicts?.left) || !Array.isArray(end.replayVerdicts?.right) ||
      end.replayVerdicts.left.length !== start.steps || end.replayVerdicts.right.length !== start.steps ||
      end.replayVerdicts.left.some((value) => value !== 'CONSISTENT') || end.replayVerdicts.right.some((value) => value !== 'CONSISTENT') ||
      end.comparison?.pair !== 'same-initial-state-policy-v1') {
    throw new LabStoreError('CORRUPT', 'Policy end evidence does not match its start and parent.', { field: 'policy.end.json' });
  }
}

function validRunIds(value, steps) {
  return Array.isArray(value) && value.length === steps && value.every((item, index) => item === `run-${index + 1}`);
}

function runIds(steps) { return Array.from({ length: steps }, (_, index) => `run-${index + 1}`); }

function requireSteps(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8) throw new LabStoreError('INVALID_INPUT', 'steps must be an integer from 1 to 8.', { field: 'steps' });
  return value;
}

function requireTerminalParent(current) {
  if (current.lastRunId === null || current.status === 'RUNNING' || current.status === 'CORRUPT') throw new LabStoreError('CONFLICT', 'A paired policy requires a terminal parent Run.', { field: 'labPath' });
}

function continuityState(current) {
  return { worldState: current.worldState, memory: current.memory, rngState: current.rngState, kernelStep: current.kernelStep, ...(current.changeSupervisor === undefined ? {} : { changeSupervisor: current.changeSupervisor }) };
}

function scenarioAllowed(manifest, scenario) { return Array.isArray(manifest.scenarioIds) && manifest.scenarioIds.includes(scenario); }

async function ensureNewExperimentDirectory(outputPath) {
  try {
    const stats = await lstat(outputPath);
    if (!stats.isDirectory()) throw new LabStoreError('CONFLICT', 'outputPath is not a directory.', { field: 'outputPath' });
    if ((await readdir(outputPath)).length > 0) throw new LabStoreError('CONFLICT', 'outputPath already contains an experiment.', { field: 'outputPath' });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(outputPath, { recursive: false });
  }
}

async function writeExclusiveJson(filePath, value) { await writeFile(filePath, `${canonicalJson(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }

async function readOptionalEvidence(filePath, label) {
  let raw;
  try { raw = await readFile(filePath, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  let value;
  try { value = JSON.parse(raw); } catch (error) { throw new LabStoreError('CORRUPT', `${label} is not valid JSON.`, { filePath }, { cause: error }); }
  if (!verifySelfDigest(value)) throw new LabStoreError('CORRUPT', `${label} digest is invalid.`, { filePath });
  return value;
}

async function existingPath(value, field) {
  try { return await realpath(path.resolve(value)); } catch (error) { throw new LabStoreError('NOT_FOUND', `${field} does not exist.`, { field }, { cause: error }); }
}

async function listRunIds(root) {
  try {
    return (await readdir(path.join(root, 'runs'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function isDigest(value) { return typeof value === 'string' && DIGEST_PATTERN.test(value); }
function requireAbsoluteText(value, field) { if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) throw new LabStoreError('INVALID_INPUT', `${field} must be an absolute path.`, { field }); return value; }
function requireText(value, field) { if (typeof value !== 'string' || value.length === 0) throw new LabStoreError('INVALID_INPUT', `${field} must be a non-empty string.`, { field }); return value; }
function requireRecord(value, field) { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new LabStoreError('INVALID_INPUT', `${field} must be an object.`, { field }); return value; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

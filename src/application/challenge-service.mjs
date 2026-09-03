import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LabStore, LabStoreError } from '../runtime/lab-store.mjs';
import { canonicalDigest, SCHEMA_VERSION } from '../runtime/schema.mjs';
import { annotateCandidateHistory } from '../runtime/candidate-history.mjs';
import { replayRun } from '../runtime/replay.mjs';
import { createWorld } from './world-registry.mjs';
import { initLab, inspectLab, replayLab, runLab } from './agent-service.mjs';

const CASES = [
  'unknown-action-exploration',
  'regime-shift',
  'execution-rejected',
  'external-during-step',
  'all-unsafe',
  'snapshot-write-failure',
  'replay-tamper',
  'inspect-readonly',
  'world-diversity',
  'paired-candidates',
];

export class ChallengeFalsifiedError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ChallengeFalsifiedError';
    this.code = code;
  }
}

export function classifyChallengeError(error) {
  if (error instanceof ChallengeFalsifiedError) {
    return {
      verdict: 'FALSIFIED',
      evidence: { code: error.code, message: error.message },
    };
  }
  return {
    verdict: 'INCONCLUSIVE',
    invalidator: { code: error?.code ?? 'INTERNAL', message: error?.message ?? 'Unknown challenge error.' },
  };
}

export async function challenge(input) {
  const source = requireRecord(input, 'challenge input');
  if (source.labPath !== undefined) await inspectLab({ labPath: requireText(source.labPath, 'labPath') });
  const selected = source.caseId === undefined ? CASES : [requireCase(source.caseId)];
  const cases = [];
  for (const id of selected) cases.push(await runCase(id));
  const hasFalsified = cases.some((item) => item.verdict === 'FALSIFIED');
  const hasInconclusive = cases.some((item) => item.verdict === 'INCONCLUSIVE');
  return {
    schemaVersion: SCHEMA_VERSION,
    campaignId: randomUUID(),
    verdict: hasFalsified ? 'FALSIFIED' : hasInconclusive ? 'INCONCLUSIVE' : 'PASS',
    cases,
  };
}

async function runCase(id) {
  const root = await mkdtemp(path.join(tmpdir(), `yi-challenge-${id}-`));
  try {
    const evidence = await CASE_RUNNERS[id](root);
    return { id, verdict: 'PASS', evidence };
  } catch (error) {
    return { id, ...classifyChallengeError(error) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const CASE_RUNNERS = {
  async 'unknown-action-exploration'(root) {
    const lab = await prepare(root, 'temperature', 'exploration');
    await runLab({ labPath: lab, runId: 'run-1', steps: 2 });
    const run = await (await LabStore.open({ labPath: lab })).readRun('run-1');
    const tokens = run.events.filter((event) => event.kind === 'STEP').map((event) => event.payload.choice.token);
    if (new Set(tokens).size < 2) throw challengeFailure('EXPLORATION_NOT_OBSERVED');
    return { runId: 'run-1', distinctActionTokens: [...new Set(tokens)] };
  },

  async 'regime-shift'(root) {
    const lab = await prepare(root, 'temperature', 'regime');
    await runLab({ labPath: lab, runId: 'run-1', steps: 1, scenario: 'regime-shift' });
    const run = await (await LabStore.open({ labPath: lab })).readRun('run-1');
    if (run.events.find((event) => event.kind === 'STEP')?.payload.afterState.worldState.regime !== 'shifted') {
      throw challengeFailure('REGIME_SHIFT_NOT_RECORDED');
    }
    return { runId: 'run-1', observedRegime: 'shifted' };
  },

  async 'execution-rejected'(root) {
    const lab = await prepare(root, 'temperature', 'rejected');
    const result = await runLab({ labPath: lab, runId: 'run-1', steps: 1, scenario: 'execution-rejected' });
    if (result.stopReason !== 'EXECUTION_REJECTED') throw challengeFailure('REJECTION_NOT_HALTED');
    return { runId: 'run-1', stopReason: result.stopReason };
  },

  async 'external-during-step'(root) {
    const lab = await prepare(root, 'temperature', 'external');
    await runLab({ labPath: lab, runId: 'run-1', steps: 1, scenario: 'external-during-step' });
    const run = await (await LabStore.open({ labPath: lab })).readRun('run-1');
    const verification = run.events.find((event) => event.kind === 'STEP').payload.verification;
    if (verification.attribution !== 'AMBIGUOUS' || verification.learnable !== false) {
      throw challengeFailure('EXTERNAL_EVENT_WAS_LEARNED');
    }
    return { runId: 'run-1', attribution: verification.attribution, learnable: verification.learnable };
  },

  async 'all-unsafe'(root) {
    const lab = await prepare(root, 'temperature', 'unsafe');
    const result = await runLab({ labPath: lab, runId: 'run-1', steps: 1, scenario: 'all-unsafe' });
    if (result.stopReason !== 'NO_SAFE_ACTION' || result.metrics.executed !== 0) {
      throw challengeFailure('UNSAFE_ACTION_EXECUTED');
    }
    return { runId: 'run-1', stopReason: result.stopReason, executed: result.metrics.executed };
  },

  async 'snapshot-write-failure'(root) {
    const lab = await prepare(root, 'temperature', 'snapshot');
    let failed = false;
    try {
      await runLab({
        labPath: lab,
        runId: 'run-1',
        steps: 1,
        failpoint: (point) => point === 'snapshot:before-publish',
      });
    } catch (error) {
      failed = error?.code === 'INJECTED_FAILURE';
    }
    if (!failed) throw challengeFailure('SNAPSHOT_FAILURE_NOT_INJECTED');
    const recovered = await LabStore.recover({ labPath: lab, livenessProbe: () => false });
    if (!['HALTED', 'READY'].includes(recovered.current.status)) throw challengeFailure('RECOVERY_DID_NOT_CONVERGE');
    return { recoveryReason: recovered.reason, status: recovered.current.status };
  },

  async 'replay-tamper'(root) {
    const lab = await prepare(root, 'temperature', 'tamper');
    await runLab({ labPath: lab, runId: 'run-1', steps: 1 });
    const stored = await (await LabStore.open({ labPath: lab })).readRun('run-1');
    const events = stored.events.map((event) => JSON.parse(JSON.stringify(event)));
    events[1].payload.choice.score += 0.25;
    events[1].digest = canonicalDigest(omit(events[1], 'digest'));
    events[2].prevDigest = events[1].digest;
    events[2].digest = canonicalDigest(omit(events[2], 'digest'));
    const end = { ...stored.end, finalEventDigest: events[2].digest };
    end.selfDigest = canonicalDigest(omit(end, 'selfDigest'));
    const result = replayRun({
      manifest: stored.manifest,
      start: stored.start,
      events,
      end,
      worldFactories: { temperature: (options) => createWorld(stored.manifest, options.scenario) },
    });
    if (result.verdict !== 'INCONSISTENT' || result.firstDifference.sequence !== 2) {
      throw challengeFailure('REPLAY_TAMPER_NOT_LOCATED');
    }
    return { runId: 'run-1', firstDifference: result.firstDifference };
  },

  async 'inspect-readonly'(root) {
    const lab = await prepare(root, 'temperature', 'inspect');
    await runLab({ labPath: lab, runId: 'run-1', steps: 1 });
    const before = await filesSnapshot(lab);
    await inspectLab({ labPath: lab });
    const after = await filesSnapshot(lab);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw challengeFailure('INSPECT_WROTE_STATE');
    return { runId: 'run-1', readonly: true };
  },

  async 'world-diversity'(root) {
    const cases = [
      { worldId: 'inventory', scenario: 'supply-shock', dimensions: 3 },
      { worldId: 'grid', scenario: 'blocked-route', dimensions: 4 },
      { worldId: 'queue', scenario: 'external-during-step', dimensions: 3 },
    ];
    const evidence = [];
    for (const [index, item] of cases.entries()) {
      const lab = await prepare(root, item.worldId, `diverse-${index}`);
      const result = await runLab({
        labPath: lab,
        runId: 'run-1',
        steps: 1,
        scenario: item.scenario,
      });
      const stored = await (await LabStore.open({ labPath: lab })).readRun('run-1');
      const step = stored.events.find((event) => event.kind === 'STEP');
      if (step === undefined || step.payload.beforeObservation.vector.length !== item.dimensions) {
        throw challengeFailure(`WORLD_DIVERSITY_${item.worldId.toUpperCase()}_OBSERVATION`);
      }
      const replay = await replayLab({ labPath: lab, runId: 'run-1' });
      if (replay.verdict !== 'CONSISTENT') {
        throw challengeFailure(`WORLD_DIVERSITY_${item.worldId.toUpperCase()}_REPLAY`);
      }
      evidence.push({
        worldId: item.worldId,
        scenario: item.scenario,
        status: result.status,
        observationDimensions: item.dimensions,
        attribution: step.payload.verification.attribution,
      });
    }
    return { worlds: evidence };
  },

  async 'paired-candidates'(root) {
    const identity = {
      worldId: 'temperature',
      labId: 'challenge-paired',
      seed: 'challenge-paired-seed',
    };
    const parent = await prepareWithIdentity(root, 'paired-parent', identity);
    const parentManifest = (await LabStore.open({ labPath: parent })).manifest;
    await runLab({
      labPath: parent,
      runId: 'run-1',
      steps: 1,
      scenario: 'steady',
      advisor: fixedAdvisor(parentManifest.tokenMap.entries[0].token, 'parent'),
    });
    const parentInspection = await inspectLab({ labPath: parent });
    const initialState = continuityState(parentInspection.current);
    const beforeStateDigest = canonicalDigest(initialState);
    const left = await prepareWithIdentity(root, 'paired-left', identity);
    const right = await prepareWithIdentity(root, 'paired-right', identity);
    const leftToken = (await LabStore.open({ labPath: left })).manifest.tokenMap.entries[0].token;
    const rightToken = (await LabStore.open({ labPath: right })).manifest.tokenMap.entries[1].token;
    await runLab({
      labPath: left,
      runId: 'run-1',
      steps: 1,
      scenario: 'regime-shift',
      initialState,
      advisor: fixedAdvisor(leftToken, 'left'),
    });
    await runLab({
      labPath: right,
      runId: 'run-1',
      steps: 1,
      scenario: 'regime-shift',
      initialState,
      advisor: fixedAdvisor(rightToken, 'right'),
    });
    const leftStore = await LabStore.open({ labPath: left });
    const rightStore = await LabStore.open({ labPath: right });
    const leftHistory = await leftStore.readCandidateOutcomes();
    const rightHistory = await rightStore.readCandidateOutcomes();
    const pairedHistory = annotateCandidateHistory([...leftHistory, ...rightHistory]);
    const comparison = pairedHistory.at(-1)?.pairedComparison;
    if (comparison === undefined || comparison.verdict !== 'RIGHT_BETTER') {
      throw challengeFailure('PAIRED_CANDIDATE_COMPARISON_NOT_OBSERVED');
    }
    if (comparison.beforeStateDigest !== beforeStateDigest ||
        leftHistory[0].beforeStateDigest !== rightHistory[0].beforeStateDigest ||
        leftHistory[0].tokenMapDigest !== rightHistory[0].tokenMapDigest) {
      throw challengeFailure('PAIRED_CANDIDATE_SCOPE_NOT_BOUND');
    }
    const replayVerdicts = {
      left: (await replayLab({ labPath: left, runId: 'run-1' })).verdict,
      right: (await replayLab({ labPath: right, runId: 'run-1' })).verdict,
    };
    if (replayVerdicts.left !== 'CONSISTENT' || replayVerdicts.right !== 'CONSISTENT') {
      throw challengeFailure('PAIRED_CANDIDATE_REPLAY_DIVERGED');
    }
    const afterParent = await inspectLab({ labPath: parent });
    if (afterParent.current.selfDigest !== parentInspection.current.selfDigest) {
      throw challengeFailure('PAIRED_CANDIDATE_MUTATED_PARENT');
    }
    return {
      beforeStateDigest,
      branchBeforeStateDigest: leftHistory[0].beforeStateDigest,
      comparison,
      replayVerdicts,
    };
  },
};

async function prepare(root, worldId, suffix) {
  const lab = path.join(root, suffix);
  await initLab({ labPath: lab, labId: `challenge-${suffix}`, worldId, seed: `challenge-${suffix}` });
  return lab;
}

async function prepareWithIdentity(root, suffix, identity) {
  const lab = path.join(root, suffix);
  await initLab({ labPath: lab, ...identity });
  return lab;
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

function fixedAdvisor(token, label) {
  return async () => ({
    model: `challenge-paired-${label}`,
    token,
    responseDigest: canonicalDigest({ token, label }),
    reason: null,
  });
}

function requireCase(value) {
  if (typeof value !== 'string' || !CASES.includes(value)) {
    throw new LabStoreError('INVALID_INPUT', 'Unknown challenge case.', { field: 'caseId' });
  }
  return value;
}

async function filesSnapshot(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else result.push([path.relative(root, target), await readFile(target, 'utf8')]);
    }
  }
  await visit(root);
  return result.sort((left, right) => left[0].localeCompare(right[0]));
}

function omit(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function challengeFailure(code) {
  return new ChallengeFalsifiedError(code);
}

function requireRecord(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LabStoreError('INVALID_INPUT', `${field} must be an object.`, { field });
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LabStoreError('INVALID_INPUT', `${field} must be a non-empty string.`, { field });
  }
  return value;
}

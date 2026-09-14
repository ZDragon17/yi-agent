#!/usr/bin/env node

// R16：用 CSPRNG seed 标签复测 signed-v1 下 creditChain 对 96 步电费的影响。

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKw, PRICE_LEVELS_BY_HOUR, TOU_TARIFF } from '../../examples/energy/shared/energy-sim.mjs';
import { LabStore } from '../../src/runtime/lab-store.mjs';
import { summarizeR16PairedRuns } from './r16-chain-effect-statistics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STEPS = 96;
const HORIZON = 8;
const SAMPLE_SIZE = 20;
const REPORT_PATH = path.join(ROOT, 'docs/figures/r16-chain-effect.json');
const STATE_SCHEMA_VERSION = 1;
const CONDITIONS = [
  { label: 'utility-base', chain: false },
  { label: 'utility-pair', chain: true },
];
const SOURCE_PATHS = [
  'scripts/curriculum/r16-chain-effect.mjs',
  'scripts/curriculum/r16-chain-effect-statistics.mjs',
];
const tariffPrice = (hour) => [TOU_TARIFF.valley, TOU_TARIFF.flat, TOU_TARIFF.peak][PRICE_LEVELS_BY_HOUR[hour % 24]];

function runCli(args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function firstJson(stdout) {
  const line = stdout.trim().split(/\r?\n/u).find((candidate) => candidate.trim().length > 0);
  return line === undefined ? null : JSON.parse(line);
}

function requireCliSuccess(result, label) {
  if (result.code !== 0) {
    throw new Error(`${label} failed (${result.code}): ${(result.stderr || result.stdout).slice(0, 500)}`);
  }
}

function measureRun({ events, tokenEntries, seed, condition }) {
  const steps = events.filter((event) => event.kind === 'STEP');
  if (steps.length !== STEPS) throw new Error(`wrong STEP count for ${seed.sequence}/${condition.label}`);
  const initialRngState = steps[0]?.payload.rngBefore?.state;
  if (!Number.isInteger(initialRngState) || initialRngState <= 0 || initialRngState > 0xffffffff) {
    throw new Error(`invalid initial RNG state for ${seed.sequence}/${condition.label}`);
  }

  const capabilityByToken = new Map(tokenEntries.map((entry) => [entry.token, entry.capabilityId]));
  const actionTrace = [];
  let cost = 0;
  let actionChains = 0;
  let unresolved = 0;
  for (const event of steps) {
    const hour = event.payload.afterState.worldState.hour - 1;
    const capabilityId = capabilityByToken.get(event.payload.choice.token);
    const essPower = capabilityId === 'ess.charge' ? 100 : capabilityId === 'ess.discharge' ? -100 : capabilityId === 'ess.idle' ? 0 : null;
    if (essPower === null) throw new Error(`unknown ESS action in ${seed.sequence}/${condition.label}`);
    actionTrace.push(capabilityId);
    // 用动作账本与公开电价重算成本，不采信 adapter 自报的 settlement 总额。
    cost += Math.max(0, loadKw(hour) + essPower) * tariffPrice(hour);
    for (const item of event.payload.update?.settled ?? []) {
      if (item.attribution === 'ACTION_CHAIN') actionChains += 1;
      if (item.attribution === 'UNRESOLVED') unresolved += 1;
    }
  }
  const valueMode = steps[0]?.payload.boundary.valueSpec.valueMode;
  if (valueMode !== 'signed-v1') throw new Error(`wrong value mode for ${seed.sequence}/${condition.label}`);

  return {
    seedLabel: seed.seedLabel,
    condition: condition.label,
    initialRngState,
    costYuan: Math.round(cost),
    actionChains,
    unresolved,
    valueMode,
    actionTraceDigest: createHash('sha256').update(JSON.stringify(actionTrace)).digest('hex'),
  };
}

async function runCondition({ seed, condition, state, attempt }) {
  const attemptDir = mkdtempSync(path.join(state.artifactRoot, `pair-${seed.sequence}-${condition.label}-`));
  const adapter = path.join(attemptDir, 'adapter.json');
  writeFileSync(adapter, JSON.stringify({
    executable: process.execPath,
    args: [
      path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs'),
      '--utility-mode',
      ...(condition.chain ? ['--chain-credit'] : []),
    ],
    adapterId: 'ess-arbitrage-adapter-v1',
    worldId: 'ess-arbitrage',
    timeoutMs: 30000,
    transport: 'persistent-jsonl',
  }));

  const lab = path.join(attemptDir, 'lab');
  const init = runCli([
    'init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', seed.seedLabel,
    '--adapter', adapter, '--json',
  ]);
  requireCliSuccess(init, `init ${seed.sequence}/${condition.label}`);
  const run = runCli([
    'agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', String(STEPS),
    '--kernel-only', '--planning-horizon', String(HORIZON), '--adapter', adapter, '--json',
  ]);
  requireCliSuccess(run, `run ${seed.sequence}/${condition.label}`);
  const runEnvelope = firstJson(run.stdout);
  if (runEnvelope?.data?.status !== 'COMPLETED') {
    throw new Error(`run ${seed.sequence}/${condition.label} did not complete: ${runEnvelope?.data?.status}`);
  }

  const store = await LabStore.open({ labPath: lab });
  const runRecord = await store.readRun('r');
  const measured = measureRun({
    events: runRecord.events,
    tokenEntries: store.manifest.tokenMap.entries,
    seed,
    condition,
  });
  const replay = runCli(['replay', '--lab', lab, '--run', 'r', '--adapter', adapter, '--json']);
  requireCliSuccess(replay, `replay ${seed.sequence}/${condition.label}`);
  const replayEnvelope = firstJson(replay.stdout);
  if (replayEnvelope?.data?.verdict !== 'CONSISTENT') {
    throw new Error(`Replay ${seed.sequence}/${condition.label}: ${replayEnvelope?.data?.verdict}`);
  }
  return {
    ...measured,
    replay: replayEnvelope.data.verdict,
    worldVersion: store.manifest.worldVersion,
    worldImplementationDigest: store.manifest.worldImplementationDigest,
    artifactPath: lab,
    attempt,
  };
}

function createCandidate(sequence, knownLabels = new Set()) {
  let seedLabel;
  do {
    seedLabel = `r16-${randomBytes(32).toString('hex')}`;
  } while (knownLabels.has(seedLabel));
  knownLabels.add(seedLabel);
  const treatmentOrder = randomInt(2) === 0
    ? ['utility-base', 'utility-pair']
    : ['utility-pair', 'utility-base'];
  return { sequence, seedLabel, treatmentOrder, status: 'PENDING', conditions: {} };
}

function sourceFingerprint() {
  const listed = spawnSync('git', [
    'ls-files', '-z', 'src', 'bin', 'examples/energy/shared',
    'examples/curriculum/ess-arbitrage', 'package.json', 'package-lock.json',
  ], { cwd: ROOT, encoding: null, windowsHide: true });
  if (listed.status !== 0) throw new Error(`cannot enumerate experiment source files: ${listed.stderr?.toString('utf8')}`);
  const files = [...new Set([
    ...listed.stdout.toString('utf8').split('\0').filter(Boolean),
    ...SOURCE_PATHS,
  ])].sort();
  const hash = createHash('sha256');
  for (const relativePath of files) {
    hash.update(relativePath).update('\0').update(readFileSync(path.join(ROOT, relativePath)));
  }
  return hash.digest('hex');
}

function createRunState() {
  const knownLabels = new Set();
  const candidates = Array.from({ length: SAMPLE_SIZE }, (_, index) => createCandidate(index + 1, knownLabels));
  const artifactRoot = mkdtempSync(path.join(tmpdir(), 'r16-chain-effect-artifacts-'));
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    experiment: 'R16-chain-effect',
    status: 'RUNNING',
    createdAt: new Date().toISOString(),
    nodeVersion: process.version,
    sourceFingerprint: sourceFingerprint(),
    artifactRoot,
    design: experimentDesign(),
    candidates,
  };
}

function experimentDesign() {
  return {
    pairedSeeds: SAMPLE_SIZE,
    stepsPerCondition: STEPS,
    planningHorizon: HORIZON,
    valueMode: 'signed-v1',
    primaryOutcome: 'utility-pair cost minus utility-base cost; negative favors chain credit',
    seedSelection: 'independent 256-bit labels from node:crypto.randomBytes; sample distribution is induced by the current seed initializer, not asserted uniform over uint32 states',
    stateSelection: 'record STEP.rngBefore.state and reject only repeated initial states; repeated action traces remain valid coverage observations',
    treatmentOrder: 'randomized independently within each pair using node:crypto.randomInt',
    inferenceUnit: 'one accepted paired outcome per distinct observed xorshift32 initial state',
    interval: 'approximate two-sided 95% paired Student-t interval, df=19; interpreted with raw paired outcomes because normality of deltas is not established',
    objectiveOracle: 'STEP action token + deterministic load + public TOU tariff; adapter settlement totals are not used',
    replayRequired: true,
  };
}

function validateRunState(state, expectedFingerprint) {
  const artifactRelativePath = typeof state?.artifactRoot === 'string'
    ? path.relative(path.resolve(tmpdir()), path.resolve(state.artifactRoot))
    : '';
  if (state?.schemaVersion !== STATE_SCHEMA_VERSION || state.experiment !== 'R16-chain-effect' ||
      state.status !== 'RUNNING' || state.nodeVersion !== process.version ||
      state.sourceFingerprint !== expectedFingerprint ||
      JSON.stringify(state.design) !== JSON.stringify(experimentDesign()) ||
      !Array.isArray(state.candidates) || state.candidates.length < SAMPLE_SIZE ||
      artifactRelativePath === '' || artifactRelativePath === '..' || artifactRelativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(artifactRelativePath)) {
    throw new Error('R16 run state does not match this source, Node runtime, design, or active experiment.');
  }
}

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value, null, 2));
  renameSync(temporaryPath, filePath);
}

function acceptedPairs(state) {
  return state.candidates.filter((candidate) => candidate.status === 'ACCEPTED').map((candidate) => candidate.pair);
}

function pairedResult(candidate) {
  const base = candidate.conditions['utility-base'];
  const chain = candidate.conditions['utility-pair'];
  if (base.initialRngState !== chain.initialRngState) {
    throw new Error(`paired conditions used different initial RNG states for candidate ${candidate.sequence}`);
  }
  return {
    sequence: candidate.sequence,
    seedLabel: candidate.seedLabel,
    treatmentOrder: candidate.treatmentOrder,
    base,
    chain,
    initialRngState: base.initialRngState,
    deltaYuan: chain.costYuan - base.costYuan,
  };
}

function addReplacementCandidate(state) {
  const knownLabels = new Set(state.candidates.map((candidate) => candidate.seedLabel));
  state.candidates.push(createCandidate(state.candidates.length + 1, knownLabels));
}

function writeState(statePath, state) {
  state.updatedAt = new Date().toISOString();
  writeJsonAtomically(statePath, state);
}

async function runExperiment(state, statePath) {
  mkdirSync(state.artifactRoot, { recursive: true });
  writeState(statePath, state);
  console.log(`R16 state ${statePath}`);
  console.log(`R16 source fingerprint ${state.sourceFingerprint}`);

  while (acceptedPairs(state).length < SAMPLE_SIZE) {
    let candidate = state.candidates.find((item) => item.status === 'PENDING' || item.status === 'RUNNING');
    if (candidate === undefined) {
      addReplacementCandidate(state);
      writeState(statePath, state);
      candidate = state.candidates.at(-1);
    }
    candidate.status = 'RUNNING';
    writeState(statePath, state);

    for (const conditionLabel of candidate.treatmentOrder) {
      if (candidate.conditions[conditionLabel] !== undefined) continue;
      const condition = CONDITIONS.find((item) => item.label === conditionLabel);
      const result = await runCondition({ seed: candidate, condition, state, attempt: randomUUID() });
      candidate.conditions[conditionLabel] = result;
      writeState(statePath, state);
      console.log(`candidate ${candidate.sequence} ${conditionLabel} ${result.costYuan} yuan; state ${result.initialRngState}; Replay ${result.replay}`);
    }

    candidate.pair = pairedResult(candidate);
    const usedStates = new Set(acceptedPairs(state).map((pair) => pair.initialRngState));
    if (usedStates.has(candidate.pair.initialRngState)) {
      candidate.status = 'REJECTED_DUPLICATE_INITIAL_RNG_STATE';
      candidate.rejection = 'initial RNG state already belongs to an accepted pair';
      writeState(statePath, state);
      console.log(`candidate ${candidate.sequence} rejected: repeated initial RNG state ${candidate.pair.initialRngState}`);
      continue;
    }
    candidate.status = 'ACCEPTED';
    writeState(statePath, state);
  }

  const pairs = acceptedPairs(state);
  const effect = summarizeR16PairedRuns(pairs);
  const idleBaseline = Array.from({ length: STEPS }, (_, hour) => loadKw(hour) * tariffPrice(hour))
    .reduce((sum, cost) => sum + cost, 0);
  const report = {
    experiment: state.experiment,
    analysisSource: state.resumed ? 'resumed-cli-runs' : 'fresh-cli-runs',
    sourceFingerprint: state.sourceFingerprint,
    nodeVersion: state.nodeVersion,
    design: state.design,
    idleBaselineYuan: Math.round(idleBaseline),
    effect,
    pairs: pairs.map((pair) => ({
      ...pair,
      base: publicRun(pair.base),
      chain: publicRun(pair.chain),
    })),
    rejectedCandidates: state.candidates
      .filter((candidate) => candidate.status === 'REJECTED_DUPLICATE_INITIAL_RNG_STATE')
      .map((candidate) => ({
        sequence: candidate.sequence,
        seedLabel: candidate.seedLabel,
        initialRngState: candidate.pair.initialRngState,
        rejection: candidate.rejection,
        treatmentOrder: candidate.treatmentOrder,
        base: publicRun(candidate.pair.base),
        chain: publicRun(candidate.pair.chain),
        deltaYuan: candidate.pair.deltaYuan,
      })),
  };
  if (existsSync(REPORT_PATH)) throw new Error(`report already exists; refusing to overwrite ${REPORT_PATH}`);
  writeJsonAtomically(REPORT_PATH, report);
  state.status = 'COMPLETED';
  state.completedAt = new Date().toISOString();
  writeState(statePath, state);
  console.log(`mean chain-base delta ${effect.meanDeltaYuan} yuan; decision ${effect.decision}`);
  console.log(`approximate 95% paired t interval [${effect.nominalCi95Yuan.low}, ${effect.nominalCi95Yuan.high}] yuan`);
  console.log(`written docs/figures/r16-chain-effect.json; ${effect.nSeedPairs} accepted pairs, ${report.rejectedCandidates.length} repeated states rejected`);
}

function publicRun(run) {
  const { artifactPath, attempt, ...measured } = run;
  return measured;
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a path`);
  return path.resolve(value);
}

async function main() {
  const resumePath = argumentValue('--resume');
  const requestedStatePath = argumentValue('--state-file');
  if (resumePath !== undefined && requestedStatePath !== undefined) {
    throw new Error('use either --resume or --state-file, not both');
  }
  const fingerprint = sourceFingerprint();
  if (resumePath === undefined && existsSync(REPORT_PATH)) {
    throw new Error(`report already exists; refusing to overwrite ${REPORT_PATH}`);
  }

  let state;
  let statePath;
  if (resumePath !== undefined) {
    statePath = resumePath;
    state = JSON.parse(readFileSync(statePath, 'utf8'));
    validateRunState(state, fingerprint);
    state.resumed = true;
  } else {
    statePath = requestedStatePath ?? path.join(tmpdir(), `yi-agent-r16-${randomUUID()}.json`);
    if (existsSync(statePath)) throw new Error(`state file already exists: ${statePath}`);
    state = createRunState();
    writeState(statePath, state);
  }
  await runExperiment(state, statePath);
}

await main();

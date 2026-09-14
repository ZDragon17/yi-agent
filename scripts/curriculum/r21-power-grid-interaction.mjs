#!/usr/bin/env node

// R21：同一 seed 的四格实验，只扩展 ESS 的动作集合：3 档（±100、0）对比
// 5 档（±100、±50、0），同时测量动作集合与动作链信用的差中差交互。

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKw, PRICE_LEVELS_BY_HOUR, TOU_TARIFF } from '../../examples/energy/shared/energy-sim.mjs';
import { LabStore } from '../../src/runtime/lab-store.mjs';
import { batteryStepAtPower, essPowerForCapability } from './r21-power-grid-model.mjs';
import { summarizeR21FactorialRuns } from './r21-power-grid-statistics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STEPS = 96;
const HORIZON = 8;
const SAMPLE_SIZE = 20;
const REPORT_PATH = path.join(ROOT, 'docs/figures/r21-power-grid-interaction.json');
const STATE_SCHEMA_VERSION = 1;
const CONDITIONS = [
  { label: 'base-3', fine: false, chain: false },
  { label: 'chain-3', fine: false, chain: true },
  { label: 'base-5', fine: true, chain: false },
  { label: 'chain-5', fine: true, chain: true },
];
const SOURCE_PATHS = [
  'scripts/curriculum/r21-power-grid-model.mjs',
  'scripts/curriculum/r21-power-grid-statistics.mjs',
  'scripts/curriculum/r21-power-grid-interaction.mjs',
];

function staticTariffPriceAt(hour) {
  return [TOU_TARIFF.valley, TOU_TARIFF.flat, TOU_TARIFF.peak][PRICE_LEVELS_BY_HOUR[hour % 24]];
}

function runCli(args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, env: process.env,
    maxBuffer: 64 * 1024 * 1024, timeout: 300000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function firstJson(stdout) {
  const line = stdout.trim().split(/\r?\n/u).find((candidate) => candidate.trim().length > 0);
  return line === undefined ? null : JSON.parse(line);
}

function requireCliSuccess(result, label) {
  if (result.code !== 0) throw new Error(`${label} failed (${result.code}): ${(result.stderr || result.stdout).slice(0, 500)}`);
}

function measureRun({ events, tokenEntries, seed, condition }) {
  const steps = events.filter((event) => event.kind === 'STEP');
  if (steps.length !== STEPS) throw new Error(`wrong STEP count for ${seed.sequence}/${condition.label}`);
  const initialRngState = steps[0]?.payload.rngBefore?.state;
  if (!Number.isInteger(initialRngState) || initialRngState <= 0 || initialRngState > 0xffffffff) {
    throw new Error(`invalid initial RNG state for ${seed.sequence}/${condition.label}`);
  }
  const capabilityByToken = new Map(tokenEntries.map((entry) => [entry.token, entry.capabilityId]));
  let soc = 50;
  let costYuan = 0;
  let actionChains = 0;
  let unresolved = 0;
  const actionTrace = [];
  for (const event of steps) {
    const hour = event.payload.afterState.worldState.hour - 1;
    const capabilityId = capabilityByToken.get(event.payload.choice.token);
    if (capabilityId === undefined) throw new Error(`unknown token in ${seed.sequence}/${condition.label}`);
    const powerKw = essPowerForCapability(capabilityId);
    actionTrace.push(capabilityId);
    const accepted = event.payload.receipt.status === 'ACCEPTED';
    const expectedSoc = accepted ? batteryStepAtPower(soc, powerKw) : soc;
    const observedSoc = event.payload.afterState.worldState.soc;
    if (observedSoc !== expectedSoc) throw new Error(`SOC oracle mismatch for ${seed.sequence}/${condition.label}: expected ${expectedSoc}, got ${observedSoc}`);
    soc = observedSoc;
    costYuan += Math.max(0, loadKw(hour) + powerKw) * staticTariffPriceAt(hour);
    for (const item of event.payload.update?.settled ?? []) {
      if (item.attribution === 'ACTION_CHAIN') actionChains += 1;
      if (item.attribution === 'UNRESOLVED') unresolved += 1;
    }
  }
  if (steps[0]?.payload.boundary.valueSpec.valueMode !== 'signed-v1') throw new Error(`wrong value mode for ${seed.sequence}/${condition.label}`);
  return {
    seedLabel: seed.seedLabel,
    condition: condition.label,
    initialRngState,
    costYuan: Math.round(costYuan),
    actionChains,
    unresolved,
    valueMode: 'signed-v1',
    actionTraceDigest: createHash('sha256').update(JSON.stringify(actionTrace)).digest('hex'),
  };
}

async function runCondition({ seed, condition, state, attempt }) {
  const attemptDir = mkdtempSync(path.join(state.artifactRoot, `factorial-${seed.sequence}-${condition.label}-`));
  const adapter = path.join(attemptDir, 'adapter.json');
  writeFileSync(adapter, JSON.stringify({
    executable: process.execPath,
    args: [
      path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs'),
      '--utility-mode',
      ...(condition.fine ? ['--fine-grained-actions'] : []),
      ...(condition.chain ? ['--chain-credit'] : []),
    ],
    adapterId: 'ess-arbitrage-adapter-v1', worldId: 'ess-arbitrage', timeoutMs: 30000, transport: 'persistent-jsonl',
  }));
  const lab = path.join(attemptDir, 'lab');
  const init = runCli(['init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', seed.seedLabel, '--adapter', adapter, '--json']);
  requireCliSuccess(init, `init ${seed.sequence}/${condition.label}`);
  const run = runCli(['agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', String(STEPS), '--kernel-only', '--planning-horizon', String(HORIZON), '--adapter', adapter, '--json']);
  requireCliSuccess(run, `run ${seed.sequence}/${condition.label}`);
  const runEnvelope = firstJson(run.stdout);
  if (runEnvelope?.data?.status !== 'COMPLETED') throw new Error(`run ${seed.sequence}/${condition.label} did not complete: ${runEnvelope?.data?.status}`);
  const store = await LabStore.open({ labPath: lab });
  const measured = measureRun({ events: (await store.readRun('r')).events, tokenEntries: store.manifest.tokenMap.entries, seed, condition });
  const expectedIdentity = condition.fine ? 'power-grid-v1' : 'utility-v1';
  if (!store.manifest.worldVersion.includes(expectedIdentity)) throw new Error(`world identity does not encode ${expectedIdentity} for ${seed.sequence}/${condition.label}`);
  if (condition.chain && !store.manifest.worldVersion.includes('chain-v2')) throw new Error(`world identity does not encode chain-v2 for ${seed.sequence}/${condition.label}`);
  const replay = runCli(['replay', '--lab', lab, '--run', 'r', '--adapter', adapter, '--json']);
  requireCliSuccess(replay, `replay ${seed.sequence}/${condition.label}`);
  const replayEnvelope = firstJson(replay.stdout);
  if (replayEnvelope?.data?.verdict !== 'CONSISTENT') throw new Error(`Replay ${seed.sequence}/${condition.label}: ${replayEnvelope?.data?.verdict}`);
  return { ...measured, replay: replayEnvelope.data.verdict, worldVersion: store.manifest.worldVersion, artifactPath: lab, attempt };
}

function shuffledConditions() {
  const order = [...CONDITIONS];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order.map((condition) => condition.label);
}

function createCandidate(sequence, knownLabels = new Set()) {
  let seedLabel;
  do seedLabel = `r21-${randomBytes(32).toString('hex')}`; while (knownLabels.has(seedLabel));
  knownLabels.add(seedLabel);
  return { sequence, seedLabel, treatmentOrder: shuffledConditions(), status: 'PENDING', conditions: {} };
}

function sourceFingerprint() {
  const listed = spawnSync('git', ['ls-files', '-z', 'src', 'bin', 'examples/energy/shared', 'examples/curriculum/ess-arbitrage', 'package.json', 'package-lock.json'], { cwd: ROOT, encoding: null, windowsHide: true });
  if (listed.status !== 0) throw new Error(`cannot enumerate experiment source files: ${listed.stderr?.toString('utf8')}`);
  const files = [...new Set([...listed.stdout.toString('utf8').split('\0').filter(Boolean), ...SOURCE_PATHS])].sort();
  const hash = createHash('sha256');
  for (const relativePath of files) hash.update(relativePath).update('\0').update(readFileSync(path.join(ROOT, relativePath)));
  return hash.digest('hex');
}

function experimentDesign() {
  return {
    sameSeedRuns: SAMPLE_SIZE,
    cellsPerSeed: 4,
    stepsPerCell: STEPS,
    planningHorizon: HORIZON,
    valueMode: 'signed-v1',
    cells: CONDITIONS.map(({ label, fine, chain }) => ({ label, fineGrainedActions: fine, chain })),
    changedWorldCondition: 'ESS action set changes from 3 actions (±100, 0 kW) to 5 actions (±100, ±50, 0 kW); load, tariff, battery dynamics, planning horizon, and all other settings remain fixed',
    primaryOutcome: '(chain-5 - base-5) - (chain-3 - base-3); positive means the expanded power grid changes the chain cost upward',
    seedSelection: 'independent 256-bit labels from node:crypto.randomBytes; sample distribution is induced by the current seed initializer, not asserted uniform over uint32 states',
    treatmentOrder: 'randomized independently within each seed using node:crypto.randomInt; every cell starts from a fresh Lab with the same seed label',
    stateSelection: 'record STEP.rngBefore.state and reject only repeated initial states across seeds; repeated action traces remain valid coverage observations',
    interval: 'approximate two-sided 95% paired Student-t interval for same-seed interaction, df=19; difference normality is not established',
    objectiveOracle: 'STEP action token + independently encoded ESS power map, SOC dynamics, fixed public load, and TOU tariff; adapter settlement totals are not used',
    replayRequired: true,
  };
}

function createRunState() {
  const knownLabels = new Set();
  const candidates = Array.from({ length: SAMPLE_SIZE }, (_, index) => createCandidate(index + 1, knownLabels));
  return { schemaVersion: STATE_SCHEMA_VERSION, experiment: 'R21-power-grid-interaction', status: 'RUNNING', createdAt: new Date().toISOString(), nodeVersion: process.version, sourceFingerprint: sourceFingerprint(), artifactRoot: mkdtempSync(path.join(tmpdir(), 'r21-power-grid-artifacts-')), design: experimentDesign(), candidates };
}

function validateRunState(state, expectedFingerprint) {
  const artifactRelativePath = typeof state?.artifactRoot === 'string' ? path.relative(path.resolve(tmpdir()), path.resolve(state.artifactRoot)) : '';
  if (state?.schemaVersion !== STATE_SCHEMA_VERSION || state.experiment !== 'R21-power-grid-interaction' || state.status !== 'RUNNING' || state.nodeVersion !== process.version || state.sourceFingerprint !== expectedFingerprint || JSON.stringify(state.design) !== JSON.stringify(experimentDesign()) || !Array.isArray(state.candidates) || state.candidates.length < SAMPLE_SIZE || artifactRelativePath === '' || artifactRelativePath === '..' || artifactRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(artifactRelativePath)) throw new Error('R21 run state does not match this source, Node runtime, design, or active experiment.');
}

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value, null, 2));
  renameSync(temporaryPath, filePath);
}
function acceptedRuns(state) { return state.candidates.filter((candidate) => candidate.status === 'ACCEPTED').map((candidate) => candidate.factorial); }
function conditionResultKey(label) { return label.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase()); }
function factorialResult(candidate) {
  const byLabel = new Map(Object.entries(candidate.conditions));
  const result = { sequence: candidate.sequence, seedLabel: candidate.seedLabel, treatmentOrder: candidate.treatmentOrder };
  for (const condition of CONDITIONS) result[conditionResultKey(condition.label)] = byLabel.get(condition.label);
  return result;
}
function addReplacementCandidate(state) { const knownLabels = new Set(state.candidates.map((candidate) => candidate.seedLabel)); state.candidates.push(createCandidate(state.candidates.length + 1, knownLabels)); }
function writeState(statePath, state) { state.updatedAt = new Date().toISOString(); writeJsonAtomically(statePath, state); }

async function runExperiment(state, statePath) {
  mkdirSync(state.artifactRoot, { recursive: true });
  writeState(statePath, state);
  console.log(`R21 state ${statePath}`);
  console.log(`R21 source fingerprint ${state.sourceFingerprint}`);
  while (acceptedRuns(state).length < SAMPLE_SIZE) {
    let candidate = state.candidates.find((item) => item.status === 'PENDING' || item.status === 'RUNNING');
    if (candidate === undefined) { addReplacementCandidate(state); writeState(statePath, state); candidate = state.candidates.at(-1); }
    candidate.status = 'RUNNING';
    writeState(statePath, state);
    for (const conditionLabel of candidate.treatmentOrder) {
      if (candidate.conditions[conditionLabel] !== undefined) continue;
      const condition = CONDITIONS.find((item) => item.label === conditionLabel);
      const result = await runCondition({ seed: candidate, condition, state, attempt: randomUUID() });
      candidate.conditions[conditionLabel] = result;
      writeState(statePath, state);
      console.log(`seed ${candidate.sequence} ${conditionLabel} ${result.costYuan} yuan; state ${result.initialRngState}; Replay ${result.replay}`);
    }
    candidate.factorial = factorialResult(candidate);
    const usedStates = new Set(acceptedRuns(state).map((item) => item.base3.initialRngState));
    const initialStates = new Set(Object.values(candidate.factorial).filter((value) => value?.initialRngState).map((value) => value.initialRngState));
    if (initialStates.size !== 1) throw new Error(`same seed conditions produced mismatched initial RNG states for ${candidate.sequence}`);
    if (usedStates.has(candidate.factorial.base3.initialRngState)) {
      candidate.status = 'REJECTED_DUPLICATE_INITIAL_RNG_STATE';
      candidate.rejection = 'initial RNG state already belongs to an accepted seed';
      writeState(statePath, state);
      console.log(`seed ${candidate.sequence} rejected: repeated initial RNG state ${candidate.factorial.base3.initialRngState}`);
      continue;
    }
    candidate.status = 'ACCEPTED';
    writeState(statePath, state);
  }
  const factorialRuns = acceptedRuns(state);
  const effect = summarizeR21FactorialRuns(factorialRuns);
  const report = {
    experiment: state.experiment,
    analysisSource: state.resumed ? 'resumed-cli-runs' : 'fresh-cli-runs',
    sourceFingerprint: state.sourceFingerprint,
    nodeVersion: state.nodeVersion,
    design: state.design,
    effect,
    worldCondition: { baseActions: ['ess.charge', 'ess.discharge', 'ess.idle'], fineActions: ['ess.charge', 'ess.charge-half', 'ess.discharge-half', 'ess.discharge', 'ess.idle'] },
    runs: factorialRuns.map((run) => Object.fromEntries(Object.entries(run).map(([key, value]) => [key, ['base3', 'chain3', 'base5', 'chain5'].includes(key) ? publicRun(value) : value]))),
    rejectedCandidates: state.candidates.filter((candidate) => candidate.status === 'REJECTED_DUPLICATE_INITIAL_RNG_STATE').map((candidate) => ({ sequence: candidate.sequence, seedLabel: candidate.seedLabel, initialRngState: candidate.factorial.base3.initialRngState, rejection: candidate.rejection, treatmentOrder: candidate.treatmentOrder })),
  };
  if (existsSync(REPORT_PATH)) throw new Error(`report already exists; refusing to overwrite ${REPORT_PATH}`);
  writeJsonAtomically(REPORT_PATH, report);
  state.status = 'COMPLETED';
  state.completedAt = new Date().toISOString();
  writeState(statePath, state);
  console.log(`mean same-seed power-grid interaction ${effect.meanInteractionDeltaYuan} yuan; decision ${effect.decision}`);
  console.log(`approximate 95% interaction interval [${effect.nominalCi95InteractionYuan.low}, ${effect.nominalCi95InteractionYuan.high}] yuan`);
  console.log(`written docs/figures/r21-power-grid-interaction.json; ${effect.nSeedRuns} accepted seeds, ${report.rejectedCandidates.length} repeated states rejected`);
}

function publicRun(run) { const { artifactPath, attempt, ...measured } = run; return measured; }
function argumentValue(flag) { const index = process.argv.indexOf(flag); if (index < 0) return undefined; const value = process.argv[index + 1]; if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a path`); return path.resolve(value); }

async function main() {
  const resumePath = argumentValue('--resume');
  const requestedStatePath = argumentValue('--state-file');
  if (resumePath !== undefined && requestedStatePath !== undefined) throw new Error('use either --resume or --state-file, not both');
  const fingerprint = sourceFingerprint();
  if (resumePath === undefined && existsSync(REPORT_PATH)) throw new Error(`report already exists; refusing to overwrite ${REPORT_PATH}`);
  let state;
  let statePath;
  if (resumePath !== undefined) { statePath = resumePath; state = JSON.parse(readFileSync(statePath, 'utf8')); validateRunState(state, fingerprint); state.resumed = true; }
  else { statePath = requestedStatePath ?? path.join(tmpdir(), `yi-agent-r21-${randomUUID()}.json`); if (existsSync(statePath)) throw new Error(`state file already exists: ${statePath}`); state = createRunState(); writeState(statePath, state); }
  await runExperiment(state, statePath);
}

await main();

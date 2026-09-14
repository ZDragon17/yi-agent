#!/usr/bin/env node

// R22：在真实模型适配器边界上执行连续功率 proposal。WorldPort 只公开
// ess.set-power 一个不透明 token，功率值由模型 proposal 提供，再由 adapter
// 独立校验并进入可 Replay 的 transition 请求。

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKw, PRICE_LEVELS_BY_HOUR, TOU_TARIFF } from '../../examples/energy/shared/energy-sim.mjs';
import { LabStore } from '../../src/runtime/lab-store.mjs';
import { summarizeR22PairedRuns } from './r22-continuous-power-statistics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STEPS = 96;
const SAMPLE_SIZE = 20;
const REPORT_PATH = path.join(ROOT, 'docs/figures/r22-continuous-power-interaction.json');
const MODEL_ADAPTER = path.join(ROOT, 'test/fixtures/continuous-power-model-adapter.mjs');
const STATE_SCHEMA_VERSION = 1;
const CONDITIONS = [
  { label: 'continuous-base', chain: false },
  { label: 'continuous-chain', chain: true },
];
const SOURCE_PATHS = [
  'scripts/curriculum/r22-continuous-power-statistics.mjs',
  'scripts/curriculum/r22-continuous-power-interaction.mjs',
  'test/fixtures/continuous-power-model-adapter.mjs',
];

function staticTariffPriceAt(hour) { return [TOU_TARIFF.valley, TOU_TARIFF.flat, TOU_TARIFF.peak][PRICE_LEVELS_BY_HOUR[hour % 24]]; }
function runCli(args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: process.env, maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
function firstJson(stdout) { const line = stdout.trim().split(/\r?\n/u).find((candidate) => candidate.trim().length > 0); return line === undefined ? null : JSON.parse(line); }
function requireCliSuccess(result, label) { if (result.code !== 0) throw new Error(`${label} failed (${result.code}): ${(result.stderr || result.stdout).slice(0, 500)}`); }

function measureRun({ events, tokenEntries, seed, condition }) {
  const steps = events.filter((event) => event.kind === 'STEP');
  if (steps.length !== STEPS) throw new Error(`wrong STEP count for ${seed.sequence}/${condition.label}`);
  const initialRngState = steps[0]?.payload.rngBefore?.state;
  if (!Number.isInteger(initialRngState) || initialRngState <= 0 || initialRngState > 0xffffffff) throw new Error(`invalid initial RNG state for ${seed.sequence}/${condition.label}`);
  const tokenSet = new Set(tokenEntries.map((entry) => entry.token));
  let soc = 50;
  let costYuan = 0;
  let actionChains = 0;
  let unresolved = 0;
  const powerTrace = [];
  for (const event of steps) {
    if (!tokenSet.has(event.payload.choice.token)) throw new Error(`unknown token for ${seed.sequence}/${condition.label}`);
    const proposal = event.payload.policyEvidence?.proposal;
    const powerKw = proposal?.powerKw;
    if (!Number.isFinite(powerKw) || powerKw < -100 || powerKw > 100 || Math.round(powerKw * 1000) / 1000 !== powerKw) throw new Error(`missing or invalid persisted power proposal for ${seed.sequence}/${condition.label}`);
    powerTrace.push(powerKw);
    const accepted = event.payload.receipt.status === 'ACCEPTED';
    const expectedSoc = accepted
      ? Math.round(Math.min(100, Math.max(0, soc + (powerKw * (powerKw > 0 ? 0.95 : 1 / 0.95) * 100) / 800)) * 1000) / 1000
      : soc;
    const observedSoc = event.payload.afterState.worldState.soc;
    if (observedSoc !== expectedSoc) throw new Error(`SOC oracle mismatch for ${seed.sequence}/${condition.label}: expected ${expectedSoc}, got ${observedSoc}`);
    soc = observedSoc;
    if (accepted) costYuan += Math.max(0, loadKw(event.payload.afterState.worldState.hour - 1) + powerKw) * staticTariffPriceAt(event.payload.afterState.worldState.hour - 1);
    for (const item of event.payload.update?.settled ?? []) {
      if (item.attribution === 'ACTION_CHAIN') actionChains += 1;
      if (item.attribution === 'UNRESOLVED') unresolved += 1;
    }
  }
  if (steps.some((event) => event.payload.policyEvidence?.applied !== true)) throw new Error(`continuous proposal was not applied for ${seed.sequence}/${condition.label}`);
  return {
    seedLabel: seed.seedLabel,
    condition: condition.label,
    initialRngState,
    costYuan: Math.round(costYuan),
    actionChains,
    unresolved,
    proposalCount: powerTrace.length,
    proposalMinKw: Math.min(...powerTrace),
    proposalMaxKw: Math.max(...powerTrace),
    proposalTraceDigest: createHash('sha256').update(JSON.stringify(powerTrace)).digest('hex'),
    replay: 'CONSISTENT',
  };
}

async function runCondition({ seed, condition, state, attempt }) {
  const attemptDir = mkdtempSync(path.join(state.artifactRoot, `paired-${seed.sequence}-${condition.label}-`));
  const adapter = path.join(attemptDir, 'adapter.json');
  const model = path.join(attemptDir, 'model.json');
  writeFileSync(adapter, JSON.stringify({ executable: process.execPath, args: [path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs'), '--utility-mode', '--continuous-power', ...(condition.chain ? ['--chain-credit'] : [])], adapterId: 'ess-arbitrage-adapter-v1', worldId: 'ess-arbitrage', timeoutMs: 30000, transport: 'persistent-jsonl' }));
  writeFileSync(model, JSON.stringify({ executable: process.execPath, args: [MODEL_ADAPTER], model: 'continuous-power-fixture', timeoutMs: 5000 }));
  const lab = path.join(attemptDir, 'lab');
  requireCliSuccess(runCli(['init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', seed.seedLabel, '--adapter', adapter, '--json']), `init ${seed.sequence}/${condition.label}`);
  const run = runCli(['agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', String(STEPS), '--adapter', adapter, '--model-adapter', model, '--json']);
  requireCliSuccess(run, `run ${seed.sequence}/${condition.label}`);
  if (firstJson(run.stdout)?.data?.status !== 'COMPLETED') throw new Error(`run ${seed.sequence}/${condition.label} did not complete`);
  const store = await LabStore.open({ labPath: lab });
  const measured = measureRun({ events: (await store.readRun('r')).events, tokenEntries: store.manifest.tokenMap.entries, seed, condition });
  if (!store.manifest.worldVersion.includes('continuous-power-v1') || (condition.chain && !store.manifest.worldVersion.includes('chain-v2'))) throw new Error(`world identity mismatch for ${seed.sequence}/${condition.label}`);
  const replay = runCli(['replay', '--lab', lab, '--run', 'r', '--adapter', adapter, '--json']);
  requireCliSuccess(replay, `replay ${seed.sequence}/${condition.label}`);
  const replayEnvelope = firstJson(replay.stdout);
  if (replayEnvelope?.data?.verdict !== 'CONSISTENT') throw new Error(`Replay ${seed.sequence}/${condition.label}: ${replayEnvelope?.data?.verdict}`);
  return { ...measured, replay: replayEnvelope.data.verdict, worldVersion: store.manifest.worldVersion, artifactPath: lab, attempt };
}

function shuffledConditions() { const order = [...CONDITIONS]; for (let index = order.length - 1; index > 0; index -= 1) { const swap = randomInt(index + 1); [order[index], order[swap]] = [order[swap], order[index]]; } return order.map((condition) => condition.label); }
function createCandidate(sequence, knownLabels = new Set()) { let seedLabel; do seedLabel = `r22-${randomBytes(32).toString('hex')}`; while (knownLabels.has(seedLabel)); knownLabels.add(seedLabel); return { sequence, seedLabel, treatmentOrder: shuffledConditions(), status: 'PENDING', conditions: {} }; }
function sourceFingerprint() {
  const listed = spawnSync('git', ['ls-files', '-z', 'src', 'bin', 'examples/energy/shared', 'examples/curriculum/ess-arbitrage', 'package.json', 'package-lock.json'], { cwd: ROOT, encoding: null, windowsHide: true });
  if (listed.status !== 0) throw new Error(`cannot enumerate experiment source files: ${listed.stderr?.toString('utf8')}`);
  const files = [...new Set([...listed.stdout.toString('utf8').split('\0').filter(Boolean), ...SOURCE_PATHS])].sort();
  const hash = createHash('sha256');
  for (const relativePath of files) hash.update(relativePath).update('\0').update(readFileSync(path.join(ROOT, relativePath)));
  return hash.digest('hex');
}
function experimentDesign() { return { sameSeedRuns: SAMPLE_SIZE, cellsPerSeed: 2, stepsPerCell: STEPS, valueMode: 'signed-v1', cells: CONDITIONS.map(({ label, chain }) => ({ label, continuousPower: true, chain })), changedWorldCondition: 'the WorldPort exposes one ess.set-power token and accepts only bounded decimal powerKw proposals; chain credit is the only paired condition', primaryOutcome: 'continuous-chain - continuous-base; positive means chain credit costs more under this proposal policy', seedSelection: 'independent 256-bit labels from node:crypto.randomBytes; sample distribution is induced by the current seed initializer, not asserted uniform over uint32 states', treatmentOrder: 'randomized independently within each seed using node:crypto.randomInt; each cell starts from a fresh Lab with the same seed label', objectiveOracle: 'persisted model proposal + independently encoded ESS SOC dynamics, fixed public load, and TOU tariff; adapter settlement totals are not used', replayRequired: true }; }
function createRunState() { const knownLabels = new Set(); const candidates = Array.from({ length: SAMPLE_SIZE }, (_, index) => createCandidate(index + 1, knownLabels)); return { schemaVersion: STATE_SCHEMA_VERSION, experiment: 'R22-continuous-power-interaction', status: 'RUNNING', createdAt: new Date().toISOString(), nodeVersion: process.version, sourceFingerprint: sourceFingerprint(), artifactRoot: mkdtempSync(path.join(tmpdir(), 'r22-continuous-power-artifacts-')), design: experimentDesign(), candidates }; }
function validateRunState(state, expectedFingerprint) { const relative = typeof state?.artifactRoot === 'string' ? path.relative(path.resolve(tmpdir()), path.resolve(state.artifactRoot)) : ''; if (state?.schemaVersion !== STATE_SCHEMA_VERSION || state.experiment !== 'R22-continuous-power-interaction' || state.status !== 'RUNNING' || state.nodeVersion !== process.version || state.sourceFingerprint !== expectedFingerprint || JSON.stringify(state.design) !== JSON.stringify(experimentDesign()) || !Array.isArray(state.candidates) || state.candidates.length < SAMPLE_SIZE || relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('R22 run state does not match this source, Node runtime, design, or active experiment.'); }
function writeJsonAtomically(filePath, value) { const temporaryPath = `${filePath}.${randomUUID()}.tmp`; writeFileSync(temporaryPath, JSON.stringify(value, null, 2)); renameSync(temporaryPath, filePath); }
function acceptedRuns(state) { return state.candidates.filter((candidate) => candidate.status === 'ACCEPTED').map((candidate) => candidate.paired); }
function pairedResult(candidate) { const byLabel = new Map(Object.entries(candidate.conditions)); return { sequence: candidate.sequence, seedLabel: candidate.seedLabel, treatmentOrder: candidate.treatmentOrder, continuousBase: byLabel.get('continuous-base'), continuousChain: byLabel.get('continuous-chain') }; }
function writeState(statePath, state) { state.updatedAt = new Date().toISOString(); writeJsonAtomically(statePath, state); }

async function runExperiment(state, statePath) {
  mkdirSync(state.artifactRoot, { recursive: true }); writeState(statePath, state); console.log(`R22 state ${statePath}`); console.log(`R22 source fingerprint ${state.sourceFingerprint}`);
  while (acceptedRuns(state).length < SAMPLE_SIZE) {
    let candidate = state.candidates.find((item) => item.status === 'PENDING' || item.status === 'RUNNING');
    if (candidate === undefined) { const knownLabels = new Set(state.candidates.map((item) => item.seedLabel)); state.candidates.push(createCandidate(state.candidates.length + 1, knownLabels)); writeState(statePath, state); candidate = state.candidates.at(-1); }
    candidate.status = 'RUNNING'; writeState(statePath, state);
    for (const conditionLabel of candidate.treatmentOrder) {
      if (candidate.conditions[conditionLabel] !== undefined) continue;
      const condition = CONDITIONS.find((item) => item.label === conditionLabel);
      const result = await runCondition({ seed: candidate, condition, state, attempt: randomUUID() }); candidate.conditions[conditionLabel] = result; writeState(statePath, state); console.log(`seed ${candidate.sequence} ${conditionLabel} ${result.costYuan} yuan; state ${result.initialRngState}; Replay ${result.replay}`);
    }
    candidate.paired = pairedResult(candidate);
    const usedStates = new Set(acceptedRuns(state).map((item) => item.continuousBase.initialRngState));
    const initialStates = new Set(Object.values(candidate.paired).filter((value) => value?.initialRngState).map((value) => value.initialRngState));
    if (initialStates.size !== 1) throw new Error(`same seed conditions produced mismatched initial RNG states for ${candidate.sequence}`);
    if (usedStates.has(candidate.paired.continuousBase.initialRngState)) { candidate.status = 'REJECTED_DUPLICATE_INITIAL_RNG_STATE'; candidate.rejection = 'initial RNG state already belongs to an accepted seed'; writeState(statePath, state); console.log(`seed ${candidate.sequence} rejected: repeated initial RNG state ${candidate.paired.continuousBase.initialRngState}`); continue; }
    candidate.status = 'ACCEPTED'; writeState(statePath, state);
  }
  const pairedRuns = acceptedRuns(state); const effect = summarizeR22PairedRuns(pairedRuns); const report = { experiment: state.experiment, analysisSource: state.resumed ? 'resumed-cli-runs' : 'fresh-cli-runs', sourceFingerprint: state.sourceFingerprint, nodeVersion: state.nodeVersion, design: state.design, effect, worldCondition: { capabilityId: 'ess.set-power', proposalField: 'powerKw', boundsKw: [-100, 100], decimalPlaces: 3 }, runs: pairedRuns.map((run) => Object.fromEntries(Object.entries(run).map(([key, value]) => [key, ['continuousBase', 'continuousChain'].includes(key) ? publicRun(value) : value]))), rejectedCandidates: state.candidates.filter((candidate) => candidate.status === 'REJECTED_DUPLICATE_INITIAL_RNG_STATE').map((candidate) => ({ sequence: candidate.sequence, seedLabel: candidate.seedLabel, initialRngState: candidate.paired.continuousBase.initialRngState, rejection: candidate.rejection, treatmentOrder: candidate.treatmentOrder })) };
  if (existsSync(REPORT_PATH)) throw new Error(`report already exists; refusing to overwrite ${REPORT_PATH}`); writeJsonAtomically(REPORT_PATH, report); state.status = 'COMPLETED'; state.completedAt = new Date().toISOString(); writeState(statePath, state); console.log(`mean continuous chain delta ${effect.meanChainDeltaYuan} yuan; decision ${effect.decision}`); console.log(`approximate 95% interval [${effect.nominalCi95ChainDeltaYuan.low}, ${effect.nominalCi95ChainDeltaYuan.high}] yuan`); console.log(`written docs/figures/r22-continuous-power-interaction.json; ${effect.nSeedRuns} accepted seeds`);
}
function publicRun(run) { const { artifactPath, attempt, ...measured } = run; return measured; }
function argumentValue(flag) { const index = process.argv.indexOf(flag); if (index < 0) return undefined; const value = process.argv[index + 1]; if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a path`); return path.resolve(value); }
async function main() { const resumePath = argumentValue('--resume'); const requestedStatePath = argumentValue('--state-file'); if (resumePath !== undefined && requestedStatePath !== undefined) throw new Error('use either --resume or --state-file, not both'); const fingerprint = sourceFingerprint(); if (resumePath === undefined && existsSync(REPORT_PATH)) throw new Error(`report already exists; refusing to overwrite ${REPORT_PATH}`); let state; let statePath; if (resumePath !== undefined) { statePath = resumePath; state = JSON.parse(readFileSync(statePath, 'utf8')); validateRunState(state, fingerprint); state.resumed = true; } else { statePath = requestedStatePath ?? path.join(tmpdir(), `yi-agent-r22-${randomUUID()}.json`); if (existsSync(statePath)) throw new Error(`state file already exists: ${statePath}`); state = createRunState(); writeState(statePath, state); } await runExperiment(state, statePath); }
await main();

#!/usr/bin/env node

// R23：让模型按当前 observation 选择连续功率，再检查 proposal 是否与该观测
// 一一对应。这里先验证反馈闭环，不把收益或 proposal 条件化学习提前混入结论。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE_SIZE = 8;
const STEPS = 96;
const REPORT_PATH = path.join(ROOT, 'docs/figures/r23-feedback-continuous-power.json');
const ADAPTER = path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs');
const MODEL_ADAPTER = path.join(ROOT, 'test/fixtures/feedback-continuous-power-model-adapter.mjs');

function expectedPower(observation) {
  const tariff = observation.vector[1];
  const soc = observation.vector[2] * 100;
  if (tariff < -0.1 && soc < 80) return 50;
  if (tariff > 0.1 && soc > 20) return -50;
  return 0;
}
function runCli(args) { return spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: process.env, maxBuffer: 64 * 1024 * 1024, timeout: 300000 }); }
function jsonLine(stdout) { const line = stdout.trim().split(/\r?\n/u).find((item) => item.length > 0); return line === undefined ? null : JSON.parse(line); }
function requireSuccess(result, label) { if (result.status !== 0) throw new Error(`${label} failed (${result.status}): ${(result.stderr || result.stdout).slice(0, 500)}`); }
function sourceFingerprint() {
  const files = [
    'src', 'bin', 'examples/energy/shared', 'examples/curriculum/ess-arbitrage',
    'package.json', 'package-lock.json', 'scripts/curriculum/r23-feedback-continuous-power.mjs',
    'test/fixtures/feedback-continuous-power-model-adapter.mjs',
  ];
  const listed = spawnSync('git', ['ls-files', '-z', ...files], { cwd: ROOT, encoding: null, windowsHide: true });
  if (listed.status !== 0) throw new Error('cannot enumerate experiment source files');
  const hash = createHash('sha256');
  for (const relative of listed.stdout.toString('utf8').split('\0').filter(Boolean).sort()) hash.update(relative).update('\0').update(readFileSync(path.join(ROOT, relative)));
  return hash.digest('hex');
}
function runOne(seed, index) {
  const artifact = mkdtempSync(path.join(tmpdir(), `yi-agent-r23-${index}-`));
  const adapterConfig = path.join(artifact, 'adapter.json');
  const modelConfig = path.join(artifact, 'model.json');
  const lab = path.join(artifact, 'lab');
  writeFileSync(adapterConfig, JSON.stringify({ executable: process.execPath, args: [ADAPTER, '--utility-mode', '--continuous-power'], adapterId: 'ess-arbitrage-adapter-v1', worldId: 'ess-arbitrage', timeoutMs: 30000, transport: 'persistent-jsonl' }));
  writeFileSync(modelConfig, JSON.stringify({ executable: process.execPath, args: [MODEL_ADAPTER], model: 'feedback-continuous-power-fixture', timeoutMs: 5000 }));
  requireSuccess(runCli(['init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', seed, '--adapter', adapterConfig, '--json']), `init ${index}`);
  const run = runCli(['agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', String(STEPS), '--adapter', adapterConfig, '--model-adapter', modelConfig, '--json']);
  requireSuccess(run, `run ${index}`);
  if (jsonLine(run.stdout)?.data?.status !== 'COMPLETED') throw new Error(`run ${index} did not complete`);
  return LabStore.open({ labPath: lab }).then(async (store) => {
    const events = (await store.readRun('r')).events.filter((event) => event.kind === 'STEP');
    if (events.length !== STEPS) throw new Error(`run ${index} has ${events.length} steps`);
    const powers = events.map((event) => event.payload.policyEvidence?.proposal?.powerKw);
    const expected = events.map((event) => expectedPower(event.payload.beforeObservation));
    if (JSON.stringify(powers) !== JSON.stringify(expected)) throw new Error(`feedback mismatch in run ${index}`);
    const current = await store.readChainCurrent();
    const replay = runCli(['replay', '--lab', lab, '--run', 'r', '--adapter', adapterConfig, '--json']);
    requireSuccess(replay, `replay ${index}`);
    if (jsonLine(replay.stdout)?.data?.verdict !== 'CONSISTENT') throw new Error(`replay ${index} was inconsistent`);
    return { seed, steps: events.length, feedbackAligned: true, uniquePowers: [...new Set(powers)].sort((a, b) => a - b), actionModelKeyCount: Object.keys(current.memory.actionModels).length, actionModelSamples: Object.values(current.memory.actionModels)[0]?.sampleCount ?? 0, replay: 'CONSISTENT' };
  });
}

async function main() {
  if (existsSync(REPORT_PATH)) throw new Error(`report already exists; refusing to overwrite ${REPORT_PATH}`);
  const seeds = Array.from({ length: SAMPLE_SIZE }, () => `r23-${randomBytes(32).toString('hex')}`);
  const runs = [];
  for (const [index, seed] of seeds.entries()) { const result = await runOne(seed, index + 1); runs.push(result); console.log(`run ${index + 1}/${SAMPLE_SIZE}: ${result.uniquePowers.join(',')} kW; model keys ${result.actionModelKeyCount}; Replay ${result.replay}`); }
  const report = { experiment: 'R23-feedback-continuous-power', sourceFingerprint: sourceFingerprint(), nodeVersion: process.version, design: { independentRuns: SAMPLE_SIZE, stepsPerRun: STEPS, policy: 'valley +50 kW while SOC < 80%; peak -50 kW while SOC > 20%; otherwise 0 kW', primaryOutcome: 'every persisted proposal equals the function of the preceding observation', replayRequired: true }, result: { runs: runs.length, allFeedbackAligned: runs.every((run) => run.feedbackAligned), allReplayConsistent: runs.every((run) => run.replay === 'CONSISTENT'), observedPowerValues: [...new Set(runs.flatMap((run) => run.uniquePowers))].sort((a, b) => a - b), actionModelKeyCounts: [...new Set(runs.map((run) => run.actionModelKeyCount))], actionModelSampleCounts: [...new Set(runs.map((run) => run.actionModelSamples))] }, runs };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`written docs/figures/r23-feedback-continuous-power.json; ${runs.length} runs`);
}
await main();

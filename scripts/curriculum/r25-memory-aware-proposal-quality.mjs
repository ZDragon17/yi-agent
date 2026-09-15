#!/usr/bin/env node

// R25：验证 proposal 条件化记忆是否会改变后续候选质量，而不是只改变存储形状。
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE_SIZE = 8;
const STEPS = 96;
const REPORT_PATH = path.join(ROOT, 'docs/figures/r25-memory-aware-proposal-quality.json');
const ADAPTER = path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs');
const REACTIVE_MODEL = path.join(ROOT, 'test/fixtures/feedback-continuous-power-model-adapter.mjs');
const MEMORY_MODEL = path.join(ROOT, 'test/fixtures/memory-aware-continuous-power-model-adapter.mjs');

function runCli(args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300000,
  });
}

function jsonLine(stdout) {
  const line = stdout.trim().split(/\r?\n/u).find((item) => item.length > 0);
  return line === undefined ? null : JSON.parse(line);
}

function requireSuccess(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}): ${(result.stderr || result.stdout).slice(0, 500)}`);
}

function sourceFingerprint() {
  const files = [
    'src',
    'bin',
    'examples/energy/shared',
    'examples/curriculum/ess-arbitrage',
    'package.json',
    'package-lock.json',
    'scripts/curriculum/r25-memory-aware-proposal-quality.mjs',
    'test/fixtures/feedback-continuous-power-model-adapter.mjs',
    'test/fixtures/memory-aware-continuous-power-model-adapter.mjs',
  ];
  const listed = spawnSync('git', ['ls-files', '-z', ...files], { cwd: ROOT, encoding: null, windowsHide: true });
  if (listed.status !== 0) throw new Error('cannot enumerate experiment source files');
  const tracked = listed.stdout.toString('utf8').split('\0').filter(Boolean);
  for (const required of [
    'scripts/curriculum/r25-memory-aware-proposal-quality.mjs',
    'test/fixtures/memory-aware-continuous-power-model-adapter.mjs',
  ]) if (!tracked.includes(required)) tracked.push(required);
  const hash = createHash('sha256');
  for (const relative of tracked.sort()) hash.update(relative).update('\0').update(readFileSync(path.join(ROOT, relative)));
  return hash.digest('hex');
}

function runOne(seed, modelPath, label, index) {
  const artifact = mkdtempSync(path.join(tmpdir(), `yi-agent-r25-${index}-${label}-`));
  const adapterConfig = path.join(artifact, 'adapter.json');
  const modelConfig = path.join(artifact, 'model.json');
  const lab = path.join(artifact, 'lab');
  writeFileSync(adapterConfig, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, '--utility-mode', '--continuous-power'],
    adapterId: 'ess-arbitrage-adapter-v1',
    worldId: 'ess-arbitrage',
    timeoutMs: 30000,
    transport: 'persistent-jsonl',
  }));
  writeFileSync(modelConfig, JSON.stringify({
    executable: process.execPath,
    args: [modelPath],
    model: `${label}-continuous-power-fixture`,
    timeoutMs: 5000,
  }));
  requireSuccess(runCli(['init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', seed, '--adapter', adapterConfig, '--json']), `init ${label}-${index}`);
  const run = runCli([
    'agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', String(STEPS),
    '--adapter', adapterConfig, '--model-adapter', modelConfig, '--json',
  ]);
  requireSuccess(run, `run ${label}-${index}`);
  if (jsonLine(run.stdout)?.data?.status !== 'COMPLETED') throw new Error(`run ${label}-${index} did not complete`);
  return LabStore.open({ labPath: lab }).then(async (store) => {
    const events = (await store.readRun('r')).events.filter((event) => event.kind === 'STEP');
    const replay = runCli(['replay', '--lab', lab, '--run', 'r', '--adapter', adapterConfig, '--json']);
    requireSuccess(replay, `replay ${label}-${index}`);
    if (jsonLine(replay.stdout)?.data?.verdict !== 'CONSISTENT') throw new Error(`replay ${label}-${index} was inconsistent`);
    const finalState = events.at(-1)?.payload.afterState.worldState;
    return {
      label,
      seed,
      steps: events.length,
      utilityYuan: finalState?.utilityYuan,
      replay: 'CONSISTENT',
      proposals: events.map((event) => event.payload.policyEvidence?.proposal?.powerKw),
      learnedProposalModelCount: Object.values((await store.readChainCurrent()).memory.proposalModels ?? {})
        .reduce((sum, models) => sum + Object.keys(models).length, 0),
    };
  });
}

async function main() {
  if (existsSync(REPORT_PATH) && !process.argv.includes('--rewrite')) throw new Error(`report already exists; use --rewrite to overwrite ${REPORT_PATH}`);
  const seeds = Array.from({ length: SAMPLE_SIZE }, () => `r25-${randomBytes(32).toString('hex')}`);
  const runs = [];
  for (const [index, seed] of seeds.entries()) {
    const reactive = await runOne(seed, REACTIVE_MODEL, 'reactive', index + 1);
    const memoryAware = await runOne(seed, MEMORY_MODEL, 'memory-aware', index + 1);
    runs.push({ seed, reactive, memoryAware, utilityDifferenceYuan: memoryAware.utilityYuan - reactive.utilityYuan });
    console.log(`pair ${index + 1}/${SAMPLE_SIZE}: reactive=${reactive.utilityYuan}; memory-aware=${memoryAware.utilityYuan}`);
  }
  const differences = runs.map((run) => run.utilityDifferenceYuan);
  const meanDifferenceYuan = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const report = {
    experiment: 'R25-memory-aware-proposal-quality',
    sourceFingerprint: sourceFingerprint(),
    nodeVersion: process.version,
    design: {
      independentPairedRuns: SAMPLE_SIZE,
      stepsPerRun: STEPS,
      primaryOutcome: 'whether a model that reads verified proposalModels changes cumulative utility against an observation-only model',
      lowerUtilityIsBetter: true,
      replayRequired: true,
    },
    result: {
      pairs: runs.length,
      allReplayConsistent: runs.every((run) => run.reactive.replay === 'CONSISTENT' && run.memoryAware.replay === 'CONSISTENT'),
      meanMemoryAwareMinusReactiveYuan: meanDifferenceYuan,
      improvedPairs: differences.filter((value) => value < 0).length,
      worsenedPairs: differences.filter((value) => value > 0).length,
      equalPairs: differences.filter((value) => value === 0).length,
    },
    runs,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`written docs/figures/r25-memory-aware-proposal-quality.json; ${runs.length} pairs`);
}

await main();

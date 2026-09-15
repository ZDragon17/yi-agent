#!/usr/bin/env node

// R26：验证 proposal × context 是否能改善 R25 的全局 proposal 平均值混淆。
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE_SIZE = 8;
const STEPS = 96;
const REPORT_PATH = path.join(ROOT, 'docs/figures/r26-context-aware-proposal-quality.json');
const ADAPTER = path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs');
const GLOBAL_MODEL = path.join(ROOT, 'test/fixtures/memory-aware-continuous-power-model-adapter.mjs');
const CONTEXT_MODEL = path.join(ROOT, 'test/fixtures/context-aware-continuous-power-model-adapter.mjs');

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
    'scripts/curriculum/r26-context-aware-proposal-quality.mjs',
    'test/fixtures/memory-aware-continuous-power-model-adapter.mjs',
    'test/fixtures/context-aware-continuous-power-model-adapter.mjs',
  ];
  const listed = spawnSync('git', ['ls-files', '-z', ...files], { cwd: ROOT, encoding: null, windowsHide: true });
  if (listed.status !== 0) throw new Error('cannot enumerate experiment source files');
  const tracked = listed.stdout.toString('utf8').split('\0').filter(Boolean);
  for (const required of [
    'scripts/curriculum/r26-context-aware-proposal-quality.mjs',
    'test/fixtures/context-aware-continuous-power-model-adapter.mjs',
  ]) if (!tracked.includes(required)) tracked.push(required);
  const hash = createHash('sha256');
  for (const relative of tracked.sort()) hash.update(relative).update('\0').update(readFileSync(path.join(ROOT, relative)));
  return hash.digest('hex');
}

function countContextModels(memory) {
  return Object.values(memory.proposalContextModels ?? {}).reduce((sum, proposals) =>
    sum + Object.values(proposals).reduce((proposalSum, contexts) => proposalSum + Object.keys(contexts).length, 0),
  0);
}

function runOne(seed, modelPath, label, index) {
  const artifact = mkdtempSync(path.join(tmpdir(), `yi-agent-r26-${index}-${label}-`));
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
    const current = await store.readChainCurrent();
    return {
      label,
      seed,
      steps: events.length,
      utilityYuan: events.at(-1)?.payload.afterState.worldState.utilityYuan,
      replay: 'CONSISTENT',
      proposals: events.map((event) => event.payload.policyEvidence?.proposal?.powerKw),
      proposalModelCount: Object.values(current.memory.proposalModels ?? {})
        .reduce((sum, models) => sum + Object.keys(models).length, 0),
      proposalContextModelCount: countContextModels(current.memory),
    };
  });
}

async function main() {
  if (existsSync(REPORT_PATH) && !process.argv.includes('--rewrite')) throw new Error(`report already exists; use --rewrite to overwrite ${REPORT_PATH}`);
  const seeds = Array.from({ length: SAMPLE_SIZE }, () => `r26-${randomBytes(32).toString('hex')}`);
  const runs = [];
  for (const [index, seed] of seeds.entries()) {
    const global = await runOne(seed, GLOBAL_MODEL, 'global', index + 1);
    const contextual = await runOne(seed, CONTEXT_MODEL, 'contextual', index + 1);
    runs.push({ seed, global, contextual, utilityDifferenceYuan: contextual.utilityYuan - global.utilityYuan });
    console.log(`pair ${index + 1}/${SAMPLE_SIZE}: global=${global.utilityYuan}; contextual=${contextual.utilityYuan}`);
  }
  const differences = runs.map((run) => run.utilityDifferenceYuan);
  const meanDifferenceYuan = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const report = {
    experiment: 'R26-context-aware-proposal-quality',
    sourceFingerprint: sourceFingerprint(),
    nodeVersion: process.version,
    design: {
      independentPairedRuns: SAMPLE_SIZE,
      stepsPerRun: STEPS,
      primaryOutcome: 'whether active proposal-context models improve cumulative utility over global proposal models',
      lowerUtilityIsBetter: true,
      replayRequired: true,
    },
    result: {
      pairs: runs.length,
      allReplayConsistent: runs.every((run) => run.global.replay === 'CONSISTENT' && run.contextual.replay === 'CONSISTENT'),
      meanContextualMinusGlobalYuan: meanDifferenceYuan,
      improvedPairs: differences.filter((value) => value < 0).length,
      worsenedPairs: differences.filter((value) => value > 0).length,
      equalPairs: differences.filter((value) => value === 0).length,
      contextualModelCounts: [...new Set(runs.map((run) => run.contextual.proposalContextModelCount))],
    },
    runs,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`written docs/figures/r26-context-aware-proposal-quality.json; ${runs.length} pairs`);
}

await main();

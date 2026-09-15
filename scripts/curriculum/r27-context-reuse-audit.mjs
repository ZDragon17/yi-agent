#!/usr/bin/env node

// R27：审计 proposal×context 模型是否形成可重复证据，而不是只产生大量一次性键。
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
const REPORT_PATH = path.join(ROOT, 'docs/figures/r27-context-reuse-audit.json');
const ADAPTER = path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs');
const MODEL = path.join(ROOT, 'test/fixtures/context-aware-continuous-power-model-adapter.mjs');

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
    'scripts/curriculum/r27-context-reuse-audit.mjs',
    'test/fixtures/context-aware-continuous-power-model-adapter.mjs',
  ];
  const listed = spawnSync('git', ['ls-files', '-z', ...files], { cwd: ROOT, encoding: null, windowsHide: true });
  if (listed.status !== 0) throw new Error('cannot enumerate audit source files');
  const tracked = listed.stdout.toString('utf8').split('\0').filter(Boolean);
  for (const required of [
    'scripts/curriculum/r27-context-reuse-audit.mjs',
    'test/fixtures/context-aware-continuous-power-model-adapter.mjs',
  ]) if (!tracked.includes(required)) tracked.push(required);
  const hash = createHash('sha256');
  for (const relative of tracked.sort()) hash.update(relative).update('\0').update(readFileSync(path.join(ROOT, relative)));
  return hash.digest('hex');
}

function auditMemory(memory) {
  const sampleCounts = [];
  const byScale = { h0: 0, h1: 0, h2: 0 };
  const reusableByScale = { h0: 0, h1: 0, h2: 0 };
  for (const proposals of Object.values(memory.proposalContextModels ?? {})) {
    for (const contexts of Object.values(proposals)) {
      for (const [contextKey, model] of Object.entries(contexts)) {
        sampleCounts.push(model.sampleCount);
        const scale = contextKey.slice(0, 2);
        if (Object.hasOwn(byScale, scale)) {
          byScale[scale] += 1;
          if (model.sampleCount >= 2) reusableByScale[scale] += 1;
        }
      }
    }
  }
  return {
    proposalContextModelCount: sampleCounts.length,
    reusableModelCountAtTwoSamples: sampleCounts.filter((count) => count >= 2).length,
    modelCountsBySampleCount: Object.fromEntries(
      [...new Set(sampleCounts)].sort((left, right) => left - right).map((count) => [count, sampleCounts.filter((item) => item === count).length]),
    ),
    modelsByScale: byScale,
    reusableModelsByScaleAtTwoSamples: reusableByScale,
  };
}

async function runOne(seed, index) {
  const artifact = mkdtempSync(path.join(tmpdir(), `yi-agent-r27-${index}-`));
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
    args: [MODEL],
    model: 'context-reuse-audit-fixture',
    timeoutMs: 5000,
  }));
  requireSuccess(runCli(['init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', seed, '--adapter', adapterConfig, '--json']), `init ${index}`);
  const run = runCli([
    'agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', String(STEPS),
    '--adapter', adapterConfig, '--model-adapter', modelConfig, '--json',
  ]);
  requireSuccess(run, `run ${index}`);
  if (jsonLine(run.stdout)?.data?.status !== 'COMPLETED') throw new Error(`run ${index} did not complete`);
  const store = await LabStore.open({ labPath: lab });
  const replay = runCli(['replay', '--lab', lab, '--run', 'r', '--adapter', adapterConfig, '--json']);
  requireSuccess(replay, `replay ${index}`);
  if (jsonLine(replay.stdout)?.data?.verdict !== 'CONSISTENT') throw new Error(`replay ${index} was inconsistent`);
  const audit = auditMemory((await store.readChainCurrent()).memory);
  return { seed, steps: STEPS, replay: 'CONSISTENT', ...audit };
}

async function main() {
  if (existsSync(REPORT_PATH) && !process.argv.includes('--rewrite')) throw new Error(`report already exists; use --rewrite to overwrite ${REPORT_PATH}`);
  const seeds = Array.from({ length: SAMPLE_SIZE }, () => `r27-${randomBytes(32).toString('hex')}`);
  const runs = [];
  for (const [index, seed] of seeds.entries()) {
    const result = await runOne(seed, index + 1);
    runs.push(result);
    console.log(`run ${index + 1}/${SAMPLE_SIZE}: ${result.proposalContextModelCount} models; reusable>=2 ${result.reusableModelCountAtTwoSamples}; Replay ${result.replay}`);
  }
  const average = (field) => runs.reduce((sum, run) => sum + run[field], 0) / runs.length;
  const report = {
    experiment: 'R27-context-reuse-audit',
    sourceFingerprint: sourceFingerprint(),
    nodeVersion: process.version,
    design: {
      independentRuns: SAMPLE_SIZE,
      stepsPerRun: STEPS,
      primaryOutcome: 'whether proposal-context models recur often enough to form reusable evidence',
      reusableThresholdSamples: 2,
      replayRequired: true,
    },
    result: {
      runs: runs.length,
      allReplayConsistent: runs.every((run) => run.replay === 'CONSISTENT'),
      averageProposalContextModelCount: average('proposalContextModelCount'),
      averageReusableModelCountAtTwoSamples: average('reusableModelCountAtTwoSamples'),
      modelCountsBySampleCount: runs[0].modelCountsBySampleCount,
      modelsByScale: runs[0].modelsByScale,
      reusableModelsByScaleAtTwoSamples: runs[0].reusableModelsByScaleAtTwoSamples,
    },
    runs,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`written docs/figures/r27-context-reuse-audit.json; ${runs.length} runs`);
}

await main();

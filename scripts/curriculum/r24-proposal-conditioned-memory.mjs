#!/usr/bin/env node

// R24：验证同一动作 Token 下，不同 proposal 的反馈会进入各自的模型，
// 而不是继续汇总到一个 token-level action model。
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateDigest } from '../../src/runtime/schema.mjs';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE_SIZE = 8;
const STEPS = 96;
const REPORT_PATH = path.join(ROOT, 'docs/figures/r24-proposal-conditioned-memory.json');
const ADAPTER = path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs');
const MODEL_ADAPTER = path.join(ROOT, 'test/fixtures/feedback-continuous-power-model-adapter.mjs');

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
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${(result.stderr || result.stdout).slice(0, 500)}`);
  }
}

function sourceFingerprint() {
  const files = [
    'src',
    'bin',
    'examples/energy/shared',
    'examples/curriculum/ess-arbitrage',
    'package.json',
    'package-lock.json',
    'scripts/curriculum/r24-proposal-conditioned-memory.mjs',
    'test/fixtures/feedback-continuous-power-model-adapter.mjs',
  ];
  const listed = spawnSync('git', ['ls-files', '-z', ...files], {
    cwd: ROOT,
    encoding: null,
    windowsHide: true,
  });
  if (listed.status !== 0) throw new Error('cannot enumerate experiment source files');
  const hash = createHash('sha256');
  const tracked = listed.stdout.toString('utf8').split('\0').filter(Boolean);
  if (!tracked.includes('scripts/curriculum/r24-proposal-conditioned-memory.mjs')) {
    tracked.push('scripts/curriculum/r24-proposal-conditioned-memory.mjs');
  }
  for (const relative of tracked.sort()) {
    hash.update(relative).update('\0').update(readFileSync(path.join(ROOT, relative)));
  }
  return hash.digest('hex');
}

function runOne(seed, index) {
  const artifact = mkdtempSync(path.join(tmpdir(), `yi-agent-r24-${index}-`));
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
    args: [MODEL_ADAPTER],
    model: 'feedback-continuous-power-fixture',
    timeoutMs: 5000,
  }));
  requireSuccess(
    runCli(['init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', seed, '--adapter', adapterConfig, '--json']),
    `init ${index}`,
  );
  const run = runCli([
    'agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', String(STEPS),
    '--adapter', adapterConfig, '--model-adapter', modelConfig, '--json',
  ]);
  requireSuccess(run, `run ${index}`);
  if (jsonLine(run.stdout)?.data?.status !== 'COMPLETED') throw new Error(`run ${index} did not complete`);

  return LabStore.open({ labPath: lab }).then(async (store) => {
    const steps = (await store.readRun('r')).events.filter((event) => event.kind === 'STEP');
    if (steps.length !== STEPS) throw new Error(`run ${index} has ${steps.length} steps`);
    const replay = runCli(['replay', '--lab', lab, '--run', 'r', '--adapter', adapterConfig, '--json']);
    requireSuccess(replay, `replay ${index}`);
    if (jsonLine(replay.stdout)?.data?.verdict !== 'CONSISTENT') throw new Error(`replay ${index} was inconsistent`);

    const token = steps[0].payload.choice.token;
    const proposalCounts = new Map();
    for (const step of steps.slice(0, -1)) {
      const proposal = step.payload.policyEvidence?.proposal;
      const key = JSON.stringify(proposal);
      proposalCounts.set(key, (proposalCounts.get(key) ?? 0) + 1);
    }
    const current = await store.readChainCurrent();
    if (Object.keys(current.memory.actionModels).length !== 0) {
      throw new Error(`run ${index} retained an aggregate action model`);
    }
    const models = current.memory.proposalModels?.[token] ?? {};
    const modelSamplesByProposal = {};
    for (const [proposalJson, count] of proposalCounts) {
      const proposal = JSON.parse(proposalJson);
      const digest = candidateDigest({ token, proposal });
      const model = models[digest];
      if (model === undefined || model.sampleCount !== count) {
        throw new Error(`run ${index} proposal model count mismatch for ${proposalJson}`);
      }
      modelSamplesByProposal[proposalJson] = model.sampleCount;
    }
    if (Object.keys(models).length !== proposalCounts.size) {
      throw new Error(`run ${index} has orphaned proposal models`);
    }
    return {
      seed,
      steps: steps.length,
      actionModelKeyCount: Object.keys(current.memory.actionModels).length,
      proposalModelKeyCount: Object.keys(models).length,
      proposalSampleCounts: modelSamplesByProposal,
      replay: 'CONSISTENT',
    };
  });
}

async function main() {
  if (existsSync(REPORT_PATH) && !process.argv.includes('--rewrite')) {
    throw new Error(`report already exists; refusing to overwrite ${REPORT_PATH}`);
  }
  const seeds = Array.from({ length: SAMPLE_SIZE }, () => `r24-${randomBytes(32).toString('hex')}`);
  const runs = [];
  for (const [index, seed] of seeds.entries()) {
    const result = await runOne(seed, index + 1);
    runs.push(result);
    console.log(`run ${index + 1}/${SAMPLE_SIZE}: ${result.proposalModelKeyCount} proposal models; Replay ${result.replay}`);
  }
  const report = {
    experiment: 'R24-proposal-conditioned-memory',
    sourceFingerprint: sourceFingerprint(),
    nodeVersion: process.version,
    design: {
      independentRuns: SAMPLE_SIZE,
      stepsPerRun: STEPS,
      primaryOutcome: 'each proposal digest learns only from occurrences of that exact token+proposal pair',
      replayRequired: true,
    },
    result: {
      runs: runs.length,
      allRunsSeparated: runs.every((run) => run.actionModelKeyCount === 0 && run.proposalModelKeyCount === 3),
      allReplayConsistent: runs.every((run) => run.replay === 'CONSISTENT'),
      actionModelKeyCounts: [...new Set(runs.map((run) => run.actionModelKeyCount))],
      proposalModelKeyCounts: [...new Set(runs.map((run) => run.proposalModelKeyCount))],
      proposalSampleCounts: runs.map((run) => run.proposalSampleCounts),
    },
    runs,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`written docs/figures/r24-proposal-conditioned-memory.json; ${runs.length} runs`);
}

await main();

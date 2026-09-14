#!/usr/bin/env node

// R15：固定 seed 标签配对测量 signed-v1 下 creditChain 对 96 步电费的影响。
// 记录实际 RNG 状态和轨迹覆盖；固定 seed sweep 只作描述，不作总体推断。

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKw, PRICE_LEVELS_BY_HOUR, TOU_TARIFF } from '../../examples/energy/shared/energy-sim.mjs';
import { LabStore } from '../../src/runtime/lab-store.mjs';
import { summarizeR15PairedRuns } from './r15-chain-effect-statistics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STEPS = 96;
const HORIZON = 8;
const REPORT_PATH = path.join(ROOT, 'docs/figures/r15-chain-effect.json');
const SEEDS = [
  { label: 'alpha', value: 'r14-alpha' },
  { label: 'beta', value: 'r14-beta' },
  { label: 'gamma', value: 'r14-gamma' },
  ...Array.from({ length: 17 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, '0');
    return { label: `new-${suffix}`, value: `r15-seed-${suffix}` };
  }),
];
const CONDITIONS = [
  { label: 'utility-base', chain: false },
  { label: 'utility-pair', chain: true },
];
const R14_ANCHOR = {
  alpha: { 'utility-base': 14222, 'utility-pair': 13687 },
  beta: { 'utility-base': 13602, 'utility-pair': 13892 },
  gamma: { 'utility-base': 14222, 'utility-pair': 13722 },
};
const tariffPrice = (hour) => [TOU_TARIFF.valley, TOU_TARIFF.flat, TOU_TARIFF.peak][PRICE_LEVELS_BY_HOUR[hour % 24]];

function runCli(args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), ...args], {
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
  if (steps.length !== STEPS) throw new Error(`wrong STEP count for ${seed.label}/${condition.label}`);
  const initialRngState = steps[0]?.payload.rngBefore?.state;
  if (!Number.isInteger(initialRngState) || initialRngState <= 0 || initialRngState > 0xffffffff) {
    throw new Error(`invalid initial RNG state for ${seed.label}/${condition.label}`);
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
    if (essPower === null) throw new Error(`unknown ESS action in ${seed.label}/${condition.label}`);
    actionTrace.push(capabilityId);
    // 独立于 adapter 的 settlement evidence，从落账动作和公开电价重算总成本。
    cost += Math.max(0, loadKw(hour) + essPower) * tariffPrice(hour);
    for (const item of event.payload.update?.settled ?? []) {
      if (item.attribution === 'ACTION_CHAIN') actionChains += 1;
      if (item.attribution === 'UNRESOLVED') unresolved += 1;
    }
  }
  const valueMode = steps[0]?.payload.boundary.valueSpec.valueMode;
  if (valueMode !== 'signed-v1') throw new Error(`wrong value mode for ${seed.label}/${condition.label}`);

  return {
    seed: seed.label,
    initSeed: seed.value,
    condition: condition.label,
    initialRngState,
    costYuan: Math.round(cost),
    actionChains,
    unresolved,
    valueMode,
    actionTraceDigest: createHash('sha256').update(JSON.stringify(actionTrace)).digest('hex'),
  };
}

async function runCondition({ seed, condition, index, tmp }) {
  const adapter = path.join(tmp, `adapter-${index}-${condition.label}.json`);
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

  const lab = path.join(tmp, `lab-${index}-${condition.label}`);
  const init = runCli([
    'init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', seed.value,
    '--adapter', adapter, '--json',
  ]);
  requireCliSuccess(init, `init ${seed.label}/${condition.label}`);
  const run = runCli([
    'agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', String(STEPS),
    '--kernel-only', '--planning-horizon', String(HORIZON), '--adapter', adapter, '--json',
  ]);
  requireCliSuccess(run, `run ${seed.label}/${condition.label}`);
  const runEnvelope = firstJson(run.stdout);
  if (runEnvelope?.data?.status !== 'COMPLETED') {
    throw new Error(`run ${seed.label}/${condition.label} did not complete: ${runEnvelope?.data?.status}`);
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
  requireCliSuccess(replay, `replay ${seed.label}/${condition.label}`);
  const replayEnvelope = firstJson(replay.stdout);
  if (replayEnvelope?.data?.verdict !== 'CONSISTENT') {
    throw new Error(`Replay ${seed.label}/${condition.label}: ${replayEnvelope?.data?.verdict}`);
  }
  return { ...measured, replay: replayEnvelope.data.verdict };
}

async function readExistingCondition({ lab, seed, condition, previous }) {
  if (previous.replay !== 'CONSISTENT') throw new Error(`stored Replay result invalid for ${seed.label}/${condition.label}`);
  const store = await LabStore.open({ labPath: lab });
  const runRecord = await store.readRun('r');
  const measured = measureRun({
    events: runRecord.events,
    tokenEntries: store.manifest.tokenMap.entries,
    seed,
    condition,
  });
  for (const key of ['costYuan', 'actionChains', 'unresolved']) {
    if (measured[key] !== previous[key]) {
      throw new Error(`existing ledger ${key} mismatch for ${seed.label}/${condition.label}`);
    }
  }
  return { ...previous, ...measured };
}

function makeReport(pairs, { analysisSource, anchorReplication }) {
  const effectPairs = pairs.map((pair) => {
    const base = pair['utility-base'];
    const chain = pair['utility-pair'];
    if (base.initialRngState !== chain.initialRngState) {
      throw new Error(`paired runs used different initial RNG states for ${pair.seed}`);
    }
    return {
      baseTraceDigest: base.actionTraceDigest,
      chainTraceDigest: chain.actionTraceDigest,
      initialRngState: base.initialRngState,
      deltaYuan: pair.deltaYuan,
    };
  });
  const effect = summarizeR15PairedRuns(effectPairs);
  const baseline = Array.from({ length: STEPS }, (_, hour) => loadKw(hour) * tariffPrice(hour))
    .reduce((sum, cost) => sum + cost, 0);
  return {
    experiment: 'R15-chain-effect',
    analysisSource,
    design: {
      pairedSeeds: 20,
      stepsPerCondition: STEPS,
      planningHorizon: HORIZON,
      valueMode: 'signed-v1',
      primaryOutcome: 'utility-pair cost minus utility-base cost; negative favors chain credit',
      seedSelection: '20 fixed literal labels; not probability-sampled',
      seedState: 'recorded from the first STEP.rngBefore.state; paired conditions must match',
      interval: 'nominal two-sided 95% paired Student-t interval, df=19; descriptive only because seed labels were fixed rather than probability-sampled',
      inferenceUnit: 'fixed seed label; this sweep is descriptive, and trace counts are coverage diagnostics rather than independent-sample evidence',
      treatmentOrder: 'alternated by paired seed',
      objectiveOracle: 'STEP action token + deterministic load + public TOU tariff; adapter settlement evidence is not used',
      replayRequired: true,
    },
    idleBaselineYuan: Math.round(baseline),
    effect,
    pairs,
    anchorReplication,
  };
}

function writeReport(report) {
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  const effect = report.effect;
  console.log(`paired mean delta ${effect.meanDeltaYuan} yuan; distinct base traces ${effect.uniqueBaseActionTraces}/20; ${effect.decision}`);
  console.log(`nominal 95% paired t interval [${effect.nominalCi95Yuan.low}, ${effect.nominalCi95Yuan.high}] is descriptive only`);
  console.log(`written docs/figures/r15-chain-effect.json`);
}

async function main() {
  const r14 = JSON.parse(readFileSync(path.join(ROOT, 'docs/figures/r14-utility-projection.json'), 'utf8'));
  const tmp = mkdtempSync(path.join(tmpdir(), 'r15-chain-effect-'));
  const pairs = [];

  for (let index = 0; index < SEEDS.length; index += 1) {
    const seed = SEEDS[index];
    const orderedConditions = index % 2 === 0 ? CONDITIONS : [...CONDITIONS].reverse();
    const pair = {};
    for (const condition of orderedConditions) {
      const result = await runCondition({ seed, condition, index, tmp });
      pair[condition.label] = result;
      console.log(`${seed.label.padEnd(7)} ${condition.label.padEnd(12)} ${result.costYuan} yuan; ACTION_CHAIN ${result.actionChains}; Replay ${result.replay}`);
    }
    pair.deltaYuan = pair['utility-pair'].costYuan - pair['utility-base'].costYuan;
    if (R14_ANCHOR[seed.label] !== undefined) {
      for (const condition of CONDITIONS) {
        if (pair[condition.label].costYuan !== R14_ANCHOR[seed.label][condition.label] ||
            pair[condition.label].costYuan !== r14.summary[condition.label].runs.find((run) => run.seed === seed.label)?.cost) {
          throw new Error(`R14 anchor mismatch for ${seed.label}/${condition.label}`);
        }
      }
    }
    pair.seed = seed.label;
    pair.initSeed = seed.value;
    pairs.push(pair);
  }

  if (pairs.length !== 20) throw new Error(`expected 20 paired seeds, got ${pairs.length}`);
  writeReport(makeReport(pairs, {
    analysisSource: 'fresh-cli-runs',
    anchorReplication: { seeds: ['alpha', 'beta', 'gamma'], matched: true },
  }));
  console.log(`run artifacts ${tmp}`);
}

async function analyzeExisting(root) {
  const previous = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  if (!Array.isArray(previous.pairs) || previous.pairs.length !== 20) {
    throw new Error('existing R15 report must contain exactly 20 paired seeds');
  }
  const pairs = [];
  for (let index = 0; index < SEEDS.length; index += 1) {
    const seed = SEEDS[index];
    const previousPair = previous.pairs[index];
    if (previousPair.seed !== seed.label || previousPair.initSeed !== seed.value) {
      throw new Error(`existing R15 seed order mismatch at ${index}`);
    }
    const pair = {};
    for (const condition of CONDITIONS) {
      pair[condition.label] = await readExistingCondition({
        lab: path.join(root, `lab-${index}-${condition.label}`),
        seed,
        condition,
        previous: previousPair[condition.label],
      });
    }
    pair.deltaYuan = pair['utility-pair'].costYuan - pair['utility-base'].costYuan;
    if (pair.deltaYuan !== previousPair.deltaYuan) throw new Error(`existing R15 delta mismatch for ${seed.label}`);
    pair.seed = seed.label;
    pair.initSeed = seed.value;
    pairs.push(pair);
  }
  writeReport(makeReport(pairs, {
    analysisSource: 'replayed-existing-cli-ledgers',
    anchorReplication: previous.anchorReplication,
  }));
}

const analysisIndex = process.argv.indexOf('--analyze-existing');
if (analysisIndex >= 0) {
  const existingRoot = process.argv[analysisIndex + 1];
  if (existingRoot === undefined) throw new Error('--analyze-existing requires an artifact directory');
  await analyzeExisting(path.resolve(existingRoot));
} else {
  await main();
}

#!/usr/bin/env node

// 课程表 R12：链长效应——多充一放 vs pair 链 vs 无链（F-256 边界的直接检验）。
// 真实工商储能日形态：谷时 ≤3 小时充电 + 峰时 1 小时放电。pair 链（1充1放）
// 只能表达单步往返；多充链 [charge×3, discharge] 均分 0.25×4 份额。
//
// 预注册判据（实验前固定，3 seed × 3 配置 × horizon 8 × 96 步）：
// - 主判据（链长效应）：multi 均值 < pair 均值
// - 冲关判据（净套利）：multi 均值 gap < 0（低于待机基线）
// - 安全断言（无论正负）：全部 COMPLETED、链配置 ACTION_CHAIN ≥ 20、
//   全部 Replay CONSISTENT

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STEPS = 96;
const SEEDS = ['alpha', 'beta', 'gamma'];
const CONFIGS = [
  { label: 'base', flags: [] },
  { label: 'pair', flags: ['--chain-credit'] },
  { label: 'multi3', flags: ['--chain-credit', '--chain-max-charges', '3'] },
];

function runCli(args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status, stdout: result.stdout };
}

async function main() {
  const { LabStore } = await import(pathToFileURL(path.join(ROOT, 'src/runtime/lab-store.mjs')));
  const { loadKw, PRICE_LEVELS_BY_HOUR, TOU_TARIFF } = await import(pathToFileURL(path.join(ROOT, 'examples/energy/shared/energy-sim.mjs')));
  const tariffPrice = (hour) => [TOU_TARIFF.valley, TOU_TARIFF.flat, TOU_TARIFF.peak][PRICE_LEVELS_BY_HOUR[hour % 24]];

  const tmp = mkdtempSync(path.join(tmpdir(), 'r12-len-'));
  const results = [];

  for (const config of CONFIGS) {
    for (const seed of SEEDS) {
      const adapter = path.join(tmp, `adapter-${config.label}-${seed}.json`);
      writeFileSync(adapter, JSON.stringify({
        executable: process.execPath,
        args: [path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs'), ...config.flags],
        adapterId: 'ess-arbitrage-adapter-v1',
        worldId: 'ess-arbitrage',
        timeoutMs: 30000,
      }));
      const lab = path.join(tmp, `lab-${config.label}-${seed}`);
      const init = runCli(['init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', `r12-${config.label}-${seed}`, '--adapter', adapter, '--json']);
      if (init.code !== 0) throw new Error(`init ${config.label}/${seed}: ${init.stdout.slice(0, 200)}`);
      const run = runCli(['agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', String(STEPS), '--kernel-only', '--planning-horizon', '8', '--adapter', adapter, '--json']);
      if (run.code !== 0) throw new Error(`run ${config.label}/${seed}: ${run.stdout.slice(0, 300)}`);

      const initEnvelope = JSON.parse(init.stdout.trim().split(/\r?\n/u).find((line) => line.trim().length > 0));
      const powerOf = new Map(initEnvelope.data.tokenMap.entries.map((x) => [x.token, x.capabilityId]));
      const store = await LabStore.open({ labPath: lab });
      const events = (await store.readRun('r')).events.filter((event) => event.kind === 'STEP');

      let cost = 0;
      let actionChains = 0;
      let unresolved = 0;
      for (const event of events) {
        const hour = event.payload.afterState.worldState.hour - 1;
        const capabilityId = powerOf.get(event.payload.choice.token);
        const essPower = capabilityId === 'ess.charge' ? 100 : capabilityId === 'ess.discharge' ? -100 : 0;
        cost += Math.max(0, loadKw(hour) + essPower) * tariffPrice(hour);
        for (const item of event.payload.update?.settled ?? []) {
          if (item.attribution === 'ACTION_CHAIN') actionChains += 1;
          if (item.attribution === 'UNRESOLVED') unresolved += 1;
        }
      }
      const replay = runCli(['replay', '--lab', lab, '--run', 'r', '--adapter', adapter, '--json']);
      const replayEnvelope = JSON.parse(replay.stdout.trim().split(/\r?\n/u).find((line) => line.trim().length > 0));
      if (replayEnvelope.data.verdict !== 'CONSISTENT') throw new Error(`replay ${config.label}/${seed}`);

      results.push({ config: config.label, seed, cost: Math.round(cost), actionChains, unresolved });
      console.log(`${config.label.padEnd(6)} ${seed}: cost ${cost.toFixed(0)}, chains ${actionChains}, unresolved ${unresolved}, replay CONSISTENT`);
    }
  }

  let baseline = 0;
  for (let hour = 0; hour < STEPS; hour += 1) baseline += loadKw(hour) * tariffPrice(hour);
  console.log(`idle baseline: ${baseline.toFixed(0)}`);

  const summary = {};
  for (const config of CONFIGS) {
    const runs = results.filter((r) => r.config === config.label);
    const mean = runs.reduce((sum, r) => sum + r.cost, 0) / runs.length;
    const meanGapPct = +(((mean - baseline) / baseline) * 100).toFixed(2);
    summary[config.label] = { mean: Math.round(mean), meanGapPct, runs: runs.map((r) => ({ seed: r.seed, cost: r.cost, chains: r.actionChains, unresolved: r.unresolved })) };
    console.log(`  ${config.label}: mean ${mean.toFixed(0)} (gap ${meanGapPct}%)`);
  }

  // 预注册判据输出
  console.log(`[primary] multi < pair: ${summary.multi3.mean < summary.pair.mean ? 'PASS' : 'FAIL'} (${summary.multi3.mean} vs ${summary.pair.mean})`);
  console.log(`[stretch] multi gap < 0: ${summary.multi3.meanGapPct < 0 ? 'PASS' : 'FAIL'} (${summary.multi3.meanGapPct}%)`);

  writeFileSync(path.join(ROOT, 'docs/figures', 'r12-chain-length.json'), JSON.stringify({ baseline: Math.round(baseline), summary }, null, 2));
  console.log('written docs/figures/r12-chain-length.json');
}

await main();

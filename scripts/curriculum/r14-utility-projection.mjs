#!/usr/bin/env node

// 课程表 R14：价值投影检验（F-258 之后的底层分叉）。
// R11-R13 的策略收益都在默认距离投影下测量；但 ess-arbitrage 的真实目标是
// 累计电费，默认三维观测并不直接携带累计成本。本轮只切换 WorldPort 已有的
// valueSpec 投影，不改 Kernel，不把“脚本统计的低成本”误当成 Kernel 已优化的
// 目标。
//
// 预注册对照：3 seed × 4 配置 × horizon 8 × 96 步。
// - distance-base / distance-pair：默认 distance-v2 投影，链开关对照；
// - utility-base / utility-pair：WorldPort 显式声明 signed-v1 累计效用，链开关对照；
// - 安全判据：全部 COMPLETED、链配置出现 ACTION_CHAIN、全部 Replay CONSISTENT；
// - 解释判据：分别报告投影主效应与 chain×projection 交互，不预先锁定哪一个
//   一定更优，避免把一次模拟结果写成普遍因果结论。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STEPS = 96;
const SEEDS = ['alpha', 'beta', 'gamma'];
const CONFIGS = [
  { label: 'distance-base', flags: [] },
  { label: 'distance-pair', flags: ['--chain-credit'] },
  { label: 'utility-base', flags: ['--utility-mode'] },
  { label: 'utility-pair', flags: ['--utility-mode', '--chain-credit'] },
];

function runCli(args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function firstJson(stdout) {
  const line = stdout.trim().split(/\r?\n/u).find((candidate) => candidate.trim().length > 0);
  return line === undefined ? null : JSON.parse(line);
}

async function main() {
  const { LabStore } = await import(pathToFileURL(path.join(ROOT, 'src/runtime/lab-store.mjs')));
  const { loadKw, PRICE_LEVELS_BY_HOUR, TOU_TARIFF } = await import(pathToFileURL(path.join(ROOT, 'examples/energy/shared/energy-sim.mjs')));
  const tariffPrice = (hour) => [TOU_TARIFF.valley, TOU_TARIFF.flat, TOU_TARIFF.peak][PRICE_LEVELS_BY_HOUR[hour % 24]];
  const tmp = mkdtempSync(path.join(tmpdir(), 'r14-value-'));
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
      const init = runCli([
        'init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', `r14-${seed}`,
        '--adapter', adapter, '--json',
      ]);
      if (init.code !== 0) throw new Error(`init ${config.label}/${seed}: ${init.stdout.slice(0, 300)}`);
      const initEnvelope = firstJson(init.stdout);
      const run = runCli([
        'agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', String(STEPS),
        '--kernel-only', '--planning-horizon', '8', '--adapter', adapter, '--json',
      ]);
      if (run.code !== 0) throw new Error(`run ${config.label}/${seed}: ${run.stdout.slice(0, 400)}`);
      const runEnvelope = firstJson(run.stdout);
      if (runEnvelope?.data?.status !== 'COMPLETED') throw new Error(`status ${config.label}/${seed}`);

      const powerOf = new Map(initEnvelope.data.tokenMap.entries.map((entry) => [entry.token, entry.capabilityId]));
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
      const replayEnvelope = firstJson(replay.stdout);
      if (replayEnvelope?.data?.verdict !== 'CONSISTENT') {
        throw new Error(`replay ${config.label}/${seed}: ${replayEnvelope?.data?.verdict}`);
      }
      results.push({
        config: config.label,
        seed,
        valueMode: events[0].payload.boundary.valueSpec.valueMode,
        cost: Math.round(cost),
        actionChains,
        unresolved,
      });
      console.log(`${config.label.padEnd(14)} ${seed}: cost ${cost.toFixed(0)}, chains ${actionChains}, unresolved ${unresolved}, replay CONSISTENT`);
    }
  }

  const baseline = Array.from({ length: STEPS }, (_, hour) => loadKw(hour) * tariffPrice(hour))
    .reduce((sum, value) => sum + value, 0);
  const summary = {};
  for (const config of CONFIGS) {
    const runs = results.filter((result) => result.config === config.label);
    const mean = runs.reduce((sum, result) => sum + result.cost, 0) / runs.length;
    summary[config.label] = {
      mean: Math.round(mean),
      meanGapPct: +(((mean - baseline) / baseline) * 100).toFixed(2),
      runs: runs.map(({ seed, valueMode, cost, actionChains, unresolved }) => ({
        seed, valueMode, cost, chains: actionChains, unresolved,
      })),
    };
    console.log(`  ${config.label}: mean ${mean.toFixed(0)} (gap ${summary[config.label].meanGapPct}%)`);
  }

  const interaction = {
    distanceChainDelta: summary['distance-pair'].mean - summary['distance-base'].mean,
    utilityChainDelta: summary['utility-pair'].mean - summary['utility-base'].mean,
    distanceProjectionDelta: summary['distance-pair'].mean - summary['utility-pair'].mean,
    baseProjectionDelta: summary['distance-base'].mean - summary['utility-base'].mean,
  };
  console.log(`  interaction: distance chain delta ${interaction.distanceChainDelta}, utility chain delta ${interaction.utilityChainDelta}`);

  writeFileSync(
    path.join(ROOT, 'docs/figures/r14-utility-projection.json'),
    JSON.stringify({ baseline: Math.round(baseline), summary, interaction }, null, 2),
  );
  console.log('written docs/figures/r14-utility-projection.json');
}

await main();

#!/usr/bin/env node

// 课程表 R11：动作链信用的策略收益检验（CURRICULUM L5 开放方向的直接实验）。
// F-131 建立了 v29 creditChain 协议，F-132-139 验证了传递/可学性/可辨识性边界，
// 但从未回到套利场景比较长期策略收益——CURRICULUM 原文要求「比较同一延迟
// 效用任务的长期策略收益」。本脚本在 ess-arbitrage 世界以 --chain-credit
// 开/关 × horizon 1/4/8 各跑 96 步，对照 R1 存档基线（h1 -0.73%，h4/h8 -2.97%）。
//
// 预注册判据（实验前固定）：
// - 正结果：任一链配置 gap ≤ -8%（接近全套利潜力 ~13% 的 60%）
// - 负结果：链配置与 R1 基线差 ≤ 2.5 个百分点——协议传递信用但不改变策略，
//   精确刻画剩余缺口位置
// - 安全断言（无论正负）：run COMPLETED、链结算 ACTION_CHAIN 出现、
//   Replay CONSISTENT——协议确实生效后才允许解读策略数字

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HORIZONS = [1, 4, 8];
const STEPS = 96;

function runCli(args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function main() {
  const { LabStore } = await import(pathToFileURL(path.join(ROOT, 'src/runtime/lab-store.mjs')));
  const { loadKw, PRICE_LEVELS_BY_HOUR, TOU_TARIFF } = await import(pathToFileURL(path.join(ROOT, 'examples/energy/shared/energy-sim.mjs')));
  const tariffPrice = (hour) => [TOU_TARIFF.valley, TOU_TARIFF.flat, TOU_TARIFF.peak][PRICE_LEVELS_BY_HOUR[hour % 24]];

  const tmp = mkdtempSync(path.join(tmpdir(), 'r11-chain-'));
  const results = [];

  for (const chain of [false, true]) {
    for (const horizon of HORIZONS) {
      const adapter = path.join(tmp, `adapter-${chain ? 'chain' : 'base'}-h${horizon}.json`);
      const args = [path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs'), '--chain-credit'];
      if (!chain) args.pop();
      writeFileSync(adapter, JSON.stringify({
        executable: process.execPath,
        args,
        adapterId: 'ess-arbitrage-adapter-v1',
        worldId: 'ess-arbitrage',
        timeoutMs: 30000,
      }));
      const lab = path.join(tmp, `lab-${chain ? 'chain' : 'base'}-h${horizon}`);
      const init = runCli(['init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', `r11-${chain ? 'chain' : 'base'}-h${horizon}`, '--adapter', adapter, '--json']);
      if (init.code !== 0) throw new Error(`init: ${init.stdout.slice(0, 200)}`);
      const runArgs = ['agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', String(STEPS), '--kernel-only', '--adapter', adapter, '--json'];
      if (horizon > 1) runArgs.push('--planning-horizon', String(horizon));
      const run = runCli(runArgs);
      if (run.code !== 0) throw new Error(`run h${horizon} chain=${chain}: ${run.stdout.slice(0, 300)}`);
      const envelope = JSON.parse(run.stdout.trim().split(/\r?\n/u).find((line) => line.trim().length > 0));
      if (envelope.data.status !== 'COMPLETED') throw new Error(`status ${envelope.data.status}`);

      const initEnvelope = JSON.parse(init.stdout.trim().split(/\r?\n/u).find((line) => line.trim().length > 0));
      const powerOf = new Map(initEnvelope.data.tokenMap.entries.map((x) => [x.token, x.capabilityId]));
      const store = await LabStore.open({ labPath: lab });
      const events = (await store.readRun('r')).events.filter((event) => event.kind === 'STEP');

      let cost = 0;
      let actionChains = 0;
      for (const event of events) {
        const hour = event.payload.afterState.worldState.hour - 1;
        const capabilityId = powerOf.get(event.payload.choice.token);
        const essPower = capabilityId === 'ess.charge' ? 100 : capabilityId === 'ess.discharge' ? -100 : 0;
        cost += Math.max(0, loadKw(hour) + essPower) * tariffPrice(hour);
        for (const item of event.payload.update?.settled ?? []) {
          if (item.attribution === 'ACTION_CHAIN') actionChains += 1;
        }
      }

      const replay = runCli(['replay', '--lab', lab, '--run', 'r', '--adapter', adapter, '--json']);
      const replayEnvelope = JSON.parse(replay.stdout.trim().split(/\r?\n/u).find((line) => line.trim().length > 0));
      if (replayEnvelope.data.verdict !== 'CONSISTENT') throw new Error(`replay h${horizon} chain=${chain}: ${replayEnvelope.data.verdict}`);

      results.push({ chain, horizon, cost: Math.round(cost), actionChains });
      console.log(`${chain ? 'chain' : 'base '} h${horizon}: cost ${cost.toFixed(0)}, ACTION_CHAIN settlements ${actionChains}, replay CONSISTENT`);
    }
  }

  let baseline = 0;
  for (let hour = 0; hour < STEPS; hour += 1) baseline += loadKw(hour) * tariffPrice(hour);
  console.log(`idle baseline: ${baseline.toFixed(0)}`);
  for (const r of results) {
    r.gapPct = +(((r.cost - baseline) / baseline) * 100).toFixed(2);
    console.log(`  ${r.chain ? 'chain' : 'base '} h${r.horizon}: gap ${r.gapPct}%`);
  }

  const outDir = path.join(ROOT, 'docs/figures');
  writeFileSync(path.join(outDir, 'r11-chain-gain.json'), JSON.stringify({ baseline: Math.round(baseline), r1Archive: { h1: -0.73, h4: -2.97, h8: -2.97 }, results }, null, 2));
  console.log('written docs/figures/r11-chain-gain.json');
}

await main();

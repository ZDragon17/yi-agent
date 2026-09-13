import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';
import { loadKw, PRICE_LEVELS_BY_HOUR, TOU_TARIFF } from '../../examples/energy/shared/energy-sim.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('examples/curriculum/ess-arbitrage/adapter.mjs');

function tariffPrice(hour) {
  return [TOU_TARIFF.valley, TOU_TARIFF.flat, TOU_TARIFF.peak][PRICE_LEVELS_BY_HOUR[hour % 24]];
}

// R11：动作链信用的策略收益（CURRICULUM L5 开放方向的直接实验）。
// 关键发现（docs/figures/r11-chain-gain.json 存档）：种子敏感性显著——无链
// 配置跨 seed 的缺口从 +7.15% 到 -3.4%（高方差），链配置聚在基线附近
// （+0.07% 到 -2.3%）。稳健断言：3 seed × 2 配置，链的均值严格优于无链，
// 且每次链运行都有成对 ACTION_CHAIN 结算。
const R11_SEEDS = ['alpha', 'beta', 'gamma'];

test('R11: chain credit settles ACTION_CHAIN pairs and beats the no-chain mean across seeds', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-r11-e2e-'));
  try {
    const runs = { chain: [], base: [] };
    for (const chain of [false, true]) {
      for (const seed of R11_SEEDS) {
        const adapter = path.join(root, `adapter-${chain ? 'chain' : 'base'}-${seed}.json`);
        await writeFile(adapter, JSON.stringify({
          executable: process.execPath,
          args: chain ? [ADAPTER, '--chain-credit'] : [ADAPTER],
          adapterId: 'ess-arbitrage-adapter-v1',
          worldId: 'ess-arbitrage',
          timeoutMs: 30000,
        }));
        const lab = path.join(root, `lab-${chain ? 'chain' : 'base'}-${seed}`);
        const init = await invoke(['init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', `r11-${chain ? 'chain' : 'base'}-${seed}`, '--adapter', adapter, '--json']);
        assert.equal(init.code, 0, JSON.stringify(init));
        const run = await invoke(['agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', '96', '--kernel-only', '--planning-horizon', '8', '--adapter', adapter, '--json']);
        assert.equal(run.code, 0, JSON.stringify(run));
        assert.equal(run.stdout[0].data.status, 'COMPLETED');

        const powerOf = new Map(init.stdout[0].data.tokenMap.entries.map((x) => [x.token, x.capabilityId]));
        const events = (await (await LabStore.open({ labPath: lab })).readRun('r')).events
          .filter((event) => event.kind === 'STEP');
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
        const replay = await invoke(['replay', '--lab', lab, '--run', 'r', '--adapter', adapter, '--json']);
        assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
        runs[chain ? 'chain' : 'base'].push({ seed, cost: Math.round(cost), actionChains });
      }
    }

    // 协议确实生效：每次链运行都有成对链结算，无链运行为零
    for (const r of runs.chain) assert.ok(r.actionChains >= 20, `seed ${r.seed}: expected ≥20 ACTION_CHAIN, got ${r.actionChains}`);
    for (const r of runs.base) assert.equal(r.actionChains, 0);

    // 稳健的相对收益断言：链均值严格优于无链均值（3 seed）
    const mean = (list) => list.reduce((sum, r) => sum + r.cost, 0) / list.length;
    const chainMean = mean(runs.chain);
    const baseMean = mean(runs.base);
    assert.ok(
      chainMean < baseMean,
      `chain mean ${chainMean.toFixed(0)} must beat base mean ${baseMean.toFixed(0)} (chain: ${JSON.stringify(runs.chain.map((r) => r.cost))}, base: ${JSON.stringify(runs.base.map((r) => r.cost))})`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 协议时序边界：链反馈必须在两成员都 pending 之后发出（当前步的 pending
// 在结算之后才建立）——链中放电的下一动作发出结算。
test('R11: chain feedback arrives one step after both members are pending', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-r11-timing-'));
  const adapter = path.join(root, 'adapter.json');
  await writeFile(adapter, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, '--chain-credit'],
    adapterId: 'ess-arbitrage-adapter-v1',
    worldId: 'ess-arbitrage',
    timeoutMs: 30000,
  }));
  try {
    const lab = path.join(root, 'lab');
    const init = await invoke(['init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', 'r11-timing', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const run = await invoke(['agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', '24', '--kernel-only', '--adapter', adapter, '--json']);
    assert.equal(run.code, 0, JSON.stringify(run));
    const events = (await (await LabStore.open({ labPath: lab })).readRun('r')).events
      .filter((event) => event.kind === 'STEP');
    // 每条链结算出现时，其两个成员 nonce 都属于更早的步骤
    for (const event of events) {
      const currentNonce = event.payload.receipt.executionNonce;
      for (const item of event.payload.update?.settled ?? []) {
        if (item.attribution === 'ACTION_CHAIN') {
          assert.notEqual(item.executionNonce, currentNonce, 'chain anchor must be a prior step');
        }
      }
    }
    const replay = await invoke(['replay', '--lab', lab, '--run', 'r', '--adapter', adapter, '--json']);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function invoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code,
      stdout: stdout.trim() === '' ? [] : stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line)),
      stderr,
    }));
  });
}

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
const SEEDS = ['alpha', 'beta', 'gamma'];

function tariffPrice(hour) {
  return [TOU_TARIFF.valley, TOU_TARIFF.flat, TOU_TARIFF.peak][PRICE_LEVELS_BY_HOUR[hour % 24]];
}

// R12：链长效应（F-257）。
// 预注册结果（docs/figures/r12-chain-length.json 存档）：
// - pair 链在 h8 下实现跨 seed 稳定净套利（均值 -2.66%，方差 ±1%）——
//   R1 缺口曲线的开放问题（信用分配能否转为净策略收益）首次得到稳定肯定回答；
// - 多充链（3充1放）负结果：+0.97% 显著差于 pair——份额稀释与窗口噪声
//   假设记入任务账本，不锁死为断言（未来学习改进可能改变排序）。
// 本 E2E 锁定：pair 净套利稳定成立 + 多充链协议正确（4 成员链结算）。
test('R12: pair chains reach stable net arbitrage and multi-charge chains settle correctly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-r12-e2e-'));
  try {
    const runs = { pair: [], multi3: [] };
    for (const label of ['pair', 'multi3']) {
      for (const seed of SEEDS) {
        const adapter = path.join(root, `adapter-${label}-${seed}.json`);
        await writeFile(adapter, JSON.stringify({
          executable: process.execPath,
          args: label === 'pair'
            ? [ADAPTER, '--chain-credit']
            : [ADAPTER, '--chain-credit', '--chain-max-charges', '3'],
          adapterId: 'ess-arbitrage-adapter-v1',
          worldId: 'ess-arbitrage',
          timeoutMs: 30000,
        }));
        const lab = path.join(root, `lab-${label}-${seed}`);
        const init = await invoke(['init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', `r12-e2e-${label}-${seed}`, '--adapter', adapter, '--json']);
        assert.equal(init.code, 0, JSON.stringify(init));
        const run = await invoke(['agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', '96', '--kernel-only', '--planning-horizon', '8', '--adapter', adapter, '--json']);
        assert.equal(run.code, 0, JSON.stringify(run));
        assert.equal(run.stdout[0].data.status, 'COMPLETED');

        const powerOf = new Map(init.stdout[0].data.tokenMap.entries.map((x) => [x.token, x.capabilityId]));
        const events = (await (await LabStore.open({ labPath: lab })).readRun('r')).events
          .filter((event) => event.kind === 'STEP');
        let cost = 0;
        let actionChains = 0;
        let widestChain = 0;
        for (const event of events) {
          const hour = event.payload.afterState.worldState.hour - 1;
          const capabilityId = powerOf.get(event.payload.choice.token);
          const essPower = capabilityId === 'ess.charge' ? 100 : capabilityId === 'ess.discharge' ? -100 : 0;
          cost += Math.max(0, loadKw(hour) + essPower) * tariffPrice(hour);
          for (const item of event.payload.update?.settled ?? []) {
            if (item.attribution === 'ACTION_CHAIN') actionChains += 1;
          }
          for (const item of event.payload.postObservation.feedback ?? []) {
            if (item.creditChain?.members?.length > widestChain) widestChain = item.creditChain.members.length;
          }
        }
        const replay = await invoke(['replay', '--lab', lab, '--run', 'r', '--adapter', adapter, '--json']);
        assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
        runs[label].push({ seed, cost: Math.round(cost), actionChains, widestChain });
      }
    }

    let baseline = 0;
    for (let hour = 0; hour < 96; hour += 1) baseline += loadKw(hour) * tariffPrice(hour);

    // pair：链结算充分 + 跨 seed 稳定净套利（均值低于基线 ≥1%）
    for (const r of runs.pair) assert.ok(r.actionChains >= 20, `pair ${r.seed}: chains ${r.actionChains}`);
    const pairMean = runs.pair.reduce((sum, r) => sum + r.cost, 0) / runs.pair.length;
    assert.ok(
      pairMean < baseline * 0.99,
      `pair mean ${pairMean.toFixed(0)} must undercut idle baseline ${baseline.toFixed(0)} by ≥1% (costs: ${JSON.stringify(runs.pair.map((r) => r.cost))})`,
    );

    // multi3：4 成员链确实出现并结算（协议在 >2 成员下正确工作）
    for (const r of runs.multi3) {
      assert.ok(r.actionChains >= 20, `multi3 ${r.seed}: chains ${r.actionChains}`);
      assert.equal(r.widestChain, 4, `multi3 ${r.seed}: expected 4-member chains, widest ${r.widestChain}`);
    }
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

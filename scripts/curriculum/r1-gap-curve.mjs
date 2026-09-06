#!/usr/bin/env node

// 课程表 R1：跨步信用分配缺口的定量基线曲线。
// 在 ess-arbitrage 世界以 horizon 1/2/3/4/6/8 六配置各跑 96 步，
// 记录每配置的总电费与待机基线的相对缺口，渲染缺口曲线 SVG。
// 无底座变更——这是 L5 演化前的基线存档。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HORIZONS = [1, 2, 3, 4, 6, 8];
const STEPS = 96;

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function main() {
  const { LabStore } = await import(pathToFileURL(path.join(ROOT, 'src/runtime/lab-store.mjs')));
  const { loadKw, PRICE_LEVELS_BY_HOUR, TOU_TARIFF } = await import(pathToFileURL(path.join(ROOT, 'examples/energy/shared/energy-sim.mjs')));
  const tariffPrice = (hour) => [TOU_TARIFF.valley, TOU_TARIFF.flat, TOU_TARIFF.peak][PRICE_LEVELS_BY_HOUR[hour % 24]];

  const tmp = mkdtempSync(path.join(tmpdir(), 'r1-gap-'));
  const adapter = path.join(tmp, 'adapter.json');
  writeFileSync(adapter, JSON.stringify({
    executable: process.execPath,
    args: [path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs')],
    adapterId: 'ess-arbitrage-adapter-v1',
    worldId: 'ess-arbitrage',
    timeoutMs: 30000,
  }));

  let baseline = 0;
  for (let hour = 0; hour < STEPS; hour += 1) baseline += loadKw(hour) * tariffPrice(hour);

  const results = [];
  for (const horizon of HORIZONS) {
    const lab = path.join(tmp, `lab-h${horizon}`);
    const init = runCli(['init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', `r1-h${horizon}`, '--adapter', adapter, '--json']);
    if (init.code !== 0) throw new Error(`init h${horizon}: ${init.stdout.slice(0, 200)}`);
    const args = ['agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', String(STEPS), '--kernel-only', '--adapter', adapter, '--json'];
    if (horizon > 1) args.push('--planning-horizon', String(horizon));
    const r = runCli(args);
    if (r.code !== 0) throw new Error(`run h${horizon}: ${r.stdout.slice(0, 300)}`);
    const store = await LabStore.open({ labPath: lab });
    const events = (await store.readRun('r')).events.filter((event) => event.kind === 'STEP');
    const initEnvelope = JSON.parse(init.stdout.trim().split(/\r?\n/u).find((line) => line.trim().length > 0));
    const powerOf = new Map(initEnvelope.data.tokenMap.entries.map((x) => [x.token, x.capabilityId]));
    let cost = 0;
    for (const event of events) {
      const hour = event.payload.afterState.worldState.hour - 1;
      const capabilityId = powerOf.get(event.payload.choice.token);
      const essPower = capabilityId === 'ess.charge' ? 100 : capabilityId === 'ess.discharge' ? -100 : 0;
      cost += Math.max(0, loadKw(hour) + essPower) * tariffPrice(hour);
    }
    const gap = (cost - baseline) / baseline;
    results.push({ horizon, cost: Math.round(cost), gapPct: +(gap * 100).toFixed(2) });
    console.log(`horizon ${horizon}: cost ${cost.toFixed(0)} 元, gap ${(gap * 100).toFixed(2)}% vs baseline ${baseline.toFixed(0)} 元`);
  }

  // 渲染缺口曲线 SVG
  const points = results.map((r) => ({ x: r.horizon, y: r.gapPct }));
  const W = 920; const H = 420;
  const m = { top: 46, right: 24, bottom: 58, left: 78 };
  const w = W - m.left - m.right; const h = H - m.top - m.bottom;
  const lo = Math.min(-10, ...points.map((p) => p.y)) - 2;
  const hi = Math.max(10, ...points.map((p) => p.y)) + 2;
  const X = (x) => m.left + ((x - 0.5) / (HORIZONS.at(-1) + 0.5 - 0.5)) * w;
  const Y = (y) => m.top + h - ((y - lo) / (hi - lo)) * h;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica,Arial,sans-serif">`;
  svg += `<rect width="${W}" height="${H}" fill="white"/>`;
  svg += `<text x="${W / 2}" y="24" text-anchor="middle" font-size="17" font-weight="bold">R1  Cross-period arbitrage gap vs planning horizon (96 steps, ess-arbitrage)</text>`;
  for (let i = 0; i <= 6; i += 1) {
    const y = lo + ((hi - lo) * i) / 6;
    svg += `<line x1="${m.left}" y1="${Y(y)}" x2="${m.left + w}" y2="${Y(y)}" stroke="#e5e5e5"/>`;
    svg += `<text x="${m.left - 8}" y="${Y(y) + 4}" text-anchor="end" font-size="11" fill="#555">${y.toFixed(1)}%</text>`;
  }
  for (const hz of HORIZONS) {
    svg += `<text x="${X(hz)}" y="${m.top + h + 18}" text-anchor="middle" font-size="11" fill="#555">h=${hz}</text>`;
  }
  svg += `<line x1="${m.left}" y1="${Y(0)}" x2="${m.left + w}" y2="${Y(0)}" stroke="#d1242f" stroke-dasharray="6 4"/>`;
  svg += `<text x="${m.left + w - 4}" y="${Y(0) - 6}" text-anchor="end" font-size="11" fill="#d1242f">idle baseline (0% gap)</text>`;
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.horizon).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  svg += `<path d="${d}" fill="none" stroke="#1f6feb" stroke-width="2"/>`;
  for (const p of points) {
    svg += `<circle cx="${X(p.horizon)}" cy="${Y(p.y)}" r="4" fill="#1f6feb"/>`;
    svg += `<text x="${X(p.horizon)}" y="${Y(p.y) - 10}" text-anchor="middle" font-size="11" fill="#1f6feb">${p.gapPct}%</text>`;
  }
  svg += `<text x="${m.left + w / 2}" y="${H - 12}" text-anchor="middle" font-size="12" fill="#333">planning horizon (steps)</text>`;
  svg += `<text x="16" y="${m.top + h / 2}" text-anchor="middle" font-size="12" fill="#333" transform="rotate(-90 16 ${m.top + h / 2})">cost gap vs idle baseline (%)</text>`;
  svg += '</svg>';

  const outDir = path.join(ROOT, 'docs', 'figures');
  writeFileSync(path.join(outDir, 'fig9-r1-gap-curve.svg'), svg);
  writeFileSync(path.join(outDir, 'r1-gap-curve.json'), JSON.stringify({ baseline: Math.round(baseline), results }, null, 2));
  console.log('written docs/figures/fig9-r1-gap-curve.svg');
}

await main();

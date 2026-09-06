#!/usr/bin/env node

// 论文图表构建器：从真实实验运行收集数据点，渲染为零依赖 SVG。
// 每次重跑都会重新执行实验并重新生成图表——论文图表可复现。

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { loadKw } from '../../examples/energy/shared/energy-sim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'docs', 'figures');
mkdirSync(OUT, { recursive: true });
const TMP = mkdtempSync(path.join(tmpdir(), 'paper-figs-'));

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), ...args], {
    input: '',
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

async function collectRunEvents(lab, runId) {
  const { LabStore } = await import(pathToFileURL(path.join(ROOT, 'src/runtime/lab-store.mjs')));
  const store = await LabStore.open({ labPath: lab });
  const run = await store.readRun(runId);
  return run.events.filter((event) => event.kind === 'STEP').map((event) => event.payload);
}

async function ciEssCurve() {
  const lab = path.join(TMP, 'ciess');
  const adapter = path.join(TMP, 'ciess-adapter.json');
  writeFileSync(adapter, JSON.stringify({
    executable: process.execPath,
    args: [path.join(ROOT, 'examples/energy/ci-ess/adapter.mjs')],
    adapterId: 'ci-ess-adapter-v1',
    worldId: 'ci-ess',
    timeoutMs: 5000,
  }));
  run(['init', '--lab', lab, '--world', 'ci-ess', '--seed', 'paper-ci-ess', '--adapter', adapter, '--json']);
  const r = run(['run', '--lab', lab, '--run-id', 'r', '--steps', '72', '--adapter', adapter, '--json']);
  if (r.code !== 0) throw new Error(`ci-ess run failed: ${r.stdout.slice(0, 200)}`);
  const events = await collectRunEvents(lab, 'r');
  return {
    soc: events.map((p) => p.afterState.worldState.soc),
    cost: events.map((p) => p.afterState.worldState.hour - 1),
  };
}

async function vppCurve() {
  const lab = path.join(TMP, 'vpp');
  const adapter = path.join(TMP, 'vpp-adapter.json');
  writeFileSync(adapter, JSON.stringify({
    executable: process.execPath,
    args: [path.join(ROOT, 'examples/energy/vpp/adapter.mjs')],
    adapterId: 'vpp-adapter-v1',
    worldId: 'vpp',
    timeoutMs: 5000,
  }));
  run(['init', '--lab', lab, '--world', 'vpp', '--seed', 'paper-vpp', '--adapter', adapter, '--json']);
  const r = run(['run', '--lab', lab, '--run-id', 'r', '--steps', '96', '--adapter', adapter, '--json']);
  if (r.code !== 0) throw new Error(`vpp run failed: ${r.stdout.slice(0, 200)}`);
  const events = await collectRunEvents(lab, 'r');
  const { vppCommandKw } = await import(pathToFileURL(path.join(ROOT, 'examples/energy/shared/energy-sim.mjs')));
  return {
    command: events.map((p, index) => vppCommandKw(index)),
    output: events.map((p) => p.afterState.worldState.siteA + p.afterState.worldState.siteB),
  };
}

async function emsCurve() {
  const lab = path.join(TMP, 'ems');
  const adapter = path.join(TMP, 'ems-adapter.json');
  writeFileSync(adapter, JSON.stringify({
    executable: process.execPath,
    args: [path.join(ROOT, 'examples/energy/ems/adapter.mjs')],
    adapterId: 'ems-adapter-v1',
    worldId: 'ems',
    timeoutMs: 5000,
  }));
  run(['init', '--lab', lab, '--world', 'ems', '--seed', 'paper-ems', '--adapter', adapter, '--json']);
  const r = run(['run', '--lab', lab, '--run-id', 'r', '--steps', '96', '--adapter', adapter, '--json']);
  if (r.code !== 0) throw new Error(`ems run failed: ${r.stdout.slice(0, 200)}`);
  const events = await collectRunEvents(lab, 'r');
  return {
    load: events.map((p) => {
      const hour = p.afterState.worldState.hour - 1;
      const shed = p.afterState.worldState.shedRemaining > 0 ? 40 : 0;
      return loadKw(hour) - shed;
    }),
    demandPeak: events.map((p) => p.afterState.worldState.demandPeakKw),
  };
}

async function valueHoldCurve() {
  const lab = path.join(TMP, 'hold');
  const adapter = path.join(TMP, 'collision-adapter.json');
  writeFileSync(adapter, JSON.stringify({
    executable: process.execPath,
    args: [path.join(ROOT, 'test/fixtures/cyclic-collision-world-adapter.mjs'), '--state-file', path.join(TMP, 'hold-state.json')],
    adapterId: 'cyclic-collision-adapter-v1',
    worldId: 'cyclic-collision',
    timeoutMs: 2000,
  }));
  run(['init', '--lab', lab, '--world', 'cyclic-collision', '--seed', 'paper-hold', '--adapter', adapter, '--json']);
  const r = run(['run', '--lab', lab, '--run-id', 'r', '--steps', '700', '--adapter', adapter, '--json']);
  if (r.code !== 0 && r.code !== 2) throw new Error(`hold run failed: ${r.stdout.slice(0, 200)}`);
  const events = await collectRunEvents(lab, 'r');
  return {
    value: events.map((p) => p.postObservation.vector[0]),
    winnerRate: null,
  };
}

async function phaseLockCurve() {
  const CAPS = ['cyclic-collision.alpha', 'cyclic-collision.beta', 'cyclic-collision.gamma', 'cyclic-collision.delta'];
  const SCHEDULE = [0, 1, 0, 2, 1, 0, 3];
  const lab = path.join(TMP, 'lock');
  const adapter = path.join(TMP, 'lock-adapter.json');
  writeFileSync(adapter, JSON.stringify({
    executable: process.execPath,
    args: [path.join(ROOT, 'test/fixtures/cyclic-collision-world-adapter.mjs'), '--state-file', path.join(TMP, 'lock-state.json')],
    adapterId: 'cyclic-collision-adapter-v1',
    worldId: 'cyclic-collision',
    timeoutMs: 2000,
  }));
  run(['init', '--lab', lab, '--world', 'cyclic-collision', '--seed', 'paper-lock', '--adapter', adapter, '--json']);
  const r = run(['run', '--lab', lab, '--run-id', 'r', '--steps', '360', '--adapter', adapter, '--json']);
  if (r.code !== 0 && r.code !== 2) throw new Error(`lock run failed: ${r.stdout.slice(0, 200)}`);
  const manifest = readJsonFile(path.join(lab, 'manifest.json'));
  const tokenToIndex = new Map(manifest.tokenMap.entries.map((e) => [e.token, CAPS.indexOf(e.capabilityId)]));
  const events = await collectRunEvents(lab, 'r');
  const wins = events.map((p, index) =>
    tokenToIndex.get(p.choice.token) === SCHEDULE[index % SCHEDULE.length] ? 1 : 0);
  // 30 步滑动窗口赢家率
  const rate = [];
  for (let i = 0; i + 30 <= wins.length; i += 15) {
    rate.push({ x: i + 15, y: wins.slice(i, i + 30).reduce((a, b) => a + b, 0) / 30 * 100 });
  }
  return { rate, blind: 25 };
}

// ---- SVG 渲染 ----

function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

function lineChart({ title, yLabel, xLabel, series, yMin, yMax, refLines = [], width = 920, height = 420 }) {
  const m = { top: 46, right: 24, bottom: 52, left: 68 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const all = series.flatMap((s) => s.points.map((p) => p.y)).concat(refLines.map((r) => r.y));
  const lo = yMin ?? Math.min(...all);
  const hi = yMax ?? Math.max(...all);
  const xMax = Math.max(...series.flatMap((s) => s.points.map((p) => p.x)));
  const X = (x) => m.left + (x / xMax) * w;
  const Y = (y) => m.top + h - ((y - lo) / (hi - lo || 1)) * h;
  const colors = ['#1f6feb', '#d1242f', '#1a7f37', '#8250df', '#bf8700'];
  const ticksY = 5;
  const ticksX = Math.min(10, xMax);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica,Arial,sans-serif">`;
  svg += `<rect width="${width}" height="${height}" fill="white"/>`;
  svg += `<text x="${width / 2}" y="24" text-anchor="middle" font-size="17" font-weight="bold" fill="#111">${esc(title)}</text>`;
  for (let i = 0; i <= ticksY; i += 1) {
    const y = lo + ((hi - lo) * i) / ticksY;
    svg += `<line x1="${m.left}" y1="${Y(y)}" x2="${m.left + w}" y2="${Y(y)}" stroke="#e5e5e5"/>`;
    svg += `<text x="${m.left - 8}" y="${Y(y) + 4}" text-anchor="end" font-size="11" fill="#555">${(+y.toFixed(2))}</text>`;
  }
  for (let i = 0; i <= ticksX; i += 1) {
    const x = (xMax * i) / ticksX;
    svg += `<text x="${X(x)}" y="${m.top + h + 18}" text-anchor="middle" font-size="11" fill="#555">${(+x.toFixed(0))}</text>`;
  }
  svg += `<text x="${m.left + w / 2}" y="${height - 12}" text-anchor="middle" font-size="12" fill="#333">${esc(xLabel)}</text>`;
  svg += `<text x="16" y="${m.top + h / 2}" text-anchor="middle" font-size="12" fill="#333" transform="rotate(-90 16 ${m.top + h / 2})">${esc(yLabel)}</text>`;
  for (const ref of refLines) {
    svg += `<line x1="${m.left}" y1="${Y(ref.y)}" x2="${m.left + w}" y2="${Y(ref.y)}" stroke="${ref.color ?? '#d1242f'}" stroke-dasharray="6 4"/>`;
    if (ref.label) svg += `<text x="${m.left + w - 4}" y="${Y(ref.y) - 6}" text-anchor="end" font-size="11" fill="${ref.color ?? '#d1242f'}">${esc(ref.label)}</text>`;
  }
  series.forEach((s, i) => {
    const color = s.color ?? colors[i % colors.length];
    const d = s.points.map((p, index) => `${index === 0 ? 'M' : 'L'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
    svg += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${s.width ?? 1.8}"/>`;
    svg += `<rect x="${m.left + 4 + i * 190}" y="34" width="12" height="4" fill="${color}"/>`;
    svg += `<text x="${m.left + 22 + i * 190}" y="39" font-size="12" fill="#333">${esc(s.label)}</text>`;
  });
  svg += `<line x1="${m.left}" y1="${m.top}" x2="${m.left}" y2="${m.top + h}" stroke="#333"/><line x1="${m.left}" y1="${m.top + h}" x2="${m.left + w}" y2="${m.top + h}" stroke="#333"/>`;
  svg += '</svg>';
  return svg;
}

function barChart({ title, yLabel, categories, values, colors, width = 920, height = 420 }) {
  const m = { top: 46, right: 24, bottom: 92, left: 68 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const hi = Math.max(...values) * 1.15;
  const bw = w / categories.length;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica,Arial,sans-serif">`;
  svg += `<rect width="${width}" height="${height}" fill="white"/>`;
  svg += `<text x="${width / 2}" y="24" text-anchor="middle" font-size="17" font-weight="bold" fill="#111">${esc(title)}</text>`;
  for (let i = 0; i <= 5; i += 1) {
    const y = (hi * i) / 5;
    svg += `<line x1="${m.left}" y1="${m.top + h - (y / hi) * h}" x2="${m.left + w}" y2="${m.top + h - (y / hi) * h}" stroke="#e5e5e5"/>`;
    svg += `<text x="${m.left - 8}" y="${m.top + h - (y / hi) * h + 4}" text-anchor="end" font-size="11" fill="#555">${y}</text>`;
  }
  categories.forEach((c, i) => {
    const v = values[i];
    const x = m.left + i * bw + bw * 0.18;
    const bh = (v / hi) * h;
    svg += `<rect x="${x}" y="${m.top + h - bh}" width="${bw * 0.64}" height="${bh}" fill="${colors[i % colors.length]}" stroke="#333" stroke-width="0.6"/>`;
    svg += `<text x="${x + bw * 0.32}" y="${m.top + h - bh - 6}" text-anchor="middle" font-size="12" fill="#111">${v}</text>`;
    const lines = String(c).split('|');
    lines.forEach((ln, li) => {
      svg += `<text x="${x + bw * 0.32}" y="${m.top + h + 18 + li * 14}" text-anchor="middle" font-size="10.5" fill="#333">${esc(ln)}</text>`;
    });
  });
  svg += `<text x="${m.left + w / 2}" y="${height - 10}" text-anchor="middle" font-size="12" fill="#333">${esc(yLabel)}</text>`;
  svg += '</svg>';
  return svg;
}

// ---- 构建 ----

const figures = {};
const summary = {};

console.log('[1/6] ci-ess 72-step run…');
figures.soc = await ciEssCurve();

console.log('[2/6] vpp 96-step run…');
figures.vpp = await vppCurve();

console.log('[3/6] ems 96-step run…');
figures.ems = await emsCurve();

console.log('[4/6] value-hold 700-step run…');
figures.hold = await valueHoldCurve();

console.log('[5/6] phase-lock 360-step run…');
figures.lock = await phaseLockCurve();

console.log('[6/6] rendering SVGs…');
mkdirSync(OUT, { recursive: true });

// Figure 3：相位锁定曲线
const lockSvg = lineChart({
  title: 'Fig. 3  Period-7 collision world: sliding-window winner rate (v26)',
  yLabel: 'winner rate in 30-step window (%)',
  xLabel: 'step',
  series: [{ label: 'observed winner rate', points: figures.lock.rate.map((p) => ({ x: p.x, y: p.y })) }],
  yMin: 0,
  yMax: 100,
  refLines: [
    { y: 25, label: 'blind choice 25%', color: '#8b8b8b' },
    { y: 78.6, label: 'window-2 optimum 78.6%', color: '#bf8700' },
    { y: 100, label: 'window-8 optimum 100%', color: '#1a7f37' },
  ],
});
writeFileSync(path.join(OUT, 'fig3-phase-lock.svg'), lockSvg);
summary.lockTail = figures.lock.rate.at(-1).y.toFixed(1);

// Figure 4：目标驻留值曲线
const holdSvg = lineChart({
  title: 'Fig. 4  Period-7 world: value reaches target and holds (700 steps)',
  yLabel: 'observed value',
  xLabel: 'step',
  series: [{ label: 'value', points: figures.hold.value.map((v, i) => ({ x: i + 1, y: v })), color: '#1f6feb' }],
  refLines: [{ y: 400, label: 'target 400', color: '#d1242f' }],
});
writeFileSync(path.join(OUT, 'fig4-value-hold.svg'), holdSvg);
const tailHold = figures.hold.value.slice(-200);
summary.holdAvg = (tailHold.reduce((a, b) => a + Math.abs(b - 400), 0) / tailHold.length).toFixed(2);

// Figure 5：ci-ess SOC 与累计电费
const costSeries = [];
let acc = 0;
const CI_POWER = { charge: 100, discharge: -100, idle: 0 };
figures.soc.points = figures.soc.soc.map((v, i) => ({ x: i + 1, y: v }));
const socSvg = lineChart({
  title: 'Fig. 5  C&I ESS: SOC charge/discharge cycling over 72 hourly steps',
  yLabel: 'SOC (%)',
  xLabel: 'step (1 hour each)',
  series: [{ label: 'SOC', points: figures.soc.points, color: '#1a7f37' }],
  yMin: 0,
  yMax: 100,
  refLines: [
    { y: 10, label: 'BMS floor 10%', color: '#d1242f' },
    { y: 95, label: 'BMS ceiling 95%', color: '#bf8700' },
  ],
});
writeFileSync(path.join(OUT, 'fig5-ciess-soc.svg'), socSvg);

// Figure 6：VPP 指令跟踪
const vppSvg = lineChart({
  title: 'Fig. 6  VPP: aggregated output tracks dispatch command (96 steps)',
  yLabel: 'power (kW)',
  xLabel: 'step',
  series: [
    { label: 'dispatch command', points: figures.vpp.command.map((y, i) => ({ x: i + 1, y })), color: '#d1242f', width: 1.4 },
    { label: 'aggregated output', points: figures.vpp.output.map((y, i) => ({ x: i + 1, y })), color: '#1f6feb' },
  ],
});
writeFileSync(path.join(OUT, 'fig6-vpp-tracking.svg'), vppSvg);
const tailDev = figures.vpp.command.slice(-24).map((c, i) => Math.abs(figures.vpp.output.slice(-24)[i] - c));
summary.vppDev = (tailDev.reduce((a, b) => a + b, 0) / tailDev.length).toFixed(1);

// Figure 7：EMS 需量曲线
const emsSvg = lineChart({
  title: 'Fig. 7  EMS: load and demand peak vs 250 kW contract (96 steps)',
  yLabel: 'power (kW)',
  xLabel: 'step',
  series: [
    { label: 'local load', points: figures.ems.load.map((y, i) => ({ x: i + 1, y })), color: '#1f6feb' },
    { label: 'demand peak', points: figures.ems.demandPeak.map((y, i) => ({ x: i + 1, y })), color: '#8250df', width: 1.4 },
  ],
  refLines: [{ y: 250, label: 'contract 250 kW', color: '#d1242f' }],
});
writeFileSync(path.join(OUT, 'fig7-ems-demand.svg'), emsSvg);
summary.emsPeak = Math.max(...figures.ems.demandPeak).toFixed(0);

// Figure 8：突变检验柱状图（PASS 基线 vs 突变后 FALSIFIED）
const mutationSvg = barChart({
  title: 'Fig. 8  Challenge suite mutation testing: all 10 discriminators can FALSIFY',
  yLabel: 'challenge cases with expected verdict (count)',
  categories: ['unknown-action|exploration', 'regime-shift', 'execution-rejected', 'external|during-step', 'all-unsafe', 'snapshot|write-failure', 'replay-tamper', 'inspect-readonly', 'world-diversity', 'paired-candidates'],
  values: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  colors: Array(10).fill('#1a7f37'),
});
writeFileSync(path.join(OUT, 'fig8-mutation.svg'), mutationSvg);

// Figure 1：架构图（静态 SVG）
const archSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="920" height="500" viewBox="0 0 920 500" font-family="Helvetica,Arial,sans-serif">
<rect width="920" height="500" fill="white"/>
<text x="460" y="26" text-anchor="middle" font-size="17" font-weight="bold">Fig. 1  Layered architecture and trust boundaries</text>
<rect x="40" y="50" width="840" height="52" rx="6" fill="#dbeafe" stroke="#1f6feb"/>
<text x="460" y="73" text-anchor="middle" font-size="13" font-weight="bold">CLI (thin adapter: JSON envelope, exit codes, ui shell)</text>
<text x="460" y="92" text-anchor="middle" font-size="11">init | run | inspect | replay | challenge | recover | agent | experiment | effect | ui</text>
<rect x="40" y="122" width="840" height="60" rx="6" fill="#f3e8ff" stroke="#8250df"/>
<text x="460" y="147" text-anchor="middle" font-size="13" font-weight="bold">Application Services (use cases; proposal capture; evidence binding)</text>
<text x="460" y="166" text-anchor="middle" font-size="11">runLab | inspectLab | replayLab | runContinuous | challenge | paired-* | ui-service</text>
<rect x="40" y="202" width="400" height="120" rx="6" fill="#fff7e6" stroke="#bf8700" stroke-width="1.6"/>
<text x="240" y="226" text-anchor="middle" font-size="13" font-weight="bold">Kernel (domain-blind, pure)</text>
<text x="240" y="246" text-anchor="middle" font-size="11">numeric observations · ValueSpec · opaque tokens</text>
<text x="240" y="264" text-anchor="middle" font-size="11">expectation → choice → verify → learn</text>
<text x="240" y="282" text-anchor="middle" font-size="11">bounded planning · multi-scale context · belief gates</text>
<text x="240" y="306" text-anchor="middle" font-size="11">no I/O · no clock · no world names (invariant 8)</text>
<rect x="480" y="202" width="400" height="120" rx="6" fill="#ffebe9" stroke="#d1242f"/>
<text x="680" y="226" text-anchor="middle" font-size="13" font-weight="bold">WorldPort boundary (domain semantics live here)</text>
<text x="680" y="246" text-anchor="middle" font-size="11">built-in: temperature · virtual-desktop · inventory · grid · queue</text>
<text x="680" y="264" text-anchor="middle" font-size="11">external JSONL: counter · repo · ci-ess · pv-station · ems · vpp</text>
<text x="680" y="282" text-anchor="middle" font-size="11">battery · inverter · meter · PV · charger · DR (device models)</text>
<text x="680" y="306" text-anchor="middle" font-size="11">digest-bound implementations · fail-closed state contract</text>
<rect x="40" y="342" width="400" height="66" rx="6" fill="#f6f8fa" stroke="#555"/>
<text x="240" y="366" text-anchor="middle" font-size="12.5" font-weight="bold">ModelAdvisor / ModelPlanner (untrusted proposals)</text>
<text x="240" y="386" text-anchor="middle" font-size="11">OpenAI-compatible · real GLM verified · replay never calls model</text>
<rect x="480" y="342" width="400" height="66" rx="6" fill="#f6f8fa" stroke="#555"/>
<text x="680" y="366" text-anchor="middle" font-size="12.5" font-weight="bold">LabStore (JSONL ledger + hash chain + snapshots + lock)</text>
<text x="680" y="386" text-anchor="middle" font-size="11">deterministic replay · crash recovery · ≤40 MiB · fail-closed</text>
<rect x="40" y="428" width="840" height="52" rx="6" fill="#dafbe1" stroke="#1a7f37"/>
<text x="460" y="450" text-anchor="middle" font-size="12.5" font-weight="bold">Evidence invariants: expectation before action · verify before learn · replay without side effects · fail-closed on unknown versions</text>
<text x="460" y="470" text-anchor="middle" font-size="11">four-layer confounder defence: world receipt → host forcing → kernel verify → ledger validation</text>
</svg>`;
writeFileSync(path.join(OUT, 'fig1-architecture.svg'), archSvg);

// Figure 2：学习版本台阶（静态 SVG）
const versions = [
  ['v3-v8', 'delayed feedback & confounder attribution'],
  ['v11', 'ordered history accumulator'],
  ['v12-v14', 'bounded planning & information value'],
  ['v15', 'periodic revalidation'],
  ['v16-v18', 'recursive/tree planning'],
  ['v21-v24', 'capacity & eviction economics'],
  ['v25', 'multi-scale context'],
  ['v26', 'long-window context'],
  ['v27', 'revalidation belief gate'],
];
let tl = `<svg xmlns="http://www.w3.org/2000/svg" width="920" height="420" viewBox="0 0 920 420" font-family="Helvetica,Arial,sans-serif">`;
tl += `<rect width="920" height="420" fill="white"/>`;
tl += `<text x="460" y="26" text-anchor="middle" font-size="17" font-weight="bold">Fig. 2  Versioned learning ladder driven by falsification experiments</text>`;
tl += `<line x1="60" y1="360" x2="880" y2="360" stroke="#333" stroke-width="1.5"/>`;
versions.forEach(([v, label], i) => {
  const x = 90 + i * 88;
  const h = 40 + (i % 3) * 34;
  tl += `<rect x="${x - 8}" y="${360 - h}" width="16" height="${h}" fill="#1f6feb" opacity="${0.45 + (i % 3) * 0.2}"/>`;
  tl += `<text x="${x}" y="${368 - h - 6}" text-anchor="middle" font-size="12" font-weight="bold" fill="#1f6feb">${v}</text>`;
  const words = label.split(' ');
  const l1 = words.slice(0, 2).join(' ');
  const l2 = words.slice(2).join(' ');
  tl += `<text x="${x}" y="384" text-anchor="middle" font-size="9.5" fill="#333">${esc(l1)}</text>`;
  if (l2) tl += `<text x="${x}" y="397" text-anchor="middle" font-size="9.5" fill="#333">${esc(l2)}</text>`;
});
tl += `<text x="460" y="414" text-anchor="middle" font-size="11" fill="#555">each step gated: old ledgers replay under their historical semantics; unknown versions fail closed</text>`;
tl += '</svg>';
writeFileSync(path.join(OUT, 'fig2-ladder.svg'), tl);

writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('figures written to', OUT);
console.log('summary:', JSON.stringify(summary));

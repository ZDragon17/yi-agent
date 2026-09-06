import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';
import { PRICE_LEVELS_BY_HOUR, TOU_TARIFF } from '../../examples/energy/shared/energy-sim.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('examples/curriculum/ess-arbitrage/adapter.mjs');

// ---- R9：非平稳叠加——mid-run 电价表翻转 + 全部既有难度 ----
test('R9: mid-run tariff regime flip is captured by observations without breaking the loop', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-r9-regime-'));
  const lab = path.join(root, 'lab');
  const adapter = path.join(root, 'adapter.json');
  await writeFile(adapter, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, '--regime-shift-at', '48'],
    adapterId: 'ess-arbitrage-adapter-v1',
    worldId: 'ess-arbitrage',
    timeoutMs: 30000,
  }));
  try {
    const init = await invoke(['init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', 'r9-regime', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const run = await invoke(['agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', '96', '--kernel-only', '--adapter', adapter, '--json']);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout[0].data.status, 'COMPLETED');

    const events = (await (await LabStore.open({ labPath: lab })).readRun('r')).events
      .filter((event) => event.kind === 'STEP');
    assert.equal(events.length, 96);

    // 电价表翻转的证据：翻转点（hour 48）后，同一小时档位的价格通道符号翻转
    // （hour 0 模式：谷档 priceChannel 谷=-0.35；hour 48 起谷档变峰 → +0.5）
    const before = events[0].payload.postObservation.vector[1];
    const after = events[48].payload.postObservation.vector[1];
    assert.ok(before < 0, `pre-flip valley channel should be negative, got ${before}`);
    assert.ok(after > 0, `post-flip valley channel should flip to peak, got ${after}`);

    const replay = await invoke(['replay', '--lab', lab, '--run', 'r', '--adapter', adapter, '--json']);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- R10：终局全合成验收——延迟 16 + 噪声 + 对抗 + regime shift 全叠加 ----
test('R10: all-difficulty synthetic run stays consistent across every channel', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-r10-synth-'));
  const lab = path.join(root, 'lab');
  const adapter = path.join(root, 'adapter.json');
  await writeFile(adapter, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, '--settlement-delay', '16', '--noisy-feedback', '--adversarial', '--regime-shift-at', '48'],
    adapterId: 'ess-arbitrage-adapter-v1',
    worldId: 'ess-arbitrage',
    timeoutMs: 30000,
  }));
  try {
    const init = await invoke(['init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', 'r10-synth', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const run = await invoke(['agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', '96', '--kernel-only', '--adapter', adapter, '--json']);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout[0].data.status, 'COMPLETED');

    const events = (await (await LabStore.open({ labPath: lab })).readRun('r')).events
      .filter((event) => event.kind === 'STEP');
    assert.equal(events.length, 96);

    // 归因分级在全部难度叠加下保持语义正确
    let action = 0; let ambiguous = 0; let unresolved = 0;
    for (const event of events) {
      for (const item of event.payload.update?.settled ?? []) {
        if (item.attribution === 'ACTION') action += 1;
        else if (item.attribution === 'AMBIGUOUS') ambiguous += 1;
        else if (item.attribution === 'UNRESOLVED') unresolved += 1;
        else assert.fail(`unexpected attribution ${item.attribution}`);
        if (item.attribution === 'AMBIGUOUS') assert.equal(item.learnable, false);
      }
    }
    assert.ok(action + ambiguous + unresolved > 0, 'delayed settlements must exist under delay 16');

    const replay = await invoke(['replay', '--lab', lab, '--run', 'r', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
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

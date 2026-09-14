import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('examples/curriculum/ess-arbitrage/adapter.mjs');
const SEEDS = ['alpha', 'beta', 'gamma'];

// R12：链长效应（F-257）。
// 长期收益由 scripts/curriculum/r12-chain-length.mjs 测量，不是固定行为契约；
// 本 E2E 锁定链长协议、反馈快照边界和 Replay，不锁定特定 seed 的成本排序。
test('R12: pair and multi-charge chains preserve attribution boundaries and replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-r12-e2e-'));
  try {
    const runs = { pair: [], multi2: [], multi3: [] };
    for (const label of ['pair', 'multi2', 'multi3']) {
      for (const seed of SEEDS) {
        const adapter = path.join(root, `adapter-${label}-${seed}.json`);
        await writeFile(adapter, JSON.stringify({
          executable: process.execPath,
          args: label === 'pair'
            ? [ADAPTER, '--chain-credit']
            : [ADAPTER, '--chain-credit', '--chain-max-charges', label === 'multi2' ? '2' : '3'],
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

        const events = (await (await LabStore.open({ labPath: lab })).readRun('r')).events
          .filter((event) => event.kind === 'STEP');
        let actionChains = 0;
        let widestChain = 0;
        for (const event of events) {
          for (const item of event.payload.update?.settled ?? []) {
            if (item.attribution === 'ACTION_CHAIN') actionChains += 1;
          }
          for (const feedback of event.payload.postObservation.feedback ?? []) {
            if (feedback.creditChain === undefined) continue;
            assert.deepEqual(feedback.vector, event.payload.beforeObservation.vector);
            assert.equal(feedback.stateVersion, event.payload.beforeObservation.stateVersion);
            assert.equal(feedback.intervalId, event.payload.beforeObservation.intervalId);
            if (feedback.creditChain.members.length > widestChain) {
              widestChain = feedback.creditChain.members.length;
            }
          }
        }
        const replay = await invoke(['replay', '--lab', lab, '--run', 'r', '--adapter', adapter, '--json']);
        assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
        runs[label].push({ seed, actionChains, widestChain });
      }
    }

    for (const [label, expectedWidth] of [['pair', 2], ['multi2', 3], ['multi3', 4]]) {
      for (const r of runs[label]) {
        assert.ok(r.actionChains > 0, `${label} ${r.seed}: expected chain settlements`);
        assert.equal(r.widestChain, expectedWidth, `${label} ${r.seed}: expected ${expectedWidth}-member chain, widest ${r.widestChain}`);
      }
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

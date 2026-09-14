import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('examples/curriculum/ess-arbitrage/adapter.mjs');
const CONFIGS = [
  { label: 'distance-base', utility: false, chain: false },
  { label: 'distance-pair', utility: false, chain: true },
  { label: 'utility-base', utility: true, chain: false },
  { label: 'utility-pair', utility: true, chain: true },
];

test('R14: value projection is persisted, chain feedback settles, and all four CLI branches replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-r14-e2e-'));
  try {
    for (const config of CONFIGS) {
      const adapter = path.join(root, `adapter-${config.label}.json`);
      const adapterArgs = [
        ADAPTER,
        ...(config.utility ? ['--utility-mode'] : []),
        ...(config.chain ? ['--chain-credit'] : []),
      ];
      await writeFile(adapter, JSON.stringify({
        executable: process.execPath,
        args: adapterArgs,
        adapterId: 'ess-arbitrage-adapter-v1',
        worldId: 'ess-arbitrage',
        timeoutMs: 30000,
      }));

      const lab = path.join(root, `lab-${config.label}`);
      const init = await invoke([
        'init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', 'r14-paired-seed',
        '--adapter', adapter, '--json',
      ]);
      assert.equal(init.code, 0, JSON.stringify(init));
      const run = await invoke([
        'agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', '48',
        '--kernel-only', '--planning-horizon', '8', '--adapter', adapter, '--json',
      ]);
      assert.equal(run.code, 0, JSON.stringify(run));
      assert.equal(run.stdout[0].data.status, 'COMPLETED');

      const store = await LabStore.open({ labPath: lab });
      const events = (await store.readRun('r')).events.filter((event) => event.kind === 'STEP');
      assert.equal(events.length, 48);
      for (const event of events) {
        const valueSpec = event.payload.boundary.valueSpec;
        if (config.utility) {
          assert.equal(valueSpec.valueMode, 'signed-v1');
          assert.deepEqual(valueSpec.weights, [0, 0, 0, 1]);
          assert.equal(valueSpec.observationDimensions, 4);
        } else {
          assert.equal(valueSpec.valueMode, 'distance-v2');
          assert.deepEqual(valueSpec.weights, [1.5, 0.3, 0]);
          assert.equal(valueSpec.observationDimensions, 3);
        }
      }

      const chainSettlements = events.flatMap((event) => event.payload.update?.settled ?? [])
        .filter((item) => item.attribution === 'ACTION_CHAIN');
      if (config.chain) assert.ok(chainSettlements.length > 0, `${config.label} must settle chain credit`);
      else assert.equal(chainSettlements.length, 0, `${config.label} must not settle chain credit`);

      if (config.chain) {
        const releases = events.flatMap((event) =>
          (event.payload.postObservation.feedback ?? [])
            .filter((feedback) => feedback.creditChain !== undefined)
            .map((feedback) => ({ event, feedback })),
        );
        assert.ok(releases.length > 0, 'utility-pair must emit chain feedback');
        for (const { event, feedback } of releases) {
          assert.deepEqual(feedback.vector, event.payload.beforeObservation.vector);
          assert.equal(feedback.stateVersion, event.payload.beforeObservation.stateVersion);
          assert.equal(feedback.intervalId, event.payload.beforeObservation.intervalId);
          if (config.utility) assert.notEqual(feedback.vector[3], event.payload.postObservation.vector[3]);
        }
      }

      const replay = await invoke(['replay', '--lab', lab, '--run', 'r', '--adapter', adapter, '--json']);
      assert.equal(replay.code, 0, JSON.stringify(replay));
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
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

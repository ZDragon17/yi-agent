import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADAPTER = path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs');
const MODEL_ADAPTER = path.join(ROOT, 'test/fixtures/feedback-continuous-power-model-adapter.mjs');

function expectedPower(observation) {
  const tariff = observation.vector[1];
  const soc = observation.vector[2] * 100;
  if (tariff < -0.1 && soc < 80) return 50;
  if (tariff > 0.1 && soc > 20) return -50;
  return 0;
}

test('feedback-driven continuous proposal follows each preceding observation and replays', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-r23-feedback-e2e-'));
  const adapterConfig = path.join(root, 'adapter.json');
  const modelConfig = path.join(root, 'model.json');
  const lab = path.join(root, 'lab');
  await writeFile(adapterConfig, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, '--utility-mode', '--continuous-power'],
    adapterId: 'ess-arbitrage-adapter-v1',
    worldId: 'ess-arbitrage',
    timeoutMs: 30000,
    transport: 'persistent-jsonl',
  }));
  await writeFile(modelConfig, JSON.stringify({
    executable: process.execPath,
    args: [MODEL_ADAPTER],
    model: 'feedback-continuous-power-fixture',
    timeoutMs: 5000,
  }));
  try {
    const init = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), 'init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', 'r23-feedback-seed', '--adapter', adapterConfig, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.equal(init.status, 0, init.stderr);
    const run = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), 'agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', '24', '--adapter', adapterConfig, '--model-adapter', modelConfig, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    const ledger = await LabStore.open({ labPath: lab });
    const steps = (await ledger.readRun('r')).events.filter((event) => event.kind === 'STEP');
    assert.equal(steps.length, 24);
    const powers = steps.map((event) => event.payload.policyEvidence?.proposal?.powerKw);
    assert.deepEqual(powers, steps.map((event) => expectedPower(event.payload.beforeObservation)));
    assert.deepEqual(new Set(powers), new Set([50, 0, -50]));
    const current = await ledger.readChainCurrent();
    assert.equal(Object.keys(current.memory.actionModels).length, 1);
    // 末步的反馈可能留在 terminal STEP 的持久化边界之外；这里确认绝大多数
    // observation-driven 动作已进入记忆，不把终止时序误判成 proposal 失败。
    assert.ok(Object.values(current.memory.actionModels)[0].sampleCount >= 23);
    assert.ok(Object.values(current.memory.actionModels)[0].sampleCount <= 24);
    const replay = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), 'replay', '--lab', lab, '--run', 'r', '--adapter', adapterConfig, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.equal(replay.status, 0, replay.stderr);
    assert.match(replay.stdout, /CONSISTENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

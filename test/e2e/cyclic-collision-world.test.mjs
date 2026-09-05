import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('test/fixtures/cyclic-collision-world-adapter.mjs');
const CAPABILITY_IDS = [
  'cyclic-collision.alpha',
  'cyclic-collision.beta',
  'cyclic-collision.gamma',
  'cyclic-collision.delta',
];
const WINNER_SCHEDULE = [0, 1, 0, 2, 1, 0, 3];
const STEPS_PER_RUN = 180;
const LOCK_WINDOW = 120;
// 预注册判据：盲选赢家率 25%，窗口-1/2 政策类的理论上限约 5.5/7 ≈ 78.6%。
// 600/1500 步实测显示多尺度上下文在 ~150 步内把赢家率提升到该平台附近并持续
// 数百步（更长跑中平台在 ~550 步处发生不可逆瓦解，作为已知边界记录在 F-116）。
// 成熟窗口（末 120 步）要求 ≥ 70.8%（85/120）：显著高于盲选与 v25 实测的
// 28.6%，并允许平台内的瞬态；600 步长跑显示该平台可持续数百步。
const LOCK_THRESHOLD = 85;

test('kernel-only runs lock onto period-7 collision dynamics through long-window context memory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-cyclic-collision-e2e-'));
  try {
    const worlds = await Promise.all(['collision-a', 'collision-b'].map((seed) => prepareWorld(root, seed)));
    for (const world of worlds) {
      const first = await invoke(['run', '--lab', world.lab, '--run-id', `run-${world.seed}-first`, '--steps', String(STEPS_PER_RUN), '--adapter', world.adapter, '--json']);
      assert.equal(first.code, 0, JSON.stringify(first));
      assert.equal(first.stdout[0].data.metrics.executed, STEPS_PER_RUN);
      const second = await invoke(['run', '--lab', world.lab, '--run-id', `run-${world.seed}-second`, '--steps', String(STEPS_PER_RUN), '--adapter', world.adapter, '--json']);
      assert.equal(second.code, 0, JSON.stringify(second));
      assert.equal(second.stdout[0].data.metrics.executed, STEPS_PER_RUN);
      world.runIds = [first.stdout[0].data.runId, second.stdout[0].data.runId];

      for (const runId of world.runIds) {
        const replay = await invoke(['replay', '--lab', world.lab, '--run', runId, '--adapter', world.adapter, '--json']);
        assert.equal(replay.code, 0, JSON.stringify(replay));
        assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
      }
    }

    const stats = [];
    for (const world of worlds) {
      const durable = JSON.parse(await readFile(world.stateFile, 'utf8'));
      assert.equal(durable.effects.length, STEPS_PER_RUN * 2);
      assert.equal(durable.revision, STEPS_PER_RUN * 2);

      const choices = (await Promise.all(world.runIds.map(async (runId) => {
        const run = await (await LabStore.open({ labPath: world.lab })).readRun(runId);
        return run.events
          .filter((event) => event.kind === 'STEP')
          .map((event) => world.tokens.get(event.payload.choice.token));
      }))).flat();
      assert.equal(choices.length, STEPS_PER_RUN * 2);

      const window = choices.slice(-LOCK_WINDOW);
      const winners = window.filter((capabilityId, offset) => {
        const globalStep = choices.length - LOCK_WINDOW + offset;
        return CAPABILITY_IDS[WINNER_SCHEDULE[globalStep % WINNER_SCHEDULE.length]] === capabilityId;
      }).length;
      stats.push({ seed: world.seed, winners, choices });
    }

    const failures = stats.filter(({ winners }) => winners < LOCK_THRESHOLD);
    assert.equal(failures.length, 0, `mature-window winner rates below threshold: ${failures.map(({ seed, winners }) => `${seed} ${winners}/${LOCK_WINDOW}`).join('; ')}; choices=${JSON.stringify(Object.fromEntries(stats.map(({ seed, choices }) => [seed, choices.map((capabilityId, index) => `${index}:${capabilityId === CAPABILITY_IDS[WINNER_SCHEDULE[index % WINNER_SCHEDULE.length]] ? 'W' : 'x'}`)])))}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function prepareWorld(root, seed) {
  const stateFile = path.join(root, seed, 'world', 'state.json');
  const adapter = path.join(root, seed, 'adapter.json');
  const lab = path.join(root, seed, 'lab');
  await mkdir(path.dirname(adapter), { recursive: true });
  await writeFile(adapter, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, '--state-file', stateFile],
    adapterId: 'cyclic-collision-adapter-v1',
    worldId: 'cyclic-collision',
    timeoutMs: 2000,
  }));
  const init = await invoke(['init', '--lab', lab, '--world', 'cyclic-collision', '--seed', seed, '--lab-id', `collision-${seed}`, '--adapter', adapter, '--json']);
  assert.equal(init.code, 0, JSON.stringify(init));
  const tokens = new Map(init.stdout[0].data.tokenMap.entries.map((entry) => [entry.token, entry.capabilityId]));
  return { seed, stateFile, adapter, lab, tokens };
}

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

test('the converged policy reaches the value target and holds it without scheduled-winner supervision', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-cyclic-collision-hold-'));
  try {
    const stateFile = path.join(root, 'world', 'state.json');
    const adapter = path.join(root, 'adapter.json');
    const lab = path.join(root, 'lab');
    await mkdir(path.dirname(adapter), { recursive: true });
    await writeFile(adapter, JSON.stringify({
      executable: process.execPath,
      args: [ADAPTER, '--state-file', stateFile],
      adapterId: 'cyclic-collision-adapter-v1',
      worldId: 'cyclic-collision',
      timeoutMs: 2000,
    }));
    const init = await invoke(['init', '--lab', lab, '--world', 'cyclic-collision', '--seed', 'collision-hold', '--lab-id', 'collision-hold', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    for (const runId of ['hold-1', 'hold-2']) {
      const run = await invoke(['run', '--lab', lab, '--run-id', runId, '--steps', '600', '--adapter', adapter, '--json']);
      assert.equal(run.code, 0, JSON.stringify(run));
    }

    const store = await LabStore.open({ labPath: lab });
    const values = [];
    for (const runId of ['hold-1', 'hold-2']) {
      const run = await store.readRun(runId);
      for (const event of run.events.filter((event) => event.kind === 'STEP')) {
        values.push({ step: values.length, value: event.payload.beforeObservation.vector[0] });
      }
    }
    // 目标达成：值在预算内进入目标带。
    const reached = values.find((entry) => Math.abs(entry.value - 400) <= 5);
    assert.ok(reached !== undefined, 'value never reached the 400 target band');
    assert.ok(reached.step <= 900, `target reached at step ${reached.step}`);

    // 目标驻留：越过目标后平均距离保持有界——越过目标后调度赢家不再是最优，
    // 调度赢家率失效，值距离才是正确的度量。驻留窗口取最后 100 步，
    // 避开逼近段尾巴。
    const hold = values.slice(-100);
    const avgDistance = hold.reduce((sum, entry) => sum + Math.abs(entry.value - 400), 0) / hold.length;
    assert.ok(avgDistance <= 5, `hold-phase average distance ${avgDistance.toFixed(2)} exceeds 5`);

    for (const runId of ['hold-1', 'hold-2']) {
      const replay = await invoke(['replay', '--lab', lab, '--run', runId, '--adapter', adapter, '--json']);
      assert.equal(replay.code, 0, JSON.stringify(replay));
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

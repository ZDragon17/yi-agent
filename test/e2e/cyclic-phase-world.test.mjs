import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('test/fixtures/cyclic-phase-world-adapter.mjs');
const CAPABILITY_IDS = ['cyclic-phase.alpha', 'cyclic-phase.beta', 'cyclic-phase.gamma'];
const STEPS_PER_RUN = 30;
const LOCK_WINDOW = 18;
const LOCK_THRESHOLD = 15;

test('kernel-only runs lock onto period-3 hidden phase dynamics through bounded context memory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-cyclic-phase-e2e-'));
  try {
    const worlds = await Promise.all(['cyclic-a', 'cyclic-b'].map((seed) => prepareWorld(root, seed)));
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

      // 预注册判据：隐藏相位每步推进且对 Kernel 不可见；只有历史上下文能表达相位条件策略。
      // 第二个进程（成熟记忆）的收尾窗口必须达到 ≥ LOCK_THRESHOLD/LOCK_WINDOW 的当步赢家命中率。
      const window = choices.slice(-LOCK_WINDOW);
      const winners = window.filter((capabilityId, offset) => {
        const globalStep = choices.length - LOCK_WINDOW + offset;
        return capabilityId === CAPABILITY_IDS[globalStep % 3];
      }).length;
      assert.ok(
        winners >= LOCK_THRESHOLD,
        `${world.seed}: phase-lock window hit ${winners}/${LOCK_WINDOW} (threshold ${LOCK_THRESHOLD}); choices=${JSON.stringify(choices.map((capabilityId, index) => `${index}:${capabilityId === CAPABILITY_IDS[index % 3] ? 'W' : (CAPABILITY_IDS[(index + 1) % 3] === capabilityId ? 'n' : 'L')}`))}`,
      );
    }
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
    adapterId: 'cyclic-phase-adapter-v1',
    worldId: 'cyclic-phase',
    timeoutMs: 2000,
  }));
  const init = await invoke(['init', '--lab', lab, '--world', 'cyclic-phase', '--seed', seed, '--lab-id', `cyclic-${seed}`, '--adapter', adapter, '--json']);
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

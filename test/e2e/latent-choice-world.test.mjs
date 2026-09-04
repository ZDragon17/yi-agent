import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('test/fixtures/latent-choice-world-adapter.mjs');

test('verified feedback changes hidden-world choices across independent CLI restarts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-latent-choice-e2e-'));
  try {
    const worlds = await Promise.all(['A', 'B'].map((mode) => prepareWorld(root, mode)));
    for (const world of worlds) {
      const first = await invoke(['run', '--lab', world.lab, '--run-id', `run-${world.mode}-first`, '--steps', '2', '--adapter', world.adapter, '--json']);
      assert.equal(first.code, 0, JSON.stringify(first));
      assert.equal(first.stdout[0].data.metrics.executed, 2);
      const second = await invoke(['run', '--lab', world.lab, '--run-id', `run-${world.mode}-second`, '--steps', '3', '--adapter', world.adapter, '--json']);
      assert.equal(second.code, 0, JSON.stringify(second));
      assert.equal(second.stdout[0].data.metrics.executed, 3);
      world.runIds = [first.stdout[0].data.runId, second.stdout[0].data.runId];
    }

    const runs = await Promise.all(worlds.map(async (world) => ({
      ...world,
      events: (await Promise.all(world.runIds.map(async (runId) => (
        await (await LabStore.open({ labPath: world.lab })).readRun(runId)
      )))).flatMap((run) => run.events),
    })));
    const choices = runs.map(({ events, tokens }) => events
      .filter((event) => event.kind === 'STEP')
      .map((event) => tokens.get(event.payload.choice.token)));
    assert.equal(choices[0][0], choices[1][0]);
    assert.equal(choices[0][1], choices[1][1]);
    assert.notEqual(choices[0][2], choices[1][2]);
    assert.notDeepEqual(choices[0], choices[1]);

    for (const world of worlds) {
      for (const runId of world.runIds) {
        const replay = await invoke(['replay', '--lab', world.lab, '--run', runId, '--adapter', world.adapter, '--json']);
        assert.equal(replay.code, 0, JSON.stringify(replay));
        assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
      }
      assert.equal(JSON.parse(await readFile(world.stateFile, 'utf8')).effects.length, 5);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function prepareWorld(root, mode) {
  const stateFile = path.join(root, mode, 'world', 'state.json');
  const adapter = path.join(root, mode, 'adapter.json');
  const lab = path.join(root, mode, 'lab');
  await mkdir(path.dirname(adapter), { recursive: true });
  await writeFile(adapter, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, '--state-file', stateFile, '--mode', mode],
    adapterId: `latent-choice-adapter-${mode.toLowerCase()}-v1`,
    worldId: 'latent-choice',
    timeoutMs: 2000,
  }));
  const init = await invoke(['init', '--lab', lab, '--world', 'latent-choice', '--seed', `latent-choice-${mode}`, '--lab-id', `latent-choice-${mode}`, '--adapter', adapter, '--json']);
  assert.equal(init.code, 0, JSON.stringify(init));
  const tokens = new Map(init.stdout[0].data.tokenMap.entries.map((entry) => [entry.token, entry.capabilityId]));
  return { mode, stateFile, adapter, lab, tokens };
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

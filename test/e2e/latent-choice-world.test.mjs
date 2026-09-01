import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('test/fixtures/latent-choice-world-adapter.mjs');

test('an all-safe hidden WorldPort separates only after feedback and remains restartable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-latent-choice-e2e-'));
  try {
    const worlds = await Promise.all(['A', 'B'].map((mode) => prepareWorld(root, mode)));
    for (const world of worlds) {
      const result = await invoke(['run', '--lab', world.lab, '--run-id', `run-${world.mode}`, '--steps', '5', '--adapter', world.adapter, '--json']);
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.equal(result.stdout[0].data.metrics.executed, 5);
    }

    const runs = await Promise.all(worlds.map(async (world) => ({
      ...world,
      run: await (await LabStore.open({ labPath: world.lab })).readRun(`run-${world.mode}`),
    })));
    const choices = runs.map(({ run, tokens }) => run.events
      .filter((event) => event.kind === 'STEP')
      .map((event) => tokens.get(event.payload.choice.token)));
    assert.equal(choices[0][0], choices[1][0]);
    assert.notDeepEqual(choices[0], choices[1]);
    assert.ok(choices[0].findIndex((choice, index) => choice !== choices[1][index]) > 0);

    for (const world of worlds) {
      const replay = await invoke(['replay', '--lab', world.lab, '--run', `run-${world.mode}`, '--adapter', world.adapter, '--json']);
      assert.equal(replay.code, 0, JSON.stringify(replay));
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
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

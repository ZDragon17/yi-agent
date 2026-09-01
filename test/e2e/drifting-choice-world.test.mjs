import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('test/fixtures/drifting-choice-world-adapter.mjs');

test('periodic revalidation adapts to hidden drift across CLI runs and replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-drifting-choice-e2e-'));
  const stateFile = path.join(root, 'world', 'state.json');
  const adapter = path.join(root, 'adapter.json');
  const lab = path.join(root, 'lab');
  await writeFile(adapter, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, '--state-file', stateFile, '--drift-after', '3'],
    adapterId: 'drifting-choice-adapter-3-v1',
    worldId: 'drifting-choice',
    timeoutMs: 2000,
  }));

  try {
    const init = await invoke(['init', '--lab', lab, '--world', 'drifting-choice', '--seed', 'drifting-choice-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const manifest = init.stdout[0].data;
    const tokens = Object.fromEntries(manifest.tokenMap.entries.map((entry) => [entry.capabilityId, entry.token]));

    const first = await invoke(['agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '8', '--stagnation-limit', '100000', '--kernel-only', '--adapter', adapter, '--json']);
    assert.equal(first.code, 0, JSON.stringify(first));
    const second = await invoke(['agent', 'run', '--lab', lab, '--run-id', 'run-2', '--steps', '7', '--stagnation-limit', '100000', '--kernel-only', '--adapter', adapter, '--json']);
    assert.equal(second.code, 0, JSON.stringify(second));

    const store = await LabStore.open({ labPath: lab });
    const runs = await Promise.all(['run-1', 'run-2'].map((runId) => store.readRun(runId)));
    const steps = runs.flatMap((run) => run.events).filter((event) => event.kind === 'STEP');
    const revalidation = steps.find((event) => event.payload.expectation.verificationAge >= 8);
    assert.ok(revalidation);
    assert.equal(revalidation.payload.choice.token, tokens['drifting-choice.a']);
    assert.equal(
      revalidation.payload.postObservation.vector[0],
      revalidation.payload.beforeObservation.vector[0] - 2,
    );
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).effects.length, 15);

    const current = (await store.inspect()).current;
    assert.equal(
      current.memory.lastVerifiedSteps[tokens['drifting-choice.a']],
      revalidation.payload.afterState.memory.lastVerifiedSteps[tokens['drifting-choice.a']],
    );
    assert.ok(current.memory.lastVerifiedSteps[tokens['drifting-choice.a']] > 0);
    assert.equal(current.kernelStep, 15);

    for (const result of [first, second]) {
      const replay = await invoke(['replay', '--lab', lab, '--run', result.stdout[0].data.runId, '--adapter', adapter, '--json']);
      assert.equal(replay.code, 0, JSON.stringify(replay));
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    }
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).effects.length, 15);
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

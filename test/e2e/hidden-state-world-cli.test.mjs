import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('test/fixtures/hidden-state-world-adapter.mjs');

test('hidden WorldPort preserves verified outcome branches across CLI restarts and replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-hidden-state-e2e-'));
  const stateFile = path.join(root, 'world', 'state.json');
  const adapter = path.join(root, 'adapter.json');
  const lab = path.join(root, 'lab');
  await writeFile(adapter, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, '--state-file', stateFile],
    adapterId: 'hidden-state-adapter-v1',
    worldId: 'hidden-state',
    timeoutMs: 2000,
  }));

  try {
    const init = await invoke('init', '--lab', lab, '--world', 'hidden-state', '--seed', 'hidden-state-seed', '--adapter', adapter, '--json');
    assert.equal(init.code, 0, JSON.stringify(init));

    const first = await invoke('run', '--lab', lab, '--steps', '5', '--adapter', adapter, '--json');
    assert.equal(first.code, 0, JSON.stringify(first));
    const second = await invoke('run', '--lab', lab, '--steps', '6', '--adapter', adapter, '--json');
    assert.equal(second.code, 0, JSON.stringify(second));

    const inspection = await invoke('inspect', '--lab', lab, '--adapter', adapter, '--json');
    assert.equal(inspection.code, 0, JSON.stringify(inspection));
    const current = inspection.stdout[0].data.current;
    const token = inspection.stdout[0].data.manifest.tokenMap.entries
      .find((entry) => entry.capabilityId === 'hidden-state.advance').token;
    const belief = current.memory.beliefModels[token]['r1:+'];
    assert.deepEqual(belief.samples, [[-1], [1], [-1], [1]]);
    assert.equal(belief.sampleCount, 4);
    assert.equal(current.worldState.value, 1);
    assert.equal(current.worldState.hiddenMode, 'A');
    assert.equal(current.kernelStep, 11);

    const store = await LabStore.open({ labPath: lab });
    const runs = await Promise.all([first, second].map((result) => store.readRun(result.stdout[0].data.runId)));
    const advanceSteps = runs.flatMap((run) => run.events)
      .filter((event) => event.kind === 'STEP' && event.payload.choice.token === token);
    assert.equal(advanceSteps.length, 4);
    assert.deepEqual(advanceSteps.map((event) => event.payload.beforeObservation.vector), [[0], [0], [0], [0]]);

    const storedWorld = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(storedWorld.effects.length, 11);
    for (const result of [first, second]) {
      const replay = await invoke('replay', '--lab', lab, '--run', result.stdout[0].data.runId, '--adapter', adapter, '--json');
      assert.equal(replay.code, 0, JSON.stringify(replay));
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    }
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).effects.length, 11);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function invoke(...args) {
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

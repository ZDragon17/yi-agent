import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ExternalWorldProtocolError, loadExternalWorldRegistry } from '../../src/application/external-world-registry.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('test/fixtures/durable-counter-world-adapter.mjs');

test('persistent JSONL WorldPort reuses one session and replay never starts it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-world-'));
  try {
    const stateFile = path.join(root, 'world', 'state.json');
    const startFile = path.join(root, 'world', 'starts.log');
    const adapter = path.join(root, 'adapter.json');
    const lab = path.join(root, 'lab');
    await mkdir(path.dirname(adapter), { recursive: true });
    await writeFile(adapter, JSON.stringify({
      executable: process.execPath,
      args: [ADAPTER, '--state-file', stateFile, '--start-file', startFile],
      adapterId: 'durable-counter-adapter-v1',
      worldId: 'durable-counter',
      timeoutMs: 5000,
      transport: 'persistent-jsonl',
    }));

    const init = await invoke(['init', '--lab', lab, '--world', 'durable-counter', '--seed', 'persistent-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const startsAfterInit = (await readFile(startFile, 'utf8')).trim().split(/\r?\n/u).filter(Boolean);
    assert.equal(startsAfterInit.length, 1);

    const run = await invoke(['run', '--lab', lab, '--run-id', 'persistent-run', '--steps', '6', '--adapter', adapter, '--json']);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.json.data.status, 'COMPLETED');
    const startsAfterRun = (await readFile(startFile, 'utf8')).trim().split(/\r?\n/u).filter(Boolean);
    // Each CLI command performs one descriptor probe; all runtime requests in
    // the run share one additional persistent child session.
    assert.equal(startsAfterRun.length - startsAfterInit.length, 2);

    const replay = await invoke(['replay', '--lab', lab, '--run', 'persistent-run', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
    const startsAfterReplay = (await readFile(startFile, 'utf8')).trim().split(/\r?\n/u).filter(Boolean);
    assert.deepEqual(startsAfterReplay, startsAfterRun);

    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.effects.length, 6);
    assert.equal(state.value, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persistent session loss resumes through the existing nonce boundary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-recovery-'));
  try {
    const stateFile = path.join(root, 'world', 'state.json');
    const adapter = path.join(root, 'adapter.json');
    const lab = path.join(root, 'lab');
    await mkdir(path.dirname(adapter), { recursive: true });
    await writeFile(adapter, JSON.stringify({
      executable: process.execPath,
      args: [ADAPTER, '--state-file', stateFile, '--drop-response-once'],
      adapterId: 'durable-counter-adapter-v1',
      worldId: 'durable-counter',
      timeoutMs: 5000,
      transport: 'persistent-jsonl',
    }));

    const init = await invoke(['init', '--lab', lab, '--world', 'durable-counter', '--seed', 'persistent-recovery-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const lost = await invoke(['run', '--lab', lab, '--run-id', 'lost-run', '--steps', '1', '--adapter', adapter, '--json']);
    assert.notEqual(lost.code, 0, JSON.stringify(lost));
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).effects.length, 1);

    const resumed = await invoke(['run', '--lab', lab, '--run-id', 'recovered-run', '--steps', '1', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.json.data.status, 'COMPLETED');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.effects.length, 1);
    assert.equal(state.value, 1);
    const replay = await invoke(['replay', '--lab', lab, '--run', 'recovered-run', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persistent request timeout kills the session and recovery does not duplicate the effect', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-timeout-'));
  try {
    const stateFile = path.join(root, 'world', 'state.json');
    const delayMarker = path.join(root, 'world', 'delay.marker');
    const adapter = path.join(root, 'adapter.json');
    const lab = path.join(root, 'lab');
    await mkdir(path.dirname(adapter), { recursive: true });
    await writeFile(adapter, JSON.stringify({
      executable: process.execPath,
      args: [ADAPTER, '--state-file', stateFile, '--delay-once-ms', '4000', '--delay-marker', delayMarker],
      adapterId: 'durable-counter-adapter-v1',
      worldId: 'durable-counter',
      timeoutMs: 2000,
      transport: 'persistent-jsonl',
    }));

    const init = await invoke(['init', '--lab', lab, '--world', 'durable-counter', '--seed', 'persistent-timeout-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const timedOut = await invoke(['run', '--lab', lab, '--run-id', 'timeout-run', '--steps', '1', '--adapter', adapter, '--json']);
    assert.notEqual(timedOut.code, 0, JSON.stringify(timedOut));
    assert.equal(timedOut.json.error.code, 'WORLD_ADAPTER_PROTOCOL');
    const afterTimeout = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(afterTimeout.effects.length, 1);

    const resumed = await invoke(['run', '--lab', lab, '--run-id', 'timeout-recovered-run', '--steps', '1', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    const afterResume = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(afterResume.effects.length, 1);
    assert.equal(afterResume.value, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persistent session rebuild ignores the old process close event', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-rebuild-'));
  let registry = null;
  try {
    const stateFile = path.join(root, 'world', 'state.json');
    const delayMarker = path.join(root, 'world', 'delay.marker');
    const adapter = path.join(root, 'adapter.json');
    await mkdir(path.dirname(adapter), { recursive: true });
    await writeFile(adapter, JSON.stringify({
      executable: process.execPath,
      args: [ADAPTER, '--state-file', stateFile, '--delay-once-ms', '1000', '--delay-marker', delayMarker],
      adapterId: 'durable-counter-adapter-v1',
      worldId: 'durable-counter',
      timeoutMs: 500,
      transport: 'persistent-jsonl',
    }));

    registry = loadExternalWorldRegistry(adapter);
    const manifest = {
      schemaVersion: 1,
      worldId: 'durable-counter',
      labId: 'persistent-rebuild-lab',
      seed: 'persistent-rebuild-seed',
      ...registry.createManifestParts({
        labId: 'persistent-rebuild-lab',
        seed: 'persistent-rebuild-seed',
        worldId: 'durable-counter',
      }),
    };
    const world = registry.createWorld(manifest, 'steady');
    const state = await world.initialState();
    const action = (await world.actions({
      schemaVersion: manifest.schemaVersion,
      tokenMap: manifest.tokenMap,
      authorityPolicy: manifest.authorityPolicy,
    }, state))[0];
    const request = {
      schemaVersion: 1,
      token: action.token,
      basedOnVersion: state.stateVersion,
      policyVersion: manifest.authorityPolicy.policyVersion,
      constraintsDigest: manifest.authorityPolicy.constraintsDigest,
      executionNonce: 'execution:persistent-rebuild:1',
    };

    await assert.rejects(
      () => world.transition(state, request),
      (error) => error instanceof ExternalWorldProtocolError && error.context.cause === 'Timeout',
    );
    const observation = await world.observe(state);
    assert.deepEqual(observation.vector, [0]);
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).effects.length, 1);
  } finally {
    await registry?.close();
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
    child.on('close', (code) => {
      let json = null;
      if (stdout.trim() !== '') {
        try {
          json = JSON.parse(stdout.trim());
        } catch (error) {
          reject(new Error(`CLI output was not JSON: ${stdout}\n${stderr}`, { cause: error }));
          return;
        }
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

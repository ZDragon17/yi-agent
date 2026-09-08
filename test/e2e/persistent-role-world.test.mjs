import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadExternalWorldRegistry } from '../../src/application/external-world-registry.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const PRIMARY = path.resolve('test/fixtures/chain-credit-world-adapter.mjs');
const WITNESS = path.resolve('test/fixtures/independent-chain-witness-adapter.mjs');
const EXECUTION_ADAPTER = path.resolve('test/fixtures/idempotent-transition-world-adapter.mjs');

test('persistent transport covers an independent witness across a long run and replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-role-'));
  try {
    const lab = path.join(root, 'lab');
    const adapter = path.join(root, 'adapter.json');
    const primaryStarts = path.join(root, 'primary-starts.log');
    const witnessStarts = path.join(root, 'witness-starts.log');
    const witnessTrace = path.join(root, 'witness-trace.log');
    await mkdir(root, { recursive: true });
    await writeFile(adapter, JSON.stringify({
      executable: process.execPath,
      args: [PRIMARY, '--credit-chain', '--attested-evidence', '--independent-evidence', '--start-file', primaryStarts],
      adapterId: 'chain-credit-adapter-independent-v1',
      worldId: 'chain-credit',
      timeoutMs: 5000,
      transport: 'persistent-jsonl',
      witness: {
        executable: process.execPath,
        args: [WITNESS, '--start-file', witnessStarts, '--trace-file', witnessTrace],
        adapterId: 'chain-credit-witness-v1',
        worldId: 'chain-credit',
        timeoutMs: 5000,
        transport: 'persistent-jsonl',
      },
    }));

    const init = await invoke([
      'init', '--lab', lab, '--world', 'chain-credit', '--seed', 'persistent-role-seed',
      '--lab-id', 'persistent-role-lab', '--adapter', adapter, '--json',
    ]);
    assert.equal(init.code, 0, JSON.stringify(init));
    const primaryAfterInit = await startCount(primaryStarts);
    const witnessAfterInit = await startCount(witnessStarts);
    assert.equal(primaryAfterInit, 1);
    assert.equal(witnessAfterInit, 1);

    const run = await invoke([
      'run', '--lab', lab, '--run-id', 'run-1', '--steps', '6', '--scenario', 'chain', '--adapter', adapter, '--json',
    ]);
    assert.equal(run.code, 0, `${JSON.stringify(run)}\n${await readFile(witnessTrace, 'utf8')}`);
    assert.equal(run.json.data.status, 'COMPLETED');
    assert.equal(await startCount(primaryStarts) - primaryAfterInit, 2);
    const witnessAfterRun = await startCount(witnessStarts);
    assert.equal(witnessAfterRun - witnessAfterInit, 2, await readFile(witnessTrace, 'utf8'));
    const evidencePids = (await readFile(witnessTrace, 'utf8')).trim().split(/\r?\n/u)
      .filter((line) => line.endsWith(':evidence'))
      .map((line) => line.split(':', 1)[0]);
    assert.equal(evidencePids.length, 2);
    assert.equal(new Set(evidencePids).size, 1);

    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-1', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
    assert.equal(await startCount(primaryStarts), primaryAfterInit + 2);
    assert.equal(await startCount(witnessStarts), witnessAfterInit + 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persistent transport keeps authority and observer sessions across an idempotent retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-execution-'));
  let registry = null;
  try {
    const effectFile = path.join(root, 'effect.json');
    const adapter = path.join(root, 'adapter.json');
    const primaryStarts = path.join(root, 'primary-starts.log');
    const authorityStarts = path.join(root, 'authority-starts.log');
    const observerStarts = path.join(root, 'observer-starts.log');
    await writeFile(adapter, JSON.stringify({
      executable: process.execPath,
      args: [EXECUTION_ADAPTER, '--effect-file', effectFile, '--start-file', primaryStarts],
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: 'idempotent-transition',
      timeoutMs: 5000,
      transport: 'persistent-jsonl',
      executionAuthority: {
        executable: process.execPath,
        args: [EXECUTION_ADAPTER, '--effect-file', effectFile, '--execution-authority', '--start-file', authorityStarts],
        adapterId: 'idempotent-execution-authority-v1',
        worldId: 'idempotent-transition',
        timeoutMs: 5000,
        transport: 'persistent-jsonl',
      },
      executionObserver: {
        executable: process.execPath,
        args: [EXECUTION_ADAPTER, '--effect-file', effectFile, '--execution-observer', '--start-file', observerStarts],
        adapterId: 'idempotent-execution-observer-v1',
        worldId: 'idempotent-transition',
        timeoutMs: 5000,
        transport: 'persistent-jsonl',
      },
    }));

    registry = loadExternalWorldRegistry(adapter);
    const manifest = {
      schemaVersion: 1,
      worldId: 'idempotent-transition',
      labId: 'persistent-execution-lab',
      seed: 'persistent-execution-seed',
      ...registry.createManifestParts({
        labId: 'persistent-execution-lab',
        seed: 'persistent-execution-seed',
        worldId: 'idempotent-transition',
      }),
    };
    const world = registry.createWorld(manifest, 'idempotent');
    const state = await world.initialState();
    const worldManifest = {
      schemaVersion: manifest.schemaVersion,
      tokenMap: manifest.tokenMap,
      authorityPolicy: manifest.authorityPolicy,
    };
    const action = (await world.actions(worldManifest, state))[0];
    const request = {
      schemaVersion: 1,
      token: action.token,
      basedOnVersion: state.stateVersion,
      policyVersion: manifest.authorityPolicy.policyVersion,
      constraintsDigest: manifest.authorityPolicy.constraintsDigest,
      executionNonce: 'execution:persistent-authority:1',
    };

    const first = await world.transition(state, request);
    const second = await world.transition(state, request);
    assert.equal(first.receipt.status, 'ACCEPTED');
    assert.equal(second.receipt.executionNonce, request.executionNonce);
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    assert.equal(await startCount(primaryStarts), 2);
    assert.equal(await startCount(authorityStarts), 2);
    assert.equal(await startCount(observerStarts), 2);
  } finally {
    await registry?.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function startCount(filePath) {
  try {
    return (await readFile(filePath, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).length;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

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

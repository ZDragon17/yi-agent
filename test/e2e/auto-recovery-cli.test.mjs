import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const CLI = path.resolve('bin/yi-agent.mjs');
const FIXTURE = path.resolve('test/fixtures/idempotent-transition-world-adapter.mjs');

test('agent run rejects auto-recover because it is a resume-only loop policy', async () => {
  const result = await invoke([
    'agent', 'run', '--lab', 'missing', '--steps', '1', '--auto-recover', '--json',
  ]);
  assert.equal(result.code, 64, JSON.stringify(result));
  assert.equal(result.stdout[0]?.error?.code, 'INVALID_INPUT', JSON.stringify(result));
  assert.equal(result.stdout[0]?.error?.message, '--auto-recover requires agent loop --resume.', JSON.stringify(result));
});

test('agent loop resume auto-recovers a force-terminated Run and completes the remaining loop', async () => {
  await withTemporaryLab(async ({ root, lab }) => {
    const effectFile = path.join(root, 'auto-recovery-effect.json');
    const releaseFile = path.join(root, 'release-response');
    const adapter = await writeHeldAdapter(root, effectFile, releaseFile);
    const init = await invoke([
      'init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'auto-recovery-seed',
      '--adapter', adapter, '--json',
    ]);
    assert.equal(init.code, 0, JSON.stringify(init));

    const first = spawnHeldLoop(lab, adapter, 3);
    const firstClosed = waitForClose(first.child, 30_000);
    await waitForEffect(effectFile, 30_000);
    assert.equal(first.child.kill(), true, 'the first CLI must be force-terminable during the Run');
    await writeFile(releaseFile, 'release-response');
    const killed = await firstClosed;
    assert.notEqual(killed.code, 0, 'the force-terminated CLI must not report success');
    assert.equal((await readEffect(effectFile)).effectCount, 1);

    const resumed = await invoke([
      'agent', 'loop', '--lab', lab, '--resume', '--auto-recover', '--kernel-only',
      '--adapter', adapter, '--json',
    ], 30_000);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.stdout[0]?.data?.status, 'COMPLETED', JSON.stringify(resumed));
    assert.equal((await readEffect(effectFile)).effectCount, 3, 'auto-recovery must continue the two remaining logical Runs');

    const inspection = await invoke(['inspect', '--lab', lab, '--adapter', adapter, '--json']);
    assert.equal(inspection.code, 0, JSON.stringify(inspection));
    assert.equal(inspection.stdout[0]?.data?.current?.kernelStep, 3, JSON.stringify(inspection));
    assert.equal(await countRunDirectories(lab), 4, 'recovery must retain the halted attempt and three logical Runs');
  });
});

test('agent loop auto-recover refuses a live old CLI while its external response is held', async () => {
  await withTemporaryLab(async ({ root, lab }) => {
    const effectFile = path.join(root, 'live-owner-effect.json');
    const releaseFile = path.join(root, 'release-live-owner');
    const adapter = await writeHeldAdapter(root, effectFile, releaseFile);
    const init = await invoke([
      'init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'live-owner-seed',
      '--adapter', adapter, '--json',
    ]);
    assert.equal(init.code, 0, JSON.stringify(init));

    const first = spawnHeldLoop(lab, adapter, 2);
    const firstClosed = waitForClose(first.child, 30_000);
    try {
      await waitForEffect(effectFile, 30_000);
      assert.equal(first.child.exitCode, null, 'the old CLI must still be alive while the response is held');
      const runsBefore = await countRunDirectories(lab);

      const contender = await invoke([
        'agent', 'loop', '--lab', lab, '--resume', '--auto-recover', '--kernel-only',
        '--adapter', adapter, '--json',
      ]);
      assert.equal(contender.timedOut, false, JSON.stringify(contender));
      assert.notEqual(contender.code, 0, 'auto-recover must refuse to seize a live writer lock');
      assert.ok(['LIVE_OWNER', 'BUSY'].includes(contender.stdout[0]?.error?.code), JSON.stringify(contender));
      assert.equal(first.child.exitCode, null, 'the contender must not terminate the old CLI');
      assert.equal(await countRunDirectories(lab), runsBefore, 'a blocked auto-recover must not append a Run');
      assert.equal((await readEffect(effectFile)).effectCount, 1, 'a blocked auto-recover must not repeat the effect');
    } finally {
      await writeFile(releaseFile, 'release-live-owner').catch(() => {});
      if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill();
      await firstClosed.catch(() => {});
    }
  });
});

async function writeHeldAdapter(root, effectFile, releaseFile) {
  const config = path.join(root, 'held-transition-adapter.json');
  await writeFile(config, JSON.stringify({
    executable: process.execPath,
    args: [
      FIXTURE,
      '--effect-file', effectFile,
      '--two-actions',
      '--non-idempotent',
      '--reconcilable',
      '--hold-response',
      '--release-file', releaseFile,
    ],
    adapterId: 'idempotent-transition-adapter-v1',
    worldId: 'idempotent-transition',
    timeoutMs: 10_000,
  }));
  return config;
}

function spawnHeldLoop(lab, adapter, runs) {
  const child = spawn(process.execPath, [
    CLI,
    'agent', 'loop', '--lab', lab, '--steps', '1', '--runs', String(runs),
    '--scenario', 'idempotent', '--kernel-only', '--adapter', adapter, '--json',
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  return { child };
}

function invoke(args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, timedOut: true, stdout: parseJsonLines(stdout), stderr });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false, stdout: parseJsonLines(stdout), stderr });
    });
  });
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({ code, signal });
    });
  });
}

async function waitForEffect(effectFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readEffect(effectFile)).effectCount === 1) return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`external effect did not become observable within ${timeoutMs}ms`);
}

async function readEffect(effectFile) {
  return JSON.parse(await readFile(effectFile, 'utf8'));
}

async function countRunDirectories(lab) {
  const entries = await readdir(path.join(lab, 'runs'), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).length;
}

async function withTemporaryLab(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-auto-recovery-e2e-'));
  try {
    await callback({ root, lab: path.join(root, 'lab') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseJsonLines(value) {
  return value.trim() === '' ? [] : value.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
}

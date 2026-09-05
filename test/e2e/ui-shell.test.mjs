import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';

const CLI = path.resolve('bin/yi-agent.mjs');

test('ui shell serves the read-only inspect view without touching the lab', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-ui-shell-e2e-'));
  const lab = path.join(root, 'lab');
  try {
    const init = await invoke(['init', '--lab', lab, '--world', 'temperature', '--seed', 'ui-shell-seed', '--json']);
    assert.equal(init.code, 0, init.stderr);
    const run = await invoke(['run', '--lab', lab, '--run-id', 'run-1', '--steps', '5', '--json']);
    assert.equal(run.code, 0, run.stderr);

    const hashBefore = await labHash(lab);
    const child = spawn(process.execPath, [CLI, 'ui', '--lab', lab, '--port', '0', '--json'], { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
      const listening = await waitForListening(child, () => stdout, () => stderr);
      assert.equal(listening.data.event, 'listening');
      assert.equal(listening.data.host, '127.0.0.1');
      assert.ok(Number.isInteger(listening.data.port) && listening.data.port > 0);
      const base = `http://127.0.0.1:${listening.data.port}`;

      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /yi-agent 只读检查外壳/u);

      const forbidden = await fetch(`${base}/api/state`, { method: 'POST' });
      assert.equal(forbidden.status, 405);
      const missing = await fetch(`${base}/nope`);
      assert.equal(missing.status, 404);

      const first = await (await fetch(`${base}/api/state`)).json();
      assert.equal(first.ok, true);
      assert.equal(first.data.manifest.worldId, 'temperature');
      assert.equal(first.data.current.kernelStep, 5);
      assert.ok(first.data.inspectView);
      const second = await (await fetch(`${base}/api/state`)).json();
      assert.deepEqual(second.data.current, first.data.current);

      const hashAfter = await labHash(lab);
      assert.equal(hashAfter, hashBefore, 'ui shell must not modify the lab directory');
    } finally {
      child.kill();
      await onceExit(child);
    }
    const hashAfterShutdown = await labHash(lab);
    assert.equal(hashAfterShutdown, hashBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ui shell fails closed on a missing lab before listening', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-ui-shell-missing-'));
  try {
    const result = await invoke(['ui', '--lab', path.join(root, 'absent'), '--json']);
    assert.equal(result.code, 70, result.stdout + result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'PATH_ESCAPE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function labHash(lab) {
  const hash = createHash('sha256');
  await walk(lab, (filePath, content) => {
    hash.update(path.relative(lab, filePath).replace(/\\/g, '/u').replace('/u', '/'));
    hash.update(content);
  });
  return hash.digest('hex');
}

async function walk(dir, visit) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const childPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(childPath, visit);
      continue;
    }
    visit(childPath, await readFile(childPath));
  }
}

function waitForListening(child, readStdout, readStderr) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const line = readStdout().split(/\r?\n/u).find((candidate) => candidate.trim().length > 0);
      if (line !== undefined) {
        clearInterval(timer);
        try {
          resolve(JSON.parse(line));
        } catch (error) {
          reject(new Error(`listening line is not JSON: ${line}; stderr=${readStderr()}`));
        }
        return;
      }
      if (child.exitCode !== null || Date.now() - started > 15000) {
        clearInterval(timer);
        reject(new Error(`ui did not print a listening line; stdout=${readStdout()}; stderr=${readStderr()}`));
      }
    }, 50);
  });
}

function onceExit(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}

function invoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

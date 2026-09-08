import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'test-gate.mjs');

test('test gate terminates a hanging node:test child at the configured deadline', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yi-agent-test-gate-watchdog-'));
  const fixture = path.join(directory, 'hanging.test.mjs');

  try {
    await writeFile(
      fixture,
      "import { test } from 'node:test';\nsetInterval(() => {}, 1000);\ntest('hangs', async () => { await new Promise(() => {}); });\n",
      'utf8',
    );

    const result = await invoke([SCRIPT, fixture], {
      YI_AGENT_TEST_GATE_TIMEOUT_MS: '250',
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /test gate timeout/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function invoke(args, extraEnvironment) {
  return new Promise((resolve, reject) => {
    const { NODE_TEST_CONTEXT: _nodeTestContext, ...baseEnvironment } = process.env;
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...baseEnvironment, ...extraEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const deadline = setTimeout(async () => {
      await terminateProcessTree(child.pid);
      reject(new Error('test gate wrapper timed out'));
    }, 3000);
    child.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function terminateProcessTree(pid) {
  if (!Number.isInteger(pid)) return Promise.resolve();

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The child may have exited between the timeout and the kill attempt.
  }
  return Promise.resolve();
}

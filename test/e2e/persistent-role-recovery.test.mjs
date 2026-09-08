import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('test/fixtures/idempotent-transition-world-adapter.mjs');

test('persistent authority response loss resumes with one nonce-bound effect', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-role-recovery-'));
  try {
    const lab = path.join(root, 'lab');
    const adapter = path.join(root, 'adapter.json');
    const effectFile = path.join(root, 'primary-effect.json');
    const authorityEffectFile = path.join(root, 'authority-effect.json');
    await mkdir(root, { recursive: true });
    await writeFile(adapter, JSON.stringify({
      executable: process.execPath,
      args: [ADAPTER, '--effect-file', effectFile],
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: 'idempotent-transition',
      timeoutMs: 5000,
      transport: 'persistent-jsonl',
      executionAuthority: {
        executable: process.execPath,
        args: [ADAPTER, '--effect-file', effectFile, '--execution-authority', '--authority-effect-file', authorityEffectFile, '--drop-execution-response-once'],
        adapterId: 'idempotent-execution-authority-v1',
        worldId: 'idempotent-transition',
        timeoutMs: 5000,
        transport: 'persistent-jsonl',
      },
      executionObserver: {
        executable: process.execPath,
        args: [ADAPTER, '--effect-file', effectFile, '--execution-observer'],
        adapterId: 'idempotent-execution-observer-v1',
        worldId: 'idempotent-transition',
        timeoutMs: 5000,
        transport: 'persistent-jsonl',
      },
    }));

    const init = await invoke([
      'init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'persistent-role-recovery-seed',
      '--lab-id', 'persistent-role-recovery-lab', '--adapter', adapter, '--json',
    ]);
    assert.equal(init.code, 0, JSON.stringify(init));

    const lost = await invoke([
      'run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json',
    ]);
    assert.notEqual(lost.code, 0, JSON.stringify(lost));
    assert.equal(lost.json.error.code, 'WORLD_ADAPTER_PROTOCOL');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    assert.equal(JSON.parse(await readFile(authorityEffectFile, 'utf8')).effectCount, 1);

    const resumed = await invoke([
      'run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json',
    ]);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    assert.equal(JSON.parse(await readFile(authorityEffectFile, 'utf8')).effectCount, 1);

    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
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

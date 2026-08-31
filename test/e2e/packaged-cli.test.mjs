import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const DURABLE_ADAPTER = path.join(PROJECT_ROOT, 'test', 'fixtures', 'durable-counter-world-adapter.mjs');

test('installed package preserves the PowerShell CLI closed loop and replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-packaged-cli-e2e-'));
  const prefix = path.join(root, 'install');
  const lab = path.join(root, 'lab');

  try {
    const packed = await runCommand(NPM, ['pack', '--json', '--pack-destination', root], { cwd: PROJECT_ROOT });
    assert.equal(packed.code, 0, packed.stderr);
    const metadata = JSON.parse(packed.stdout);
    const tarball = path.join(root, metadata[0].filename);

    const installed = await runCommand(NPM, ['install', '--prefix', prefix, tarball, '--no-audit', '--no-fund'], { cwd: PROJECT_ROOT });
    assert.equal(installed.code, 0, installed.stderr);

    const cli = path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'yi-agent.cmd' : 'yi-agent');
    await access(cli);

    const init = await runCli(cli, ['init', '--lab', lab, '--world', 'inventory', '--seed', 'packaged-seed', '--json']);
    assert.equal(init.code, 0, init.stderr);
    assert.equal(init.json.ok, true);

    const loop = await runCli(cli, ['agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '2', '--kernel-only', '--json']);
    assert.equal(loop.code, 0, loop.stderr);
    assert.equal(loop.json.data.status, 'COMPLETED');
    assert.equal(loop.json.data.runs, 2);

    const inspect = await runCli(cli, ['inspect', '--lab', lab, '--json']);
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.equal(inspect.json.data.current.kernelStep, 2);

    for (const result of loop.json.data.results) {
      const replay = await runCli(cli, ['replay', '--lab', lab, '--run', result.runId, '--json']);
      assert.equal(replay.code, 0, replay.stderr);
      assert.equal(replay.json.data.verdict, 'CONSISTENT');
    }

    const externalLab = path.join(root, 'external-lab');
    const externalState = path.join(root, 'external-world', 'state.json');
    const adapterConfig = path.join(root, 'adapter.json');
    await writeFile(adapterConfig, JSON.stringify({
      executable: process.execPath,
      args: [DURABLE_ADAPTER, '--state-file', externalState, '--drop-response-once'],
      adapterId: 'durable-counter-adapter-v1',
      worldId: 'durable-counter',
      timeoutMs: 2000,
    }));

    const externalInit = await runCli(cli, ['init', '--lab', externalLab, '--world', 'durable-counter', '--seed', 'packaged-external-seed', '--adapter', adapterConfig, '--json']);
    assert.equal(externalInit.code, 0, externalInit.stderr);
    const lost = await runCli(cli, ['agent', 'loop', '--lab', externalLab, '--steps', '1', '--runs', '2', '--kernel-only', '--adapter', adapterConfig, '--json']);
    assert.notEqual(lost.code, 0, lost.stderr);
    assert.equal(JSON.parse(await readFile(externalState, 'utf8')).effects.length, 1);

    const resumed = await runCli(cli, ['agent', 'loop', '--lab', externalLab, '--resume', '--kernel-only', '--adapter', adapterConfig, '--json']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.json.data.runs, 2);
    const externalStateAfterResume = JSON.parse(await readFile(externalState, 'utf8'));
    assert.equal(externalStateAfterResume.value, 2);
    assert.equal(externalStateAfterResume.effects.length, 2);
    const externalInspect = await runCli(cli, ['inspect', '--lab', externalLab, '--adapter', adapterConfig, '--json']);
    assert.equal(externalInspect.code, 0, externalInspect.stderr);
    assert.equal(externalInspect.json.data.current.kernelStep, 2);
    for (const result of resumed.json.data.results) {
      const replay = await runCli(cli, ['replay', '--lab', externalLab, '--run', result.runId, '--adapter', adapterConfig, '--json']);
      assert.equal(replay.code, 0, replay.stderr);
      assert.equal(replay.json.data.verdict, 'CONSISTENT');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runCli(cli, args) {
  return runCommand(cli, args, { cwd: PROJECT_ROOT }).then((result) => ({
    ...result,
    json: JSON.parse(result.stdout.trim()),
  }));
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : command,
      process.platform === 'win32'
        ? ['/d', '/s', '/c', [quoteWindowsArg(command), ...args.map(quoteWindowsArg)].join(' ')]
        : args,
      {
      ...options,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (text.length > 0 && !/[\s"&()<>^|]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`;
}

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');

test('a force-killed CLI process recovers its unfinished Run and continues', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-force-kill-e2e-'));
  let releasePending = () => {};
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    requestCount += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const token = /tok_[A-Z0-9]{8,128}/u.exec(body.messages[0].content)?.[0] ?? null;
    const respond = () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        id: 'force-kill',
        model: body.model,
        choices: [{ message: { content: JSON.stringify({ token }) } }],
      }));
    };
    if (requestCount === 2 && !server.released) {
      await new Promise((resolve) => { releasePending = () => { server.released = true; resolve(); }; });
    }
    respond();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'force-kill-test-key',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'force-kill-model',
    YI_AGENT_API_TIMEOUT_MS: '20000',
  };
  const lab = path.join(root, 'lab');
  try {
    const init = await invoke(['init', '--lab', lab, '--world', 'inventory', '--seed', 'force-kill-seed', '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));

    const child = spawn(process.execPath, [CLI, 'agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '2', '--json'], {
      env,
      windowsHide: true,
    });
    const childClosed = waitForClose(child);
    await waitFor(async () => requestCount >= 2 && (await inspectKernelStep(lab)) === 1, 10_000);
    assert.equal(child.kill(), true);
    releasePending();
    const killed = await childClosed;
    assert.notEqual(killed.code, 0, 'force-killed process must not report a successful completion');

    const recovered = await invoke(['recover', '--lab', lab, '--confirm-lock-owner-dead', '--json']);
    assert.equal(recovered.code, 0, JSON.stringify(recovered));
    assert.equal(recovered.stdout[0].data.current.kernelStep, 1);
    assert.equal(recovered.stdout[0].data.reason, 'CRASH_HALTED');

    const continued = await invoke(['agent', 'loop', '--lab', lab, '--resume', '--json'], env);
    assert.equal(continued.code, 0, JSON.stringify(continued));
    const inspection = await invoke(['inspect', '--lab', lab, '--json']);
    assert.equal(inspection.code, 0, JSON.stringify(inspection));
    assert.equal(inspection.stdout[0].data.current.kernelStep, 2);
  } finally {
    server.released = true;
    releasePending();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('a resumed finite loop preserves its durable run budget after a process restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-loop-resume-e2e-'));
  let releasePending = () => {};
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    requestCount += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const token = /tok_[A-Z0-9]{8,128}/u.exec(body.messages[0].content)?.[0] ?? null;
    const respond = () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        id: 'loop-resume',
        model: body.model,
        choices: [{ message: { content: JSON.stringify({ token }) } }],
      }));
    };
    if (requestCount === 2 && !server.released) {
      await new Promise((resolve) => { releasePending = () => { server.released = true; resolve(); }; });
    }
    respond();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'loop-resume-test-key',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'loop-resume-model',
  };
  const lab = path.join(root, 'lab');
  try {
    const init = await invoke(['init', '--lab', lab, '--world', 'temperature', '--seed', 'loop-resume-seed', '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));

    const child = spawn(process.execPath, [CLI, 'agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '2', '--scenario', 'regime-shift', '--json'], {
      env,
      windowsHide: true,
    });
    const childClosed = waitForClose(child);
    await waitFor(async () => requestCount >= 2 && (await inspectKernelStep(lab)) === 1, 10_000);
    assert.equal(child.kill(), true);
    releasePending();
    const killed = await childClosed;
    assert.notEqual(killed.code, 0, 'force-killed process must not report a successful completion');

    const recovered = await invoke(['recover', '--lab', lab, '--confirm-lock-owner-dead', '--json']);
    assert.equal(recovered.code, 0, JSON.stringify(recovered));
    assert.equal(recovered.stdout[0].data.current.kernelStep, 1);

    const resumed = await invoke(['agent', 'loop', '--lab', lab, '--resume', '--json'], env);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.stdout[0].data.runs, 1);
    assert.equal(resumed.stdout[0].data.metrics.executed, 1);
    assert.equal((await inspectKernelStep(lab)), 2);
    const continuation = await LabStore.open({ labPath: lab });
    const resumedContinuation = await continuation.readLoopContinuation();
    assert.equal(resumedContinuation.status, 'COMPLETED');
    assert.equal(resumedContinuation.scenario, 'regime-shift');
  } finally {
    server.released = true;
    releasePending();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

async function inspectKernelStep(lab) {
  const result = await invoke(['inspect', '--lab', lab, '--json']);
  return result.stdout[0]?.data?.current?.kernelStep ?? null;
}

async function invoke(args, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: environment, windowsHide: true });
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

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}

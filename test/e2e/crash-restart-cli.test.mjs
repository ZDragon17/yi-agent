import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';
import { initLab, runContinuous } from '../../src/application/agent-service.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const DURABLE_ADAPTER = path.resolve('test/fixtures/durable-counter-world-adapter.mjs');

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

test('two independent CLIs cannot commit the same resumed loop index twice', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-concurrent-resume-e2e-'));
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    requestCount += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const token = /tok_[A-Z0-9]{8,128}/u.exec(body.messages[0].content)?.[0] ?? null;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'concurrent-resume',
      model: body.model,
      choices: [{ message: { content: JSON.stringify({ token }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'concurrent-resume-test-key',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'concurrent-resume-model',
  };
  const lab = path.join(root, 'lab');
  try {
    await initLab({ labPath: lab, labId: 'concurrent-resume-lab', worldId: 'temperature', seed: 'concurrent-resume-seed' });
    let stopChecks = 0;
    const prepared = await runContinuous({
      labPath: lab,
      stepsPerRun: 1,
      runs: 2,
      shouldStop: () => stopChecks++ > 0,
    });
    assert.equal(prepared.stopReason, 'INTERRUPTED');

    const resumed = await Promise.all([
      invoke(['agent', 'loop', '--lab', lab, '--resume', '--json'], env),
      invoke(['agent', 'loop', '--lab', lab, '--resume', '--json'], env),
    ]);
    assert.equal(resumed.filter((result) => result.code === 0).length, 1, JSON.stringify(resumed));
    assert.equal(requestCount, 1, JSON.stringify(resumed));
    const store = await LabStore.open({ labPath: lab });
    const continuation = await store.readLoopContinuation();
    assert.equal(continuation.status, 'COMPLETED');
    assert.equal((await store.inspect()).current.kernelStep, 2);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('a continuous external loop survives response loss, restart, and replay without duplicating effects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-external-loop-e2e-'));
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const token = /tok_[A-Z0-9]{8,128}/u.exec(body.messages[0].content)?.[0] ?? null;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'external-loop',
      model: body.model,
      choices: [{ message: { content: JSON.stringify({ token }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'external-loop-test-key',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'external-loop-model',
  };
  const offlineEnv = { ...env };
  delete offlineEnv.YI_AGENT_API_KEY;
  delete offlineEnv.ZAI_API_KEY;
  delete offlineEnv.YI_AGENT_MODEL;
  const lab = path.join(root, 'lab');
  const externalState = path.join(root, 'external-world', 'state.json');
  const adapter = path.join(root, 'adapter.json');
  await writeFile(adapter, JSON.stringify({
    executable: process.execPath,
    args: [DURABLE_ADAPTER, '--state-file', externalState, '--drop-response-once'],
    adapterId: 'durable-counter-adapter-v1',
    worldId: 'durable-counter',
    timeoutMs: 2000,
  }));
  try {
    const init = await invoke(['init', '--lab', lab, '--world', 'durable-counter', '--seed', 'external-loop-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));

    const lost = await invoke(['agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '2', '--adapter', adapter, '--json'], env);
    assert.notEqual(lost.code, 0, JSON.stringify(lost));
    assert.equal(JSON.parse(await readFile(externalState, 'utf8')).effects.length, 1);

    const resumed = await invoke(['agent', 'loop', '--lab', lab, '--resume', '--adapter', adapter, '--json'], offlineEnv);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.stdout[0].data.runs, 2);

    const state = JSON.parse(await readFile(externalState, 'utf8'));
    assert.equal(state.value, 2);
    assert.equal(state.effects.length, 2);
    const inspection = await invoke(['inspect', '--lab', lab, '--adapter', adapter, '--json']);
    assert.equal(inspection.code, 0, JSON.stringify(inspection));
    assert.equal(inspection.stdout[0].data.current.kernelStep, 2);
    assert.equal(inspection.stdout[0].data.current.worldState.value, 2);

    for (const result of resumed.stdout[0].data.results) {
      const replay = await invoke(['replay', '--lab', lab, '--run', result.runId, '--adapter', adapter, '--json']);
      assert.equal(replay.code, 0, JSON.stringify(replay));
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    }
    assert.equal(JSON.parse(await readFile(externalState, 'utf8')).effects.length, 2);
  } finally {
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

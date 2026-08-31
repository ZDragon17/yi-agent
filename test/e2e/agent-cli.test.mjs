import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';
import { main } from '../../src/cli.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');

test('agent run uses model proposals inside the replayable closed loop', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-model-e2e-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ authorization: request.headers.authorization, body });
    const token = /tok_[A-Z0-9]{8,128}/u.exec(body.messages[0].content)?.[0];
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'agent-chat',
      model: body.model,
      choices: [{ message: { content: JSON.stringify({ token }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'local-agent-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'local-model',
  };
  const lab = path.join(root, 'lab');
  try {
    const init = await invoke(['init', '--lab', lab, '--world', 'temperature', '--json'], process.env);
    assert.equal(init.code, 0);
    const run = await invoke(['agent', 'run', '--lab', lab, '--steps', '2', '--goal', '保持系统稳定', '--json'], env);
    assert.equal(run.code, 0);
    assert.equal(run.stdout[0].data.status, 'COMPLETED');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].authorization, 'Bearer local-agent-secret');

    const events = (await (await LabStore.open({ labPath: lab })).readRun(run.stdout[0].data.runId)).events;
    const policyEvidence = events.find((event) => event.kind === 'STEP').payload.policyEvidence;
    assert.equal(policyEvidence.source, 'model');
    assert.equal(policyEvidence.applied, true);
    assert.equal(policyEvidence.reason, null);

    const replay = await invoke(['replay', '--lab', lab, '--run', run.stdout[0].data.runId, '--json'], process.env);
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('agent loop commits multiple runs and resumes from the persisted current state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-loop-e2e-'));
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const token = /tok_[A-Z0-9]{8,128}/u.exec(body.messages[0].content)?.[0] ?? null;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'agent-loop', model: body.model, choices: [{ message: { content: JSON.stringify({ token }) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'local-loop-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'local-model',
  };
  const lab = path.join(root, 'lab');
  try {
    assert.equal((await invoke(['init', '--lab', lab, '--world', 'inventory', '--seed', 'loop-seed', '--json'], process.env)).code, 0);
    const loop = await invoke(['agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '3', '--json'], env);
    assert.equal(loop.code, 0);
    assert.equal(loop.stdout[0].data.runs, 3);
    assert.equal(loop.stdout[0].data.metrics.executed, 3);
    const inspection = await invoke(['inspect', '--lab', lab, '--json'], process.env);
    assert.equal(inspection.stdout[0].data.current.kernelStep, 3);
    for (const result of loop.stdout[0].data.results) {
      const replay = await invoke(['replay', '--lab', lab, '--run', result.runId, '--json'], process.env);
      assert.equal(replay.code, 0);
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('agent loop accepts an explicit forever policy without confusing it with a run count', async () => {
  const help = await invoke(['agent', 'loop', '--lab', 'missing', '--steps', '1', '--forever', '--json'], {
    ...process.env,
    YI_AGENT_API_KEY: 'parse-only',
    YI_AGENT_MODEL: 'parse-only-model',
  });
  assert.notEqual(help.code, 64);
  assert.equal(help.stderr.includes('forever and runs are mutually exclusive'), false);
});

test('agent run rejects the loop-only forever policy', async () => {
  const result = await invoke(['agent', 'run', '--lab', 'missing', '--steps', '1', '--forever', '--json'], {
    ...process.env,
    YI_AGENT_API_KEY: 'parse-only',
    YI_AGENT_MODEL: 'parse-only-model',
  });
  assert.equal(result.code, 64);
  assert.equal(result.stdout[0].error.message, '--forever is only supported by agent loop.');
});

test('agent run loads and persists a multi-stage goal plan from PowerShell-facing CLI input', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-plan-e2e-'));
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const token = /tok_[A-Z0-9]{8,128}/u.exec(body.messages[0].content)?.[0] ?? null;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'agent-plan', model: body.model, choices: [{ message: { content: JSON.stringify({ token }) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'local-plan-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'local-plan-model',
  };
  const lab = path.join(root, 'lab');
  const plan = path.join(root, 'plan.json');
  try {
    await writeFile(plan, JSON.stringify({
      schemaVersion: 1,
      rootGoal: '保持系统稳定',
      stages: [
        { id: 'approach', goal: '先接近稳定状态' },
        { id: 'settle', goal: '再维持稳定状态' },
      ],
    }));
    assert.equal((await invoke(['init', '--lab', lab, '--world', 'temperature', '--json'], process.env)).code, 0);
    const result = await invoke(['agent', 'run', '--lab', lab, '--steps', '3', '--goal-plan', plan, '--json'], env);
    assert.equal(result.code, 0);
    assert.equal(result.stdout[0].data.status, 'COMPLETED');
    const inspection = await invoke(['inspect', '--lab', lab, '--json'], process.env);
    assert.equal(inspection.stdout[0].data.current.changeSupervisor.plan.stages.length, 2);
    assert.equal((await invoke(['replay', '--lab', lab, '--run', result.stdout[0].data.runId, '--json'], process.env)).stdout[0].data.verdict, 'CONSISTENT');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('agent loop handles SIGINT at a committed run boundary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-signal-e2e-'));
  let signalled = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('Content-Type', 'application/json');
    setTimeout(() => {
      response.end(JSON.stringify({
        id: 'agent-signal',
        model: body.model,
        choices: [{ message: { content: JSON.stringify({ token: null }) } }],
      }));
    }, 50);
    if (!signalled) {
      signalled = true;
      setTimeout(() => process.emit('SIGINT'), 10);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'local-signal-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'local-signal-model',
  };
  const lab = path.join(root, 'lab');
  try {
    assert.equal((await invoke(['init', '--lab', lab, '--world', 'inventory', '--seed', 'signal-seed', '--json'], process.env)).code, 0);
    const stdout = [];
    const stderr = [];
    const previousEnvironment = {
      YI_AGENT_API_KEY: process.env.YI_AGENT_API_KEY,
      YI_AGENT_API_BASE_URL: process.env.YI_AGENT_API_BASE_URL,
      YI_AGENT_MODEL: process.env.YI_AGENT_MODEL,
    };
    Object.assign(process.env, env);
    let code;
    try {
      code = await main(['agent', 'loop', '--lab', lab, '--steps', '1', '--forever', '--json'], {
        stdout: (value) => stdout.push(JSON.parse(value)),
        stderr: (value) => stderr.push(value),
      });
    } finally {
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    assert.equal(code, 0);
    assert.equal(stderr.length, 0);
    assert.equal(stdout[0].data.stopReason, 'INTERRUPTED');
    assert.equal(stdout[0].data.runs, 1);
    assert.equal((await invoke(['inspect', '--lab', lab, '--json'], process.env)).stdout[0].data.current.kernelStep, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function invoke(args, env, onChild) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    onChild?.(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: parseJsonLines(stdout), stderr }));
  });
}

function parseJsonLines(value) {
  return value.trim().length === 0 ? [] : value.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
}

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
    const run = await invoke(['agent', 'run', '--lab', lab, '--steps', '2', '--scenario', 'regime-shift', '--goal', '保持系统稳定', '--json'], env);
    assert.equal(run.code, 0);
    assert.equal(run.stdout[0].data.status, 'COMPLETED');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].authorization, 'Bearer local-agent-secret');
    assert.match(requests[0].body.messages[0].content, /observationEvidence/u);
    assert.match(requests[0].body.messages[0].content, /regime-shift/u);

    const events = (await (await LabStore.open({ labPath: lab })).readRun(run.stdout[0].data.runId)).events;
    const policyEvidence = events.find((event) => event.kind === 'STEP').payload.policyEvidence;
    assert.equal(policyEvidence.source, 'model');
    assert.equal(policyEvidence.applied, true);
    assert.equal(policyEvidence.reason, null);
    assert.match(policyEvidence.observationDigest, /^sha256:[0-9a-f]{64}$/u);

    const replay = await invoke(['replay', '--lab', lab, '--run', run.stdout[0].data.runId, '--json'], process.env);
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('agent CLI isolates an unavailable HTTP advisor and replays the kernel fallback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-model-outage-e2e-'));
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    requestCount += 1;
    response.statusCode = 503;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ error: { message: 'temporary provider outage' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'local-outage-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'local-outage-model',
  };
  const lab = path.join(root, 'lab');
  try {
    assert.equal((await invoke(['init', '--lab', lab, '--world', 'temperature', '--seed', 'outage-seed', '--json'], process.env)).code, 0);
    const run = await invoke(['agent', 'run', '--lab', lab, '--steps', '2', '--json'], env);
    assert.equal(run.code, 0);
    assert.equal(run.stdout[0].data.status, 'COMPLETED');
    assert.equal(requestCount, 2);
    const events = (await (await LabStore.open({ labPath: lab })).readRun(run.stdout[0].data.runId)).events;
    const stepEvents = events.filter((event) => event.kind === 'STEP');
    assert.equal(stepEvents.length, 2);
    assert.equal(stepEvents.every((event) => event.payload.policyEvidence?.reason === 'MODEL_UNAVAILABLE'), true);
    assert.equal(stepEvents.every((event) => event.payload.policyEvidence?.token === null), true);
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
  const contexts = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    contexts.push(JSON.parse(body.messages[0].content.split('\n').at(-1)));
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
    assert.equal(contexts[0].candidateHistory.length, 0);
    assert.ok(contexts[1].candidateHistory.length >= 1, 'a later Run must receive prior candidate outcomes');
    assert.equal(contexts[1].candidateHistory.at(-1).worldId, 'inventory');
    assert.equal(contexts[1].candidateHistory.at(-1).scenario, 'steady');
    assert.equal(inspection.stdout[0].data.candidateHistory.length, 3);
    assert.equal(inspection.stdout[0].data.candidateHistory.at(-1).worldId, 'inventory');
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

test('a restarted agent run can use candidate history to choose a different safe action', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-candidate-history-e2e-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const context = JSON.parse(body.messages[0].content.split('\n').at(-1));
    requests.push(context);
    const choice = context.capabilities[context.candidateHistory.length === 0 ? 0 : 1];
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'candidate-history-agent',
      model: body.model,
      choices: [{ message: { content: JSON.stringify({ token: choice.token }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'local-candidate-history-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'local-candidate-history-model',
  };
  const lab = path.join(root, 'lab');
  try {
    assert.equal((await invoke(['init', '--lab', lab, '--world', 'temperature', '--seed', 'candidate-history-seed', '--json'], process.env)).code, 0);
    const first = await invoke(['agent', 'run', '--lab', lab, '--steps', '1', '--json'], env);
    const second = await invoke(['agent', 'run', '--lab', lab, '--steps', '1', '--json'], env);
    const third = await invoke(['agent', 'run', '--lab', lab, '--steps', '1', '--json'], env);
    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    assert.equal(third.code, 0);
    assert.equal(requests.length, 3);
    assert.equal(requests[0].candidateHistory.length, 0);
    assert.equal(requests[1].candidateHistory.length, 1);
    assert.equal(requests[2].candidateHistory.at(-1).attempt, 1);
    const store = await LabStore.open({ labPath: lab });
    const firstEvent = (await store.readRun(first.stdout[0].data.runId)).events.find((event) => event.kind === 'STEP');
    const secondEvent = (await store.readRun(second.stdout[0].data.runId)).events.find((event) => event.kind === 'STEP');
    const thirdEvent = (await store.readRun(third.stdout[0].data.runId)).events.find((event) => event.kind === 'STEP');
    assert.notEqual(firstEvent.payload.choice.token, secondEvent.payload.choice.token);
    assert.equal(secondEvent.payload.choice.token, thirdEvent.payload.choice.token);
    const history = await store.readCandidateOutcomes();
    assert.equal(history.length, 3);
    assert.equal(history.at(-1).attempt, 2);
    assert.match(history.at(-1).candidateScopeDigest, /^sha256:[0-9a-f]{64}$/u);
    for (const runId of [first.stdout[0].data.runId, second.stdout[0].data.runId, third.stdout[0].data.runId]) {
      const replay = await invoke(['replay', '--lab', lab, '--run', runId, '--json'], process.env);
      assert.equal(replay.code, 0, JSON.stringify(replay));
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate history stays isolated between WorldPort lab spaces', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-candidate-history-isolation-e2e-'));
  const contexts = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const context = JSON.parse(body.messages[0].content.split('\n').at(-1));
    contexts.push(context);
    const capability = context.capabilities.find((item) => item.allowed && item.safe);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'candidate-history-isolation-agent',
      model: body.model,
      choices: [{ message: { content: JSON.stringify({ token: capability?.token ?? null }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'local-candidate-history-isolation-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'local-candidate-history-isolation-model',
  };
  const temperatureLab = path.join(root, 'temperature-lab');
  const inventoryLab = path.join(root, 'inventory-lab');
  try {
    assert.equal((await invoke(['init', '--lab', temperatureLab, '--world', 'temperature', '--seed', 'isolation-temperature', '--json'], process.env)).code, 0);
    assert.equal((await invoke(['init', '--lab', inventoryLab, '--world', 'inventory', '--seed', 'isolation-inventory', '--json'], process.env)).code, 0);
    const temperatureRun = await invoke(['agent', 'run', '--lab', temperatureLab, '--steps', '1', '--json'], env);
    const inventoryRun = await invoke(['agent', 'run', '--lab', inventoryLab, '--steps', '1', '--json'], env);
    assert.equal(temperatureRun.code, 0);
    assert.equal(inventoryRun.code, 0);
    assert.equal(contexts.length, 2);
    assert.equal(contexts[0].candidateHistory.length, 0);
    assert.equal(contexts[1].candidateHistory.length, 0);
    const temperatureHistory = await (await LabStore.open({ labPath: temperatureLab })).readCandidateOutcomes();
    const inventoryHistory = await (await LabStore.open({ labPath: inventoryLab })).readCandidateOutcomes();
    assert.equal(temperatureHistory.length, 1);
    assert.equal(inventoryHistory.length, 1);
    assert.equal(temperatureHistory[0].worldId, 'temperature');
    assert.equal(inventoryHistory[0].worldId, 'inventory');
    for (const [lab, run] of [[temperatureLab, temperatureRun], [inventoryLab, inventoryRun]]) {
      const replay = await invoke(['replay', '--lab', lab, '--run', run.stdout[0].data.runId, '--json'], process.env);
      assert.equal(replay.code, 0, JSON.stringify(replay));
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('a new agent loop still requires model configuration', async () => {
  const env = { ...process.env };
  delete env.YI_AGENT_API_KEY;
  delete env.ZAI_API_KEY;
  delete env.YI_AGENT_MODEL;
  const result = await invoke(['agent', 'loop', '--lab', 'missing', '--steps', '1', '--runs', '1', '--json'], env);
  assert.equal(result.code, 64);
  assert.match(result.stdout[0].error.message, /YI_AGENT_API_KEY(?: or ZAI_API_KEY)? must be configured/u);
});

test('kernel-only agent run works without model configuration and remains replayable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-kernel-only-e2e-'));
  const lab = path.join(root, 'lab');
  const env = { ...process.env };
  delete env.YI_AGENT_API_KEY;
  delete env.ZAI_API_KEY;
  delete env.YI_AGENT_MODEL;
  try {
    assert.equal((await invoke(['init', '--lab', lab, '--world', 'inventory', '--seed', 'kernel-only-seed', '--json'], process.env)).code, 0);
    const run = await invoke(['agent', 'run', '--lab', lab, '--steps', '2', '--kernel-only', '--json'], env);
    assert.equal(run.code, 0);
    assert.equal(run.stdout[0].data.status, 'COMPLETED');
    const inspection = await invoke(['inspect', '--lab', lab, '--json'], env);
    assert.equal(inspection.code, 0);
    assert.equal(inspection.stdout[0].data.current.kernelStep, 2);
    const replay = await invoke(['replay', '--lab', lab, '--run', run.stdout[0].data.runId, '--json'], env);
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    const loop = await invoke(['agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '2', '--kernel-only', '--json'], env);
    assert.equal(loop.code, 0);
    assert.equal(loop.stdout[0].data.runs, 2);
    assert.equal((await invoke(['inspect', '--lab', lab, '--json'], env)).stdout[0].data.current.kernelStep, 4);
    for (const result of loop.stdout[0].data.results) {
      const loopReplay = await invoke(['replay', '--lab', lab, '--run', result.runId, '--json'], env);
      assert.equal(loopReplay.code, 0);
      assert.equal(loopReplay.stdout[0].data.verdict, 'CONSISTENT');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('agent run uses the bounded automatic planner through the PowerShell-facing CLI', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-auto-plan-e2e-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body.messages[0].content);
    const content = body.messages[0].content.includes('goal planner')
      ? JSON.stringify({
          rootGoal: '自动维持温度',
          stages: [
            { id: 'approach', goal: '先接近稳定值', target: [22.5] },
            { id: 'settle', goal: '再完成稳定值', target: [23] },
          ],
        })
      : JSON.stringify({ token: /tok_[A-Z0-9]{8,128}/u.exec(body.messages[0].content)?.[0] ?? null });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'agent-auto-plan', model: body.model, choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'local-auto-plan-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'local-auto-plan-model',
  };
  const lab = path.join(root, 'lab');
  try {
    assert.equal((await invoke(['init', '--lab', lab, '--world', 'temperature', '--json'], process.env)).code, 0);
    const result = await invoke(['agent', 'run', '--lab', lab, '--steps', '2', '--goal', '自动维持温度', '--auto-plan', '--json'], env);
    assert.equal(result.code, 0);
    assert.equal(result.stdout[0].data.stopReason, 'OBJECTIVE_REACHED');
    assert.equal(requests.length, 3);
    const inspection = await invoke(['inspect', '--lab', lab, '--json'], process.env);
    assert.equal(inspection.stdout[0].data.current.changeSupervisor.plan.revision, 1);
    const runId = result.stdout[0].data.runId;
    const replay = await invoke(['replay', '--lab', lab, '--run', runId, '--json'], process.env);
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('agent CLI persists planner policy across processes and replays a revised plan', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-replan-e2e-'));
  const requests = [];
  let plannerCalls = 0;
  const goal = '持续调整温度';
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = body.messages[0].content;
    requests.push(prompt);
    const isPlanner = prompt.includes('goal planner');
    const content = isPlanner
      ? JSON.stringify({
          rootGoal: goal,
          stages: [{ id: 'active', goal: '调整当前阶段', target: [plannerCalls++ === 0 ? 30 : 25] }],
        })
      : JSON.stringify({ token: /tok_[A-Z0-9]{8,128}/u.exec(prompt)?.[0] ?? null });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'agent-replan', model: body.model, choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'local-replan-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'local-replan-model',
  };
  const lab = path.join(root, 'lab');
  try {
    assert.equal((await invoke(['init', '--lab', lab, '--world', 'temperature', '--seed', 'replan-seed', '--json'], process.env)).code, 0);
    const first = await invoke(['agent', 'run', '--lab', lab, '--steps', '1', '--scenario', 'external-during-step', '--goal', goal, '--auto-plan', '--stagnation-limit', '1', '--json'], env);
    assert.equal(first.code, 0);
    const second = await invoke(['agent', 'run', '--lab', lab, '--steps', '1', '--scenario', 'external-during-step', '--stagnation-limit', '1', '--json'], env);
    assert.equal(second.code, 0);
    assert.equal(plannerCalls, 3);
    assert.equal(requests.filter((prompt) => prompt.includes('goal planner')).length, 3);
    const inspection = await invoke(['inspect', '--lab', lab, '--json'], process.env);
    assert.equal(inspection.code, 0);
    assert.equal(inspection.stdout[0].data.current.changeSupervisor.plan.revision, 2);
    for (const run of [first, second]) {
      const replay = await invoke(['replay', '--lab', lab, '--run', run.stdout[0].data.runId, '--json'], process.env);
      assert.equal(replay.code, 0);
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    }
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

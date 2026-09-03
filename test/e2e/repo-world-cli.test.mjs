import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('examples/repo-world/adapter.mjs');
const REPOSITORY_ROOT = path.resolve('.');
const READ_PATH = 'README.md';
const TEST_PATH = 'test/agent/model-advisor.test.mjs';

test('repo WorldPort uses the same continuous Run and Replay envelope as a built-in WorldPort', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-matrix-e2e-'));
  const adapterConfig = path.join(root, 'adapter.json');
  const environment = { ...process.env };
  await writeFile(adapterConfig, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, REPOSITORY_ROOT, READ_PATH, TEST_PATH],
    adapterId: 'repo-readonly-example-v1',
    worldId: 'repo',
    timeoutMs: 30000,
  }));

  const cases = [
    { id: 'repo', seed: 'repo-matrix-seed', adapter: adapterConfig },
    { id: 'temperature', seed: 'temperature-matrix-seed', adapter: null },
  ];
  try {
    const envelopes = [];
    for (const world of cases) {
      const lab = path.join(root, world.id, 'lab');
      const initArgs = [
        'init', '--lab', lab, '--world', world.id, '--seed', world.seed,
        '--json', ...(world.adapter === null ? [] : ['--adapter', world.adapter]),
      ];
      const loopArgs = [
        'agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '2', '--scenario',
        ...(world.adapter === null ? ['steady'] : ['working-tree']), '--kernel-only', '--json',
        ...(world.adapter === null ? [] : ['--adapter', world.adapter]),
      ];
      const init = await invoke(initArgs, environment);
      assert.equal(init.code, 0, `${world.id} init: ${JSON.stringify(init)}`);
      const loop = await invoke(loopArgs, environment);
      assert.equal(loop.code, 0, `${world.id} loop: ${JSON.stringify(loop)}`);
      const data = loop.stdout[0].data;
      assert.equal(data.status, 'COMPLETED');
      assert.equal(data.runs, 2);
      assert.equal(data.metrics.executed, 2);
      assert.equal(data.results.length, 2);
      assert.equal(new Set(data.results.map((result) => result.runId)).size, 2);
      envelopes.push(data.results.map((result) => Object.keys(result).sort()));

      const inspection = await invoke([
        'inspect', '--lab', lab, '--json',
        ...(world.adapter === null ? [] : ['--adapter', world.adapter]),
      ], environment);
      assert.equal(inspection.code, 0, `${world.id} inspect: ${JSON.stringify(inspection)}`);
      assert.equal(inspection.stdout[0].data.current.kernelStep, 2);
      for (const result of data.results) {
        const replay = await invoke([
          'replay', '--lab', lab, '--run', result.runId, '--json',
          ...(world.adapter === null ? [] : ['--adapter', world.adapter]),
        ], environment);
        assert.equal(replay.code, 0, `${world.id}/${result.runId} replay: ${JSON.stringify(replay)}`);
        assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
      }
      assert.deepEqual(await listRunIds(lab), data.results.map((result) => result.runId).sort());
    }
    assert.deepEqual(envelopes[0], envelopes[1], 'WorldPorts must share the same committed Run result envelope');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read-only repo WorldPort completes the shared loop without writing the repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-e2e-'));
  const requests = [];
  let modelCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const tokens = [...new Set(body.messages[0].content.match(/tok_[A-Z0-9]{8,128}/gu) ?? [])];
    assert.ok(tokens.length >= 2, 'the decision context must expose both repo capabilities');
    const token = tokens[modelCalls++ % 2];
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'repo-agent-chat',
      model: body.model,
      choices: [{ message: { content: JSON.stringify({ token }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'repo-local-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'repo-local-model',
  };
  const adapterConfig = path.join(root, 'adapter.json');
  const lab = path.join(root, 'lab');
  const beforeReadme = await readFile(path.join(REPOSITORY_ROOT, READ_PATH));
  const sentinel = path.join(REPOSITORY_ROOT, '.repo-world-write-sentinel');

  await writeFile(adapterConfig, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, REPOSITORY_ROOT, READ_PATH, TEST_PATH],
    adapterId: 'repo-readonly-example-v1',
    worldId: 'repo',
    timeoutMs: 30000,
  }));

  try {
    const init = await invoke([
      'init', '--lab', lab, '--world', 'repo', '--seed', 'repo-seed',
      '--adapter', adapterConfig, '--json',
    ], process.env);
    assert.equal(init.code, 0);

    const run = await invoke([
      'agent', 'run', '--lab', lab, '--steps', '2', '--scenario', 'working-tree',
      '--adapter', adapterConfig, '--goal', '先读取仓库，再验证测试', '--json',
    ], env);
    assert.equal(run.code, 0);
    assert.equal(run.stdout[0].data.status, 'COMPLETED');
    assert.equal(modelCalls, 2);

    const runId = run.stdout[0].data.runId;
    const store = await LabStore.open({ labPath: lab });
    const events = (await store.readRun(runId)).events;
    const stepEvents = events.filter((event) => event.kind === 'STEP');
    assert.equal(stepEvents.length, 2);
    assert.deepEqual(
      stepEvents.map((event) => event.payload.afterState.worldState.lastAction),
      ['repo.read-file', 'repo.run-tests'],
    );
    assert.equal(stepEvents[0].payload.afterState.worldState.lastReadPath, READ_PATH);
    assert.equal(stepEvents[1].payload.afterState.worldState.lastTestStatus, 'PASS');
    assert.match(stepEvents[1].payload.afterState.worldState.lastTestOutputDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(stepEvents.every((event) => event.payload.policyEvidence?.applied === true), true);

    const replay = await invoke([
      'replay', '--lab', lab, '--run', runId, '--adapter', adapterConfig, '--json',
    ], process.env);
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    assert.equal(modelCalls, 2, 'replay must not call the model again');
    assert.deepEqual(await readFile(path.join(REPOSITORY_ROOT, READ_PATH)), beforeReadme);
    await assert.rejects(access(sentinel));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('repo WorldPort survives a process restart, resumes the remaining Run, and replays both Runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-repo-restart-e2e-'));
  let releasePending = () => {};
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    requestCount += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const tokens = [...new Set(body.messages[0].content.match(/tok_[A-Z0-9]{8,128}/gu) ?? [])];
    assert.ok(tokens.length >= 2, 'the restart decision context must expose both repo capabilities');
    if (requestCount === 2 && !server.released) {
      await new Promise((resolve) => { releasePending = () => { server.released = true; resolve(); }; });
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'repo-restart-chat',
      model: body.model,
      choices: [{ message: { content: JSON.stringify({ token: tokens[requestCount === 1 ? 0 : 1] }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const environment = {
    ...process.env,
    YI_AGENT_API_KEY: 'repo-restart-local-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'repo-restart-local-model',
  };
  const adapterConfig = path.join(root, 'adapter.json');
  const lab = path.join(root, 'lab');
  const beforeReadme = await readFile(path.join(REPOSITORY_ROOT, READ_PATH));
  const sentinel = path.join(REPOSITORY_ROOT, '.repo-world-write-sentinel');
  await writeFile(adapterConfig, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, REPOSITORY_ROOT, READ_PATH, TEST_PATH],
    adapterId: 'repo-readonly-example-v1',
    worldId: 'repo',
    timeoutMs: 30000,
  }));

  try {
    const init = await invoke([
      'init', '--lab', lab, '--world', 'repo', '--seed', 'repo-restart-seed',
      '--adapter', adapterConfig, '--json',
    ], process.env);
    assert.equal(init.code, 0, JSON.stringify(init));

    const child = spawn(process.execPath, [
      CLI, 'agent', 'loop', '--lab', lab, '--steps', '1', '--runs', '2',
      '--scenario', 'working-tree', '--adapter', adapterConfig,
      '--goal', '先读取仓库，再验证测试', '--json',
    ], { env: environment, windowsHide: true });
    const childClosed = invokeChildClose(child);
    try {
      await waitFor(async () => requestCount >= 2 && (await inspectKernelStep(lab, adapterConfig)) === 1, 10_000);
    } catch (error) {
      child.kill();
      const diagnostic = await childClosed;
      error.message += `; requests=${requestCount}; child=${JSON.stringify(diagnostic)}`;
      throw error;
    }
    assert.equal(child.kill(), true);
    releasePending();
    const killed = await childClosed;
    assert.notEqual(killed.code, 0, 'the interrupted repo loop must not report success');

    const recovered = await invoke(['recover', '--lab', lab, '--confirm-lock-owner-dead', '--json']);
    assert.equal(recovered.code, 0, JSON.stringify(recovered));
    assert.equal(recovered.stdout[0].data.current.kernelStep, 1);

    const resumed = await invoke([
      'agent', 'loop', '--lab', lab, '--resume', '--adapter', adapterConfig, '--json',
    ], environment);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.stdout[0].data.status, 'COMPLETED');
    assert.equal(resumed.stdout[0].data.runs, 1);
    assert.equal(await inspectKernelStep(lab, adapterConfig), 2);

    const inspection = await invoke(['inspect', '--lab', lab, '--adapter', adapterConfig, '--json']);
    assert.equal(inspection.code, 0, JSON.stringify(inspection));
    assert.equal(inspection.stdout[0].data.current.worldState.lastAction, 'repo.run-tests');
    assert.equal(inspection.stdout[0].data.current.worldState.lastTestStatus, 'PASS');
    for (const runId of await listRunIds(lab)) {
      const replay = await invoke(['replay', '--lab', lab, '--run', runId, '--adapter', adapterConfig, '--json']);
      assert.equal(replay.code, 0, JSON.stringify(replay));
      assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
    }
    assert.deepEqual(await readFile(path.join(REPOSITORY_ROOT, READ_PATH)), beforeReadme);
    await assert.rejects(access(sentinel));
  } finally {
    server.released = true;
    releasePending();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function invoke(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: parseJsonLines(stdout), stderr }));
  });
}

function invokeChildClose(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function inspectKernelStep(lab, adapterConfig = null) {
  const inspection = await invoke([
    'inspect', '--lab', lab, '--json',
    ...(adapterConfig === null ? [] : ['--adapter', adapterConfig]),
  ]);
  return inspection.stdout[0]?.data?.current?.kernelStep ?? null;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

async function listRunIds(lab) {
  return (await readdir(path.join(lab, 'runs'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function parseJsonLines(value) {
  return value.trim().length === 0 ? [] : value.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
}

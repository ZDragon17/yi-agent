import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

function parseJsonLines(value) {
  return value.trim().length === 0 ? [] : value.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
}

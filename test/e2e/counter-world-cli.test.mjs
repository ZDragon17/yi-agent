import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('examples/counter-world/adapter.mjs');

test('agent run composes with a user-facing external WorldPort example', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-counter-e2e-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const token = /tok_[A-Z0-9]{8,128}/u.exec(body.messages[0].content)?.[0] ?? null;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'counter-agent-chat',
      model: body.model,
      choices: [{ message: { content: JSON.stringify({ token }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const env = {
    ...process.env,
    YI_AGENT_API_KEY: 'counter-local-secret',
    YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    YI_AGENT_MODEL: 'counter-local-model',
  };
  const adapterConfig = path.join(root, 'adapter.json');
  const lab = path.join(root, 'lab');
  await writeFile(adapterConfig, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER],
    adapterId: 'counter-example-v1',
    worldId: 'counter',
    timeoutMs: 5000,
  }));

  try {
    const init = await invoke(['init', '--lab', lab, '--world', 'counter', '--seed', 'counter-seed', '--adapter', adapterConfig, '--json'], process.env);
    assert.equal(init.code, 0);
    const run = await invoke(['agent', 'run', '--lab', lab, '--steps', '2', '--goal', '让计数器稳定增长', '--adapter', adapterConfig, '--json'], env);
    assert.equal(run.code, 0);
    assert.equal(run.stdout[0].data.status, 'COMPLETED');
    assert.equal(requests.length, 2);

    const runId = run.stdout[0].data.runId;
    const events = (await (await LabStore.open({ labPath: lab })).readRun(runId)).events;
    const stepEvents = events.filter((event) => event.kind === 'STEP');
    assert.equal(stepEvents.length, 2);
    assert.equal(stepEvents.every((event) => event.payload.policyEvidence?.applied === true), true);

    const replay = await invoke(['replay', '--lab', lab, '--run', runId, '--adapter', adapterConfig, '--json'], process.env);
    assert.equal(replay.code, 0);
    assert.equal(replay.stdout[0].data.verdict, 'CONSISTENT');
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

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

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

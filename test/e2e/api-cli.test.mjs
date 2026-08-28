import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const CLI = path.resolve('bin/yi-agent.mjs');

test('PowerShell-facing CLI reaches an OpenAI-compatible API over HTTP', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined,
    });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'local-model' }] }));
      return;
    }
    response.end(JSON.stringify({
      id: 'local-chat',
      model: 'local-model',
      choices: [{ message: { content: '本地 API 已接通' } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  try {
    const env = {
      ...process.env,
      YI_AGENT_PROVIDER: 'zhipu-code',
      ZAI_API_KEY: 'local-secret',
      YI_AGENT_API_BASE_URL: baseUrl,
      YI_AGENT_MODEL: 'local-model',
    };
    const connection = await invoke(['api', 'test', '--json'], env);
    assert.equal(connection.code, 0);
    assert.deepEqual(connection.stdout[0].data, { status: 'CONNECTED', modelCount: 1 });

    const ask = await invoke(['ask', '--prompt', '你好', '--json'], env);
    assert.equal(ask.code, 0);
    assert.equal(ask.stdout[0].data.content, '本地 API 已接通');
    assert.equal(requests[0].authorization, 'Bearer local-secret');
    assert.deepEqual(requests[1].body.messages, [{ role: 'user', content: '你好' }]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('CLI rejects an API call before network access when configuration is missing', async () => {
  const env = { ...process.env };
  delete env.YI_AGENT_PROVIDER;
  delete env.YI_AGENT_API_KEY;
  delete env.YI_AGENT_API_BASE_URL;
  delete env.YI_AGENT_MODEL;
  delete env.ZAI_API_KEY;
  const result = await invoke(['api', 'test', '--json'], env);
  assert.equal(result.code, 64);
  assert.equal(result.stdout[0].error.code, 'INVALID_INPUT');
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

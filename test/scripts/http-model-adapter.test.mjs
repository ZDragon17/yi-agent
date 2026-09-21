import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import path from 'node:path';

const ADAPTER = path.resolve('scripts/http-model-adapter.mjs');

test('HTTP model adapter forwards a bounded request without exposing protocol noise', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    const body = JSON.stringify({
      model: 'fixture-http-model',
      choices: [{ message: { content: '{"token":"tok_HTTP1"}' } }],
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const child = spawn(process.execPath, [ADAPTER], {
    env: {
      ...process.env,
      YI_AGENT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      YI_AGENT_API_KEY: 'fixture-secret',
      YI_AGENT_MODEL: 'fixture-http-model',
      YI_AGENT_ADAPTER_HTTP_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  try {
    child.stdin.write(JSON.stringify({
      protocol: 'yi-model-cli',
      version: 1,
      id: 'request-1',
      payload: { prompt: 'bounded prompt' },
    }) + '\n');
    await waitFor(() => output.includes('\n'));
    const response = JSON.parse(output.trim());
    assert.deepEqual(response, {
      protocol: 'yi-model-cli',
      version: 1,
      id: 'request-1',
      ok: true,
      result: { model: 'fixture-http-model', content: '{"token":"tok_HTTP1"}' },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'fixture-http-model');
    assert.equal(requests[0].messages[0].content, 'bounded prompt');
  } finally {
    child.kill();
    await once(child, 'close').catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('HTTP model adapter did not respond in time.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

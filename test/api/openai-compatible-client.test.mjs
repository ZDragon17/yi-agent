import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAICompatibleClient, loadApiConfig } from '../../src/api/openai-compatible-client.mjs';

test('API configuration reads environment variables without requiring a config file', () => {
  const config = loadApiConfig({
    YI_AGENT_API_KEY: ' key-1 ',
    YI_AGENT_MODEL: ' model-1 ',
    YI_AGENT_API_BASE_URL: 'https://example.test/v1/',
    YI_AGENT_API_TIMEOUT_MS: '12000',
  });
  assert.deepEqual(config, {
    apiKey: 'key-1',
    model: 'model-1',
    baseUrl: 'https://example.test/v1',
    timeoutMs: 12000,
  });
});

test('API client sends bearer authentication and performs a connection test', async () => {
  const requests = [];
  const client = createOpenAICompatibleClient({
    apiKey: 'secret-key',
    model: 'model-1',
    baseUrl: 'https://example.test/v1',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(200, { data: [{ id: 'model-1' }] });
    },
  });

  assert.deepEqual(await client.testConnection(), { status: 'CONNECTED', modelCount: 1 });
  assert.equal(requests[0].url, 'https://example.test/v1/models');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-key');
});

test('API client sends a non-streaming chat request and returns the assistant content', async () => {
  let request;
  const client = createOpenAICompatibleClient({
    apiKey: 'secret-key',
    model: 'model-1',
    baseUrl: 'https://example.test/v1',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return response(200, { id: 'chat-1', model: 'model-1', choices: [{ message: { content: '你好' } }], usage: { total_tokens: 2 } });
    },
  });

  assert.deepEqual(await client.chat('请回答'), {
    id: 'chat-1',
    model: 'model-1',
    content: '你好',
    usage: { total_tokens: 2 },
  });
  assert.equal(request.url, 'https://example.test/v1/chat/completions');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(request.body, {
    model: 'model-1',
    messages: [{ role: 'user', content: '请回答' }],
    stream: false,
  });
});

test('API client exposes provider failures without exposing authorization data', async () => {
  const client = createOpenAICompatibleClient({
    apiKey: 'secret-key',
    model: 'model-1',
    fetchImpl: async () => response(401, { error: { message: 'bad key' } }),
  });

  await assert.rejects(client.testConnection(), (error) => {
    assert.equal(error.code, 'API_ERROR');
    assert.equal(error.context.status, 401);
    assert.equal(error.message, 'bad key');
    assert.equal(error.message.includes('secret-key'), false);
    return true;
  });
});

function response(status, body) {
  const raw = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(raw)) : null; } },
    async text() { return raw; },
  };
}

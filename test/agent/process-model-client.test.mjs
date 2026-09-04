import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createProcessModelClient } from '../../src/agent/process-model-client.mjs';

test('process model client accepts one bounded JSONL response', async () => {
  const client = createProcessModelClient({
    executable: process.execPath,
    args: ['--input-type=module', '-e', [
      "process.stdin.on('data', (chunk) => {",
      "  const request = JSON.parse(chunk.toString());",
      "  process.stdout.write(JSON.stringify({ protocol: 'yi-model-cli', version: 1, id: request.id, ok: true, result: { model: 'fixture-model', content: '{\\\"token\\\":\\\"tok_PROCESS1\\\"}' } }) + '\\n');",
      '});',
    ].join('\n')],
    model: 'fixture-model',
    timeoutMs: 1000,
  });

  assert.deepEqual(await client.chat('hello'), {
    model: 'fixture-model',
    content: '{"token":"tok_PROCESS1"}',
  });
});

test('process model client preserves UTF-8 content split across stdout chunks', async () => {
  const client = createProcessModelClient({
    executable: process.execPath,
    args: ['--input-type=module', '-e', [
      "process.stdin.on('data', (chunk) => {",
      "  const request = JSON.parse(chunk.toString());",
      "  const response = JSON.stringify({ protocol: 'yi-model-cli', version: 1, id: request.id, ok: true, result: { model: 'fixture-model', content: '{\\\"token\\\":\\\"tok_PROCESS1\\\",\\\"note\\\":\\\"中\\\"}' } });",
      "  const bytes = Buffer.from(response);",
      "  const split = bytes.indexOf(Buffer.from('中')) + 1;",
      "  process.stdout.write(bytes.subarray(0, split));",
      "  setTimeout(() => process.stdout.write(Buffer.concat([bytes.subarray(split), Buffer.from('\\n')])), 20);",
      '});',
    ].join('\n')],
    model: 'fixture-model',
    timeoutMs: 1000,
  });

  const response = await client.chat('hello');
  assert.equal(response.content, '{"token":"tok_PROCESS1","note":"中"}');
});

test('process model client kills an uncooperative child on caller cancellation', async () => {
  const client = createProcessModelClient({
    executable: process.execPath,
    args: ['--input-type=module', '-e', "process.stdin.resume(); setInterval(() => {}, 1000);"],
    model: 'fixture-model',
    timeoutMs: 5000,
  });
  const controller = new AbortController();
  const result = Promise.race([
    client.chat('never return', { signal: controller.signal }),
    new Promise((resolve) => setTimeout(() => resolve({ code: 'TEST_TIMEOUT' }), 1500)),
  ]);
  setTimeout(() => controller.abort(), 50);

  let error;
  try {
    await result;
  } catch (caught) {
    error = caught;
  }
  assert.notEqual(error?.code, 'TEST_TIMEOUT');
  assert.equal(error?.code, 'MODEL_ADAPTER_CANCELLED');
});

test('process model client terminates a child when cancellation races with spawn', async () => {
  const controller = new AbortController();
  let child;
  const client = createProcessModelClient({
    executable: process.execPath,
    args: [],
    timeoutMs: 1000,
  }, {
    spawnImpl: () => {
      controller.abort();
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        child.exitCode = null;
        child.signalCode = 'SIGTERM';
        child.emit('close', null, 'SIGTERM');
        return true;
      };
      return child;
    },
  });

  await assert.rejects(client.chat('race', { signal: controller.signal }), { code: 'MODEL_ADAPTER_CANCELLED' });
  assert.equal(child.killed, true);
});

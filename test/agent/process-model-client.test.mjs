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

test('persistent process model client reuses one child and serializes JSONL requests', async () => {
  const children = [];
  const client = createProcessModelClient({
    executable: process.execPath,
    args: [],
    transport: 'persistent-jsonl',
    timeoutMs: 1000,
  }, {
    spawnImpl: () => {
      const child = createFakeModelChild();
      children.push(child);
      return child;
    },
  });

  const first = client.chat('first');
  const second = client.chat('second');
  const responses = await Promise.all([first, second]);

  assert.equal(children.length, 1);
  assert.deepEqual(responses.map((response) => response.content), [
    '{"requestId":"1","prompt":"first"}',
    '{"requestId":"2","prompt":"second"}',
  ]);
  await client.close();
  assert.equal(children[0].killed, true);
});

test('persistent process model client rejects the session without replay after timeout', async () => {
  const children = [];
  const client = createProcessModelClient({
    executable: process.execPath,
    args: [],
    transport: 'persistent-jsonl',
    timeoutMs: 100,
  }, {
    spawnImpl: () => {
      const child = createFakeModelChild({ respond: children.length > 0 });
      children.push(child);
      return child;
    },
  });

  const first = client.chat('first');
  const second = client.chat('second');
  await assert.rejects(first, { code: 'MODEL_CALLBACK_TIMEOUT' });
  await assert.rejects(second, { code: 'MODEL_ADAPTER_SESSION' });
  assert.equal(children.length, 1);

  const nextChildResponse = client.chat('next');
  const next = await nextChildResponse;
  assert.equal(children.length, 2);
  assert.equal(next.content, '{"requestId":"3","prompt":"next"}');
  await client.close();
});

test('persistent process model client ignores late output from a terminated child', async () => {
  const children = [];
  const client = createProcessModelClient({
    executable: process.execPath,
    args: [],
    transport: 'persistent-jsonl',
    timeoutMs: 100,
  }, {
    spawnImpl: () => {
      const child = createFakeModelChild({ respond: children.length > 0, lateResponseOnKill: children.length === 0 });
      children.push(child);
      return child;
    },
  });

  await assert.rejects(client.chat('first'), { code: 'MODEL_CALLBACK_TIMEOUT' });
  const next = await client.chat('next');
  assert.equal(next.content, '{"requestId":"2","prompt":"next"}');
  assert.equal(children.length, 2);
  await client.close();
});

test('persistent process model client cancels queued requests immediately', async () => {
  const children = [];
  const client = createProcessModelClient({
    executable: process.execPath,
    args: [],
    transport: 'persistent-jsonl',
    timeoutMs: 100,
  }, {
    spawnImpl: () => {
      const child = createFakeModelChild({ respond: false });
      children.push(child);
      return child;
    },
  });

  const first = client.chat('first');
  const controller = new AbortController();
  const second = client.chat('second', { signal: controller.signal });
  controller.abort();
  await assert.rejects(second, { code: 'MODEL_ADAPTER_CANCELLED' });
  await assert.rejects(first, { code: 'MODEL_CALLBACK_TIMEOUT' });
  assert.equal(children.length, 1);
  await client.close();
});

test('persistent process model client resets buffers when a child exits after a response', async () => {
  const children = [];
  const client = createProcessModelClient({
    executable: process.execPath,
    args: [],
    transport: 'persistent-jsonl',
    timeoutMs: 1000,
  }, {
    spawnImpl: () => {
      const child = createFakeModelChild({ closeAfterResponse: children.length === 0 });
      children.push(child);
      return child;
    },
  });

  const first = await client.chat('first');
  const second = await client.chat('second');
  assert.equal(first.content, '{"requestId":"1","prompt":"first"}');
  assert.equal(second.content, '{"requestId":"2","prompt":"second"}');
  assert.equal(children.length, 2);
  await client.close();
});

test('closing a persistent process model client rejects queued work and prevents future spawn', async () => {
  const children = [];
  const client = createProcessModelClient({
    executable: process.execPath,
    args: [],
    transport: 'persistent-jsonl',
    timeoutMs: 1000,
  }, {
    spawnImpl: () => {
      const child = createFakeModelChild({ respond: false });
      children.push(child);
      return child;
    },
  });

  const first = client.chat('first');
  const second = client.chat('second');
  await client.close();
  await assert.rejects(first, { code: 'MODEL_ADAPTER_CLOSED' });
  await assert.rejects(second, { code: 'MODEL_ADAPTER_CLOSED' });
  await assert.rejects(client.chat('after-close'), { code: 'MODEL_ADAPTER_CLOSED' });
  assert.equal(children.length, 1);
  assert.equal(children[0].killed, true);
});

function createFakeModelChild({ respond = true, lateResponseOnKill = false, closeAfterResponse = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.respond = respond;
  child.closeAfterResponse = closeAfterResponse;
  child.kill = () => {
    if (child.killed) return true;
    child.killed = true;
    child.signalCode = 'SIGTERM';
    if (lateResponseOnKill) {
      setImmediate(() => child.stdout.write(`${JSON.stringify({
        protocol: 'yi-model-cli',
        version: 1,
        id: '1',
        ok: true,
        result: { model: 'late-fixture-model', content: '{"late":true}' },
      })}\n`));
    }
    child.emit('close', null, 'SIGTERM');
    return true;
  };
  child.stdin.on('data', (chunk) => {
    if (!child.respond) return;
    for (const line of chunk.toString('utf8').split(/\r?\n/u).filter(Boolean)) {
      const request = JSON.parse(line);
      setImmediate(() => {
        const response = JSON.stringify({
          protocol: 'yi-model-cli',
          version: 1,
          id: request.id,
          ok: true,
          result: {
            model: 'fixture-model',
            content: JSON.stringify({ requestId: request.id, prompt: request.payload.prompt }),
          },
        });
        child.stdout.write(`${response}${child.closeAfterResponse ? '' : '\n'}`);
        if (child.closeAfterResponse) {
          child.exitCode = 0;
          child.emit('close', 0, null);
        }
      });
    }
  });
  return child;
}

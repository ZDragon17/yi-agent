import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  EffectJournal,
  EffectJournalError,
} from '../../src/effects/effect-journal.mjs';
import {
  createEffectBroker,
  restoreEffectBroker,
} from '../../src/effects/effect-broker.mjs';
import { canonicalDigest } from '../../src/runtime/schema.mjs';

test('EffectJournal flushes a hash-chained JSONL event and rejects tampering', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yi-agent-effect-journal-'));
  const filePath = path.join(directory, 'effects.jsonl');
  try {
    const journal = await EffectJournal.open(filePath);
    const first = await journal.append({
      type: 'INTENT_PLANNED',
      executionNonce: 'nonce:1',
      recordedAt: '2026-01-01T00:00:00.000Z',
      payload: { phase: 'AWAITING_CONFIRMATION' },
    });
    const second = await journal.append({
      type: 'HUMAN_CONFIRMED',
      executionNonce: 'nonce:1',
      recordedAt: '2026-01-01T00:00:01.000Z',
      payload: { phase: 'CONFIRMED' },
    });
    assert.equal(first.sequence, 1);
    assert.equal(second.prevDigest, first.digest);
    assert.equal((await EffectJournal.open(filePath)).read().length, 2);

    const raw = await readFile(filePath, 'utf8');
    await writeFile(filePath, raw.replace('CONFIRMED', 'TAMPERED'), 'utf8');
    await assert.rejects(EffectJournal.open(filePath), (error) => error instanceof EffectJournalError && error.code === 'CORRUPT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('broker recovery rejects a journal with an impossible transition even when its digest is valid', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yi-agent-effect-transition-'));
  const filePath = path.join(directory, 'effects.jsonl');
  try {
    const intent = makeIntent();
    const journal = await EffectJournal.open(filePath);
    await journal.append({
      type: 'EFFECT_APPLIED',
      executionNonce: intent.executionNonce,
      payload: {
        phase: 'APPLIED',
        intent,
        receipt: { status: 'APPLIED', effectDigest: digest('applied') },
        detail: null,
      },
    });
    await assert.rejects(restoreEffectBroker({
      executor: executorWith(),
      journal: await EffectJournal.open(filePath),
    }), (error) => error.code === 'CORRUPT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable broker restores an applied nonce without executing it twice', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yi-agent-effect-broker-'));
  const filePath = path.join(directory, 'effects.jsonl');
  try {
    let executeCount = 0;
    const executor = executorWith({
      execute: async () => { executeCount += 1; return applied(); },
    });
    const journal = await EffectJournal.open(filePath);
    const broker = createEffectBroker({ executor, journal, now: clock() });
    const intent = makeIntent({ requiresConfirmation: true });

    assert.equal((await broker.plan(intent)).phase, 'AWAITING_CONFIRMATION');
    assert.equal(executeCount, 0);
    await broker.confirm(intent.executionNonce);
    assert.equal((await broker.execute(intent.executionNonce)).phase, 'APPLIED');
    assert.equal(executeCount, 1);

    const restoredJournal = await EffectJournal.open(filePath);
    const restored = await restoreEffectBroker({ executor, journal: restoredJournal, now: clock() });
    assert.equal(restored.get(intent.executionNonce).phase, 'APPLIED');
    assert.equal((await restored.execute(intent.executionNonce)).phase, 'APPLIED');
    assert.equal(executeCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recovery converts a durable EXECUTING boundary into reconciliation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yi-agent-effect-recovery-'));
  const filePath = path.join(directory, 'effects.jsonl');
  try {
    let executeCount = 0;
    let reconcileCount = 0;
    const executor = executorWith({
      execute: async () => { executeCount += 1; throw new Error('simulated crash after send'); },
      reconcile: async () => { reconcileCount += 1; return applied(); },
    });
    const journal = await EffectJournal.open(filePath);
    const broker = createEffectBroker({ executor, journal, now: clock() });
    const intent = makeIntent({ requiresConfirmation: false });
    await broker.plan(intent);
    assert.equal((await broker.execute(intent.executionNonce)).phase, 'RECONCILE_REQUIRED');
    assert.equal(executeCount, 1);

    const restored = await restoreEffectBroker({
      executor,
      journal: await EffectJournal.open(filePath),
      now: clock(),
    });
    assert.equal(restored.get(intent.executionNonce).phase, 'RECONCILE_REQUIRED');
    assert.equal((await restored.reconcile(intent.executionNonce)).phase, 'APPLIED');
    assert.equal(reconcileCount, 1);
    assert.equal(executeCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('executor is not called when EXECUTION_STARTED cannot be durably appended', async () => {
  let executeCount = 0;
  const journal = {
    read: () => [],
    async append(event) {
      if (event.type === 'EXECUTION_STARTED') throw new Error('disk unavailable');
      return { ...event, schemaVersion: 1, sequence: 1, digest: 'sha256:' + '0'.repeat(64) };
    },
  };
  const broker = createEffectBroker({
    executor: executorWith({ execute: async () => { executeCount += 1; return applied(); } }),
    journal,
    now: clock(),
  });
  const intent = makeIntent({ requiresConfirmation: false });
  await broker.plan(intent);
  await assert.rejects(broker.execute(intent.executionNonce), /disk unavailable/);
  assert.equal(executeCount, 0);
});

test('compensator is not called when COMPENSATION_STARTED cannot be durably appended', async () => {
  let compensateCount = 0;
  const journal = {
    read: () => [],
    async append(event) {
      if (event.type === 'COMPENSATION_STARTED') throw new Error('disk unavailable');
      return { ...event, schemaVersion: 1, sequence: 1, digest: 'sha256:' + '0'.repeat(64) };
    },
  };
  const broker = createEffectBroker({
    executor: executorWith({
      compensate: async () => { compensateCount += 1; return { status: 'REVERSED', effectDigest: digest('reversed') }; },
    }),
    journal,
    now: clock(),
  });
  const intent = makeIntent({ requiresConfirmation: false });
  await broker.plan(intent);
  await broker.execute(intent.executionNonce);
  await assert.rejects(broker.compensate(intent.executionNonce), /disk unavailable/);
  assert.equal(compensateCount, 0);
});

test('concurrent broker calls serialize executor access and journal sequence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yi-agent-effect-serial-'));
  const filePath = path.join(directory, 'effects.jsonl');
  try {
    let active = 0;
    let maxActive = 0;
    const executor = executorWith({
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return applied();
      },
    });
    const journal = await EffectJournal.open(filePath);
    const broker = createEffectBroker({ executor, journal, now: clock() });
    const intents = Array.from({ length: 8 }, (_, index) => makeIntent({
      executionNonce: `nonce:serial:${index}`,
      requiresConfirmation: false,
    }));
    await Promise.all(intents.map((intent) => broker.plan(intent)));
    const results = await Promise.all(intents.map((intent) => broker.execute(intent.executionNonce)));
    assert.ok(results.every((result) => result.phase === 'APPLIED'));
    assert.equal(maxActive, 1);
    const events = (await EffectJournal.open(filePath)).read();
    assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('independent processes serialize journal append and preserve one digest chain', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yi-agent-effect-cross-process-'));
  const filePath = path.join(directory, 'effects.jsonl');
  try {
    const moduleUrl = pathToFileURL(path.resolve('src/effects/effect-journal.mjs')).href;
    const results = await Promise.all(['a', 'b'].map((worker) => runJournalChild(moduleUrl, filePath, worker)));
    assert.deepEqual(results.map((result) => result.sequence).sort((a, b) => a - b), [1, 2]);
    const events = (await EffectJournal.open(filePath)).read();
    assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
    assert.deepEqual(events.map((event) => event.payload.worker).sort(), ['a', 'b']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('independent broker snapshots reject a stale semantic append and remain replayable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yi-agent-effect-cross-process-broker-'));
  const filePath = path.join(directory, 'effects.jsonl');
  try {
    const intent = makeIntent({ executionNonce: 'nonce:cross:broker' });
    const journal = await EffectJournal.open(filePath);
    const broker = createEffectBroker({ executor: executorWith(), journal, now: clock() });
    assert.equal((await broker.plan(intent)).phase, 'AWAITING_CONFIRMATION');

    const moduleUrl = pathToFileURL(path.resolve('src/effects/effect-broker.mjs')).href;
    const journalModuleUrl = pathToFileURL(path.resolve('src/effects/effect-journal.mjs')).href;
    const results = await Promise.all([
      runBrokerConfirmChild(moduleUrl, journalModuleUrl, filePath, intent.executionNonce),
      runBrokerConfirmChild(moduleUrl, journalModuleUrl, filePath, intent.executionNonce),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.deepEqual(results.filter((result) => !result.ok).map((result) => result.code), ['CONFLICT']);

    const restoredJournal = await EffectJournal.open(filePath);
    const restored = await restoreEffectBroker({ executor: executorWith(), journal: restoredJournal, now: clock() });
    assert.equal(restored.get(intent.executionNonce).phase, 'CONFIRMED');
    assert.equal(restoredJournal.read().filter((event) => event.type === 'HUMAN_CONFIRMED').length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an active cross-process effect operation blocks reconciliation until its result is durable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yi-agent-effect-operation-lock-'));
  const filePath = path.join(directory, 'effects.jsonl');
  const markerPath = path.join(directory, 'execute.started');
  try {
    const intent = makeIntent({ executionNonce: 'nonce:cross:operation-lock' });
    const journal = await EffectJournal.open(filePath);
    const broker = createEffectBroker({ executor: executorWith(), journal, now: clock() });
    await broker.plan(intent);
    await broker.confirm(intent.executionNonce);

    const moduleUrl = pathToFileURL(path.resolve('src/effects/effect-broker.mjs')).href;
    const journalModuleUrl = pathToFileURL(path.resolve('src/effects/effect-journal.mjs')).href;
    const executeChild = runBrokerOperationChild(moduleUrl, journalModuleUrl, filePath, markerPath, 'execute', intent.executionNonce);
    await waitForFile(markerPath);
    const reconcileChild = runBrokerOperationChild(moduleUrl, journalModuleUrl, filePath, markerPath, 'reconcile', intent.executionNonce);
    const [executeResult, reconcileResult] = await Promise.all([executeChild, reconcileChild]);

    assert.deepEqual(executeResult, { kind: 'execute', ok: true, phase: 'APPLIED' });
    assert.equal(reconcileResult.kind, 'reconcile');
    assert.equal(reconcileResult.ok, false);
    assert.equal(reconcileResult.code, 'BUSY');
    const restoredJournal = await EffectJournal.open(filePath);
    const restored = await restoreEffectBroker({ executor: executorWith(), journal: restoredJournal });
    assert.equal(restored.get(intent.executionNonce).phase, 'APPLIED');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an unrelated cross-process journal append does not lose an active effect result', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yi-agent-effect-unrelated-append-'));
  const filePath = path.join(directory, 'effects.jsonl');
  const markerPath = path.join(directory, 'execute.started');
  try {
    const firstIntent = makeIntent({ executionNonce: 'nonce:cross:active' });
    const journal = await EffectJournal.open(filePath);
    const broker = createEffectBroker({ executor: executorWith(), journal, now: clock() });
    await broker.plan(firstIntent);
    await broker.confirm(firstIntent.executionNonce);

    const moduleUrl = pathToFileURL(path.resolve('src/effects/effect-broker.mjs')).href;
    const journalModuleUrl = pathToFileURL(path.resolve('src/effects/effect-journal.mjs')).href;
    const executeChild = runBrokerOperationChild(moduleUrl, journalModuleUrl, filePath, markerPath, 'execute', firstIntent.executionNonce);
    await waitForFile(markerPath);

    const secondJournal = await EffectJournal.open(filePath);
    const secondBroker = createEffectBroker({ executor: executorWith(), journal: secondJournal, now: clock() });
    await secondBroker.plan(makeIntent({ executionNonce: 'nonce:cross:unrelated' }));

    assert.deepEqual(await executeChild, { kind: 'execute', ok: true, phase: 'APPLIED' });
    const restored = await restoreEffectBroker({ executor: executorWith(), journal: await EffectJournal.open(filePath) });
    assert.equal(restored.get(firstIntent.executionNonce).phase, 'APPLIED');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('journal reclaims a lock left by a confirmed dead process', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yi-agent-effect-stale-lock-'));
  const filePath = path.join(directory, 'effects.jsonl');
  try {
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const deadPid = dead.pid;
    await new Promise((resolve, reject) => {
      dead.on('error', reject);
      dead.on('close', resolve);
    });
    await writeFile(`${filePath}.lock`, `${JSON.stringify({
      schemaVersion: 1,
      pid: deadPid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    })}\n`, 'utf8');

    const event = await (await EffectJournal.open(filePath)).append({
      type: 'INTENT_PLANNED',
      executionNonce: 'nonce:stale-lock',
      payload: { recovered: true },
    });
    assert.equal(event.sequence, 1);
    await assert.rejects(readFile(`${filePath}.lock`), (error) => error.code === 'ENOENT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent stale-lock reclaim cannot delete a replacement journal lock', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yi-agent-effect-stale-race-'));
  const filePath = path.join(directory, 'effects.jsonl');
  try {
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const deadPid = dead.pid;
    await new Promise((resolve, reject) => {
      dead.on('error', reject);
      dead.on('close', resolve);
    });
    await writeFile(`${filePath}.lock`, `${JSON.stringify({
      schemaVersion: 1,
      pid: deadPid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    })}\n`, 'utf8');

    const moduleUrl = pathToFileURL(path.resolve('src/effects/effect-journal.mjs')).href;
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => (
      runJournalChild(moduleUrl, filePath, `stale-race-${index}`)
    )));
    assert.deepEqual(results.map((result) => result.sequence).sort((a, b) => a - b), [1, 2, 3, 4]);
    assert.deepEqual((await EffectJournal.open(filePath)).read().map((event) => event.sequence), [1, 2, 3, 4]);
    await assert.rejects(readFile(`${filePath}.lock`), (error) => error.code === 'ENOENT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('malformed reclaim metadata cannot escape its journal directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yi-agent-effect-reclaim-boundary-'));
  const filePath = path.join(directory, 'effects.jsonl');
  const victimPath = path.join(directory, 'victim.claim');
  try {
    await writeFile(victimPath, 'keep', 'utf8');
    await writeFile(`${filePath}.lock.reclaim`, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      nonce: '\\..\\victim',
      createdAt: new Date().toISOString(),
    })}\n`, 'utf8');

    await assert.rejects(
      (await EffectJournal.open(filePath)).append({
        type: 'INTENT_PLANNED',
        executionNonce: 'nonce:reclaim-boundary',
        payload: {},
      }),
      (error) => error instanceof EffectJournalError && error.code === 'CORRUPT',
    );
    assert.equal(await readFile(victimPath, 'utf8'), 'keep');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function makeIntent(overrides = {}) {
  const unsigned = {
    schemaVersion: 1,
    effectId: 'effect:report:move',
    executionNonce: 'nonce:report:1',
    actionToken: 'tok_REPORTMOVE',
    target: { path: 'desktop/report.txt', to: 'desktop/done' },
    precondition: { worldStateDigest: 'sha256:before', stateVersion: 'state:virtual-desktop:0' },
    risk: 'LOW',
    requiresConfirmation: true,
    reversible: true,
    compensation: { operation: 'move-back', to: 'desktop' },
    ...overrides,
  };
  return { ...unsigned, planDigest: canonicalDigest(unsigned) };
}

function executorWith(overrides = {}) {
  return {
    async execute() { return applied(); },
    async reconcile() { return { status: 'ABSENT' }; },
    async compensate() { return { status: 'REVERSED', effectDigest: digest('reversed') }; },
    async reconcileCompensation() { return { status: 'REVERSED', effectDigest: digest('reversed') }; },
    ...overrides,
  };
}

function applied() {
  return { status: 'APPLIED', effectDigest: digest('applied') };
}

function digest(value) {
  return canonicalDigest(value);
}

function clock() {
  let count = 0;
  return () => `2026-01-01T00:00:0${count++}.000Z`;
}

function runJournalChild(moduleUrl, filePath, worker) {
  const code = `
    import { EffectJournal } from '${moduleUrl}';
    const journal = await EffectJournal.open(process.env.JOURNAL_PATH);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const event = await journal.append({
      type: 'INTENT_PLANNED',
      executionNonce: 'nonce:cross:' + process.env.WORKER,
      payload: { worker: process.env.WORKER },
    });
    process.stdout.write(JSON.stringify({ sequence: event.sequence }) + '\\n');
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, JOURNAL_PATH: filePath, WORKER: worker },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(new Error(`journal child failed: code=${code ?? 'null'}, signal=${signal ?? 'null'}, stderr=${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`journal child returned invalid JSON: ${error.message}`));
      }
    });
  });
}

function runBrokerConfirmChild(brokerModuleUrl, journalModuleUrl, filePath, executionNonce) {
  const code = `
    import { EffectJournal } from '${journalModuleUrl}';
    import { restoreEffectBroker } from '${brokerModuleUrl}';
    const executor = {
      async execute() { return { status: 'UNKNOWN' }; },
      async reconcile() { return { status: 'UNKNOWN' }; },
      async compensate() { return { status: 'UNKNOWN' }; },
      async reconcileCompensation() { return { status: 'UNKNOWN' }; },
    };
    try {
      const journal = await EffectJournal.open(process.env.JOURNAL_PATH);
      const broker = await restoreEffectBroker({ executor, journal });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await broker.confirm(process.env.EXECUTION_NONCE);
      process.stdout.write(JSON.stringify({ ok: true, phase: result.phase }) + '\\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? 'UNKNOWN', message: error.message }) + '\\n');
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, JOURNAL_PATH: filePath, EXECUTION_NONCE: executionNonce },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(new Error(`broker child failed: code=${code ?? 'null'}, signal=${signal ?? 'null'}, stderr=${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`broker child returned invalid JSON: ${error.message}`));
      }
    });
  });
}

function runBrokerOperationChild(brokerModuleUrl, journalModuleUrl, filePath, markerPath, kind, executionNonce) {
  const code = `
    import { writeFile } from 'node:fs/promises';
    import { EffectJournal } from '${journalModuleUrl}';
    import { restoreEffectBroker } from '${brokerModuleUrl}';
    const executor = {
      async execute() {
        await writeFile(process.env.MARKER_PATH, 'started', 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return { status: 'APPLIED', effectDigest: 'sha256:' + '1'.repeat(64) };
      },
      async reconcile() { return { status: 'ABSENT' }; },
      async compensate() { return { status: 'UNKNOWN' }; },
      async reconcileCompensation() { return { status: 'UNKNOWN' }; },
    };
    try {
      const journal = await EffectJournal.open(process.env.JOURNAL_PATH);
      const broker = await restoreEffectBroker({ executor, journal });
      const result = await broker.${kind}(process.env.EXECUTION_NONCE);
      process.stdout.write(JSON.stringify({ kind: '${kind}', ok: true, phase: result.phase }) + '\\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ kind: '${kind}', ok: false, code: error.code ?? 'UNKNOWN' }) + '\\n');
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, JOURNAL_PATH: filePath, MARKER_PATH: markerPath, EXECUTION_NONCE: executionNonce },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      if (exitCode !== 0 || signal !== null) {
        reject(new Error(`broker operation child failed: code=${exitCode ?? 'null'}, signal=${signal ?? 'null'}, stderr=${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`broker operation child returned invalid JSON: ${error.message}`));
      }
    });
  });
}

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await readFile(filePath, 'utf8');
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

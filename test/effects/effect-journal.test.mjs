import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
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

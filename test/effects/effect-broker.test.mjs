import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEffectBroker } from '../../src/effects/effect-broker.mjs';
import { canonicalDigest } from '../../src/runtime/schema.mjs';

test('EffectBroker requires confirmation before a risky effect and records the applied receipt', async () => {
  const calls = [];
  const broker = createEffectBroker({
    executor: executorFor(calls),
    now: clock(),
  });
  const intent = makeIntent({ requiresConfirmation: true });

  assert.equal((await broker.plan(intent)).phase, 'AWAITING_CONFIRMATION');
  await assert.rejects(broker.execute(intent.executionNonce), (error) => error.code === 'INVALID_STATE');
  assert.equal((await broker.confirm(intent.executionNonce)).phase, 'CONFIRMED');
  const result = await broker.execute(intent.executionNonce);

  assert.equal(result.phase, 'APPLIED');
  assert.equal(result.receipt.executionNonce, intent.executionNonce);
  assert.deepEqual(calls, ['execute']);
  assert.ok(result.events.some((event) => event.type === 'HUMAN_CONFIRMED'));
});

test('an uncertain execution must reconcile before retrying the same nonce', async () => {
  let executeCount = 0;
  const broker = createEffectBroker({
    executor: {
      async execute() { executeCount += 1; if (executeCount === 1) throw new Error('lost response'); return applied(); },
      async reconcile() { return { status: 'ABSENT' }; },
      async compensate() { return { status: 'REVERSED' }; },
      async reconcileCompensation() { return { status: 'REVERSED' }; },
    },
    now: clock(),
  });
  const intent = makeIntent({ requiresConfirmation: false });
  await broker.plan(intent);

  assert.equal((await broker.execute(intent.executionNonce)).phase, 'RECONCILE_REQUIRED');
  await assert.rejects(broker.execute(intent.executionNonce), (error) => error.code === 'INVALID_STATE');
  assert.equal((await broker.reconcile(intent.executionNonce)).phase, 'CONFIRMED');
  assert.equal((await broker.execute(intent.executionNonce)).phase, 'APPLIED');
  assert.equal(executeCount, 2);
});

test('same nonce is idempotent, while a different plan on that nonce is a conflict', async () => {
  const broker = createEffectBroker({ executor: executorFor([]), now: clock() });
  const intent = makeIntent({ requiresConfirmation: false });
  const first = await broker.plan(intent);
  const second = await broker.plan(intent);
  assert.deepEqual(second, first);
  await assert.rejects(broker.plan(makeIntent({ requiresConfirmation: false, target: { path: 'other' } })), (error) => error.code === 'CONFLICT');
});

test('a non-low-risk intent cannot disable confirmation', async () => {
  const broker = createEffectBroker({ executor: executorFor([]), now: clock() });
  await assert.rejects(
    broker.plan(makeIntent({ risk: 'HIGH', requiresConfirmation: false })),
    (error) => error.code === 'INVALID_INPUT',
  );
});

test('compensation is explicit and cannot be invented for an irreversible effect', async () => {
  const broker = createEffectBroker({ executor: executorFor([]), now: clock() });
  const intent = makeIntent({ requiresConfirmation: false, reversible: false, compensation: null });
  await broker.plan(intent);
  await broker.execute(intent.executionNonce);
  await assert.rejects(broker.compensate(intent.executionNonce), (error) => error.code === 'NOT_REVERSIBLE');
});

test('compensation uncertainty has its own reconciliation path', async () => {
  const broker = createEffectBroker({
    executor: {
      async execute() { return applied(); },
      async reconcile() { return { status: 'APPLIED', effectDigest: digest('applied') }; },
      async compensate() { throw new Error('lost compensation response'); },
      async reconcileCompensation() { return { status: 'REVERSED', effectDigest: digest('reversed') }; },
    },
    now: clock(),
  });
  const intent = makeIntent({ requiresConfirmation: false });
  await broker.plan(intent);
  await broker.execute(intent.executionNonce);
  assert.equal((await broker.compensate(intent.executionNonce)).phase, 'COMPENSATION_UNKNOWN');
  assert.equal((await broker.reconcileCompensation(intent.executionNonce)).phase, 'REVERSED');
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

function executorFor(calls) {
  return {
    async execute() { calls.push('execute'); return applied(); },
    async reconcile() { calls.push('reconcile'); return { status: 'ABSENT' }; },
    async compensate() { calls.push('compensate'); return { status: 'REVERSED', effectDigest: digest('reversed') }; },
    async reconcileCompensation() { calls.push('reconcileCompensation'); return { status: 'REVERSED' }; },
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

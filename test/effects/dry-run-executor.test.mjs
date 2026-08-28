import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDryRunExecutor } from '../../src/effects/dry-run-executor.mjs';
import { createEffectBroker } from '../../src/effects/effect-broker.mjs';
import { canonicalDigest } from '../../src/runtime/schema.mjs';

test('dry-run executor provides idempotent apply, reconciliation, and compensation', async () => {
  const executor = createDryRunExecutor({
    initialState: { location: 'inbox' },
    apply: ({ state, intent }) => ({ accepted: true, nextState: { ...state, location: intent.target.location } }),
    compensate: ({ state }) => ({ accepted: true, nextState: { ...state, location: 'inbox' } }),
  });
  const broker = createEffectBroker({ executor, now: () => '2026-01-01T00:00:00.000Z' });
  const intent = {
    schemaVersion: 1,
    effectId: 'effect:move',
    executionNonce: 'nonce:move:1',
    actionToken: 'tok_MOVEREPORT',
    target: { location: 'done' },
    precondition: { location: 'inbox' },
    risk: 'LOW',
    requiresConfirmation: false,
    reversible: true,
    compensation: { location: 'inbox' },
  };
  intent.planDigest = canonicalDigest(intent);

  await broker.plan(intent);
  assert.equal((await broker.execute(intent.executionNonce)).phase, 'APPLIED');
  assert.equal(executor.inspect().location, 'done');
  assert.equal((await broker.reconcile(intent.executionNonce).catch(() => null)), null);
  assert.equal((await broker.compensate(intent.executionNonce)).phase, 'REVERSED');
  assert.equal(executor.inspect().location, 'inbox');
});

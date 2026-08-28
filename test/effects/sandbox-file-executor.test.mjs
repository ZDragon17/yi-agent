import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createEffectBroker, restoreEffectBroker } from '../../src/effects/effect-broker.mjs';
import { EffectJournal } from '../../src/effects/effect-journal.mjs';
import { createSandboxFileExecutor } from '../../src/effects/sandbox-file-executor.mjs';
import { canonicalDigest } from '../../src/runtime/schema.mjs';

test('sandbox file executor moves, recovers, and compensates a real temporary file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-sandbox-'));
  try {
    await mkdir(path.join(root, 'inbox'));
    await mkdir(path.join(root, 'done'));
    await writeFile(path.join(root, '.yi-agent-sandbox'), 'yi-agent-sandbox-v1\n', 'utf8');
    await writeFile(path.join(root, 'inbox', 'report.txt'), 'report', 'utf8');
    const executor = createSandboxFileExecutor({ sandboxRoot: root });
    const journal = await EffectJournal.open(path.join(root, 'effects.jsonl'));
    const broker = createEffectBroker({ executor, journal, now: clock() });
    const intent = moveIntent();

    await broker.plan(intent);
    await broker.confirm(intent.executionNonce);
    assert.equal((await broker.execute(intent.executionNonce)).phase, 'APPLIED');
    assert.equal(await readFile(path.join(root, 'done', 'report.txt'), 'utf8'), 'report');
    await assert.rejects(readFile(path.join(root, 'inbox', 'report.txt'), 'utf8'), (error) => error.code === 'ENOENT');

    assert.equal((await broker.compensate(intent.executionNonce)).phase, 'REVERSED');
    assert.equal(await readFile(path.join(root, 'inbox', 'report.txt'), 'utf8'), 'report');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox recovery observes a move that happened before the executor response was lost', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-sandbox-recovery-'));
  try {
    await mkdir(path.join(root, 'inbox'));
    await mkdir(path.join(root, 'done'));
    await writeFile(path.join(root, '.yi-agent-sandbox'), 'yi-agent-sandbox-v1\n', 'utf8');
    await writeFile(path.join(root, 'inbox', 'report.txt'), 'report', 'utf8');
    const realExecutor = createSandboxFileExecutor({ sandboxRoot: root });
    const executor = {
      async execute(intent) {
        await realExecutor.execute(intent);
        throw new Error('response lost after rename');
      },
      reconcile: realExecutor.reconcile,
      compensate: realExecutor.compensate,
      reconcileCompensation: realExecutor.reconcileCompensation,
    };
    const journal = await EffectJournal.open(path.join(root, 'effects.jsonl'));
    const broker = createEffectBroker({ executor, journal, now: clock() });
    const intent = moveIntent({ executionNonce: 'nonce:sandbox:recovery' });
    await broker.plan(intent);
    await broker.confirm(intent.executionNonce);
    assert.equal((await broker.execute(intent.executionNonce)).phase, 'RECONCILE_REQUIRED');
    const restored = await restoreEffectBroker({
      executor: realExecutor,
      journal: await EffectJournal.open(path.join(root, 'effects.jsonl')),
      now: clock(),
    });
    assert.equal(restored.get(intent.executionNonce).phase, 'RECONCILE_REQUIRED');
    assert.equal((await restored.reconcile(intent.executionNonce)).phase, 'APPLIED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox executor rejects paths outside its root before touching the filesystem', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-sandbox-boundary-'));
  try {
    await writeFile(path.join(root, '.yi-agent-sandbox'), 'yi-agent-sandbox-v1\n', 'utf8');
    const executor = createSandboxFileExecutor({ sandboxRoot: root });
    await assert.rejects(executor.execute(moveIntent({
      target: { operation: 'move', from: '../outside.txt', to: 'done/outside.txt' },
    })), (error) => error.code === 'INVALID_INPUT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function moveIntent(overrides = {}) {
  const unsigned = {
    schemaVersion: 1,
    effectId: 'effect:file:move',
    executionNonce: 'nonce:sandbox:1',
    actionToken: 'tok_FILEMOVE',
    target: { operation: 'move', from: 'inbox/report.txt', to: 'done/report.txt' },
    precondition: { sourceExists: true, destinationAbsent: true },
    risk: 'HIGH',
    requiresConfirmation: true,
    reversible: true,
    compensation: { operation: 'move-back', from: 'done/report.txt', to: 'inbox/report.txt' },
    ...overrides,
  };
  return { ...unsigned, planDigest: canonicalDigest(unsigned) };
}

function clock() {
  let count = 0;
  return () => `2026-01-01T00:00:0${count++}.000Z`;
}

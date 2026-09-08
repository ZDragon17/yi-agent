import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createEffectBroker } from '../../src/effects/effect-broker.mjs';
import { EffectJournal } from '../../src/effects/effect-journal.mjs';
import { createSandboxFileExecutor } from '../../src/effects/sandbox-file-executor.mjs';
import { createEffectBrokerAuthority } from '../../src/effects/effect-broker-authority.mjs';

test('EffectBroker authority executes and reconciles one sandbox effect by nonce', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-authority-'));
  try {
    await mkdir(path.join(root, 'inbox'));
    await mkdir(path.join(root, 'done'));
    await writeFile(path.join(root, '.yi-agent-sandbox'), 'yi-agent-sandbox-v1\n', 'utf8');
    await writeFile(path.join(root, 'inbox', 'report.txt'), 'report', 'utf8');
    const journal = await EffectJournal.open(path.join(root, 'effects.jsonl'));
    const broker = createEffectBroker({
      journal,
      executor: createSandboxFileExecutor({ sandboxRoot: root }),
      now: clock(),
    });
    const authority = createEffectBrokerAuthority({
      broker,
      effectPlan: {
        effectId: 'effect:file:move',
        target: { operation: 'move', from: 'inbox/report.txt', to: 'done/report.txt' },
        precondition: { sourceExists: true, destinationAbsent: true },
        risk: 'LOW',
        requiresConfirmation: false,
        reversible: true,
        compensation: { operation: 'move-back', from: 'done/report.txt', to: 'inbox/report.txt' },
        afterStateDigest: 'sha256:' + '2'.repeat(64),
      },
      descriptor: { adapterId: 'effect-broker-authority-v1' },
    });
    const payload = executionPayload();

    assert.equal((await authority.executeExecution(payload)).status, 'EXECUTED');
    assert.equal(await readFile(path.join(root, 'done', 'report.txt'), 'utf8'), 'report');
    assert.equal((await authority.executeExecution(payload)).status, 'EXECUTED');

    const reconciled = await authority.reconcileExecution(payload);
    assert.equal(reconciled.status, 'RECONCILED');
    assert.equal(reconciled.afterStateDigest, 'sha256:' + '2'.repeat(64));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('EffectBroker authority never auto-executes a confirmation-gated plan', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-authority-confirm-'));
  try {
    await mkdir(path.join(root, 'inbox'));
    await mkdir(path.join(root, 'done'));
    await writeFile(path.join(root, '.yi-agent-sandbox'), 'yi-agent-sandbox-v1\n', 'utf8');
    await writeFile(path.join(root, 'inbox', 'report.txt'), 'report', 'utf8');
    const broker = createEffectBroker({
      journal: await EffectJournal.open(path.join(root, 'effects.jsonl')),
      executor: createSandboxFileExecutor({ sandboxRoot: root }),
      now: clock(),
    });
    const authority = createEffectBrokerAuthority({
      broker,
      effectPlan: {
        effectId: 'effect:file:move',
        target: { operation: 'move', from: 'inbox/report.txt', to: 'done/report.txt' },
        precondition: {},
        risk: 'HIGH',
        requiresConfirmation: true,
        reversible: true,
        compensation: { operation: 'move-back', from: 'done/report.txt', to: 'inbox/report.txt' },
      },
      descriptor: { adapterId: 'effect-broker-authority-v1' },
    });

    await assert.rejects(authority.executeExecution(executionPayload()), (error) => error.code === 'CONFIRMATION_REQUIRED');
    await assert.rejects(readFile(path.join(root, 'done', 'report.txt')), (error) => error.code === 'ENOENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function executionPayload() {
  return {
    schemaVersion: 1,
    worldId: 'idempotent-transition',
    scenario: 'idempotent',
    executionNonce: 'execution:step:1',
    token: 'tok_IDEMPOTENT',
    basedOnVersion: 'state:idempotent-transition:0',
    beforeStateDigest: 'sha256:' + '1'.repeat(64),
  };
}

function clock() {
  let count = 0;
  return () => `2026-01-01T00:00:0${count++}.000Z`;
}

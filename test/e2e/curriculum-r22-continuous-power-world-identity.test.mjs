import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LabStore } from '../../src/runtime/lab-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADAPTER = path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs');
const MODEL_ADAPTER = path.join(ROOT, 'test/fixtures/continuous-power-model-adapter.mjs');

function request(op, payload = {}, args = ['--utility-mode', '--continuous-power']) {
  const body = { protocol: 'yi-world-cli', version: 1, id: `r22-${op}`, op, payload };
  const result = spawnSync(process.execPath, [ADAPTER, ...args], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, input: `${JSON.stringify(body)}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.ok, true);
  return response.result;
}

function initialState() {
  return request('initialState').state;
}

function transition(state, proposal) {
  const entries = [{ token: 'set-power', capabilityId: 'ess.set-power' }];
  return request('transition', {
    state,
    request: {
      token: 'set-power',
      ...(proposal === undefined ? {} : { proposal }),
      executionNonce: 'execution:step:1',
      basedOnVersion: 'arbitrage:0',
      policyVersion: 'policy:ess-arbitrage:1',
      constraintsDigest: 'sha256:fixture',
    },
    manifest: { tokenMap: { entries } },
  });
}

test('continuous ESS power is a distinct WorldPort capability identity', () => {
  const continuous = request('hello');
  const discrete = request('hello', {}, ['--utility-mode']);
  assert.equal(continuous.worldVersion, 'ess-arbitrage-2-d2-utility-v1-continuous-power-v1');
  assert.deepEqual(continuous.capabilityIds, ['ess.set-power']);
  assert.equal(discrete.worldVersion, 'ess-arbitrage-2-d2-utility-v1');
});

test('continuous ESS power accepts bounded decimal proposals and rejects unsafe values', () => {
  const accepted = transition(initialState(), { powerKw: 37.5 });
  assert.equal(accepted.receipt.status, 'ACCEPTED');
  assert.equal(accepted.nextWorldState.soc, 54.453);

  const missing = transition(initialState());
  assert.equal(missing.receipt.status, 'REJECTED');
  assert.equal(missing.receipt.rejectionReason, 'INVALID_POWER_PROPOSAL');

  const malformed = transition(initialState(), { powerKw: 100.1234 });
  assert.equal(malformed.receipt.status, 'REJECTED');
  assert.equal(malformed.receipt.rejectionReason, 'INVALID_POWER_PROPOSAL');

  const exportAttempt = transition(initialState(), { powerKw: -100 });
  assert.equal(exportAttempt.receipt.status, 'REJECTED');
  assert.equal(exportAttempt.receipt.rejectionReason, 'GRID_EXPORT_NOT_ALLOWED');
});

test('continuous ESS proposals cross the real CLI model boundary and replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-r22-proposal-e2e-'));
  const adapterConfig = path.join(root, 'adapter.json');
  const modelConfig = path.join(root, 'model.json');
  const lab = path.join(root, 'lab');
  await writeFile(adapterConfig, JSON.stringify({
    executable: process.execPath,
    args: [ADAPTER, '--utility-mode', '--continuous-power'],
    adapterId: 'ess-arbitrage-adapter-v1',
    worldId: 'ess-arbitrage',
    timeoutMs: 30000,
    transport: 'persistent-jsonl',
  }));
  await writeFile(modelConfig, JSON.stringify({
    executable: process.execPath,
    args: [MODEL_ADAPTER],
    model: 'continuous-power-fixture',
    timeoutMs: 5000,
  }));
  try {
    const init = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), 'init', '--lab', lab, '--world', 'ess-arbitrage', '--seed', 'r22-proposal-seed', '--adapter', adapterConfig, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.equal(init.status, 0, init.stderr);
    const run = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), 'agent', 'run', '--lab', lab, '--run-id', 'r', '--steps', '4', '--adapter', adapterConfig, '--model-adapter', modelConfig, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    const ledger = await LabStore.open({ labPath: lab });
    const steps = (await ledger.readRun('r')).events.filter((event) => event.kind === 'STEP');
    assert.equal(steps.length, 4);
    assert.deepEqual(steps.map((event) => event.payload.policyEvidence?.proposal?.powerKw), [37.5, -37.5, 12.5, -12.5]);
    assert.equal(steps.every((event) => event.payload.policyEvidence?.applied === true), true);
    const replay = spawnSync(process.execPath, [path.join(ROOT, 'bin/yi-agent.mjs'), 'replay', '--lab', lab, '--run', 'r', '--adapter', adapterConfig, '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.equal(replay.status, 0, replay.stderr);
    assert.match(replay.stdout, /CONSISTENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADAPTER = path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs');

function request(args, op, payload = {}) {
  const input = JSON.stringify({ protocol: 'yi-world-cli', version: 1, id: `r21-${op}`, op, payload });
  const result = spawnSync(process.execPath, [ADAPTER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    input: `${input}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.ok, true);
  return response.result;
}

test('fine-grained ESS actions are an explicit WorldPort identity', () => {
  const steady = request(['--utility-mode'], 'hello');
  const fine = request(['--utility-mode', '--fine-grained-actions'], 'hello');

  assert.equal(steady.worldVersion, 'ess-arbitrage-2-d2-utility-v1');
  assert.equal(fine.worldVersion, 'ess-arbitrage-2-d2-utility-v1-power-grid-v1');
  assert.deepEqual(fine.capabilityIds, [
    'ess.charge',
    'ess.charge-half',
    'ess.discharge-half',
    'ess.discharge',
    'ess.idle',
  ]);
});

test('fine-grained ESS actions expose independent SOC and grid safety', () => {
  const state = request(['--utility-mode', '--fine-grained-actions'], 'initialState').state;
  const hello = request(['--utility-mode', '--fine-grained-actions'], 'hello');
  const entries = hello.capabilityIds.map((capabilityId, index) => ({ token: `token-${index}`, capabilityId }));
  const actions = request(['--utility-mode', '--fine-grained-actions'], 'actions', {
    state,
    manifest: { tokenMap: { entries } },
  }).actions;

  assert.equal(actions.length, 5);
  assert.deepEqual(actions.map((item) => item.safe), [true, true, true, false, true]);

  const transition = request(['--utility-mode', '--fine-grained-actions'], 'transition', {
    state,
    request: {
      token: 'token-1',
      executionNonce: 'execution:step:1',
      basedOnVersion: 'arbitrage:0',
      policyVersion: 'policy:ess-arbitrage:1',
      constraintsDigest: 'sha256:fixture',
    },
    manifest: { tokenMap: { entries } },
  });
  assert.equal(transition.receipt.status, 'ACCEPTED');
  assert.equal(transition.nextWorldState.soc, 55.938);
});

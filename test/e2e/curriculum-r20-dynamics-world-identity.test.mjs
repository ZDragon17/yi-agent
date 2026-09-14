import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADAPTER = path.join(ROOT, 'examples/curriculum/ess-arbitrage/adapter.mjs');

function describeWorld(args) {
  const request = {
    protocol: 'yi-world-cli',
    version: 1,
    id: 'r20-descriptor',
    op: 'hello',
    payload: {},
  };
  const result = spawnSync(process.execPath, [ADAPTER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    input: `${JSON.stringify(request)}\n`,
  });

  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.ok, true);
  assert.equal(response.id, request.id);
  return response.result;
}

function chargeSoc(args) {
  const state = {
    schemaVersion: 1,
    stateVersion: 'arbitrage:0',
    revision: 0,
    hour: 0,
    soc: 50,
    lastNonce: null,
    chargeNonces: [],
    chainToRelease: null,
    pendingSettlements: [],
    usedExecutionNonces: [],
    utilityYuan: 0,
  };
  const request = {
    protocol: 'yi-world-cli',
    version: 1,
    id: 'r20-transition',
    op: 'transition',
    payload: {
      state,
      request: {
        token: 'charge',
        executionNonce: 'execution:step:1',
        basedOnVersion: 'arbitrage:0',
        policyVersion: 'policy:ess-arbitrage:1',
        constraintsDigest: 'sha256:fixture',
      },
      manifest: {
        tokenMap: { entries: [{ token: 'charge', capabilityId: 'ess.charge' }] },
      },
    },
  };
  const result = spawnSync(process.execPath, [ADAPTER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    input: `${JSON.stringify(request)}\n`,
  });

  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.ok, true);
  assert.equal(response.result.receipt.status, 'ACCEPTED');
  return response.result.nextWorldState.soc;
}

test('ESS efficiency stress changes world identity without changing the baseline identity', () => {
  const steady = describeWorld(['--utility-mode']);
  const stressed = describeWorld(['--utility-mode', '--battery-efficiency', '0.85']);
  const stressedChain = describeWorld(['--utility-mode', '--chain-credit', '--battery-efficiency', '0.85']);

  assert.equal(steady.worldVersion, 'ess-arbitrage-2-d2-utility-v1');
  assert.equal(stressed.worldVersion, 'ess-arbitrage-2-d2-utility-v1-battery-efficiency-0.85');
  assert.equal(stressedChain.worldVersion, 'ess-arbitrage-2-d2-utility-v1-chain-v2-battery-efficiency-0.85');
});

test('ESS efficiency stress changes the public SOC transition', () => {
  assert.equal(chargeSoc(['--utility-mode']), 61.875);
  assert.equal(chargeSoc(['--utility-mode', '--battery-efficiency', '0.85']), 60.625);
});

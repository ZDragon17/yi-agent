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
    id: 'r19-descriptor',
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

test('ESS load stress changes world identity without changing the steady identity', () => {
  const steady = describeWorld(['--utility-mode']);
  const stressed = describeWorld(['--utility-mode', '--load-shift-at', '48', '--load-scale', '1.2']);
  const stressedChain = describeWorld([
    '--utility-mode', '--chain-credit', '--load-shift-at', '48', '--load-scale', '1.2',
  ]);

  assert.equal(steady.worldVersion, 'ess-arbitrage-2-d2-utility-v1');
  assert.equal(stressed.worldVersion, 'ess-arbitrage-2-d2-utility-v1-load-scale-1.2-at-48');
  assert.equal(stressedChain.worldVersion, 'ess-arbitrage-2-d2-utility-v1-chain-v2-load-scale-1.2-at-48');
});

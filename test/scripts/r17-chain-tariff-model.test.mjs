import assert from 'node:assert/strict';
import test from 'node:test';
import { tariffPriceAt } from '../../scripts/curriculum/r17-chain-tariff-model.mjs';

test('R17 reverses only peak and valley prices from hour 48 onward', () => {
  assert.equal(tariffPriceAt(0), 0.35);
  assert.equal(tariffPriceAt(8), 1.2);
  assert.equal(tariffPriceAt(48), 1.2);
  assert.equal(tariffPriceAt(56), 0.35);
  assert.equal(tariffPriceAt(60), 0.7);
});

test('R17 tariff oracle rejects invalid simulation hours', () => {
  assert.throws(() => tariffPriceAt(-1), /non-negative integer/u);
  assert.throws(() => tariffPriceAt(1.5), /non-negative integer/u);
});

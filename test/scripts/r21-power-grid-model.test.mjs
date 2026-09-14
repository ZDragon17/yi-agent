import assert from 'node:assert/strict';
import test from 'node:test';
import { batteryStepAtPower, essPowerForCapability } from '../../scripts/curriculum/r21-power-grid-model.mjs';

test('R21 power grid oracle preserves full and half ESS dynamics', () => {
  assert.equal(batteryStepAtPower(50, 100), 61.875);
  assert.equal(batteryStepAtPower(50, 50), 55.938);
  assert.equal(batteryStepAtPower(50, -50), 43.421);
  assert.equal(essPowerForCapability('ess.discharge-half'), -50);
});

test('R21 power grid oracle rejects unknown capability ids', () => {
  assert.throws(() => essPowerForCapability('ess.charge-quarter'), /unknown R21 ESS capability/u);
});

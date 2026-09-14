import assert from 'node:assert/strict';
import test from 'node:test';
import { BASE_BATTERY_EFFICIENCY, BATTERY_EFFICIENCY, batteryStepAtEfficiency } from '../../scripts/curriculum/r20-dynamics-interaction-model.mjs';

test('R20 independent SOC oracle reflects the stressed ESS efficiency', () => {
  assert.equal(BASE_BATTERY_EFFICIENCY, 0.95);
  assert.equal(BATTERY_EFFICIENCY, 0.85);
  assert.equal(batteryStepAtEfficiency(50, 100), 60.625);
  assert.equal(batteryStepAtEfficiency(50, -100), 35.294);
});

test('R20 SOC oracle rejects invalid efficiency', () => {
  assert.throws(() => batteryStepAtEfficiency(50, 100, 0), /efficiency/u);
  assert.throws(() => batteryStepAtEfficiency(50, 100, 1.1), /efficiency/u);
});

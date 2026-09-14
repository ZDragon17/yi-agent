import { PRICE_LEVELS_BY_HOUR, TOU_TARIFF } from '../../examples/energy/shared/energy-sim.mjs';

export const TARIFF_SHIFT_AT = 48;

export function tariffPriceAt(hour) {
  if (!Number.isSafeInteger(hour) || hour < 0) {
    throw new TypeError('hour must be a non-negative integer');
  }

  const baseLevel = PRICE_LEVELS_BY_HOUR[hour % 24];
  const level = hour < TARIFF_SHIFT_AT
    ? baseLevel
    : baseLevel === 0
      ? 2
      : baseLevel === 2
        ? 0
        : 1;
  return [TOU_TARIFF.valley, TOU_TARIFF.flat, TOU_TARIFF.peak][level];
}

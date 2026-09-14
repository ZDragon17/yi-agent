import { loadKw } from '../../examples/energy/shared/energy-sim.mjs';

export const LOAD_SHIFT_AT = 48;
export const LOAD_SCALE = 1.2;

export function loadForHour(hour, stressed) {
  if (!Number.isSafeInteger(hour) || hour < 0) {
    throw new TypeError('hour must be a non-negative integer');
  }
  const base = loadKw(hour);
  return stressed && hour >= LOAD_SHIFT_AT
    ? Math.round(base * LOAD_SCALE * 1000) / 1000
    : base;
}

import { BATTERY } from '../../examples/energy/shared/energy-sim.mjs';

export const BASE_BATTERY_EFFICIENCY = BATTERY.efficiency;
export const BATTERY_EFFICIENCY = 0.85;

export function batteryStepAtEfficiency(soc, powerKw, efficiency = BATTERY_EFFICIENCY, hours = 1) {
  if (!Number.isFinite(soc) || !Number.isFinite(powerKw) || !Number.isFinite(efficiency) || efficiency <= 0 || efficiency > 1) {
    throw new TypeError('soc, powerKw, and efficiency must be finite; efficiency must be in (0, 1]');
  }
  const deltaSoc = (powerKw * hours * (powerKw > 0 ? efficiency : 1 / efficiency) * 100) / BATTERY.capacityKWh;
  return Math.round(Math.min(100, Math.max(0, soc + deltaSoc)) * 1000) / 1000;
}

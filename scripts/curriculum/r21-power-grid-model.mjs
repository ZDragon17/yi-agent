const BATTERY_CAPACITY_KWH = 800;
const BATTERY_EFFICIENCY = 0.95;

export const ESS_POWER_BY_CAPABILITY = Object.freeze({
  'ess.charge': 100,
  'ess.charge-half': 50,
  'ess.discharge-half': -50,
  'ess.discharge': -100,
  'ess.idle': 0,
});

export function batteryStepAtPower(soc, powerKw, hours = 1) {
  const multiplier = powerKw > 0 ? BATTERY_EFFICIENCY : 1 / BATTERY_EFFICIENCY;
  const deltaSoc = (powerKw * hours * multiplier * 100) / BATTERY_CAPACITY_KWH;
  return Math.round(Math.min(100, Math.max(0, soc + deltaSoc)) * 1000) / 1000;
}

export function essPowerForCapability(capabilityId) {
  const power = ESS_POWER_BY_CAPABILITY[capabilityId];
  if (power === undefined) throw new TypeError(`unknown R21 ESS capability: ${capabilityId}`);
  return power;
}

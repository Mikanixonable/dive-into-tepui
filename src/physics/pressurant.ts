export type PressurantGasType = 'nitrogen' | 'helium';
const GAS_CONSTANT = 8.314462618;
const MOLAR_MASS: Record<PressurantGasType, number> = { nitrogen: 0.0280134, helium: 0.004002602 };

export function pressurantMassFor(propellantVolume: number, tankPressureMpa: number, gas: PressurantGasType, temperatureK = 293.15): number {
  if (propellantVolume < 0 || tankPressureMpa < 0 || !(temperatureK > 0)) throw new RangeError('invalid pressurant inputs');
  return tankPressureMpa * 1e6 * propellantVolume * MOLAR_MASS[gas] / (GAS_CONSTANT * temperatureK);
}

export function autogenousBoiloffRate(propellantId: string, tankPressureMpa: number, flowRate: number): number {
  if (tankPressureMpa < 0 || flowRate < 0) throw new RangeError('invalid boiloff inputs');
  const cryogenic = propellantId === 'liquid-hydrogen' || propellantId === 'liquid-oxygen' || propellantId === 'liquid-methane';
  return cryogenic ? flowRate * Math.min(0.2, 0.01 + tankPressureMpa * 0.002) : 0;
}

export function remainingBurnTime(pressurantMass: number, flowRate: number, tankPressureMpa: number, gas: PressurantGasType, propellantVolume = 1, temperatureK = 293.15): number {
  if (pressurantMass < 0 || flowRate < 0) throw new RangeError('invalid remaining-time inputs');
  if (flowRate === 0) return Infinity;
  const massPerSecond = pressurantMassFor(propellantVolume, tankPressureMpa, gas, temperatureK);
  return massPerSecond === 0 ? 0 : pressurantMass / massPerSecond;
}

export function thrustScaleFromPressure(tankPressureMpa: number, requiredPressureMpa: number, cycle: 'pressure_fed' | 'pump_fed'): number {
  if (tankPressureMpa < 0 || requiredPressureMpa < 0) throw new RangeError('invalid pressure');
  if (requiredPressureMpa === 0) return 1;
  if (cycle === 'pump_fed') return tankPressureMpa >= requiredPressureMpa ? 1 : 0;
  return Math.max(0, Math.min(1, tankPressureMpa / requiredPressureMpa));
}

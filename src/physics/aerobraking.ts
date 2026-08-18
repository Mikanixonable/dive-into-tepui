export interface AerobrakingStep { readonly deceleration: number; readonly heatJ: number; readonly ablatorConsumedKg: number; }
export function aerobrakingStep(density: number, speed: number, cdAreaOverMass: number, dt: number, ablatorKg: number, ablationPerHeat: number): AerobrakingStep {
  if (density < 0 || speed < 0 || cdAreaOverMass < 0 || dt < 0 || ablatorKg < 0) throw new RangeError('invalid aerobraking input');
  const deceleration = 0.5 * density * speed * speed * cdAreaOverMass;
  const heatJ = deceleration * speed * dt;
  const ablatorConsumedKg = Math.min(ablatorKg, heatJ * Math.max(0, ablationPerHeat));
  return { deceleration, heatJ, ablatorConsumedKg };
}
export function radiatorPerformance(backgroundTemperatureK: number): number {
  if (backgroundTemperatureK < 0) throw new RangeError('temperature below absolute zero');
  return backgroundTemperatureK <= 50 ? 400 : 150;
}

/** Pure rocket-equation helpers. Masses are kg, specific impulse is seconds. */
export const STANDARD_GRAVITY = 9.80665;

function checkMasses(m0: number, mf: number): void {
  if (!(m0 > 0) || !(mf > 0) || mf > m0) throw new RangeError('final mass must be in (0, initial mass]');
}

export function dvFor(m0: number, mf: number, isp: number): number {
  checkMasses(m0, mf);
  if (!(isp > 0)) throw new RangeError('specific impulse must be positive');
  return STANDARD_GRAVITY * isp * Math.log(m0 / mf);
}

export function massAfterBurn(m0: number, dv: number, isp: number): number {
  if (!(m0 > 0) || !(isp > 0) || dv < 0) throw new RangeError('invalid burn');
  return m0 * Math.exp(-dv / (STANDARD_GRAVITY * isp));
}

export function propellantForDv(dv: number, dryMass: number, isp: number): number {
  if (!(dryMass > 0) || !(isp > 0) || dv < 0) throw new RangeError('invalid burn');
  return dryMass * (Math.exp(dv / (STANDARD_GRAVITY * isp)) - 1);
}

/** Closed-form burn time for constant thrust, including mass flow. */
export function burnTimeFor(dv: number, m0: number, thrust: number, isp: number): number {
  if (dv < 0 || !(m0 > 0) || !(thrust > 0) || !(isp > 0)) throw new RangeError('invalid burn');
  return m0 * STANDARD_GRAVITY * isp / thrust * (1 - Math.exp(-dv / (STANDARD_GRAVITY * isp)));
}

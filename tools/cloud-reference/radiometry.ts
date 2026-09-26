// GOES-R ABI L1b の物理量を製品内の校正係数で復元する。

export interface AbiPlanckCoefficients {
  readonly fk1: number;
  readonly fk2: number;
  readonly bc1: number;
  readonly bc2: number;
}

/** CF の scale_factor と add_offset を packed 値に適用する。 */
export function decodeAbiPackedValue(packed: number, scaleFactor: number, addOffset: number): number {
  if (!Number.isFinite(packed) || !Number.isFinite(scaleFactor) || scaleFactor <= 0
    || !Number.isFinite(addOffset)) {
    throw new Error('ABI packed calibration requires finite values and a positive scale factor');
  }
  const value = packed * scaleFactor + addOffset;
  if (!Number.isFinite(value)) throw new Error('ABI decoded value must be finite');
  return value;
}

/** L1b Rad と kappa0 から太陽反射帯の TOA reflectance factor を返す。 */
export function abiReflectanceFactor(radiance: number, kappa0: number): number {
  if (!Number.isFinite(radiance) || radiance < 0 || !Number.isFinite(kappa0) || kappa0 <= 0) {
    throw new Error('ABI reflectance factor requires non-negative radiance and positive kappa0');
  }
  const factor = radiance * kappa0;
  if (!Number.isFinite(factor)) throw new Error('ABI reflectance factor must be finite');
  return factor;
}

/** L1b Rad と製品の Planck 係数から輝度温度 [K] を返す。 */
export function abiBrightnessTemperatureK(
  radiance: number,
  coefficients: AbiPlanckCoefficients,
): number {
  const { fk1, fk2, bc1, bc2 } = coefficients;
  if (!Number.isFinite(radiance) || radiance <= 0
    || !Number.isFinite(fk1) || fk1 <= 0
    || !Number.isFinite(fk2) || fk2 <= 0
    || !Number.isFinite(bc1)
    || !Number.isFinite(bc2) || bc2 <= 0) {
    throw new Error('ABI brightness temperature requires positive radiance and valid Planck coefficients');
  }
  const temperatureK = (fk2 / Math.log1p(fk1 / radiance) - bc1) / bc2;
  if (!Number.isFinite(temperatureK) || temperatureK <= 0) {
    throw new Error('ABI brightness temperature must be finite and positive');
  }
  return temperatureK;
}

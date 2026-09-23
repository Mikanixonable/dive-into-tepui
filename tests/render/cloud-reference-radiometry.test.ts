// ABI の packed 値と放射量の校正式が物理量と不正値を区別することを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  abiBrightnessTemperatureK,
  abiReflectanceFactor,
  decodeAbiPackedValue,
} from '../../tools/cloud-reference/radiometry';

/** GOES-R L1b の校正式の適用と境界値を検査する。 */
export function register(): void {
  test('cloud reference radiometry: packed values are scaled before ABI calibration', () => {
    const radiance = decodeAbiPackedValue(125, 0.04, 0.5);
    assert.equal(radiance, 5.5);
    assert.equal(abiReflectanceFactor(radiance, 0.1), 0.55);
    assert.equal(abiReflectanceFactor(0, 0.1), 0);
    assert.equal(abiReflectanceFactor(20, 0.1), 2);
  });

  test('cloud reference radiometry: ABI Planck coefficients yield kelvin without tone mapping', () => {
    const coefficients = { fk1: 2, fk2: 600, bc1: 1, bc2: 2 };
    const radiance = 2 / Math.expm1(600 / 301);
    assert.ok(Math.abs(abiBrightnessTemperatureK(radiance, coefficients) - 150) < 1e-10);
  });

  test('cloud reference radiometry: invalid calibration cannot become a metric sample', () => {
    assert.throws(() => decodeAbiPackedValue(Number.NaN, 1, 0));
    assert.throws(() => decodeAbiPackedValue(1, 0, 0));
    assert.throws(() => abiReflectanceFactor(-1, 0.1));
    assert.throws(() => abiReflectanceFactor(1, Number.POSITIVE_INFINITY));
    assert.throws(() => abiBrightnessTemperatureK(0, { fk1: 2, fk2: 600, bc1: 1, bc2: 2 }));
    assert.throws(() => abiBrightnessTemperatureK(1, { fk1: 2, fk2: 600, bc1: 1, bc2: 0 }));
  });
}

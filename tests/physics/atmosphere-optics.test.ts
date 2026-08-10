import * as assert from 'node:assert/strict';
import {
  beerLambertTransmittance,
  exponentialAtmosphereColumnDensity,
  exponentialAtmosphereDensity,
  henyeyGreensteinPhase,
  rayleighPhase,
  raySphereDistances,
  rgbAtmosphereOpticalDepth,
  rgbOpticalDepth,
} from '../../src/physics/atmosphere-optics';
import { test } from './harness';

const closeTo = (actual: number, expected: number, tolerance = 1e-10): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
};

export function register(): void {
  test('光学レイと球の交差距離は安定し、方向ベクトルの長さに依存しない', () => {
    assert.deepEqual(raySphereDistances({ x: 0, y: 0, z: 20 }, { x: 0, y: 0, z: -4 }, 10), { enter: 10, exit: 30 });
    assert.deepEqual(raySphereDistances({ x: 10, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 10), { enter: 0, exit: 0 });
    assert.equal(raySphereDistances({ x: 0, y: 0, z: 20 }, { x: 0, y: 0, z: 1 }, 10), null);
    assert.equal(raySphereDistances({ x: 0, y: 0, z: 20 }, { x: 0, y: 0, z: 0 }, 10), null);
  });

  test('指数大気密度は高度とともに単調減少し、境界入力でも有限', () => {
    closeTo(exponentialAtmosphereDensity(0, 8_000), 1);
    closeTo(exponentialAtmosphereDensity(8_000, 8_000), Math.exp(-1));
    assert.ok(exponentialAtmosphereDensity(0, 8_000) > exponentialAtmosphereDensity(20_000, 8_000));
    assert.equal(exponentialAtmosphereDensity(-100, 8_000), 1);
    assert.equal(exponentialAtmosphereDensity(1_000, 0), 0);
    assert.ok(Number.isFinite(exponentialAtmosphereDensity(Number.POSITIVE_INFINITY, 8_000)));
  });

  test('RayleighとMie位相関数は有限かつ正で、前方Mie散乱を表す', () => {
    assert.ok(rayleighPhase(1) > rayleighPhase(0));
    assert.ok(henyeyGreensteinPhase(1, 0.76) > henyeyGreensteinPhase(-1, 0.76));
    for (const value of [rayleighPhase(Number.NaN), henyeyGreensteinPhase(Number.POSITIVE_INFINITY, 2)]) {
      assert.ok(Number.isFinite(value) && value > 0);
    }
  });

  test('Beer-Lambert RGB透過率は光学的厚さに対して単調減少する', () => {
    const shallow = beerLambertTransmittance(rgbOpticalDepth({ r: 1e-4, g: 2e-4, b: 4e-4 }, 1_000));
    const deep = beerLambertTransmittance(rgbOpticalDepth({ r: 1e-4, g: 2e-4, b: 4e-4 }, 2_000));
    assert.ok(shallow.r > deep.r && shallow.g > deep.g && shallow.b > deep.b);
    assert.deepEqual(beerLambertTransmittance({ r: -1, g: Number.NaN, b: 0 }), { r: 1, g: 1, b: 1 });
  });

  test('球対称な指数大気の列密度とRGB光学的厚さは距離に対して単調増加する', () => {
    const origin = { x: 6_371_000, y: 0, z: 0 };
    const shortColumn = exponentialAtmosphereColumnDensity(origin, { x: 1, y: 0, z: 0 }, 10_000, 6_371_000, 8_000);
    const longColumn = exponentialAtmosphereColumnDensity(origin, { x: 1, y: 0, z: 0 }, 20_000, 6_371_000, 8_000);
    assert.ok(shortColumn > 0 && longColumn > shortColumn);
    const depth = rgbAtmosphereOpticalDepth({ r: 1e-6, g: 2e-6, b: 4e-6 }, longColumn);
    assert.ok(depth.b > depth.g && depth.g > depth.r && Number.isFinite(depth.b));
  });
}

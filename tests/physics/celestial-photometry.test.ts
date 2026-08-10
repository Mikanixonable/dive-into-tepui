import * as assert from 'node:assert/strict';
import {
  circleOverlapArea,
  earthshineIntensity,
  fresnelSchlick,
  lambertSpherePhase,
  lunarEclipseRedGlowFactor,
  solarDiscOcclusionFraction,
} from '../../src/physics/celestial-photometry';
import { test } from './harness';

const closeTo = (actual: number, expected: number, tolerance = 1e-10): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
};

export function register(): void {
  test('Schlick Fresnelは端で1へ近づき、入射余弦に対し単調', () => {
    closeTo(fresnelSchlick(1, 0.02), 0.02);
    closeTo(fresnelSchlick(0, 0.02), 1);
    assert.ok(fresnelSchlick(0.2, 0.04) > fresnelSchlick(0.8, 0.04));
    assert.equal(fresnelSchlick(Number.NaN, Number.POSITIVE_INFINITY), 1);
  });

  test('Lambert球位相関数は満月から新月まで単調減少し境界で正しい', () => {
    closeTo(lambertSpherePhase(0), 1);
    closeTo(lambertSpherePhase(Math.PI), 0);
    assert.ok(lambertSpherePhase(Math.PI / 4) > lambertSpherePhase(Math.PI / 2));
    assert.ok(lambertSpherePhase(Math.PI / 2) > lambertSpherePhase(3 * Math.PI / 4));
    assert.equal(lambertSpherePhase(Number.POSITIVE_INFINITY), 1);
  });

  test('地球照は位相と見かけ半径に対して単調で有限', () => {
    const smallFull = earthshineIntensity(0, 0.01);
    const largeFull = earthshineIntensity(0, 0.02);
    assert.ok(largeFull > smallFull && smallFull > 0);
    assert.ok(earthshineIntensity(0, 0.02) > earthshineIntensity(Math.PI / 2, 0.02));
    assert.equal(earthshineIntensity(Math.PI, 0.02), 0);
    assert.ok(Number.isFinite(earthshineIntensity(Number.NaN, Number.POSITIVE_INFINITY)));
  });

  test('太陽円盤遮蔽率は非食・皆既・部分食の境界を満たす', () => {
    const sunRadius = 10;
    const sunDistance = 1_000;
    const sameAngularRadiusOccluderRadius = 1;
    const occluderDistance = 100;
    closeTo(solarDiscOcclusionFraction(sameAngularRadiusOccluderRadius, occluderDistance, sunRadius, sunDistance, 0), 1);
    assert.equal(solarDiscOcclusionFraction(1, 100, sunRadius, sunDistance, 1), 0);
    const partial = solarDiscOcclusionFraction(1, 100, sunRadius, sunDistance, 0.01);
    assert.ok(partial > 0 && partial < 1);
    assert.equal(solarDiscOcclusionFraction(0, 100, sunRadius, sunDistance, 0), 0);
    closeTo(circleOverlapArea(1, 1, 2), 0);
  });

  test('月食赤色残光係数は遮蔽率に対して単調で、半影では抑制される', () => {
    assert.equal(lunarEclipseRedGlowFactor(0), 0);
    assert.equal(lunarEclipseRedGlowFactor(0.55), 0);
    assert.ok(lunarEclipseRedGlowFactor(0.8) > lunarEclipseRedGlowFactor(0.6));
    closeTo(lunarEclipseRedGlowFactor(1), 1);
    assert.ok(Number.isFinite(lunarEclipseRedGlowFactor(Number.NaN)));
  });
}

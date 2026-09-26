import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { earthConvectiveCloudEnvironmentAt } from '../../src/game/cloud/earth-cloud-environment';

// 緯度 deg・経度 0(+Z) の単位方向。正距円筒の取り決めで経度 0 が +Z、北極が +Y。
function directionAtLatitudeDeg(degrees: number): ReturnType<typeof v3> {
  const latitude = degrees * Math.PI / 180;
  return v3(0, Math.sin(latitude), Math.cos(latitude));
}

export function register(): void {
  test('earth cloud environment: 赤道は深く湿った対流圏、高緯度は浅く乾く', () => {
    const equator = earthConvectiveCloudEnvironmentAt(directionAtLatitudeDeg(0));
    const midlatitude = earthConvectiveCloudEnvironmentAt(directionAtLatitudeDeg(60));
    // 熱帯では有意な CAPE と深い平衡高度、高緯度では対流が立たない。
    assert.ok(equator.parcel.capeJPerKg > 0);
    assert.ok(equator.parcel.capeJPerKg > midlatitude.parcel.capeJPerKg);
    assert.ok(equator.parcel.equilibriumHeightM !== null
      && equator.parcel.equilibriumHeightM > 12_000);
    assert.ok(midlatitude.parcel.equilibriumHeightM === null);
    // 水供給の材料になる可降水量・潜熱フラックス・上層湿りも緯度で落ちる。
    assert.ok(equator.columnWaterVaporKgPerM2 > midlatitude.columnWaterVaporKgPerM2);
    assert.ok(equator.surfaceLatentHeatFluxWPerM2 > midlatitude.surfaceLatentHeatFluxWPerM2);
    assert.ok(equator.upperIceMoistureFactor > midlatitude.upperIceMoistureFactor);
  });

  test('earth cloud environment: 同じ方向には常に同じプロファイルが返る', () => {
    const direction = directionAtLatitudeDeg(30);
    const first = earthConvectiveCloudEnvironmentAt(direction);
    const second = earthConvectiveCloudEnvironmentAt(direction);
    assert.deepEqual(first, second);
  });

  test('earth cloud environment: 極・赤道・途中の緯度でも RangeError なく組める', () => {
    for (const degrees of [-90, -45, 0, 45, 89.999, 90]) {
      const profile = earthConvectiveCloudEnvironmentAt(directionAtLatitudeDeg(degrees));
      assert.ok(profile.levels.length >= 2);
      assert.ok(Number.isFinite(profile.columnWaterVaporKgPerM2));
      assert.ok(profile.columnWaterVaporKgPerM2 > 0);
      assert.ok(profile.upperIceMoistureFactor >= 0 && profile.upperIceMoistureFactor <= 1);
    }
    // 緯度方向が面内に倒れた方向(経度が非 0)でも同じ緯度なら同じプロファイル。
    const alongX = earthConvectiveCloudEnvironmentAt(v3(Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0));
    const alongZ = earthConvectiveCloudEnvironmentAt(directionAtLatitudeDeg(30));
    assert.deepEqual(alongX, alongZ);
  });
}

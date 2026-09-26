import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { earthConvectiveCloudEnvironmentAt } from '../../src/game/cloud/earth-cloud-environment';
import { AnnualClimateMap } from '../../src/render/cloud/climate-map';
import type { EarthClimateSource } from '../../src/game/cloud/earth-cloud-environment';
import type { Vec3 } from '../../src/math/vec3';

// 緯度 deg・経度 0(+Z) の単位方向。正距円筒の取り決めで経度 0 が +Z、北極が +Y。
function directionAtLatitudeDeg(degrees: number): ReturnType<typeof v3> {
  const latitude = degrees * Math.PI / 180;
  return v3(0, Math.sin(latitude), Math.cos(latitude));
}

// 全方向に同じ気候値を返す気候源。
function uniformClimate(values: {
  temperatureK: number; meanCloudiness: number; elevationM: number; landFraction: number;
}): EarthClimateSource {
  return { valuesAtCpu: () => ({ ...values }) };
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

  test('earth cloud environment: 気候源が null を返すときは緯度近似と同じ柱を返す', () => {
    const direction = directionAtLatitudeDeg(35);
    const fallback: EarthClimateSource = { valuesAtCpu: () => null };
    assert.deepEqual(
      earthConvectiveCloudEnvironmentAt(direction, fallback),
      earthConvectiveCloudEnvironmentAt(direction),
    );
  });

  test('earth cloud environment: 気候値は地表温・湿り・フラックスを変える', () => {
    const direction = directionAtLatitudeDeg(10);
    const oceanic = earthConvectiveCloudEnvironmentAt(direction, uniformClimate({
      temperatureK: 300, meanCloudiness: 0.8, elevationM: 0, landFraction: 0,
    }));
    const desert = earthConvectiveCloudEnvironmentAt(direction, uniformClimate({
      temperatureK: 300, meanCloudiness: 0.1, elevationM: 0, landFraction: 1,
    }));
    // 乾いた陸では潜熱が落ち、顕熱が増え、柱が乾く。
    assert.ok(desert.surfaceLatentHeatFluxWPerM2 < oceanic.surfaceLatentHeatFluxWPerM2);
    assert.ok(desert.surfaceSensibleHeatFluxWPerM2 > oceanic.surfaceSensibleHeatFluxWPerM2);
    assert.ok(desert.columnWaterVaporKgPerM2 < oceanic.columnWaterVaporKgPerM2);
    // 同じ地表温のまま供給が変わるので、対流の組み立ても変わる。
    const hot = earthConvectiveCloudEnvironmentAt(direction, uniformClimate({
      temperatureK: 310, meanCloudiness: 0.8, elevationM: 0, landFraction: 0,
    }));
    assert.ok(hot.levels[0]!.temperatureK === 310);
    assert.notDeepEqual(hot.parcel, oceanic.parcel);
  });

  test('earth cloud environment: 気候値が経度で変わると同緯度でも環境が変わる', () => {
    // 経度 +X 側は熱帯の海洋、それ以外は乾いた陸、という気候源。
    const source: EarthClimateSource = {
      valuesAtCpu: (direction: Vec3) => direction.x > 0
        ? { temperatureK: 300, meanCloudiness: 0.8, elevationM: 0, landFraction: 0 }
        : { temperatureK: 295, meanCloudiness: 0.1, elevationM: 0, landFraction: 1 },
    };
    const east = earthConvectiveCloudEnvironmentAt(v3(1, 0, 0), source);
    const west = earthConvectiveCloudEnvironmentAt(v3(-1, 0, 0), source);
    assert.ok(east.surfaceLatentHeatFluxWPerM2 > west.surfaceLatentHeatFluxWPerM2);
    assert.ok(east.levels[0]!.temperatureK !== west.levels[0]!.temperatureK);
  });

  test('earth cloud environment: 気候テクスチャの画素がそのまま環境へ効く', () => {
    // 4×2 の一様な気候画像(高温・多雲・海抜 0)。
    const data = new Uint8Array(4 * 2 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 190;     // R: ≈20 °C
      data[i + 1] = 200; // G: 雲量 ≈0.78
      data[i + 2] = 0;   // B: 標高 0
      data[i + 3] = 255;
    }
    const climate = AnnualClimateMap.fromPixels(data, 4, 2);
    const profile = earthConvectiveCloudEnvironmentAt(directionAtLatitudeDeg(80), climate);
    // 高緯度でも気候画像の地表温が使われ、緯度近似(極では 255 K)よりはるかに暖かい。
    const expectedSurfaceK = 190 / 255 * 80 + 233.15;
    assert.ok(Math.abs(profile.levels[0]!.temperatureK - expectedSurfaceK) < 1);
    assert.ok(Number.isFinite(profile.columnWaterVaporKgPerM2));
    climate.dispose();
  });

  test('earth cloud environment: 高山・極・沙漠の気候値でも RangeError なく組める', () => {
    const cases = [
      // 極の氷床: 低温・高標高・晴天。
      { direction: directionAtLatitudeDeg(-80), values: { temperatureK: 233.15, meanCloudiness: 0.1, elevationM: 3000, landFraction: 1 } },
      // 高山: 上限の標高。
      { direction: directionAtLatitudeDeg(30), values: { temperatureK: 260, meanCloudiness: 0.3, elevationM: 8000, landFraction: 1 } },
      // 沙漠: 高温・無雲・陸。
      { direction: directionAtLatitudeDeg(20), values: { temperatureK: 313.15, meanCloudiness: 0, elevationM: 500, landFraction: 1 } },
      // 熱帯海洋: 高温・多雲・海抜 0。
      { direction: directionAtLatitudeDeg(0), values: { temperatureK: 303, meanCloudiness: 0.9, elevationM: 0, landFraction: 0 } },
    ];
    for (const { direction, values } of cases) {
      const profile = earthConvectiveCloudEnvironmentAt(direction, uniformClimate(values));
      assert.ok(profile.levels.length >= 2);
      assert.ok(Number.isFinite(profile.columnWaterVaporKgPerM2));
      assert.ok(profile.columnWaterVaporKgPerM2 >= 0);
      assert.ok(profile.upperIceMoistureFactor >= 0 && profile.upperIceMoistureFactor <= 1);
      assert.ok(profile.surfaceLatentHeatFluxWPerM2 >= 0);
    }
  });
}

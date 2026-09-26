import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { earthGlobalEnvironmentAt } from '../../src/game/cloud/earth-global-environment';
import { earthConvectiveCloudEnvironmentAt } from '../../src/game/cloud/earth-cloud-environment';
import { weatherAtCpu } from '../../src/game/cloud/weather-model-cpu';
import { lowPlacementAt, tropicalPlacementAt } from '../../src/render/cloud/cyclone-tracks';
import type { EarthClimateSource } from '../../src/game/cloud/earth-cloud-environment';
import type { Vec3 } from '../../src/math/vec3';

// 環境の天気を解く天体の半径 [m] と自転周期 [s](地球の平均半径・恒星日)。
const SURFACE_RADIUS_M = 6.371e6;
const ROTATION_PERIOD_SECONDS = 86_164.0905;

// 緯度・経度 [deg] の単位方向。正距円筒の取り決めで経度 0 が +Z、東が +X、北極が +Y。
function directionAtLatLon(latitudeDeg: number, longitudeDeg: number): Vec3 {
  const latitude = latitudeDeg * Math.PI / 180;
  const longitude = longitudeDeg * Math.PI / 180;
  return v3(
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
    Math.cos(latitude) * Math.cos(longitude));
}

// 配置の中心方向。
function directionOfPlacement(placement: { latitude: number; longitude: number }): Vec3 {
  return directionAtLatLon(placement.latitude * 180 / Math.PI, placement.longitude * 180 / Math.PI);
}

// 全方向に同じ気候値を返す気候源。
function uniformClimate(values: {
  temperatureK: number; meanCloudiness: number; elevationM: number; landFraction: number;
}): EarthClimateSource {
  return { valuesAtCpu: () => ({ ...values }) };
}

// 高さ heightM の層の大規模鉛直流 [m/s]。
function verticalVelocityAt(
  profile: ReturnType<typeof earthGlobalEnvironmentAt>, heightM: number,
): number {
  return profile.levels.find((level) => level.heightM === heightM)!.largeScaleVerticalVelocityMps;
}

export function register(): void {
  test('earth global environment: 渦の影響域で湿り・上昇・雲頂が変わる', () => {
    const tropical = tropicalPlacementAt(0);
    assert.ok(tropical !== null && tropical.depth > 30, '熱帯低気圧が時刻 0 に深くあること');
    const direction = directionOfPlacement(tropical);
    const inside = earthGlobalEnvironmentAt(
      direction, null, 0, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS);
    const base = earthConvectiveCloudEnvironmentAt(direction, null);
    // 眼の内側は乾く — 上層の氷層帯の湿りが大きく下がり、柱の水蒸気も減る。
    assert.ok(inside.upperIceMoistureFactor < base.upperIceMoistureFactor * 0.5);
    assert.ok(inside.columnWaterVaporKgPerM2 < base.columnWaterVaporKgPerM2);
    // 眼壁の強い上昇が層の鉛直流へ写る。
    assert.ok(inside.levels.some((level) => level.largeScaleVerticalVelocityMps > 0.01));
    // 深い谷の上では対流圏界面が下がるので、層の格子自体が浅くなる。
    assert.ok(
      inside.levels[inside.levels.length - 1]!.heightM
        < base.levels[base.levels.length - 1]!.heightM);
  });

  test('earth global environment: 気団の前線帯で中層が湿り上昇する', () => {
    // 時刻 0 の中緯度の低気圧の中心は気団の折り目(前線)の上に立つ。
    const low = lowPlacementAt(2, 0, SURFACE_RADIUS_M);
    assert.ok(low !== null && low.depth > 10);
    const direction = directionOfPlacement(low);
    const weather = weatherAtCpu(direction, null, 0, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS);
    assert.ok(weather.bandStrength > 0.3);
    const inside = earthGlobalEnvironmentAt(
      direction, null, 0, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS);
    const base = earthConvectiveCloudEnvironmentAt(direction, null);
    const levelAt = (heightM: number) => ({
      inside: inside.levels.find((level) => level.heightM === heightM)!,
      base: base.levels.find((level) => level.heightM === heightM)!,
    });
    // 傾斜上昇域の湿潤層が 3 km の比湿を底上げする。
    assert.ok(
      levelAt(3_000).inside.waterVaporSpecificHumidityKgPerKg
        > levelAt(3_000).base.waterVaporSpecificHumidityKgPerKg);
    // 暖気の流入が地表温を上げ、帯の上昇が層の鉛直流へ写る。
    assert.ok(inside.levels[0]!.temperatureK > base.levels[0]!.temperatureK);
    assert.ok(verticalVelocityAt(inside, 4_000) > 0.01);
  });

  test('earth global environment: 地形の風上と風下で環境が変わる', () => {
    // |x| に向かって標高が上がる気候源。風が斜面を駆け上がる側では強制上昇、
    // 駆け下りる側では沈降が入る。
    const slopeClimate: EarthClimateSource = {
      valuesAtCpu: (direction: Vec3) => ({
        temperatureK: 285, meanCloudiness: 0.5,
        elevationM: 8_000 * Math.min(1, Math.abs(direction.x)), landFraction: 0,
      }),
    };
    const flatClimate = uniformClimate({
      temperatureK: 285, meanCloudiness: 0.5, elevationM: 0, landFraction: 0,
    });
    // 同じ方向で比べると、標高の勾配がある分だけ鉛直流が変わる。どちらが風上かは
    // その時刻の地表風と斜面の向きで決まる — この組では一方が上昇、他方が下降になる。
    const windward = directionAtLatLon(-45, 135);
    const leeward = directionAtLatLon(45, -135);
    const liftWindward = weatherAtCpu(
      windward, slopeClimate, 0, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS).liftMps;
    const liftWindwardFlat = weatherAtCpu(
      windward, flatClimate, 0, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS).liftMps;
    const liftLeeward = weatherAtCpu(
      leeward, slopeClimate, 0, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS).liftMps;
    const liftLeewardFlat = weatherAtCpu(
      leeward, flatClimate, 0, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS).liftMps;
    assert.ok(liftWindward > liftWindwardFlat);
    assert.ok(liftLeeward < liftLeewardFlat);
    // 層の鉛直流へも同じ向きに写る。
    const upSlope = earthGlobalEnvironmentAt(
      leeward, slopeClimate, 0, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS);
    const upFlat = earthGlobalEnvironmentAt(
      leeward, flatClimate, 0, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS);
    assert.ok(
      Math.max(...upSlope.levels.map((level) => level.largeScaleVerticalVelocityMps))
        < Math.max(...upFlat.levels.map((level) => level.largeScaleVerticalVelocityMps)));
  });

  test('earth global environment: 渦の外では緯度+気候の柱へ近づく', () => {
    // どの渦の裾からも遠い、穏やかな赤道の海上。大循環の帯・ロスビー波・平均風の
    // 偏差は全球に残るので、格子は一致し値は僅差で一致する。
    const direction = directionAtLatLon(0, 100);
    const global = earthGlobalEnvironmentAt(
      direction, null, 0, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS);
    const base = earthConvectiveCloudEnvironmentAt(direction, null);
    // 遠方の谷の裾で対流圏界面がわずかにたわむので、格子はずれても 1 段まで。
    assert.ok(Math.abs(global.levels.length - base.levels.length) <= 1);
    assert.ok(Math.abs(global.levels[0]!.temperatureK - base.levels[0]!.temperatureK) < 1);
    assert.ok(
      Math.abs(global.columnWaterVaporKgPerM2 - base.columnWaterVaporKgPerM2)
        / base.columnWaterVaporKgPerM2 < 0.05);
    assert.ok(global.levels.every((level) => Math.abs(level.largeScaleVerticalVelocityMps) < 0.02));
    // 渦の中心での変化のほうが桁で大きい。
    const tropical = tropicalPlacementAt(0)!;
    const inside = earthGlobalEnvironmentAt(
      directionOfPlacement(tropical), null, 0, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS);
    const insideBase = earthConvectiveCloudEnvironmentAt(directionOfPlacement(tropical), null);
    assert.ok(
      Math.abs(inside.columnWaterVaporKgPerM2 - insideBase.columnWaterVaporKgPerM2)
        > 4 * Math.abs(global.columnWaterVaporKgPerM2 - base.columnWaterVaporKgPerM2));
  });

  test('earth global environment: 極・高山・渦中心で RangeError なく組める', () => {
    const iceSheet = uniformClimate({
      temperatureK: 233.15, meanCloudiness: 0.1, elevationM: 3_000, landFraction: 1,
    });
    const hotMountain = uniformClimate({
      temperatureK: 310, meanCloudiness: 0.2, elevationM: 8_000, landFraction: 1,
    });
    const tropical = directionOfPlacement(tropicalPlacementAt(0)!);
    const cases: readonly [Vec3, EarthClimateSource | null][] = [
      [directionAtLatLon(89.999, 0), null],
      [directionAtLatLon(-89.999, 0), null],
      [directionAtLatLon(0, -160), null],
      [tropical, null],
      [directionAtLatLon(-80, 0), iceSheet],
      [directionAtLatLon(30, 45), hotMountain],
    ];
    for (const [direction, climate] of cases) {
      const profile = earthGlobalEnvironmentAt(
        direction, climate, 0, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS);
      assert.ok(profile.levels.length >= 2);
      assert.ok(Number.isFinite(profile.columnWaterVaporKgPerM2));
      assert.ok(profile.upperIceMoistureFactor >= 0 && profile.upperIceMoistureFactor <= 1);
      assert.ok(profile.levels.every((level) => Number.isFinite(level.temperatureK)
        && Number.isFinite(level.waterVaporSpecificHumidityKgPerKg)
        && Number.isFinite(level.eastWindMps)
        && Number.isFinite(level.largeScaleVerticalVelocityMps)));
    }
  });

  test('earth global environment: 同じ方向・時刻には同じプロファイルが返り、時刻で変わる', () => {
    const direction = directionAtLatLon(23, 138.7);
    const first = earthGlobalEnvironmentAt(
      direction, null, 0, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS);
    const second = earthGlobalEnvironmentAt(
      direction, null, 0, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS);
    assert.deepEqual(first, second);
    // 渦が移るので、同じ方向でも時刻が違えば柱は変わる。
    const later = earthGlobalEnvironmentAt(
      direction, null, 7 * 86_400, SURFACE_RADIUS_M, ROTATION_PERIOD_SECONDS);
    assert.notDeepEqual(first.levels, later.levels);
  });
}

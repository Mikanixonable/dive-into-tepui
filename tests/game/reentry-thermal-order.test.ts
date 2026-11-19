// 再突入で「空力分解」と「加熱限界」のどちらが先に来るかを固定する回帰テスト。
// SPEC(FLIGHT)は 1,300 K の熱喪失と 35 kPa の空力破壊を併記するが、以前の物性値では
// どの再突入プロファイルでも構造限界が先に立ち、加熱喪失は実質到達不能だった。
// ここでは一定の流れへ晒した熱収支で、構造限界に満たない動圧でも熱限界へ到達しうること
// (= 加熱が先に来うること)と、ゆるい流れでは限界へ達しないことを固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import type { Atmosphere } from '../../src/physics/atmosphere';
import type { DynamicsEnvironmentSample } from '../../src/physics/dynamics';
import {
  ENV_TEMP, HULL_EMISS, stepThermalState,
} from '../../src/game/dynamic/dynamic-motion-thermal';
import { MAX_DYN_PRESSURE } from '../../src/game/player/aero-load';
import {
  MAX_HULL_TEMP, SHIP_BCINV, SHIP_BULK_DENSITY, SHIP_RADIATING_AREA_PER_MASS,
} from '../../src/game/dynamic/dynamic-entity/combat-ship-entity';

const SHIP_SPECIFIC_HEAT = 100; // 艦の比熱(combat-ship-entity.ts と同じ値)[J/(kg·K)]
const SURFACE_R = 6.4e6;

// 高度依存を消した球形大気(スケールハイトを巨大にして密度をほぼ一様にする)。
// 非自転なので対気速度はそのまま標本の速度になる。
function constantAtmosphere(density: number): Atmosphere {
  return {
    equatorRadius: SURFACE_R,
    polarRadius: SURFACE_R,
    spinRate: 0,
    layers: [[0, density, 1e12]],
    pole: v3(0, 0, 1),
  };
}

// 密度・速さが一定の流れを表す環境標本。
function flowSample(density: number, speed: number): DynamicsEnvironmentSample {
  return {
    t: 0,
    r: v3(SURFACE_R + 50e3, 0, 0),
    v: v3(0, speed, 0),
    sunDist: 1,
    sunlit: 0,
    sunDir: v3(0, 0, 1),
    atmosphere: constantAtmosphere(density),
    atmosphereState: kinematicState(0, v3(), v3()),
  };
}

// 一定の流れへ晒し続けたときの到達温度を、熱限界で燃え尽きたかとともに返す。
function dwellUntilSettled(
  density: number, speed: number, maxSeconds: number,
): { readonly burnedUp: boolean; readonly temperature: number; readonly seconds: number } {
  const sample = flowSample(density, speed);
  let temperature = 300;
  let thermalDeviation = 0;
  let pendingSpecificHeat = 0;
  const dt = 0.5;
  let t = 0;
  while (t < maxSeconds) {
    const next = stepThermalState({
      dt,
      samples: [sample],
      radiantIntensity: 0,
      temperature,
      thermalDeviation,
      pendingSpecificHeat,
      specificHeat: SHIP_SPECIFIC_HEAT,
      bulkDensity: SHIP_BULK_DENSITY,
      emissivity: HULL_EMISS,
      maxTemperature: MAX_HULL_TEMP,
      bcInv: SHIP_BCINV,
      radiatingAreaPerMass: SHIP_RADIATING_AREA_PER_MASS,
      solarAbsorbAreaPerMass: () => 0,
    });
    if (next.burnedUp) return { burnedUp: true, temperature: next.temperature, seconds: t };
    temperature = next.temperature;
    thermalDeviation = next.thermalDeviation;
    pendingSpecificHeat = next.pendingSpecificHeat;
    t += dt;
  }
  return { burnedUp: false, temperature, seconds: t };
}

export function register(): void {
  test('reentry: 構造限界に満たない動圧でも、持続すれば加熱限界へ達する', () => {
    const speed = 7500; // 周回速度級 [m/s]
    const dynamicPressure = 30e3; // 構造限界の手前 [Pa]
    const density = (2 * dynamicPressure) / (speed * speed);
    assert.ok(dynamicPressure < MAX_DYN_PRESSURE, '前提: 流れの動圧は構造限界未満');
    const result = dwellUntilSettled(density, speed, 120);
    assert.ok(
      result.burnedUp,
      `q=${dynamicPressure / 1e3} kPa の流れで ${result.temperature.toFixed(0)} K に留まり、加熱限界へ達しない`,
    );
  });

  test('reentry: ゆるい流れでは放射冷却が勝ち、加熱限界へ達しない', () => {
    const speed = 7500;
    const dynamicPressure = 2e3; // 燃焼輝きが出る程度の流れ [Pa]
    const density = (2 * dynamicPressure) / (speed * speed);
    const result = dwellUntilSettled(density, speed, 1200);
    assert.ok(
      !result.burnedUp && result.temperature < MAX_HULL_TEMP,
      `q=${dynamicPressure / 1e3} kPa の流れで ${result.temperature.toFixed(0)} K まで熱くなる`,
    );
    assert.ok(result.temperature > ENV_TEMP, '流れの中では環境温度より熱い');
  });
}

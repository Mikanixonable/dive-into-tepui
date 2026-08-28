// 熱収支の純関数(physics/thermal.ts)の回帰テスト。
// **物体へ入る熱がその区間に散逸した力学エネルギーを超えないこと**が中心で、これを破ると
// 軌道上の物体が理由なく熱を持つ。刻みに対する頑健さ(放熱が環境温度を通り越さないこと)も
// ここで固定する — 通り越すと T⁴ が段どうしで増幅し、1歩で発散する。太陽光の受熱については、
// 日照だけで軌道上の物体が焼失しないことを固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  STEFAN_BOLTZMANN, aeroHeating, dragDissipation, radiativeCooling, solarHeating,
  sphereNoseRadius, stepTemperature, stepThermalDeviation,
} from '../../src/physics/thermal';
import { SOLAR_CONSTANT } from '../../src/physics/srp';
import { AU } from '../../src/physics/planet-orbit';

const ENV_TEMP = 255;
const SG_CONST = 1.7415e-4; // 地球大気の Sutton–Graves 定数 [kg^0.5/m]
const SHIP_BCINV = 3.3e-3;
const SMALL_DEBRIS_BCINV = 8e-3;
const DRAG_COEFFICIENT = 2.2;
const HULL_EMISS = 0.85;

// 灰色体とみなした物体が太陽光を受ける実効面積の比 [m^2/kg](game/const.ts と同じ導き方)。
function solarAbsorbAreaPerMass(bcInv: number): number {
  return (HULL_EMISS * bcInv) / DRAG_COEFFICIENT;
}

// 加熱と放熱が釣り合う温度 [K] を、上の枝から二分で求める。
function equilibrium(
  heating: number, emissivity: number, radiatingAreaPerMass: number,
): number {
  let lo = ENV_TEMP;
  let hi = 1e6;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const cooling = radiativeCooling(mid, ENV_TEMP, emissivity, radiatingAreaPerMass, 0, 0);
    if (cooling < heating) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function register(): void {
  test('thermal: 抗力の散逸は対気速さの3乗・密度・弾道係数に比例する', () => {
    const base = dragDissipation(1e-5, 7000, SHIP_BCINV);
    assert.ok(Math.abs(dragDissipation(2e-5, 7000, SHIP_BCINV) - 2 * base) < 1e-9 * base);
    assert.ok(Math.abs(dragDissipation(1e-5, 14000, SHIP_BCINV) - 8 * base) < 1e-9 * base);
    assert.ok(Math.abs(dragDissipation(1e-5, 7000, 2 * SHIP_BCINV) - 2 * base) < 1e-9 * base);
    assert.equal(dragDissipation(0, 7000, SHIP_BCINV), 0, '真空では散らさない');
  });

  test('thermal: 空力加熱は抗力の散逸を超えない', () => {
    // 密度を10桁またいで走らせる。頭打ちが無ければ、薄いほうで比が 1 を超える。
    const noseRadius = 0.6;
    const absorb = 9e-4;
    let capped = 0;
    for (let e = -13; e <= -3; e++) {
      const density = Math.pow(10, e);
      const dissipation = dragDissipation(density, 7500, SHIP_BCINV);
      const heating = aeroHeating(density, 7500, SHIP_BCINV, SG_CONST, noseRadius, absorb);
      assert.ok(heating <= dissipation + 1e-12 * dissipation,
        `ρ=1e${e}: 受熱 ${heating} が散逸 ${dissipation} を超えた`);
      assert.ok(heating >= 0);
      if (heating >= dissipation * (1 - 1e-12)) capped++;
    }
    assert.ok(capped > 0, '頭打ちに一度も触れていない — 試験になっていない');
  });

  test('thermal: 濃い大気では空力加熱は Sutton–Graves の値そのもの', () => {
    const density = 1e-4;
    const noseRadius = 0.6;
    const absorb = 9e-4;
    const flux = SG_CONST * Math.sqrt(density / noseRadius) * 7500 ** 3;
    const heating = aeroHeating(density, 7500, SHIP_BCINV, SG_CONST, noseRadius, absorb);
    assert.ok(heating < dragDissipation(density, 7500, SHIP_BCINV), '前提: ここでは頭打ちに触れない');
    assert.ok(Math.abs(heating - flux * absorb) < 1e-9 * heating);
  });

  test('thermal: 真空でも曲率半径0でも空力加熱は0', () => {
    assert.equal(aeroHeating(0, 7500, SHIP_BCINV, SG_CONST, 0.6, 9e-4), 0);
    assert.equal(aeroHeating(1e-5, 7500, 0, SG_CONST, 0.6, 9e-4), 0, '抵抗を受けなければ加熱もない');
    assert.equal(aeroHeating(1e-5, 7500, SHIP_BCINV, SG_CONST, 0, 9e-4), 0);
  });

  test('thermal: 球とみなした曲率半径は弾道係数と材質密度から決まる', () => {
    // 一様な球なら bcInv = Cd·A/m = 3·Cd/(4·ρ·R) なので、逆に解いた値が戻る。
    const cd = 2.2;
    const bulk = 2700;
    const radius = sphereNoseRadius(8e-3, cd, bulk);
    assert.ok(Math.abs((3 * cd) / (4 * bulk * radius) - 8e-3) < 1e-15);
    // 軽い材質・小さい弾道係数ほど大きい球になる。
    assert.ok(sphereNoseRadius(4e-3, cd, bulk) > radius);
    assert.ok(sphereNoseRadius(8e-3, cd, bulk / 2) > radius);
  });

  test('thermal: 放熱は環境温度で正味0になり、下回れば暖まる向きになる', () => {
    assert.equal(radiativeCooling(ENV_TEMP, ENV_TEMP, 0.85, 0.07, 0, 0), 0);
    assert.ok(radiativeCooling(ENV_TEMP + 100, ENV_TEMP, 0.85, 0.07, 0, 0) > 0);
    assert.ok(radiativeCooling(ENV_TEMP - 100, ENV_TEMP, 0.85, 0.07, 0, 0) < 0);
    assert.equal(radiativeCooling(1000, ENV_TEMP, 0, 0.07, 0, 0), 0, '輻射率0なら放熱しない');
  });

  test('thermal: 放熱はステファン・ボルツマンの法則そのもの', () => {
    const t = 1300;
    const expected = 0.85 * STEFAN_BOLTZMANN * 0.07 * (t ** 4 - ENV_TEMP ** 4);
    assert.ok(Math.abs(radiativeCooling(t, ENV_TEMP, 0.85, 0.07, 0, 0) - expected) < 1e-9 * expected);
  });

  test('thermal: 刻みがどれだけ広くても、放熱は環境温度を通り越さない', () => {
    // 比熱が小さく刻みが広いほど、頭打ちが無ければ1歩で負の温度へ落ちて T⁴ が暴走する。
    for (const dt of [1, 20, 204.8, 1e4]) {
      for (const specificHeat of [10, 100, 500]) {
        const cooling = radiativeCooling(3000, ENV_TEMP, 0.85, 0.07, specificHeat, dt);
        const next = stepTemperature(3000, -cooling, specificHeat, dt);
        assert.ok(next >= ENV_TEMP - 1e-9, `dt=${dt} c=${specificHeat}: ${next} K まで落ちた`);
        assert.ok(next <= 3000 + 1e-9, `dt=${dt} c=${specificHeat}: 冷えずに上がった`);
      }
    }
  });

  test('thermal: 太陽光の受熱は1天文単位で太陽定数そのもので、距離の2乗に反比例する', () => {
    const area = solarAbsorbAreaPerMass(SHIP_BCINV);
    const at1AU = solarHeating(SOLAR_CONSTANT, AU, 1, area);
    assert.ok(Math.abs(at1AU - SOLAR_CONSTANT * area) < 1e-12, `1AU で ${at1AU} W/kg`);
    for (const ratio of [0.5, 2, 5.2, 30]) {
      const far = solarHeating(SOLAR_CONSTANT, ratio * AU, 1, area);
      assert.ok(Math.abs(far - at1AU / (ratio * ratio)) < 1e-12 * at1AU, `${ratio} AU で ${far} W/kg`);
    }
  });

  test('thermal: 太陽光の受熱は日照率に比例し、本影では入らない', () => {
    const area = solarAbsorbAreaPerMass(SMALL_DEBRIS_BCINV);
    const full = solarHeating(SOLAR_CONSTANT, AU, 1, area);
    assert.ok(Math.abs(solarHeating(SOLAR_CONSTANT, AU, 0.25, area) - full / 4) < 1e-12 * full);
    assert.equal(solarHeating(SOLAR_CONSTANT, AU, 0, area), 0, '本影では入らない');
  });

  // 日照だけで焼ける物体があると、軌道に置いただけの破片や敵機が戦闘前に勝手に消える。
  test('thermal: 地球軌道の日照だけでは、破片も艦も限界温度に届かない', () => {
    const cases = [
      { name: '破片', bcInv: SMALL_DEBRIS_BCINV, radiatingAreaPerMass: 0.01455, maxTemp: 933 },
      { name: '艦', bcInv: SHIP_BCINV, radiatingAreaPerMass: 0.07, maxTemp: 500 },
    ];
    for (const c of cases) {
      const heating = solarHeating(
        SOLAR_CONSTANT, AU, 1, solarAbsorbAreaPerMass(c.bcInv));
      const t = equilibrium(heating, HULL_EMISS, c.radiatingAreaPerMass);
      assert.ok(t < c.maxTemp, `${c.name}: 日照の平衡 ${t.toFixed(0)} K が限界 ${c.maxTemp} K に達する`);
      assert.ok(t > ENV_TEMP, `${c.name}: 日照で環境温度より暖まらない`);
    }
  });

  test('thermal: 局所的な過熱は温度が高いほど速く薄まる', () => {
    const hot = stepThermalDeviation(600, 1500, HULL_EMISS, 0.047, 500, 10);
    const cool = stepThermalDeviation(600, 1000, HULL_EMISS, 0.047, 500, 10);
    assert.ok(hot < cool, `1500 K で ${hot.toFixed(1)} K、1000 K で ${cool.toFixed(1)} K`);
    assert.ok(hot < 600 && cool < 600, '薄まっていない');
    assert.equal(stepThermalDeviation(600, 1500, 0, 0.047, 500, 10), 600, '輻射率0なら薄まらない');
  });

  test('thermal: 局所的な過熱の薄まりは刻みの分け方に依らない', () => {
    const once = stepThermalDeviation(600, 1500, HULL_EMISS, 0.047, 500, 20);
    let split = 600;
    for (let i = 0; i < 4; i++) split = stepThermalDeviation(split, 1500, HULL_EMISS, 0.047, 500, 5);
    assert.ok(Math.abs(once - split) < 1e-9 * once, `1歩 ${once} に対し4分割 ${split}`);
  });

  test('thermal: 刻みがどれだけ広くても、局所的な過熱は0へ収束して符号を変えない', () => {
    for (const dt of [1, 100, 1e4, 1e8]) {
      const next = stepThermalDeviation(600, 1500, HULL_EMISS, 0.047, 500, dt);
      assert.ok(next >= 0, `dt=${dt}: ${next} K まで落ちた`);
      assert.ok(next <= 600, `dt=${dt}: 薄まらずに育った`);
    }
    assert.ok(stepThermalDeviation(600, 1500, HULL_EMISS, 0.047, 500, 1e8) < 1e-9, '十分な時間で消えない');
  });

  test('thermal: 比熱0の物体は温度が動かない', () => {
    assert.equal(stepTemperature(300, 1e9, 0, 20), 300);
    assert.equal(stepTemperature(300, -1e9, 0, 20), 300);
  });

  test('thermal: 加熱を続けると平衡温度へ収束する', () => {
    const emissivity = 0.85;
    const radiatingAreaPerMass = 0.0145;
    const specificHeat = 500;
    const heating = 1897; // 破片が高度 90 km で受ける比パワーの桁 [W/kg]
    const target = equilibrium(heating, emissivity, radiatingAreaPerMass);
    let t = ENV_TEMP;
    for (let i = 0; i < 200000; i++) {
      const cooling = radiativeCooling(t, ENV_TEMP, emissivity, radiatingAreaPerMass, specificHeat, 0.05);
      t = stepTemperature(t, heating - cooling, specificHeat, 0.05);
    }
    assert.ok(Math.abs(t - target) < 1, `平衡 ${target.toFixed(1)} K に対し ${t.toFixed(1)} K`);
    // 破片が焼ける桁にいること自体も見る — 桁がずれていれば式のどこかが間違っている。
    assert.ok(target > 900 && target < 2000, `平衡温度 ${target.toFixed(0)} K は想定の桁から外れる`);
  });
}

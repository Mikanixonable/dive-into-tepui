// 熱収支の純関数(physics/thermal.ts)の回帰テスト。
// **物体へ入る熱がその区間に散逸した力学エネルギーを超えないこと**が中心で、これを破ると
// 軌道上の物体が理由なく熱を持つ。刻みに対する頑健さ(放熱が環境温度を通り越さないこと)も
// ここで固定する — 通り越すと T⁴ が段どうしで増幅し、1歩で発散する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  STEFAN_BOLTZMANN, aeroHeating, dragDissipation, radiativeCooling, sphereNoseRadius,
  stepTemperature,
} from '../../src/physics/thermal';

const ENV_TEMP = 255;
const SG_CONST = 1.7415e-4; // 地球大気の Sutton–Graves 定数 [kg^0.5/m]
const SHIP_BCINV = 3.3e-3;

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

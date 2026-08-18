// 姿勢依存の空力(§11-2)の回帰テスト。直方体に対して厳密な投影面積の式と、そこから出る
// 弾道係数・輻射圧係数を固定する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { v3 } from '../../src/physics/vec3';
import {
  FREE_MOLECULAR_CD, RADIATION_PRESSURE_COEFF, ballisticCoeffInv, meanProjectedArea,
  projectedArea, radiationPressureCoeff,
} from '../../src/physics/aerodynamics';

export function register(): void {
  test('aerodynamics: 主軸方向から見た投影面積がその軸の面積そのものになる', () => {
    const areas = v3(2, 3, 5);
    assert.equal(projectedArea(areas, v3(1, 0, 0)), 2);
    assert.equal(projectedArea(areas, v3(0, -1, 0)), 3);
    assert.equal(projectedArea(areas, v3(0, 0, 4)), 5); // 単位ベクトルでなくてよい
  });

  test('aerodynamics: 一辺 a の立方体の投影面積が、どの向きから見ても正しい', () => {
    // 立方体の3面はどれも a²。対角線方向 (1,1,1)/√3 から見た面積は √3·a² である。
    const a2 = 4;
    const areas = v3(a2, a2, a2);
    assert.equal(projectedArea(areas, v3(1, 0, 0)), a2);
    assert.ok(Math.abs(projectedArea(areas, v3(1, 1, 1)) - Math.sqrt(3) * a2) < 1e-12);
  });

  test('aerodynamics: 向きを平均した投影面積が3軸の和の半分になる', () => {
    const areas = v3(2, 3, 5);
    assert.equal(meanProjectedArea(areas), 5);
    // 向きが決まらないときは平均の値へ落ちる。
    assert.equal(projectedArea(areas, v3()), 5);
  });

  test('aerodynamics: 細長い機体は横を向けると弾道係数が大きくなる', () => {
    // 断面 1 m²、側面 6 m² の細長い機体。進行方向へ向ければ抗力は最小になる。
    const areas = v3(6, 6, 1);
    const mass = 100;
    const nose = ballisticCoeffInv(areas, mass, v3(0, 0, 1));
    const side = ballisticCoeffInv(areas, mass, v3(1, 0, 0));
    assert.ok(Math.abs(nose - (FREE_MOLECULAR_CD * 1) / mass) < 1e-15);
    assert.ok(Math.abs(side - (FREE_MOLECULAR_CD * 6) / mass) < 1e-15);
    assert.ok(side / nose > 5.9 && side / nose < 6.1, `${side / nose}`);
  });

  test('aerodynamics: 質量が 0 以下なら係数は 0 になる', () => {
    const areas = v3(1, 1, 1);
    assert.equal(ballisticCoeffInv(areas, 0, v3(0, 0, 1)), 0);
    assert.equal(radiationPressureCoeff(areas, -1), 0);
    assert.equal(radiationPressureCoeff(areas, 2), (RADIATION_PRESSURE_COEFF * 1.5) / 2);
  });
}

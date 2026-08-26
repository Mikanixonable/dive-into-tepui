// 温度 → 表示値の表(render/blackbody.ts)の回帰テスト。**明るさの目盛りが崩れていないこと**が
// 中心で、ここが動くと赤熱するものが軒並み明るすぎるか暗すぎる絵になる。目盛りの正本は
// 「1 天文単位で太陽に正対したアルベド 1 の完全拡散面が表示値 1」で、期待値はプランクの式と
// CIE 等色関数の積分から独立に出したもの。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from './harness';
import { blackbodyEmissive } from '../../src/render/blackbody';

const HULL_EMISS = 0.85;

function valueAt(temperature: number, emissivity = HULL_EMISS): THREE.Color {
  return blackbodyEmissive(temperature, emissivity, new THREE.Color());
}

export function register(): void {
  test('blackbody: 赤熱の明るさが放射量の目盛りに乗っている', () => {
    // 輻射率 1 の黒体の表示値は 1500 K で R = 0.558、1300 K で 0.0525(プランク × CIE の積分)。
    const hot = valueAt(1500);
    const dull = valueAt(1300);
    assert.ok(Math.abs(hot.r - 0.558 * HULL_EMISS) < 0.02 * hot.r, `1500 K で R=${hot.r}`);
    assert.ok(Math.abs(hot.g - 0.0921 * HULL_EMISS) < 0.05 * hot.g, `1500 K で G=${hot.g}`);
    assert.ok(Math.abs(dull.r - 0.0525 * HULL_EMISS) < 0.02 * dull.r, `1300 K で R=${dull.r}`);
  });

  test('blackbody: 温度が上がるほど明るく、赤から白へ寄る', () => {
    let previous = valueAt(1000);
    for (let t = 1100; t <= 2600; t += 100) {
      const value = valueAt(t);
      assert.ok(value.r > previous.r, `${t} K で R が増えない`);
      assert.ok(value.g >= previous.g, `${t} K で G が減る`);
      previous = value;
    }
    // 高温ほど R と G の比が 1 へ近づく(色度が白へ寄る)。
    assert.ok(valueAt(2600).g / valueAt(2600).r > valueAt(1300).g / valueAt(1300).r);
  });

  test('blackbody: 色域の外へ出た成分が負にならない', () => {
    for (let t = 800; t <= 3000; t += 50) {
      const value = valueAt(t);
      assert.ok(value.r >= 0 && value.g >= 0 && value.b >= 0, `${t} K で負の成分 ${value.getHexString()}`);
    }
  });

  test('blackbody: 冷たい物体は光らず、明るさは輻射率に比例する', () => {
    // 影の中のアルベド 0.3 の面(表示値 0.028)の 1% にも届かない。
    assert.ok(valueAt(1000).r < 2.8e-4, `1000 K で R=${valueAt(1000).r}`);
    assert.equal(valueAt(1500, 0).r, 0, '輻射率0なら光らない');
    const half = valueAt(1500, 0.5).r;
    assert.ok(Math.abs(valueAt(1500, 1).r - 2 * half) < 1e-9 * half);
  });

  test('blackbody: 表の範囲外の温度でも値が壊れない', () => {
    assert.equal(valueAt(300).r, valueAt(800).r, '下端より冷たい温度は下端に張り付く');
    assert.equal(valueAt(6000).r, valueAt(3000).r, '上端より熱い温度は上端に張り付く');
  });
}

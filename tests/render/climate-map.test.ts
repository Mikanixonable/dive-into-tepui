import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { AnnualClimateMap } from '../../src/render/cloud/climate-map';
import { climateValuesAtCpu } from '../../src/render/cloud/climate-pixels';
import type { Vec3 } from '../../src/math/vec3';

// 正距円筒の texel 中心へ向く単位方向。u = (x+0.5)/width が経度(0.5 が本初子午線 +Z)、
// v = (y+0.5)/height が緯度(0 が北極 +Y)。行 0 が画像の先頭行。
function directionAtTexelCenter(x: number, y: number, width: number, height: number): Vec3 {
  const longitude = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
  const latitude = (0.5 - (y + 0.5) / height) * Math.PI;
  return v3(
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
    Math.cos(latitude) * Math.cos(longitude),
  );
}

// 緯度・経度 [rad] の単位方向。正距円筒の取り決めで経度 0 が +Z、東が +X、北極が +Y。
function directionAtLatLon(latitude: number, longitude: number): Vec3 {
  return v3(
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
    Math.cos(latitude) * Math.cos(longitude),
  );
}

// width×height の RGB8 画素列。texel (x,y) の値は rgbAt が返す値をそのまま持つ。
function pixels(
  width: number, height: number,
  rgbAt: (x: number, y: number) => readonly [number, number, number],
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [r, g, b] = rgbAt(x, y);
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return data;
}

export function register(): void {
  test('climate map: valuesAtCpu は texel の値を目盛りへ復号して返す', () => {
    // 4×2 の気候画像。texel (1,0) に既知の値を置く。
    const data = pixels(4, 2, (x, y) => (x === 1 && y === 0 ? [128, 64, 32] : [0, 0, 0]));
    const climate = AnnualClimateMap.fromPixels(data, 4, 2);
    const values = climate.valuesAtCpu(directionAtTexelCenter(1, 0, 4, 2));
    assert.ok(values !== null);
    // R は −40..40 °C を 0..1、B は 0..8000 m を 0..1、G は雲量 0..1。
    const tolerance = 0.5 / 255;
    assert.ok(Math.abs(values.temperatureK - (128 / 255 * 80 + 233.15)) < tolerance);
    assert.ok(Math.abs(values.meanCloudiness - 64 / 255) < tolerance);
    assert.ok(Math.abs(values.elevationM - 32 / 255 * 8000) < 8000 * tolerance);
    // 標高 ≈1000 m は陸らしさの立ち上がり(100 m)を超えるので 1。
    assert.equal(values.landFraction, 1);
    climate.dispose();
  });

  test('climate map: 同じ方向には同じ値が返る', () => {
    const data = pixels(4, 2, (x, y) => [x * 40, y * 100, 16]);
    const climate = AnnualClimateMap.fromPixels(data, 4, 2);
    const direction = directionAtTexelCenter(2, 1, 4, 2);
    assert.deepEqual(climate.valuesAtCpu(direction), climate.valuesAtCpu(direction));
    climate.dispose();
  });

  test('climate map: 画像がまだ無い遅延読み込みでは null を返す', () => {
    const climate = AnnualClimateMap.fromDeferredUrl('earth-climate.png');
    assert.equal(climate.valuesAtCpu(directionAtTexelCenter(0, 0, 4, 2)), null);
    climate.dispose();
  });

  test('climate map: 経度方向は周回して読み、texel 間は線形に補間する', () => {
    // 全 texel の B は一定。R は x ごとに違う値にして補間と周回を見る。
    const data = pixels(4, 1, (x) => [x === 0 ? 100 : x === 3 ? 200 : 0, 0, 128]);
    const climate = AnnualClimateMap.fromPixels(data, 4, 1);
    // 列 3(u=0.875)と列 0(u=0.125)の間は経度 ±180° の継ぎ目(u=1.0)を跨ぐ。
    const acrossSeam = climate.valuesAtCpu(directionAtLatLon(0, Math.PI));
    assert.ok(acrossSeam !== null);
    // 線形補間で 200 と 100 の中間。
    const tolerance = 0.5 / 255;
    assert.ok(Math.abs(acrossSeam.temperatureK - (150 / 255 * 80 + 233.15)) < tolerance);
    climate.dispose();
  });

  test('climate map: 取り出した画素列からの復号は valuesAtCpu と一致する', () => {
    const data = pixels(8, 4, (x, y) => [x * 30, y * 60, (x + y) * 12]);
    const climate = AnnualClimateMap.fromPixels(data, 8, 4);
    const transferred = climate.climatePixels();
    assert.ok(transferred !== null);
    // worker 側が受け取る形 {width,height,data} だけから値を復号する。
    for (const direction of [
      directionAtLatLon(0.3, 1.2), directionAtLatLon(-0.7, -2.1), directionAtLatLon(1.4, 0),
    ]) {
      assert.deepEqual(climateValuesAtCpu(direction, transferred), climate.valuesAtCpu(direction));
    }
    climate.dispose();
  });

  test('climate map: 画像がまだ無い遅延読み込みでは画素列も null を返す', () => {
    const climate = AnnualClimateMap.fromDeferredUrl('earth-climate.png');
    assert.equal(climate.climatePixels(), null);
    climate.dispose();
  });
}

// 楕円体の解析法線、地理座標の周期性と回転による内積保存を検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import {
  earthNormalAtUv, earthNormalToView, earthPositionAtUv, earthRadialAtUv,
  earthSurfaceNormal, earthSurfaceUv, earthUvFromRadial,
} from '../../src/render/earth-surface-coordinate';

// 値の一致を、単位ベクトルとUVの倍精度丸め誤差の範囲で検査する。
function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

// この層の回帰テストを登録する。
export function register(): void {
  test('earth coordinates: 地理法線と放射方向は非一様楕円体でも相互変換できる', () => {
    // 回転楕円体と三軸楕円体のどちらにも、同じ地理法線が定義できる。
    for (const axes of [new THREE.Vector3(6378137, 6356752, 6378137), new THREE.Vector3(9, 3, 6)]) {
      for (const latitude of [0, 60, 85, -60, -85]) {
        for (const longitude of [-180, -90, 0, 90, 180]) {
          const u = longitude / 360 + 0.5;
          const v = 0.5 - latitude / 180;
          const position = earthPositionAtUv(u, v, axes);
          near(position.clone().divide(axes).length(), 1);
          const normal = earthSurfaceNormal(position, axes);
          near(normal.distanceTo(earthNormalAtUv(u, v)), 0);
          for (const uv of [earthSurfaceUv(position, axes), earthUvFromRadial(earthRadialAtUv(u, v, axes), axes)]) {
            near(Math.sin(2 * Math.PI * (uv.x - u)), 0);
            near(uv.y, v);
          }
        }
      }
    }
  });

  test('earth coordinates: 法線は接線と直交し放射方向との混同を検出する', () => {
    const axes = new THREE.Vector3(9, 3, 6);
    const point = earthPositionAtUv(0.63, 0.2, axes);
    const normal = earthSurfaceNormal(point, axes);
    const epsilon = 1e-6;
    const east = earthPositionAtUv(0.63 + epsilon, 0.2, axes)
      .sub(earthPositionAtUv(0.63 - epsilon, 0.2, axes)).normalize();
    assert.ok(Math.abs(normal.dot(east)) < 1e-9);
    assert.ok(normal.angleTo(point.clone().normalize()) > 0.1);
  });

  test('earth coordinates: 経度境界と両極は同じ地理位置へ連続する', () => {
    const axes = new THREE.Vector3(9, 3, 6);
    for (const v of [0, 0.1, 0.5, 0.9, 1]) {
      near(earthPositionAtUv(0, v, axes).distanceTo(earthPositionAtUv(1, v, axes)), 0);
      assert.ok(earthPositionAtUv(1e-9, v, axes).distanceTo(earthPositionAtUv(1 - 1e-9, v, axes)) < 1e-6);
    }
    for (const v of [0, 1]) {
      for (const u of [-2, 0, 0.37, 1, 3]) {
        near(earthPositionAtUv(u, v, axes).x, 0);
        near(earthPositionAtUv(u, v, axes).z, 0);
        near(earthSurfaceUv(earthPositionAtUv(u, v, axes), axes).y, v);
      }
    }
  });

  test('earth coordinates: 実法線のview変換は光源との内積を保存する', () => {
    const normal = earthSurfaceNormal(new THREE.Vector3(4, 2, 3), new THREE.Vector3(9, 3, 6));
    const light = new THREE.Vector3(1, 3, -2).normalize();
    const rotation = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(0.9, 2.3, -1.1),
    ));
    const transformed = earthNormalToView(normal, rotation);
    near(transformed.dot(light.clone().applyMatrix3(rotation)), normal.dot(light));
    near(transformed.length(), 1);
  });
}

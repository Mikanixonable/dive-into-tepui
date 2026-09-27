// 対流圏の天井(圏界面)の高さと、そこから決まる上層の雲の高さ。
import * as THREE from 'three/webgpu';
import { abs, smoothstep } from 'three/tsl';
import type { FloatNode } from '../tsl-types';

// 圏界面の高さ [m] とその緯度依存。熱帯で 16〜17 km、極で 9 km 前後で、亜熱帯のジェットの下で
// 段をなして下がる(NCAR ACOM「Cloud Tops and Tropopause」)。深い対流はここに当たって横へ広がる
// ので、対流の天井そのものになる。
const TROPOPAUSE_EQUATOR = 17000;
const TROPOPAUSE_POLE = 9000;
const TROPOPAUSE_STEP_START = THREE.MathUtils.degToRad(15);
const TROPOPAUSE_STEP_END = THREE.MathUtils.degToRad(60);

// 滑らかさ 0 の上層の雲(巻雲)が圏界面から下がる深さ [m]。かなとこ(滑らかさ 1)は圏界面に張り付く。
// 巻雲の典型の高さ(中緯度で 7〜10 km)に届く調整値。
const CIRRUS_DEPTH_BELOW_TROPOPAUSE = 2500;

// 緯度 latitude [rad] における圏界面の高さ [m]。
export function tropopauseAt(latitude: FloatNode): FloatNode {
  const drop = smoothstep(TROPOPAUSE_STEP_START, TROPOPAUSE_STEP_END, abs(latitude));
  return drop.mul(TROPOPAUSE_POLE - TROPOPAUSE_EQUATOR).add(TROPOPAUSE_EQUATOR);
}

// 緯度 latitude [rad]、滑らかさ smoothness 0..1 の上層の雲の高さ [m]。
export function upperCloudAltitude(latitude: FloatNode, smoothness: FloatNode): FloatNode {
  return tropopauseAt(latitude).sub(smoothness.oneMinus().mul(CIRRUS_DEPTH_BELOW_TROPOPAUSE));
}

// 積雲場の共通定数と、coverage を柱の光学的厚みへ変換する規則。coverage は雲頂の高さや
// 不透明面へ変換せず、cloud-density.ts が高度方向の密度へ広げて使う。
import * as THREE from 'three/webgpu';
import { log, min, uniform } from 'three/tsl';
import type { FloatNode, FloatUniform } from '../tsl-types';

export const CLOUD_ALBEDO = 0.8;

export const EMPTY_CLOUD_FIELD = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
EMPTY_CLOUD_FIELD.minFilter = THREE.LinearMipmapLinearFilter;
EMPTY_CLOUD_FIELD.magFilter = THREE.LinearFilter;
EMPTY_CLOUD_FIELD.wrapS = THREE.RepeatWrapping;
EMPTY_CLOUD_FIELD.needsUpdate = true;

// 場の G(雲頂高度)を実寸へ戻す上限 [m]。場の G 自体は 0..1 で持つ。
export const CLOUD_TOP_SPAN = 15000;

// 旧 render-lab の入力を壊さないための互換ノブ。新しい積雲経路はこの値を読まず、coverage を
// cloudDensityAt() で連続密度へ直接変換する。
export const CUMULUS_COVERAGE_KNOB: {
  readonly center: FloatUniform;
  readonly halfWidth: FloatUniform;
} = { center: uniform(0.34), halfWidth: uniform(0.12) };

const MAX_COLUMN_COVERAGE = 0.99;

// coverage を、その柱を光が通り抜けない確率と読んだときの光学的厚み。割合 1 では発散するので、
// その手前で頭打ちにする。coverage 0 は厳密に 0 となり、晴天へ雲や影を作らない。
export function columnOpticalDepth(coverage: FloatNode): FloatNode {
  return log(min(coverage, MAX_COLUMN_COVERAGE).oneMinus()).negate();
}

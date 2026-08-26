// ライティングパスが描く光源 1 種の形。光源は共有のシェーディング入力から自分の寄与を組み、
// パスはそれを光源 1 つにつきフルスクリーン 1 枚の加算合成で照度バッファへ積む。
import * as THREE from 'three/webgpu';
import { mrt, select, vec3, vec4 } from 'three/tsl';
import type { Vec3Node } from '../../tsl-types';
import type { ShadingSample } from './shading-sample';

// 光源 1 つがシェーディング点へ届ける照度。マテリアル固有の F0(反射率の色)を知らないため、
// 鏡面は F0=1 で仮に評価した値になる — フレネル項をマテリアルパス側で掛け直す前提の、
// ライトプリパスという構成そのものが持つ制約。
export type LightContribution = {
  readonly diffuse: Vec3Node;
  readonly specular: Vec3Node;
};

export interface LightSource {
  // このフレームに寄与があるか。無い光源の描画命令はパスが発行しない。
  hasContribution(): boolean;
  // 照度バッファへ加算合成で描くマテリアル。パスが描画のたびに呼ぶので、実体は光源側が
  // 遅延生成して使い回す(設定でモードを持つ光源は、モードごとに 1 枚を持つ)。
  material(sample: ShadingSample): THREE.MeshBasicNodeMaterial;
  // 生成したマテリアルなどの GPU 資源を解放する。パスの dispose から呼ばれる。
  dispose(): void;
}

// 寄与を照度バッファ(diffuse/specular の MRT)へ加算で積むマテリアルに包む。
export function contributionMaterial(
  sample: ShadingSample, contribution: LightContribution,
): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: true,
  });
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.mrtNode = mrt({
    diffuse: vec4(select(sample.lit, contribution.diffuse, vec3(0)), 1),
    specular: vec4(select(sample.lit, contribution.specular, vec3(0)), 1),
  });
  return material;
}

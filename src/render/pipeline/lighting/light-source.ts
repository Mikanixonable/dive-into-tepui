// ライティングパスが描く光源 1 種の形。光源は共有のシェーディング入力から自分の寄与を組み、
// パスはそれを光源 1 つにつきフルスクリーン 1 枚の加算合成で照度バッファへ積む。
import * as THREE from 'three/webgpu';
import { mrt, select, vec3, vec4 } from 'three/tsl';
import type { Vec3Node } from '../../tsl-types';
import type { ShadingSample } from './shading-sample';

// 鏡面の寄与を積む照度バッファ。'far'(遠方)は近くの物体の映り込みが置き換える鏡面。'direct'(直接)は
// 遮り方を影パスなど光源自身が持つ鏡面。
export type SpecularReach = 'direct' | 'far';

// 光源 1 つがシェーディング点へ届ける照度。マテリアル固有の F0(反射率の色)を知らないため、
// 鏡面は F0=1 で仮に評価した値になる — フレネル項をマテリアルパス側で掛け直す前提の、
// ライトプリパスという構成そのものが持つ制約。
export interface LightContribution {
  readonly diffuse: Vec3Node;
  readonly specular: Vec3Node;
  readonly specularReach: SpecularReach;
}

export interface LightSource {
  // このフレームに寄与があるか。偽なら描画命令は発行されない。
  hasContribution(): boolean;
  // 照度バッファへ加算合成で描くマテリアル。毎フレーム呼ばれても再生成しないよう、実体は
  // 遅延生成して使い回す(設定でモードを持つ光源は、モードごとに 1 枚を持つ)。
  material(sample: ShadingSample): THREE.MeshBasicNodeMaterial;
  // 生成したマテリアルなどの GPU 資源を解放する。
  dispose(): void;
}

// 寄与を照度バッファ(拡散・直接の鏡面・遠方の鏡面の MRT)へ加算で積むマテリアルに包む。鏡面は
// specularReach の側の照度バッファへ積む。
export function contributionMaterial(
  sample: ShadingSample, contribution: LightContribution,
): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: true,
  });
  // 加算合成(src 1 + dst 1)。
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  // 面の無い画素は 0 を積む。
  const specular = vec4(select(sample.lit, contribution.specular, vec3(0)), 1);
  const none = vec4(vec3(0), 1);
  material.mrtNode = mrt({
    diffuse: vec4(select(sample.lit, contribution.diffuse, vec3(0)), 1),
    directSpecular: contribution.specularReach === 'direct' ? specular : none,
    farSpecular: contribution.specularReach === 'far' ? specular : none,
  });
  return material;
}

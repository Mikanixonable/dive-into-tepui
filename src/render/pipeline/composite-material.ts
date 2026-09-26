// 合成パスが全画面へ描くマテリアル。表示ごとに色だけが違い、深度は G バッファのものを描画先の深度バッファへ複製する
// (depthTest を切ったまま depthWrite を立てるので全画素が無条件に書かれる)— 後続の 3D UI パスがこの深度に対して
// テストを行う。デバッグ表示でも同じく書く。
import * as THREE from 'three/webgpu';
import { screenUV, texture } from 'three/tsl';
import type { Vec4Node } from '../tsl-types';

// 色 colorNode を描き、G バッファの深度 depthTexture を複製する合成のマテリアル。
export function compositeMaterial(colorNode: Vec4Node, depthTexture: THREE.Texture): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: true, transparent: false });
  material.colorNode = colorNode;
  material.depthNode = texture(depthTexture, screenUV).r;
  return material;
}

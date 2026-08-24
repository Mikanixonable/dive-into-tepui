// 画素ごとの視線を view 空間で組む。深度からの位置復元と、その画素を通るレイの起点・向きを
// 投影方式に依らない形で持つのがこのモジュールの責務。
//
// **「カメラ位置から復元位置を引く」形は透視投影でしか成り立たない。** 透視投影の視線は
// カメラ原点から出る 1 点束だが、平行投影では画素ごとに始点の違う平行束で、光軸上の 1 画素を
// 除いて起点も向きも違う。近平面と遠平面の同じ画素を復元して結べば、どちらの投影でも同じ
// 1 本の式で出る。
//
// 近平面の深度が 1・遠平面が 0 なのは反転深度(render/scene.ts)の約束。
import * as THREE from 'three/webgpu';
import { float, getViewPosition, normalize, screenUV, texture } from 'three/tsl';
import type { Mat4Uniform, Vec3Node } from '../tsl-types';

// その画素を通る視線。origin は近平面上の点、direction はカメラから遠ざかる単位ベクトル。
export type ViewRay = {
  readonly origin: Vec3Node;
  readonly direction: Vec3Node;
};

// 深度テクスチャの生値から復元した、その画素が写している面の view 空間位置。
//
// WGSL では screenUV の原点が上端(NodeBuilder.isFlipY が WGSL のとき偽で、fragCoord が
// そのまま使われる)。getViewPosition はその向きを前提に上下を反転して NDC を組むので、
// 深度テクスチャのサンプルと同じ screenUV をそのまま渡してよい。
export function viewPositionAt(depthTexture: THREE.Texture, projectionMatrixInverse: Mat4Uniform): Vec3Node {
  return getViewPosition(screenUV, texture(depthTexture, screenUV).r, projectionMatrixInverse);
}

// その画素を通る視線。透視投影では起点がカメラ原点から視線に沿ってずれるだけで、直線そのものは
// 変わらない。向きを近平面と遠平面の 2 点から引くので、面が近平面に乗っていても退化しない。
export function viewRayAt(projectionMatrixInverse: Mat4Uniform): ViewRay {
  const nearPoint = getViewPosition(screenUV, float(1), projectionMatrixInverse);
  const farPoint = getViewPosition(screenUV, float(0), projectionMatrixInverse);
  return { origin: nearPoint, direction: normalize(farPoint.sub(nearPoint)) };
}

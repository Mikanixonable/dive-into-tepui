// 投影方式（透視／平行）によらず、深度値から view 空間の画素レイ起点・方向を復元する計算層。
// 近平面（深さ 1）と遠平面（深さ 0）の画素位置から統一的に視線ベクトルを構築する。
import * as THREE from 'three/webgpu';
import { float, getViewPosition, normalize, screenUV, texture } from 'three/tsl';
import type { Mat4Uniform, Vec2Node, Vec3Node } from '../tsl-types';

// その画素を通る視線。origin は近平面上の点、direction はカメラから遠ざかる単位ベクトル。
type ViewRay = {
  readonly origin: Vec3Node;
  readonly direction: Vec3Node;
};

// 深度テクスチャの生値から復元した、その画素が写している面の view 空間位置。uv を渡せば
// 隣接画素の位置も同じ式で引ける。
//
// WGSL では screenUV の原点が上端(NodeBuilder.isFlipY が WGSL のとき偽で、fragCoord が
// そのまま使われる)。getViewPosition はその向きを前提に上下を反転して NDC を組むので、
// 深度テクスチャのサンプルと同じ screenUV をそのまま渡してよい。
export function viewPositionAt(
  depthTexture: THREE.Texture, projectionMatrixInverse: Mat4Uniform, uv: Vec2Node = screenUV,
): Vec3Node {
  return getViewPosition(uv, texture(depthTexture, uv).r, projectionMatrixInverse);
}

// その画素を通る視線。透視投影では起点がカメラ原点から視線に沿ってずれるだけで、直線そのものは
// 変わらない。向きを近平面と遠平面の 2 点から引くので、面が近平面に乗っていても退化しない。
// uv を渡せば隣接画素の視線も同じ式で引ける。
export function viewRayAt(projectionMatrixInverse: Mat4Uniform, uv: Vec2Node = screenUV): ViewRay {
  const nearPoint = getViewPosition(uv, float(1), projectionMatrixInverse);
  const farPoint = getViewPosition(uv, float(0), projectionMatrixInverse);
  return { origin: nearPoint, direction: normalize(farPoint.sub(nearPoint)) };
}

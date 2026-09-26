// 局所雲体積の固定層の光学的厚み診断。各 z スラブは高度方向に一様で、xy の密度は
// 変わりうるので GPU は光路の中点で評価する。小さな C9 の2層 fixture 向けの診断で、
// 任意の細かい場の製品積分器ではない。
import * as THREE from 'three/webgpu';
import { and, exp, float, int, max, min, select, sqrt, texture, vec4 } from 'three/tsl';
import type { FloatNode, Vec2Node, Vec4Node } from '../tsl-types';

export interface CloudOpticalRayNodes {
  // startAltitudeM における UV。体積の正規化された局所格子座標。
  readonly originUv: Vec2Node;
  // 局所格子の実寸の幅 [m]。UV は無次元なので、UV の傾きを水平の m へ戻すのに使う。
  readonly gridSpanEastM: number;
  readonly gridSpanNorthM: number;
  // 鉛直高度 1 m あたりの正規化 UV の変化。
  readonly uvDeltaPerAltitudeM: Vec2Node;
  // 診断光路は上向きに進む。startAltitudeM は endAltitudeM 未満であること。
  readonly startAltitudeM: FloatNode;
  readonly endAltitudeM: FloatNode;
}

// RG32F/RG16F 体積の離散高度スラブをすべて積分する。静的な JS ループでスラブごとに
// 1回のテクスチャ参照を展開する。相ごとの結果は m^-1 × m = 無次元の光学的厚み。
// 出力チャンネルは液水 τ、氷 τ、合計 τ、exp(-合計 τ)。
export function integrateCloudOpticalVolumeRayNode(
  volume: THREE.DataArrayTexture,
  layerEdgesM: Float32Array,
  ray: CloudOpticalRayNodes,
): Vec4Node {
  validateLayerEdges(volume, layerEdgesM);
  requirePositiveFinite(ray.gridSpanEastM, 'gridSpanEastM');
  requirePositiveFinite(ray.gridSpanNorthM, 'gridSpanNorthM');
  return THREE.TSL.Fn(() => {
    const liquidTau = float(0).toVar();
    const iceTau = float(0).toVar();
    const horizontalEastPerAltitude = ray.uvDeltaPerAltitudeM.x.mul(ray.gridSpanEastM);
    const horizontalNorthPerAltitude = ray.uvDeltaPerAltitudeM.y.mul(ray.gridSpanNorthM);
    const pathLengthPerAltitude = sqrt(horizontalEastPerAltitude.mul(horizontalEastPerAltitude)
      .add(horizontalNorthPerAltitude.mul(horizontalNorthPerAltitude)).add(1));

    for (let layer = 0; layer < layerEdgesM.length - 1; layer += 1) {
      const segmentStart = max(ray.startAltitudeM, float(layerEdgesM[layer]!));
      const segmentEnd = min(ray.endAltitudeM, float(layerEdgesM[layer + 1]!));
      const verticalLength = max(segmentEnd.sub(segmentStart), 0);
      const midpointAltitude = segmentStart.add(segmentEnd).mul(0.5);
      const segmentStartUv = ray.originUv.add(
        ray.uvDeltaPerAltitudeM.mul(segmentStart.sub(ray.startAltitudeM)),
      );
      const segmentEndUv = ray.originUv.add(
        ray.uvDeltaPerAltitudeM.mul(segmentEnd.sub(ray.startAltitudeM)),
      );
      const sampleUv = ray.originUv.add(
        ray.uvDeltaPerAltitudeM.mul(midpointAltitude.sub(ray.startAltitudeM)),
      );
      const sample = texture(volume, sampleUv).depth(int(layer)).level(float(0));
      const opticalPathLength = verticalLength.mul(pathLengthPerAltitude);
      // 直線光路では両端の判定で区間全体が UV 矩形の内側に留まることが保証される。
      // 外れる区間は、テクスチャの端クランプ値を積む代わりに捨てる。
      const startInsideGrid = and(
        and(segmentStartUv.x.greaterThanEqual(0), segmentStartUv.x.lessThanEqual(1)),
        and(segmentStartUv.y.greaterThanEqual(0), segmentStartUv.y.lessThanEqual(1)),
      );
      const endInsideGrid = and(
        and(segmentEndUv.x.greaterThanEqual(0), segmentEndUv.x.lessThanEqual(1)),
        and(segmentEndUv.y.greaterThanEqual(0), segmentEndUv.y.lessThanEqual(1)),
      );
      const midpointInsideGrid = and(
        and(sampleUv.x.greaterThanEqual(0), sampleUv.x.lessThanEqual(1)),
        and(sampleUv.y.greaterThanEqual(0), sampleUv.y.lessThanEqual(1)),
      );
      const insideGrid = and(and(startInsideGrid, endInsideGrid), midpointInsideGrid);
      liquidTau.addAssign(select(insideGrid, sample.r, float(0)).mul(opticalPathLength));
      iceTau.addAssign(select(insideGrid, sample.g, float(0)).mul(opticalPathLength));
    }

    const totalTau = liquidTau.add(iceTau);
    return vec4(liquidTau, iceTau, totalTau, exp(totalTau.negate()));
  })() as Vec4Node;
}

function validateLayerEdges(volume: THREE.DataArrayTexture, edges: Float32Array): void {
  const depth = (volume.image as { readonly depth: number }).depth;
  if (!(edges instanceof Float32Array) || edges.length !== depth + 1) {
    throw new RangeError('layerEdgesM must match the volume depth');
  }
  for (let index = 0; index < edges.length; index += 1) {
    if (!Number.isFinite(edges[index]!) || (index > 0 && edges[index]! <= edges[index - 1]!)) {
      throw new RangeError('layerEdgesM must be finite and strictly increasing');
    }
  }
}

// 高度 1 m あたりの光路長 [m/m]。UV の水平傾きを実寸へ戻して鉛直成分 1 と合成する。
export function cloudRayPathLengthPerAltitude(
  eastUvPerAltitudeM: number,
  northUvPerAltitudeM: number,
  gridSpanEastM: number,
  gridSpanNorthM: number,
): number {
  requireFinite(eastUvPerAltitudeM, 'eastUvPerAltitudeM');
  requireFinite(northUvPerAltitudeM, 'northUvPerAltitudeM');
  requirePositiveFinite(gridSpanEastM, 'gridSpanEastM');
  requirePositiveFinite(gridSpanNorthM, 'gridSpanNorthM');
  return Math.hypot(eastUvPerAltitudeM * gridSpanEastM, northUvPerAltitudeM * gridSpanNorthM, 1);
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

function requirePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive and finite`);
}

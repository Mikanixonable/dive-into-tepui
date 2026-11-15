// 熱帯の対流クラスタの実体。積乱雲の群れ 1 つは、活動する芯・周囲へ広がる消費
// (湿度を食べて沈降で乾かす環)・上層へ流出するかなとこの盾(東へずれた広い領域)を持つ。
// 配置は cluster-tracks.ts。周囲の乾きが次のクラスタを遠ざけるように、別のクラスタの
// 消費の環の中では強さを削る — 資源を食べるほど隙間が開く自己組織化。
import * as THREE from 'three/webgpu';
import { dot, exp, float, max, uniform } from 'three/tsl';
import { CLUSTER_COUNT, clusterPlacementAt } from './cluster-tracks';
import type { ClusterPlacement } from './cluster-tracks';
import type { FloatNode, FloatUniform, Vec3Node, Vec3Uniform } from '../tsl-types';

// 消費の環の広がり(芯の半径の何倍まで周囲が乾くか)と、流出の盾の広がりと
// 東へのずれ(芯の半径の何倍)。消費は流出より広く、群れが雨で食べた湿りの
// 乾いた囲いを作る。
const CLUSTER_HALO_SPAN = 3;
const CLUSTER_OUTFLOW_SPAN = 2.5;
const CLUSTER_OUTFLOW_EAST = 1.2;
// 別のクラスタの消費の環の中では強さを削る幅。環の内側のこの割合までは
// 強さ 0(資源が無い所に群れは立たない)、縁ではまる強さ。
const CLUSTER_INHIBIT_FULL = 0.6;
const CLUSTER_INHIBIT_START = 1.0;

// クラスタ 1 つ。配置を uniform に持ち、単位方向での芯・消費・流出の濃さを答える。
export class Cluster {
  private readonly center: Vec3Uniform = uniform(new THREE.Vector3());
  // 流出の盾がずれる向き(西進するクラスタの残骸が残る東)。
  private readonly outflowAxis: Vec3Uniform = uniform(new THREE.Vector3());
  private readonly strength: FloatUniform = uniform(0);
  private readonly radius: FloatUniform = uniform(0);

  // surfaceRadius はクラスタを置く天体の半径 [m]。
  public constructor(private readonly surfaceRadius: number) {}

  // 配置 placement を uniform へ設定する。null(存在しない)なら強さを 0 にする。
  // 半径や中心を 0 のままにすると正規化と除算が NaN を返して場全体を壊すので、
  // 強さ 0 で出力に出ない無害な値を置く。
  public place(placement: ClusterPlacement | null): void {
    if (placement === null) {
      this.strength.value = 0;
      this.center.value.set(1, 0, 0);
      this.outflowAxis.value.set(0, 1, 0);
      this.radius.value = 1;
      return;
    }
    const { latitude, longitude } = placement;
    const cosLatitude = Math.cos(latitude);
    this.center.value.set(
      cosLatitude * Math.sin(longitude), Math.sin(latitude), cosLatitude * Math.cos(longitude),
    );
    // 東方向ベクトル (cosLon, 0, −sinLon) — 西へ流されるクラスタの残骸が東へ残る。
    this.outflowAxis.value.set(Math.cos(longitude), 0, -Math.sin(longitude));
    this.strength.value = placement.strength;
    this.radius.value = placement.radius;
  }

  // 活動する芯の濃さ 0..1。積乱雲の塔が集まる被覆。
  public coreAt(direction: Vec3Node): FloatNode {
    return this.spotAt(direction, this.center, 1).mul(this.strength);
  }

  // 消費の環の濃さ 0..1。周囲の湿りを食べて沈降が乾かす、芯を囲む乾いた囲い。
  public consumedAt(direction: Vec3Node): FloatNode {
    const ring = this.spotAt(direction, this.center, CLUSTER_HALO_SPAN)
      .sub(this.spotAt(direction, this.center, 1));
    return max(ring, 0).mul(this.strength);
  }

  // 流出の盾の濃さ 0..1。芯から東へずれた、半径の数倍に広がるかなとこ。
  public outflowAt(direction: Vec3Node): FloatNode {
    const shifted = this.center
      .add(this.outflowAxis.mul(this.radius.mul(CLUSTER_OUTFLOW_EAST / this.surfaceRadius)))
      .normalize();
    return this.spotAt(direction, shifted, CLUSTER_OUTFLOW_SPAN).mul(this.strength);
  }

  // 中心 center の単位方向から、半径の span 倍を幅に持つガウス状の濃さ。
  private spotAt(direction: Vec3Node, center: Vec3Node, span: number): FloatNode {
    const offset = direction.sub(center);
    const scale = float(this.surfaceRadius).div(this.radius.mul(span));
    return exp(dot(offset, offset).mul(scale.mul(scale).negate()));
  }
}

export class Clusters {
  private readonly clusters: readonly Cluster[];

  // 配置を uniform に持つ。surfaceRadius は天体の半径 [m]。
  public constructor(private readonly surfaceRadius: number) {
    this.clusters = Array.from({ length: CLUSTER_COUNT }, () => new Cluster(surfaceRadius));
    this.syncTime(0);
  }

  // 時刻 [s] における配置を uniform へ反映する。別のクラスタの消費の環の中に
  // 生まれたクラスタは、相手の強さに応じて強さを削る — 乾ききった環に新しい
  // 群れは立たない、資源消費による間隔の自己組織化。
  public syncTime(seconds: number): void {
    const placements: readonly (ClusterPlacement | null)[] = Array.from(
      { length: CLUSTER_COUNT }, (_, i) => clusterPlacementAt(i, seconds, this.surfaceRadius),
    );
    for (const [i, cluster] of this.clusters.entries()) {
      const self = placements[i] ?? null;
      if (self === null) {
        cluster.place(null);
        continue;
      }
      let strength = self.strength;
      for (const [j, other] of placements.entries()) {
        if (j === i || other === null || other === undefined || other.strength <= strength) continue;
        const distance = greatCircleDistance(self, other, this.surfaceRadius);
        const edge = self.radius + other.radius * CLUSTER_HALO_SPAN;
        strength *= THREE.MathUtils.smoothstep(
          distance, edge * CLUSTER_INHIBIT_FULL, edge * CLUSTER_INHIBIT_START,
        );
      }
      cluster.place({ ...self, strength });
    }
  }

  // 単位方向 direction での芯の濃さの合計 0..1。
  public coreAt(direction: Vec3Node): FloatNode {
    return this.clusters.reduce<FloatNode>((sum, c) => sum.add(c.coreAt(direction)), float(0));
  }

  // 単位方向 direction での消費の環の濃さの合計 0..1。
  public consumedAt(direction: Vec3Node): FloatNode {
    return this.clusters.reduce<FloatNode>((sum, c) => sum.add(c.consumedAt(direction)), float(0));
  }

  // 単位方向 direction での流出の盾の濃さの合計 0..1。
  public outflowAt(direction: Vec3Node): FloatNode {
    return this.clusters.reduce<FloatNode>((sum, c) => sum.add(c.outflowAt(direction)), float(0));
  }
}

// 2 つの配置の中心の大圏距離 [m]。
function greatCircleDistance(
  a: ClusterPlacement, b: ClusterPlacement, surfaceRadius: number,
): number {
  const cosAngle = Math.sin(a.latitude) * Math.sin(b.latitude)
    + Math.cos(a.latitude) * Math.cos(b.latitude) * Math.cos(a.longitude - b.longitude);
  return surfaceRadius * Math.acos(Math.min(Math.max(cosAngle, -1), 1));
}

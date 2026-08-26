// 視線に沿って参加媒質を積分する器。**サンプル点の間隔が不均等でも正しい答えを出す** —
// 区間ごとの透過率を 1 − exp(−σ·Δs) から解き、間隔が一定であることをどこでも前提にしない。
// 媒質そのものは知らないので、大気にも発光する雲にも同じ器を使う。
import { exp, max, vec3 } from 'three/tsl';
import type { FloatNode, Vec3Node } from './tsl-types';

// 視線上の 1 点における媒質。
export type MediumSample = {
  // 消散係数 [1/m]。波長ごとに違ってよい。
  readonly extinction: Vec3Node;
  // 単位光学的厚みあたりに、その点が視線へ足す放射輝度。散乱なら「そこへ届く光 × 位相関数」。
  readonly source: Vec3Node;
};

// 区間を通り抜けたあとの透過率と、区間が視線へ足した放射輝度。
export type RayMarchResult = {
  readonly transmittance: Vec3Node;
  readonly radiance: Vec3Node;
};

// 区間を steps 段で積分する。distanceAt は 0..1 を区間の位置 [m] へ写す単調な写像で、
// **サンプル点の粗密はこの写像だけが決める** — 等間隔なら線形に、濃いところを細かく取りたければ
// そこで傾きを寝かせる。両端を必ず通るので、刻みをどう寄せても区間を取りこぼさない。
// medium は区間の中点で評価される。
export function rayMarch(
  steps: number,
  distanceAt: (fraction: number) => FloatNode,
  medium: (distance: FloatNode) => MediumSample,
): RayMarchResult {
  const bounds = Array.from({ length: steps + 1 }, (_, index) => distanceAt(index / steps));
  let transmittance: Vec3Node = vec3(1, 1, 1);
  let radiance: Vec3Node = vec3(0, 0, 0);
  for (let index = 0; index < steps; index++) {
    const entry = bounds[index]!;
    const exit = bounds[index + 1]!;
    const sample = medium(entry.add(exit).mul(0.5));
    // 区間 1 つぶんは解析で解く。**σ→0 でも 1 − exp(0) = 0 へ落ちる**ので、薄い区間で
    // ゼロ除算を踏まない。手前の層で既に減った光は transmittance が運ぶ。
    const stepTransmittance = exp(sample.extinction.mul(max(exit.sub(entry), 0)).negate());
    radiance = radiance.add(transmittance.mul(vec3(1, 1, 1).sub(stepTransmittance)).mul(sample.source));
    transmittance = transmittance.mul(stepTransmittance);
  }
  return { transmittance, radiance };
}

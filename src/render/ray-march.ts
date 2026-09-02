// 視線に沿って参加媒質を積分する器。**サンプル点の間隔が不均等でも正しい答えを出す** —
// 区間ごとの透過率を 1 − exp(−σ·Δs) から解き、間隔が一定であることをどこでも前提にしない。
// 媒質そのものは知らないので、大気にも発光する雲にも同じ器を使う。
import { Loop, ceil, exp, float, int, max, min, vec3 } from 'three/tsl';
import type { FloatNode, Vec3Node } from './tsl-types';

// 視線上の 1 点における媒質。
export type MediumSample = {
  // 消散係数 [1/m]。波長ごとに違ってよい。
  readonly extinction: Vec3Node;
  // 単位光学的厚みあたりに、その点が視線へ足す放射輝度。散乱なら「そこへ届く光 × 位相関数」。
  readonly source: Vec3Node;
};

// 区間を通り抜けたあとの透過率と、区間が視線へ足した放射輝度。
type RayMarchResult = {
  readonly transmittance: Vec3Node;
  readonly radiance: Vec3Node;
};

// 区間を steps 段で積分する。**steps は整数でなくてよい** — 端数のぶんは最後の段が短くなる形で
// 現れるので、steps を連続に動かすと積分値も連続に動く。distanceAt は 0..1 を区間の位置 [m] へ
// 写す単調な写像で、**サンプル点の粗密はこの写像だけが決める** — 等間隔なら線形に、濃いところを
// 細かく取りたければそこで傾きを寝かせる。両端を必ず通るので、刻みをどう寄せても区間を
// 取りこぼさない。medium は段の中点で評価される。**toVar と Loop を使うので Fn の中から呼ぶこと。**
//
// jitter は段の境目を画素ごとにずらす 0..1 の数(blue-noise.ts)。中点則のまま刻みの位相だけを
// 回すので、**どのずらし方でも元の中点則より悪くならない** — 段の中の評価位置そのものを乱数で
// 動かすと中点則ではなくなり、残差が分散に化けて桁ごと悪化するが、こちらはそうならない。
// ただし**滑らかな所では効かない**: 合成中点則の主誤差は h²/24·(g'(1)−g'(0)) という両端だけの
// 項で、刻みの位相に依らないので、ずらしても打ち消せない。効くのは被積分関数がほぼ不連続な所
// (昼夜境界)だけで、そこの帯が画素間の粒へ散る。段が 1 つ増えるぶんの負荷と引き換え。
export function rayMarch(
  steps: FloatNode,
  distanceAt: (fraction: FloatNode) => FloatNode,
  medium: (distance: FloatNode) => MediumSample,
  jitter: FloatNode | null = null,
): RayMarchResult {
  const transmittance = vec3(1, 1, 1).toVar();
  const radiance = vec3(0, 0, 0).toVar();
  const entry = distanceAt(float(0)).toVar();
  // 段の境目は (offset + 段番号)/steps を 1 で頭打ちにしたもの。jitter を渡すと最初の段だけが
  // 短くなり、**段が 1 つ増える**。頭打ちより先の段は長さ 0 へ潰れる。
  const offset = jitter ?? float(1);
  const segments = int(ceil(steps)).add(jitter === null ? 0 : 1);
  Loop({ start: 0, end: segments, type: 'int', condition: '<' }, ({ i }) => {
    const exit = distanceAt(min(offset.add(float(i)).div(steps), 1)).toVar();
    const sample = medium(entry.add(exit).mul(0.5));
    // 区間 1 つぶんは解析で解く。**σ→0 でも 1 − exp(0) = 0 へ落ちる**ので、薄い区間で
    // ゼロ除算を踏まない。手前の層で既に減った光は transmittance が運ぶ。
    const stepTransmittance = exp(sample.extinction.mul(max(exit.sub(entry), 0)).negate()).toVar();
    radiance.addAssign(transmittance.mul(vec3(1, 1, 1).sub(stepTransmittance)).mul(sample.source));
    transmittance.mulAssign(stepTransmittance);
    entry.assign(exit);
  });
  return { transmittance, radiance };
}

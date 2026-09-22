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

// 区間を steps 個のステップで積分する。**steps は整数でなくてよい** — 端数分は最後のステップが
// 短くなる形で反映されるため、steps を連続に変化させると積分値も滑らかに変化する。distanceAt は
// 0..1 を区間の距離 [m] へマッピングする単調関数であり、**サンプル点の粗密はこの写像のみが決める** —
// 等間隔なら線形に、密度を高めたい箇所では傾きを緩める。両端を確実に通るため、刻みをどう寄せても
// 区間を取りこぼさない。medium はステップの中点で評価される。**toVar と Loop を使うので Fn の中から呼ぶこと。**
//
// jitter はステップ境界を画素ごとにずらす 0..1 の乱数(blue-noise.ts)。中点則のままサンプリング位相だけを
// 回転させるため、**どのずらし方でも元の中点則より精度が悪化しない** — ステップ内の評価位置そのものを乱数で
// 動かすと中点則の性質が失われ、積分残差が分散ノイズへ転化して精度低下を招くが、本方式では生じない。
// ただし**滑らかな領域では改善効果が薄い**: 合成中点則の主誤差は h²/24·(g'(1)−g'(0)) という両端の項であり、
// サンプル位相に依らないためずらしても相殺されない。有効なのは被積分関数が急変する領域
// (昼夜境界)であり、マッハバンド状の帯をピクセル間のノイズへ分散させる。ステップが1つ増える負荷と引き換え。
export function rayMarch(
  steps: FloatNode,
  distanceAt: (fraction: FloatNode) => FloatNode,
  medium: (distance: FloatNode) => MediumSample,
  jitter: FloatNode | null = null,
): RayMarchResult {
  const transmittance = vec3(1, 1, 1).toVar();
  const radiance = vec3(0, 0, 0).toVar();
  const entry = distanceAt(float(0)).toVar();
  // ステップ境界は (offset + ステップ番号)/steps を 1 でクランプしたもの。jitter を渡すと最初のステップだけが
  // 短くなり、**ステップ数が 1 つ増える**。1 を超えた先のステップは長さ 0 へ縮退する。
  const offset = jitter ?? float(1);
  const segments = int(ceil(steps)).add(jitter === null ? 0 : 1);
  Loop({ start: 0, end: segments, type: 'int', condition: '<' }, ({ i }) => {
    const exit = distanceAt(min(offset.add(float(i)).div(steps), 1)).toVar();
    const sample = medium(entry.add(exit).mul(0.5));
    // 区間 1 つぶんは解析的に求める。**σ→0 でも 1 − exp(0) = 0 へ落ちる**ので、薄い区間で
    // ゼロ除算を踏まない。手前の層で既に減った光は transmittance が運ぶ。
    const stepTransmittance = exp(sample.extinction.mul(max(exit.sub(entry), 0)).negate()).toVar();
    radiance.addAssign(transmittance.mul(vec3(1, 1, 1).sub(stepTransmittance)).mul(sample.source));
    transmittance.mulAssign(stepTransmittance);
    entry.assign(exit);
  });
  return { transmittance, radiance };
}

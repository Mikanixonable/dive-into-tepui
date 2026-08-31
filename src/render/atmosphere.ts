// 天体ごとの、大気の見えを決める光学パラメータと、その大気を解くサンプル点の配り方。濃さは高度の
// 指数関数で表し、レイリー散乱とミー散乱がそれぞれのスケールハイトを持つ。どの高度にも「ここから
// 上は真空」という界面を置かないので、大気の広がりは決め打ちの厚みではなく散乱係数から導かれる。
// **配り方は物理ではなく、品質の段が決める予算をどの大気へ回すかの方針である。**
// 抗力を解く大気モデル(physics/atmosphere.ts)とは別の分布で、こちらは見えだけを決める。
import * as THREE from 'three/webgpu';
import { apparentSizePx } from '../math/projection';
import { ATMOSPHERE_QUALITY, type AtmosphereQuality } from './graphics-settings';

// 大気 1 つぶんの光学パラメータ。散乱係数はいずれも基準球面(天体半径)での値 [1/m]。
export type AtmosphereOptics = {
  // レイリー散乱係数 [1/m]。空の青も夕焼けの赤も、この3成分の比が決める。
  readonly rayleigh: THREE.Vector3;
  readonly rayleighScaleHeight: number; // [m]
  // ミー散乱係数 [1/m]。粒径が波長より大きく波長依存がほぼ無いので1成分で持つ。
  readonly mie: number;
  readonly mieScaleHeight: number; // [m]
  // ミー散乱の非対称因子 0..1。大きいほど前方へ強く散り、太陽のまわりのグローが締まる。
  readonly mieAnisotropy: number;
};

// 大気を持つ天体の光学パラメータ。**ここに載っている天体だけが大気を持つ。**
export const ATMOSPHERE_OPTICS: Readonly<Record<string, AtmosphereOptics>> = {
  // 標準大気の分子散乱と、視程 50km 相当のエーロゾル。
  earth: {
    rayleigh: new THREE.Vector3(5.802e-6, 13.558e-6, 33.1e-6),
    rayleighScaleHeight: 8.0e3,
    mie: 3.996e-6,
    mieScaleHeight: 1.2e3,
    mieAnisotropy: 0.8,
  },
  // 地球の 1/166 の柱密度へ CO2 の散乱断面積を掛けた分子散乱と、光学的厚み 0.3 の浮遊塵。
  // **塵が分子散乱を2桁上回る**ので、空の色は青ではなく塵の色になる。塵は地球のエーロゾルと
  // 違って大気全体へ混ざるため、スケールハイトが分子と同じになる。
  mars: {
    rayleigh: new THREE.Vector3(8.6e-8, 2.0e-7, 4.9e-7),
    rayleighScaleHeight: 11.1e3,
    mie: 2.7e-5,
    mieScaleHeight: 11.1e3,
    mieAnisotropy: 0.65,
  },
};

// 天体 id の大気。大気を持たない天体では null。
export function atmosphereOpticsOf(id: string): AtmosphereOptics | null {
  return ATMOSPHERE_OPTICS[id] ?? null;
}

// 同時に大気を描ける天体の数。
export const MAX_ATMOSPHERE_BODIES = 4;

// 品質の段ごとの、大気ぜんぶへ配れるサンプル点の合計。**段が現れるのはこの表だけで、配分は
// 予算だけを受け取る。** オフの予算 0 は「1 体も描かない」に落ちる。
const TOTAL_SAMPLES_OF_QUALITY: Readonly<Record<AtmosphereQuality, number>> = {
  [ATMOSPHERE_QUALITY.off]: 0,
  [ATMOSPHERE_QUALITY.low]: 8,
  [ATMOSPHERE_QUALITY.medium]: 16,
  [ATMOSPHERE_QUALITY.high]: 24,
};

// 描くと決めた天体へ必ず配るサンプル点の数。
const MIN_SAMPLES = 2;

// 1 体へ配るサンプル点の上限。ここを超えても絵はほとんど変わらないので、支配的な 1 体が予算を
// 吸い切る構図では余りを使わずに済ませる。
const MAX_SAMPLES = 16;

// 描くに値しないと見なす影響の下限 [画素]。**画面の 1 画素にも満たない大気は描かない。**
const MIN_SCORE = 1;

// 絵に出ないと見なす光学的厚み。地平線方向の視線がこれを下回る高度から上は描かない。
const MIN_VISIBLE_OPTICAL_DEPTH = 1e-5;

// 散乱係数 beta [1/m]・スケールハイト scaleHeight [m] の成分だけを見たときの打ち切り高度 [m]。
// 高度 h を最接近点とする地平線方向の視線が通る光学的厚みは beta·exp(−h/H)·√(2πRH) で
// 近似できるので、これが閾値を切る h を解く。
function speciesCutoff(beta: number, scaleHeight: number, surfaceRadius: number): number {
  const limbPath = Math.sqrt(2 * Math.PI * surfaceRadius * scaleHeight);
  return Math.max(scaleHeight * Math.log((beta * limbPath) / MIN_VISIBLE_OPTICAL_DEPTH), 0);
}

// 大気の裾を打ち切る高度 [m]。**密度はここまで連続に薄れているので、打ち切りは界面として
// 見えない** — 積分区間とサンプル点の密度を有限に保つためだけの境界である。
export function cutoffAltitude(optics: AtmosphereOptics, surfaceRadius: number): number {
  const rayleigh = Math.max(optics.rayleigh.x, optics.rayleigh.y, optics.rayleigh.z);
  return Math.max(
    speciesCutoff(rayleigh, optics.rayleighScaleHeight, surfaceRadius),
    speciesCutoff(optics.mie, optics.mieScaleHeight, surfaceRadius),
  );
}

// 大気を天頂方向へ通り抜ける光学的厚み。**濃さを1つの数で表すためだけの量**なので、波長ごとに
// 違うレイリー散乱は3成分の平均で潰す。
function verticalOpticalDepth(optics: AtmosphereOptics): number {
  const rayleigh = (optics.rayleigh.x + optics.rayleigh.y + optics.rayleigh.z) / 3;
  return rayleigh * optics.rayleighScaleHeight + optics.mie * optics.mieScaleHeight;
}

// その天体の大気が画面で覆う画素の数を、効きの深さで重み付けした量。**画角と解像度がここから
// 入る** — 同じ天体でも、覗き込めば影響は増える。裾球の縁までが大気を通る視線なので、覆う範囲は
// 裾球の円盤で採る。
//
// **カメラが裾球の中にいる構図では、これは必ず画面 1 枚ぶんを超える** — 視点からの直線距離が
// 裾半径を下回るので、円盤の半径が画面の高さの半分を超える。地表から空を見上げて地面が画面に
// 無い構図でも、空の色が予算から落ちることはない。
function screenImpact(optics: AtmosphereOptics, surfaceRadius: number, metersPerPixel: number): number {
  const cutoffRadius = surfaceRadius + cutoffAltitude(optics, surfaceRadius);
  const radiusPx = apparentSizePx(cutoffRadius, metersPerPixel);
  return Math.PI * radiusPx * radiusPx * -Math.expm1(-verticalOpticalDepth(optics));
}

// 大気を持つ天体 1 体。中心は描画座標、半径は [m]。
export type AtmosphereBody = {
  readonly center: THREE.Vector3;
  readonly surfaceRadius: number;
  readonly optics: AtmosphereOptics;
};

// 大気を描く候補 1 体。distance は視点から天体中心までの距離 [m] で、重ねる順序を決める。
// metersPerPixel はその距離での画面 1 画素ぶんの実距離 [m] で、影響の大きさを決める。
// **視線方向の深度ではなく直線距離で測ったものを渡すこと** — 深度は視点の背後で床打ちされ、
// 画面に写らない天体が目の前の天体と同じ影響を主張する。
export type AtmosphereCandidate = {
  readonly body: AtmosphereBody;
  readonly distance: number;
  readonly metersPerPixel: number;
};

// 大気を描く指示 1 体ぶん。steps はその大気を解くサンプル点の数で、整数でない値も採る。
export type AtmosphereDraw = {
  readonly body: AtmosphereBody;
  readonly steps: number;
};

// 予算 budget サンプルを、影響の大きい順に配る。**返す並びは視点に近い順**(合成の順序)。
// 予算で賄えない数の候補は、影響の小さい側から落ちる。
function allocateSamples(
  scored: readonly (AtmosphereCandidate & { readonly score: number })[],
  budget: number,
): readonly AtmosphereDraw[] {
  // **体数そのものを予算で削る** — 最低ぶんすら賄えない数を描くと、段を下げたのに予算を超える。
  const drawn = scored
    .filter(({ score }) => score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(MAX_ATMOSPHERE_BODIES, Math.floor(budget / MIN_SAMPLES)));
  const scoreSum = drawn.reduce((sum, { score }) => sum + score, 0);
  const shared = budget - MIN_SAMPLES * drawn.length;
  // **上限で余った予算は捨てる。** 上限が効くのは 1 体が取り分を独占しているときで、そのとき
  // 残りの候補は桁違いに小さい — 残りのスコアで割り直すと、その桁違いに小さい天体が余りを
  // 丸ごと受け取ってしまう。
  return drawn
    .map(({ body, distance, score }) => ({
      body,
      distance,
      steps: MIN_SAMPLES + Math.min(MAX_SAMPLES - MIN_SAMPLES, (shared * score) / scoreSum),
    }))
    .sort((a, b) => a.distance - b.distance)
    .map(({ body, steps }) => ({ body, steps }));
}

// このフレームに大気を描く天体を、**視点に近い順**に、それぞれのサンプル点の数を添えて返す。
// 品質の段は、大気ぜんぶへ配れるサンプル点の合計だけを決める。
export function atmosphereDraws(
  candidates: readonly AtmosphereCandidate[],
  quality: AtmosphereQuality,
): readonly AtmosphereDraw[] {
  return allocateSamples(
    candidates.map((candidate) => ({
      ...candidate,
      score: screenImpact(candidate.body.optics, candidate.body.surfaceRadius, candidate.metersPerPixel),
    })),
    TOTAL_SAMPLES_OF_QUALITY[quality],
  );
}

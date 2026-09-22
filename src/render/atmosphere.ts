// 天体大気の光学パラメータとレイマーチングサンプル点の配分方針。
// 密度分布は高度の指数関数でモデル化し、レイリー散乱・ミー散乱が各スケールハイトを持つ。
// 境界界面は設けず、散乱係数から自然な減衰境界を導出する。
// サンプル配分は描画品質設定に応じた計算リソースの最適化方針を表す。
// ※物理シミュレーション用の大気モデル（physics/atmosphere.ts）とは独立した描画専用モデル。
import type * as THREE from 'three/webgpu';
import { apparentSizePx } from '../math/projection';
import { airglowCutoffAltitude, type AirglowOptics } from './airglow';
import type { CloudRenderInput } from './cloud/cloud-render-input';

// 大気描画品質の階層。品質を上げるほどサンプリング密度が増加する。
export const ATMOSPHERE_QUALITY = { off: 0, low: 1, medium: 2, high: 3 } as const;
type AtmosphereQuality = (typeof ATMOSPHERE_QUALITY)[keyof typeof ATMOSPHERE_QUALITY];

// 大気 1 つぶんの光学パラメータ。散乱係数はいずれも基準球面(天体半径)での値 [1/m]。
export interface AtmosphereOptics {
  // レイリー散乱係数 [1/m]。空の青も夕焼けの赤も、この3成分の比が決める。
  readonly rayleigh: THREE.Vector3;
  readonly rayleighScaleHeight: number; // [m]
  // ミー散乱係数 [1/m]。粒径が波長より大きく波長依存がほぼ無いので1成分で持つ。
  readonly mie: number;
  readonly mieScaleHeight: number; // [m]
  // ミー散乱の非対称因子（0..1）。値が大きいほど前方散乱が強まり、光源周囲のグレアが収束する。
  readonly mieAnisotropy: number;
  // 大気自身の発光層。未指定なら大気は反射・散乱だけを持つ。
  readonly airglow?: AirglowOptics;
}

// 同時描画可能な大気天体の最大数。描画負荷の上限を制御する。
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
// 近似できるので、これが閾値を下回る高度 h を算出する。
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
    optics.airglow === undefined ? 0 : airglowCutoffAltitude(optics.airglow),
  );
}

// 大気の裾を打ち切る球の、天体中心からの半径 [m]。surfaceRadius は赤道半径。
export function cutoffRadius(optics: AtmosphereOptics, surfaceRadius: number): number {
  return surfaceRadius + cutoffAltitude(optics, surfaceRadius);
}

// エアグローを切った光学。**打ち切り高度は動かさない** — cutoffAltitude が見るのは発光層の
// 高度とスケールハイトだけなので、強さを 0 にすれば積分の範囲もサンプル点の配分もオンのままで、
// 絵から消えるのは発光の項だけになる。そこが切り分けの条件である。
export function withAirglowEnabled(optics: AtmosphereOptics, enabled: boolean): AtmosphereOptics {
  if (enabled || optics.airglow === undefined) return optics;
  return { ...optics, airglow: { ...optics.airglow, strength: 0 } };
}

// 大気を天頂方向へ通り抜ける光学的厚み。**濃さを1つの数で表すためだけの量**なので、波長ごとに
// 違うレイリー散乱は3成分の平均で潰す。
function verticalOpticalDepth(optics: AtmosphereOptics): number {
  const rayleigh = (optics.rayleigh.x + optics.rayleigh.y + optics.rayleigh.z) / 3;
  return rayleigh * optics.rayleighScaleHeight + optics.mie * optics.mieScaleHeight;
}

// その天体の大気が画面で覆う画素の数を、効きの深さで重み付けした量。**画角と解像度がここから
// 入る** — 同じ天体でも、覗き込めば影響は増える。裾球の縁までが大気を通る視線なので、覆う範囲は
// 裾球の円盤で採る。**カメラが裾球の中にいる構図では必ず画面 1 枚ぶんを超える**ので、地表から
// 空を見上げて地面が画面に無い構図でも、空の色は予算に残る。
function screenImpact(optics: AtmosphereOptics, surfaceRadius: number, metersPerPixel: number): number {
  const radiusPx = apparentSizePx(cutoffRadius(optics, surfaceRadius), metersPerPixel);
  return Math.PI * radiusPx * radiusPx * -Math.expm1(-verticalOpticalDepth(optics));
}

// 大気の中へ散乱の殻として立てる雲。field は焼いた雲場と、それを焼いた cap の置き方の組、
// bodyFromWorld は描画座標のベクトルを天体固定の向きへ回す行列。
export interface AtmosphereClouds {
  readonly cloud: CloudRenderInput;
  readonly bodyFromWorld: THREE.Matrix4;
}

// 大気を持つ天体 1 体。中心は描画座標、半径は [m]。**地表も大気の等密度面も、自転軸まわりの
// 相似な回転楕円体**で、surfaceRadius は赤道半径、polarRatio は極半径をそれで割った比。
// polarAxis は潰す向き(描画座標の単位ベクトル)で、真球(polarRatio = 1)では効かない。
// clouds は大気の中に立てる雲で、雲を持たない天体では null。
export interface AtmosphereBody {
  readonly center: THREE.Vector3;
  readonly surfaceRadius: number;
  readonly polarAxis: THREE.Vector3;
  readonly polarRatio: number;
  readonly optics: AtmosphereOptics;
  readonly clouds: AtmosphereClouds | null;
}

// 大気を描く候補 1 体。distance は視点から天体中心までの距離 [m] で、重ねる順序を決める。
// metersPerPixel はその距離での画面 1 画素ぶんの実距離 [m] で、影響の大きさを決める。
// **視線方向の深度ではなく直線距離で測ったものを渡すこと** — 深度は視点の背後で床打ちされ、
// 画面に写らない天体が目の前の天体と同じ影響を主張する。
export interface AtmosphereCandidate {
  readonly body: AtmosphereBody;
  readonly distance: number;
  readonly metersPerPixel: number;
}

// 大気を描く指示 1 体ぶん。steps はその大気のレイマーチングにおけるサンプル点数で、整数でない値も採る。
export interface AtmosphereDraw {
  readonly body: AtmosphereBody;
  readonly steps: number;
}

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

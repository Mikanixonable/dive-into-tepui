// 天体ごとの、大気の見えを決める光学パラメータ。濃さは高度の指数関数で表し、レイリー散乱と
// ミー散乱がそれぞれのスケールハイトを持つ。どの高度にも「ここから上は真空」という界面を
// 置かないので、大気の広がりは決め打ちの厚みではなく散乱係数から導かれる。
// 抗力を解く大気モデル(physics/atmosphere.ts)とは別の分布で、こちらは見えだけを決める。
import * as THREE from 'three/webgpu';

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

// 主天体へ足す濃い表現が、単層表現へ薄まりきる対数消散係数の差。1 桁の開きがあれば、
// その天体の大気が場を支配していると見なす。
const DENSE_WEIGHT_GAP = Math.LN10;

// 主天体へ足す濃い表現の重み 0..1。gap は第 1 候補と第 2 候補の対数消散係数の差で、候補が
// 1 体しか無いなら Infinity を渡す。**順位が入れ替わる点では gap が 0 になり、どちらが
// 主天体でも重みが 0 で一致する**ので、入れ替わりそのものは絵に出ない。
function denseWeightFromGap(gap: number): number {
  return THREE.MathUtils.smoothstep(gap, 0, DENSE_WEIGHT_GAP);
}

// 天体 id の大気。大気を持たない天体では null。
export function atmosphereOpticsOf(id: string): AtmosphereOptics | null {
  return ATMOSPHERE_OPTICS[id] ?? null;
}

// 絵に出ないと見なす光学的厚み。地平線方向の視線がこれを下回る高度から上は描かない。
const MIN_VISIBLE_OPTICAL_DEPTH = 1e-5;

// レイリー散乱係数の3成分の平均 [1/m]。濃さを1つの数で比べるためだけの量。
function meanRayleigh(optics: AtmosphereOptics): number {
  return (optics.rayleigh.x + optics.rayleigh.y + optics.rayleigh.z) / 3;
}

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

// 高度 altitude [m] における消散係数の自然対数。**天体どうしの「その場の大気の濃さ」は
// この量で比べる** — 素の指数は惑星間距離で単精度の下限を割り込み、どの天体も 0 になって
// 比較が付かなくなる。2成分の和の対数は、大きいほうを括り出して求める。
function logExtinctionAt(optics: AtmosphereOptics, altitude: number): number {
  const rayleigh = Math.log(meanRayleigh(optics)) - altitude / optics.rayleighScaleHeight;
  const mie = Math.log(optics.mie) - altitude / optics.mieScaleHeight;
  const larger = Math.max(rayleigh, mie);
  return larger + Math.log1p(Math.exp(Math.min(rayleigh, mie) - larger));
}

// 大気を持つ天体を、視点のいる場所の大気を強く作っている順に並べ、先頭へ足す濃い表現の重み 0..1
// を添えて返す。altitude は視点のその天体からの高度 [m]。**視線の向きは見ない** — 地表から空を
// 見上げて地面が視錐台に入っていなくても、空は大気の色でなければならない。
//
// **この並びは視点に近い順でもある。** 濃さは高度に対して指数で落ちるので、遠い天体が近い天体を
// 上回るのは近い側の大気がそもそも見えないときだけ。
export function rankAtmospheres<T extends { readonly optics: AtmosphereOptics }>(
  candidates: readonly { readonly body: T; readonly altitude: number }[],
): { readonly bodies: readonly T[]; readonly denseWeight: number } {
  const ranked = candidates
    .map(({ body, altitude }) => ({ body, strength: logExtinctionAt(body.optics, altitude) }))
    .sort((a, b) => b.strength - a.strength);
  // 候補が 1 体しか無いなら、その天体が場を独占している。
  const gap = ranked.length < 2 ? Infinity : ranked[0]!.strength - ranked[1]!.strength;
  return { bodies: ranked.map(({ body }) => body), denseWeight: denseWeightFromGap(gap) };
}

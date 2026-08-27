// 天体ごとの、大気の見えを決める光学パラメータと、その大気を解くサンプル点の配り方。濃さは高度の
// 指数関数で表し、レイリー散乱とミー散乱がそれぞれのスケールハイトを持つ。どの高度にも「ここから
// 上は真空」という界面を置かないので、大気の広がりは決め打ちの厚みではなく散乱係数から導かれる。
// **サンプル点の配り方は物理ではなく、品質の段ぶんの予算をどの大気へ寄せるかの方針である。**
// 抗力を解く大気モデル(physics/atmosphere.ts)とは別の分布で、こちらは見えだけを決める。
import * as THREE from 'three/webgpu';
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

// 大気 1 体を解くのに配れるサンプル点の数の段。
export const ATMOSPHERE_STEPS = { low: 2, medium: 6, high: 16 } as const;
export type AtmosphereSteps = (typeof ATMOSPHERE_STEPS)[keyof typeof ATMOSPHERE_STEPS];

// 品質の段ごとの、最も細かく描く天体へ配るサンプル点の数。
const STEPS_OF_QUALITY: Readonly<Record<AtmosphereQuality, AtmosphereSteps>> = {
  [ATMOSPHERE_QUALITY.off]: ATMOSPHERE_STEPS.low,
  [ATMOSPHERE_QUALITY.low]: ATMOSPHERE_STEPS.low,
  [ATMOSPHERE_QUALITY.medium]: ATMOSPHERE_STEPS.medium,
  [ATMOSPHERE_QUALITY.high]: ATMOSPHERE_STEPS.high,
};

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

// 裾の外の視点で強さを落とす、全天体共通のスケールハイト [m]。典型的な大気のスケールハイトの桁。
const VACUUM_RANK_SCALE_HEIGHT = 1e4;

// 並び替えに使う、その天体の大気が視点の場所を作っている強さ。裾の中では視点の消散係数の対数。
// **裾の外では天体ごとのスケールハイトで外挿を続けない** — どの大気も絵に出ない高度なのに、
// 遠方ではスケールハイトの大きい天体が距離によらず勝ってしまう。裾から先は全天体共通の減衰率で
// 落とし、裾の外の天体どうしの比較を「どちらの大気に近いか」の比較にする。
function rankStrength(optics: AtmosphereOptics, surfaceRadius: number, altitude: number): number {
  const cutoff = cutoffAltitude(optics, surfaceRadius);
  return logExtinctionAt(optics, Math.min(altitude, cutoff))
    - Math.max(altitude - cutoff, 0) / VACUUM_RANK_SCALE_HEIGHT;
}

// 細かく描く天体への寄せが、残りと同じ細かさへ薄まりきる順位の強さの差。1 桁の開きがあれば、
// その天体の大気が場を支配していると見なす。
const DETAIL_WEIGHT_GAP = Math.LN10;

// 大気の広がりを決めるもの。
type AtmosphereExtent = {
  readonly optics: AtmosphereOptics;
  readonly surfaceRadius: number;
};

// 大気を描く候補 1 体。distance は視点から天体中心までの距離 [m]。
export type AtmosphereCandidate<T extends AtmosphereExtent> = {
  readonly body: T;
  readonly distance: number;
};

// 大気を描く指示 1 体ぶん。steps はその大気を解くサンプル点の数で、段の間の実数も採る。
export type AtmosphereDraw<T extends AtmosphereExtent> = {
  readonly body: T;
  readonly steps: number;
};

// このフレームに大気を描く天体を、**視点に近い順**に、それぞれのサンプル点の数を添えて返す。
// 品質がオフなら空。同時に描ける数を超えた候補は、影響の小さいほうから落ちる。
export function atmosphereDraws<T extends AtmosphereExtent>(
  candidates: readonly AtmosphereCandidate<T>[],
  quality: AtmosphereQuality,
): readonly AtmosphereDraw<T>[] {
  if (quality === ATMOSPHERE_QUALITY.off) return [];
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      strength: rankStrength(
        candidate.body.optics, candidate.body.surfaceRadius,
        candidate.distance - candidate.body.surfaceRadius,
      ),
    }))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MAX_ATMOSPHERE_BODIES);
  // 先頭へ寄せる予算は、2 位との開きで決める。**開きが 0 の場所では残りと同じ細かさになる**ので、
  // 順位が入れ替わっても絵が飛ばない。候補が 1 体なら、その天体が場を独占している。
  const gap = ranked.length < 2 ? Infinity : ranked[0]!.strength - ranked[1]!.strength;
  const detailed = THREE.MathUtils.lerp(
    ATMOSPHERE_STEPS.low, STEPS_OF_QUALITY[quality],
    THREE.MathUtils.smoothstep(gap, 0, DETAIL_WEIGHT_GAP),
  );
  return ranked
    .map(({ body, distance }, index) => ({
      body, distance, steps: index === 0 ? detailed : ATMOSPHERE_STEPS.low,
    }))
    .sort((a, b) => a.distance - b.distance)
    .map(({ body, steps }) => ({ body, steps }));
}

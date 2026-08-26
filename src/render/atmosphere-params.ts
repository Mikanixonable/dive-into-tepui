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
};

// 大気を持つ天体の光学パラメータ。**ここに載っている天体だけが大気を持つ。**
export const ATMOSPHERE_OPTICS: Readonly<Record<string, AtmosphereOptics>> = {
  // 標準大気の分子散乱と、視程 50km 相当のエーロゾル。
  earth: {
    rayleigh: new THREE.Vector3(5.802e-6, 13.558e-6, 33.1e-6),
    rayleighScaleHeight: 8.0e3,
    mie: 3.996e-6,
    mieScaleHeight: 1.2e3,
  },
  // 地球の 1/166 の柱密度へ CO2 の散乱断面積を掛けた分子散乱と、光学的厚み 0.3 の浮遊塵。
  // **塵が分子散乱を2桁上回る**ので、空の色は青ではなく塵の色になる。塵は地球のエーロゾルと
  // 違って大気全体へ混ざるため、スケールハイトが分子と同じになる。
  mars: {
    rayleigh: new THREE.Vector3(8.6e-8, 2.0e-7, 4.9e-7),
    rayleighScaleHeight: 11.1e3,
    mie: 2.7e-5,
    mieScaleHeight: 11.1e3,
  },
};

// 天体 id の大気。大気を持たない天体では null。
export function atmosphereOpticsOf(id: string): AtmosphereOptics | null {
  return ATMOSPHERE_OPTICS[id] ?? null;
}

// レイリー散乱係数の3成分の平均 [1/m]。濃さを1つの数で比べるためだけの量。
function meanRayleigh(optics: AtmosphereOptics): number {
  return (optics.rayleigh.x + optics.rayleigh.y + optics.rayleigh.z) / 3;
}

// 高度 altitude [m] における消散係数の自然対数。**天体どうしの「その場の大気の濃さ」は
// この量で比べる** — 素の指数は惑星間距離で単精度の下限を割り込み、どの天体も 0 になって
// 比較が付かなくなる。2成分の和の対数は、大きいほうを括り出して求める。
export function logExtinctionAt(optics: AtmosphereOptics, altitude: number): number {
  const rayleigh = Math.log(meanRayleigh(optics)) - altitude / optics.rayleighScaleHeight;
  const mie = Math.log(optics.mie) - altitude / optics.mieScaleHeight;
  const larger = Math.max(rayleigh, mie);
  return larger + Math.log1p(Math.exp(Math.min(rayleigh, mie) - larger));
}

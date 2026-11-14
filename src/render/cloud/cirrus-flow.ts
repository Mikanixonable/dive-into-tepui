// 巻雲の筋の向きを表す倍角ベクトルの基準式。筋は向きを持たない線なので、向き θ を 2 倍した角の
// 単位ベクトル (cos 2θ, sin 2θ) で持つ — θ と θ+π が同じ値になり、双線形補間が向きの折り返しで
// 壊れない。その場所が 1 方向へどれだけ揃っているかの揃い度 c(0..1) を掛けるので、向きの無い所は
// 0 ベクトルになる。値は局所の東・北の基底で、雲場の B・A へ符号付き(−1..1)のまま焼く。
// ここにある式が CPU の基準で、cirrus-flow-node.ts が同じ式をシェーダグラフへ組む。

// 揃い度が立ち上がる風速と、張り付く風速 [m/s]。上層の流れが弱い所では筋の向きは決まらない。
// 筋の揃いが見えるのはジェットや渦のまわり(20 m/s 以上)なので、下は穏やかな上層の風、
// 上はジェットの芯へ合わせる。
export const CIRRUS_FLOW_SPEED_ONSET = 5;
export const CIRRUS_FLOW_SPEED_FULL = 30;

// 倍角ベクトルの成分。局所の東・北の基底で (cos 2θ, sin 2θ) × 揃い度。
interface CirrusFlow {
  readonly east: number;
  readonly north: number;
}

// 上層の風(東・北の成分 [m/s])から、筋の向き θ の倍角ベクトル (cos 2θ, sin 2θ) × 揃い度。
// θ は風の吹く向き(東が 0、北が正)。倍角の向きは風ベクトルの成分から直に組める —
// cos 2θ = (e²−n²)/(e²+n²)、sin 2θ = 2en/(e²+n²)。揃い度は風速の smoothstep(5 m/s で 0、
// 30 m/s で 1)。
export function cirrusFlowFromWind(eastMs: number, northMs: number): CirrusFlow {
  const speedSq = eastMs * eastMs + northMs * northMs;
  const speed = Math.sqrt(speedSq);
  const t = Math.min(Math.max(
    (speed - CIRRUS_FLOW_SPEED_ONSET) / (CIRRUS_FLOW_SPEED_FULL - CIRRUS_FLOW_SPEED_ONSET), 0), 1);
  const alignment = t * t * (3 - 2 * t);
  // 倍角の各成分へ揃い度を畳み込む。風が無い所は揃い度も 0 なので、床を置くのは 0 割り避けだけ。
  const inv = alignment / Math.max(speedSq, 1e-8);
  return {
    east: (eastMs * eastMs - northMs * northMs) * inv,
    north: 2 * eastMs * northMs * inv,
  };
}

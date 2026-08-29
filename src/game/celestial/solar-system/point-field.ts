// 小惑星帯・木星トロヤ群・ヒルダ群・カイパーベルト・散乱円盤の点群を、軌道要素の統計分布として
// 生成し位置を評価する。表示専用なので天体 id で引く経路(重力源・ピック対象・フォーカス対象)には
// 載せない。THREE 非依存に保ってあり、生成の決定性と分布は tests/physics で検査する。
// 各群は PointFieldDef 1つのデータで駆動する — 群を増やすには POINT_FIELD_DEFS に要素を足すだけ
// でよく、生成コード自体に群固有の分岐を増やさない。
import { AU } from '../../../physics/planet-orbit';
import { EPOCH_T_OFFSET, MU_SUN } from './constants';
import { JUPITER } from './jupiter-system';
import { mulberry32 } from '../../../math/random';
import type { PointElements, PointField } from '../point-field';

// 軌道長半径の引き方。散乱円盤だけは近日点距離 q = a(1-e) に集中する分布なので、
// a ではなく q から引いて a = q/(1-e) を逆算する。
type SizeDistribution =
  | { readonly kind: 'semiMajor'; readonly aRangeAu: readonly [number, number] }
  | { readonly kind: 'perihelion'; readonly qRangeAu: readonly [number, number] };

// 木星との平均運動共鳴で経度方向に偏らせる群(トロヤ群・ヒルダ群)の分布。
// 共鳴角 σ = p·λ_J − q·λ_H − (p−q)·ϖ_H (p:q = n_点群:n_木星)を、librationCenterDeg の
// 周りに ±librationWidthDeg で散らす。a を共鳴比どおりに取れば dσ/dt = 0 になり、σ は保たれる。
// p=q(1:1, トロヤ群)のときは (p−q) 項が消えて ϖ_H が自由になる代わり、σ が直接 λ_H を決める。
type ResonanceDistribution = {
  readonly meanMotionRatio: readonly [number, number]; // [p, q]
  readonly librationCenterDeg: number;
  readonly librationWidthDeg: number;
};

type PointFieldDef = {
  readonly id: string;
  readonly drawRadius: number; // [m] 表示上の1点の大きさ
  readonly color: number;
  readonly count: number;
  readonly size: SizeDistribution;
  readonly gapsAu?: readonly number[]; // 共鳴間隙の中心 [AU](ガウス棄却で抜く。semiMajor のみ)
  readonly eRange: readonly [number, number];
  readonly incRange: readonly [number, number]; // [rad]
  readonly resonance?: ResonanceDistribution;
};

const ASTEROID_SEED = 0x5eed_a571;

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

// カークウッド空隙のガウス棄却の標準偏差 [AU]。
const GAP_SIGMA_AU = 0.04;
// 棄却法が病的な乱数列で止まらなくなるのを防ぐ上限。到達したらその標本をそのまま採る。
const MAX_REJECTION_TRIES = 64;

const JUPITER_A_AU = JUPITER.orbit.a / AU;

const POINT_FIELD_DEFS: readonly PointFieldDef[] = [
  {
    id: 'main-belt',
    drawRadius: 3e7,
    color: 0x777777,
    count: 4000,
    size: { kind: 'semiMajor', aRangeAu: [2.0, 3.4] },
    // 木星との 4:1 / 3:1 / 7:3 / 5:2 / 2:1 平均運動共鳴によるカークウッドの空隙。
    gapsAu: [2.06, 2.5, 2.82, 2.958, 3.28],
    eRange: [0, 0.25],
    incRange: [0, 20 * DEG],
  },
  {
    id: 'trojan-l4',
    drawRadius: 3e7,
    color: 0x777777,
    count: 800,
    size: { kind: 'semiMajor', aRangeAu: [JUPITER_A_AU, JUPITER_A_AU] },
    eRange: [0, 0.15],
    incRange: [0, 25 * DEG],
    resonance: { meanMotionRatio: [1, 1], librationCenterDeg: -60, librationWidthDeg: 30 },
  },
  {
    id: 'trojan-l5',
    drawRadius: 3e7,
    color: 0x777777,
    count: 800,
    size: { kind: 'semiMajor', aRangeAu: [JUPITER_A_AU, JUPITER_A_AU] },
    eRange: [0, 0.15],
    incRange: [0, 25 * DEG],
    resonance: { meanMotionRatio: [1, 1], librationCenterDeg: 60, librationWidthDeg: 30 },
  },
  {
    // 木星と 3:2 の平均運動共鳴。σ は 0 のまわりの1つの秤動島に収まるが、そこから
    // M = 3(λ_H − λ_J) + σ となるため遠日点が木星に対して 120° おきの3方向で繰り返し、
    // 遠日点付近に長く留まる効果で群全体が三角形に見える(頂点は木星の L4/L3/L5)。
    id: 'hilda',
    drawRadius: 3e7,
    color: 0x777777,
    count: 600,
    size: { kind: 'semiMajor', aRangeAu: [3.972, 3.972] },
    eRange: [0.1, 0.3],
    incRange: [0, 20 * DEG],
    resonance: { meanMotionRatio: [3, 2], librationCenterDeg: 0, librationWidthDeg: 30 },
  },
  {
    id: 'kuiper-cold',
    drawRadius: 1.2e8,
    color: 0x5588aa,
    count: 2500,
    size: { kind: 'semiMajor', aRangeAu: [39, 48] },
    eRange: [0, 0.1],
    incRange: [0, 5 * DEG],
  },
  {
    // hot 群と別の PointFieldDef にするのは、両者が力学的に別起源で、1つの分布にまとめると
    // 傾斜角の二峰性が消えてしまうため。
    id: 'kuiper-hot',
    drawRadius: 1.2e8,
    color: 0x5588aa,
    count: 1500,
    size: { kind: 'semiMajor', aRangeAu: [39, 48] },
    eRange: [0, 0.3],
    incRange: [0, 30 * DEG],
  },
  {
    id: 'scattered-disk',
    drawRadius: 1.2e8,
    color: 0xaa8855,
    count: 1000,
    size: { kind: 'perihelion', qRangeAu: [30, 40] },
    eRange: [0.3, 0.9],
    incRange: [0, 40 * DEG],
  },
];

// 閉区間 [min, max] の一様乱数。
function uniform(rand: () => number, [min, max]: readonly [number, number]): number {
  return min + rand() * (max - min);
}

// 木星の平均黄経 [rad]。トロヤ群・ヒルダ群の共鳴基準にしか使わないので、位置の3段合成では
// なく平均黄経の一次式だけを引く。
export function jupiterMeanLongitude(t: number): number {
  const orbit = JUPITER.orbit;
  return orbit.l0 + orbit.lRate * (t + EPOCH_T_OFFSET);
}

// gaps の中心へ近いほど高い確率で棄却しながら、軌道長半径 [AU] を1つ引く。空隙は複数ありうる
// ので、各空隙の残存率の積をその標本の採択率とする。
function sampleSemiMajorAu(
  rand: () => number,
  [minAu, maxAu]: readonly [number, number],
  gapsAu: readonly number[] | undefined,
): number {
  // 空隙が無ければ一様分布そのもの。あれば採択率 keep で棄却法にかける。
  if (!gapsAu || gapsAu.length === 0) return uniform(rand, [minAu, maxAu]);
  for (let i = 0; i < MAX_REJECTION_TRIES; i++) {
    const au = uniform(rand, [minAu, maxAu]);
    let keep = 1;
    for (const gap of gapsAu) {
      const d = (au - gap) / GAP_SIGMA_AU;
      keep *= 1 - Math.exp(-0.5 * d * d);
    }
    if (rand() < keep) return au;
  }
  return (minAu + maxAu) / 2;
}

// resonance を持つ点の l0/lonPeri/meanMotion を、共鳴角 σ = p·λ_J − q·λ_H − (p−q)·ϖ_H が
// librationCenterDeg の周りに留まるよう決める。
function resonantAngles(
  rand: () => number,
  a: number,
  resonance: ResonanceDistribution,
  jupiterLambda0: number,
  jupiterLRate: number,
): { readonly lonPeri: number; readonly l0: number; readonly meanMotion: number } {
  const [p, q] = resonance.meanMotionRatio;
  const sigma = (resonance.librationCenterDeg + (rand() * 2 - 1) * resonance.librationWidthDeg) * DEG;
  if (p === q) {
    // 1:1 共鳴(トロヤ群): (p−q) 項が消えるので σ が直接 λ_H を決め、ϖ_H は自由。
    const l0 = jupiterLambda0 - sigma / p;
    return { lonPeri: rand() * TAU, l0, meanMotion: jupiterLRate * (p / q) };
  }
  const l0 = rand() * TAU;
  const lonPeri = (p * jupiterLambda0 - q * l0 - sigma) / (p - q);
  return { lonPeri, l0, meanMotion: Math.sqrt(MU_SUN / (a * a * a)) };
}

// 1群の分布定義から点を1つ引く。乱数の消費順は固定で、同じ seed からは同じ点列が出る。
function generatePoint(
  rand: () => number,
  def: PointFieldDef,
  jupiterLambda0: number,
  jupiterLRate: number,
): PointElements {
  // 近日点分布の群は a を e から逆算するので、e を先に引く。
  const e = uniform(rand, def.eRange);
  const inc = uniform(rand, def.incRange);
  const raan = rand() * TAU;

  let a: number;
  if (def.size.kind === 'perihelion') {
    const q = uniform(rand, def.size.qRangeAu) * AU;
    a = q / (1 - e);
  } else {
    a = sampleSemiMajorAu(rand, def.size.aRangeAu, def.gapsAu) * AU;
  }

  const { lonPeri, l0, meanMotion } = def.resonance
    ? resonantAngles(rand, a, def.resonance, jupiterLambda0, jupiterLRate)
    : { lonPeri: rand() * TAU, l0: rand() * TAU, meanMotion: Math.sqrt(MU_SUN / (a * a * a)) };

  return { a, e, inc, raan, lonPeri, l0, meanMotion };
}

// seed から点群全体を生成する。同じ seed からは必ず同じ結果になる。
export function generatePointField(seed: number = ASTEROID_SEED): PointField {
  const rand = mulberry32(seed);
  const jupiterLambda0 = jupiterMeanLongitude(0);
  const jupiterLRate = JUPITER.orbit.lRate;
  return POINT_FIELD_DEFS.map((def) => ({
    id: def.id,
    drawRadius: def.drawRadius,
    color: def.color,
    points: Array.from({ length: def.count }, () => generatePoint(rand, def, jupiterLambda0, jupiterLRate)),
  }));
}

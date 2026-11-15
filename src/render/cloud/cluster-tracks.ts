// 熱帯の対流クラスタ(積乱雲の群れ)の配置を、時刻の閉じた関数で答える。湿った海と
// 収束帯の上に生まれ、周囲の湿度を食べながら貿易風に乗って西へ流れ、1〜3 日で
// 消える。進路と一生は世代ごとの乱数で決まり、どの時刻へ飛んでも同じ配置になる。
import { mulberry32, randSym } from '../../math/random';

// 一様乱数を引く幅 [min, max]。
type Range = readonly [min: number, max: number];

function uniformIn(range: Range, rand: () => number): number {
  return range[0] + rand() * (range[1] - range[0]);
}

// クラスタ 1 つの配置。緯度・経度 [rad](緯度は南半球で負。経度は畳まない)、
// 強さ 0..1、芯の半径 [m]。
export interface ClusterPlacement {
  readonly latitude: number;
  readonly longitude: number;
  readonly strength: number;
  readonly radius: number;
}

// 同時に持つクラスタの数。
export const CLUSTER_COUNT = 7;

const DAY = 86400; // [s]
const DEGREE = Math.PI / 180; // [rad]

// 1 つの枡が生まれ直す周期 [s] と寿命の幅 [s]。積乱雲の群れは 1〜3 日で入れ替わる。
const CLUSTER_PERIOD = 2.5 * DAY;
const CLUSTER_LIFETIME: Range = [1 * DAY, 2.5 * DAY];
const CLUSTER_REBIRTH_GAP = 4 * 3600;
// 発生源の海域(緯度・経度の箱 [°])。赤道付近の収束帯の海上と、日射の強い夏の大陸。
// 世代で地域を巡るので、全部のクラスタが同じ海へ固まらない。
const CLUSTER_REGIONS = [
  { latitude: [5, 15] as Range, longitude: [120, 165] as Range },   // 西太平洋の暖水塊
  { latitude: [5, 13] as Range, longitude: [-120, -90] as Range },  // 東太平洋の収束帯
  { latitude: [5, 12] as Range, longitude: [-50, -20] as Range },   // 大西洋の収束帯
  { latitude: [5, 15] as Range, longitude: [55, 90] as Range },     // インド洋
  { latitude: [-10, -2] as Range, longitude: [100, 140] as Range }, // 海洋大陸
  { latitude: [-15, -5] as Range, longitude: [160, 185] as Range }, // 南太平洋収束帯
  { latitude: [-10, 0] as Range, longitude: [-70, -50] as Range },  // アマゾン
  { latitude: [-5, 5] as Range, longitude: [15, 30] as Range },     // コンゴ
];
// 貿易風に乗って西へ進む速さの幅 [m/s] と、一生のあいだの南北のずれ [°](±)。
const CLUSTER_WESTWARD: Range = [4, 8];
const CLUSTER_DRIFT = 0.8;
// 芯の半径の幅 [m]。積乱雲の群れの被覆が数百キロ級(SPEC「群れをなして…かなとこの盾」)。
const CLUSTER_RADIUS: Range = [150e3, 350e3];
// 強さの山の偏り。数時間で育って 1 日かけて衰える、早い立ち上がり。
const CLUSTER_PEAK_SKEW = 0.7;
// 乱数の種に足す塩。低気圧・高気圧・熱帯低気圧の種列と交差しない先に取る。
const CLUSTER_SEED_SALT = 1 << 22;

// クラスタ 1 つの一生。周期の頭から生まれるまでの時間 onset [s]、寿命 lifetime [s]、
// 生まれる点、西への速さ [°/s]、南北のずれ [°]、芯の半径 [m]。
interface ClusterTrack {
  readonly onset: number;
  readonly lifetime: number;
  readonly birthLatitude: number;
  readonly birthLongitude: number;
  readonly westward: number;
  readonly driftLatitude: number;
  readonly radius: number;
}

// 枡 index に世代 generation で生まれるクラスタ。乱数は世代ごとに 1 列で、引く順が一生を決める。
// surfaceRadius [m] は天体の半径で、走る速さ [m/s] を経度の進み [°/s] へ直すのに要る。
function clusterTrackOf(index: number, generation: number, surfaceRadius: number): ClusterTrack {
  const rand = mulberry32(CLUSTER_SEED_SALT + generation * CLUSTER_COUNT + index);
  const lifetime = uniformIn(CLUSTER_LIFETIME, rand);
  const onset = CLUSTER_REBIRTH_GAP / 2 + rand() * (CLUSTER_PERIOD - lifetime - CLUSTER_REBIRTH_GAP);
  // 発生源の地域は世代で巡る。
  const region = CLUSTER_REGIONS[(index + generation) % CLUSTER_REGIONS.length]!;
  const birthLatitude = uniformIn(region.latitude, rand);
  const birthLongitude = uniformIn(region.longitude, rand);
  const speed = uniformIn(CLUSTER_WESTWARD, rand);
  const westward = speed / (surfaceRadius * Math.cos(birthLatitude * DEGREE)) / DEGREE;
  const driftLatitude = randSym(CLUSTER_DRIFT, rand);
  const radius = uniformIn(CLUSTER_RADIUS, rand);
  return { onset, lifetime, birthLatitude, birthLongitude, westward, driftLatitude, radius };
}

// クラスタ index(0..CLUSTER_COUNT − 1)の、時刻 seconds [s] における配置。
// 生まれる前と消えたあとは null。
export function clusterPlacementAt(
  index: number, seconds: number, surfaceRadius: number,
): ClusterPlacement | null {
  const age = seconds / CLUSTER_PERIOD + index / CLUSTER_COUNT;
  const generation = Math.floor(age);
  const track = clusterTrackOf(index, generation, surfaceRadius);
  const life = ((age - generation) * CLUSTER_PERIOD - track.onset) / track.lifetime;
  if (life < 0 || life > 1) return null;
  const alive = life * track.lifetime;
  return {
    latitude: (track.birthLatitude + track.driftLatitude * life) * DEGREE,
    longitude: (track.birthLongitude - track.westward * alive) * DEGREE,
    strength: Math.sin(Math.PI * life ** CLUSTER_PEAK_SKEW),
    radius: track.radius,
  };
}

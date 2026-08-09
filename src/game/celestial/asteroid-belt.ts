// 小惑星帯・木星トロヤ群の点群を、軌道要素の統計分布として生成し位置を評価する。
// 表示専用なので AttractorId 系(重力源・ピック対象・フォーカス対象)には載せない。
// THREE 非依存に保ってあり、生成の決定性と分布は tests/physics で検査する。
// game-entity/asteroid.ts の Asteroid(重力を及ぼし積分される個別の GameEntity)とは別物。
import { Q_ECLY_TO_ECI } from '../../physics/ecliptic';
import { positionFromOrbitalElements, trueAnomalyFromMean } from '../../physics/elements';
import { EPOCH_T_OFFSET } from '../../physics/ephemeris';
import { AU } from '../../physics/planet-orbit';
import { MU_SUN, SOLAR_SYSTEM } from '../../physics/solar-system';
import { qRotate } from '../../physics/attitude';
import { Vec3 } from '../../physics/vec3';

// 1点の軌道。平均運動を要素と一緒に持つのは、位置評価が毎フレーム全点に及ぶため
// (a から毎回 sqrt を引くのを避ける)。
export type AsteroidElements = {
  readonly a: number; // 軌道長半径 [m]
  readonly e: number;
  readonly inc: number; // 黄道面に対する傾斜 [rad]
  readonly raan: number; // 昇交点黄経 [rad]
  readonly lonPeri: number; // 近点黄経 ϖ [rad]
  readonly l0: number; // t=0 の平均黄経 [rad]
  readonly meanMotion: number; // 平均黄経の変化率 [rad/s]
};

export type AsteroidBelt = {
  readonly mainBelt: readonly AsteroidElements[];
  readonly trojanL4: readonly AsteroidElements[];
  readonly trojanL5: readonly AsteroidElements[];
};

export const MAIN_BELT_COUNT = 4000;
export const TROJAN_COUNT_PER_POINT = 800;
export const ASTEROID_SEED = 0x5eed_a571;

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

// メインベルトの軌道長半径の分布域 [AU]。
const MAIN_BELT_MIN_AU = 2.0;
const MAIN_BELT_MAX_AU = 3.4;
// カークウッドの空隙(木星との 4:1 / 3:1 / 5:2 / 2:1 平均運動共鳴)の中心 [AU] と、
// 空隙の広がりを表すガウス棄却の標準偏差。
const KIRKWOOD_GAP_AU: readonly number[] = [2.06, 2.5, 2.82, 3.28];
const KIRKWOOD_GAP_SIGMA_AU = 0.04;
// 棄却法が病的な乱数列で止まらなくなるのを防ぐ上限。到達したらその標本をそのまま採る。
const MAX_REJECTION_TRIES = 64;

const MAIN_BELT_MAX_ECC = 0.25;
const MAIN_BELT_MAX_INC = 20 * DEG;
const TROJAN_MAX_ECC = 0.15;
const TROJAN_MAX_INC = 25 * DEG;
// L4/L5 が木星の平均黄経から離れる角、および群の経度方向の広がり(片側)。
const TROJAN_LEAD_ANGLE = 60 * DEG;
const TROJAN_LIBRATION_SPREAD = 30 * DEG;

// mulberry32。Math.random を使わないのは、セーブ・リプレイをまたいで同じ点群が要るため。
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// 木星の平均黄経 [rad]。トロヤ群の基準にしか使わないので、Ephemeris の3段合成ではなく
// 平均黄経の一次式だけを引く。
export function jupiterMeanLongitude(t: number): number {
  const orbit = SOLAR_SYSTEM.jupiter.orbit;
  return orbit.l0 + orbit.lRate * (t + EPOCH_T_OFFSET);
}

// カークウッドの空隙を抜いた軌道長半径 [m] を1つ引く。空隙の中心へ近いほど高い確率で棄却する。
// 空隙は複数あるので、各空隙の残存率の積をその標本の採択率とする。
function sampleMainBeltSemiMajor(rand: () => number): number {
  for (let i = 0; i < MAX_REJECTION_TRIES; i++) {
    const au = MAIN_BELT_MIN_AU + rand() * (MAIN_BELT_MAX_AU - MAIN_BELT_MIN_AU);
    let keep = 1;
    for (const gap of KIRKWOOD_GAP_AU) {
      const d = (au - gap) / KIRKWOOD_GAP_SIGMA_AU;
      keep *= 1 - Math.exp(-0.5 * d * d);
    }
    if (rand() < keep) return au * AU;
  }
  return ((MAIN_BELT_MIN_AU + MAIN_BELT_MAX_AU) / 2) * AU;
}

// メインベルトの1点。軌道長半径以外の要素は、観測される分布域の一様乱数で与える。
function mainBeltAsteroid(rand: () => number): AsteroidElements {
  const a = sampleMainBeltSemiMajor(rand);
  return {
    a,
    e: rand() * MAIN_BELT_MAX_ECC,
    inc: rand() * MAIN_BELT_MAX_INC,
    raan: rand() * TAU,
    lonPeri: rand() * TAU,
    l0: rand() * TAU,
    meanMotion: Math.sqrt(MU_SUN / (a * a * a)),
  };
}

// トロヤ群の1点。木星と同じ軌道長半径で、平均黄経は木星の L4/L5 から ±TROJAN_LIBRATION_SPREAD
// に散らす。平均運動には木星自身の lRate を使う — 1:1 共鳴の群なので、木星に対する経度差が
// そのまま保たれてほしい。
function trojanAsteroid(rand: () => number, leadSign: 1 | -1): AsteroidElements {
  const orbit = SOLAR_SYSTEM.jupiter.orbit;
  const offset = leadSign * TROJAN_LEAD_ANGLE + (rand() * 2 - 1) * TROJAN_LIBRATION_SPREAD;
  return {
    a: orbit.a,
    e: rand() * TROJAN_MAX_ECC,
    inc: rand() * TROJAN_MAX_INC,
    raan: rand() * TAU,
    lonPeri: rand() * TAU,
    l0: jupiterMeanLongitude(0) + offset,
    meanMotion: orbit.lRate,
  };
}

// seed から点群全体を生成する。同じ seed からは必ず同じ結果になる。
export function generateAsteroidBelt(seed: number = ASTEROID_SEED): AsteroidBelt {
  const rand = mulberry32(seed);
  const mainBelt: AsteroidElements[] = [];
  for (let i = 0; i < MAIN_BELT_COUNT; i++) mainBelt.push(mainBeltAsteroid(rand));
  const trojanL4: AsteroidElements[] = [];
  for (let i = 0; i < TROJAN_COUNT_PER_POINT; i++) trojanL4.push(trojanAsteroid(rand, 1));
  const trojanL5: AsteroidElements[] = [];
  for (let i = 0; i < TROJAN_COUNT_PER_POINT; i++) trojanL5.push(trojanAsteroid(rand, -1));
  return { mainBelt, trojanL4, trojanL5 };
}

// 生成結果を1本の配列に均す。
export function allAsteroids(belt: AsteroidBelt): readonly AsteroidElements[] {
  return [...belt.mainBelt, ...belt.trojanL4, ...belt.trojanL5];
}

// 時刻 t の太陽中心位置 [m]。ECI 化(太陽の ECI 位置を足す)は呼び出し側の仕事。
export function asteroidPositionAt(el: AsteroidElements, t: number): Vec3 {
  const m = el.l0 + el.meanMotion * t - el.lonPeri;
  const nu = trueAnomalyFromMean(m, el.e);
  const p = positionFromOrbitalElements(el.a, el.e, el.inc, el.raan, el.lonPeri - el.raan, nu);
  return qRotate(Q_ECLY_TO_ECI, p);
}

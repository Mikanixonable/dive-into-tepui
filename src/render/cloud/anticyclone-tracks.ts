// 気圧へ書き込む高気圧の丘の配置を、時刻の閉じた関数で答える。移動性の高気圧は低気圧の
// あいだの位相に生まれ、低気圧よりゆっくり東へ進んで消える。楕円・眼・温帯化を持たない
// 単純な一生で、中緯度の低気圧と同じ枡の仕組みを半位相ずらして使う — 低・高が交互に
// 一周並ぶ、教科書の気圧配置に近づけるため。
import { mulberry32, randSym } from '../../math/random';
import type { CyclonePlacement } from './cyclone-tracks';
import { LOW_COUNT } from './cyclone-tracks';
import { WAVE_NUMBER, WAVE_PHASE_SPEED, waveTroughLongitude } from './rossby-wave';

// 高気圧。低気圧と同じ枡数を、半位相ずらして持つ(偶数番が北、奇数番が南)。
export const HIGH_COUNT = LOW_COUNT;

const DAY = 86400; // [s]
const DEGREE = Math.PI / 180; // [rad]

type Range = readonly [min: number, max: number];

// 1 つの枡が生まれ直す周期 [s] と寿命の幅 [s]。高気圧は低気圧より長く留まる
// (移動性高気圧は 1〜2 週間、ブロッキングはもっと長い)。
const HIGH_PERIOD = 10 * DAY;
const HIGH_LIFETIME: Range = [7 * DAY, 12 * DAY];
const HIGH_REBIRTH_GAP = 8 * 3600;
// 生まれる緯度・消える緯度の幅 [°]。低気圧の帯(32〜67°)の赤道側寄り — 低気圧の
// あいだに座る移動性高気圧は、暴風帯の南縁から中ほどまでに出る。
const HIGH_BIRTH_LATITUDE: Range = [30, 48];
const HIGH_END_LATITUDE: Range = [35, 55];
// 高気圧は波の谷と谷の中間(尾根)の下流側へ座る — 低気圧と同じ波の錨を
// 半波長ずらして使うので、低・高が交互に一周並ぶ配置が保たれる。
const WAVE_TROUGH_WIDTH = 360 / WAVE_NUMBER;
const WAVE_RIDGE_OFFSET = WAVE_TROUGH_WIDTH / 2; // 尾根 = 谷 + 半波長 [°]
const HIGH_DOWNSTREAM = 25; // 尾根からの下流への距離 [°](低気圧と同じ下流配置)
const HIGH_LONGITUDE_JITTER = 0.15;
// 錨が波とともに東へ進む速さ [°/s]。
const WAVE_DRIFT = WAVE_PHASE_SPEED * (180 / Math.PI);
// 東への速さの幅 [m/s] と減速の指数の幅。高気圧は低気圧(10〜20 m/s)より遅く、
// 時にほとんど停滞する(ブロッキング傾向)。
const HIGH_SPEED: Range = [1.5, 5];
const HIGH_BRAKE: Range = [1.3, 1.8];
// 高さの幅 [hPa] と生まれる半径の幅 [m]、育ちの幅。高気圧は低気圧(最深 16〜32 hPa・
// 半径 600〜900 km)より浅く広い — 移動性高気圧は 5〜15 hPa 程度の盛り上がりで、
// 影響域は千 km 級。
const HIGH_DEPTH: Range = [6, 14];
const HIGH_BIRTH_RADIUS: Range = [800e3, 1200e3];
const HIGH_GROWTH: Range = [0.3, 0.8];
// 高さの山の偏り(低気圧の LOW_PEAK_SKEW と同じ形)。
const HIGH_PEAK_SKEW = 0.8;
// 長軸/短軸の比。高気圧は前線の向きへ伸びた谷よりずっと丸い。
const HIGH_ELONGATION = 1.15;

function uniformIn(range: Range, rand: () => number): number {
  return range[0] + rand() * (range[1] - range[0]);
}

// 乱数の種に足す塩。低気圧・熱帯低気圧の種列と交差しない先に取る。
const HIGH_SEED_SALT = 1 << 21;

// 枡 index に世代 generation で生まれる高気圧の一生。
interface HighTrack {
  readonly onset: number;
  readonly lifetime: number;
  readonly birthSeconds: number;
  readonly birthLatitude: number;
  readonly endLatitude: number;
  readonly birthLongitude: number;
  readonly eastward: number;
  readonly brake: number;
  readonly peakDepth: number;
  readonly birthRadius: number;
  readonly growth: number;
}

function highTrackOf(index: number, generation: number, surfaceRadius: number): HighTrack {
  const rand = mulberry32(HIGH_SEED_SALT + generation * HIGH_COUNT + index);
  const lifetime = uniformIn(HIGH_LIFETIME, rand);
  const onset = HIGH_REBIRTH_GAP / 2 + rand() * (HIGH_PERIOD - lifetime - HIGH_REBIRTH_GAP);
  const birthLatitude = uniformIn(HIGH_BIRTH_LATITUDE, rand);
  const endLatitude = uniformIn(HIGH_END_LATITUDE, rand);
  // 枡がこの世代で座る尾根の番号(谷と同じ巡回)と、生まれる時刻 [s]。
  const ridgeIndex = (Math.floor(index / 2) + generation) % WAVE_NUMBER;
  const birthSeconds = (generation - index / HIGH_COUNT) * HIGH_PERIOD + onset;
  const birthLongitude = waveTroughLongitude(ridgeIndex, birthSeconds)
    + WAVE_RIDGE_OFFSET + HIGH_DOWNSTREAM
    + randSym(HIGH_LONGITUDE_JITTER * WAVE_TROUGH_WIDTH, rand);
  const speed = uniformIn(HIGH_SPEED, rand);
  const brake = uniformIn(HIGH_BRAKE, rand);
  const peakDepth = uniformIn(HIGH_DEPTH, rand);
  const birthRadius = uniformIn(HIGH_BIRTH_RADIUS, rand);
  const growth = uniformIn(HIGH_GROWTH, rand);
  const midLatitude = (birthLatitude + endLatitude) / 2;
  const eastward = (speed * lifetime) / (surfaceRadius * Math.cos(midLatitude * DEGREE)) / DEGREE;
  const hemisphere = index % 2 === 0 ? 1 : -1;
  return {
    onset, lifetime, birthSeconds,
    birthLatitude: hemisphere * birthLatitude,
    endLatitude: hemisphere * endLatitude,
    birthLongitude, eastward, brake, peakDepth, birthRadius, growth,
  };
}

// 中緯度の高気圧 index(0..HIGH_COUNT − 1)の、時刻 seconds [s] における配置。
// 生まれる前と消えたあとは null。depth は正の盛り上がり [hPa]、latitude は半球の符号つき。
export function highPlacementAt(
  index: number, seconds: number, surfaceRadius: number,
): CyclonePlacement | null {
  const age = seconds / HIGH_PERIOD + index / HIGH_COUNT;
  const generation = Math.floor(age);
  const track = highTrackOf(index, generation, surfaceRadius);
  const life = ((age - generation) * HIGH_PERIOD - track.onset) / track.lifetime;
  if (life < 0 || life > 1) return null;
  // 直線に近い緩やかな東進。低気圧のベジエのような折れは要らない。
  const s = 1 - (1 - life) ** track.brake;
  const latitude = track.birthLatitude + (track.endLatitude - track.birthLatitude) * s;
  // 錨は波とともに東へ進む — 生まれた時刻からのドリフトを進路へ足す。
  const longitude = track.birthLongitude + track.eastward * s
    + WAVE_DRIFT * (seconds - track.birthSeconds);
  return {
    latitude: latitude * DEGREE,
    longitude: longitude * DEGREE,
    depth: track.peakDepth * Math.sin(Math.PI * life ** HIGH_PEAK_SKEW),
    radius: track.birthRadius * (1 + track.growth * life),
    elongation: HIGH_ELONGATION,
    life,
  };
}

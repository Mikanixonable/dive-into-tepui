// 気圧へ書き込む高気圧の丘の配置を、時刻の閉じた関数で答える。移動性の高気圧は上層の
// ロスビー波の尾根(谷と谷の中間)の下流側に生まれ、低気圧よりゆっくり東へ進んで消える。
// 丘の下では空気が沈降して広い晴れ間を作り、低気圧どうしの位相の中間に座ることで、
// 中緯度の空に低と高が交互に並ぶ気圧配置ができる
// (`DEVELOP/SPEC/RENDERING.md`「低気圧どうしの位相の中間には移動性の高気圧が座る」)。
// 低気圧のような発生の門は設けない — 高気圧は蛇行の弱い静かな時期を埋める背景でもある
// ので確実に現れる。代わりに尾根の振幅で高さを抑揚し、強い蛇行ほど強いブロッキング
// 高気圧にする。一生は世代ごとの乱数で決まり、どの時刻へ飛んでも同じ配置になる。
import * as THREE from 'three/webgpu';
import { mulberry32, randSym } from '../../math/random';
import {
  WAVE_NUMBER, WAVE_PHASE_SPEED, waveAmplitudeAt, waveTroughLongitude,
} from './rossby-wave';
import type { CyclonePlacement } from './cyclone-tracks';

const DAY = 86400; // [s]
const DEGREE = Math.PI / 180; // [rad]

// 一様乱数を引く幅 [min, max]。
type Range = readonly [min: number, max: number];

// 高気圧。同時に持つ枡の数(偶数番が北、奇数番が南)。枡は上層のロスビー波の尾根へ錨づき、
// 半球あたりの枡の数(6)は尾根の数(WAVE_NUMBER = 5)を 1 つだけ超える — ほとんどの世代で
// 全ての尾根に高気圧が座り、あぶれた 1 枡が同じ尾根の下流へ 2 つ目を並べる。
export const HIGH_COUNT = 12;
// 1 つの枡が候補を立て直す周期 [s] と寿命の幅 [s]。高気圧は低気圧(中央値 ~4.5 日)より
// 長く留まる — 移動性高気圧は 1〜2 週間、ブロッキングはさらに長い。周期は最長の寿命より
// 余裕を持たせ、生まれる時刻を周期の中で揺らす余地(周期 − 寿命)を残す。同じ枡で前の
// 高気圧が消えてから次が生まれるまでに必ず空く時間 [s] を、その余地の両端から取る —
// 高さ 0 で入れ替わる瞬間に中心が別の尾根へ移るので、居ない時間を挟んで丘が跳んだと
// 読めなくする。
const HIGH_PERIOD = 14 * DAY;
const HIGH_LIFETIME: Range = [7 * DAY, 12 * DAY];
const HIGH_REBIRTH_GAP = 8 * 3600;
// 生まれる緯度と消える緯度の幅 [°]。低気圧の帯(32〜67°)の赤道側寄り — 低気圧のあいだに
// 座る移動性高気圧は、暴風帯の南縁から中ほどまでに出る。
const HIGH_BIRTH_LATITUDE: Range = [30, 48];
const HIGH_END_LATITUDE: Range = [35, 55];
// 枡の経度は波の尾根へ錨づく — 尾根は谷から半波長下流。谷の間隔 [°]、尾根からさらに
// 下流への距離 [°](低気圧の谷からの下流距離と揃え、低と高が半位相ずれて交互に並ぶ
// 配置にする)、同じ尾根へ並ぶ枡どうしの下流方向の間隔 [°]、生まれる経度の揺れ(谷の
// 間隔に対する比、±。揺れは両隣の谷へ寄りすぎない範囲に留める)。
const WAVE_TROUGH_WIDTH = 360 / WAVE_NUMBER;
const WAVE_RIDGE_OFFSET = WAVE_TROUGH_WIDTH / 2;
const WAVE_HIGH_DOWNSTREAM = 25;
const HIGH_RANK_SPACING = 20;
const HIGH_LONGITUDE_JITTER = 0.1;
// 錨が波とともに東へ進む速さ [°/s]。高気圧は生まれたあとも波とともに運ばれる。
const WAVE_DRIFT = WAVE_PHASE_SPEED * (180 / Math.PI);
// 一生を平均した自力の速さの幅 [m/s] と減速の指数の幅。高気圧は低気圧(6.5〜11 m/s)より
// 遅く、時にほとんど停滞する(ブロッキング傾向)。
const HIGH_SPEED: Range = [1.5, 5];
const HIGH_BRAKE: Range = [1.3, 1.8];
// 最深の幅 [hPa] と、尾根の振幅が最深へ効く床。高気圧は低気圧(最深 12〜40 hPa)より浅い
// 盛り上がり — 移動性高気圧は 5〜15 hPa 程度。振幅は門ではなく掛け目なので、床から上の
// 効きで最深の幅の内側に留める — 蛇行の弱い時期にも確実に座り、強い蛇行(大きく張り出した
// 尾根)ほど深いブロッキング高気圧になる。
const HIGH_DEPTH: Range = [6, 14];
const HIGH_AMPLITUDE_FLOOR = 0.7;
// 生まれる半径の幅 [m] と消えるまでに半径が増える割合の幅。低気圧(550〜900 km)より広い
// 緩い丘 — 影響域は千 km 級。
const HIGH_BIRTH_RADIUS: Range = [800e3, 1200e3];
const HIGH_GROWTH: Range = [0.3, 0.8];
// 高さの山の偏り。高さ = 最深 × sin(π × life^偏り) で、最盛期が life 0.42 へ寄る
// (低気圧の LOW_PEAK_SKEW と同じ形)。
const HIGH_PEAK_SKEW = 0.8;
// 生まれてから高さの山が立ち始めるまでの時間 [s]。山の式は生まれた直後の傾きが発散する
// ので、高まりはこの時間かけて立ち上げる(低気圧の LOW_DEPTH_RAMP と同じ理由)。
const HIGH_DEPTH_RAMP = 18 * 3600;
// 長軸/短軸の比。高気圧は前線の向きへ伸びた谷(1.3)よりずっと丸い。
const HIGH_ELONGATION = 1.15;
// 乱数の種に足す塩。低気圧の一次の種(世代 × LOW_COUNT + 番号)・家族の塩(1 << 24)・
// 熱帯低気圧の塩(1 << 20)のどれとも、数千年ぶんの世代の進みでは交差しない先に取る。
const HIGH_SEED_SALT = 1 << 21;

// rand([0, 1) の生成器)から range の一様乱数。
function uniformIn(range: Range, rand: () => number): number {
  return range[0] + rand() * (range[1] - range[0]);
}

// 高気圧 1 つの一生。周期の頭から生まれるまでの時間 onset [s]、寿命 lifetime [s]、
// 生まれる時刻 birthSeconds [s](波の錨がこの時刻の尾根の位相へ置かれる)、生まれる緯度と
// 消える緯度 [°](半球の符号を含む)、生まれる経度 [°](畳まない)、消えるまでの東への
// 進み [°]、減速の指数 brake、最深 peakDepth [hPa]、生まれる半径 birthRadius [m]、
// 消えるまでに半径が増える割合 growth。
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

// 枡 index に世代 generation で生まれる高気圧の一生。発生を認めない門は無い — 高気圧は
// 静かな時期を埋める背景なので、どの世代にも立つ。乱数は(枡, 世代)ごとに 1 列で、引く順が
// 一生を決める — 時刻の閉じた関数のまま保つ。surfaceRadius [m] は天体の半径で、走る速さ
// [m/s] を経度の進み [°] へ直すのに要る。
function highTrackOf(index: number, generation: number, surfaceRadius: number): HighTrack {
  const hemisphere = index % 2 === 0 ? 1 : -1;
  const slot = Math.floor(index / 2);
  const rand = mulberry32(HIGH_SEED_SALT + generation * HIGH_COUNT + index);
  const lifetime = uniformIn(HIGH_LIFETIME, rand);
  const onset = HIGH_REBIRTH_GAP / 2 + rand() * (HIGH_PERIOD - lifetime - HIGH_REBIRTH_GAP);
  const birthLatitude = uniformIn(HIGH_BIRTH_LATITUDE, rand);
  const endLatitude = uniformIn(HIGH_END_LATITUDE, rand);
  // この世代で枡が座る尾根の番号と、同じ尾根へ並ぶ枡の中での順番(低気圧の谷と同じ巡り方)。
  // 生まれる時刻 [s] = 世代の周期の頭から onset だけ遅れ、枡の位相ずらし分だけ早い。
  const ridgeIndex = (slot + generation) % WAVE_NUMBER;
  let rank = 0;
  for (let s = 0; s < slot; s++) {
    if ((s + generation) % WAVE_NUMBER === ridgeIndex) rank++;
  }
  const birthSeconds = (generation - index / HIGH_COUNT) * HIGH_PERIOD + onset;
  const birthLongitude = waveTroughLongitude(ridgeIndex, birthSeconds, hemisphere) / DEGREE
    + WAVE_RIDGE_OFFSET + WAVE_HIGH_DOWNSTREAM + rank * HIGH_RANK_SPACING
    + randSym(HIGH_LONGITUDE_JITTER * WAVE_TROUGH_WIDTH, rand);
  // 高さは生まれる点での蛇行振幅(緯度包絡 × ストームトラック重み)で抑揚する — 発生の
  // 門ではなく強さの調整なので、弱い蛇行の尾根でも座る。緯度は半球の符号を付けて渡す。
  const amplitude = waveAmplitudeAt(hemisphere * birthLatitude * DEGREE, birthLongitude * DEGREE);
  const peakDepth = HIGH_DEPTH[0] + (HIGH_DEPTH[1] - HIGH_DEPTH[0]) * rand()
    * (HIGH_AMPLITUDE_FLOOR + (1 - HIGH_AMPLITUDE_FLOOR) * amplitude);
  const speed = uniformIn(HIGH_SPEED, rand);
  const brake = uniformIn(HIGH_BRAKE, rand);
  const birthRadius = uniformIn(HIGH_BIRTH_RADIUS, rand);
  const growth = uniformIn(HIGH_GROWTH, rand);
  // 東への進み [°]: 平均の速さで寿命のあいだ走った道のりを、生まれと消えの中ほどの
  // 緯度の緯線で測る。
  const midLatitude = (birthLatitude + endLatitude) / 2;
  const eastward = (speed * lifetime) / (surfaceRadius * Math.cos(midLatitude * DEGREE)) / DEGREE;
  return {
    onset, lifetime, birthSeconds,
    birthLatitude: hemisphere * birthLatitude,
    endLatitude: hemisphere * endLatitude,
    birthLongitude, eastward, brake, peakDepth, birthRadius, growth,
  };
}

// 中緯度の高気圧 index(0..HIGH_COUNT − 1)の、時刻 seconds [s] における配置。
// surfaceRadius [m] は天体の半径。生まれる前と消えたあとは null。depth は正の盛り上がり [hPa]。
export function highPlacementAt(
  index: number, seconds: number, surfaceRadius: number,
): CyclonePlacement | null {
  // 枡ごとに周期の位相をずらし、同じ半球の枡が揃って生まれ直さないようにする。
  const age = seconds / HIGH_PERIOD + index / HIGH_COUNT;
  const generation = Math.floor(age);
  const track = highTrackOf(index, generation, surfaceRadius);
  const life = ((age - generation) * HIGH_PERIOD - track.onset) / track.lifetime;
  if (life < 0 || life > 1) return null;
  // 折れのない緩やかな東進。道のりの進みは 1 − (1 − life)^指数 で、消えるときに止まる。
  const s = 1 - (1 - life) ** track.brake;
  const latitude = track.birthLatitude + (track.endLatitude - track.birthLatitude) * s;
  // 錨は波とともに東へ進む — 生まれた時刻からのドリフトを進路へ足す。
  const longitude = track.birthLongitude + track.eastward * s
    + WAVE_DRIFT * (seconds - track.birthSeconds);
  return {
    latitude: latitude * DEGREE,
    longitude: longitude * DEGREE,
    depth: track.peakDepth * Math.sin(Math.PI * life ** HIGH_PEAK_SKEW)
      * THREE.MathUtils.smoothstep(life * track.lifetime, 0, HIGH_DEPTH_RAMP),
    radius: track.birthRadius * (1 + track.growth * life),
    elongation: HIGH_ELONGATION,
  };
}

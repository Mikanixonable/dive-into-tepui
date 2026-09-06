// 気圧へ書き込む低気圧の谷の配置を、時刻の閉じた関数で答える。中緯度の低気圧は亜熱帯の縁に
// 生まれて東へ走り、極側で止まって埋まる。熱帯低気圧は暖かい海に 1 つずつ生まれ、貿易風に西へ
// 流されてから転向し、温帯低気圧へ変わって消える。進路と一生は世代ごとの乱数で決まり、どの時刻へ
// 飛んでも同じ配置になる。
import * as THREE from 'three/webgpu';
import { R_EARTH } from '../../game/celestial/solar-system/constants';
import { mulberry32, randSym } from '../../math/random';

// 谷 1 つの配置。緯度・経度 [rad](緯度は南半球で負。経度は畳まない)、深さ [hPa](0 以上)、
// 短軸の半径 [m]、長軸/短軸の比。
export type CyclonePlacement = {
  readonly latitude: number;
  readonly longitude: number;
  readonly depth: number;
  readonly radius: number;
  readonly elongation: number;
};

// 進路の上の点 [°]。経度は連続な数で持ち、180° をまたぐ進路は 180 を超える値で書く。
type Waypoint = {
  readonly latitude: number;
  readonly longitude: number;
};

// 進路。生まれる点 origin から消える点 terminus へ、道のりの半ば(s = 0.5)で turn を通る弧。
type Course = {
  readonly origin: Waypoint;
  readonly turn: Waypoint;
  readonly terminus: Waypoint;
};

// 一様乱数を引く幅 [min, max]。
type Range = readonly [min: number, max: number];

const DAY = 86400; // [s]
const DEGREE = Math.PI / 180; // [rad]

// 中緯度の低気圧。同時に持つ枡の数(偶数番が北、奇数番が南)。
export const LOW_COUNT = 8;
// 1 つの枡が生まれ直す周期 [s] と寿命の幅 [s]。寿命は周期より短く、生まれる時刻を周期の中で揺らす
// 余地(周期 − 寿命)を残す — 同じ枡の低気圧が毎回同じ間隔で現れない。同じ枡で前の低気圧が消えて
// から次が生まれるまでに必ず空く時間 [s] を、その余地の両端から取る — 深さ 0 の谷が入れ替わる瞬間に
// 中心が極側の東端から亜熱帯の西端へ移るので、居ない時間を挟んで 1 つの谷が跳んだと読めなくする。
const LOW_PERIOD = 7 * DAY;
const LOW_LIFETIME: Range = [4 * DAY, 6.5 * DAY];
const LOW_REBIRTH_GAP = 6 * 3600;
// 生まれる緯度と消える緯度の幅 [°]。亜熱帯の縁に生まれ、暴風帯の極側で止まる
// (`DEVELOP/SPEC/RENDERING.md`「中緯度の低気圧は生まれ、東へ走り、極側で止まって消える」)。
const LOW_BIRTH_LATITUDE: Range = [32, 45];
const LOW_END_LATITUDE: Range = [55, 67];
// 半球の枡の数と幅 [°]、半球の中の順番から枡へ進む歩幅、生まれる経度の揺れ(枡の幅に対する比、±)。
// 歩幅は枡の数と互いに素で、隣の枡の低気圧の位相を 1/4 周期ずつずらして隣どうしを離す。
const LOW_SLOT_COUNT = LOW_COUNT / 2;
const LOW_SLOT_WIDTH = 360 / LOW_SLOT_COUNT;
const LOW_SLOT_STRIDE = 3;
const LOW_LONGITUDE_JITTER = 0.1;
// 一生を平均した速さの幅 [m/s] と減速の指数の幅。道のりの進みは 1 − (1 − life)^指数 で、消えるときに
// 止まる。生まれた直後の東への速さは、平均の「指数 × 2 × (2 × 東の割合 − 1/2)」倍(= 1.4 × 指数倍)で、
// 幅の端で 7 と 20 m/s — 若い低気圧の 10〜20 m/s(`DEVELOP/SPEC/RENDERING.md`)。
const LOW_SPEED: Range = [3.5, 7];
const LOW_BRAKE: Range = [1.5, 2.0];
// 道のりの半ばで通る点の、極側への進みと東への進みに対する割合。先に東へ走り、あとで極側へ折れる。
const LOW_TURN_POLEWARD_FRACTION = 0.35;
const LOW_TURN_EASTWARD_FRACTION = 0.6;
// 最深の幅 [hPa]、生まれる半径の幅 [m]、育ち(消えるまでに半径が増える割合)の幅。**眼を持たない
// 範囲で取る** — 最深 32 hPa・半径 600 km を緯度 70° に置いても、芯で風が等圧線を横切る角は 18.1° で、
// 眼の開く門(16°)より開いている。**隣と溶けない範囲で取る** — 上の速さと寿命の幅なら、同じ半球の
// 隣どうしの中心は、両方に深さがあるあいだ最接近でも半径の和より外に留まる(3 年ぶんの実測)。
const LOW_DEPTH: Range = [16, 32];
const LOW_BIRTH_RADIUS: Range = [600e3, 900e3];
const LOW_GROWTH: Range = [0.5, 1.0];
// 深さの山の偏り。深さ = 最深 × sin(π × life^偏り) で、最盛期が life 0.42 へ寄る。
const LOW_PEAK_SKEW = 0.8;
// 長軸/短軸の比。前線の向きへ伸びた楕円。
const LOW_ELONGATION = 1.3;

// 熱帯低気圧。生まれ直す周期 [s] と寿命の幅 [s]。寿命は周期の頭から数え、残りは熱帯低気圧の無い
// 時間 — 同時には 1 つで、消えてから次が別の海域に生まれるまでに間が空く。
const TROPICAL_PERIOD = 14 * DAY;
const TROPICAL_LIFETIME: Range = [7 * DAY, 10 * DAY];
// 乱数の種に足す塩。低気圧の種(世代 × LOW_COUNT + 番号)が数千年ぶん進んでも届かない先に取る。
const TROPICAL_SEED_SALT = 1 << 20;
// 進路の揺れ [°](±): 生まれる点の緯度・経度、転向点の経度、消える点の緯度・経度。転向の位置も
// 生まれる位置も毎回違い、同じ海域でも同じ進路をなぞらない。
const TROPICAL_BIRTH_LATITUDE_JITTER = 3;
const TROPICAL_BIRTH_LONGITUDE_JITTER = 8;
const TROPICAL_TURN_LONGITUDE_JITTER = 5;
const TROPICAL_END_LATITUDE_JITTER = 4;
const TROPICAL_END_LONGITUDE_JITTER = 8;
// 最深の幅 [hPa] と生まれる半径の幅 [m]。**眼を持つ範囲で取る** — 最深 55 hPa・半径 240 km でも、
// 転向の直後の最盛期(緯度 16° 以上)で芯の風が等圧線を横切る角は 11.5° 以下で、眼が全開になる
// 門(12°)より閉じている。温帯化して深さが 6 割・半径が 1.5 倍を超えると 21° 以上に開き、眼が
// 消える門(16°)を越える。
const TROPICAL_DEPTH: Range = [55, 70];
const TROPICAL_BIRTH_RADIUS: Range = [180e3, 240e3];
// 温帯化。半径が増える割合の幅と、行き着く長軸/短軸の比の幅。それぞれ life が onset を過ぎてから
// smoothstep で立ち上がり、消えるときに行き着く — 転向のあと渦は緩く大きくなりながら浅くなり、
// 前線の向きへ伸びた楕円になる。
const TROPICAL_GROWTH: Range = [2.5, 3.5];
const TROPICAL_GROWTH_ONSET = 0.55;
const TROPICAL_FINAL_ELONGATION: Range = [1.4, 1.8];
const TROPICAL_ELONGATION_ONSET = 0.6;
// 深さの山の偏り。深さ = 最深 × sin(π × life^偏り) で、最盛期が転向(life 0.5)の直後 0.56 に来る。
const TROPICAL_PEAK_SKEW = 1.2;

// 緯度 latitude・経度 longitude [°] の進路の上の点。
function waypoint(latitude: number, longitude: number): Waypoint {
  return { latitude, longitude };
}

// 海域ごとの進路 [°]。世代の順に巡る。どの進路も、11 点で標本化した気候テクスチャの標高が全点 0 m
// (海上)で平年の雲量が 0.52 以上 — 乾いた土地の上に熱帯低気圧は立たない。
const TROPICAL_COURSES: readonly Course[] = [
  // 西太平洋、早い転向(台風)。
  { origin: waypoint(12, 152), turn: waypoint(19, 136), terminus: waypoint(38, 152) },
  // 西太平洋、遅い転向(台風)。
  { origin: waypoint(11, 160), turn: waypoint(21, 126), terminus: waypoint(36, 145) },
  // 大西洋(ハリケーン)。
  { origin: waypoint(12, -38), turn: waypoint(24, -63), terminus: waypoint(40, -42) },
  // 東太平洋(ハリケーン)。ほぼ転向せず、冷たい海の上で消える。
  { origin: waypoint(12, -100), turn: waypoint(16, -118), terminus: waypoint(24, -135) },
  // 南インド洋(サイクロン)。
  { origin: waypoint(-12, 85), turn: waypoint(-20, 62), terminus: waypoint(-35, 75) },
  // 南太平洋(サイクロン)。180° をまたぐ。
  { origin: waypoint(-12, 168), turn: waypoint(-22, 160), terminus: waypoint(-35, 188) },
];

// rand([0, 1) の生成器)から range の一様乱数。
function uniformIn(range: Range, rand: () => number): number {
  return range[0] + rand() * (range[1] - range[0]);
}

// 進路の道のり s(0 で生まれ、1 で消える)の点。turn を s = 0.5 で通る 2 次ベジエで、制御点
// 2 turn − (origin + terminus) / 2 を 3 点の重みへ畳んである。
function courseAt(course: Course, s: number): Waypoint {
  // 3 点の重み。s = 0.5 で turn だけが残る。
  const cross = (1 - s) * s;
  const originWeight = (1 - s) ** 2 - cross;
  const turnWeight = 4 * cross;
  const terminusWeight = s * s - cross;
  // 緯度と経度を別々に混ぜる。
  return waypoint(
    originWeight * course.origin.latitude + turnWeight * course.turn.latitude
      + terminusWeight * course.terminus.latitude,
    originWeight * course.origin.longitude + turnWeight * course.turn.longitude
      + terminusWeight * course.terminus.longitude,
  );
}

// 中緯度の低気圧 1 つの一生。周期の頭から生まれるまでの時間 onset [s]、寿命 lifetime [s]、進路
// course(緯度は半球の符号を含む)、減速の指数 brake、最深 peakDepth [hPa]、生まれる半径
// birthRadius [m]、消えるまでに半径が増える割合 growth。
type LowTrack = {
  readonly onset: number;
  readonly lifetime: number;
  readonly course: Course;
  readonly brake: number;
  readonly peakDepth: number;
  readonly birthRadius: number;
  readonly growth: number;
};

// 枡 index に世代 generation で生まれる低気圧。乱数は世代ごとに 1 列で、引く順が一生を決める。
function lowTrackOf(index: number, generation: number): LowTrack {
  const rand = mulberry32(generation * LOW_COUNT + index);
  const lifetime = uniformIn(LOW_LIFETIME, rand);
  const onset = LOW_REBIRTH_GAP / 2 + rand() * (LOW_PERIOD - lifetime - LOW_REBIRTH_GAP);
  const birthLatitude = uniformIn(LOW_BIRTH_LATITUDE, rand);
  const endLatitude = uniformIn(LOW_END_LATITUDE, rand);
  const slot = ((Math.floor(index / 2) * LOW_SLOT_STRIDE) % LOW_SLOT_COUNT) * LOW_SLOT_WIDTH;
  const birthLongitude = slot + randSym(LOW_LONGITUDE_JITTER * LOW_SLOT_WIDTH, rand);
  const speed = uniformIn(LOW_SPEED, rand);
  const peakDepth = uniformIn(LOW_DEPTH, rand);
  const birthRadius = uniformIn(LOW_BIRTH_RADIUS, rand);
  const growth = uniformIn(LOW_GROWTH, rand);
  const brake = uniformIn(LOW_BRAKE, rand);
  // 東への進み [°]: 平均の速さで寿命のあいだ走った道のりを、進路の中ほどの緯度の緯線で測る。
  const poleward = endLatitude - birthLatitude;
  const midLatitude = (birthLatitude + endLatitude) / 2;
  const eastward = (speed * lifetime) / (R_EARTH * Math.cos(midLatitude * DEGREE)) / DEGREE;
  // 偶数番が北、奇数番が南。先に東へ走り、あとで極側へ折れる。
  const hemisphere = index % 2 === 0 ? 1 : -1;
  const course = {
    origin: waypoint(hemisphere * birthLatitude, birthLongitude),
    turn: waypoint(
      hemisphere * (birthLatitude + LOW_TURN_POLEWARD_FRACTION * poleward),
      birthLongitude + LOW_TURN_EASTWARD_FRACTION * eastward,
    ),
    terminus: waypoint(hemisphere * endLatitude, birthLongitude + eastward),
  };
  return { onset, lifetime, course, brake, peakDepth, birthRadius, growth };
}

// 中緯度の低気圧 index(0..LOW_COUNT − 1)の、時刻 seconds [s] における配置。生まれる前と消えた
// あとは null。
export function lowPlacementAt(index: number, seconds: number): CyclonePlacement | null {
  // 枡ごとに周期の位相をずらし、同じ半球の枡が揃って生まれ直さないようにする。
  const age = seconds / LOW_PERIOD + index / LOW_COUNT;
  const generation = Math.floor(age);
  const track = lowTrackOf(index, generation);
  const life = ((age - generation) * LOW_PERIOD - track.onset) / track.lifetime;
  if (life < 0 || life > 1) return null;
  const point = courseAt(track.course, 1 - (1 - life) ** track.brake);
  return {
    latitude: point.latitude * DEGREE,
    longitude: point.longitude * DEGREE,
    depth: track.peakDepth * Math.sin(Math.PI * life ** LOW_PEAK_SKEW),
    radius: track.birthRadius * (1 + track.growth * life),
    elongation: LOW_ELONGATION,
  };
}

// 熱帯低気圧 1 つの一生。寿命 lifetime [s]、進路 course、最深 peakDepth [hPa]、生まれる半径
// birthRadius [m]、温帯化で半径が増える割合 growth と行き着く長軸/短軸の比 finalElongation。
type TropicalTrack = {
  readonly lifetime: number;
  readonly course: Course;
  readonly peakDepth: number;
  readonly birthRadius: number;
  readonly growth: number;
  readonly finalElongation: number;
};

// 世代 generation の熱帯低気圧。乱数は世代ごとに 1 列で、引く順が一生を決める。海域は世代の順に巡る。
function tropicalTrackOf(generation: number): TropicalTrack {
  const rand = mulberry32(TROPICAL_SEED_SALT + generation);
  const lifetime = uniformIn(TROPICAL_LIFETIME, rand);
  // 海域の進路を、生まれる点・転向点・消える点の順に揺らす。世代が負でも表の中を指す。
  const courseCount = TROPICAL_COURSES.length;
  const base = TROPICAL_COURSES[((generation % courseCount) + courseCount) % courseCount]!;
  const birthLatitude = base.origin.latitude + randSym(TROPICAL_BIRTH_LATITUDE_JITTER, rand);
  const birthLongitude = base.origin.longitude + randSym(TROPICAL_BIRTH_LONGITUDE_JITTER, rand);
  const turnLongitude = base.turn.longitude + randSym(TROPICAL_TURN_LONGITUDE_JITTER, rand);
  const endLatitude = base.terminus.latitude + randSym(TROPICAL_END_LATITUDE_JITTER, rand);
  const endLongitude = base.terminus.longitude + randSym(TROPICAL_END_LONGITUDE_JITTER, rand);
  // 強さと温帯化の様子。
  const peakDepth = uniformIn(TROPICAL_DEPTH, rand);
  const birthRadius = uniformIn(TROPICAL_BIRTH_RADIUS, rand);
  const growth = uniformIn(TROPICAL_GROWTH, rand);
  const finalElongation = uniformIn(TROPICAL_FINAL_ELONGATION, rand);
  const course = {
    origin: waypoint(birthLatitude, birthLongitude),
    turn: waypoint(base.turn.latitude, turnLongitude),
    terminus: waypoint(endLatitude, endLongitude),
  };
  return { lifetime, course, peakDepth, birthRadius, growth, finalElongation };
}

// 世代 0 の最盛期(life 0.5)が時刻 0 に来る位相(周期に対する比)。
const TROPICAL_PHASE = tropicalTrackOf(0).lifetime / (2 * TROPICAL_PERIOD);

// 熱帯低気圧の、時刻 seconds [s] における配置。消えてから次が生まれるまでは null。
export function tropicalPlacementAt(seconds: number): CyclonePlacement | null {
  // 周期の頭から寿命のあいだだけ居る。
  const age = seconds / TROPICAL_PERIOD + TROPICAL_PHASE;
  const generation = Math.floor(age);
  const track = tropicalTrackOf(generation);
  const life = ((age - generation) * TROPICAL_PERIOD) / track.lifetime;
  if (life > 1) return null;
  // 進路を等速で辿り、転向のあとに緩く大きくなりながら浅くなり、前線の向きへ伸びる。
  const point = courseAt(track.course, life);
  return {
    latitude: point.latitude * DEGREE,
    longitude: point.longitude * DEGREE,
    depth: track.peakDepth * Math.sin(Math.PI * life ** TROPICAL_PEAK_SKEW),
    radius: track.birthRadius * (1 + track.growth * THREE.MathUtils.smoothstep(life, TROPICAL_GROWTH_ONSET, 1)),
    elongation: 1 + (track.finalElongation - 1) * THREE.MathUtils.smoothstep(life, TROPICAL_ELONGATION_ONSET, 1),
  };
}

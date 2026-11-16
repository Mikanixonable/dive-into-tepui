// 低気圧・高気圧の気圧の起伏の配置と進路の語彙。配置は時刻の閉じた関数で求まり、進路は
// 生まれる点から消える点へ、道のりの半ばで折れる弧として持つ。中緯度の低気圧は low-tracks、
// 熱帯低気圧は tropical-tracks、高気圧は anticyclone-tracks がそれぞれの一生を組む。

// 谷・丘 1 つの配置。緯度・経度 [rad](緯度は南半球で負。経度は畳まない)、深さ [hPa](0 以上)、
// 短軸の半径 [m]、長軸/短軸の比。occlusion は閉塞の進み 0..1 — 深さの山を越えて寒冷前線が
// 温暖前線へ追いつくと立ち上がる。持たない配置(熱帯低気圧・高気圧)は閉塞しない。
export interface PressurePlacement {
  readonly latitude: number;
  readonly longitude: number;
  readonly depth: number;
  readonly radius: number;
  readonly elongation: number;
  readonly occlusion?: number;
}

// 進路の上の点 [°]。経度は連続な数で持ち、180° をまたぐ進路は 180 を超える値で書く。
interface Waypoint {
  readonly latitude: number;
  readonly longitude: number;
}

// 進路。生まれる点 origin から消える点 terminus へ、道のりの半ば(s = 0.5)で turn を通る弧。
export interface Course {
  readonly origin: Waypoint;
  readonly turn: Waypoint;
  readonly terminus: Waypoint;
}

// 一様乱数を引く幅 [min, max]。
export type Range = readonly [min: number, max: number];

export const DAY = 86400; // [s]
export const DEGREE = Math.PI / 180; // [rad]

// 緯度 latitude・経度 longitude [°] の進路の上の点。
export function waypoint(latitude: number, longitude: number): Waypoint {
  return { latitude, longitude };
}

// rand([0, 1) の生成器)から range の一様乱数。
export function uniformIn(range: Range, rand: () => number): number {
  return range[0] + rand() * (range[1] - range[0]);
}

// 進路の道のり s(0 で生まれ、1 で消える)の点。turn を s = 0.5 で通る 2 次ベジエで、制御点
// 2 turn − (origin + terminus) / 2 を 3 点の重みへ畳んである。
export function courseAt(course: Course, s: number): Waypoint {
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

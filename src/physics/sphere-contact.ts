// 球どうしの接触の幾何(掃引区間で2球の表面がどう交わったか)。
// 重力源かどうか・天体かどうかには関与しない純粋な幾何。
//
// 経路は常に三次曲線で解く。曲線の事前棄却は弦の 2〜3 倍で済み、遠い相手はそこで落ちるので、
// 次数を落として稼げる分は小さい。
// **linearSphereContact・curveSphereContact の二次・sweptSagitta は消してはならない。**
// SPEC/ORBIT.md「未確定の案」の「掃引の近似を区間ごとに粗くする分岐」を入れるための余地で、
// どこまで粗くしてよいかは tests/perf/exp10・exp11 が測る。
import { KinematicState } from './kinematic-state';
import { Vec3, add, len, scale, v3 } from './vec3';

// 区間内で表面を跨いだ瞬間。
export interface SurfaceCrossing {
  readonly toi: number; // 区間内の割合 0..1
  readonly normal: Vec3; // a から b へ向く接触法線
}

// 掃引区間で2球の表面がどう交わったか。跨ぎの向きは startsInside で決まる — false なら
// 外から内へ、true なら内から外へ。crossing が null なら、区間を通して始点と同じ側に留まる。
export interface SweptSphereContact {
  readonly startsInside: boolean;
  readonly crossing: SurfaceCrossing | null;
}

// 半径和 radiusSum の2球が、それぞれ start→end の区間を渡る間に最初に表面を跨ぐ瞬間と、
// 区間の始点で重なっていたか。入力が非有限で判定できないときだけ null を返す。
// 区間は両球で共通で、その長さは aStart→aEnd の時刻差から取る。
// 解法を選ばない窓口 — SPEC/ORBIT.md「未確定の案」の区間ごとの分岐を入れるなら、その唯一の
// 分岐点がここになるので、三次への1行のたらい回しに見えても消してはならない。
export function sweptSphereContact(
  aStart: KinematicState,
  aEnd: KinematicState,
  bStart: KinematicState,
  bEnd: KinematicState,
  radiusSum: number,
): SweptSphereContact | null {
  return curveSphereContact(aStart, aEnd, bStart, bEnd, radiusSum, 3);
}

// 弦と三次曲線の中点のずれ [m]。弦で解いたときの誤差とほぼ同じ大きさになるので、線分で
// 足りるかの見積りに使う。
export function sweptSagitta(
  aStart: KinematicState,
  aEnd: KinematicState,
  bStart: KinematicState,
  bEnd: KinematicState,
): number {
  const dt = aEnd.t - aStart.t;
  const dx = (bStart.v.x - aStart.v.x) - (bEnd.v.x - aEnd.v.x);
  const dy = (bStart.v.y - aStart.v.y) - (bEnd.v.y - aEnd.v.y);
  const dz = (bStart.v.z - aStart.v.z) - (bEnd.v.z - aEnd.v.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * dt / 8;
}

// 線分で解く実体。2球の中心がそれぞれ start→end を線形移動するとみなし、速度は読まない。
export function linearSphereContact(
  aStart: KinematicState,
  aEnd: KinematicState,
  bStart: KinematicState,
  bEnd: KinematicState,
  radiusSum: number,
): SweptSphereContact | null {
  // 相対位置 p(t) = p0 + d·t (t∈[0,1]) が半径和 radiusSum の球を跨ぐ t を解く2次方程式。
  const px = bStart.r.x - aStart.r.x;
  const py = bStart.r.y - aStart.r.y;
  const pz = bStart.r.z - aStart.r.z;
  const dx = (bEnd.r.x - bStart.r.x) - (aEnd.r.x - aStart.r.x);
  const dy = (bEnd.r.y - bStart.r.y) - (aEnd.r.y - aStart.r.y);
  const dz = (bEnd.r.z - bStart.r.z) - (aEnd.r.z - aStart.r.z);
  const startDistSq = px * px + py * py + pz * pz;
  const aa = dx * dx + dy * dy + dz * dz;
  // 非有限な入力をここで落とす。判定は `!(x >= 0)` の否定形で書く — NaN はどの比較でも
  // false になるので、この形のときだけ自動的に null へ落ちる(`x < 0` では通り抜ける)。
  if (!(radiusSum > 0) || !(startDistSq >= 0) || !(aa >= 0)) return null;

  const c = startDistSq - radiusSum * radiusSum;
  const startsInside = c <= 0;
  if (!(aa > 1e-18)) return { startsInside, crossing: null };
  const bb = 2 * (px * dx + py * dy + pz * dz);
  const discriminant = bb * bb - 4 * aa * c;
  if (!(discriminant >= 0)) return { startsInside, crossing: null };
  // 始点が外なら最初に触れる小さい方の根、内なら抜け出る大きい方の根。
  const root = Math.sqrt(discriminant);
  const toi = ((startsInside ? root : -root) - bb) / (2 * aa);
  if (!(toi >= 0 && toi <= 1)) return { startsInside, crossing: null };
  return {
    startsInside,
    crossing: crossingAt(toi, v3(px + dx * toi, py + dy * toi, pz + dz * toi)),
  };
}

// 曲線で解く実体。degree で二次・三次を選ぶ。
// 区間端点の側だけを見ると、端点の両方が同じ側でも途中だけ反対側へ出る軌道を落とす。
// ここでは相対位置(b − a)をBezierへ変換し、Bezier制御点の凸包が表面を跨ぎ得る区間だけを
// 左から再帰的に調べる。制御点の軸平行箱が丸ごと始点と同じ側にあれば、その区間に跨ぎはない。
// したがって、単なる固定サンプル列より細い通過も拾いつつ、曲線上の clearance の符号反転を
// 固定反復で詰められる。
export function curveSphereContact(
  aStart: KinematicState,
  aEnd: KinematicState,
  bStart: KinematicState,
  bEnd: KinematicState,
  radiusSum: number,
  degree: 2 | 3,
): SweptSphereContact | null {
  const dt = aEnd.t - aStart.t;
  if (!Number.isFinite(dt) || !Number.isFinite(radiusSum) || !(radiusSum > 0)) return null;
  // 制御点はまずスカラー座標として求める。遠すぎて棄却される相手が大半なので、凸包の箱で
  // 落ちるところまでは Vec3 を1つも作らない。
  const sx = bStart.r.x - aStart.r.x;
  const sy = bStart.r.y - aStart.r.y;
  const sz = bStart.r.z - aStart.r.z;
  const ex = bEnd.r.x - aEnd.r.x;
  const ey = bEnd.r.y - aEnd.r.y;
  const ez = bEnd.r.z - aEnd.r.z;
  // Hermite の接線は u 微分へ変換するため dt を掛ける。
  const t0x = (bStart.v.x - aStart.v.x) * dt;
  const t0y = (bStart.v.y - aStart.v.y) * dt;
  const t0z = (bStart.v.z - aStart.v.z) * dt;
  const t1x = (bEnd.v.x - aEnd.v.x) * dt;
  const t1y = (bEnd.v.y - aEnd.v.y) * dt;
  const t1z = (bEnd.v.z - aEnd.v.z) * dt;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz)
    || !Number.isFinite(ex) || !Number.isFinite(ey) || !Number.isFinite(ez)
    || !Number.isFinite(t0x) || !Number.isFinite(t0y) || !Number.isFinite(t0z)
    || !Number.isFinite(t1x) || !Number.isFinite(t1y) || !Number.isFinite(t1z)) return null;

  const radiusSq = radiusSum * radiusSum;
  const startsInside = sx * sx + sy * sy + sz * sz <= radiusSq;
  // 区間が無ければ曲線が定まらないが、始点の内外は答えられる。
  if (!(dt > 0)) return { startsInside, crossing: null };

  // 中間制御点。二次は1つしか持たないので、箱の min/max を変えないよう同じ点を2度数える。
  const quadratic = degree === 2;
  const c1x = quadratic ? (sx + ex) / 2 + (t0x - t1x) / 4 : sx + t0x / 3;
  const c1y = quadratic ? (sy + ey) / 2 + (t0y - t1y) / 4 : sy + t0y / 3;
  const c1z = quadratic ? (sz + ez) / 2 + (t0z - t1z) / 4 : sz + t0z / 3;
  const c2x = quadratic ? c1x : ex - t1x / 3;
  const c2y = quadratic ? c1y : ey - t1y / 3;
  const c2z = quadratic ? c1z : ez - t1z / 3;
  const wholeBoxOnStartSide = startsInside
    ? axisMaxDistanceSq(sx, c1x, c2x, ex)
      + axisMaxDistanceSq(sy, c1y, c2y, ey)
      + axisMaxDistanceSq(sz, c1z, c2z, ez) < radiusSq
    : axisDistanceSq(sx, c1x, c2x, ex)
      + axisDistanceSq(sy, c1y, c2y, ey)
      + axisDistanceSq(sz, c1z, c2z, ez) > radiusSq;
  if (wholeBoxOnStartSide) return { startsInside, crossing: null };

  const controls: readonly Vec3[] = quadratic
    ? [v3(sx, sy, sz), v3(c1x, c1y, c1z), v3(ex, ey, ez)]
    : [v3(sx, sy, sz), v3(c1x, c1y, c1z), v3(c2x, c2y, c2z), v3(ex, ey, ez)];

  // 始点と同じ側で正、反対側で負になる符号付きクリアランス。跨ぎはこの符号の反転として探す。
  const sign = startsInside ? -1 : 1;
  const clearanceAt = (p: Vec3): number => (len(p) - radiusSum) * sign;
  const MAX_DEPTH = 32;
  const MIN_INTERVAL = 1e-7;
  const ROOT_ITERATIONS = 24;

  const refine = (lo: number, hi: number): number => {
    // lo は始点と同じ側、hi は表面上(または反対側)という不変条件。
    for (let i = 0; i < ROOT_ITERATIONS; i++) {
      const mid = (lo + hi) / 2;
      if (clearanceAt(bezierPoint(controls, mid)) > 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };

  const search = (segment: readonly Vec3[], u0: number, u1: number, depth: number): number | null => {
    const boxOnStartSide = startsInside
      ? maxDistanceSqToControlBox(segment) < radiusSq
      : distanceSqToControlBox(segment) > radiusSq;
    if (boxOnStartSide) return null;
    if (clearanceAt(segment[0]!) <= 0) return u0;
    if (clearanceAt(segment[segment.length - 1]!) <= 0) return refine(u0, u1);
    if (depth >= MAX_DEPTH || u1 - u0 <= MIN_INTERVAL) return null;

    const [left, right] = splitBezier(segment);
    return search(left, u0, (u0 + u1) / 2, depth + 1)
      ?? search(right, (u0 + u1) / 2, u1, depth + 1);
  };

  const toi = search(controls, 0, 1, 0);
  return {
    startsInside,
    crossing: toi === null ? null : crossingAt(toi, bezierPoint(controls, toi)),
  };
}

// 跨いだ時刻とそのときの相対位置から SurfaceCrossing を組む。跨ぎの瞬間の相対距離は
// 半径和(正)に一致するので、向きは常に定まる。
function crossingAt(toi: number, relative: Vec3): SurfaceCrossing {
  const d = len(relative);
  return { toi, normal: v3(relative.x / d, relative.y / d, relative.z / d) };
}

// 次数は制御点の数で決まる。
function bezierPoint(control: readonly Vec3[], u: number): Vec3 {
  const v = 1 - u;
  if (control.length === 3) {
    const w0 = v * v;
    const w1 = 2 * v * u;
    const w2 = u * u;
    return v3(
      control[0]!.x * w0 + control[1]!.x * w1 + control[2]!.x * w2,
      control[0]!.y * w0 + control[1]!.y * w1 + control[2]!.y * w2,
      control[0]!.z * w0 + control[1]!.z * w1 + control[2]!.z * w2,
    );
  }
  const w0 = v * v * v;
  const w1 = 3 * v * v * u;
  const w2 = 3 * v * u * u;
  const w3 = u * u * u;
  return v3(
    control[0]!.x * w0 + control[1]!.x * w1 + control[2]!.x * w2 + control[3]!.x * w3,
    control[0]!.y * w0 + control[1]!.y * w1 + control[2]!.y * w2 + control[3]!.y * w3,
    control[0]!.z * w0 + control[1]!.z * w1 + control[2]!.z * w2 + control[3]!.z * w3,
  );
}

// 曲線を u = ½ で2本へ分ける。次数は制御点の数で決まる。
function splitBezier(control: readonly Vec3[]): readonly [readonly Vec3[], readonly Vec3[]] {
  const p0 = control[0]!;
  const p1 = control[1]!;
  const p01 = scale(add(p0, p1), 0.5);
  if (control.length === 3) {
    const p2 = control[2]!;
    const p12 = scale(add(p1, p2), 0.5);
    const p012 = scale(add(p01, p12), 0.5);
    return [[p0, p01, p012], [p012, p12, p2]];
  }
  const p2 = control[2]!;
  const p3 = control[3]!;
  const p12 = scale(add(p1, p2), 0.5);
  const p23 = scale(add(p2, p3), 0.5);
  const p012 = scale(add(p01, p12), 0.5);
  const p123 = scale(add(p12, p23), 0.5);
  const p0123 = scale(add(p012, p123), 0.5);
  return [[p0, p01, p012, p0123], [p0123, p123, p23, p3]];
}

// 制御点4つが1軸上に張る区間と原点の距離の2乗。区間が原点を跨ぐなら 0。
function axisDistanceSq(a: number, b: number, c: number, d: number): number {
  const min = Math.min(Math.min(a, b), Math.min(c, d));
  const max = Math.max(Math.max(a, b), Math.max(c, d));
  const distance = min > 0 ? min : max < 0 ? -max : 0;
  return distance * distance;
}

// 制御点4つが1軸上に張る区間のうち、原点から最も遠い点までの距離の2乗。
function axisMaxDistanceSq(a: number, b: number, c: number, d: number): number {
  const distance = Math.max(
    Math.max(Math.abs(a), Math.abs(b)), Math.max(Math.abs(c), Math.abs(d)));
  return distance * distance;
}

// Bezier の凸包を囲う軸平行箱と原点の最短距離の2乗。制御点が3つなら末尾を2度数える。
function distanceSqToControlBox(control: readonly Vec3[]): number {
  const last = control[control.length - 1]!;
  return axisDistanceSq(control[0]!.x, control[1]!.x, control[2]!.x, last.x)
    + axisDistanceSq(control[0]!.y, control[1]!.y, control[2]!.y, last.y)
    + axisDistanceSq(control[0]!.z, control[1]!.z, control[2]!.z, last.z);
}

// Bezier の凸包を囲う軸平行箱と原点の最長距離の2乗。制御点が3つなら末尾を2度数える。
function maxDistanceSqToControlBox(control: readonly Vec3[]): number {
  const last = control[control.length - 1]!;
  return axisMaxDistanceSq(control[0]!.x, control[1]!.x, control[2]!.x, last.x)
    + axisMaxDistanceSq(control[0]!.y, control[1]!.y, control[2]!.y, last.y)
    + axisMaxDistanceSq(control[0]!.z, control[1]!.z, control[2]!.z, last.z);
}


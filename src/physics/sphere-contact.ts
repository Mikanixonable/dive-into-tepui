// 球どうしの接触の幾何(掃引接触の時刻・法線、点が球の内側にあるかの判定)。
// 重力源かどうか・天体かどうかには関与しない純粋な幾何。
import { KinematicState } from './kinematic-state';
import { Vec3, add, len, scale, sub, v3 } from './vec3';

export interface SphereContact {
  readonly toi: number; // frame区間内の衝突割合 0..1
  readonly normal: Vec3; // aからbへ向く接触法線
}

// 掃引経路の近似。'linear' は端点を結ぶ線分、'cubic' は端点の速度を接線に取る三次曲線。
export type SweptMode = 'linear' | 'cubic';

// 半径和 radiusSum の2球が、それぞれ start→end の区間を渡る間に最初に表面が触れる時刻(区間内の
// 割合)と、その瞬間の a→b 向きの法線。触れなければ null。開始時点で既に重なっている場合も
// null を返す — 掃引では扱えないので、呼び出し側の離散 solver へ委譲する。
// 区間は両球で共通で、その長さは aStart→aEnd の時刻差から取る。
export function sweptSphereContact(
  aStart: KinematicState,
  aEnd: KinematicState,
  bStart: KinematicState,
  bEnd: KinematicState,
  radiusSum: number,
  mode: SweptMode,
): SphereContact | null {
  return mode === 'linear'
    ? linearSphereContact(aStart, aEnd, bStart, bEnd, radiusSum)
    : cubicSphereContact(aStart, aEnd, bStart, bEnd, radiusSum);
}

// 線形モードの実体。2球の中心がそれぞれ start→end を線形移動するとみなし、速度は読まない。
function linearSphereContact(
  aStart: KinematicState,
  aEnd: KinematicState,
  bStart: KinematicState,
  bEnd: KinematicState,
  radiusSum: number,
): SphereContact | null {
  // 相対位置 p(t) = p0 + d·t (t∈[0,1]) が半径和 radiusSum の球に触れる最小の t を解く2次方程式。
  // 各早期returnは `!(x > 0)` 系の否定形で書く — NaN はどの比較でも false になるので、
  // 非有限な入力はこの形のときだけ自動的に null へ落ちる(`x <= 0` に書き換えると通り抜ける)。
  const px = bStart.r.x - aStart.r.x;
  const py = bStart.r.y - aStart.r.y;
  const pz = bStart.r.z - aStart.r.z;
  const dx = (bEnd.r.x - bStart.r.x) - (aEnd.r.x - aStart.r.x);
  const dy = (bEnd.r.y - bStart.r.y) - (aEnd.r.y - aStart.r.y);
  const dz = (bEnd.r.z - bStart.r.z) - (aEnd.r.z - aStart.r.z);
  const c = px * px + py * py + pz * pz - radiusSum * radiusSum;
  if (!(c > 0)) return null;
  const aa = dx * dx + dy * dy + dz * dz;
  if (!(aa > 1e-18)) return null;
  const bb = 2 * (px * dx + py * dy + pz * dz);
  const discriminant = bb * bb - 4 * aa * c;
  if (!(discriminant >= 0)) return null;
  const toi = (-bb - Math.sqrt(discriminant)) / (2 * aa);
  if (!(toi >= 0 && toi <= 1)) return null;
  // 接触時刻における相対位置がそのまま接触法線の向きになる。
  return normalized(toi, v3(px + dx * toi, py + dy * toi, pz + dz * toi));
}

// 三次モードの実体。
// 区間端点の符号だけを見ると、端点の両方が表面外でも途中だけ球を通過する軌道を落とす。
// ここでは相対位置(b − a)を3次Bezierへ変換し、Bezier制御点の凸包が球と交わり得る区間だけを
// 左から再帰的に調べる。制御点の軸平行箱が球から離れていれば、その区間には交差がない。
// したがって、単なる固定サンプル列より細い通過も拾いつつ、曲線上の clearance の符号反転を
// 固定反復で詰められる。
function cubicSphereContact(
  aStart: KinematicState,
  aEnd: KinematicState,
  bStart: KinematicState,
  bEnd: KinematicState,
  radiusSum: number,
): SphereContact | null {
  const dt = aEnd.t - aStart.t;
  if (!(dt > 0) || !Number.isFinite(dt) || !Number.isFinite(radiusSum) || !(radiusSum > 0)) return null;
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
  const c1x = sx + t0x / 3;
  const c1y = sy + t0y / 3;
  const c1z = sz + t0z / 3;
  const c2x = ex - t1x / 3;
  const c2y = ey - t1y / 3;
  const c2z = ez - t1z / 3;

  // 全区間の凸包が球から離れていれば交差はない。
  const boxDistanceSq = axisDistanceSq(sx, c1x, c2x, ex)
    + axisDistanceSq(sy, c1y, c2y, ey)
    + axisDistanceSq(sz, c1z, c2z, ez);
  if (boxDistanceSq > radiusSum * radiusSum) return null;
  // 開始時点の重なりは線形モードと同じく、呼び出し側の離散 solver に委譲する。
  if (Math.sqrt(sx * sx + sy * sy + sz * sz) <= radiusSum) return null;

  const controls: readonly Vec3[] = [
    v3(sx, sy, sz), v3(c1x, c1y, c1z), v3(c2x, c2y, c2z), v3(ex, ey, ez),
  ];

  const clearanceAt = (u: number): number => len(cubicPoint(controls, u)) - radiusSum;
  const MAX_DEPTH = 32;
  const MIN_INTERVAL = 1e-7;
  const ROOT_ITERATIONS = 24;

  const refine = (lo: number, hi: number): number => {
    // lo は表面外、hi は表面上(または内部)という不変条件。
    for (let i = 0; i < ROOT_ITERATIONS; i++) {
      const mid = (lo + hi) / 2;
      if (clearanceAt(mid) > 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };

  const search = (segment: readonly Vec3[], u0: number, u1: number, depth: number): number | null => {
    if (distanceSqToControlBox(segment) > radiusSum * radiusSum) return null;
    if (len(segment[0]!) - radiusSum <= 0) return u0;
    if (len(segment[3]!) - radiusSum <= 0) return refine(u0, u1);
    if (depth >= MAX_DEPTH || u1 - u0 <= MIN_INTERVAL) return null;

    const [left, right] = splitCubic(segment);
    return search(left, u0, (u0 + u1) / 2, depth + 1)
      ?? search(right, (u0 + u1) / 2, u1, depth + 1);
  };

  const toi = search(controls, 0, 1, 0);
  return toi === null ? null : normalized(toi, cubicPoint(controls, toi));
}

// 接触時刻とそのときの相対位置から SphereContact を組む。相対位置が潰れていれば向きを
// 決められないので null(線形・三次で同じ扱いにする)。
function normalized(toi: number, relative: Vec3): SphereContact | null {
  const d = len(relative);
  if (!(d > 1e-12)) return null;
  return { toi, normal: v3(relative.x / d, relative.y / d, relative.z / d) };
}

function cubicPoint(control: readonly Vec3[], u: number): Vec3 {
  const v = 1 - u;
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

function splitCubic(control: readonly Vec3[]): readonly [readonly Vec3[], readonly Vec3[]] {
  const p0 = control[0]!;
  const p1 = control[1]!;
  const p2 = control[2]!;
  const p3 = control[3]!;
  const p01 = scale(add(p0, p1), 0.5);
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

// Bezier の凸包を囲う軸平行箱と原点の最短距離の2乗。
function distanceSqToControlBox(control: readonly Vec3[]): number {
  return axisDistanceSq(control[0]!.x, control[1]!.x, control[2]!.x, control[3]!.x)
    + axisDistanceSq(control[0]!.y, control[1]!.y, control[2]!.y, control[3]!.y)
    + axisDistanceSq(control[0]!.z, control[1]!.z, control[2]!.z, control[3]!.z);
}

// point が bodies のいずれかの球の内側にあれば、その球を返す。無ければ null。
export function containingBody<T extends { readonly radius: number; readonly state: KinematicState }>(
  point: Vec3,
  bodies: readonly T[],
): T | null {
  for (const body of bodies) {
    if (len(sub(point, body.state.r)) < body.radius) return body;
  }
  return null;
}

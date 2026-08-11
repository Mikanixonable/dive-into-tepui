// 球どうしの接触の幾何(掃引接触の時刻・法線、点が球の内側にあるかの判定)。
// 重力源かどうか・天体かどうかには関与しない純粋な幾何。
import { KinematicState } from './kinematic-state';
import { Vec3, add, len, scale, sub, v3 } from './vec3';

export interface SphereContact {
  readonly toi: number; // frame区間内の衝突割合 0..1
  readonly normal: Vec3; // aからbへ向く接触法線
}

// 2球の中心がそれぞれ start→end を線形移動するとみなし、最初に表面が触れる時刻を返す。
// 開始時点で既にoverlapしている場合は離散overlap solverへ委譲するため null。
export function sweptSphereToi(
  aStart: Vec3,
  aEnd: Vec3,
  bStart: Vec3,
  bEnd: Vec3,
  radiusSum: number,
): SphereContact | null {
  // 相対位置 p(t) = p0 + d·t (t∈[0,1]) が半径和 radiusSum の球に触れる最小の t を解く2次方程式。
  // 各早期returnは `!(x > 0)` 系の否定形で書く — NaN はどの比較でも false になるので、
  // 非有限な入力はこの形のときだけ自動的に null へ落ちる(`x <= 0` に書き換えると通り抜ける)。
  const px = bStart.x - aStart.x;
  const py = bStart.y - aStart.y;
  const pz = bStart.z - aStart.z;
  const dx = (bEnd.x - bStart.x) - (aEnd.x - aStart.x);
  const dy = (bEnd.y - bStart.y) - (aEnd.y - aStart.y);
  const dz = (bEnd.z - bStart.z) - (aEnd.z - aStart.z);
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
  const nx0 = px + dx * toi;
  const ny0 = py + dy * toi;
  const nz0 = pz + dz * toi;
  const nLen = Math.sqrt(nx0 * nx0 + ny0 * ny0 + nz0 * nz0);
  if (!(nLen > 1e-12)) return null;
  return { toi, normal: v3(nx0 / nLen, ny0 / nLen, nz0 / nLen) };
}

// prev→next の Hermite 軌道と、start→end の線形移動球が最初に接触する割合を返す。
// 区間端点の符号だけを見ると、端点の両方が表面外でも途中だけ球を通過する軌道を落とす。
// ここでは相対位置を3次Bezierへ変換し、Bezier制御点の凸包が球と交わり得る区間だけを
// 左から再帰的に調べる。制御点の軸平行箱が球から離れていれば、その区間には交差がない。
// したがって、単なる固定サンプル列より細い通過も拾いつつ、曲線上の clearance の符号反転を
// 固定反復で詰められる。
export function sweptHermiteSphereToi(
  prev: KinematicState,
  next: KinematicState,
  bodyStart: Vec3,
  bodyEnd: Vec3,
  radius: number,
): number | null {
  const dt = next.t - prev.t;
  if (!(dt > 0) || !Number.isFinite(dt) || !Number.isFinite(radius) || !(radius > 0)) return null;
  const bodyVelocity = scale(sub(bodyEnd, bodyStart), 1 / dt);
  const relativeStart = sub(prev.r, bodyStart);
  const relativeEnd = sub(next.r, bodyEnd);
  if (![relativeStart.x, relativeStart.y, relativeStart.z, relativeEnd.x, relativeEnd.y, relativeEnd.z,
    bodyVelocity.x, bodyVelocity.y, bodyVelocity.z].every(Number.isFinite)) return null;

  // Hermite の接線は u 微分へ変換するため dt を掛ける。相対位置のBezier制御点。
  const tangent0 = scale(sub(prev.v, bodyVelocity), dt);
  const tangent1 = scale(sub(next.v, bodyVelocity), dt);
  const controls: readonly Vec3[] = [
    relativeStart,
    add(relativeStart, scale(tangent0, 1 / 3)),
    add(relativeEnd, scale(tangent1, -1 / 3)),
    relativeEnd,
  ];

  // 開始時点の重なりは sweptSphereToi と同じく、呼び出し側の離散 solver に委譲する。
  if (len(relativeStart) <= radius) return null;

  const clearanceAt = (u: number): number => len(cubicPoint(controls, u)) - radius;
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
    if (distanceSqToControlBox(segment) > radius * radius) return null;
    const c0 = len(segment[0]!) - radius;
    if (c0 <= 0) return u0;
    const c1 = len(segment[3]!) - radius;
    if (c1 <= 0) return refine(u0, u1);
    if (depth >= MAX_DEPTH || u1 - u0 <= MIN_INTERVAL) return null;

    const [left, right] = splitCubic(segment);
    return search(left, u0, (u0 + u1) / 2, depth + 1)
      ?? search(right, (u0 + u1) / 2, u1, depth + 1);
  };

  return search(controls, 0, 1, 0);
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

// Bezier の凸包を囲う軸平行箱と原点の最短距離。箱の外にある軸だけ距離を加える。
function distanceSqToControlBox(control: readonly Vec3[]): number {
  let distanceSq = 0;
  for (const axis of ['x', 'y', 'z'] as const) {
    let min = Infinity;
    let max = -Infinity;
    for (const p of control) {
      min = Math.min(min, p[axis]);
      max = Math.max(max, p[axis]);
    }
    const distance = min > 0 ? min : max < 0 ? -max : 0;
    distanceSq += distance * distance;
  }
  return distanceSq;
}

// point が bodies のいずれかの半径 + margin の球の内側にあれば、その球を返す。無ければ null。
export function containingBody<T extends { readonly radius: number; readonly state: KinematicState }>(
  point: Vec3,
  bodies: readonly T[],
  margin: number,
): T | null {
  for (const body of bodies) {
    if (len(sub(point, body.state.r)) < body.radius + margin) return body;
  }
  return null;
}

// カプセル（中心線分を半径ぶん膨らませた形状）の接触幾何。
// 形状の中心・軸・寸法は呼び出し側がワールド座標へ変換して渡す。
import { add, addScaled, cross, dot, lenSq, norm, scale, sub, v3, type Vec3 } from '../math/vec3';

export interface Capsule {
  readonly center: Vec3;
  readonly axis: Vec3;
  readonly halfLength: number;
  readonly radius: number;
}

export interface CapsuleHit {
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly depth: number;
}

interface SegmentPair {
  readonly a: Vec3;
  readonly b: Vec3;
}

const EPSILON = 1e-12;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function capsuleEnds(capsule: Capsule): SegmentPair {
  return {
    a: addScaled(capsule.center, capsule.axis, -capsule.halfLength),
    b: addScaled(capsule.center, capsule.axis, capsule.halfLength),
  };
}

function closestPointOnSegment(point: Vec3, segment: SegmentPair): Vec3 {
  const direction = sub(segment.b, segment.a);
  const lengthSq = lenSq(direction);
  const t = lengthSq > EPSILON ? clamp(dot(sub(point, segment.a), direction) / lengthSq, 0, 1) : 0;
  return addScaled(segment.a, direction, t);
}

// 2本の軸線分の最近接点対を求める。
function closestPointsBetweenSegments(a: SegmentPair, b: SegmentPair): SegmentPair {
  const d1 = sub(a.b, a.a);
  const d2 = sub(b.b, b.a);
  const between = sub(a.a, b.a);
  const aa = dot(d1, d1);
  const ee = dot(d2, d2);
  const ff = dot(d2, between);
  let s = 0;
  let t: number;

  if (aa <= EPSILON && ee <= EPSILON) return { a: a.a, b: b.a };
  if (aa <= EPSILON) {
    t = clamp(ff / ee, 0, 1);
    return { a: a.a, b: addScaled(b.a, d2, t) };
  }

  const cc = dot(d1, between);
  if (ee <= EPSILON) {
    s = clamp(-cc / aa, 0, 1);
    return { a: addScaled(a.a, d1, s), b: b.a };
  }

  const bb = dot(d1, d2);
  const denominator = aa * ee - bb * bb;
  if (denominator > EPSILON) s = clamp((bb * ff - cc * ee) / denominator, 0, 1);
  t = (bb * s + ff) / ee;
  if (t < 0) {
    t = 0;
    s = clamp(-cc / aa, 0, 1);
  } else if (t > 1) {
    t = 1;
    s = clamp((bb - cc) / aa, 0, 1);
  }
  return { a: addScaled(a.a, d1, s), b: addScaled(b.a, d2, t) };
}

function fallbackNormal(a: Vec3, b: Vec3, axis: Vec3): Vec3 {
  const between = norm(sub(b, a));
  if (lenSq(between) > EPSILON) return between;
  const reference = Math.abs(axis.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  const perpendicular = norm(cross(axis, reference));
  return lenSq(perpendicular) > EPSILON ? perpendicular : v3(1, 0, 0);
}

function capsuleBasis(axis: Vec3): { readonly x: Vec3; readonly y: Vec3; readonly z: Vec3 } {
  const y = norm(axis);
  const reference = Math.abs(y.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  const x = norm(cross(reference, y));
  return { x, y, z: cross(y, x) };
}

function toLocal(point: Vec3, capsule: Capsule): Vec3 {
  const basis = capsuleBasis(capsule.axis);
  const relative = sub(point, capsule.center);
  return v3(dot(relative, basis.x), dot(relative, basis.y), dot(relative, basis.z));
}

// カプセルと球の接触。法線はカプセルから球へ向く。
export function capsuleSphereContact(
  capsule: Capsule, sphereCenter: Vec3, sphereRadius: number,
): CapsuleHit | null {
  const nearestOnAxis = closestPointOnSegment(sphereCenter, capsuleEnds(capsule));
  const diff = sub(sphereCenter, nearestOnAxis);
  const distSq = lenSq(diff);
  const radiusSum = capsule.radius + sphereRadius;

  if (distSq > radiusSum * radiusSum + EPSILON) return null;

  const dist = Math.sqrt(distSq);
  const normal = dist > EPSILON ? scale(diff, 1 / dist) : fallbackNormal(capsule.center, sphereCenter, capsule.axis);
  return {
    point: addScaled(nearestOnAxis, normal, capsule.radius),
    normal,
    depth: Math.max(0, radiusSum - dist),
  };
}

// 2本のカプセルどうしの接触。法線は a から b へ向く。
export function capsuleCapsuleContact(a: Capsule, b: Capsule): CapsuleHit | null {
  const nearest = closestPointsBetweenSegments(capsuleEnds(a), capsuleEnds(b));
  const diff = sub(nearest.b, nearest.a);
  const distSq = lenSq(diff);
  const radiusSum = a.radius + b.radius;

  if (distSq > radiusSum * radiusSum + EPSILON) return null;

  const dist = Math.sqrt(distSq);
  const normal = dist > EPSILON ? scale(diff, 1 / dist) : fallbackNormal(a.center, b.center, a.axis);
  return {
    point: addScaled(nearest.a, normal, a.radius),
    normal,
    depth: Math.max(0, radiusSum - dist),
  };
}

function translatedCapsule(capsule: Capsule, displacement: Vec3): Capsule {
  return { ...capsule, center: add(capsule.center, displacement) };
}

// 2本のカプセルが並進移動する区間で初めて触れる時刻と接触幾何。
// 線分間距離の幾何学的性質（相対移動に沿った単峰性・凸性）を活用し、
// 初期時刻・重心最近接時刻・終端時刻の評価と二分探索で高速に解く。
export function sweptCapsuleCapsuleContact(
  a: Capsule, b: Capsule, previousACenter: Vec3, previousBCenter: Vec3,
): { readonly hit: CapsuleHit; readonly toi: number } | null {
  const aDisplacement = sub(a.center, previousACenter);
  const bDisplacement = sub(b.center, previousBCenter);

  const at = (toi: number): { readonly a: Capsule; readonly b: Capsule } => ({
    a: translatedCapsule(a, scale(aDisplacement, toi - 1)),
    b: translatedCapsule(b, scale(bDisplacement, toi - 1)),
  });

  // t=0 での接触評価
  const initial = capsuleCapsuleContact(at(0).a, at(0).b);
  if (initial !== null) return { hit: initial, toi: 0 };

  // 区間内での相対変位と、重心間最近接時刻 t_closest
  const r0 = sub(previousBCenter, previousACenter);
  const r1 = sub(b.center, a.center);
  const v = sub(r1, r0);
  const vSq = lenSq(v);
  const tClosest = vSq > EPSILON ? clamp(-dot(r0, v) / vSq, 0, 1) : 0.5;

  // 評価サンプル点（tClosest, 0.5, 1.0）
  const sampleTimes = [tClosest];
  if (Math.abs(tClosest - 0.5) > 0.15) {
    sampleTimes.push(0.5);
  }
  if (Math.abs(tClosest - 1.0) > 0.05) {
    sampleTimes.push(1.0);
  }
  sampleTimes.sort((x, y) => x - y);

  let firstContactTime: number | null = null;
  let firstContactHit: CapsuleHit | null = null;

  for (const t of sampleTimes) {
    const sample = at(t);
    const hit = capsuleCapsuleContact(sample.a, sample.b);
    if (hit !== null) {
      firstContactTime = t;
      firstContactHit = hit;
      break;
    }
  }

  // サンプル点で接触が検出されなければ、区間内での交差なし
  if (firstContactTime === null || firstContactHit === null) {
    return null;
  }

  // 接触が判明した区間 [0, firstContactTime] を二分探索で絞り込む（8反復で約 0.4% の時間分解能）
  let low = 0;
  let high = firstContactTime;
  let bestHit = firstContactHit;

  for (let i = 0; i < 8; i++) {
    const mid = (low + high) * 0.5;
    const midState = at(mid);
    const hit = capsuleCapsuleContact(midState.a, midState.b);
    if (hit === null) {
      low = mid;
    } else {
      high = mid;
      bestHit = hit;
    }
  }

  return { hit: bestHit, toi: high };
}

function firstSphereRoot(start: Vec3, direction: Vec3, center: Vec3, radius: number): number | null {
  const relative = sub(start, center);
  const aa = dot(direction, direction);
  if (!(aa > EPSILON)) return null;
  const bb = 2 * dot(relative, direction);
  const cc = dot(relative, relative) - radius * radius;
  const discriminant = bb * bb - 4 * aa * cc;
  if (!(discriminant >= 0)) return null;
  const root = Math.sqrt(discriminant);
  const t = (-bb - root) / (2 * aa);
  return t >= 0 && t <= 1 ? t : null;
}

function firstCylinderSideRoot(start: Vec3, direction: Vec3, radius: number, halfLength: number): number | null {
  const aa = direction.x * direction.x + direction.z * direction.z;
  if (!(aa > EPSILON)) return null;
  const bb = 2 * (start.x * direction.x + start.z * direction.z);
  const cc = start.x * start.x + start.z * start.z - radius * radius;
  const discriminant = bb * bb - 4 * aa * cc;
  if (!(discriminant >= 0)) return null;
  const root = Math.sqrt(discriminant);
  for (const t of [(-bb - root) / (2 * aa), (-bb + root) / (2 * aa)]) {
    if (t < 0 || t > 1) continue;
    const y = start.y + direction.y * t;
    if (y >= -halfLength && y <= halfLength) return t;
  }
  return null;
}

// 球の中心が区間内を移動してカプセルへ入る最初の接触。
export function sweptSphereCapsuleContact(
  capsule: Capsule,
  previousSphereCenter: Vec3,
  sphereCenter: Vec3,
  sphereRadius: number,
): { readonly hit: CapsuleHit; readonly toi: number } | null {
  const initial = capsuleSphereContact(capsule, previousSphereCenter, sphereRadius);
  if (initial !== null) return { hit: initial, toi: 0 };

  const start = toLocal(previousSphereCenter, capsule);
  const end = toLocal(sphereCenter, capsule);
  const direction = sub(end, start);
  const expandedRadius = capsule.radius + sphereRadius;

  let toi: number | null = firstCylinderSideRoot(start, direction, expandedRadius, capsule.halfLength);
  for (const capY of [-capsule.halfLength, capsule.halfLength]) {
    const capToi = firstSphereRoot(start, direction, v3(0, capY, 0), expandedRadius);
    if (capToi !== null && (toi === null || capToi < toi)) toi = capToi;
  }
  if (toi === null) return null;

  const contactCenter = addScaled(previousSphereCenter, sub(sphereCenter, previousSphereCenter), toi);
  const hit = capsuleSphereContact(capsule, contactCenter, sphereRadius);
  return hit === null ? null : { hit, toi };
}

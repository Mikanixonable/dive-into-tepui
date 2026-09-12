// 有限円柱の接触幾何。軸線を半径ぶん膨らませた形で、円柱の端を丸めた接触を返す。
// 形状の中心・軸・寸法は呼び出し側がワールド座標へ変換して渡す。
import { add, addScaled, cross, dot, lenSq, norm, scale, sub, v3, type Vec3 } from '../math/vec3';

export interface Cylinder {
  readonly center: Vec3;
  readonly axis: Vec3;
  readonly halfLength: number;
  readonly radius: number;
}

export interface CylinderHit {
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

function cylinderEnds(cylinder: Cylinder): SegmentPair {
  return {
    a: addScaled(cylinder.center, cylinder.axis, -cylinder.halfLength),
    b: addScaled(cylinder.center, cylinder.axis, cylinder.halfLength),
  };
}

function closestPointOnSegment(point: Vec3, segment: SegmentPair): Vec3 {
  const direction = sub(segment.b, segment.a);
  const lengthSq = lenSq(direction);
  const t = lengthSq > EPSILON ? clamp(dot(sub(point, segment.a), direction) / lengthSq, 0, 1) : 0;
  return addScaled(segment.a, direction, t);
}

// 2本の軸線分の最近接点。円柱の端を含む接触を一定時間の幾何として解く。
function closestPointsBetweenSegments(a: SegmentPair, b: SegmentPair): SegmentPair {
  const d1 = sub(a.b, a.a);
  const d2 = sub(b.b, b.a);
  const between = sub(a.a, b.a);
  const aa = dot(d1, d1);
  const ee = dot(d2, d2);
  const ff = dot(d2, between);
  let s = 0;
  let t = 0;

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

function cylinderBasis(axis: Vec3): { readonly x: Vec3; readonly y: Vec3; readonly z: Vec3 } {
  const y = norm(axis);
  const reference = Math.abs(y.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  const x = norm(cross(reference, y));
  return { x, y, z: cross(y, x) };
}

function toLocal(point: Vec3, cylinder: Cylinder): Vec3 {
  const basis = cylinderBasis(cylinder.axis);
  const relative = sub(point, cylinder.center);
  return v3(dot(relative, basis.x), dot(relative, basis.y), dot(relative, basis.z));
}

function toWorld(point: Vec3, cylinder: Cylinder): Vec3 {
  const basis = cylinderBasis(cylinder.axis);
  return add(
    cylinder.center,
    add(add(scale(basis.x, point.x), scale(basis.y, point.y)), scale(basis.z, point.z)),
  );
}

function localDirectionToWorld(direction: Vec3, cylinder: Cylinder): Vec3 {
  const basis = cylinderBasis(cylinder.axis);
  return norm(
    add(add(scale(basis.x, direction.x), scale(basis.y, direction.y)), scale(basis.z, direction.z)),
  );
}

// 球の中心から有限円柱の表面までの接触。法線は円柱から球へ向く。
export function cylinderSphereContact(
  cylinder: Cylinder, sphereCenter: Vec3, sphereRadius: number,
): CylinderHit | null {
  const local = toLocal(sphereCenter, cylinder);
  const radialLength = Math.hypot(local.x, local.z);
  const inside = radialLength <= cylinder.radius && Math.abs(local.y) <= cylinder.halfLength;
  let surface: Vec3;
  let localNormal: Vec3;

  if (inside) {
    const sideDistance = cylinder.radius - radialLength;
    const capDistance = cylinder.halfLength - Math.abs(local.y);
    if (sideDistance <= capDistance) {
      const radialNormal = radialLength > EPSILON
        ? v3(local.x / radialLength, 0, local.z / radialLength)
        : v3(1, 0, 0);
      surface = v3(radialNormal.x * cylinder.radius, local.y, radialNormal.z * cylinder.radius);
      localNormal = radialNormal;
      return {
        point: toWorld(surface, cylinder),
        normal: localDirectionToWorld(localNormal, cylinder),
        depth: sphereRadius + sideDistance,
      };
    }
    const sign = local.y >= 0 ? 1 : -1;
    surface = v3(local.x, sign * cylinder.halfLength, local.z);
    localNormal = v3(0, sign, 0);
    return {
      point: toWorld(surface, cylinder),
      normal: localDirectionToWorld(localNormal, cylinder),
      depth: sphereRadius + capDistance,
    };
  }

  const axial = clamp(local.y, -cylinder.halfLength, cylinder.halfLength);
  const radialScale = radialLength > cylinder.radius && radialLength > EPSILON
    ? cylinder.radius / radialLength
    : 1;
  surface = v3(local.x * radialScale, axial, local.z * radialScale);
  const worldSurface = toWorld(surface, cylinder);
  const difference = sub(sphereCenter, worldSurface);
  const distance = Math.sqrt(lenSq(difference));
  if (!(distance <= sphereRadius + EPSILON)) return null;
  const normal = distance > EPSILON
    ? scale(difference, 1 / distance)
    : localDirectionToWorld(v3(0, local.y >= 0 ? 1 : -1, 0), cylinder);
  return { point: worldSurface, normal, depth: Math.max(0, sphereRadius - distance) };
}

// 2本の軸線分を半径ぶん膨らませた円柱どうしの接触。法線は a から b へ向く。
export function cylinderCylinderContact(a: Cylinder, b: Cylinder): CylinderHit | null {
  const nearest = closestPointsBetweenSegments(cylinderEnds(a), cylinderEnds(b));
  const difference = sub(nearest.b, nearest.a);
  const distanceSq = lenSq(difference);
  const radiusSum = a.radius + b.radius;
  if (!(distanceSq < radiusSum * radiusSum)) return null;
  const distance = Math.sqrt(distanceSq);
  const normal = fallbackNormal(a.center, b.center, a.axis);
  const contactNormal = distance > EPSILON ? scale(difference, 1 / distance) : normal;
  return {
    point: add(nearest.a, scale(contactNormal, a.radius)),
    normal: contactNormal,
    depth: radiusSum - distance,
  };
}

function translatedCylinder(cylinder: Cylinder, displacement: Vec3): Cylinder {
  return { ...cylinder, center: add(cylinder.center, displacement) };
}

// 2本の円柱が並進区間で初めて触れる時刻を、区間を形状半径で刻んで求める。
// 軸の回転は終端姿勢で固定し、接触時刻付近だけ二分する。
export function sweptCylinderCylinderContact(
  a: Cylinder, b: Cylinder, previousACenter: Vec3, previousBCenter: Vec3,
): { readonly hit: CylinderHit; readonly toi: number } | null {
  const aDisplacement = sub(a.center, previousACenter);
  const bDisplacement = sub(b.center, previousBCenter);
  const relativeDistance = Math.sqrt(lenSq(sub(bDisplacement, aDisplacement)));
  const sampleRadius = Math.max(EPSILON, Math.min(a.radius, b.radius));
  const sampleCount = Math.max(1, Math.min(16, Math.ceil(relativeDistance / sampleRadius)));
  const at = (toi: number): { readonly a: Cylinder; readonly b: Cylinder } => ({
    a: translatedCylinder(a, scale(aDisplacement, toi - 1)),
    b: translatedCylinder(b, scale(bDisplacement, toi - 1)),
  });

  const initial = cylinderCylinderContact(at(0).a, at(0).b);
  if (initial !== null) return { hit: initial, toi: 0 };

  let before = 0;
  for (let i = 1; i <= sampleCount; i++) {
    const after = i / sampleCount;
    const sample = at(after);
    const hit = cylinderCylinderContact(sample.a, sample.b);
    if (hit === null) {
      before = after;
      continue;
    }
    let low = before;
    let high = after;
    let highHit = hit;
    for (let j = 0; j < 6; j++) {
      const middle = (low + high) / 2;
      const candidate = at(middle);
      const middleHit = cylinderCylinderContact(candidate.a, candidate.b);
      if (middleHit === null) low = middle;
      else {
        high = middle;
        highHit = middleHit;
      }
    }
    return { hit: highHit, toi: high };
  }
  return null;
}

function pointInsideCapsule(point: Vec3, cylinder: Cylinder, radius: number): boolean {
  const nearest = closestPointOnSegment(point, cylinderEnds(cylinder));
  return lenSq(sub(point, nearest)) <= radius * radius;
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

// 球の中心が区間内を移動して円柱へ入る最初の接触。円柱の姿勢は区間終端のものを使う。
export function sweptSphereCylinderContact(
  cylinder: Cylinder,
  previousSphereCenter: Vec3,
  sphereCenter: Vec3,
  sphereRadius: number,
): { readonly hit: CylinderHit; readonly toi: number } | null {
  const initial = cylinderSphereContact(cylinder, previousSphereCenter, sphereRadius);
  if (initial !== null) return { hit: initial, toi: 0 };

  const start = toLocal(previousSphereCenter, cylinder);
  const end = toLocal(sphereCenter, cylinder);
  const direction = sub(end, start);
  const expandedRadius = cylinder.radius + sphereRadius;
  if (pointInsideCapsule(start, {
    center: v3(), axis: v3(0, 1, 0), halfLength: cylinder.halfLength, radius: cylinder.radius,
  }, expandedRadius)) {
    const hit = cylinderSphereContact(cylinder, previousSphereCenter, sphereRadius);
    return hit === null ? null : { hit, toi: 0 };
  }

  let toi: number | null = firstCylinderSideRoot(
    start, direction, expandedRadius, cylinder.halfLength);
  for (const capY of [-cylinder.halfLength, cylinder.halfLength]) {
    const capToi = firstSphereRoot(start, direction, v3(0, capY, 0), expandedRadius);
    if (capToi !== null && (toi === null || capToi < toi)) toi = capToi;
  }
  if (toi === null) return null;

  const contactCenter = addScaled(previousSphereCenter, sub(sphereCenter, previousSphereCenter), toi);
  const hit = cylinderSphereContact(cylinder, contactCenter, sphereRadius);
  return hit === null ? null : { hit, toi };
}

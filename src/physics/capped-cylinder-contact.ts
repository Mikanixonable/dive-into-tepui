// 平坦な端面を持つ有限円柱の接触幾何。軸は入力時に正規化し、円柱の外側だけを接触面とする。
import { add, addScaled, cross, dot, len, lenSq, norm, scale, sub, v3, type Vec3 } from '../math/vec3';

export interface CappedCylinder {
  readonly center: Vec3;
  readonly axis: Vec3;
  readonly halfLength: number;
  readonly radius: number;
}

export interface CappedCylinderHit {
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly depth: number;
}

export interface CappedCylinderRayHit {
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly distance: number;
}

interface PreparedCylinder {
  readonly center: Vec3;
  readonly axis: Vec3;
  readonly halfLength: number;
  readonly radius: number;
}

interface SupportPoint {
  readonly p: Vec3;
  readonly a: Vec3;
  readonly b: Vec3;
}

interface EpaFace {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly normal: Vec3;
  readonly distance: number;
}

const EPSILON = 1e-10;
const MAX_GJK_ITERATIONS = 48;
const MAX_EPA_ITERATIONS = 64;

function elementAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Missing geometry element at ${index}`);
  return value;
}

function finiteVec(value: Vec3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function prepare(cylinder: CappedCylinder): PreparedCylinder | null {
  if (!finiteVec(cylinder.center) || !finiteVec(cylinder.axis)
    || !Number.isFinite(cylinder.halfLength) || !Number.isFinite(cylinder.radius)
    || cylinder.halfLength < 0 || cylinder.radius < 0) return null;
  const axisLength = len(cylinder.axis);
  if (!(axisLength > EPSILON) || !Number.isFinite(axisLength)) return null;
  return {
    center: cylinder.center,
    axis: scale(cylinder.axis, 1 / axisLength),
    halfLength: cylinder.halfLength,
    radius: cylinder.radius,
  };
}

function finiteHit(hit: CappedCylinderHit | CappedCylinderRayHit): boolean {
  const magnitude = 'depth' in hit ? hit.depth : hit.distance;
  return finiteVec(hit.point) && finiteVec(hit.normal) && Number.isFinite(magnitude);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function fallbackPerpendicular(axis: Vec3): Vec3 {
  const reference = Math.abs(axis.x) < 0.8 ? v3(1, 0, 0) : v3(0, 1, 0);
  const result = norm(cross(axis, reference));
  return lenSq(result) > EPSILON ? result : v3(0, 0, 1);
}

function closestPointOnCylinder(point: Vec3, cylinder: PreparedCylinder): {
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly inside: boolean;
  readonly distanceToSurface: number;
} {
  const relative = sub(point, cylinder.center);
  const axial = dot(relative, cylinder.axis);
  const axialClamped = clamp(axial, -cylinder.halfLength, cylinder.halfLength);
  const radial = sub(relative, scale(cylinder.axis, axial));
  const radialLength = len(radial);
  const inside = Math.abs(axial) <= cylinder.halfLength && radialLength <= cylinder.radius;

  if (inside) {
    const sideDistance = cylinder.radius - radialLength;
    const capDistance = cylinder.halfLength - Math.abs(axial);
    if (sideDistance <= capDistance) {
      const normal = radialLength > EPSILON ? scale(radial, 1 / radialLength) : fallbackPerpendicular(cylinder.axis);
      return {
        point: addScaled(add(cylinder.center, scale(cylinder.axis, axial)), normal, cylinder.radius),
        normal,
        inside: true,
        distanceToSurface: sideDistance,
      };
    }
    const sign = axial >= 0 ? 1 : -1;
    const normal = scale(cylinder.axis, sign);
    return {
      point: addScaled(add(cylinder.center, scale(cylinder.axis, sign * cylinder.halfLength)), radial, 1),
      normal,
      inside: true,
      distanceToSurface: capDistance,
    };
  }

  const radialNormal = radialLength > EPSILON ? scale(radial, 1 / radialLength) : fallbackPerpendicular(cylinder.axis);
  const radialPoint = radialLength > cylinder.radius
    ? scale(radialNormal, cylinder.radius)
    : radial;
  const surface = add(
    add(cylinder.center, scale(cylinder.axis, axialClamped)),
    radialPoint,
  );
  const difference = sub(point, surface);
  const distance = len(difference);
  const normal = distance > EPSILON ? scale(difference, 1 / distance) : radialNormal;
  return { point: surface, normal, inside: false, distanceToSurface: distance };
}

// 円柱から球の中心へ向く法線を返す。球が内部から始まる場合も、最短の外面を返す。
export function cappedCylinderSphereContact(
  cylinderInput: CappedCylinder, sphereCenter: Vec3, sphereRadius: number,
): CappedCylinderHit | null {
  const cylinder = prepare(cylinderInput);
  if (cylinder === null || !finiteVec(sphereCenter) || !Number.isFinite(sphereRadius) || sphereRadius < 0) return null;
  const closest = closestPointOnCylinder(sphereCenter, cylinder);
  const depth = closest.inside
    ? sphereRadius + closest.distanceToSurface
    : sphereRadius - closest.distanceToSurface;
  if (!(depth >= -EPSILON)) return null;
  const hit: CappedCylinderHit = {
    point: closest.point,
    normal: closest.normal,
    depth: Math.max(0, depth),
  };
  return finiteHit(hit) ? hit : null;
}

function support(cylinder: PreparedCylinder, direction: Vec3): Vec3 {
  const axial = dot(direction, cylinder.axis);
  const axialPoint = add(cylinder.center, scale(cylinder.axis, axial >= 0 ? cylinder.halfLength : -cylinder.halfLength));
  const radial = sub(direction, scale(cylinder.axis, axial));
  const radialLength = len(radial);
  return radialLength > EPSILON
    ? addScaled(axialPoint, radial, cylinder.radius / radialLength)
    : axialPoint;
}

function minkowskiSupport(a: PreparedCylinder, b: PreparedCylinder, direction: Vec3): SupportPoint {
  const pa = support(a, direction);
  const pb = support(b, scale(direction, -1));
  return { p: sub(pa, pb), a: pa, b: pb };
}

function tripleCross(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return cross(cross(a, b), c);
}

// simplex は最後に追加した点を先頭に置く。true は原点が simplex 内にあることを表す。
function updateSimplex(simplex: SupportPoint[], direction: { value: Vec3 }): boolean {
  const a = elementAt(simplex, 0).p;
  const ao = scale(a, -1);
  if (simplex.length === 2) {
    const b = elementAt(simplex, 1).p;
    const ab = sub(b, a);
    if (dot(ab, ao) > 0) {
      const next = tripleCross(ab, ao, ab);
      direction.value = lenSq(next) > EPSILON ? next : fallbackPerpendicular(ab);
    } else {
      simplex.splice(1, 1);
      direction.value = ao;
    }
    return false;
  }

  if (simplex.length === 3) {
    const b = elementAt(simplex, 1).p;
    const c = elementAt(simplex, 2).p;
    const ab = sub(b, a);
    const ac = sub(c, a);
    const abc = cross(ab, ac);
    const abPerp = cross(ab, abc);
    if (dot(abPerp, ao) > 0) {
      simplex.splice(2, 1);
      direction.value = tripleCross(ab, ao, ab);
      return false;
    }
    const acPerp = cross(abc, ac);
    if (dot(acPerp, ao) > 0) {
      simplex.splice(1, 1);
      direction.value = tripleCross(ac, ao, ac);
      return false;
    }
    direction.value = dot(abc, ao) > 0 ? abc : scale(abc, -1);
    if (dot(abc, ao) < 0) {
      const swap = elementAt(simplex, 1);
      simplex[1] = elementAt(simplex, 2);
      simplex[2] = swap;
    }
    return false;
  }

  const b = elementAt(simplex, 1).p;
  const c = elementAt(simplex, 2).p;
  const d = elementAt(simplex, 3).p;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ad = sub(d, a);
  const abc = cross(ab, ac);
  const acd = cross(ac, ad);
  const adb = cross(ad, ab);
  const abcOut = dot(abc, ad) < 0 ? abc : scale(abc, -1);
  const acdOut = dot(acd, ab) < 0 ? acd : scale(acd, -1);
  const adbOut = dot(adb, ac) < 0 ? adb : scale(adb, -1);
  if (dot(abcOut, ao) > 0) {
    simplex.splice(3, 1);
    direction.value = abcOut;
    return false;
  }
  if (dot(acdOut, ao) > 0) {
    simplex.splice(1, 1);
    direction.value = acdOut;
    return false;
  }
  if (dot(adbOut, ao) > 0) {
    simplex.splice(2, 1);
    direction.value = adbOut;
    return false;
  }
  return true;
}

function gjk(a: PreparedCylinder, b: PreparedCylinder): SupportPoint[] | null {
  let direction = sub(b.center, a.center);
  if (lenSq(direction) <= EPSILON) direction = fallbackPerpendicular(a.axis);
  const simplex: SupportPoint[] = [minkowskiSupport(a, b, direction)];
  direction = scale(elementAt(simplex, 0).p, -1);
  if (lenSq(direction) <= EPSILON) return simplex;
  for (let i = 0; i < MAX_GJK_ITERATIONS; i++) {
    const point = minkowskiSupport(a, b, direction);
    if (dot(point.p, direction) < 0) return null;
    simplex.unshift(point);
    const next = { value: direction };
    if (updateSimplex(simplex, next)) return simplex;
    direction = next.value;
    if (lenSq(direction) <= EPSILON) return simplex;
  }
  return null;
}

function makeFace(vertices: SupportPoint[], ia: number, ib: number, ic: number): EpaFace | null {
  const vertexA = elementAt(vertices, ia);
  const edgeA = sub(elementAt(vertices, ib).p, vertexA.p);
  const edgeB = sub(elementAt(vertices, ic).p, vertexA.p);
  let normal = norm(cross(edgeA, edgeB));
  if (lenSq(normal) <= EPSILON) return null;
  let distance = dot(normal, vertexA.p);
  if (distance < 0) {
    normal = scale(normal, -1);
    distance = -distance;
    return { a: ia, b: ic, c: ib, normal, distance };
  }
  return { a: ia, b: ib, c: ic, normal, distance };
}

function makeOutwardFace(
  vertices: SupportPoint[], ia: number, ib: number, ic: number, opposite: number,
): EpaFace | null {
  const vertexA = elementAt(vertices, ia);
  const edgeA = sub(elementAt(vertices, ib).p, vertexA.p);
  const edgeB = sub(elementAt(vertices, ic).p, vertexA.p);
  let normal = norm(cross(edgeA, edgeB));
  if (lenSq(normal) <= EPSILON) return null;
  if (dot(normal, sub(elementAt(vertices, opposite).p, vertexA.p)) > 0) normal = scale(normal, -1);
  const distance = dot(normal, vertexA.p);
  return distance > EPSILON ? { a: ia, b: ib, c: ic, normal, distance } : null;
}

function barycentric(point: Vec3, a: Vec3, b: Vec3, c: Vec3): [number, number, number] {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(point, a);
  const d00 = dot(ab, ab);
  const d01 = dot(ab, ac);
  const d11 = dot(ac, ac);
  const d20 = dot(ap, ab);
  const d21 = dot(ap, ac);
  const denominator = d00 * d11 - d01 * d01;
  if (Math.abs(denominator) <= EPSILON) return [1 / 3, 1 / 3, 1 / 3];
  const v = (d11 * d20 - d01 * d21) / denominator;
  const w = (d00 * d21 - d01 * d20) / denominator;
  return [1 - v - w, v, w];
}

function contactFromFace(vertices: SupportPoint[], face: EpaFace): CappedCylinderHit | null {
  const projected = scale(face.normal, face.distance);
  const va = elementAt(vertices, face.a);
  const vb = elementAt(vertices, face.b);
  const vc = elementAt(vertices, face.c);
  const weights = barycentric(projected, va.p, vb.p, vc.p);
  const pointA = add(add(scale(va.a, weights[0]), scale(vb.a, weights[1])), scale(vc.a, weights[2]));
  const pointB = add(add(scale(va.b, weights[0]), scale(vb.b, weights[1])), scale(vc.b, weights[2]));
  const hit: CappedCylinderHit = {
    point: scale(add(pointA, pointB), 0.5),
    normal: face.normal,
    depth: Math.max(0, face.distance),
  };
  return finiteHit(hit) ? hit : null;
}

function epa(a: PreparedCylinder, b: PreparedCylinder, initial: SupportPoint[]): CappedCylinderHit | null {
  const vertices = [...initial];
  const crossAxis = cross(a.axis, b.axis);
  const directions = [
    a.axis, scale(a.axis, -1), b.axis, scale(b.axis, -1),
    crossAxis, scale(crossAxis, -1), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1),
    v3(1, 1, 1), v3(-1, 1, 1), v3(1, -1, 1), v3(1, 1, -1),
  ];
  for (const direction of directions) {
    if (lenSq(direction) <= EPSILON) continue;
    const candidate = minkowskiSupport(a, b, direction);
    if (vertices.every((vertex) => lenSq(sub(vertex.p, candidate.p)) > EPSILON)) vertices.push(candidate);
  }
  if (vertices.length < 4) return null;
  let seed: [number, number, number, number] | null = null;
  let seedClearance = -Infinity;
  for (let ia = 0; ia < vertices.length - 3; ia++) {
    for (let ib = ia + 1; ib < vertices.length - 2; ib++) {
      for (let ic = ib + 1; ic < vertices.length - 1; ic++) {
        for (let id = ic + 1; id < vertices.length; id++) {
          const candidateFaces = [
            makeOutwardFace(vertices, ia, ib, ic, id), makeOutwardFace(vertices, ia, id, ib, ic),
            makeOutwardFace(vertices, ia, ic, id, ib), makeOutwardFace(vertices, ib, id, ic, ia),
          ];
          const validFaces = candidateFaces.filter((face): face is EpaFace => face !== null);
          if (validFaces.length !== candidateFaces.length) continue;
          const clearance = Math.min(...validFaces.map((face) => face.distance));
          if (clearance > seedClearance) {
            seedClearance = clearance;
            seed = [ia, ib, ic, id];
          }
        }
      }
    }
  }
  if (seed === null || !(seedClearance > EPSILON)) return null;
  let faces: EpaFace[] = [];
  for (const [ia, ib, ic, opposite] of [
    [seed[0], seed[1], seed[2], seed[3]], [seed[0], seed[3], seed[1], seed[2]],
    [seed[0], seed[2], seed[3], seed[1]], [seed[1], seed[3], seed[2], seed[0]],
  ] as const) {
    const face = makeOutwardFace(vertices, ia, ib, ic, opposite);
    if (face) faces.push(face);
  }
  for (let iteration = 0; iteration < MAX_EPA_ITERATIONS; iteration++) {
    faces.sort((left, right) => left.distance - right.distance);
    const closest = faces[0];
    if (!closest) return null;
    const supportPoint = minkowskiSupport(a, b, closest.normal);
    const advance = dot(supportPoint.p, closest.normal) - closest.distance;
    if (advance <= 1e-8) {
      return contactFromFace(vertices, closest);
    }

    if (vertices.some((vertex) => lenSq(sub(vertex.p, supportPoint.p)) <= EPSILON)) {
      return contactFromFace(vertices, closest);
    }

    const newIndex = vertices.length;
    vertices.push(supportPoint);
    const visible = faces.filter((face) => (
      dot(face.normal, sub(supportPoint.p, elementAt(vertices, face.a).p)) > EPSILON
    ));
    if (visible.length === 0) return contactFromFace(vertices, closest);
    const boundary: [number, number][] = [];
    const addEdge = (from: number, to: number): void => {
      const reverse = boundary.findIndex(([a0, b0]) => a0 === to && b0 === from);
      if (reverse >= 0) boundary.splice(reverse, 1);
      else boundary.push([from, to]);
    };
    for (const face of visible) {
      addEdge(face.a, face.b);
      addEdge(face.b, face.c);
      addEdge(face.c, face.a);
    }
    faces = faces.filter((face) => !visible.includes(face));
    for (const [from, to] of boundary) {
      const face = makeFace(vertices, from, to, newIndex);
      if (face) faces.push(face);
    }
    if (faces.length > 256) return contactFromFace(vertices, closest);
  }
  return null;
}

function parallelCylinderContact(a: PreparedCylinder, b: PreparedCylinder): CappedCylinderHit | null {
  const delta = sub(b.center, a.center);
  const axialDelta = dot(delta, a.axis);
  const axialDistance = Math.abs(axialDelta);
  const axialDepth = a.halfLength + b.halfLength - axialDistance;
  const radialDelta = sub(delta, scale(a.axis, axialDelta));
  const radialDistance = len(radialDelta);
  const radialDepth = a.radius + b.radius - radialDistance;
  if (axialDepth < -EPSILON || radialDepth < -EPSILON) return null;
  if (radialDepth <= axialDepth) {
    const normal = radialDistance > EPSILON ? scale(radialDelta, 1 / radialDistance) : fallbackPerpendicular(a.axis);
    const axial = clamp(axialDelta, -a.halfLength, a.halfLength);
    const pointA = add(add(a.center, scale(a.axis, axial)), scale(normal, a.radius));
    const pointB = add(add(b.center, scale(a.axis, -axialDelta + axial)), scale(normal, -b.radius));
    return { point: scale(add(pointA, pointB), 0.5), normal, depth: Math.max(0, radialDepth) };
  }
  const sign = axialDelta >= 0 ? 1 : -1;
  const normal = scale(a.axis, sign);
  const pointA = add(a.center, scale(a.axis, sign * a.halfLength));
  const pointB = add(b.center, scale(a.axis, -sign * b.halfLength));
  return { point: scale(add(pointA, pointB), 0.5), normal, depth: Math.max(0, axialDepth) };
}

// 円柱から b へ向く法線を返す。平行軸では端面・側面の最小貫入を解析的に求める。
export function cappedCylinderCylinderContact(
  aInput: CappedCylinder, bInput: CappedCylinder,
): CappedCylinderHit | null {
  const a = prepare(aInput);
  const b = prepare(bInput);
  if (a === null || b === null) return null;
  const axisCross = cross(a.axis, b.axis);
  // 角度が 1e-4 rad 未満では、平行軸の解析解へ連続的に寄せる。GJK の simplex が
  // ほぼ共面になる領域で、接触の有無を数値誤差で反転させないためである。
  const result = lenSq(axisCross) <= 1e-8
    ? parallelCylinderContact(a, b)
    : (() => {
      const simplex = gjk(a, b);
      return simplex === null ? null : epa(a, b, simplex);
    })();
  return result !== null && finiteHit(result) ? result : null;
}

function rayCandidate(
  origin: Vec3, direction: Vec3, t: number, normal: Vec3,
): CappedCylinderRayHit | null {
  if (!(t >= -EPSILON) || !finiteVec(normal)) return null;
  const distance = Math.max(0, t);
  const hit = { point: addScaled(origin, direction, distance), normal: norm(normal), distance };
  return finiteHit(hit) ? hit : null;
}

// ray の direction は正規化して解釈する。内部開始なら最初の退出面を返す。
export function cappedCylinderRaycast(
  cylinderInput: CappedCylinder, origin: Vec3, directionInput: Vec3,
): CappedCylinderRayHit | null {
  const cylinder = prepare(cylinderInput);
  if (cylinder === null || !finiteVec(origin) || !finiteVec(directionInput)) return null;
  const directionLength = len(directionInput);
  if (!(directionLength > EPSILON) || !Number.isFinite(directionLength)) return null;
  const direction = scale(directionInput, 1 / directionLength);
  const relative = sub(origin, cylinder.center);
  const axialOrigin = dot(relative, cylinder.axis);
  const axialDirection = dot(direction, cylinder.axis);
  const radialOrigin = sub(relative, scale(cylinder.axis, axialOrigin));
  const radialDirection = sub(direction, scale(cylinder.axis, axialDirection));
  const candidates: CappedCylinderRayHit[] = [];
  const quadraticA = dot(radialDirection, radialDirection);
  const quadraticB = 2 * dot(radialOrigin, radialDirection);
  const quadraticC = dot(radialOrigin, radialOrigin) - cylinder.radius * cylinder.radius;
  if (quadraticA > EPSILON) {
    const discriminant = quadraticB * quadraticB - 4 * quadraticA * quadraticC;
    if (discriminant >= -EPSILON) {
      const root = Math.sqrt(Math.max(0, discriminant));
      for (const t of [(-quadraticB - root) / (2 * quadraticA), (-quadraticB + root) / (2 * quadraticA)]) {
        const axial = axialOrigin + axialDirection * t;
        if (axial >= -cylinder.halfLength - EPSILON && axial <= cylinder.halfLength + EPSILON) {
          const radialPoint = add(radialOrigin, scale(radialDirection, t));
          const candidate = rayCandidate(origin, direction, t, radialPoint);
          if (candidate) candidates.push(candidate);
        }
      }
    }
  }
  if (Math.abs(axialDirection) > EPSILON) {
    for (const sign of [-1, 1]) {
      const t = (sign * cylinder.halfLength - axialOrigin) / axialDirection;
      const radialPoint = add(radialOrigin, scale(radialDirection, t));
      if (lenSq(radialPoint) <= cylinder.radius * cylinder.radius + EPSILON) {
        const candidate = rayCandidate(origin, direction, t, scale(cylinder.axis, sign));
        if (candidate) candidates.push(candidate);
      }
    }
  }
  candidates.sort((left, right) => left.distance - right.distance);
  return candidates[0] ?? null;
}

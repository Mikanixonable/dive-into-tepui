// moduleId を持つ capped-cylinder 集合の接触幾何。局所 primitive を1箇所で
// pose へ変換し、個別の capped-cylinder 判定へ委譲する。ゲーム状態は知らない。
import {
  cappedCylinderCylinderContact, cappedCylinderRaycast, cappedCylinderSphereContact,
  type CappedCylinder,
} from './capped-cylinder-contact';
import { add, addScaled, dot, len, lenSq, sub, v3, type Vec3 } from '../math/vec3';
import { qNormalize, qRotate, qSlerp, type Quat } from '../math/quat';

export interface CompoundCylinderPrimitive extends CappedCylinder {
  readonly moduleId: string;
}

export interface CompoundCylinderShape {
  readonly primitives: readonly CompoundCylinderPrimitive[];
}

export interface RigidPose {
  readonly position: Vec3;
  readonly rotation: Quat;
}

export interface CompoundCylinderContact {
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly depth: number;
  readonly moduleIdA: string;
  readonly moduleIdB: string | null;
}

export interface CompoundCylinderRayHit {
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly distance: number;
  readonly moduleId: string;
}

export interface SweptCompoundCylinderContact extends CompoundCylinderContact {
  readonly toi: number;
}

const EPSILON = 1e-10;
const MAX_SWEEP_SUBDIVISIONS = 1_000_000;
const FEATURE_STEP_FRACTION = 0.25;
const BINARY_SEARCH_ITERATIONS = 40;

const IDENTITY_POSE: RigidPose = { position: v3(), rotation: { x: 0, y: 0, z: 0, w: 1 } };

const sortedPrimitiveCache = new WeakMap<CompoundCylinderShape, readonly CompoundCylinderPrimitive[] | null>();
const shapeMetricsCache = new WeakMap<CompoundCylinderShape, { readonly bound: number; readonly minFeature: number } | null>();

function finiteVec(value: Vec3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function finiteQuat(value: Quat): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y)
    && Number.isFinite(value.z) && Number.isFinite(value.w);
}

function preparePose(pose: RigidPose): RigidPose | null {
  if (!finiteVec(pose.position) || !finiteQuat(pose.rotation)) return null;
  const norm = Math.hypot(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w);
  if (!(norm > EPSILON) || !Number.isFinite(norm)) return null;
  return { position: pose.position, rotation: qNormalize(pose.rotation) };
}

function sortedPrimitives(shape: CompoundCylinderShape): readonly CompoundCylinderPrimitive[] | null {
  const cached = sortedPrimitiveCache.get(shape);
  if (cached !== undefined) return cached;
  if (shape.primitives.length === 0) return null;
  // 1 module が突起を含む複数 primitive を持てるよう、moduleId の重複は許す。
  // module 内も幾何値で並べ、入力配列の順序を narrow phase の tie break にしない。
  const result = [...shape.primitives].sort((a, b) => {
    if (a.moduleId !== b.moduleId) return a.moduleId < b.moduleId ? -1 : 1;
    const av = [a.center.x, a.center.y, a.center.z, a.axis.x, a.axis.y, a.axis.z, a.halfLength, a.radius];
    const bv = [b.center.x, b.center.y, b.center.z, b.axis.x, b.axis.y, b.axis.z, b.halfLength, b.radius];
    for (let i = 0; i < av.length; i++) {
      const left = av[i];
      const right = bv[i];
      if (left === undefined || right === undefined) return 0;
      if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
  });
  for (const primitive of result) {
    if (primitive.moduleId.length === 0) return null;
    if (!finiteVec(primitive.center) || !finiteVec(primitive.axis)
      || !Number.isFinite(primitive.halfLength) || !(primitive.halfLength > 0)
      || !Number.isFinite(primitive.radius) || !(primitive.radius > 0)) return null;
    const axisLength = len(primitive.axis);
    if (!(axisLength > EPSILON) || !Number.isFinite(axisLength)) return null;
  }
  const prepared = Object.freeze(result.map((primitive) => Object.freeze({
    moduleId: primitive.moduleId,
    center: Object.freeze(v3(primitive.center.x, primitive.center.y, primitive.center.z)),
    axis: Object.freeze(v3(
      primitive.axis.x, primitive.axis.y, primitive.axis.z,
    )),
    halfLength: primitive.halfLength,
    radius: primitive.radius,
  })));
  sortedPrimitiveCache.set(shape, prepared);
  return prepared;
}

// 局所 primitive をワールド相当座標へ変換する唯一の入口。
function worldPrimitive(primitive: CompoundCylinderPrimitive, pose: RigidPose): CappedCylinder {
  return {
    center: add(pose.position, qRotate(pose.rotation, primitive.center)),
    axis: qRotate(pose.rotation, primitive.axis),
    halfLength: primitive.halfLength,
    radius: primitive.radius,
  };
}

function worldPrimitives(shape: CompoundCylinderShape, pose: RigidPose): readonly {
  readonly moduleId: string; readonly cylinder: CappedCylinder;
}[] | null {
  const primitives = sortedPrimitives(shape);
  const preparedPose = preparePose(pose);
  if (primitives === null || preparedPose === null) return null;
  return primitives.map((primitive) => ({ moduleId: primitive.moduleId, cylinder: worldPrimitive(primitive, preparedPose) }));
}

function hitForSphere(
  primitive: { readonly moduleId: string; readonly cylinder: CappedCylinder },
  center: Vec3, radius: number,
): CompoundCylinderContact | null {
  const hit = cappedCylinderSphereContact(primitive.cylinder, center, radius);
  return hit === null ? null : { ...hit, moduleIdA: primitive.moduleId, moduleIdB: null };
}

function hitForCylinder(
  a: { readonly moduleId: string; readonly cylinder: CappedCylinder },
  b: { readonly moduleId: string | null; readonly cylinder: CappedCylinder },
): CompoundCylinderContact | null {
  const hit = cappedCylinderCylinderContact(a.cylinder, b.cylinder);
  return hit === null ? null : { ...hit, moduleIdA: a.moduleId, moduleIdB: b.moduleId };
}

function deeper(
  current: CompoundCylinderContact | null, candidate: CompoundCylinderContact | null,
): CompoundCylinderContact | null {
  if (candidate === null) return current;
  if (current === null || candidate.depth > current.depth) return candidate;
  if (candidate.depth < current.depth) return current;
  if (candidate.moduleIdA !== current.moduleIdA) {
    return candidate.moduleIdA < current.moduleIdA ? candidate : current;
  }
  const candidateB = candidate.moduleIdB ?? '';
  const currentB = current.moduleIdB ?? '';
  return candidateB < currentB ? candidate : current;
}

function finiteSphere(center: Vec3, radius: number): boolean {
  return finiteVec(center) && Number.isFinite(radius) && radius >= 0;
}

/** compound shape と球の接触を、最深の primitive として返す。 */
export function compoundCylinderSphereContact(
  shape: CompoundCylinderShape, pose: RigidPose, sphereCenter: Vec3, sphereRadius: number,
): CompoundCylinderContact | null {
  if (!finiteSphere(sphereCenter, sphereRadius)) return null;
  const primitives = worldPrimitives(shape, pose);
  if (primitives === null) return null;
  let result: CompoundCylinderContact | null = null;
  for (const primitive of primitives) result = deeper(result, hitForSphere(primitive, sphereCenter, sphereRadius));
  return result;
}

/** compound shape と単一 capped-cylinder の接触を、最深の primitive として返す。 */
export function compoundCylinderCylinderContact(
  shape: CompoundCylinderShape, pose: RigidPose, target: CappedCylinder,
  targetPose: RigidPose = IDENTITY_POSE, targetModuleId: string | null = null,
): CompoundCylinderContact | null {
  if (!finiteVec(target.center) || !finiteVec(target.axis)
    || !Number.isFinite(target.halfLength) || !(target.halfLength > 0)
    || !Number.isFinite(target.radius) || !(target.radius > 0)) return null;
  const primitives = worldPrimitives(shape, pose);
  const targetWorld = preparePose(targetPose);
  if (primitives === null || targetWorld === null) return null;
  const targetPrimitive = { moduleId: targetModuleId, cylinder: worldPrimitive({ ...target, moduleId: '' }, targetWorld) };
  let result: CompoundCylinderContact | null = null;
  for (const primitive of primitives) result = deeper(result, hitForCylinder(primitive, targetPrimitive));
  return result;
}

/** 2つの compound shape の全 primitive 組を調べ、最深の接触を返す。 */
export function compoundCylinderCompoundContact(
  shapeA: CompoundCylinderShape, poseA: RigidPose,
  shapeB: CompoundCylinderShape, poseB: RigidPose,
): CompoundCylinderContact | null {
  const a = worldPrimitives(shapeA, poseA);
  const b = worldPrimitives(shapeB, poseB);
  if (a === null || b === null) return null;
  let result: CompoundCylinderContact | null = null;
  for (const primitiveA of a) {
    for (const primitiveB of b) result = deeper(result, hitForCylinder(primitiveA, primitiveB));
  }
  return result;
}

/** compound shape に対する ray の最近傍 hit。同距離なら moduleId の辞書順で決める。 */
export function compoundCylinderRaycast(
  shape: CompoundCylinderShape, pose: RigidPose, origin: Vec3, direction: Vec3,
): CompoundCylinderRayHit | null {
  if (!finiteVec(origin) || !finiteVec(direction)) return null;
  const primitives = worldPrimitives(shape, pose);
  if (primitives === null) return null;
  let result: CompoundCylinderRayHit | null = null;
  for (const primitive of primitives) {
    const hit = cappedCylinderRaycast(primitive.cylinder, origin, direction);
    if (hit === null) continue;
    const candidate = { ...hit, moduleId: primitive.moduleId };
    if (result === null || candidate.distance < result.distance
      || (candidate.distance === result.distance && candidate.moduleId < result.moduleId)) result = candidate;
  }
  return result;
}

interface MotionMetrics {
  readonly distance: number;
  readonly angle: number;
  readonly bound: number;
  readonly minFeature: number;
}

function shapeMetrics(shape: CompoundCylinderShape): { readonly bound: number; readonly minFeature: number } | null {
  const cached = shapeMetricsCache.get(shape);
  if (cached !== undefined) return cached;
  const primitives = sortedPrimitives(shape);
  if (primitives === null) return null;
  let bound = 0;
  let minFeature = Infinity;
  for (const primitive of primitives) {
    bound = Math.max(bound, len(primitive.center) + Math.hypot(primitive.halfLength, primitive.radius));
    minFeature = Math.min(minFeature, primitive.halfLength, primitive.radius);
  }
  const result = Number.isFinite(bound) && Number.isFinite(minFeature) && minFeature > 0
    ? { bound, minFeature }
    : null;
  shapeMetricsCache.set(shape, result);
  return result;
}

function motionMetrics(start: RigidPose, end: RigidPose, shape: CompoundCylinderShape): MotionMetrics | null {
  const a = preparePose(start);
  const b = preparePose(end);
  const shapeData = shapeMetrics(shape);
  if (a === null || b === null || shapeData === null) return null;
  const cosine = Math.max(-1, Math.min(1,
    Math.abs(a.rotation.x * b.rotation.x + a.rotation.y * b.rotation.y
      + a.rotation.z * b.rotation.z + a.rotation.w * b.rotation.w)));
  return {
    distance: len(sub(b.position, a.position)),
    angle: 2 * Math.acos(cosine),
    bound: shapeData.bound,
    minFeature: shapeData.minFeature,
  };
}

function primitiveMotionMetrics(
  start: RigidPose, end: RigidPose, primitive: CompoundCylinderPrimitive,
): MotionMetrics | null {
  const a = preparePose(start);
  const b = preparePose(end);
  if (a === null || b === null) return null;
  const cosine = Math.max(-1, Math.min(1,
    Math.abs(a.rotation.x * b.rotation.x + a.rotation.y * b.rotation.y
      + a.rotation.z * b.rotation.z + a.rotation.w * b.rotation.w)));
  return {
    distance: len(sub(b.position, a.position)),
    angle: 2 * Math.acos(cosine),
    bound: len(primitive.center) + Math.hypot(primitive.halfLength, primitive.radius),
    minFeature: Math.min(primitive.halfLength, primitive.radius),
  };
}

function subdivisions(metrics: readonly MotionMetrics[]): number | null {
  let movement = 0;
  let minFeature = Infinity;
  for (const metric of metrics) {
    movement += metric.distance + metric.angle * metric.bound;
    minFeature = Math.min(minFeature, metric.minFeature);
  }
  const required = Math.max(1, Math.ceil(movement / (minFeature * FEATURE_STEP_FRACTION)));
  return required <= MAX_SWEEP_SUBDIVISIONS ? required : null;
}

function poseAt(start: RigidPose, end: RigidPose, t: number): RigidPose {
  return {
    position: v3(
      start.position.x + (end.position.x - start.position.x) * t,
      start.position.y + (end.position.y - start.position.y) * t,
      start.position.z + (end.position.z - start.position.z) * t,
    ),
    rotation: qSlerp(start.rotation, end.rotation, t),
  };
}

function firstSweepHit(
  subdivisionsCount: number,
  at: (t: number) => CompoundCylinderContact | null,
): SweptCompoundCylinderContact | null {
  let previousT = 0;
  const previous = at(0);
  if (previous !== null) return { ...previous, toi: 0 };
  for (let i = 1; i <= subdivisionsCount; i++) {
    const currentT = i / subdivisionsCount;
    const current = at(currentT);
    if (current === null) {
      previousT = currentT;
      continue;
    }
    let lo = previousT;
    let hi = currentT;
    for (let iteration = 0; iteration < BINARY_SEARCH_ITERATIONS; iteration++) {
      const mid = (lo + hi) / 2;
      if (at(mid) === null) lo = mid;
      else hi = mid;
    }
    const hit = at(hi);
    return hit === null ? { ...current, toi: currentT } : { ...hit, toi: hi };
  }
  return null;
}

function sphereAt(start: Vec3, end: Vec3, t: number): Vec3 {
  return v3(
    start.x + (end.x - start.x) * t,
    start.y + (end.y - start.y) * t,
    start.z + (end.z - start.z) * t,
  );
}

function earlierSweepHit(
  current: SweptCompoundCylinderContact | null,
  candidate: SweptCompoundCylinderContact | null,
): SweptCompoundCylinderContact | null {
  if (candidate === null) return current;
  if (current === null || candidate.toi < current.toi) return candidate;
  if (candidate.toi > current.toi) return current;
  if (candidate.moduleIdA !== current.moduleIdA) {
    return candidate.moduleIdA < current.moduleIdA ? candidate : current;
  }
  const candidateB = candidate.moduleIdB ?? '';
  const currentB = current.moduleIdB ?? '';
  return candidateB < currentB ? candidate : current;
}

const MAX_SPHERE_SWEEP_SUBDIVISIONS = 32;

function sweptPrimitiveSphereContact(
  primitive: CompoundCylinderPrimitive, start: RigidPose, end: RigidPose,
  sphereStart: Vec3, sphereEnd: Vec3, sphereRadius: number,
): SweptCompoundCylinderContact | null {
  const startPose = preparePose(start);
  const endPose = preparePose(end);
  if (startPose === null || endPose === null) return null;

  // primitive の外接球による高速早期棄却。球の軌道が primitive の外接球をかすめもしないなら即座に除外する。
  const pCenterStart = add(startPose.position, qRotate(startPose.rotation, primitive.center));
  const pCenterEnd = add(endPose.position, qRotate(endPose.rotation, primitive.center));
  const primitiveBoundRadius = Math.hypot(primitive.halfLength, primitive.radius);
  const maxCombinedRadius = primitiveBoundRadius + sphereRadius;

  const r0 = sub(sphereStart, pCenterStart);
  const r1 = sub(sphereEnd, pCenterEnd);
  const v = sub(r1, r0);
  const vSq = lenSq(v);
  const tClosest = vSq > 1e-12 ? Math.max(0, Math.min(1, -dot(r0, v) / vSq)) : 0;
  const closestRel = addScaled(r0, v, tClosest);
  if (lenSq(closestRel) > maxCombinedRadius * maxCombinedRadius + 1e-6) {
    return null;
  }

  const metrics = primitiveMotionMetrics(start, end, primitive);
  if (metrics === null) return null;
  const sphereDistance = len(sub(sphereEnd, sphereStart));
  const sphereFeature: MotionMetrics = {
    distance: sphereDistance, angle: 0, bound: sphereRadius,
    // 半径0の点を相手にしても、primitive側の最小形状を刻み幅の基準にする。
    minFeature: sphereRadius > EPSILON ? sphereRadius : metrics.minFeature,
  };
  const rawCount = subdivisions([metrics, sphereFeature]);
  if (rawCount === null) return null;
  const count = Math.min(MAX_SPHERE_SWEEP_SUBDIVISIONS, rawCount);

  return firstSweepHit(count, (t) => hitForSphere(
    { moduleId: primitive.moduleId, cylinder: worldPrimitive(primitive, poseAt(startPose, endPose, t)) },
    sphereAt(sphereStart, sphereEnd, t), sphereRadius,
  ));
}

/** compound shape と移動球の接触。姿勢・並進から分割数を決め、最初の TOI を二分探索する。 */
export function sweptCompoundCylinderSphereContact(
  shape: CompoundCylinderShape, start: RigidPose, end: RigidPose,
  sphereStart: Vec3, sphereEnd: Vec3, sphereRadius: number,
): SweptCompoundCylinderContact | null {
  if (!finiteSphere(sphereStart, sphereRadius) || !finiteVec(sphereEnd)) return null;
  const primitives = sortedPrimitives(shape);
  if (primitives === null) return null;
  let result: SweptCompoundCylinderContact | null = null;
  for (const primitive of primitives) {
    result = earlierSweepHit(result, sweptPrimitiveSphereContact(
      primitive, start, end, sphereStart, sphereEnd, sphereRadius));
  }
  return result;
}

/** 2つの移動 compound shape の接触。両姿勢を slerp し、最初の TOI を二分探索する。 */
export function sweptCompoundCylinderCompoundContact(
  shapeA: CompoundCylinderShape, startA: RigidPose, endA: RigidPose,
  shapeB: CompoundCylinderShape, startB: RigidPose, endB: RigidPose,
): SweptCompoundCylinderContact | null {
  const metricsA = motionMetrics(startA, endA, shapeA);
  const metricsB = motionMetrics(startB, endB, shapeB);
  if (metricsA === null || metricsB === null) return null;
  const count = subdivisions([metricsA, metricsB]);
  if (count === null) return null;
  return firstSweepHit(count, (t) => compoundCylinderCompoundContact(
    shapeA, poseAt(startA, endA, t), shapeB, poseAt(startB, endB, t),
  ));
}

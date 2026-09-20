// capped-cylinder の集合を1つの剛体として見た質量特性。入力座標系はアセンブリ座標系
// (ワールドまたはローカル)に統一されていることを前提とする。各プリミティブの慣性テンソルを
// 指定座標軸へ射影した対角成分のみを返す。
import { type Vec3, v3 } from '../math/vec3';

/** 質量特性を持つ均質 capped cylinder 1個。center/axis は同じ座標系で表す。 */
export interface ShipMassElement {
  readonly moduleId: string;
  readonly center: Vec3;
  readonly axis: Vec3;
  readonly halfLength: number;
  readonly radius: number;
  readonly dryMass: number;
  readonly resourceMass: number;
}

/** 集合全体の質量特性。centerOfMass と inertia は入力と同じ座標系の軸を使う。 */
export interface ShipMassProperties {
  readonly totalMass: number;
  readonly centerOfMass: Vec3;
  /** 重心を原点とした、入力座標軸まわりの対角慣性 [kg m²]。 */
  readonly inertia: Vec3;
  /** 全 capped cylinder を含む、重心中心の bounding sphere 半径 [m]。 */
  readonly boundingRadius: number;
}

const MIN_AXIS_LENGTH = 1e-12;

/**
 * capped-cylinder の列から質量、重心、対角慣性、bounding radius を求める。
 *
 * 各 cylinder は均質な円柱として扱う。軸方向の慣性は 1/2 mr²、軸直交方向は
 * m(r²/4 + h²/3) とし、重心までの平行軸の定理を加える。入力は空でなく、寸法・
 * 質量・座標が有限かつ正しいことを要求し、壊れた形状を黙って補正しない。
 */
export function shipMassProperties(elements: readonly ShipMassElement[]): ShipMassProperties {
  if (elements.length === 0) throw new Error('ship mass elements must not be empty');

  // 入力の順序による浮動小数点の加算順序差をなくす。moduleId は assembly 内で一意とする。
  const ordered = [...elements].sort((a, b) => a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0);
  const ids = new Set<string>();
  for (const element of ordered) validateElement(element, ids);

  let totalMass = 0;
  let weightedX = 0;
  let weightedY = 0;
  let weightedZ = 0;
  for (const element of ordered) {
    const mass = element.dryMass + element.resourceMass;
    totalMass += mass;
    weightedX += element.center.x * mass;
    weightedY += element.center.y * mass;
    weightedZ += element.center.z * mass;
  }
  if (!Number.isFinite(totalMass) || !(totalMass > 0)
    || !Number.isFinite(weightedX) || !Number.isFinite(weightedY) || !Number.isFinite(weightedZ)) {
    throw new Error('ship mass properties are not finite');
  }
  const centerOfMass = v3(weightedX / totalMass, weightedY / totalMass, weightedZ / totalMass);

  let inertiaX = 0;
  let inertiaY = 0;
  let inertiaZ = 0;
  let boundingRadiusSq = 0;
  for (const element of ordered) {
    const mass = element.dryMass + element.resourceMass;
    const axisLength = Math.hypot(element.axis.x, element.axis.y, element.axis.z);
    const ax = element.axis.x / axisLength;
    const ay = element.axis.y / axisLength;
    const az = element.axis.z / axisLength;
    const axialInertia = 0.5 * mass * element.radius * element.radius;
    const transverseInertia = mass * (element.radius * element.radius / 4
      + element.halfLength * element.halfLength / 3);
    const orientationDelta = axialInertia - transverseInertia;
    const dx = element.center.x - centerOfMass.x;
    const dy = element.center.y - centerOfMass.y;
    const dz = element.center.z - centerOfMass.z;

    // 対角成分だけを axis の二次形式から取り出す。積慣性(Ixy 等)は導入しない。
    inertiaX += transverseInertia + orientationDelta * ax * ax + mass * (dy * dy + dz * dz);
    inertiaY += transverseInertia + orientationDelta * ay * ay + mass * (dx * dx + dz * dz);
    inertiaZ += transverseInertia + orientationDelta * az * az + mass * (dx * dx + dy * dy);

    // 円柱から重心までの軸方向・半径方向距離の最大値。全 primitive を含む球になる。
    const axialOffset = Math.abs(dx * ax + dy * ay + dz * az) + element.halfLength;
    const offsetSq = dx * dx + dy * dy + dz * dz;
    const perpendicularSq = Math.max(0, offsetSq - (dx * ax + dy * ay + dz * az) ** 2);
    const radialOffset = Math.sqrt(perpendicularSq) + element.radius;
    boundingRadiusSq = Math.max(boundingRadiusSq, axialOffset * axialOffset + radialOffset * radialOffset);
  }

  const inertia = v3(inertiaX, inertiaY, inertiaZ);
  const boundingRadius = Math.sqrt(boundingRadiusSq);
  if (!finiteVec(inertia) || !Number.isFinite(boundingRadius)) {
    throw new Error('ship mass properties are not finite');
  }
  return { totalMass, centerOfMass, inertia, boundingRadius };
}

function validateElement(element: ShipMassElement, ids: Set<string>): void {
  if (element.moduleId.length === 0 || ids.has(element.moduleId)) {
    throw new Error(`ship mass module id must be unique and non-empty: ${element.moduleId}`);
  }
  ids.add(element.moduleId);
  if (!finiteVec(element.center)) throw new Error(`ship mass center must be finite: ${element.moduleId}`);
  if (!finiteVec(element.axis)) throw new Error(`ship mass axis must be finite: ${element.moduleId}`);
  const axisLength = Math.hypot(element.axis.x, element.axis.y, element.axis.z);
  if (!Number.isFinite(axisLength) || !(axisLength > MIN_AXIS_LENGTH)) {
    throw new Error(`ship mass axis must be nonzero: ${element.moduleId}`);
  }
  if (!Number.isFinite(element.halfLength) || !(element.halfLength > 0)) {
    throw new Error(`ship mass halfLength must be positive: ${element.moduleId}`);
  }
  if (!Number.isFinite(element.radius) || !(element.radius > 0)) {
    throw new Error(`ship mass radius must be positive: ${element.moduleId}`);
  }
  if (!Number.isFinite(element.dryMass) || element.dryMass < 0
    || !Number.isFinite(element.resourceMass) || element.resourceMass < 0
    || !(element.dryMass + element.resourceMass > 0)
    || !Number.isFinite(element.dryMass + element.resourceMass)) {
    throw new Error(`ship mass must be finite and positive: ${element.moduleId}`);
  }
}

function finiteVec(value: Vec3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

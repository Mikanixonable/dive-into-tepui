import { len, type Vec3, v3 } from '../../math/vec3';
import type { CompoundCylinderShape } from '../../physics/compound-cylinder-contact';
import type { CompoundSphereShape } from '../../physics/compound-sphere-contact';

// 接触形状と、同じ形状に対応する剛体物性の一貫したスナップショット。
// 交換時に全項目を検証するため、部分的に更新された物性は観測されない。
export interface DynamicCollisionProperties {
  readonly mass: number;
  readonly radius: number;
  readonly centerOfMass: Vec3;
  readonly inertia: Vec3;
  readonly compoundShape: CompoundCylinderShape | null;
  readonly surfaceShape?: CompoundSphereShape | null;
}

export interface DynamicCollisionPropertiesSnapshot extends DynamicCollisionProperties {
  readonly shapeRevision: number;
}

const COLLISION_EPSILON = 1e-12;

function frozenVec(value: Vec3): Vec3 {
  return Object.freeze(v3(value.x, value.y, value.z));
}

function finiteVec(value: Vec3): boolean {
  return value !== null && value !== undefined
    && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function validateMass(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('dynamic mass must be finite and nonnegative');
  return value;
}

function validateRadius(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('dynamic radius must be finite and nonnegative');
  return value;
}

function validateVec(value: Vec3, name: string): Vec3 {
  if (!finiteVec(value)) throw new Error(`dynamic ${name} must be finite`);
  return value;
}

function validateInertia(value: Vec3): Vec3 {
  validateVec(value, 'inertia');
  if (!(value.x > 0) || !(value.y > 0) || !(value.z > 0)) {
    throw new Error('dynamic inertia must be finite and positive');
  }
  return value;
}

function freezeCompoundShape(shape: CompoundCylinderShape | null): CompoundCylinderShape | null {
  if (shape === null) return null;
  if (shape === undefined || !Array.isArray(shape.primitives) || shape.primitives.length === 0) {
    throw new Error('dynamic compound shape must contain primitives');
  }
  const primitives = shape.primitives.map((primitive) => {
    if (primitive === null || primitive === undefined || typeof primitive.moduleId !== 'string'
      || primitive.moduleId.length === 0) throw new Error('dynamic primitive moduleId must be non-empty');
    validateVec(primitive.center, 'primitive center');
    validateVec(primitive.axis, 'primitive axis');
    const axisLength = Math.hypot(primitive.axis.x, primitive.axis.y, primitive.axis.z);
    if (!Number.isFinite(axisLength) || !(axisLength > COLLISION_EPSILON)) {
      throw new Error('dynamic primitive axis must be nonzero');
    }
    if (!Number.isFinite(primitive.halfLength) || !(primitive.halfLength > 0)
      || !Number.isFinite(primitive.radius) || !(primitive.radius > 0)) {
      throw new Error('dynamic primitive dimensions must be finite and positive');
    }
    return Object.freeze({
      moduleId: primitive.moduleId,
      center: frozenVec(primitive.center),
      axis: frozenVec(v3(
        primitive.axis.x / axisLength, primitive.axis.y / axisLength, primitive.axis.z / axisLength,
      )),
      halfLength: primitive.halfLength,
      radius: primitive.radius,
    });
  });
  return Object.freeze({ primitives: Object.freeze(primitives) });
}

function freezeSurfaceShape(
  shape: CompoundSphereShape | null, exactShape: CompoundCylinderShape | null,
): CompoundSphereShape | null {
  if (shape === null) return null;
  if (shape === undefined || !Array.isArray(shape.primitives) || shape.primitives.length === 0) {
    throw new Error('dynamic surface shape must contain primitives');
  }
  const primitives = shape.primitives.map((primitive) => {
    if (primitive === null || primitive === undefined || typeof primitive.moduleId !== 'string'
      || primitive.moduleId.length === 0) throw new Error('dynamic surface primitive moduleId must be non-empty');
    validateVec(primitive.center, 'surface primitive center');
    if (!Number.isFinite(primitive.radius) || !(primitive.radius > 0)) {
      throw new Error('dynamic surface primitive radius must be finite and positive');
    }
    return Object.freeze({
      moduleId: primitive.moduleId,
      center: frozenVec(primitive.center),
      radius: primitive.radius,
    });
  });
  if (exactShape !== null) {
    let exactBound = 0;
    for (const primitive of exactShape.primitives) {
      exactBound = Math.max(exactBound, len(primitive.center) + Math.hypot(
        primitive.halfLength, primitive.radius,
      ));
    }
    let proxyBound = 0;
    for (const primitive of primitives) {
      proxyBound = Math.max(proxyBound, len(primitive.center) + primitive.radius);
    }
    if (!(proxyBound >= exactBound)) {
      throw new Error('dynamic surface shape must contain the compound shape');
    }
  }
  return Object.freeze({ primitives: Object.freeze(primitives) });
}

// 交換前に全ての衝突物性を検証し、外部から変更できない値へ正規化する。
export function collisionPropertiesOf(properties: DynamicCollisionProperties): DynamicCollisionProperties {
  const nextMass = validateMass(properties.mass);
  const nextRadius = validateRadius(properties.radius);
  const nextCenterOfMass = frozenVec(validateVec(properties.centerOfMass, 'centerOfMass'));
  const nextInertia = frozenVec(validateInertia(properties.inertia));
  const nextShape = freezeCompoundShape(properties.compoundShape);
  const nextSurfaceShape = freezeSurfaceShape(properties.surfaceShape ?? null, nextShape);
  return {
    mass: nextMass,
    radius: nextRadius,
    centerOfMass: nextCenterOfMass,
    inertia: nextInertia,
    compoundShape: nextShape,
    surfaceShape: nextSurfaceShape,
  };
}

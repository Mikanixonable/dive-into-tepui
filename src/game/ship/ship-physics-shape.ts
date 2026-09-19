// 船体 assembly から COM 基準の compound shape と質量特性を同時に導出する。
import { qNormalize, qRotate, type Quat } from '../../math/quat';
import { add, v3, type Vec3 } from '../../math/vec3';
import type {
  CompoundCylinderPrimitive,
  CompoundCylinderShape,
} from '../../physics/compound-cylinder-contact';
import {
  shipMassProperties,
  type ShipMassElement,
  type ShipMassProperties,
} from '../../physics/ship-mass-properties';
import type { ShipAssembly } from './ship-assembly';
import type { ShipModuleDefinition } from './ship-module-definition';
import type { ShipModuleInstance } from './ship-module-instance';

/**
 * Assembly 座標へ展開した compound shape と、同じ世代の質量特性。
 * shape の中心は COM を原点とし、centerOffset が展開前 assembly 座標の COM を表す。
 * mass.centerOfMass は shape を recenter する前の assembly 座標で保持する。
 */
export interface ShipPhysicsShape {
  readonly shape: CompoundCylinderShape;
  readonly mass: ShipMassProperties;
  readonly centerOffset: Vec3;
}

interface ExpandedPrimitive {
  readonly shape: CompoundCylinderPrimitive;
  readonly mass: ShipMassElement;
}

/**
 * ShipAssembly の唯一の module state から、物理へ渡す shape と mass を同時に組み立てる。
 * module transform と primitive local transform はここで一度だけ合成する。空 assembly は
 * 物理形状を持たないため null を返す。
 */
export function shipPhysicsShape(assembly: ShipAssembly): ShipPhysicsShape | null {
  const moduleIds = [...assembly.moduleIds].sort();
  if (moduleIds.length === 0) return null;

  const expanded: ExpandedPrimitive[] = [];
  for (const moduleId of moduleIds) {
    const instance = assembly.module(moduleId);
    const definition = assembly.definition(moduleId);
    const transform = assembly.worldTransformOf(moduleId);
    if (instance === null || definition === null || transform === null) return null;
    const modulePrimitives = expandModule(instance, definition, transform);
    if (modulePrimitives === null) return null;
    expanded.push(...modulePrimitives);
  }

  const massElements = expanded.map((item) => item.mass);
  let mass: ShipMassProperties;
  try {
    // shipMassProperties は入力を並べ替えるため、module の追加順に依存しない。
    mass = shipMassProperties(massElements);
  } catch {
    return null;
  }
  if (!finiteVec(mass.centerOfMass) || !Number.isFinite(mass.totalMass)
    || !finiteVec(mass.inertia) || !Number.isFinite(mass.boundingRadius)) return null;

  const centerOffset = v3(mass.centerOfMass.x, mass.centerOfMass.y, mass.centerOfMass.z);
  const primitives = expanded.map(({ shape }) => ({
    moduleId: shape.moduleId,
    center: v3(
      shape.center.x - centerOffset.x,
      shape.center.y - centerOffset.y,
      shape.center.z - centerOffset.z,
    ),
    axis: v3(shape.axis.x, shape.axis.y, shape.axis.z),
    halfLength: shape.halfLength,
    radius: shape.radius,
  }));

  return {
    shape: { primitives: Object.freeze(primitives) },
    mass,
    centerOffset,
  };
}

function expandModule(
  instance: ShipModuleInstance,
  definition: ShipModuleDefinition,
  transform: { readonly position: Vec3; readonly rotation: Quat },
): readonly ExpandedPrimitive[] | null {
  if (!finiteVec(transform.position) || !finiteQuat(transform.rotation)) return null;
  const rotation = qNormalize(transform.rotation);
  if (!finiteQuat(rotation)) return null;

  const totalVolume = definition.solidPrimitives.reduce((total, primitive) => {
    const volume = cylinderVolume(primitive.halfLength, primitive.radius);
    return total + volume;
  }, 0);
  if (!Number.isFinite(totalVolume) || !(totalVolume > 0)) return null;

  const moduleResourceMass = resourceMass(instance, definition);
  if (moduleResourceMass === null) return null;
  const result: ExpandedPrimitive[] = [];
  for (let index = 0; index < definition.solidPrimitives.length; index++) {
    const primitive = definition.solidPrimitives[index];
    if (primitive === undefined) return null;
    const volume = cylinderVolume(primitive.halfLength, primitive.radius);
    const center = add(transform.position, qRotate(rotation, primitive.center));
    const axis = qRotate(rotation, primitive.axis);
    if (!finiteVec(center) || !finiteVec(axis) || !Number.isFinite(volume)) return null;
    const fraction = volume / totalVolume;
    const dryMass = definition.dryMass * fraction;
    const resource = moduleResourceMass * fraction;
    if (!Number.isFinite(dryMass) || !Number.isFinite(resource)) return null;
    result.push({
      shape: {
        moduleId: instance.id,
        center: v3(center.x, center.y, center.z),
        axis: v3(axis.x, axis.y, axis.z),
        halfLength: primitive.halfLength,
        radius: primitive.radius,
      },
      mass: {
        moduleId: `${instance.id}#${index}`,
        center: v3(center.x, center.y, center.z),
        axis: v3(axis.x, axis.y, axis.z),
        halfLength: primitive.halfLength,
        radius: primitive.radius,
        dryMass,
        resourceMass: resource,
      },
    });
  }
  return result;
}

function cylinderVolume(halfLength: number, radius: number): number {
  return Math.PI * radius * radius * (2 * halfLength);
}

function resourceMass(instance: ShipModuleInstance, definition: ShipModuleDefinition): number | null {
  if (instance.kind !== 'tank' && instance.kind !== 'booster') return 0;
  const fuelMassPerUnit = definition.abilities.fuelMassPerUnit ?? 1;
  const result = instance.fuel * fuelMassPerUnit;
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function finiteVec(value: Vec3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function finiteQuat(value: Quat): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y)
    && Number.isFinite(value.z) && Number.isFinite(value.w)
    && Math.hypot(value.x, value.y, value.z, value.w) > 1e-12;
}

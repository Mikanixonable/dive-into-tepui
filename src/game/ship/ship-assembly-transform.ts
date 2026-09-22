import {
  qNormalize, type Quat,
} from '../../math/quat';
import { v3, type Vec3 } from '../../math/vec3';
import type { ShipModuleDefinition } from './ship-module-definition';
import type { ModuleTransform, SideSlot } from './ship-assembly-types';
import type { ShipModuleInstance } from './ship-module-instance';

export function copyTransform(transform: ModuleTransform): ModuleTransform {
  return {
    position: v3(transform.position.x, transform.position.y, transform.position.z),
    rotation: { ...transform.rotation },
  };
}

export function normalizedTransform(transform: ModuleTransform): ModuleTransform {
  if (!finiteVector(transform.position) || !finiteQuaternion(transform.rotation)) {
    throw new Error('module transform must be finite');
  }
  const length = Math.hypot(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w);
  if (!(length > 1e-12)) throw new Error('module transform rotation must be nonzero');
  return {
    position: v3(transform.position.x, transform.position.y, transform.position.z),
    rotation: qNormalize(transform.rotation),
  };
}

export function finiteVector(value: Vec3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

export function finiteQuaternion(value: Quat): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y)
    && Number.isFinite(value.z) && Number.isFinite(value.w);
}

export function isIdentityRotation(value: Quat): boolean {
  return value.x === 0 && value.y === 0 && value.z === 0 && value.w === 1;
}

export function sideSlotDirection(slot: SideSlot): Vec3 {
  switch (slot) {
    case 'side:+x': return v3(1, 0, 0);
    case 'side:-x': return v3(-1, 0, 0);
    case 'side:+y': return v3(0, 1, 0);
    case 'side:-y': return v3(0, -1, 0);
  }
}

export function sideSlotRotation(slot: SideSlot): Quat {
  const INV_SQRT2 = Math.SQRT1_2;
  switch (slot) {
    case 'side:+x': return { x: 0, y: INV_SQRT2, z: 0, w: INV_SQRT2 };
    case 'side:-x': return { x: INV_SQRT2, y: 0, z: -INV_SQRT2, w: 0 };
    case 'side:+y': return { x: -0.5, y: 0.5, z: 0.5, w: 0.5 };
    case 'side:-y': return { x: 0.5, y: 0.5, z: -0.5, w: 0.5 };
  }
}

export function sideMountTransform(
  parent: ShipModuleDefinition, child: ShipModuleDefinition, slot: SideSlot,
): ModuleTransform {
  const direction = sideSlotDirection(slot);
  return {
    position: v3(
      direction.x * (parent.diameter / 2 + child.length / 2),
      direction.y * (parent.diameter / 2 + child.length / 2),
      0,
    ),
    rotation: sideSlotRotation(slot),
  };
}

export function sideSlotFromTransform(transform: ModuleTransform): SideSlot | null {
  const p = transform.position;
  const values: readonly [SideSlot, number][] = [
    ['side:+x', p.x], ['side:-x', -p.x], ['side:+y', p.y], ['side:-y', -p.y],
  ];
  const best = values.reduce((current, candidate) => candidate[1] > current[1] ? candidate : current);
  if (best[1] <= 1e-9 || Math.abs(p.z) > 1e-9) return null;
  return best[0];
}

export function sameTransform(actual: ModuleTransform, expected: ModuleTransform): boolean {
  const p = actual.position;
  const e = expected.position;
  if (Math.hypot(p.x - e.x, p.y - e.y, p.z - e.z) > 1e-9) return false;
  const a = actual.rotation;
  const b = expected.rotation;
  const quaternionDot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  return Math.abs(Math.abs(quaternionDot) - 1) < 1e-9;
}

export function isSideParent(kind: ShipModuleInstance['kind']): boolean {
  return kind === 'cockpit' || kind === 'tank';
}

export function isSideChild(kind: ShipModuleInstance['kind']): boolean {
  return kind === 'dock' || kind === 'docking_port' || kind === 'solar_panel' || kind === 'radiator';
}

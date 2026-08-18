import type { BaseModulePart } from '../game-entity/parts';
import type { VesselAssembly } from './assembly';
import { validateAssembly } from './assembly-editor';
import { deriveBaseDockingPorts } from './base-module';

/**
 * Base-only invariants.  General tree/section/reference checks stay in the shared
 * assembly editor so the workbench cannot accidentally give bases a weaker model.
 */
export function validateBaseAssembly(
  assembly: VesselAssembly,
  occupiedDockCount = 0,
): readonly string[] {
  const issues = validateAssembly(assembly, { validateBlueprint: false })
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message);
  const modules = assembly.placements
    .map((placement) => placement.part)
    .filter((part): part is BaseModulePart => part.type === 'base_module' && part.hp > 0);

  if (modules.length !== 1) issues.push('基地には稼働中の base_module がちょうど1つ必要です');
  const module = modules[0];
  if (!module) return issues;
  const availablePorts = deriveBaseDockingPorts(assembly, module).slots;
  if (availablePorts.length < occupiedDockCount) {
    issues.push(`ドック容量 ${availablePorts.length} が収容中の船 ${occupiedDockCount} 隻を下回っています`);
  }
  if (module.capacity < occupiedDockCount) {
    issues.push(`基地モジュール容量 ${module.capacity} が収容中の船 ${occupiedDockCount} 隻を下回っています`);
  }
  if (module.dockSlots.some((port) => !finitePort(port)) || !finitePort(module.hatch)) {
    issues.push('基地のハッチまたはドック接続口が不正です');
  }
  return issues;
}

function finitePort(port: { localPos: { x: number; y: number; z: number }; localNormal: { x: number; y: number; z: number } }): boolean {
  return [port.localPos.x, port.localPos.y, port.localPos.z,
    port.localNormal.x, port.localNormal.y, port.localNormal.z].every(Number.isFinite);
}

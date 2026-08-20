import type { BaseModulePart } from '../game-entity/parts';
import type { VesselAssembly } from './assembly';
import { validateAssembly } from './assembly-editor';
import type { BlueprintLimits } from './blueprint-validation';
import { DEFAULT_BLUEPRINT_LIMITS } from './blueprint-validation';
import { deriveBaseDockingPorts } from './base-module';

// 基地は艦より一桁重く一回り大きいので、艦の寸法・質量の上限では元から収まらない。
export const BASE_BLUEPRINT_LIMITS: BlueprintLimits = {
  ...DEFAULT_BLUEPRINT_LIMITS,
  maxMass: 1e7,
  maxDimension: 400,
};

// 基地であることそのものが要求する不変条件。破れば収容中の艦が居場所を失うので、編集も確定も
// これで拒む。構造として組み上がるかは呼び出し側が別に見る。
export function baseInvariants(
  assembly: VesselAssembly,
  occupiedDockCount = 0,
): readonly string[] {
  const issues: string[] = [];
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

// 構造として組み上がるかと、基地固有の不変条件を合わせて見る。作業台を通さずに基地の構成を
// 差し替える経路が使う。
export function validateBaseAssembly(
  assembly: VesselAssembly,
  occupiedDockCount = 0,
): readonly string[] {
  const structural = validateAssembly(assembly, { validateBlueprint: false })
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message);
  return [...structural, ...baseInvariants(assembly, occupiedDockCount)];
}

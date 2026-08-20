import type { BaseModulePart, DockPort } from '../game-entity/parts';
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

// 差し替え後も維持されなければならない基地の性質。呼び出し側(Docking)が基地の現在の実機
// 状態から都度導いて渡す — セッション開始時の値を焼き込むと、収容艦の出入りに追従できない。
export interface BaseModuleContinuity {
  // 差し替え後の構成でも保たなければならない基地モジュールの id。
  readonly moduleId: string;
  // 艦を収容中のドック口(スロット番号ごとの元の位置・法線)。差し替え後の構成でも
  // 同じ位置・法線を保っていなければならない。
  readonly occupiedPorts: ReadonlyMap<number, DockPort>;
}

// 基地であることそのものが要求する不変条件。破れば収容中の艦が居場所を失うので、編集も確定も
// これで拒む。構造として組み上がるかは呼び出し側が別に見る。continuity を渡すと、モジュールの
// 同一性と収容中のドック口の継続性も合わせて見る(省略すると見ない — 対象がまだ基地として
// 実機化されていない下書きなどには、比べる元の状態が無い)。
export function baseInvariants(
  assembly: VesselAssembly,
  occupiedDockCount = 0,
  continuity: BaseModuleContinuity | null = null,
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
  // continuity が渡されたときだけ、モジュールの同一性とドック口の継続性も見る。
  if (continuity) {
    if (module.id !== continuity.moduleId) {
      issues.push('基地モジュールのIDは変更できません');
    } else {
      for (const [slotIndex, oldPort] of continuity.occupiedPorts) {
        if (!sameDockPort(oldPort, availablePorts[slotIndex])) {
          issues.push(`ドック ${slotIndex + 1} は船が収容中のため変更できません`);
        }
      }
    }
  }
  return issues;
}

function finitePort(port: { localPos: { x: number; y: number; z: number }; localNormal: { x: number; y: number; z: number } }): boolean {
  return [port.localPos.x, port.localPos.y, port.localPos.z,
    port.localNormal.x, port.localNormal.y, port.localNormal.z].every(Number.isFinite);
}

// 2つのドックの口が同じ位置・同じ法線を向いているか。
function sameDockPort(
  a: { readonly localPos: { x: number; y: number; z: number }; readonly localNormal: { x: number; y: number; z: number } } | undefined,
  b: { readonly localPos: { x: number; y: number; z: number }; readonly localNormal: { x: number; y: number; z: number } } | undefined,
): boolean {
  if (!a || !b) return false;
  return Math.abs(a.localPos.x - b.localPos.x) < 1e-9
    && Math.abs(a.localPos.y - b.localPos.y) < 1e-9
    && Math.abs(a.localPos.z - b.localPos.z) < 1e-9
    && Math.abs(a.localNormal.x - b.localNormal.x) < 1e-9
    && Math.abs(a.localNormal.y - b.localNormal.y) < 1e-9
    && Math.abs(a.localNormal.z - b.localNormal.z) < 1e-9;
}

// 構造として組み上がるかと、基地固有の不変条件を合わせて見る。作業台を通さずに基地の構成を
// 差し替える経路が使う。
export function validateBaseAssembly(
  assembly: VesselAssembly,
  occupiedDockCount = 0,
  continuity: BaseModuleContinuity | null = null,
): readonly string[] {
  const structural = validateAssembly(assembly, { validateBlueprint: false })
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message);
  return [...structural, ...baseInvariants(assembly, occupiedDockCount, continuity)];
}

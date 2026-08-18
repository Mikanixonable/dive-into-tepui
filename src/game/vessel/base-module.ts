// 基地モジュールが与える格納機構。ハッチとスロットの配置も、受け入れの閾値も、
// 機体の定数ではなくこの部品の性能値から読む。
import { qRotate } from '../../physics/attitude';
import { add, v3, Vec3 } from '../../physics/vec3';
import type { AnyPart, BaseModulePart, DockPort, Part } from '../game-entity/parts';
import { createPart } from '../game-entity/parts';
import type { Vessel } from './vessel';

// 既定の基地モジュール。中腹のドッキングパレット上部に中央ハッチ、その四隅にスロットを持つ。
export function createDefaultBaseModule(maxHp: number): BaseModulePart {
  const up = v3(0, 1, 0);
  const slot = (x: number, z: number): DockPort => ({ localPos: v3(x, 21.0, z), localNormal: up });
  return createPart('base_module', {
    name: 'Base Module',
    maxHp,
    hp: maxHp,
    hatch: { localPos: v3(0, 21.0, 0), localNormal: up },
    dockSlots: [slot(-16.5, -16.5), slot(16.5, -16.5), slot(-16.5, 16.5), slot(16.5, 16.5)],
    capacity: 4,
    hatchCaptureDist: 80,
    hatchCaptureAlignment: 0.5,
    slotCaptureDist: 50,
    slotCaptureAlignment: 0.5,
    captureRelSpeed: 20,
  });
}

// 収容中の機体のエントリ。parts は収容機の parts と同一参照(修理は機体へ直接反映される)。
// hp/maxHp は一覧タブ表示用の集計値で、修理のたびに書き戻す。
export interface DockedVesselEntry {
  readonly id: string;
  readonly name: string;
  hp: number;
  maxHp: number;
  readonly parts: Part[];
  readonly vessel: Vessel;
  slotIndex: number;
}

// 基地モジュールを積んだ機体が抱える在庫と収容。
export interface BaseState {
  money: number;
  inventory: AnyPart[];
  dockedVessels: DockedVesselEntry[];
}

// 口のワールド位置。
export function portWorldPos(vessel: Vessel, port: DockPort): Vec3 {
  return add(vessel.state.r, qRotate(vessel.att.q, port.localPos));
}

// 口のワールド外向き法線。
export function portWorldNormal(vessel: Vessel, port: DockPort): Vec3 {
  return qRotate(vessel.att.q, port.localNormal);
}

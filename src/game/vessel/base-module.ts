// 基地モジュールが与える格納の状態と、ハッチ・スロットのワールド座標。
import { qRotate } from '../../physics/attitude';
import { add, Vec3 } from '../../physics/vec3';
import type { AnyPart, DockPort, Part } from '../game-entity/parts';
import type { Vessel } from './vessel';

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

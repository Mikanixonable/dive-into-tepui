// 基地モジュールが与える格納の状態と、ハッチ・スロットのワールド座標。
import { qRotate } from '../../physics/attitude';
import type { Quat } from '../../physics/attitude';
import { add, norm, Vec3 } from '../../physics/vec3';
import type { AnyPart, DockPort, Part } from '../game-entity/parts';
import { FACILITIES, INITIAL_FACILITY_IDS, type FacilityId } from '../economy/facility';
import { ResourceLedger } from '../economy/resource-ledger';
export {
  baseAssemblyCollisionRadius, deriveBaseDockingPorts,
  type BaseDockingPorts, type DerivedBaseDockPort,
} from './base-geometry';

// 収容中の機体のエントリ。parts は収容機の parts と同一参照(修理は機体へ直接反映される)。
// hp/maxHp は一覧タブ表示用の集計値で、修理のたびに書き戻す。
// V は実際には Vessel だが、この型を Vessel(DOM/Three.js)から切り離して
// DOM/Three.js を持たないテストからでも読めるようにするため、ここでは Vessel を import しない。
// 具体化(V = Vessel)は vessel.ts の再エクスポートが行う。
export interface DockedVesselEntry<V = unknown> {
  readonly id: string;
  readonly name: string;
  hp: number;
  maxHp: number;
  readonly parts: Part[];
  readonly vessel: V;
  slotIndex: number;
}

// 基地モジュールを積んだ機体が抱える在庫と収容。資源の帳簿を持つのは基地モジュールを積んだ
// 機体だけであり、生産はその帳簿から引く。
export interface BaseState<V = unknown> {
  inventory: AnyPart[];
  dockedVessels: DockedVesselEntry<V>[];
  readonly resources: ResourceLedger;
}

// Vessel本体をimportせずに、座標変換だけを受け取る純粋境界。これにより基地ポート導出を
// DOM/Three.jsを持たないテストから利用でき、Vesselとの循環依存も発生しない。
export interface VesselPose {
  readonly state: { readonly r: Vec3 };
  readonly att: { readonly q: Quat };
}

interface BaseFacilityHost extends VesselPose {
  readonly parts: readonly AnyPart[];
}

// この基地が同時に回せる電力 [W]。生産の電力は基地の設備が発電するもので賄う — 機体自身の
// 太陽電池パドルは機体の系を動かすためのものであり、基地の生産設備の規模とは桁が違う。
export function basePowerAvailable(base: BaseFacilityHost): number {
  let total = 0;
  for (const id of baseFacilities(base)) total += FACILITIES[id].powerOutput;
  return total;
}

// この基地で使える生産設備。月面基地が地球から運ばれた最初の一組に、基地モジュール自身が
// 備える設備を足したもの。表に無い id は落とす。
export function baseFacilities(base: BaseFacilityHost): readonly FacilityId[] {
  const ids = new Set<FacilityId>(INITIAL_FACILITY_IDS);
  for (const part of base.parts) {
    if (part.type !== 'base_module') continue;
    for (const id of part.facilities) {
      if (id in FACILITIES) ids.add(id as FacilityId);
    }
  }
  return [...ids];
}

// 口のワールド位置。
export function portWorldPos(vessel: VesselPose, port: DockPort): Vec3 {
  return add(vessel.state.r, qRotate(vessel.att.q, port.localPos));
}

// 口のワールド外向き法線。
export function portWorldNormal(vessel: VesselPose, port: DockPort): Vec3 {
  return norm(qRotate(vessel.att.q, port.localNormal));
}

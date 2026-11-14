// ストーリーの引き継ぎ艦隊: いま存在するプレイヤーの艦をキャンペーンの記録(CarriedShip)へ
// 畳む捕捉と、記録から艦を新しく作る生成を持つ(GAME.md 11.2)。捕捉は艦を書き換えない —
// 拠点へ接舷している艦は、拠点の assembly の複製を割って切り出す。
import type * as THREE from 'three/webgpu';
import type { KinematicState } from '../../physics/kinematic-state';
import type { EntityRegistry } from '../dynamic/entity-registry';
import { ModularShip } from '../ship/modular-ship';
import type { ShipAssembly } from '../ship/ship-assembly';
import {
  restoreShipAssembly, serializeShipAssembly,
  type SerializedPendingRepair, type SerializedShipConstructionDraft,
} from '../ship/ship-save';
import type { CarriedShip } from './campaign-state';

// 引き継がれる艦の上限。同時に運用できる艦の上限と一致する(GAME.md 11.2)。
export const MAX_CARRIED_SHIPS = 6;

// いま存在する艦の列から、引き継ぎ艦の記録を組む。facilityIds はそのステージの拠点
// (設備船)の id で、拠点そのものは引き継がない — 拠点へ接舷している艦だけを切り出す。
// 喪失した艦と、プレイヤー所属でない艦(漂流デブリなど)は対象にならない。
export function captureCarriedFleet(
  ships: readonly ModularShip[], facilityIds: ReadonlySet<string>, simTime: number,
): readonly CarriedShip[] {
  const carried: CarriedShip[] = [];
  for (const ship of ships) {
    if (facilityIds.has(ship.id)) {
      carried.push(...extractDockedVessels(ship, simTime));
    } else {
      const record = captureIndependentShip(ship, simTime);
      if (record !== null) carried.push(record);
    }
  }
  return carried.slice(0, MAX_CARRIED_SHIPS);
}

// 引き継ぎ艦の記録1隻ぶんから、状態 state に置かれる艦を組み直す。台帳への登録と
// 操作対象の主張は呼び手(ステージ)が行う。
export function createCarriedShip(
  record: CarriedShip, state: KinematicState, registry: EntityRegistry, scene: THREE.Scene,
): ModularShip {
  return ModularShip.create(
    {
      id: record.id,
      name: record.name,
      assembly: restoreShipAssembly(record.assembly),
      dockState: record.dockState,
      pendingRepairs: record.pendingRepairs,
      dockedVessels: record.dockedVessels,
      operatingCockpitId: record.operatingCockpitId,
      ...(record.ammo === null ? {} : { ammo: record.ammo }),
      state,
    },
    registry,
    scene,
  );
}

// 独立した船体として存在する艦の記録。対象でなければ null。
function captureIndependentShip(ship: ModularShip, simTime: number): CarriedShip | null {
  if (!ship.motion.alive) return null;
  const saved = ship.serialize();
  // 地表固定の艦は拠点であり、プレイヤー所属でない艦は引き継がない。
  if (!saved.assembly.playerOwned || saved.surfaceAnchor !== undefined) return null;
  return {
    id: ship.id,
    name: saved.name,
    assembly: saved.assembly,
    dockState: rebaseDrafts(saved.dockState, simTime),
    pendingRepairs: rebaseRepairs(saved.pendingRepairs ?? [], simTime),
    dockedVessels: saved.dockedVessels,
    operatingCockpitId: saved.operatingCockpitId,
    ammo: { mags: saved.fire.mags, rounds: saved.fire.rounds },
  };
}

// 拠点へ接舷している艦を、拠点の assembly の複製から切り出して記録にする。接舷した艦へ
// さらに接舷している艦は、その艦の接舷艦として記録に残る。拠点の実体は書き換えない。
function extractDockedVessels(facility: ModularShip, simTime: number): CarriedShip[] {
  const records = facility.connections.serializeDockedVessels();
  if (records.length === 0) return [];
  const rootId = rootModuleId(facility.assembly);
  if (rootId === null) return [];
  let working = facility.assembly.clone();
  const remaining = [...records];
  const carried: CarriedShip[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex(
      (record) => working.graph.some((connection) => connection.id === record.connectionId),
    );
    if (index < 0) break;
    const record = remaining[index];
    if (record === undefined) break;
    const [first, second] = working.splitAt(record.connectionId);
    const retained = first.moduleIds.includes(rootId) ? first : second;
    const detached = retained === first ? second : first;
    const subRecords = remaining.filter(
      (other) => other !== record
        && detached.graph.some((connection) => connection.id === other.connectionId),
    );
    const docks = facility.docks.copyForAssembly(detached);
    carried.push({
      id: record.id,
      name: record.name,
      assembly: serializeShipAssembly(detached),
      dockState: rebaseDrafts(docks.serialize(), simTime),
      pendingRepairs: rebaseRepairs(docks.serializePendingRepairs(), simTime),
      dockedVessels: subRecords,
      operatingCockpitId: detachedCockpitId(facility, detached),
      ammo: null,
    });
    for (const used of [record, ...subRecords]) remaining.splice(remaining.indexOf(used), 1);
    working = retained;
  }
  return carried;
}

// 切り出された側の操作コックピット。拠点の操作コックピットがその側にあればそれ、
// 無ければ健全なコックピットの先頭。
function detachedCockpitId(facility: ModularShip, detached: ShipAssembly): string | null {
  const operating = facility.capabilities.operatingCockpitId;
  if (operating !== null && detached.module(operating) !== null) return operating;
  return detached.modules.find((module) => module.kind === 'cockpit' && module.hp > 0)?.id ?? null;
}

// assembly の根(親を持たないモジュール)の id。木でなければ null。
function rootModuleId(assembly: ShipAssembly): string | null {
  const incoming = new Set(assembly.graph.map((connection) => connection.childId));
  return assembly.moduleIds.find((id) => !incoming.has(id)) ?? null;
}

// 建造予約の完了時刻を、引き継ぎ先のランの simTime(入場が 0)基準へ移す。
function rebaseDrafts(
  drafts: readonly SerializedShipConstructionDraft[], simTime: number,
): readonly SerializedShipConstructionDraft[] {
  return drafts.map((draft) => (draft.pendingModule == null
    ? draft
    : {
      ...draft,
      pendingModule: {
        ...draft.pendingModule,
        completesAt: Math.max(0, draft.pendingModule.completesAt - simTime),
      },
    }));
}

// 修理の完了時刻を、引き継ぎ先のランの simTime(入場が 0)基準へ移す。
function rebaseRepairs(
  repairs: readonly SerializedPendingRepair[], simTime: number,
): readonly SerializedPendingRepair[] {
  return repairs.map((repair) => ({
    ...repair,
    completesAt: Math.max(0, repair.completesAt - simTime),
  }));
}

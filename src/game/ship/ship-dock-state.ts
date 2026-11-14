// 接舷部ごとの建造予約を保持し、接舷状態と合わせた状態面を提供する。
import type { ShipAssembly } from './ship-assembly';

export type ShipDockStatus = 'empty' | 'building' | 'connected';

// 建造中の部品。配置を始めたが、完了時刻まではまだ船体の一部になっていない
// (GAME.md 11.4)。completesAt はシミュレーション時刻 [s]。
export interface PendingConstructionModule {
  readonly id: string;
  readonly definitionId: string;
  readonly slotId: string;
  readonly completesAt: number;
}

// 修理中の作業。着手時に素材を支払い済みで、完了時刻に修理が適用される
// (GAME.md 11.4)。materials は支払った素材で、完了時点で修理の条件を失って
// いれば備蓄へ戻る。
export interface PendingRepair {
  readonly dockId: string;
  readonly completesAt: number;
  readonly materials: number;
}

export interface ShipConstructionDraftState {
  readonly dockId: string;
  readonly addedIds: readonly string[];
  readonly axialTailId: string;
  readonly firstConnectionId: string | null;
  // 追加済みのうち、拠点の備蓄から素材を支払って置いた部品。取り外しと破棄で
  // 返金されるのはこれだけ(無償で置かれた開始状態の部品は返金の対象にならない)。
  readonly paidModuleIds: readonly string[];
  // 建造中の部品。無い場合は null。建造中の部品はまだ assembly に無く、
  // paidModuleIds にも入らない(支払いは済んでいて、返金はこの記録から行う)。
  readonly pendingModule: PendingConstructionModule | null;
}

// 建造予約を保持し、接続状態は assembly の detachable edge から導出する。
export class ShipDockState {
  private readonly building = new Map<string, ShipConstructionDraftState>();
  private readonly repairs = new Map<string, PendingRepair>();

  public constructor(saved: readonly ShipConstructionDraftState[] = []) {
    for (const draft of saved) this.building.set(draft.dockId, this.copy(draft));
  }

  // 接舷 edge を優先し、指定接舷部の現在状態を返す。
  public status(assembly: ShipAssembly, moduleId: string): ShipDockStatus {
    if (assembly.isPortConnected(moduleId)) return 'connected';
    return this.building.has(moduleId) ? 'building' : 'empty';
  }

  // 健全で空いている接舷部に空の建造予約を作る。
  public beginBuilding(assembly: ShipAssembly, moduleId: string): void {
    const module = assembly.module(moduleId);
    if (module?.kind !== 'dock') {
      throw new Error(`not a docking module: ${moduleId}`);
    }
    if (module.hp <= 0) throw new Error(`docking module is destroyed: ${moduleId}`);
    if (this.status(assembly, moduleId) !== 'empty') throw new Error(`docking module is not empty: ${moduleId}`);
    this.building.set(moduleId, {
      dockId: moduleId, addedIds: [], axialTailId: moduleId, firstConnectionId: null,
      paidModuleIds: [], pendingModule: null,
    });
  }

  public finishBuilding(moduleId: string): void { this.building.delete(moduleId); }

  // 修理の着手を記録する。同じドックの修理は1件だけが進む。
  public scheduleRepair(repair: PendingRepair): void {
    this.repairs.set(repair.dockId, { ...repair });
  }

  // ドックの修理中の作業。無ければ null。
  public pendingRepair(dockId: string): PendingRepair | null {
    const repair = this.repairs.get(dockId);
    return repair === undefined ? null : { ...repair };
  }

  // 完了時刻が来た修理を取り出して消す。返った作業は呼び手が適用する。
  public dueRepairs(simTime: number): readonly PendingRepair[] {
    const due = [...this.repairs.values()].filter(repair => repair.completesAt <= simTime);
    for (const repair of due) this.repairs.delete(repair.dockId);
    return due;
  }

  // 全ての修理中の作業を保存用の独立した値へ複製する。
  public serializePendingRepairs(): readonly PendingRepair[] {
    return [...this.repairs.values()].map(repair => ({ ...repair }));
  }

  // 保存されていた修理中の作業を戻す。検証は ship-save 側が済ませた前提で置く。
  public restorePendingRepairs(saved: readonly PendingRepair[]): void {
    this.repairs.clear();
    for (const repair of saved) this.repairs.set(repair.dockId, { ...repair });
  }

  // 建造予約の複製を返す。予約が無ければ null。
  public constructionDraft(moduleId: string): ShipConstructionDraftState | null {
    const draft = this.building.get(moduleId);
    return draft === undefined ? null : this.copy(draft);
  }

  // 既存予約の編集位置と追加済み module 群を置換する。
  public updateConstructionDraft(draft: ShipConstructionDraftState): void {
    if (!this.building.has(draft.dockId)) throw new Error(`docking module is not building: ${draft.dockId}`);
    this.building.set(draft.dockId, this.copy(draft));
  }

  // assembly の分割後に、その側へ完全に属する建造予約だけを引き継ぐ。修理中の
  // 作業は、そのドックが属する側へ引き継ぐ。
  public copyForAssembly(assembly: ShipAssembly): ShipDockState {
    const copy = new ShipDockState(this.serialize().filter(draft => (
      assembly.module(draft.dockId) !== null
      && draft.addedIds.every(id => assembly.module(id) !== null)
      && (draft.firstConnectionId === null
        || assembly.graph.some(connection => connection.id === draft.firstConnectionId))
    )));
    copy.restorePendingRepairs(this.serializePendingRepairs().filter(
      repair => assembly.module(repair.dockId) !== null,
    ));
    return copy;
  }

  public restrictToAssembly(assembly: ShipAssembly): void {
    const kept = this.copyForAssembly(assembly);
    this.building.clear();
    for (const draft of kept.serialize()) this.building.set(draft.dockId, this.copy(draft));
    this.repairs.clear();
    for (const repair of kept.serializePendingRepairs()) {
      this.repairs.set(repair.dockId, { ...repair });
    }
  }

  // docking merge で remap された module/connection ID を使い、相手側の予約を移管する。
  public mergeFrom(
    other: ShipDockState, moduleIds: ReadonlyMap<string, string>, connectionIds: ReadonlyMap<string, string>,
  ): void {
    for (const draft of other.serialize()) {
      const dockId = moduleIds.get(draft.dockId);
      const axialTailId = moduleIds.get(draft.axialTailId);
      const firstConnectionId = draft.firstConnectionId === null
        ? null : connectionIds.get(draft.firstConnectionId);
      if (dockId === undefined || axialTailId === undefined
        || (draft.firstConnectionId !== null && firstConnectionId === undefined)) {
        throw new Error(`cannot remap construction draft: ${draft.dockId}`);
      }
      const addedIds = draft.addedIds
        .map(id => moduleIds.get(id))
        .filter((id): id is string => id !== undefined);
      if (addedIds.length !== draft.addedIds.length) {
        throw new Error(`cannot remap construction modules: ${draft.dockId}`);
      }
      const paidModuleIds = (draft.paidModuleIds ?? [])
        .map(id => moduleIds.get(id))
        .filter((id): id is string => id !== undefined);
      if (paidModuleIds.length !== (draft.paidModuleIds ?? []).length) {
        throw new Error(`cannot remap construction modules: ${draft.dockId}`);
      }
      const remappedFirstConnectionId = firstConnectionId ?? null;
      this.building.set(dockId, {
        dockId,
        addedIds,
        axialTailId,
        firstConnectionId: remappedFirstConnectionId,
        paidModuleIds,
        // 建造中の部品はまだ assembly に無く、id は一意に採番されるため remap せず
        // そのまま引き継ぐ。
        pendingModule: draft.pendingModule ?? null,
      });
    }
    // 修理中の作業は、ドックの remap に合わせて移管する。移管先の無いドックの
    // 修理は、ドックそのものが merge で失われた場合であり、作業も消える。
    for (const repair of other.serializePendingRepairs()) {
      const dockId = moduleIds.get(repair.dockId);
      if (dockId !== undefined) this.repairs.set(dockId, { ...repair, dockId });
    }
  }

  // 全建造予約を保存用の独立した値へ複製する。
  public serialize(): readonly ShipConstructionDraftState[] {
    return [...this.building.values()].map(draft => this.copy(draft));
  }

  private copy(draft: ShipConstructionDraftState): ShipConstructionDraftState {
    return {
      ...draft,
      addedIds: [...draft.addedIds],
      paidModuleIds: [...(draft.paidModuleIds ?? [])],
      pendingModule: draft.pendingModule ? { ...draft.pendingModule } : null,
    };
  }
}

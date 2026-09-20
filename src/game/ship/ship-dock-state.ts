// 接舷部ごとの建造予約を保持し、接舷状態と合わせた状態面を提供する。
import type { ShipAssembly } from './ship-assembly';

export type ShipDockStatus = 'empty' | 'building' | 'connected';

export interface ShipConstructionDraftState {
  readonly dockId: string;
  readonly addedIds: readonly string[];
  readonly axialTailId: string;
  readonly firstConnectionId: string | null;
}

// 建造予約を保持し、接続状態は assembly の detachable edge から導出する。
export class ShipDockState {
  private readonly building = new Map<string, ShipConstructionDraftState>();

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
    });
  }

  public finishBuilding(moduleId: string): void { this.building.delete(moduleId); }

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

  // assembly の分割後に、その側へ完全に属する建造予約だけを引き継ぐ。
  public copyForAssembly(assembly: ShipAssembly): ShipDockState {
    return new ShipDockState(this.serialize().filter(draft => (
      assembly.module(draft.dockId) !== null
      && draft.addedIds.every(id => assembly.module(id) !== null)
      && (draft.firstConnectionId === null
        || assembly.graph.some(connection => connection.id === draft.firstConnectionId))
    )));
  }

  public restrictToAssembly(assembly: ShipAssembly): void {
    const kept = this.copyForAssembly(assembly);
    this.building.clear();
    for (const draft of kept.serialize()) this.building.set(draft.dockId, this.copy(draft));
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
      const remappedFirstConnectionId = firstConnectionId ?? null;
      this.building.set(dockId, {
        dockId,
        addedIds,
        axialTailId,
        firstConnectionId: remappedFirstConnectionId,
      });
    }
  }

  // 全建造予約を保存用の独立した値へ複製する。
  public serialize(): readonly ShipConstructionDraftState[] {
    return [...this.building.values()].map(draft => this.copy(draft));
  }

  private copy(draft: ShipConstructionDraftState): ShipConstructionDraftState {
    return { ...draft, addedIds: [...draft.addedIds] };
  }
}

import type { ShipAssembly } from './ship-assembly';

export type ShipDockStatus = 'empty' | 'building' | 'connected';

export interface ShipConstructionDraftState {
  readonly dockId: string;
  readonly addedIds: readonly string[];
  readonly axialTailId: string;
  readonly firstConnectionId: string | null;
}

// 建造予約だけを明示状態として持ち、接舷状態は assembly の docking edge から導出する。
export class ShipDockState {
  private readonly building = new Map<string, ShipConstructionDraftState>();

  public constructor(saved: readonly ShipConstructionDraftState[] = []) {
    for (const draft of saved) this.building.set(draft.dockId, this.copy(draft));
  }

  public status(assembly: ShipAssembly, moduleId: string): ShipDockStatus {
    if (assembly.isDockingPortOccupied(moduleId)) return 'connected';
    return this.building.has(moduleId) ? 'building' : 'empty';
  }

  public beginBuilding(assembly: ShipAssembly, moduleId: string): void {
    const module = assembly.module(moduleId);
    if (module === null || (module.kind !== 'dock' && module.kind !== 'docking_port')) {
      throw new Error(`not a docking module: ${moduleId}`);
    }
    if (module.hp <= 0) throw new Error(`docking module is destroyed: ${moduleId}`);
    if (this.status(assembly, moduleId) !== 'empty') throw new Error(`docking module is not empty: ${moduleId}`);
    this.building.set(moduleId, {
      dockId: moduleId, addedIds: [], axialTailId: moduleId, firstConnectionId: null,
    });
  }

  public finishBuilding(moduleId: string): void { this.building.delete(moduleId); }

  public constructionDraft(moduleId: string): ShipConstructionDraftState | null {
    const draft = this.building.get(moduleId);
    return draft === undefined ? null : this.copy(draft);
  }

  public updateConstructionDraft(draft: ShipConstructionDraftState): void {
    if (!this.building.has(draft.dockId)) throw new Error(`docking module is not building: ${draft.dockId}`);
    this.building.set(draft.dockId, this.copy(draft));
  }

  public serialize(): readonly ShipConstructionDraftState[] {
    return [...this.building.values()].map(draft => this.copy(draft));
  }

  private copy(draft: ShipConstructionDraftState): ShipConstructionDraftState {
    return { ...draft, addedIds: [...draft.addedIds] };
  }
}

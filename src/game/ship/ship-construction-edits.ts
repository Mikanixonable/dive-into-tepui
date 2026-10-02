// 建造予約と船体の構造編集を一体で適用し、編集後の物性を同期する。
import { createShipModuleInstance } from './ship-module-instance';
import { enumerateConstructionSlots, placementForSlot } from './ship-construction-rules';
import { SHIP_MODULE_CATALOG } from './ship-module-catalog';
import type { ShipAssembly } from './ship-assembly';
import type { ShipDockState, ShipConstructionDraftState } from './ship-dock-state';

export interface ConstructionShip {
  readonly assembly: ShipAssembly;
  readonly docks: ShipDockState;
  readonly capabilities: { readonly controllable: boolean };
  readonly motion: { readonly alive: boolean };
  synchronizeAssemblyState(): void;
}

export class ShipConstructionEdits {
  public constructor(private readonly ship: ConstructionShip, private readonly dockId: string) {}

  public get draft(): ShipConstructionDraftState | null { return this.ship.docks.constructionDraft(this.dockId); }

  // 健全で空いた建造ドックの予約を開始する。既存の予約なら続行する。
  public begin(): void {
    this.validateDock();
    if (!this.ship.capabilities.controllable) throw new Error('健全なコックピットから操作できる船体が必要です');
    if (this.draft === null) this.ship.docks.beginBuilding(this.ship.assembly, this.dockId);
  }

  // 現在の予約でスロットを再検証し、部品と接続・予約・物性をまとめて更新する。
  public place(definitionId: string, slotId: string, moduleId: string): void {
    const draft = this.requireDraft();
    const { assembly } = this.ship;
    const definition = SHIP_MODULE_CATALOG.require(definitionId);
    const slot = enumerateConstructionSlots(
      assembly, [this.dockId, ...draft.addedIds], draft.axialTailId,
    ).find(candidate => candidate.id === slotId);
    if (slot === undefined) throw new Error('配置候補が存在しません');
    const placement = placementForSlot(assembly, slot, definition);
    if (!placement.valid) throw new Error(placement.reason ?? '配置できません');

    // 予約に記録する接続は、追加した部品へ向かうものを使う。
    assembly.addModule(createShipModuleInstance(definition, moduleId),
      placement.parentId, placement.transform, placement.kind);
    const connection = assembly.graph.find(edge => edge.childId === moduleId);
    if (connection === undefined) throw new Error(`construction connection missing: ${moduleId}`);
    this.ship.docks.updateConstructionDraft({
      dockId: this.dockId, addedIds: [...draft.addedIds, moduleId],
      axialTailId: placement.kind === 'axial' ? moduleId : draft.axialTailId,
      firstConnectionId: draft.firstConnectionId ?? connection.id,
    });
    this.ship.synchronizeAssemblyState();
  }

  // 最後に追加した部品を撤去し、残る枝の末尾と接続根を更新する。
  public removeLast(): void {
    const draft = this.requireDraft();
    const id = draft.addedIds.at(-1);
    if (id === undefined) return;
    const { assembly } = this.ship;
    assembly.removeModule(id);
    const addedIds = draft.addedIds.slice(0, -1);
    const axial = [...addedIds].reverse().find(moduleId => (
      assembly.graph.some(edge => edge.childId === moduleId && edge.kind === 'axial')
    ));

    // 側面部品が最後に残っても、軸候補は最後の軸接続へ戻す。
    this.ship.docks.updateConstructionDraft({
      dockId: this.dockId, addedIds, axialTailId: axial ?? this.dockId,
      firstConnectionId: addedIds.length === 0
        ? null : assembly.graph.find(edge => edge.childId === addedIds[0])?.id ?? null,
    });
    this.ship.synchronizeAssemblyState();
  }

  // 追加枝の根を完成済み接続へ変え、予約を終了する。
  public finish(): void {
    const draft = this.requireDraft();
    if (draft.firstConnectionId === null) throw new Error('部品を1個以上配置してください');
    this.ship.assembly.completeConstructionConnection(draft.firstConnectionId);
    this.ship.docks.finishBuilding(this.dockId);
    this.ship.synchronizeAssemblyState();
  }

  // 追加した部品を逆順に撤去し、予約を終了する。
  public discard(): void {
    const draft = this.requireDraft();
    for (const id of [...draft.addedIds].reverse()) this.ship.assembly.removeModule(id);
    this.ship.docks.finishBuilding(this.dockId);
    this.ship.synchronizeAssemblyState();
  }

  // 操作時点で予約とドックが有効なら、予約の読み取り面を返す。
  private requireDraft(): ShipConstructionDraftState {
    this.validateDock();
    const draft = this.draft;
    if (draft === null) throw new Error('建造予約が存在しません');
    return draft;
  }

  // 失われた船体・接舷済み・破壊済みのドックへの編集を拒否する。
  private validateDock(): void {
    const module = this.ship.assembly.module(this.dockId);
    if (!this.ship.motion.alive) throw new Error('対象船体が存在しません');
    if (module?.kind !== 'dock') throw new Error(`not a construction dock: ${this.dockId}`);
    if (module.hp <= 0 || this.ship.assembly.isPortConnected(this.dockId)) {
      throw new Error('空いている健全な接舷部が必要です');
    }
  }
}

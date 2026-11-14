// 建造予約と船体の構造編集を一体で適用し、編集後の物性を同期する。
// 経済が渡された場合(ストーリーモード)は、配置がその船体の拠点備蓄から素材を
// 支払い、取り外しと破棄が返金する(GAME.md 11.4)。渡されなければ無償である。
// 規模ゲートが渡された場合は、配置のたびに完成見込みの枝の総質量を設備の上限と
// 照らす(GAME.md 11.2)。
import { createShipModuleInstance } from './ship-module-instance';
import { enumerateConstructionSlots, placementForSlot } from './ship-construction-rules';
import { SHIP_MODULE_CATALOG } from './ship-module-catalog';
import { moduleMaterialsCost, type StoryEconomy } from '../campaign/story-economy';
import {
  constructionBranchMassKg, type ConstructionScaleGate,
} from '../campaign/construction-scale-gate';
import type { ShipAssembly } from './ship-assembly';
import type { ShipDockState, ShipConstructionDraftState } from './ship-dock-state';

export interface ConstructionShip {
  readonly id: string;
  readonly assembly: ShipAssembly;
  readonly docks: ShipDockState;
  readonly capabilities: { readonly controllable: boolean };
  readonly motion: { readonly alive: boolean };
  synchronizeAssemblyState(): void;
}

export class ShipConstructionEdits {
  public constructor(
    private readonly ship: ConstructionShip,
    private readonly dockId: string,
    private readonly economy: StoryEconomy | null = null,
    private readonly scaleGate: ConstructionScaleGate | null = null,
  ) {}

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
    // 規模ゲート: 完成見込みの枝の総質量が設備の上限を超える配置は、置いた部品を
    // 戻してから拒否する(GAME.md 11.2)。
    if (this.scaleGate !== null) {
      const reason = this.scaleGate.excessReason(
        this.ship.id,
        constructionBranchMassKg(assembly, draft.firstConnectionId ?? connection.id),
      );
      if (reason !== null) {
        assembly.removeModule(moduleId);
        throw new Error(reason);
      }
    }
    // 支払えなければ、置いた部品を戻してから拒否する。支払った部品は予約に記録し、
    // 取り外しと破棄の返金をその部品だけに限る。
    let paid = false;
    if (this.economy !== null) {
      const cost = moduleMaterialsCost(definition);
      if (!this.economy.charge(this.ship.id, cost, 0)) {
        const balance = this.economy.stockpileOf(this.ship.id).materials;
        assembly.removeModule(moduleId);
        throw new Error(`素材が不足しています(必要 ${cost} / 備蓄 ${balance} — あと ${cost - balance})`);
      }
      paid = true;
    }
    this.ship.docks.updateConstructionDraft({
      dockId: this.dockId, addedIds: [...draft.addedIds, moduleId],
      axialTailId: placement.kind === 'axial' ? moduleId : draft.axialTailId,
      firstConnectionId: draft.firstConnectionId ?? connection.id,
      paidModuleIds: paid ? [...draft.paidModuleIds, moduleId] : [...draft.paidModuleIds],
    });
    this.ship.synchronizeAssemblyState();
  }

  // 最後に追加した部品を撤去し、残る枝の末尾と接続根を更新する。
  public removeLast(): void {
    const draft = this.requireDraft();
    const id = draft.addedIds.at(-1);
    if (id === undefined) return;
    const { assembly } = this.ship;
    const removedDefinitionId = assembly.module(id)?.definitionId;
    assembly.removeModule(id);
    // 支払って置いた部品だけが素材へ戻る。
    const wasPaid = draft.paidModuleIds.includes(id);
    if (this.economy !== null && wasPaid && removedDefinitionId !== undefined) {
      this.economy.refund(
        this.ship.id, moduleMaterialsCost(SHIP_MODULE_CATALOG.require(removedDefinitionId)), 0,
      );
    }
    const addedIds = draft.addedIds.slice(0, -1);
    const axial = [...addedIds].reverse().find(moduleId => (
      assembly.graph.some(edge => edge.childId === moduleId && edge.kind === 'axial')
    ));

    // 側面部品が最後に残っても、軸候補は最後の軸接続へ戻す。
    this.ship.docks.updateConstructionDraft({
      dockId: this.dockId, addedIds, axialTailId: axial ?? this.dockId,
      firstConnectionId: addedIds.length === 0
        ? null : assembly.graph.find(edge => edge.childId === addedIds[0])?.id ?? null,
      paidModuleIds: draft.paidModuleIds.filter(paidId => paidId !== id),
    });
    this.ship.synchronizeAssemblyState();
  }

  // 追加枝の根を完成済み接続へ変え、予約を終了する。経済がある場合(ストーリー
  // モード)は、完成した枝の乾燥質量の合計を建造の完了として台帳へ記録する。
  public finish(): void {
    const draft = this.requireDraft();
    if (draft.firstConnectionId === null) throw new Error('部品を1個以上配置してください');
    if (this.economy !== null) {
      let builtMassKg = 0;
      for (const moduleId of draft.addedIds) {
        const definitionId = this.ship.assembly.module(moduleId)?.definitionId;
        if (definitionId !== undefined) {
          builtMassKg += SHIP_MODULE_CATALOG.require(definitionId).dryMass;
        }
      }
      this.economy.recordConstructionCompleted(builtMassKg);
    }
    this.ship.assembly.completeConstructionConnection(draft.firstConnectionId);
    this.ship.docks.finishBuilding(this.dockId);
    this.ship.synchronizeAssemblyState();
  }

  // 追加した部品を逆順に撤去し、予約を終了する。
  public discard(): void {
    const draft = this.requireDraft();
    // 返金は支払って置いた部品だけ。開始状態からある無償の部品は素材にならない。
    const paidDefinitionIds = draft.paidModuleIds
      .map(id => this.ship.assembly.module(id)?.definitionId)
      .filter((definitionId): definitionId is string => definitionId !== undefined);
    for (const id of [...draft.addedIds].reverse()) this.ship.assembly.removeModule(id);
    if (this.economy !== null) {
      for (const definitionId of paidDefinitionIds) {
        this.economy.refund(
          this.ship.id, moduleMaterialsCost(SHIP_MODULE_CATALOG.require(definitionId)), 0,
        );
      }
    }
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

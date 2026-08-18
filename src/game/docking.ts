import * as THREE from 'three/webgpu';
import * as C from './const';
import { v3, len, sub } from '../physics/vec3';
import { kinematicState } from '../physics/kinematic-state';
import { Hud } from './hud/hud';
import { BaseView, type WorkbenchSelection } from './hud/base-view';
import { ResourceTransferDialog } from './hud/resource-transfer-dialog';
import { Vessel, type VesselDeps } from './vessel/vessel';
import { hasBaseModule } from './vessel/capabilities';
import { createBlueprint } from './vessel/blueprint';
import type { VesselAssembly } from './vessel/assembly';
import type { PartPlacement } from './vessel/assembly';
import { editSection, moveNode, movePlacement, removeEdge } from './vessel/assembly-editor';
import { validateBlueprint } from './vessel/blueprint-validation';
import { validateBaseAssembly } from './vessel/base-assembly-validation';
import { baseFacilities, basePowerAvailable } from './vessel/base-module';
import { consumeProductionResources, productionRequirements, productionBlueprintOf } from './vessel/production';
import type { GameEntity } from './game-entity/game-entity';
import type { AnyPart } from './game-entity/parts';
import type { EntityManager } from './simulation/entity-manager';
import type { MapContextActions } from './map-context-actions';
import type { CameraSystem } from './camera/camera-system';
import type { ViewManager } from './view-manager';
import type { WorldSfx } from '../audio/sfx/world-sfx';
import type { EffectsSystem } from './vfx/effects-system';
import type { MarkerManager } from './marker/marker-manager';
import type { ActiveVesselController } from './active-vessel-controller';

interface WorkbenchCheckpoint {
  readonly base: Vessel;
  readonly baseAssembly: VesselAssembly | null;
  readonly inventory: readonly AnyPart[];
  readonly targets: readonly { readonly id: string; readonly assembly: VesselAssembly }[];
}

export class Docking {
  readonly baseView: BaseView;
  readonly transferDialog: ResourceTransferDialog;
  // 選択中/ドックビューの対象基地。設定されている間だけドックビューへ遷移できる。
  private _activeBase: Vessel | null = null;

  // 船と船、船と基地の物理ドッキングペア (shipId -> targetEntity)
  private readonly dockedPairs = new Map<string, GameEntity>();

  get activeBase(): Vessel | null { return this._activeBase; }

  // 作業台でドック中の船を再構築するための依存関係。
  private readonly vesselDeps: VesselDeps;
  private readonly workbenchRaycaster = new THREE.Raycaster();
  private workbenchCheckpoint: WorkbenchCheckpoint | null = null;
  private workbenchDirty = false;
  private workbenchDraft: Vessel | null = null;

  constructor(
    private readonly pauseGame: () => void,
    private readonly resumeGame: () => void,
    private readonly hud: Hud,
    private readonly worldSfx: WorldSfx,
    scene: THREE.Scene,
    effects: EffectsSystem,
    markerManager: MarkerManager,
    private readonly entities: EntityManager,
    private readonly mapActions: MapContextActions,
    private readonly cameraSystem: CameraSystem,
    private readonly viewManager: ViewManager,
    private readonly activeVessels: ActiveVesselController,
  ) {
    this.baseView = new BaseView(this.hud.layers.view);
    this.baseView.onClose = () => this.viewManager.leaveDock();
    this.baseView.onLaunchVessel = (ship, base) => this.launch(ship, base);
    this.baseView.onWorkbenchRemove = (base, vessel, partId) => this.removeDockedPart(base, vessel, partId);
    this.baseView.onWorkbenchDrop = (base, vessel, partId, fromInventory) => {
      if (fromInventory) this.installDockedPart(base, vessel, partId);
      else this.moveDockedPart(base, vessel, partId);
    };
    this.baseView.onWorkbenchPointer = (_base, vessel, clientX, clientY) => {
      return this.pickWorkbenchObject(vessel, clientX, clientY);
    };
    this.baseView.onWorkbenchNodeMove = (base, vessel, nodeId, dx, dy, dz) => {
      this.moveWorkbenchNode(base, vessel, nodeId, dx, dy, dz);
    };
    this.baseView.onWorkbenchSectionScale = (base, vessel, nodeId, factor) => {
      this.scaleWorkbenchSection(base, vessel, nodeId, factor);
    };
    this.baseView.onWorkbenchEdgeRemove = (base, vessel, edgeId) => {
      this.removeWorkbenchEdge(base, vessel, edgeId);
    };
    this.baseView.onWorkbenchCommit = () => this.commitWorkbench();
    this.baseView.onWorkbenchNewDraft = (base) => this.createWorkbenchDraft(base);
    this.baseView.onWorkbenchBuildDraft = (base, vessel) => this.buildWorkbenchDraft(base, vessel);
    this.baseView.onWorkbenchCancel = () => {
      const base = this.workbenchCheckpoint?.base ?? this._activeBase;
      this.cancelWorkbench();
      const vessel = base?.baseState?.dockedVessels[0]?.vessel ?? null;
      if (base?.alive) {
        this.startWorkbench(base);
        this.baseView.openWorkbench(base, vessel);
      }
    };
    this.baseView.onWorkbenchTransfer = (base, from, to, partId) => {
      this.transferDockedPart(base, from, to, partId);
    };
    this.viewManager.setDocking(this);

    this.transferDialog = new ResourceTransferDialog(this.hud.layers.view, this.hud.overlayManager);
    this.vesselDeps = { hud, worldSfx, scene, fx: effects, markerManager };
  }

  // 生存中の全基地を返す。
  getAvailableBases(): readonly Vessel[] {
    return this.entities.baseVessels().filter((b) => b.alive);
  }

  // 指定艦がドッキングしている対象を取得。ドッキングしていなければ null。
  getDockedTarget(ship: Vessel): GameEntity | null {
    const target = this.dockedPairs.get(ship.id);
    if (!target || !target.alive) {
      if (target) this.dockedPairs.delete(ship.id);
      return null;
    }
    return target;
  }

  // ドッキング可能判定 (距離・ドックスロット前方正面判定・相対速度)
  canDock(ship: Vessel, target: GameEntity): boolean {
    if (!ship.alive || !target.alive || ship === target) return false;
    if (this.getDockedTarget(ship) === target) return false;
    const relSpeed = len(sub(ship.state.v, target.state.v));
    if (relSpeed > C.DOCK_CAPTURE_REL_V) return false;

    // 基地モジュールを積んだ相手は、そのモジュールが定める口と閾値で受け入れを判定する。
    if (target instanceof Vessel && hasBaseModule(target)) return target.canCapture(ship);

    // 船対船のドッキングは距離だけで判定する
    const dist = len(sub(ship.state.r, target.state.r));
    return dist <= C.DOCK_CAPTURE_DIST;
  }

  // 船または基地への物理ドッキングを実行。
  dockTo(ship: Vessel, target: GameEntity): void {
    if (!ship.alive || !target.alive) return;
    if (target instanceof Vessel && hasBaseModule(target)) {
      this.storeInBase(ship, target);
    } else {
      this.dockedPairs.set(ship.id, target);
      // 相対速度をゼロにする
      ship.state = kinematicState(ship.state.t, ship.state.r, target.state.v);
      this.hud.hint(`${ship.name} が ${target.name || '対象'} にドッキングしました`);
    }
  }

  // ドッキング解除
  undock(ship: Vessel): void {
    const target = this.dockedPairs.get(ship.id);
    if (target) {
      this.dockedPairs.delete(ship.id);
      this.hud.hint(`${ship.name} のドッキングを解除しました`);
    }
  }

  // ドッキング中の相手との物資・電力融通ダイアログを開く
  openTransfer(ship: Vessel, target: GameEntity): void {
    this.transferDialog.open(ship, target);
  }

  // 基地を選択状態にする
  selectBase(base: Vessel): void {
    this._activeBase = base;
  }

  // 基地を選択し、ドックビューへ遷移する
  activate(base: Vessel): void {
    const isSameBase = this._activeBase === base;
    this.selectBase(base);
    if (this.viewManager.current === 'dock') {
      if (!isSameBase) this.enterDock();
    } else {
      this.viewManager.setView('dock');
    }
  }

  canEnterDock(): boolean {
    return this.getAvailableBases().length > 0;
  }

  /**
   * Atomically replaces one docked vessel with the validated assembly produced by
   * the workbench. The old vessel is kept untouched until validation succeeds.
   */
  commitDockedAssembly(base: Vessel, vesselId: string, assembly: VesselAssembly, track = true): { ok: true; vessel: Vessel } | { ok: false; reason: string } {
    const state = base.baseState;
    if (!state) return { ok: false, reason: '基地ではありません' };
    const index = state.dockedVessels.findIndex((entry) => entry.id === vesselId);
    if (index < 0) return { ok: false, reason: '対象艦がドックにありません' };
    const previous = state.dockedVessels[index]!.vessel;
    const blueprint = createBlueprint({
      id: `${previous.id}-dock-edit`, name: previous.name, tree: assembly.tree,
      placements: assembly.placements, now: Date.now(),
    });
    const issue = validateBlueprint(blueprint).find((candidate) => candidate.severity === 'error');
    if (issue) return { ok: false, reason: issue.message };

    const replacement = new Vessel({
      blueprintShip: { blueprint, state: previous.state, name: previous.name, id: previous.id },
    }, this.vesselDeps);
    const slotIndex = state.dockedVessels[index]!.slotIndex;
    base.detachDockedVesselMesh(previous);
    state.dockedVessels.splice(index, 1, {
      id: replacement.id, name: replacement.name, hp: replacement.hp, maxHp: replacement.maxHp,
      parts: replacement.parts, vessel: replacement, slotIndex,
    });
    base.attachDockedVesselMesh(replacement, slotIndex);
    previous.dispose();
    if (track) this.workbenchDirty = true;
    return { ok: true, vessel: replacement };
  }

  /** Apply an edited base assembly while preserving the live base and its docked vessels. */
  commitBaseAssembly(base: Vessel, assembly: VesselAssembly, track = true): { ok: true } | { ok: false; reason: string } {
    if (!base.baseState) return { ok: false, reason: '基地ではありません' };
    const validation = validateBaseAssembly(assembly, base.baseState.dockedVessels.length);
    if (validation.length > 0) return { ok: false, reason: validation[0]! };

    const previousModule = base.parts.find((part) => part.type === 'base_module' && part.hp > 0);
    const nextModule = assembly.placements.map((placement) => placement.part)
      .find((part) => part.type === 'base_module' && part.hp > 0);
    if (!previousModule || !nextModule || previousModule.type !== 'base_module' || nextModule.type !== 'base_module') {
      return { ok: false, reason: '基地モジュールを維持してください' };
    }
    for (const entry of base.baseState.dockedVessels) {
      if (!sameDockPort(previousModule.dockSlots[entry.slotIndex], nextModule.dockSlots[entry.slotIndex])) {
        return { ok: false, reason: `ドック ${entry.slotIndex + 1} は船が収容中のため変更できません` };
      }
    }
    const result = base.replaceAssembly(assembly);
    if (!result.ok) return result;
    if (track) this.workbenchDirty = true;
    return { ok: true };
  }

  clearActiveBaseIf(base: Vessel): void {
    if (this._activeBase !== base) return;
    this._activeBase = null;
    this.viewManager.leaveDock();
  }

  enterDock(): void {
    if (!this._activeBase || !this._activeBase.alive) {
      const available = this.getAvailableBases();
      if (available.length === 0) return;
      this._activeBase = available[0]!;
    }
    this.pauseGame();
    this.startWorkbench(this._activeBase);
    this.baseView.open(this._activeBase, this.activeVessels.current);
  }

  leaveDock(): void {
    this.cancelWorkbench();
    this.baseView.close();
    this.resumeGame();
  }

  private startWorkbench(base: Vessel): void {
    if (this.workbenchCheckpoint?.base === base) return;
    this.cancelWorkbench();
    this.workbenchCheckpoint = {
      base,
      baseAssembly: base.assembly,
      inventory: [...(base.baseState?.inventory ?? [])],
      targets: (base.baseState?.dockedVessels ?? []).flatMap((entry) =>
        entry.vessel.assembly ? [{ id: entry.id, assembly: entry.vessel.assembly }] : []),
    };
    this.workbenchDirty = false;
  }

  private commitWorkbench(): void {
    const base = this._activeBase;
    this.workbenchCheckpoint = null;
    this.workbenchDirty = false;
    if (base?.alive) this.startWorkbench(base);
    this.hud.hint('ドックの変更を確定しました');
  }

  private cancelWorkbench(): void {
    const checkpoint = this.workbenchCheckpoint;
    if (!checkpoint) return;
    if (this.workbenchDirty && checkpoint.base.baseState) {
      if (checkpoint.baseAssembly) {
        const restoredBase = this.commitBaseAssembly(checkpoint.base, checkpoint.baseAssembly, false);
        if (!restoredBase.ok) this.hud.hint(`基地の変更を戻せません: ${restoredBase.reason}`);
      }
      for (const target of checkpoint.targets) {
        const current = checkpoint.base.baseState.dockedVessels.find((entry) => entry.id === target.id);
        if (!current) continue;
        const result = this.commitDockedAssembly(checkpoint.base, target.id, target.assembly, false);
        if (!result.ok) this.hud.hint(`変更を戻せません: ${result.reason}`);
      }
      checkpoint.base.baseState.inventory.splice(0, checkpoint.base.baseState.inventory.length, ...checkpoint.inventory);
    }
    this.workbenchCheckpoint = null;
    this.workbenchDirty = false;
    if (this.workbenchDraft) {
      this.workbenchDraft.dispose();
      this.workbenchDraft = null;
    }
  }

  private createWorkbenchDraft(base: Vessel): void {
    if (this.workbenchDraft) {
      this.baseView.openWorkbench(base, this.workbenchDraft);
      return;
    }
    const draft = new Vessel({
      crewedShip: {
        name: '新規船下書き',
        state: kinematicState(base.state.t, base.state.r, base.state.v),
        id: `${base.id}-draft-${Date.now()}`,
      },
    }, this.vesselDeps);
    draft.renderObject.visible = false;
    this.workbenchDraft = draft;
    this.workbenchDirty = true;
    this.baseView.openWorkbench(base, draft);
    this.hud.hint('新規船の下書きを作成しました。編集後に建造を確定してください');
  }

  private buildWorkbenchDraft(base: Vessel, draft: Vessel): void {
    if (!this.workbenchDraft || draft !== this.workbenchDraft || !draft.assembly || !base.baseState) {
      this.hud.hint('建造を確定できる新規船下書きが選択されていません');
      return;
    }
    const blueprint = createBlueprint({
      id: `${draft.id}-build`, name: draft.name, tree: draft.assembly.tree,
      placements: draft.assembly.placements, now: Date.now(),
    });
    const slotIndex = base.getAvailableSlotIndex();
    if (slotIndex === null) {
      this.hud.hint('空きドックがありません');
      return;
    }
    const requirements = productionRequirements(
      blueprint, base.baseState.resources, baseFacilities(base), basePowerAvailable(base),
    );
    if (requirements.length > 0) {
      const requirement = requirements[0]!;
      this.hud.hint(`建造できません: ${requirement.kind} ${requirement.id} が不足しています`);
      return;
    }
    if (!consumeProductionResources(productionBlueprintOf(blueprint), base.baseState.resources)) {
      this.hud.hint('建造資源が不足しています');
      return;
    }
    const built = new Vessel({
      blueprintShip: {
        blueprint, state: kinematicState(base.state.t, base.state.r, base.state.v),
        name: draft.name, id: `${base.id}-built-${Date.now()}`,
      },
    }, this.vesselDeps);
    built.renderObject.visible = true;
    base.baseState.dockedVessels.push({
      id: built.id, name: built.name, hp: built.hp, maxHp: built.maxHp,
      parts: built.parts, vessel: built, slotIndex,
    });
    base.attachDockedVesselMesh(built, slotIndex);
    draft.dispose();
    this.workbenchDraft = null;
    this.workbenchDirty = true;
    this.baseView.openWorkbench(base, built);
    this.hud.hint(`${built.name} をドック ${slotIndex + 1} に建造しました`);
  }

  // ドッキング中の運動状態を同期 (毎フレーム call)
  updateDockedPhysics(): void {
    for (const [shipId, target] of [...this.dockedPairs.entries()]) {
      const ship = this.entities.findOwnShip(shipId);
      if (!ship || !ship.alive || !target.alive) {
        this.dockedPairs.delete(shipId);
        continue;
      }
      // 速度を完全同期
      ship.state = kinematicState(ship.state.t, ship.state.r, target.state.v);
    }
  }

  // 近接判定。自動収容は行わず、死んだペアの掃除と状況維持を行う。
  checkProximity(): void {
    if (this.viewManager.current === 'dock') return;
    this.updateDockedPhysics();
  }

  // 手動で艦を基地へ収容する
  storeInBase(ship: Vessel, base: Vessel): void {
    if (base.baseState!.dockedVessels.length >= base.dockCapacity) {
      this.hud.hint(`基地のドックが満杯です (最大 ${base.dockCapacity} 隻)`);
      return;
    }
    const slotIndex = base.getAvailableSlotIndex() ?? 0;
    this.undock(ship);
    base.baseState!.dockedVessels.push({
      id: ship.id,
      name: ship.name,
      hp: ship.hp,
      maxHp: ship.maxHp,
      parts: ship.parts,
      vessel: ship,
      slotIndex,
    });
    base.attachDockedVesselMesh(ship, slotIndex);

    const wasActive = this.activeVessels.current === ship;
    this.mapActions.close();
    this.cameraSystem.mapCamera.clearFocusIf(ship.id);
    if (wasActive) {
      ship.clearTransientCommands();
      this.worldSfx.setThrust(false);
      this.worldSfx.setRcs(false);
    }
    this.entities.parkVessel(ship);
    if (wasActive) {
      this.activeVessels.setOrNull(this.entities.ownShips().find((p) => p.alive) ?? null);
      if (this.activeVessels.current === null) this.viewManager.setView('map');
    }
    this.hud.hint(`${ship.name} を基地のドック ${slotIndex + 1} に収納しました`);
  }

  private removeDockedPart(base: Vessel, vessel: Vessel, partId: string): void {
    if (!vessel.assembly) return;
    const removed = vessel.parts.find((part) => part.id === partId);
    if (!removed) return;
    const placements = vessel.assembly.placements.filter((placement) => placement.part.id !== partId);
    if (placements.length === vessel.assembly.placements.length) return;
    if (vessel === base) {
      const validation = validateBaseAssembly({ tree: vessel.assembly.tree, placements }, base.baseState?.dockedVessels.length ?? 0);
      if (validation.length > 0) {
        this.hud.hint(`取り外せません: ${validation[0]}`);
        return;
      }
      const result = this.commitBaseAssembly(base, { tree: vessel.assembly.tree, placements });
      if (!result.ok) {
        this.hud.hint(`取り外せません: ${result.reason}`);
        return;
      }
      base.baseState!.inventory.push(removed);
      this.baseView.openWorkbench(base, base);
      this.hud.hint('基地部品を倉庫へ移しました');
      return;
    }
    const result = this.commitDockedAssembly(base, vessel.id, { tree: vessel.assembly.tree, placements });
    if (!result.ok) {
      this.hud.hint(`取り外せません: ${result.reason}`);
      return;
    }
    base.baseState!.inventory.push(removed);
    this.baseView.openWorkbench(base, result.vessel);
    this.hud.hint('部品を基地倉庫へ移しました');
  }

  private transferDockedPart(base: Vessel, from: Vessel, to: Vessel, partId: string): void {
    if (!from.assembly || !to.assembly || from === to) return;
    const sourcePlacement = from.assembly.placements.find((placement) => placement.part.id === partId);
    if (!sourcePlacement) return;
    const sourceAssembly = {
      tree: from.assembly.tree,
      placements: from.assembly.placements.filter((placement) => placement.part.id !== partId),
    };
    const destinationAssembly = {
      tree: to.assembly.tree,
      placements: [...to.assembly.placements, sourcePlacement],
    };
    const sourceError = assemblyError(sourceAssembly, from.name);
    const destinationError = assemblyError(destinationAssembly, to.name);
    if (sourceError || destinationError) {
      this.hud.hint(sourceError ?? destinationError ?? '移送先の検証に失敗しました');
      return;
    }
    const destinationResult = this.commitDockedAssembly(base, to.id, destinationAssembly);
    if (!destinationResult.ok) {
      this.hud.hint(`移送先を更新できません: ${destinationResult.reason}`);
      return;
    }
    const sourceResult = this.commitDockedAssembly(base, from.id, sourceAssembly);
    if (!sourceResult.ok) {
      // 予期しないランタイム失敗でも、先に更新した移送先を元へ戻す。
      this.commitDockedAssembly(base, to.id, to.assembly, false);
      this.hud.hint(`移送元を更新できません: ${sourceResult.reason}`);
      return;
    }
    this.baseView.openWorkbench(base, sourceResult.vessel);
    this.hud.hint(`${sourcePlacement.part.name} を ${to.name} へ移送しました`);
  }

  private installDockedPart(base: Vessel, vessel: Vessel, partId: string): void {
    if (!vessel.assembly || !base.baseState) return;
    const inventoryIndex = base.baseState.inventory.findIndex((part) => part.id === partId);
    if (inventoryIndex < 0) return;
    const part = base.baseState.inventory[inventoryIndex]!;
    const placement = defaultDockPlacement(vessel.assembly, part);
    if (!placement) {
      this.hud.hint('この部品を置ける接続点がありません');
      return;
    }
    const candidate = {
      tree: vessel.assembly.tree, placements: [...vessel.assembly.placements, placement],
    };
    if (vessel === base) {
      const result = this.commitBaseAssembly(base, candidate);
      if (!result.ok) {
        this.hud.hint(`取り付けられません: ${result.reason}`);
        return;
      }
      base.baseState.inventory.splice(inventoryIndex, 1);
      this.baseView.openWorkbench(base, base);
      this.hud.hint('部品を基地の作業台へ取り付けました');
      return;
    }
    const result = this.commitDockedAssembly(base, vessel.id, candidate);
    if (!result.ok) {
      this.hud.hint(`取り付けられません: ${result.reason}`);
      return;
    }
    base.baseState.inventory.splice(inventoryIndex, 1);
    this.baseView.openWorkbench(base, result.vessel);
    this.hud.hint('部品をドック作業台へ取り付けました');
  }

  private moveDockedPart(base: Vessel, vessel: Vessel, partId: string): void {
    if (!vessel.assembly) return;
    const current = vessel.assembly.placements.find((placement) => placement.part.id === partId);
    if (!current || current.kind !== 'external') {
      this.hud.hint('内装部品は3D外表面へ移動できません');
      return;
    }
    const mount = defaultDockPlacement(vessel.assembly, current.part);
    if (!mount || mount.kind !== 'external') {
      this.hud.hint('この部品を置ける接続点がありません');
      return;
    }
    const result = movePlacement(vessel.assembly, { placementId: partId, mount: mount.mount }, { validateBlueprint: false });
    if (!result.accepted) {
      this.hud.hint(`部品を移動できません: ${result.errors[0]?.message ?? '検証失敗'}`);
      return;
    }
    if (vessel === base) {
      const applied = this.commitBaseAssembly(base, result.assembly);
      if (!applied.ok) this.hud.hint(`基地部品を移動できません: ${applied.reason}`);
      else this.baseView.openWorkbench(base, base);
      return;
    }
    const applied = this.commitDockedAssembly(base, vessel.id, result.assembly);
    if (!applied.ok) this.hud.hint(`部品を移動できません: ${applied.reason}`);
    else this.baseView.openWorkbench(base, applied.vessel);
  }

  private pickWorkbenchObject(vessel: Vessel, clientX: number, clientY: number): WorkbenchSelection | null {
    const width = Math.max(1, document.documentElement.clientWidth);
    const height = Math.max(1, document.documentElement.clientHeight);
    this.workbenchRaycaster.setFromCamera(
      new THREE.Vector2((clientX / width) * 2 - 1, -(clientY / height) * 2 + 1),
      this.cameraSystem.activeCamera,
    );
    const hit = this.workbenchRaycaster.intersectObjects(vessel.renderObject.children, true)[0];
    let object: THREE.Object3D | null = hit?.object ?? null;
    while (object) {
      const partRef = object.userData['partVisualRef']?.partId as string | undefined;
      if (partRef) {
        const part = vessel.parts.find((candidate) => candidate.id === partRef);
        this.hud.hint(part ? `選択: ${part.name} (${part.type})` : `選択: ${partRef}`);
        return { kind: 'part', id: partRef };
      }
      const edgeId = object.userData['assemblyEdgeId'] as string | undefined;
      if (edgeId) {
        this.hud.hint(`エッジ ${edgeId} · ${object.userData['edgeKind'] ?? 'hull'}`);
        return { kind: 'edge', id: edgeId };
      }
      const nodeId = object.userData['assemblyNodeId'] as string | undefined;
      if (nodeId) {
        this.hud.hint(`ノード ${nodeId}`);
        return { kind: 'node', id: nodeId };
      }
      object = object.parent;
    }
    return null;
  }

  private moveWorkbenchNode(base: Vessel, vessel: Vessel, nodeId: string, dx: number, dy: number, dz: number): void {
    if (!vessel.assembly) return;
    const node = vessel.assembly.tree.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const result = moveNode(vessel.assembly, {
      nodeId,
      pos: v3(node.pos.x + dx, node.pos.y + dy, node.pos.z + dz),
    }, { validateBlueprint: false });
    if (!result.accepted) {
      this.hud.hint(`ノードを移動できません: ${result.errors[0]?.message ?? '検証失敗'}`);
      return;
    }
    if (vessel === base) {
      const applied = this.commitBaseAssembly(base, result.assembly);
      if (!applied.ok) this.hud.hint(`基地形状を更新できません: ${applied.reason}`);
      else this.baseView.openWorkbench(base, base);
      return;
    }
    const applied = this.commitDockedAssembly(base, vessel.id, result.assembly);
    if (!applied.ok) this.hud.hint(`船体形状を更新できません: ${applied.reason}`);
    else this.baseView.openWorkbench(base, applied.vessel);
  }

  private removeWorkbenchEdge(base: Vessel, vessel: Vessel, edgeId: string): void {
    if (!vessel.assembly) return;
    const result = removeEdge(vessel.assembly, edgeId, { validateBlueprint: false });
    if (!result.accepted) {
      this.hud.hint(`エッジを削除できません: ${result.errors[0]?.message ?? '検証失敗'}`);
      return;
    }
    if (vessel === base) {
      const applied = this.commitBaseAssembly(base, result.assembly);
      if (!applied.ok) this.hud.hint(`基地形状を更新できません: ${applied.reason}`);
      else this.baseView.openWorkbench(base, base);
      return;
    }
    const applied = this.commitDockedAssembly(base, vessel.id, result.assembly);
    if (!applied.ok) this.hud.hint(`エッジを削除できません: ${applied.reason}`);
    else this.baseView.openWorkbench(base, applied.vessel);
  }

  private scaleWorkbenchSection(base: Vessel, vessel: Vessel, nodeId: string, factor: number): void {
    const node = vessel.assembly?.tree.nodes.find((candidate) => candidate.id === nodeId);
    const primitive = node?.section.primitives[0];
    if (!node || !primitive) return;
    const shape = primitive.shape;
    const scaled = shape.kind === 'circle'
      ? { ...shape, radius: shape.radius * factor }
      : shape.kind === 'ellipse'
        ? { ...shape, majorRadius: shape.majorRadius * factor, minorRadius: shape.minorRadius * factor }
        : { ...shape, radius: shape.radius * factor };
    if (!(scaled.radius === undefined || scaled.radius > 0)
      || ('majorRadius' in scaled && !(scaled.majorRadius > 0))
      || ('minorRadius' in scaled && !(scaled.minorRadius > 0))) return;
    const result = editSection(vessel.assembly!, {
      kind: 'update-primitive', nodeId, primitiveId: primitive.id, patch: { shape: scaled },
    }, { validateBlueprint: false });
    if (!result.accepted) {
      this.hud.hint(`断面を変更できません: ${result.errors[0]?.message ?? '検証失敗'}`);
      return;
    }
    if (vessel === base) {
      const applied = this.commitBaseAssembly(base, result.assembly);
      if (!applied.ok) this.hud.hint(`基地外皮を更新できません: ${applied.reason}`);
      else this.baseView.openWorkbench(base, base);
      return;
    }
    const applied = this.commitDockedAssembly(base, vessel.id, result.assembly);
    if (!applied.ok) this.hud.hint(`外皮を更新できません: ${applied.reason}`);
    else this.baseView.openWorkbench(base, applied.vessel);
  }

  private launch(ship: Vessel, base: Vessel): void {
    if (this.workbenchDirty) {
      this.hud.hint('作業台の変更を先に確定または取消してください');
      return;
    }
    const idx = base.baseState!.dockedVessels.findIndex((s) => s.vessel === ship || s.id === ship.id);
    const slotIndex = idx >= 0 ? base.baseState!.dockedVessels[idx]!.slotIndex : 0;

    if (idx >= 0) {
      base.baseState!.dockedVessels.splice(idx, 1);
    }
    base.detachDockedVesselMesh(ship);

    // ドックスロットの位置・法線からワールド座標・分離速度を算出
    const slotPos = base.getSlotWorldPos(slotIndex);
    const slotNormal = base.getSlotWorldNormal(slotIndex);

    const launchPos = v3(
      slotPos.x + slotNormal.x * 15,
      slotPos.y + slotNormal.y * 15,
      slotPos.z + slotNormal.z * 15,
    );
    const launchVel = v3(
      base.state.v.x + slotNormal.x * 2.5,
      base.state.v.y + slotNormal.y * 2.5,
      base.state.v.z + slotNormal.z * 2.5,
    );

    ship.state = kinematicState(base.state.t, launchPos, launchVel);
    this.entities.addVessel(ship);
    this.activeVessels.set(ship);
    this.viewManager.setView('combat');
    this.hud.hint(`${ship.name} がドック ${slotIndex + 1} から切り離され発進しました`);
  }

  // 基地ビューの DOM を片付ける。
  dispose(): void {
    this.baseView.dispose();
  }
}

function sameDockPort(a: { localPos: { x: number; y: number; z: number }; localNormal: { x: number; y: number; z: number } } | undefined,
  b: { localPos: { x: number; y: number; z: number }; localNormal: { x: number; y: number; z: number } } | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a.localPos.x - b.localPos.x) < 1e-9
    && Math.abs(a.localPos.y - b.localPos.y) < 1e-9
    && Math.abs(a.localPos.z - b.localPos.z) < 1e-9
    && Math.abs(a.localNormal.x - b.localNormal.x) < 1e-9
    && Math.abs(a.localNormal.y - b.localNormal.y) < 1e-9
    && Math.abs(a.localNormal.z - b.localNormal.z) < 1e-9;
}

const EXTERNAL_PART_TYPES = new Set([
  'weapon', 'engine', 'rcs_thruster', 'solar_panel', 'radiator', 'combat_shield',
  'heat_shield', 'communication', 'robot_arm', 'docking_port', 'container_coupling',
]);

function assemblyError(assembly: VesselAssembly, name: string): string | null {
  const blueprint = createBlueprint({
    id: `dock-preview-${name}`, name, tree: assembly.tree, placements: assembly.placements, now: 0,
  });
  return validateBlueprint(blueprint).find((issue) => issue.severity === 'error')?.message ?? null;
}

function defaultDockPlacement(assembly: VesselAssembly, part: AnyPart): PartPlacement | null {
  const edge = assembly.tree.edges.find((candidate) => candidate.kind.kind === 'hull') ?? assembly.tree.edges[0];
  if (!edge) return null;
  if (!EXTERNAL_PART_TYPES.has(part.type)) return { kind: 'internal', part, edgeIds: [edge.id] };
  if (part.type === 'engine' && edge.portA.kind === 'axial') {
    return { kind: 'external', part, mount: { kind: 'port', nodeId: edge.a, port: edge.portA } };
  }
  if (edge.kind.kind !== 'hull') return null;
  return { kind: 'external', part, mount: { kind: 'surface', edgeId: edge.id, along: edge.length / 2, around: 0 } };
}

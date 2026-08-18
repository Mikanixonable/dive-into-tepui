import * as THREE from 'three/webgpu';
import * as C from './const';
import { v3, len, sub } from '../physics/vec3';
import { kinematicState } from '../physics/kinematic-state';
import { Hud } from './hud/hud';
import { BaseView, type WorkbenchSelectionInfo, type WorkbenchTargetView } from './hud/base-view';
import { ResourceTransferDialog } from './hud/resource-transfer-dialog';
import { Vessel, type VesselDeps } from './vessel/vessel';
import { hasBaseModule } from './vessel/capabilities';
import { createBlueprint } from './vessel/blueprint';
import type { VesselAssembly } from './vessel/assembly';
import type { PartPlacement } from './vessel/assembly';
import { validateBlueprint } from './vessel/blueprint-validation';
import {
  addEdge, addNode, editSection, moveNode, removeEdge, removeNode, removePlacement,
  movePlacement,
  type EdgeDraft,
} from './vessel/assembly-editor';
import { AssemblyRenderObject } from './vessel/assembly-render-object';
import { crewedAssembly } from './vessel/vessel-assemblies';
import { productionBlueprintOf, consumeProductionResources } from './vessel/production';
import { producibility } from './economy/producibility';
import { baseFacilities, basePowerAvailable, deriveBaseDockingPorts } from './vessel/base-module';
import { validateBaseAssembly } from './vessel/base-assembly-validation';
import type { MountPoint, PortRef, TreeNode } from './vessel/tree';
import { add as addVec, scale as scaleVec } from '../physics/vec3';
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

interface DraftEntry {
  readonly id: string;
  name: string;
  assembly: VesselAssembly;
  render: AssemblyRenderObject;
  readonly ownedPartIds: Set<string>;
}

interface WorkbenchCheckpoint {
  base: Vessel;
  readonly baseAssembly: VesselAssembly;
  readonly inventory: readonly AnyPart[];
  readonly targets: readonly { readonly id: string; readonly assembly: VesselAssembly }[];
  readonly drafts: readonly { readonly id: string; readonly name: string; readonly assembly: VesselAssembly; readonly ownedPartIds: readonly string[] }[];
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
  private readonly drafts = new Map<string, DraftEntry>();
  private selectedWorkbenchTargetId: string | null = null;
  private readonly selectedMounts = new Map<string, MountPoint>();
  private draftSequence = 0;

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
    this.baseView.onWorkbenchRemove = (base, targetId, partId) => this.removeWorkbenchPart(base, targetId, partId);
    this.baseView.onWorkbenchDrop = (base, targetId, partId, fromInventory) => {
      if (fromInventory) this.installWorkbenchPart(base, targetId, partId);
      else this.moveWorkbenchPart(base, targetId, partId);
    };
    this.baseView.onWorkbenchPointer = (_base, targetId, clientX, clientY) => {
      this.pickWorkbenchObject(targetId, clientX, clientY);
    };
    this.baseView.onWorkbenchSelectTarget = (_base, targetId) => {
      this.selectedWorkbenchTargetId = targetId;
    };
    this.baseView.onWorkbenchNodeEdit = (base, targetId, nodeId, x, y, z) => this.editWorkbenchNode(base, targetId, nodeId, x, y, z);
    this.baseView.onWorkbenchPrimitiveEdit = (base, targetId, nodeId, primitiveId, patch) => this.editWorkbenchPrimitive(base, targetId, nodeId, primitiveId, patch);
    this.baseView.onWorkbenchRemoveNode = (base, targetId, nodeId) => this.editWorkbenchNodeRemoval(base, targetId, nodeId);
    this.baseView.onWorkbenchRemoveEdge = (base, targetId, edgeId) => this.editWorkbenchEdgeRemoval(base, targetId, edgeId);
    this.baseView.onWorkbenchAddNode = (base, targetId, parentNodeId) => this.addWorkbenchNode(base, targetId, parentNodeId);
    this.baseView.onWorkbenchAddEdge = (base, targetId, nodeId) => this.addWorkbenchEdge(base, targetId, nodeId);
    this.baseView.onWorkbenchCreateDraft = (base) => this.createDraft(base);
    this.baseView.onWorkbenchBuildDraft = (base, targetId) => this.buildDraft(base, targetId);
    this.baseView.onWorkbenchCommit = () => this.commitWorkbench();
    this.baseView.onWorkbenchCancel = () => {
      const base = this.workbenchCheckpoint?.base ?? this._activeBase;
      this.cancelWorkbench();
      if (base?.alive) {
        this.startWorkbench(base);
        this.openWorkbenchView(base, this.selectedWorkbenchTargetId ?? undefined);
      }
    };
    this.baseView.onWorkbenchTransfer = (base, fromTargetId, toTargetId, partId) => {
      this.transferWorkbenchPart(base, fromTargetId, toTargetId, partId);
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
    this.openWorkbenchView(this._activeBase, this.activeVessels.current ? `vessel:${this.activeVessels.current.id}` : undefined);
  }

  leaveDock(): void {
    this.cancelWorkbench();
    this.baseView.close();
    this.resumeGame();
  }

  private startWorkbench(base: Vessel): void {
    if (this.workbenchCheckpoint?.base === base) return;
    this.cancelWorkbench();
    this.syncDraftRenders(base);
    this.workbenchCheckpoint = {
      base,
      baseAssembly: base.assembly!,
      inventory: [...(base.baseState?.inventory ?? [])],
      targets: (base.baseState?.dockedVessels ?? []).flatMap((entry) =>
        entry.vessel.assembly ? [{ id: entry.id, assembly: entry.vessel.assembly }] : []),
      drafts: [...this.drafts.values()].map((draft) => ({
        id: draft.id, name: draft.name, assembly: draft.assembly, ownedPartIds: [...draft.ownedPartIds],
      })),
    };
    this.workbenchDirty = false;
  }

  private openWorkbenchView(base: Vessel, selectedId?: string): void {
    const targets = this.workbenchTargets(base);
    const preferred = selectedId && targets.some((target) => target.id === selectedId) ? selectedId : targets[0]?.id;
    this.selectedWorkbenchTargetId = preferred ?? null;
    this.baseView.openWorkbench(base, targets, preferred);
  }

  private workbenchTargets(base: Vessel): readonly WorkbenchTargetView[] {
    const targets: WorkbenchTargetView[] = [];
    if (base.assembly) targets.push({ id: `base:${base.id}`, kind: 'base', name: base.name, vessel: base, assembly: base.assembly });
    for (const entry of base.baseState?.dockedVessels ?? []) {
      if (entry.vessel.assembly) targets.push({ id: `vessel:${entry.id}`, kind: 'vessel', name: entry.name, vessel: entry.vessel, assembly: entry.vessel.assembly });
    }
    for (const draft of this.drafts.values()) {
      targets.push({ id: draft.id, kind: 'draft', name: draft.name, vessel: null, assembly: draft.assembly });
    }
    return targets;
  }

  private syncDraftRenders(base: Vessel): void {
    for (const draft of this.drafts.values()) {
      draft.render.object.userData['workbenchDraft'] = true;
      if (draft.render.object.parent !== base.renderObject) base.renderObject.add(draft.render.object);
      draft.render.object.position.set(0, 0, 360 + this.draftSequence * 30);
      draft.render.object.visible = true;
    }
  }

  private commitWorkbench(): void {
    const base = this._activeBase;
    this.workbenchCheckpoint = null;
    this.workbenchDirty = false;
    if (base?.alive) {
      this.startWorkbench(base);
      this.openWorkbenchView(base, this.selectedWorkbenchTargetId ?? undefined);
    }
    this.hud.hint('ドックの変更を確定しました');
  }

  private cancelWorkbench(): void {
    const checkpoint = this.workbenchCheckpoint;
    if (!checkpoint) return;
    if (this.workbenchDirty && checkpoint.base.baseState) {
      const currentBase = checkpoint.base;
      if (currentBase.assembly && checkpoint.baseAssembly) {
        const restored = this.commitBaseAssembly(currentBase, checkpoint.baseAssembly, false);
        if (!restored.ok) this.hud.hint(`基地の変更を戻せません: ${restored.reason}`);
      }
      for (const target of checkpoint.targets) {
        const current = checkpoint.base.baseState?.dockedVessels.find((entry) => entry.id === target.id);
        if (!current) continue;
        const result = this.commitDockedAssembly(checkpoint.base, target.id, target.assembly, false);
        if (!result.ok) this.hud.hint(`変更を戻せません: ${result.reason}`);
      }
      checkpoint.base.baseState.inventory.splice(0, checkpoint.base.baseState.inventory.length, ...checkpoint.inventory);
      for (const id of [...this.drafts.keys()]) {
        if (checkpoint.drafts.some((draft) => draft.id === id)) continue;
        this.drafts.get(id)?.render.dispose();
        this.drafts.delete(id);
      }
      for (const saved of checkpoint.drafts) {
        const current = this.drafts.get(saved.id);
        if (!current) {
          const render = new AssemblyRenderObject(saved.assembly);
          this.drafts.set(saved.id, { id: saved.id, name: saved.name, assembly: saved.assembly, render, ownedPartIds: new Set(saved.ownedPartIds) });
        } else {
          current.render.object.removeFromParent();
          current.render.dispose();
          current.assembly = saved.assembly;
          current.name = saved.name;
          current.render = new AssemblyRenderObject(saved.assembly);
          current.ownedPartIds.clear(); saved.ownedPartIds.forEach((id) => current.ownedPartIds.add(id));
        }
      }
      this.syncDraftRenders(checkpoint.base);
    }
    this.workbenchCheckpoint = null;
    this.workbenchDirty = false;
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

  private removeWorkbenchPart(base: Vessel, targetId: string, partId: string): void {
    const target = this.targetById(base, targetId);
    if (!target) return;
    const placement = target.assembly.placements.find((candidate) => candidate.part.id === partId);
    if (!placement) return;
    if (target.kind === 'base' && placement.part.type === 'base_module') {
      this.hud.hint('基地モジュールは基地本体から取り外せません');
      return;
    }
    const result = removePlacement(target.assembly, partId, { blueprintId: `workbench-${targetId}`, blueprintName: target.name });
    if (!result.accepted) return this.reportEditFailure(result.errors[0]?.message ?? '部品を取り外せません');
    const applied = this.applyTargetAssembly(base, targetId, result.assembly);
    if (!applied) return;
    const inventoryOwner = this._activeBase ?? base;
    if (target.kind === 'draft') {
      const draft = this.drafts.get(targetId);
      if (draft?.ownedPartIds.delete(partId)) inventoryOwner.baseState!.inventory.push(placement.part);
    } else {
      inventoryOwner.baseState!.inventory.push(placement.part);
    }
    this.hud.hint(`${placement.part.name} を基地倉庫へ移しました`);
  }

  private transferWorkbenchPart(base: Vessel, fromTargetId: string, toTargetId: string, partId: string): void {
    const from = this.targetById(base, fromTargetId);
    const to = this.targetById(base, toTargetId);
    if (!from || !to || from.kind === 'base' || to.kind === 'base' || from === to) return;
    const sourcePlacement = from.assembly.placements.find((placement) => placement.part.id === partId);
    if (!sourcePlacement) return;
    const sourceAssembly = { tree: from.assembly.tree, placements: from.assembly.placements.filter((p) => p.part.id !== partId) };
    const destinationAssembly = { tree: to.assembly.tree, placements: [...to.assembly.placements, sourcePlacement] };
    if (assemblyError(sourceAssembly, from.name) || assemblyError(destinationAssembly, to.name)) {
      this.hud.hint('移送前後の構成が検証を通りません'); return;
    }
    const destinationResult = this.applyTargetAssembly(base, toTargetId, destinationAssembly);
    if (!destinationResult) return;
    const sourceResult = this.applyTargetAssembly(base, fromTargetId, sourceAssembly);
    if (!sourceResult) {
      this.hud.hint('移送元を更新できないため、変更を停止しました'); return;
    }
    this.hud.hint(`${sourcePlacement.part.name} を移送しました`);
  }

  private installWorkbenchPart(base: Vessel, targetId: string, partId: string): void {
    if (!base.baseState) return;
    const target = this.targetById(base, targetId);
    const inventoryIndex = base.baseState.inventory.findIndex((part) => part.id === partId);
    if (!target || inventoryIndex < 0) return;
    const part = base.baseState.inventory[inventoryIndex]!;
    const placement = defaultDockPlacement(target.assembly, part, this.selectedMounts.get(targetId));
    if (!placement) return this.reportEditFailure('この部品を置けるMountPointがありません');
    const next = { tree: target.assembly.tree, placements: [...target.assembly.placements, placement] };
    if (!this.applyTargetAssembly(base, targetId, next)) return;
    const inventoryOwner = this._activeBase ?? base;
    inventoryOwner.baseState!.inventory.splice(inventoryIndex, 1);
    if (target.kind === 'draft') this.drafts.get(targetId)?.ownedPartIds.add(part.id);
    this.hud.hint(`${part.name} を ${target.name} へ取り付けました`);
  }

  private moveWorkbenchPart(base: Vessel, targetId: string, partId: string): void {
    const target = this.targetById(base, targetId);
    const mount = this.selectedMounts.get(targetId);
    if (!target || !mount) return this.reportEditFailure('先に3D上の接続口または外表面を選択してください');
    const result = movePlacement(target.assembly, { placementId: partId, mount }, editorOptions(target.name));
    if (!result.accepted) return this.reportEditFailure(result.errors[0]?.message ?? '部品を移動できません');
    this.applyTargetAssembly(base, targetId, result.assembly);
  }

  private pickWorkbenchObject(targetId: string, clientX: number, clientY: number): void {
    const base = this._activeBase;
    const target = base ? this.targetById(base, targetId) : null;
    if (!base || !target) return;
    const width = Math.max(1, document.documentElement.clientWidth);
    const height = Math.max(1, document.documentElement.clientHeight);
    this.workbenchRaycaster.setFromCamera(
      new THREE.Vector2((clientX / width) * 2 - 1, -(clientY / height) * 2 + 1),
      this.cameraSystem.activeCamera,
    );
    const objectRoot = target.vessel?.renderObject ?? this.drafts.get(targetId)?.render.object;
    if (!objectRoot) return;
    objectRoot.updateMatrixWorld(true);
    const hit = this.workbenchRaycaster.intersectObjects(objectRoot.children, true)[0];
    let object: THREE.Object3D | null = hit?.object ?? null;
    while (object) {
      const partRef = object.userData['partVisualRef']?.partId as string | undefined;
      if (partRef) {
        const placement = target.assembly.placements.find((candidate) => candidate.part.id === partRef);
        if (!placement) { object = object.parent; continue; }
        const part = placement?.part;
        const info: WorkbenchSelectionInfo = {
          kind: 'part', id: partRef, label: part?.name ?? partRef,
          detail: part ? `${part.type} · ${Math.round(part.weight)} kg · HP ${Math.round(part.hp)}/${Math.round(part.maxHp)}` : partRef,
          part, placement, mount: placement?.kind === 'external' ? placement.mount : undefined,
        };
        if (info.mount) this.selectedMounts.set(targetId, info.mount);
        this.baseView.showWorkbenchSelection(info);
        this.hud.hint(`選択: ${info.label}`);
        return;
      }
      const edgeId = object.userData['assemblyEdgeId'] as string | undefined;
      if (edgeId) {
        const edge = target.assembly.tree.edges.find((candidate) => candidate.id === edgeId);
        const mount = edge ? (edgeMount(edge) ?? undefined) : undefined;
        if (mount) this.selectedMounts.set(targetId, mount);
        this.baseView.showWorkbenchSelection({
          kind: 'edge', id: edgeId, label: `エッジ ${edgeId}`, detail: `${object.userData['edgeKind'] ?? 'hull'} · ${edge?.length.toFixed(1) ?? '?'} m`, mount,
        });
        this.hud.hint(`エッジ ${edgeId}`);
        return;
      }
      const nodeId = object.userData['assemblyNodeId'] as string | undefined;
      if (nodeId) {
        const node = target.assembly.tree.nodes.find((candidate) => candidate.id === nodeId);
        const port = freePort(target.assembly, nodeId);
        if (port) this.selectedMounts.set(targetId, { kind: 'port', nodeId, port });
        this.baseView.showWorkbenchSelection({ kind: 'node', id: nodeId, label: `ノード ${nodeId}`, detail: node ? `位置 ${node.pos.x.toFixed(1)}, ${node.pos.y.toFixed(1)}, ${node.pos.z.toFixed(1)}` : '', node });
        this.hud.hint(`ノード ${nodeId}`);
        return;
      }
      object = object.parent;
    }
    if (hit) {
      this.baseView.showWorkbenchSelection({ kind: 'skin', id: 'skin', label: '外皮', detail: '外皮メッシュ' });
      this.hud.hint('外皮を選択しました');
    }
  }

  private targetById(base: Vessel, targetId: string): WorkbenchTargetView | null {
    return this.workbenchTargets(base).find((target) => target.id === targetId) ?? null;
  }

  private reportEditFailure(message: string): void {
    this.hud.hint(`作業台の変更を適用できません: ${message}`);
  }

  private applyEditorResult(base: Vessel, targetId: string, result: { accepted: boolean; assembly: VesselAssembly; errors: readonly { message: string }[] }): void {
    if (!result.accepted) return this.reportEditFailure(result.errors[0]?.message ?? '構成が不正です');
    this.applyTargetAssembly(base, targetId, result.assembly);
  }

  private editWorkbenchNode(base: Vessel, targetId: string, nodeId: string, x: number, y: number, z: number): void {
    const target = this.targetById(base, targetId);
    if (!target) return;
    this.applyEditorResult(base, targetId, moveNode(target.assembly, { nodeId, pos: v3(x, y, z) }, editorOptions(target.name)));
  }

  private editWorkbenchPrimitive(base: Vessel, targetId: string, nodeId: string, primitiveId: string, patch: Record<string, unknown>): void {
    const target = this.targetById(base, targetId);
    if (!target) return;
    this.applyEditorResult(base, targetId, editSection(target.assembly, {
      kind: 'update-primitive', nodeId, primitiveId, patch: patch as never,
    }, editorOptions(target.name)));
  }

  private editWorkbenchNodeRemoval(base: Vessel, targetId: string, nodeId: string): void {
    const target = this.targetById(base, targetId);
    if (!target) return;
    this.applyEditorResult(base, targetId, removeNode(target.assembly, nodeId, editorOptions(target.name)));
  }

  private editWorkbenchEdgeRemoval(base: Vessel, targetId: string, edgeId: string): void {
    const target = this.targetById(base, targetId);
    if (!target) return;
    this.applyEditorResult(base, targetId, removeEdge(target.assembly, edgeId, editorOptions(target.name)));
  }

  private addWorkbenchNode(base: Vessel, targetId: string, parentNodeId: string): void {
    const target = this.targetById(base, targetId);
    const parent = target?.assembly.tree.nodes.find((node) => node.id === parentNodeId);
    if (!target || !parent) return;
    const port = freePort(target.assembly, parent.id);
    if (!port) return this.reportEditFailure('選択ノードに空き接続口がありません');
    const id = uniqueId(target.assembly.tree.nodes.map((node) => node.id), `${parent.id}-child`);
    const node: TreeNode = {
      id, pos: addVec(parent.pos, scaleVec(parent.axis, 5)), axis: parent.axis,
      phaseAngle: parent.phaseAngle, section: parent.section,
    };
    const edge: EdgeDraft = {
      id: uniqueId(target.assembly.tree.edges.map((candidate) => candidate.id), `${parent.id}-${id}`),
      a: parent.id, b: id, portA: port, portB: { kind: 'axial', sign: -1 }, kind: { kind: 'hull' },
    };
    this.applyEditorResult(base, targetId, addNode(target.assembly, { node, edge }, editorOptions(target.name)));
  }

  private addWorkbenchEdge(base: Vessel, targetId: string, nodeId: string): void {
    const target = this.targetById(base, targetId);
    if (!target) return;
    const other = target.assembly.tree.nodes.find((node) => node.id !== nodeId && freePort(target.assembly, node.id) !== null);
    const portA = freePort(target.assembly, nodeId);
    const portB = other ? freePort(target.assembly, other.id) : null;
    if (!other || !portA || !portB) return this.reportEditFailure('エッジを接続できる空き接続口がありません');
    const edge: EdgeDraft = {
      id: uniqueId(target.assembly.tree.edges.map((candidate) => candidate.id), 'custom-edge'),
      a: nodeId, b: other.id, portA, portB, kind: { kind: 'hull' },
    };
    this.applyEditorResult(base, targetId, addEdge(target.assembly, edge, editorOptions(target.name)));
  }

  private applyTargetAssembly(base: Vessel, targetId: string, assembly: VesselAssembly): boolean {
    const target = this.targetById(base, targetId);
    if (!target) return false;
    const error = assemblyError(assembly, target.name);
    if (error) { this.reportEditFailure(error); return false; }
    if (target.kind === 'base') {
      const result = this.commitBaseAssembly(base, assembly);
      if (!result.ok) { this.reportEditFailure(result.reason); return false; }
      this.selectedWorkbenchTargetId = `base:${result.base.id}`;
      this.openWorkbenchView(result.base, this.selectedWorkbenchTargetId);
      return true;
    }
    if (target.kind === 'vessel' && target.vessel) {
      const result = this.commitDockedAssembly(base, target.vessel.id, assembly);
      if (!result.ok) { this.reportEditFailure(result.reason); return false; }
      this.selectedWorkbenchTargetId = targetId;
      this.openWorkbenchView(base, targetId);
      return true;
    }
    const draft = this.drafts.get(targetId);
    if (!draft) return false;
    draft.render.object.removeFromParent();
    draft.render.dispose();
    draft.assembly = assembly;
    draft.render = new AssemblyRenderObject(assembly);
    this.syncDraftRenders(base);
    this.workbenchDirty = true;
    this.selectedWorkbenchTargetId = targetId;
    this.openWorkbenchView(base, targetId);
    return true;
  }

  private commitBaseAssembly(base: Vessel, assembly: VesselAssembly, track = true): { ok: true; base: Vessel } | { ok: false; reason: string } {
    if (!base.baseState) return { ok: false, reason: '基地ではありません' };
    const validation = validateBaseAssembly(assembly, base.baseState.dockedVessels.length);
    if (validation.length > 0) return { ok: false, reason: validation[0]! };
    const oldModule = base.parts.find((part) => part.type === 'base_module' && part.hp > 0);
    const newModule = assembly.placements.map((placement) => placement.part)
      .find((part) => part.type === 'base_module' && part.hp > 0);
    if (!oldModule || !newModule || oldModule.type !== 'base_module' || newModule.type !== 'base_module') {
      return { ok: false, reason: '基地モジュールを維持してください' };
    }
    if (oldModule.id !== newModule.id) return { ok: false, reason: '基地モジュールのIDは変更できません' };
    const oldPorts = deriveBaseDockingPorts(base.assembly, oldModule).slots;
    const newPorts = deriveBaseDockingPorts(assembly, newModule).slots;
    for (const entry of base.baseState.dockedVessels) {
      if (!sameDockPort(oldPorts[entry.slotIndex], newPorts[entry.slotIndex])) {
        return { ok: false, reason: `ドック ${entry.slotIndex + 1} は船が収容中のため変更できません` };
      }
    }
    const applied = base.replaceAssembly(assembly);
    if (!applied.ok) return applied;
    this._activeBase = base;
    if (track) this.workbenchDirty = true;
    return { ok: true, base };
  }

  private createDraft(base: Vessel): void {
    const id = `draft:${base.id}:${++this.draftSequence}`;
    const assembly = crewedAssembly(C.PLAYER_MAX_HP);
    const render = new AssemblyRenderObject(assembly);
    const draft: DraftEntry = { id, name: `新規船下書き ${this.draftSequence}`, assembly, render, ownedPartIds: new Set() };
    this.drafts.set(id, draft);
    this.syncDraftRenders(base);
    this.workbenchDirty = true;
    this.selectedWorkbenchTargetId = id;
    this.openWorkbenchView(base, id);
    this.hud.hint(`${draft.name} を作成しました。作業台で編集してから建造を確定してください`);
  }

  private buildDraft(base: Vessel, targetId: string): void {
    const draft = this.drafts.get(targetId);
    if (!draft || !base.baseState) return;
    const slotIndex = base.getAvailableSlotIndex();
    if (slotIndex === null) return this.reportEditFailure('空きドックがありません');
    const blueprint = createBlueprint({ id: `${draft.id}-blueprint`, name: draft.name, tree: draft.assembly.tree, placements: draft.assembly.placements, now: Date.now() });
    const production = productionBlueprintOf(blueprint);
    const requirements = producibility(production, base.baseState.resources, baseFacilities(base), basePowerAvailable(base));
    if (requirements.length > 0) {
      this.hud.hint(`建造資源・設備が不足しています: ${requirements.map((item) => item.id).join(', ')}`); return;
    }
    if (!consumeProductionResources(production, base.baseState.resources)) return this.reportEditFailure('建造資源を消費できません');
    const vessel = new Vessel({ blueprintShip: {
      blueprint, state: kinematicState(base.state.t, base.state.r, base.state.v), name: draft.name, id: `${draft.id}-built`,
    } }, this.vesselDeps);
    base.baseState.dockedVessels.push({ id: vessel.id, name: vessel.name, hp: vessel.hp, maxHp: vessel.maxHp, parts: vessel.parts, vessel, slotIndex });
    base.attachDockedVesselMesh(vessel, slotIndex);
    draft.render.object.removeFromParent(); draft.render.dispose(); this.drafts.delete(targetId);
    this.workbenchDirty = true;
    this.selectedWorkbenchTargetId = `vessel:${vessel.id}`;
    this.openWorkbenchView(base, this.selectedWorkbenchTargetId);
    this.hud.hint(`${vessel.name} をドック ${slotIndex + 1} に格納しました`);
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

const EXTERNAL_PART_TYPES = new Set([
  'weapon', 'engine', 'rcs_thruster', 'solar_panel', 'radiator', 'combat_shield',
  'heat_shield', 'communication', 'robot_arm', 'docking_port', 'container_coupling',
]);

function editorOptions(name: string): { readonly blueprintId: string; readonly blueprintName: string } {
  return { blueprintId: `workbench-${name}`, blueprintName: name };
}

function uniqueId(existing: readonly string[], prefix: string): string {
  const used = new Set(existing);
  if (!used.has(prefix)) return prefix;
  for (let i = 2; ; i++) {
    const candidate = `${prefix}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

function portKey(nodeId: string, port: PortRef): string {
  return port.kind === 'axial'
    ? `${nodeId}:axial:${port.sign}`
    : `${nodeId}:lateral:${port.primitiveId}:${port.faceIndex}`;
}

function freePort(assembly: VesselAssembly, nodeId: string): PortRef | null {
  const occupied = new Set<string>();
  for (const edge of assembly.tree.edges) {
    if (edge.a === nodeId) occupied.add(portKey(nodeId, edge.portA));
    if (edge.b === nodeId) occupied.add(portKey(nodeId, edge.portB));
  }
  for (const port of [{ kind: 'axial', sign: 1 }, { kind: 'axial', sign: -1 }] as const) {
    if (!occupied.has(portKey(nodeId, port))) return port;
  }
  const node = assembly.tree.nodes.find((candidate) => candidate.id === nodeId);
  for (const primitive of node?.section.primitives ?? []) {
    const faceCount = primitive.shape.kind === 'circle' ? primitive.shape.branchCount
      : primitive.shape.kind === 'polygon' || primitive.shape.kind === 'notched' ? primitive.shape.sides : 2;
    for (let faceIndex = 0; faceIndex < faceCount; faceIndex++) {
      const port: PortRef = { kind: 'lateral', primitiveId: primitive.id, faceIndex };
      if (!occupied.has(portKey(nodeId, port))) return port;
    }
  }
  return null;
}

function edgeMount(edge: VesselAssembly['tree']['edges'][number]): MountPoint | null {
  if (edge.kind.kind === 'truss') return { kind: 'truss', edgeId: edge.id, along: edge.length / 2, around: 0 };
  if (edge.kind.kind === 'hull') return { kind: 'surface', edgeId: edge.id, along: edge.length / 2, around: 0 };
  const port = edge.portA;
  return port.kind === 'axial' ? { kind: 'port', nodeId: edge.a, port } : null;
}

function assemblyError(assembly: VesselAssembly, name: string): string | null {
  try {
    const blueprint = createBlueprint({
      id: `dock-preview-${name}`, name, tree: assembly.tree, placements: assembly.placements, now: 0,
    });
    return validateBlueprint(blueprint).find((issue) => issue.severity === 'error')?.message ?? null;
  } catch (error) {
    return `構成の検証に失敗しました: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function defaultDockPlacement(assembly: VesselAssembly, part: AnyPart, selectedMount?: MountPoint): PartPlacement | null {
  const edge = assembly.tree.edges.find((candidate) => candidate.kind.kind === 'hull') ?? assembly.tree.edges[0];
  if (!edge) return null;
  if (selectedMount && EXTERNAL_PART_TYPES.has(part.type)) return { kind: 'external', part, mount: selectedMount };
  if (!EXTERNAL_PART_TYPES.has(part.type)) return { kind: 'internal', part, edgeIds: [edge.id] };
  if (part.type === 'engine' && edge.portA.kind === 'axial') {
    return { kind: 'external', part, mount: { kind: 'port', nodeId: edge.a, port: edge.portA } };
  }
  if (edge.kind.kind !== 'hull') return null;
  return { kind: 'external', part, mount: { kind: 'surface', edgeId: edge.id, along: edge.length / 2, around: 0 } };
}

function sameDockPort(
  a: { readonly localPos: { x: number; y: number; z: number }; readonly localNormal: { x: number; y: number; z: number } } | undefined,
  b: { readonly localPos: { x: number; y: number; z: number }; readonly localNormal: { x: number; y: number; z: number } } | undefined,
): boolean {
  if (!a || !b) return false;
  return Math.abs(a.localPos.x - b.localPos.x) < 1e-9
    && Math.abs(a.localPos.y - b.localPos.y) < 1e-9
    && Math.abs(a.localPos.z - b.localPos.z) < 1e-9
    && Math.abs(a.localNormal.x - b.localNormal.x) < 1e-9
    && Math.abs(a.localNormal.y - b.localNormal.y) < 1e-9
    && Math.abs(a.localNormal.z - b.localNormal.z) < 1e-9;
}

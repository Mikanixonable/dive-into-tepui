import * as THREE from 'three/webgpu';
import * as C from './const';
import { v3, len, sub } from '../physics/vec3';
import { kinematicState } from '../physics/kinematic-state';
import { Hud } from './hud/hud';
import { BaseView } from './hud/base-view';
import { ResourceTransferDialog } from './hud/resource-transfer-dialog';
import { Vessel, type VesselDeps } from './vessel/vessel';
import { hasBaseModule } from './vessel/capabilities';
import type { VesselBlueprint } from './vessel/blueprint';
import { createBlueprint } from './vessel/blueprint';
import type { VesselAssembly } from './vessel/assembly';
import type { PartPlacement } from './vessel/assembly';
import { validateBlueprint } from './vessel/blueprint-validation';
import { baseFacilities, basePowerAvailable } from './vessel/base-module';
import { BlueprintLibrary } from './vessel/blueprint-library';
import { LocalStorageBlueprintStore } from './vessel/blueprint-store';
import { producibility } from './economy/producibility';
import { consumeProductionResources, productionBlueprintOf } from './vessel/production';
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
import { generateRandomName } from './random-name';

interface WorkbenchCheckpoint {
  readonly base: Vessel;
  readonly inventory: readonly AnyPart[];
  readonly targets: readonly { readonly id: string; readonly assembly: VesselAssembly }[];
}

export class Docking {
  readonly baseView: BaseView;
  readonly transferDialog: ResourceTransferDialog;
  // 選択中/ドックビューの対象基地。設定されている間だけドックビューへ遷移できる。
  private _activeBase: Vessel | null = null;
  // 新造艦艇の連番。基地をまたいで一意な id/表示名を割り振るだけの用途。
  private nextBuiltVesselNo = 0;

  // 船と船、船と基地の物理ドッキングペア (shipId -> targetEntity)
  private readonly dockedPairs = new Map<string, GameEntity>();

  get activeBase(): Vessel | null { return this._activeBase; }

  // 機体の組み立てに要る資源。基地での生産がこれを使う。
  private readonly vesselDeps: VesselDeps;
  // 生産にかけられる設計の保管庫。
  private readonly blueprints: BlueprintLibrary;
  private readonly workbenchRaycaster = new THREE.Raycaster();
  private workbenchCheckpoint: WorkbenchCheckpoint | null = null;
  private workbenchDirty = false;

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
    this.blueprints = new BlueprintLibrary(new LocalStorageBlueprintStore());
    this.baseView = new BaseView(this.hud.layers.view, this.blueprints);
    this.baseView.onClose = () => this.viewManager.leaveDock();
    this.baseView.onLaunchVessel = (ship, base) => this.launch(ship, base);
    this.baseView.onProduceVessel = (base, blueprint) => this.produceVessel(base, blueprint);
    this.baseView.onWorkbenchRemove = (base, vessel, partId) => this.removeDockedPart(base, vessel, partId);
    this.baseView.onWorkbenchDrop = (base, vessel, partId, fromInventory) => {
      if (fromInventory) this.installDockedPart(base, vessel, partId);
    };
    this.baseView.onWorkbenchPointer = (_base, vessel, clientX, clientY) => {
      this.pickWorkbenchObject(vessel, clientX, clientY);
    };
    this.baseView.onWorkbenchCommit = () => this.commitWorkbench();
    this.baseView.onWorkbenchCancel = () => {
      const base = this.workbenchCheckpoint?.base ?? this._activeBase;
      this.cancelWorkbench();
      const vessel = base?.baseState?.dockedVessels[0]?.vessel;
      if (base?.alive && vessel) this.baseView.openWorkbench(base, vessel);
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
      inventory: [...(base.baseState?.inventory ?? [])],
      targets: (base.baseState?.dockedVessels ?? []).flatMap((entry) =>
        entry.vessel.assembly ? [{ id: entry.id, assembly: entry.vessel.assembly }] : []),
    };
    this.workbenchDirty = false;
  }

  private commitWorkbench(): void {
    this.workbenchCheckpoint = null;
    this.workbenchDirty = false;
    this.hud.hint('ドックの変更を確定しました');
  }

  private cancelWorkbench(): void {
    const checkpoint = this.workbenchCheckpoint;
    if (!checkpoint) return;
    if (this.workbenchDirty && checkpoint.base.baseState) {
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
    const result = this.commitDockedAssembly(base, vessel.id, { tree: vessel.assembly.tree, placements });
    if (!result.ok) {
      this.hud.hint(`取り外せません: ${result.reason}`);
      return;
    }
    base.baseState!.inventory.push(removed);
    this.baseView.openWorkbench(base, result.vessel);
    this.hud.hint('部品を基地倉庫へ移しました');
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
    const result = this.commitDockedAssembly(base, vessel.id, {
      tree: vessel.assembly.tree, placements: [...vessel.assembly.placements, placement],
    });
    if (!result.ok) {
      this.hud.hint(`取り付けられません: ${result.reason}`);
      return;
    }
    base.baseState.inventory.splice(inventoryIndex, 1);
    this.baseView.openWorkbench(base, result.vessel);
    this.hud.hint('部品をドック作業台へ取り付けました');
  }

  private pickWorkbenchObject(vessel: Vessel, clientX: number, clientY: number): void {
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
        return;
      }
      const edgeId = object.userData['assemblyEdgeId'] as string | undefined;
      if (edgeId) {
        this.hud.hint(`エッジ ${edgeId} · ${object.userData['edgeKind'] ?? 'hull'}`);
        return;
      }
      const nodeId = object.userData['assemblyNodeId'] as string | undefined;
      if (nodeId) {
        this.hud.hint(`ノード ${nodeId}`);
        return;
      }
      object = object.parent;
    }
  }

  // 設計から実機を1機作り、基地のドックへ置く。ドックの収容数を超える生産は、完成した時点では
  // なく開始時点で拒否する。資源が足りなければ在庫は一切減らない。
  private produceVessel(base: Vessel, blueprint: VesselBlueprint): void {
    if (this.workbenchDirty) {
      this.hud.hint('作業台の変更を先に確定または取消してください');
      return;
    }
    if (base.baseState!.dockedVessels.length >= base.dockCapacity) {
      this.hud.hint(`基地のドックが満杯です (最大 ${base.dockCapacity} 隻)`);
      return;
    }
    const request = productionBlueprintOf(blueprint);
    const missing = producibility(
      request, base.baseState!.resources, baseFacilities(base), basePowerAvailable(base),
    );
    if (missing.length > 0) {
      this.hud.hint(`${blueprint.name} を生産できません (不足 ${missing.length} 件)`);
      return;
    }
    if (!consumeProductionResources(request, base.baseState!.resources)) {
      this.hud.hint(`${blueprint.name} の資源を確保できませんでした`);
      return;
    }
    const slotIndex = base.getAvailableSlotIndex() ?? 0;
    const no = ++this.nextBuiltVesselNo;
    const id = `${base.id}-built-${no}`;
    const shipName = generateRandomName('player');
    const ship = new Vessel(
      { blueprintShip: { blueprint, name: shipName, state: base.state, id } }, this.vesselDeps);
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
    this.hud.hint(`${ship.name} を生産しました (ドック ${slotIndex + 1})`);
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

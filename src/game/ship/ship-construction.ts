// ドック起点の建造セッションを持ち、ゲームの配置規則をHUD・ゴースト・候補ガイドへ同期する。
import type * as THREE from 'three/webgpu';
import { LOCAL_FORWARD, qMul, qRotate } from '../../math/quat';
import { add, dot, scale, sub, v3, type Vec3 } from '../../math/vec3';
import type { Ray } from '../../math/ray';
import type { CameraFrame } from '../../render/camera/camera-frame';
import { DockSnapGuideView, type DockSnapGuideDisplay } from '../../render/dynamic/ship/dock-snap-guide-view';
import { ShipGhostView } from '../../render/dynamic/ship/ship-ghost-view';
import type { OverlayHandle, OverlayManager } from '../../hud/overlay-manager';
import type { Input } from '../../input/input';
import type { Viewport } from '../../render/viewport';
import type { CameraSystem } from '../camera/camera-system';
import type { DisplayWindowManager } from '../display-window-manager';
import type {
  ConstructionConfirmationPort, ConstructionSlotState, ShipConstructionPanelModel,
} from './ship-construction-types';
import type { Notifier } from '../../hud/notifier';
import type { ModuleTransform } from './ship-assembly';
import {
  constructionSlotId, enumerateConstructionSlots, placementForSlot, slotState,
  type ConstructionPlacement, type ConstructionSlot,
} from './ship-construction-rules';
import { SHIP_MODULE_CATALOG } from './ship-module-catalog';
import { createShipModuleInstance } from './ship-module-instance';
import type { ModularShip } from './modular-ship';

interface ConstructionDraft {
  readonly ship: ModularShip;
  readonly dockId: string;
  readonly addedIds: string[];
  axialTailId: string;
  firstConnectionId: string | null;
}

interface ConstructionCandidate {
  readonly slot: ConstructionSlot;
  readonly placement: ConstructionPlacement;
  readonly centerEci: Vec3;
  readonly rotationEci: ModuleTransform['rotation'];
  readonly guideEci: Vec3;
  readonly guideRadius: number;
}

let nextConstructionModule = 1;

export interface ShipConstructionPanelPort {
  readonly element: { contains(target: Node): boolean };
  onSelectionChange: ((definitionId: string) => void) | null;
  onSlotChange: ((slotId: string) => void) | null;
  onPlace: (() => void) | null;
  onRemove: (() => void) | null;
  onFinish: (() => void) | null;
  onDiscard: (() => void) | null;
  sync(model: ShipConstructionPanelModel): void;
}

// 一度に一つの建造セッションを所有し、論理 assembly・HUD・ghost を同じ候補へ同期する。
export class ShipConstruction implements OverlayHandle {
  private readonly ghost: ShipGhostView;
  private readonly guide: DockSnapGuideView;
  private readonly drafts = new Map<string, ConstructionDraft>();
  private current: ConstructionDraft | null = null;
  private definitionId = 'cockpit-standard';
  private selectedSlotId = 'axial';
  private previousForceCurrent = false;

  // 建造規則の結果を、既存のHUD・入力・表示時刻の各装置へ接続する。
  public constructor(
    scene: THREE.Scene,
    private readonly panel: ShipConstructionPanelPort,
    private readonly overlayManager: OverlayManager,
    private readonly displayWindow: DisplayWindowManager,
    private readonly notifier: Notifier,
    private readonly confirmation: ConstructionConfirmationPort,
    private readonly focusDock: ((ship: ModularShip) => void) | null = null,
  ) {
    this.ghost = new ShipGhostView(scene);
    this.guide = new DockSnapGuideView(scene);
    panel.onSelectionChange = (definitionId) => {
      this.definitionId = definitionId;
      this.syncPanel();
    };
    panel.onSlotChange = (slotId) => {
      this.selectSlot(slotId);
      this.syncPanel();
    };
    panel.onPlace = () => this.place();
    panel.onRemove = () => this.removeLast();
    panel.onFinish = () => this.finish();
    panel.onDiscard = () => this.discard();
  }

  public get active(): boolean { return this.current !== null; }

  // 保存済みドラフトを復元または新規作成し、建造モードの時間・入力境界を開く。
  public start(ship: ModularShip, dockId: string): void {
    const module = ship.assembly.module(dockId);
    if (module?.kind !== 'dock') throw new Error(`not a construction dock: ${dockId}`);
    if (!ship.capabilities.controllable) throw new Error('健全なコックピットから操作できる船体が必要です');
    if (module.hp <= 0 || ship.assembly.isPortConnected(dockId)) {
      throw new Error('空いている健全な接舷部が必要です');
    }
    if (this.current !== null) this.close();
    const key = this.key(ship, dockId);
    let draft = this.drafts.get(key);
    if (draft === undefined) {
      let saved = ship.docks.constructionDraft(dockId);
      if (saved === null) {
        ship.docks.beginBuilding(ship.assembly, dockId);
        saved = ship.docks.constructionDraft(dockId);
      }
      if (saved === null) throw new Error(`construction draft missing: ${dockId}`);
      draft = {
        ship, dockId, addedIds: [...saved.addedIds],
        axialTailId: saved.axialTailId, firstConnectionId: saved.firstConnectionId,
      };
      this.drafts.set(key, draft);
    }
    this.current = draft;
    this.normalizeSelection();
    this.focusDock?.(ship);
    this.previousForceCurrent = this.displayWindow.current.forceCurrent;
    this.displayWindow.setForceCurrent(true);
    this.overlayManager.open('ship-construction-mode', this, {
      kind: 'window', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: false, pausesGame: true,
    });
    this.syncPanel();
  }

  public contains(target: Node): boolean { return this.panel.element.contains(target); }

  // ESC では未完成枝を保持してセッションだけ閉じる。
  public close(): void {
    if (this.current === null) return;
    this.confirmation.close();
    this.current = null;
    this.overlayManager.close('ship-construction-mode');
    this.displayWindow.setForceCurrent(this.previousForceCurrent);
    this.panel.sync(hiddenModel());
    this.ghost.sync(null);
    this.guide.syncAll([]);
  }

  // 3D候補をクリックしたときは、未選択候補を先に選び、選択済み候補だけを確定する。
  public handlePointer(input: Input, camera: CameraSystem, viewport: Viewport): boolean {
    if (this.current === null) return false;
    input.takeClicks((point) => {
      const ray = camera.rayThroughScreen(point.x, point.y, viewport);
      const hit = this.candidates().find(candidate => this.hitsCandidate(ray, candidate));
      if (hit === undefined) return true;
      if (this.selectedSlotId !== hit.slot.id) {
        this.selectSlot(hit.slot.id);
        this.syncPanel();
      } else {
        this.place();
      }
      return true;
    });
    input.takeRightClicks(() => true);
    return true;
  }

  // このフレームの全候補をガイドへ、選択中の候補だけをゴーストへ宣言する。
  public sync(camera: CameraFrame): void {
    if (this.current === null) {
      this.ghost.sync(null);
      this.guide.syncAll([]);
      return;
    }
    this.normalizeSelection();
    const candidates = this.candidates();
    const displays: DockSnapGuideDisplay[] = candidates.map(candidate => ({
      id: candidate.slot.id,
      position: this.displayPosition(camera, candidate.guideEci),
      rotation: candidate.rotationEci,
      radius: candidate.guideRadius,
      valid: candidate.placement.valid,
      selected: candidate.slot.id === this.selectedSlotId,
    }));
    this.guide.syncAll(displays);
    const selected = candidates.find(candidate => candidate.slot.id === this.selectedSlotId) ?? null;
    if (selected === null) {
      this.ghost.sync(null);
    } else {
      this.ghost.sync({
        modelId: SHIP_MODULE_CATALOG.require(this.definitionId).modelId,
        position: this.displayPosition(camera, selected.centerEci),
        rotation: selected.rotationEci,
        valid: selected.placement.valid,
      });
    }
    this.syncPanel();
  }

  // モード終了時にDOM callbackとGPU/3D資源を同じ所有者から解放する。
  public dispose(): void {
    this.close();
    this.ghost.dispose();
    this.guide.dispose();
    this.panel.onSelectionChange = null;
    this.panel.onSlotChange = null;
    this.panel.onPlace = null;
    this.panel.onRemove = null;
    this.panel.onFinish = null;
    this.panel.onDiscard = null;
  }

  // 選択中のスロットへ部品を追加し、保存ドラフトと船体物性を更新する。
  private place(): void {
    const draft = this.current;
    const candidate = this.selectedCandidate();
    if (draft === null || candidate === null || !candidate.placement.valid) {
      if (candidate?.placement.reason) this.notifier.hint(candidate.placement.reason, undefined, 'warn');
      return;
    }
    let id: string;
    do id = `construction-${nextConstructionModule++}`;
    while (draft.ship.assembly.module(id) !== null);
    draft.ship.assembly.addModule(
      createShipModuleInstance(SHIP_MODULE_CATALOG.require(this.definitionId), id),
      candidate.placement.parentId, candidate.placement.transform, candidate.placement.kind,
    );
    const connection = draft.ship.assembly.graph.find(edge => edge.childId === id);
    if (connection === undefined) throw new Error(`construction connection missing: ${id}`);
    if (draft.firstConnectionId === null) draft.firstConnectionId = connection.id;
    draft.addedIds.push(id);
    if (candidate.placement.kind === 'axial') draft.axialTailId = id;
    this.persistDraft(draft);
    this.synchronizeShip(draft.ship);
    this.normalizeSelection();
    this.syncPanel();
  }

  // 末尾追加の逆順を保ち、側面枝を壊さず最後の追加部品だけを撤去する。
  private removeLast(): void {
    const draft = this.current;
    const id = draft?.addedIds.at(-1);
    if (draft === null || id === undefined) return;
    draft.ship.assembly.removeModule(id);
    draft.addedIds.pop();
    const axial = [...draft.addedIds].reverse().find(moduleId => {
      const edge = draft.ship.assembly.graph.find(connection => connection.childId === moduleId);
      return edge?.kind === 'axial';
    });
    draft.axialTailId = axial ?? draft.dockId;
    draft.firstConnectionId = draft.addedIds.length === 0
      ? null
      : draft.ship.assembly.graph.find(edge => edge.childId === draft.addedIds[0])?.id ?? null;
    this.persistDraft(draft);
    this.synchronizeShip(draft.ship);
    this.normalizeSelection();
    this.syncPanel();
  }

  // 物資化の結果だけを確認オーバーレイへ送り、確定処理は別の一回きりの命令へ分ける。
  private finish(): void {
    const draft = this.current;
    if (draft === null || draft.firstConnectionId === null) return;
    const branch = draft.ship.assembly.clone().splitAt(draft.firstConnectionId)[1];
    if (branch.role === 'material') {
      this.confirmation.request({
        title: '操縦不能な物資として完成',
        message: 'この枝にはコックピットがないため、操縦不能な物資として分離されます。続けますか？',
        confirmLabel: '物資として完成', destructive: true,
      }, (confirmed) => { if (confirmed) this.finishConfirmed(); });
      return;
    }
    this.finishConfirmed();
  }

  // 確認済みの枝だけを docking edge と別の建造接続へ確定する。
  private finishConfirmed(): void {
    const draft = this.current;
    if (draft === null || draft.firstConnectionId === null) return;
    draft.ship.assembly.completeConstructionConnection(draft.firstConnectionId);
    draft.ship.docks.finishBuilding(draft.dockId);
    this.drafts.delete(this.key(draft.ship, draft.dockId));
    this.synchronizeShip(draft.ship);
    this.close();
  }

  // 追加部品がある場合だけ、破棄対象と復帰状態を説明して確認する。
  private discard(): void {
    const draft = this.current;
    if (draft === null) return;
    if (draft.addedIds.length > 0) {
      this.confirmation.request({
        title: '建造中の船体を破棄',
        message: '建造中に追加した部品をすべて破棄し、ドックを空き状態へ戻します。続けますか？',
        confirmLabel: '船体を破棄', destructive: true,
      }, (confirmed) => { if (confirmed) this.discardConfirmed(); });
      return;
    }
    this.discardConfirmed();
  }

  // 確認済みの追加部品を逆順に外し、ドックを空き状態へ戻す。
  private discardConfirmed(): void {
    const draft = this.current;
    if (draft === null) return;
    for (const id of [...draft.addedIds].reverse()) draft.ship.assembly.removeModule(id);
    draft.ship.docks.finishBuilding(draft.dockId);
    this.drafts.delete(this.key(draft.ship, draft.dockId));
    this.synchronizeShip(draft.ship);
    this.close();
  }

  // 現在の定義に対する全候補のワールド表示情報を組む。
  private candidates(): readonly ConstructionCandidate[] {
    const draft = this.current;
    if (draft === null) return [];
    const slots = this.slots(draft);
    return slots.flatMap(slot => {
      const candidate = this.candidateFor(draft, slot);
      return candidate === null ? [] : [candidate];
    });
  }

  // 純粋な接続規則へ時刻層の姿勢と原点を適用し、描画可能な候補へ変換する。
  private candidateFor(draft: ConstructionDraft, slot: ConstructionSlot): ConstructionCandidate | null {
    const definition = SHIP_MODULE_CATALOG.require(this.definitionId);
    const placement = placementForSlot(draft.ship.assembly, slot, definition);
    const parentDefinition = draft.ship.assembly.definition(slot.parentId);
    const parentWorld = draft.ship.assembly.worldTransformOf(slot.parentId);
    if (parentDefinition === null || parentWorld === null) return null;
    const assemblyPosition = add(parentWorld.position, qRotate(parentWorld.rotation, placement.transform.position));
    const assemblyRotation = qMul(parentWorld.rotation, placement.transform.rotation);
    const root = sub(
      draft.ship.motion.state.r,
      qRotate(draft.ship.motion.att.q, draft.ship.motion.centerOffset),
    );
    const centerEci = add(root, qRotate(draft.ship.motion.att.q, assemblyPosition));
    const rotationEci = qMul(draft.ship.motion.att.q, assemblyRotation);
    const parentCenter = add(root, qRotate(draft.ship.motion.att.q, parentWorld.position));
    const guideDirection = qRotate(qMul(draft.ship.motion.att.q, parentWorld.rotation), slot.direction);
    const guideDistance = slot.kind === 'side' ? parentDefinition.diameter / 2 : parentDefinition.length / 2;
    return {
      slot, placement, centerEci, rotationEci,
      guideEci: add(parentCenter, scale(guideDirection, guideDistance)),
      guideRadius: Math.min(parentDefinition.diameter, definition.diameter) / 2,
    };
  }

  // パネル・クリック・ゴーストが同じ選択候補を見るための単一参照。
  private selectedCandidate(): ConstructionCandidate | null {
    return this.candidates().find(candidate => candidate.slot.id === this.selectedSlotId) ?? null;
  }

  // 保存ドラフト内の部品だけを対象にして、既存船体の別枝へ候補を漏らさない。
  private slots(draft: ConstructionDraft): readonly ConstructionSlot[] {
    return enumerateConstructionSlots(
      draft.ship.assembly, [draft.dockId, ...draft.addedIds], draft.axialTailId,
    );
  }

  // 撤去や保存データの変化で選択先が消えたとき、軸候補へ安全に戻す。
  private normalizeSelection(): void {
    const draft = this.current;
    if (draft === null) return;
    const slots = this.slots(draft);
    if (slots.some(slot => slot.id === this.selectedSlotId)) return;
    this.selectedSlotId = slots[0]?.id ?? constructionSlotId(draft.axialTailId, 'axial');
  }

  // パネルから来たスロットIDが現在のドラフトに属する場合だけ選択を変える。
  private selectSlot(slotId: string): void {
    if (this.current === null) return;
    if (this.slots(this.current).some(slot => slot.id === slotId)) this.selectedSlotId = slotId;
  }

  // guide の円盤と同じ平面判定を入力側でも使い、見た目とクリック領域を一致させる。
  private hitsCandidate(ray: Ray, candidate: ConstructionCandidate): boolean {
    const normal = qRotate(candidate.rotationEci, LOCAL_FORWARD);
    const denominator = dot(ray.dir, normal);
    if (Math.abs(denominator) < 1e-9) return false;
    const distance = dot(sub(candidate.guideEci, ray.origin), normal) / denominator;
    if (distance < 0) return false;
    const hit = add(ray.origin, scale(ray.dir, distance));
    const offset = sub(hit, candidate.guideEci);
    const radialSq = dot(offset, offset) - dot(offset, normal) ** 2;
    const guideRadius = candidate.guideRadius * (candidate.slot.id === this.selectedSlotId ? 1.15 : 1);
    return radialSq <= guideRadius ** 2;
  }

  private synchronizeShip(ship: ModularShip): void { ship.synchronizeAssemblyState(); }

  // セーブ形式のドラフトへ、追加順と接続根を一度に書き戻す。
  private persistDraft(draft: ConstructionDraft): void {
    draft.ship.docks.updateConstructionDraft({
      dockId: draft.dockId, addedIds: draft.addedIds,
      axialTailId: draft.axialTailId, firstConnectionId: draft.firstConnectionId,
    });
  }

  // 物理のECI座標を、このフレームのfloating origin表示座標へ写す。
  private displayPosition(camera: CameraFrame, position: Vec3): Vec3 {
    const p = camera.floatingOrigin.RtoThreeV3(position);
    return v3(p.x, p.y, p.z);
  }

  // ゲーム状態を構造化したHUD snapshotへ変換し、無効候補も必ず表示へ残す。
  private syncPanel(): void {
    const draft = this.current;
    if (draft === null) return;
    this.normalizeSelection();
    const slots = this.slots(draft);
    const definition = SHIP_MODULE_CATALOG.require(this.definitionId);
    const selected = this.selectedCandidate();
    const branch = draft.firstConnectionId === null
      ? null : draft.ship.assembly.clone().splitAt(draft.firstConnectionId)[1];
    const totals = branch?.totals();
    const capabilities = {
      thrust: totals?.thrust ?? 0, mainFuel: totals?.mainFuel ?? 0, rcsFuel: totals?.rcsFuel ?? 0,
      power: totals?.power ?? 0, radiation: totals?.radiation ?? 0,
    };
    const preview = selected?.placement.valid ? previewFor(definition, capabilities, totals?.mass ?? 0, totals?.maxHp ?? 0) : null;
    const role = branch?.role ?? 'material';
    const slotStates: readonly ConstructionSlotState[] = slots.map(slot => {
      const placement = placementForSlot(draft.ship.assembly, slot, definition);
      return slotState(slot, placement);
    });
    const selectedState = slotStates.find(slot => slot.id === this.selectedSlotId);
    const warning = selected?.placement.reason ?? selectedState?.reason
      ?? (role === 'material' && draft.addedIds.length > 0 ? '操縦不能な物資として完成します' : null);
    const dockDefinition = draft.ship.assembly.definition(draft.dockId);
    this.panel.sync({
      visible: true, shipName: draft.ship.name,
      dockLabel: `${dockDefinition?.name ?? '建造ドック'} / ${draft.dockId}`,
      moduleCount: draft.addedIds.length, totalMass: branch?.totalMass ?? 0,
      hp: totals?.hp ?? 0, maxHp: totals?.maxHp ?? 0, capabilities, preview, role, warning,
      selectedDefinitionId: definition.id, selectedModuleName: definition.name,
      selectedSlotId: this.selectedSlotId, slots: slotStates,
      canPlace: selected?.placement.valid ?? false,
      canRemove: draft.addedIds.length > 0, canFinish: draft.firstConnectionId !== null,
    });
  }

  private key(ship: ModularShip, dockId: string): string { return `${ship.id}:${dockId}`; }
}

// 初期配置される燃料を含めた、現在枝への追加後の表示見積りを作る。
function previewFor(
  definition: ReturnType<typeof SHIP_MODULE_CATALOG.require>,
  current: ShipConstructionPanelModel['capabilities'], mass: number, maxHp: number,
): NonNullable<ShipConstructionPanelModel['preview']> {
  const abilities = definition.abilities;
  const fuel = abilities.fuelCapacity ?? 0;
  const fuelKind = abilities.fuelKind;
  return {
    mass: mass + definition.dryMass + fuel * (abilities.fuelMassPerUnit ?? 1),
    maxHp: maxHp + definition.maxHp,
    capabilities: {
      thrust: current.thrust + (abilities.thrust ?? 0),
      mainFuel: current.mainFuel + (fuelKind === 'main' ? fuel : 0),
      rcsFuel: current.rcsFuel + (fuelKind === 'rcs' ? fuel : 0),
      power: current.power + (abilities.powerGeneration ?? 0),
      radiation: current.radiation + (abilities.radiationArea ?? 0),
    },
  };
}

// モードを閉じた直後もUIが保持する selection/DOM callback を安全な空状態へ戻す。
function hiddenModel(): ShipConstructionPanelModel {
  return {
    visible: false, shipName: '—', dockLabel: '—', moduleCount: 0, totalMass: 0, hp: 0, maxHp: 0,
    capabilities: { thrust: 0, mainFuel: 0, rcsFuel: 0, power: 0, radiation: 0 }, preview: null,
    role: 'material', warning: null, selectedDefinitionId: 'cockpit-standard',
    selectedModuleName: 'コックピット', selectedSlotId: 'axial', slots: [],
    canPlace: false, canRemove: false, canFinish: false,
  };
}

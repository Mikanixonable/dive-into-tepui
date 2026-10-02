// ドック起点の建造セッションを持ち、ゲームの配置規則をHUD・ゴースト・候補ガイドへ同期する。
import { v3, type Vec3 } from '../../math/vec3';
import { DockSnapGuideView, type DockSnapGuideDisplay } from '../../render/dynamic/ship/dock-snap-guide-view';
import { ShipGhostView } from '../../render/dynamic/ship/ship-ghost-view';
import {
  constructionSlotId, enumerateConstructionSlots, placementForSlot, slotState,
  type ConstructionSlot,
} from './ship-construction-rules';
import { constructionCandidate, hitsConstructionCandidate, type ConstructionCandidate } from './ship-construction-candidates';
import { SHIP_MODULE_CATALOG } from './ship-module-catalog';
import { ShipConstructionEdits } from './ship-construction-edits';
import { CommandCompletion } from '../command-completion';
import type * as THREE from 'three/webgpu';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { OverlayHandle, OverlayManager } from '../../hud/overlay-manager';
import type { Input } from '../../input/input';
import type { Viewport } from '../../render/viewport';
import type { CameraSystem } from '../camera/camera-system';
import type { DisplayWindowManager } from '../display-window-manager';
import type {
  ConstructionConfirmationPort, ConstructionSlotState, ShipConstructionPanelModel,
} from './ship-construction-types';
import type { Notifier } from '../../hud/notifier';
import type { CommandQueue } from '../command-queue';
import type { ShipConstructionDraftState } from './ship-dock-state';
import type { ModularShip } from './modular-ship';

interface ConstructionDraft extends ShipConstructionDraftState {
  readonly ship: ModularShip;
}

interface ConstructionSession {
  readonly ship: ModularShip;
  readonly dockId: string;
  readonly edits: ShipConstructionEdits;
}

type ConstructionAction = 'begin' | 'place' | 'remove' | 'finish' | 'discard';

interface PendingConstructionCommand {
  readonly session: ConstructionSession;
  readonly action: ConstructionAction;
  readonly completion: CommandCompletion;
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
  private current: ConstructionSession | null = null;
  private pending: PendingConstructionCommand[] = [];
  private definitionId = 'cockpit-standard';
  private selectedSlotId = 'axial';
  private previousForceCurrent = false;

  // 建造規則の結果を、既存のHUD・入力・表示時刻の各装置へ接続する。
  public constructor(
    scene: THREE.Scene,
    private readonly commands: CommandQueue,
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
    const session: ConstructionSession = { ship, dockId, edits: new ShipConstructionEdits(ship, dockId) };
    this.current = session;
    this.submit(session, 'begin', () => session.edits.begin());
    this.normalizeSelection();
    this.focusDock?.(ship);
    this.previousForceCurrent = this.displayWindow.current.forceCurrent;
    this.displayWindow.setForceCurrent(true);
    this.overlayManager.openMode('ship-construction-mode', this, {
      closeOnEscape: true, closeOnOutsideClick: false, gatesInput: false, pausesGame: true,
    });
    this.syncPanel();
  }

  // 建造パネル内の操作かを判定する。
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
      const hit = this.candidates().find(candidate => hitsConstructionCandidate(
        ray, candidate, candidate.slot.id === this.selectedSlotId,
      ));
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
    this.syncCommandResults();
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

  // 選択時点の部品とスロットを捕捉し、配置の命令を受け付ける。
  private place(): void {
    const session = this.current;
    const candidate = this.selectedCandidate();
    if (session === null || candidate === null || !candidate.placement.valid) {
      if (candidate?.placement.reason) this.notifier.hint(candidate.placement.reason, undefined, 'warn');
      return;
    }
    const definitionId = this.definitionId;
    const slotId = this.selectedSlotId;
    this.submit(session, 'place', () => {
      let id: string;
      do id = `construction-${nextConstructionModule++}`;
      while (session.ship.assembly.module(id) !== null);
      session.edits.place(definitionId, slotId, id);
    });
  }

  // 最後に追加した部品を撤去する命令を受け付ける。
  private removeLast(): void {
    const session = this.current;
    if (session !== null) this.submit(session, 'remove', () => session.edits.removeLast());
  }

  // 物資化の結果だけを確認オーバーレイへ送り、確定処理は別の一回きりの命令へ分ける。
  private finish(): void {
    const session = this.current;
    if (session === null) return;
    const draft = this.currentDraft();
    if (draft === null || draft.firstConnectionId === null) return;
    const branch = draft.ship.assembly.clone().splitAt(draft.firstConnectionId)[1];
    if (branch.role === 'material') {
      this.confirmation.request({
        title: '操縦不能な物資として完成',
        message: 'この枝にはコックピットがないため、操縦不能な物資として分離されます。続けますか？',
        confirmLabel: '物資として完成', destructive: true,
      }, (confirmed) => { if (confirmed) this.finishConfirmed(session); });
      return;
    }
    this.finishConfirmed(session);
  }

  // 確認したセッションの枝を完成させる命令を受け付ける。
  private finishConfirmed(session: ConstructionSession): void {
    this.submit(session, 'finish', () => session.edits.finish());
  }

  // 追加部品がある場合だけ、破棄対象と復帰状態を説明して確認する。
  private discard(): void {
    const session = this.current;
    if (session === null) return;
    const draft = this.currentDraft();
    if (draft === null) return;
    if (draft.addedIds.length > 0) {
      this.confirmation.request({
        title: '建造中の船体を破棄',
        message: '建造中に追加した部品をすべて破棄し、ドックを空き状態へ戻します。続けますか？',
        confirmLabel: '船体を破棄', destructive: true,
      }, (confirmed) => { if (confirmed) this.discardConfirmed(session); });
      return;
    }
    this.discardConfirmed(session);
  }

  // 確認したセッションの追加部品を破棄する命令を受け付ける。
  private discardConfirmed(session: ConstructionSession): void {
    this.submit(session, 'discard', () => session.edits.discard());
  }

  // 現在の定義に対する全候補のワールド表示情報を組む。
  private candidates(): readonly ConstructionCandidate[] {
    const draft = this.currentDraft();
    if (draft === null) return [];
    const slots = this.slots(draft);
    const definition = SHIP_MODULE_CATALOG.require(this.definitionId);
    return slots.flatMap(slot => {
      const candidate = constructionCandidate(
        draft.ship.assembly, slot, definition,
        draft.ship.motion.state.r, draft.ship.motion.att.q, draft.ship.motion.centerOffset,
      );
      return candidate === null ? [] : [candidate];
    });
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
    const draft = this.currentDraft();
    if (draft === null) return;
    const slots = this.slots(draft);
    if (slots.some(slot => slot.id === this.selectedSlotId)) return;
    this.selectedSlotId = slots[0]?.id ?? constructionSlotId(draft.axialTailId, 'axial');
  }

  // パネルから来たスロットIDが現在のドラフトに属する場合だけ選択を変える。
  private selectSlot(slotId: string): void {
    const draft = this.currentDraft();
    if (draft !== null && this.slots(draft).some(slot => slot.id === slotId)) this.selectedSlotId = slotId;
  }

  // 船側の予約から、表示に使う建造枝を読み取る。予約開始前・終了後はnull。
  private currentDraft(): ConstructionDraft | null {
    const session = this.current;
    const saved = session?.edits.draft ?? null;
    return session === null || saved === null ? null : { ...saved, ship: session.ship };
  }

  // 応答を操作途中の状態として保持し、モデル編集を次の進行へ送る。
  private submit(session: ConstructionSession, action: ConstructionAction, apply: () => void): void {
    if (this.pending.some(command => command.session === session
      && (command.action === 'finish' || command.action === 'discard'))) return;
    const completion = new CommandCompletion();
    this.pending.push({ session, action, completion });
    this.commands.submitWithCompletion(apply, completion);
  }

  // 適用済みの応答を表示へ反映する。再開した別セッションの開閉には影響させない。
  private syncCommandResults(): void {
    for (const command of this.pending) {
      const state = command.completion.state;
      if (state.kind === 'pending') continue;
      if (state.kind === 'failed') {
        this.notifier.hint(state.error instanceof Error ? state.error.message : '建造操作に失敗しました', undefined, 'warn');
        if (command.action === 'begin' && this.current === command.session) this.close();
      } else if ((command.action === 'finish' || command.action === 'discard')
        && this.current === command.session) {
        this.close();
      }
    }
    // 適用待ちの応答を次の同期へ残す。
    this.pending = this.pending.filter(command => command.completion.state.kind === 'pending');
  }

  // 物理のECI座標を、このフレームのfloating origin表示座標へ写す。
  private displayPosition(camera: CameraFrame, position: Vec3): Vec3 {
    const p = camera.floatingOrigin.RtoThreeV3(position);
    return v3(p.x, p.y, p.z);
  }

  // ゲーム状態を構造化したHUD snapshotへ変換し、無効候補も必ず表示へ残す。
  private syncPanel(): void {
    const draft = this.currentDraft();
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

// 建造セッションの状態と命令の所有者: 起点ドック・手持ち・選択・向き・対称数・
// 指している取り付け先・取り消し履歴を持ち、船体への編集は命令として列へ積む。
import { qFromUnitVectors, qMul, qRotate, LOCAL_FORWARD } from '../../math/quat';
import { add, sub, v3, type Vec3 } from '../../math/vec3';
import { DockSnapGuideView, type DockSnapGuideDisplay } from '../../render/dynamic/ship/dock-snap-guide-view';
import { ShipGhostView, type ShipGhostDisplay } from '../../render/dynamic/ship/ship-ghost-view';
import {
  constructionModuleLabel, constructionTargetId, enumerateConstructionTargets, heldRootDefinition,
  placementFor, type ConstructionTargetInfo,
} from './ship-construction-rules';
import { constructionTargetGuide } from './ship-construction-candidates';
import { tryConstructionPlacement, type ConstructionTrial } from './ship-construction-preview';
import { SHIP_MODULE_CATALOG } from './ship-module-catalog';
import { ShipConstructionEdits } from './ship-construction-edits';
import { ConstructionHistory } from './ship-construction-history';
import { pieceOfModule } from './ship-assembly-graft';
import {
  axialPlacementFromTransform, inverseTransform, sideRollFromTransform,
  type ModuleOrientation,
} from './ship-assembly-transform';
import { serializeShipAssembly } from './ship-save';
import {
  hiddenShipConstructionModel,
  type ConstructionConfirmationPort, type ConstructionDeniedRecord,
  type ConstructionHeld, type ConstructionHistoryView, type ConstructionOperationRecord,
  type ConstructionSymmetry, type ShipConstructionPanelModel,
} from './ship-construction-types';
import { CommandCompletion } from '../command-completion';
import type * as THREE from 'three/webgpu';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { OverlayHandle, OverlayManager } from '../../hud/overlay-manager';
import type { Input } from '../../input/input';
import type { Viewport } from '../../render/viewport';
import type { CameraSystem } from '../camera/camera-system';
import type { DisplayWindowManager } from '../display-window-manager';
import type { Notifier } from '../../hud/notifier';
import type { CommandQueue } from '../command-queue';
import type { ModularShip } from './modular-ship';

interface ConstructionSession {
  readonly ship: ModularShip;
  readonly anchorId: string;
  readonly edits: ShipConstructionEdits;
  readonly history: ConstructionHistory;
}

// 命令の種別。'restore' は取り消し系で、成功時に履歴位置を動かす。
type ConstructionAction = 'place' | 'move' | 'remove' | 'reorient' | 'restore';

interface PendingConstructionCommand {
  readonly session: ConstructionSession;
  readonly action: ConstructionAction;
  readonly completion: CommandCompletion;
  // 成功時に履歴へ積む操作名。restore は代わりに履歴の位置をここへ動かす。
  readonly historyName: string;
  readonly historyIndex: number | null;
  // 成功時の操作記録へ載せる、動いたモジュールの識別子。
  readonly moduleIds: readonly string[];
  // 健全なコックピットを失う確定済みの操作は、成功したら閉じる。
  readonly closeOnSuccess: boolean;
  // 適用の中で捕捉した、その操作直後の船体の写し。
  snapshot: ReturnType<typeof serializeShipAssembly> | null;
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

// 一度に一つの建造セッションを所有し、船体の編集を命令へ、表示へ同期する。
export class ShipConstruction implements OverlayHandle {
  private readonly ghost: ShipGhostView;
  private readonly guide: DockSnapGuideView;
  private current: ConstructionSession | null = null;
  private pending: PendingConstructionCommand[] = [];
  private heldValue: ConstructionHeld | null = null;
  private selectedId: string | null = null;
  private orientation: ModuleOrientation = { roll: 0, face: 'back' };
  private symmetry: ConstructionSymmetry = 1;
  private pointedId: string | null = null;
  private previousForceCurrent = false;
  private operationSequence = 0;
  private operation: ConstructionOperationRecord | null = null;
  private denied: ConstructionDeniedRecord | null = null;
  private trialCache: { readonly signature: string; readonly trial: ConstructionTrial } | null = null;

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
    // パネルの操作を建造の各操作へ繋ぐ。
    panel.onSelectionChange = (definitionId) => {
      if (this.heldValue?.kind === 'catalog' && this.heldValue.definitionId === definitionId) {
        this.release();
      } else {
        this.hold({ kind: 'catalog', definitionId });
      }
      this.syncPanel();
    };
    panel.onSlotChange = (slotId) => {
      this.setPointedTarget(slotId);
      this.syncPanel();
    };
    panel.onPlace = () => {
      // 手持ちが無く選択中のモジュールがあるとき、配置は付け替えとして働く。
      if (this.heldValue !== null) this.placeAt();
      else if (this.selectedId !== null && this.pointedId !== null) {
        this.moveSelectedTo(this.pointedId);
      }
      this.syncPanel();
    };
    panel.onRemove = () => this.removeSelected();
    panel.onFinish = () => this.close();
    panel.onDiscard = () => this.revertAll();
  }

  public get active(): boolean { return this.current !== null; }

  // ---- セッションの読み取り面 ----
  public get sessionShip(): ModularShip | null { return this.current?.ship ?? null; }
  public get anchorId(): string | null { return this.current?.anchorId ?? null; }
  public get held(): ConstructionHeld | null { return this.heldValue; }
  public get selectedModuleId(): string | null { return this.selectedId; }
  public get currentOrientation(): ModuleOrientation { return this.orientation; }
  public get symmetryCount(): ConstructionSymmetry { return this.symmetry; }
  public get pointedTargetId(): string | null { return this.pointedId; }
  public get lastOperation(): ConstructionOperationRecord | null { return this.operation; }
  public get lastDenied(): ConstructionDeniedRecord | null { return this.denied; }

  // 船体全体の空いている取り付け先。
  public targets(): readonly ConstructionTargetInfo[] {
    const session = this.current;
    return session === null ? [] : enumerateConstructionTargets(session.ship.assembly, session.anchorId);
  }

  // 指している取り付け先へ手持ちを置いた結果。指す先・手持ち・向き・対称数・船体が
  // 変わったときだけ計算し直してキャッシュする。
  public pointedTrial(): ConstructionTrial | null {
    const session = this.current;
    const held = this.effectiveHeld();
    const target = this.pointedTarget();
    if (session === null || held === null || target === null) return null;
    const orientation = this.effectiveOrientation(session, held);
    const signature = this.trialSignature(session, held, target, orientation);
    if (this.trialCache?.signature !== signature) {
      this.trialCache = {
        signature,
        trial: tryConstructionPlacement(
          session.ship.assembly, session.anchorId, held, target.target, orientation, this.symmetry,
        ),
      };
    }
    return this.trialCache.trial;
  }

  // 履歴の名前の列・現在位置・取り消し/やり直し可否。適用待ちの編集がある間は動けない。
  public history(): ConstructionHistoryView {
    const history = this.current?.history ?? null;
    const movable = this.pending.length === 0;
    return {
      names: history?.names ?? [],
      position: history?.position ?? 0,
      canUndo: movable && (history?.canUndo ?? false),
      canRedo: movable && (history?.canRedo ?? false),
    };
  }

  // ---- 命令 ----

  // dock が健全で船体が操縦可能ならセッションを開く。接続中のドックでも始められる。
  public start(ship: ModularShip, dockId: string): void {
    const module = ship.assembly.module(dockId);
    if (module?.kind !== 'dock') throw new Error(`not a construction dock: ${dockId}`);
    if (!ship.capabilities.controllable) throw new Error('健全なコックピットから操作できる船体が必要です');
    if (module.hp <= 0 || !ship.motion.alive) throw new Error('健全な接舷部が必要です');
    if (this.current !== null) this.close();
    this.current = {
      ship, anchorId: dockId,
      edits: new ShipConstructionEdits(ship, dockId),
      history: new ConstructionHistory(serializeShipAssembly(ship.assembly)),
    };
    this.heldValue = null;
    this.selectedId = null;
    this.orientation = { roll: 0, face: 'back' };
    this.symmetry = 1;
    this.pointedId = null;
    this.trialCache = null;
    // 建造モードの入力と表示時刻の境界を開く。
    this.focusDock?.(ship);
    this.previousForceCurrent = this.displayWindow.current.forceCurrent;
    this.displayWindow.setForceCurrent(true);
    this.overlayManager.openMode('ship-construction-mode', this, {
      closeOnEscape: true, closeOnOutsideClick: false, gatesInput: false, pausesGame: true,
    });
    this.syncPanel();
  }

  // 変更を残して閉じる。ESC(共通オーバーレイ管理)もこの口を通る。
  public close(): void {
    if (this.current === null) return;
    this.confirmation.close();
    this.current = null;
    this.heldValue = null;
    this.selectedId = null;
    this.pointedId = null;
    this.trialCache = null;
    this.overlayManager.close('ship-construction-mode');
    this.displayWindow.setForceCurrent(this.previousForceCurrent);
    this.panel.sync(hiddenShipConstructionModel());
    this.ghost.sync([]);
    this.guide.syncAll([]);
  }

  // 手持ちにする。piece は配置済みモジュールの先端部、copy は写しの先端部。
  public hold(held: ConstructionHeld): void {
    const session = this.current;
    if (session === null) return;
    if (held.kind === 'piece') {
      if (held.moduleId === session.anchorId) { this.deny('起点のドックは動かせません'); return; }
      if (session.ship.assembly.module(held.moduleId) === null) { this.deny('その部品は掴めません'); return; }
      this.orientation = this.orientationOfPiece(session, held.moduleId) ?? this.orientation;
    } else {
      const definition = heldRootDefinition(session.ship.assembly, held);
      this.orientation = {
        roll: 0,
        face: definition !== null && definition.axialFaces.back !== 'structural' ? 'front' : 'back',
      };
    }
    this.heldValue = held;
    this.trialCache = null;
    this.syncPanel();
  }

  // 手に持ったものを手放す。
  public release(): void {
    this.heldValue = null;
    this.trialCache = null;
    this.syncPanel();
  }

  // 配置済みモジュールを選ぶ。起点ドックは選べない。
  public select(moduleId: string | null): void {
    const session = this.current;
    if (session === null) return;
    if (moduleId === null) { this.selectedId = null; this.syncPanel(); return; }
    if (moduleId === session.anchorId) { this.deny('起点のドックは選べません'); return; }
    if (session.ship.assembly.module(moduleId) === null) { this.deny('その部品は選べません'); return; }
    this.selectedId = moduleId;
    this.syncPanel();
  }

  // 指している取り付け先を変える。列挙に無い id は指せない。
  public setPointedTarget(targetId: string | null): void {
    if (targetId !== null && !this.targets().some(info => constructionTargetId(info.target) === targetId)) {
      return;
    }
    if (this.pointedId !== targetId) this.trialCache = null;
    this.pointedId = targetId;
    this.syncPanel();
  }

  // 手持ちを指している/指定の取り付け先へ置く命令を受け付ける。
  public placeAt(targetId?: string): void {
    const session = this.current;
    const held = this.heldValue;
    if (session === null) return;
    if (held === null) { this.deny('手に部品を持っていません'); return; }
    const info = targetId !== undefined
      ? this.targets().find(entry => constructionTargetId(entry.target) === targetId) ?? null
      : this.pointedTarget();
    if (info === null) { this.deny('取り付け先を選んでください'); return; }
    const trial = targetId !== undefined
      ? tryConstructionPlacement(
        session.ship.assembly, session.anchorId, held, info.target, this.orientation, this.symmetry,
      )
      : this.pointedTrial();
    if (trial === null || !trial.valid) {
      this.deny(trial?.reason ?? 'ここには置けません');
      return;
    }
    const newIds = this.allocateIds(session, held, info);
    const name = held.kind === 'piece'
      ? `${constructionModuleLabel(session.ship.assembly, held.moduleId)} を付け替え`
      : info.target.kind === 'joint'
        ? `${this.heldName(session, held)} を割り込み`
        : `${this.heldName(session, held)} を配置`;
    // 手持ちの写しから置くものは、置いた時点で手から離れるのではなく持ち続ける。
    const releasesHand = held.kind === 'piece';
    this.submit(session, 'place', name, this.placedIds(session, held, newIds), false, null, () => {
      session.edits.place(held, info.target, this.orientation, this.symmetry, newIds);
    });
    if (releasesHand) this.heldValue = null;
    this.trialCache = null;
  }

  // 選択中のモジュールを先端部ごと取り付け先へ付け替える。
  public moveSelectedTo(targetId: string): void {
    const session = this.current;
    const moduleId = this.selectedId;
    if (session === null) return;
    if (moduleId === null) { this.deny('付け替える部品を選んでください'); return; }
    const info = this.targets().find(entry => constructionTargetId(entry.target) === targetId) ?? null;
    if (info === null) { this.deny('取り付け先を選んでください'); return; }
    const held: ConstructionHeld = { kind: 'piece', moduleId };
    const orientation = this.orientationOfPiece(session, moduleId) ?? this.orientation;
    const trial = tryConstructionPlacement(
      session.ship.assembly, session.anchorId, held, info.target, orientation, 1,
    );
    if (!trial.valid) { this.deny(trial.reason ?? 'ここには付け替えられません'); return; }
    const name = `${constructionModuleLabel(session.ship.assembly, moduleId)} を付け替え`;
    this.submit(session, 'move', name, [moduleId], false, null,
      () => session.edits.move(moduleId, info.target, orientation));
    this.trialCache = null;
  }

  // 選択中のモジュールを先端部ごと撤去する。健全なコックピットを全て失うときは確認を挟み、
  // 確定した操作が成功したら建造を閉じる。
  public removeSelected(): void {
    const session = this.current;
    const moduleId = this.selectedId;
    if (session === null) return;
    if (moduleId === null) { this.deny('撤去する部品を選んでください'); return; }
    if (!this.pieceEditable(session, moduleId)) {
      this.deny('接舷中の接続の先は、建造では編集できません');
      return;
    }
    const work = session.ship.assembly.clone();
    try {
      work.detachPiece(moduleId, session.anchorId);
    } catch (error) {
      this.deny(error instanceof Error ? error.message : 'その部品は撤去できません');
      return;
    }
    const losesCockpit = !work.modules.some(module => module.kind === 'cockpit' && module.hp > 0);
    const name = `${constructionModuleLabel(session.ship.assembly, moduleId)} を撤去`;
    const apply = (): void => session.edits.remove(moduleId);
    if (losesCockpit) {
      this.confirmation.request({
        title: '健全なコックピットを失う撤去',
        message: 'この撤去で船体から健全なコックピットがすべて失われ、操縦不能な物資になります。続けますか？',
        confirmLabel: '撤去して閉じる', destructive: true,
      }, (confirmed) => {
        if (confirmed) this.submit(session, 'remove', name, [moduleId], true, null, apply);
      });
      return;
    }
    this.submit(session, 'remove', name, [moduleId], false, null, apply);
    this.selectedId = null;
    this.trialCache = null;
  }

  // 手持ちがあればその向きを、無ければ選択中のモジュールを先端部ごと 90° 回す。
  public rotate(delta: 1 | -1): void {
    const session = this.current;
    if (session === null) return;
    if (this.heldValue !== null) {
      this.orientation = {
        ...this.orientation,
        roll: ((this.orientation.roll + delta + 4) % 4) as ModuleOrientation['roll'],
      };
      this.trialCache = null;
      this.syncPanel();
      return;
    }
    const moduleId = this.selectedId;
    if (moduleId === null) { this.deny('回す部品を選んでください'); return; }
    const current = this.orientationOfPiece(session, moduleId) ?? { roll: 0 as const, face: 'back' as const };
    const orientation: ModuleOrientation = {
      roll: ((current.roll + delta + 4) % 4) as ModuleOrientation['roll'], face: current.face,
    };
    this.submit(session, 'reorient',
      `${constructionModuleLabel(session.ship.assembly, moduleId)} を回転`, [moduleId], false, null,
      () => session.edits.reorient(moduleId, orientation));
    this.trialCache = null;
  }

  // 手持ち・選択中の取り付ける端を入れ替える。両端に取り付け面を持つ部品だけで効く。
  public swapEnds(): void {
    const session = this.current;
    if (session === null) return;
    if (this.heldValue !== null) {
      const definition = heldRootDefinition(session.ship.assembly, this.heldValue);
      const next = this.orientation.face === 'front' ? 'back' : 'front';
      if (definition === null || definition.axialFaces[next] !== 'structural') {
        this.deny('この部品は端を入れ替えられません');
        return;
      }
      this.orientation = { ...this.orientation, face: next };
      this.trialCache = null;
      this.syncPanel();
      return;
    }
    const moduleId = this.selectedId;
    if (moduleId === null) { this.deny('端を入れ替える部品を選んでください'); return; }
    const definition = session.ship.assembly.definition(moduleId);
    const current = this.orientationOfPiece(session, moduleId) ?? { roll: 0 as const, face: 'back' as const };
    const next = current.face === 'front' ? 'back' : 'front';
    if (definition === null || definition.axialFaces[next] !== 'structural') {
      this.deny('この部品は端を入れ替えられません');
      return;
    }
    this.submit(session, 'reorient',
      `${constructionModuleLabel(session.ship.assembly, moduleId)} の端を入れ替え`, [moduleId], false, null,
      () => session.edits.reorient(moduleId, { ...current, face: next }));
    this.trialCache = null;
  }

  // 側面へ置く対称数を 1 → 2 → 4 と巡らせる。
  public cycleSymmetry(): void {
    this.symmetry = this.symmetry === 1 ? 2 : this.symmetry === 2 ? 4 : 1;
    this.trialCache = null;
    this.syncPanel();
  }

  // 選択中のモジュールの先端部の写しを手に取る。
  public duplicateSelected(): void {
    const session = this.current;
    const moduleId = this.selectedId;
    if (session === null) return;
    if (moduleId === null) { this.deny('複製する部品を選んでください'); return; }
    try {
      const piece = session.ship.assembly.clone().detachPiece(moduleId, session.anchorId);
      this.hold({ kind: 'copy', piece });
    } catch (error) {
      this.deny(error instanceof Error ? error.message : 'その部品は複製できません');
    }
  }

  // ---- 履歴(適用待ちがある間は受け付けない) ----

  private revertTo(index: number): void {
    const session = this.current;
    if (session === null) return;
    if (this.pending.length > 0) { this.deny('適用待ちの編集があります'); return; }
    const target = session.history.target(index);
    if (target === null) { this.deny('その時点へは戻れません'); return; }
    this.submit(session, 'restore', '履歴の時点へ戻す', [], false, index,
      () => session.edits.replaceAssembly(target));
    this.trialCache = null;
  }

  public undo(): void {
    const position = this.current?.history.position ?? 0;
    this.revertTo(position - 1);
  }

  public redo(): void {
    const position = this.current?.history.position ?? 0;
    this.revertTo(position + 1);
  }

  public jumpToHistory(index: number): void { this.revertTo(index); }

  // 建造を始めてからの変更をすべて取り消し、開始時の船体へ戻す。確認したときだけ行う。
  public revertAll(): void {
    const session = this.current;
    if (session === null) return;
    if (session.history.entriesView.length <= 1) return;
    this.confirmation.request({
      title: '変更をすべて取り消す',
      message: '建造を始めてからの変更をすべて取り消し、開始時の船体へ戻します。続けますか？',
      confirmLabel: 'すべて取り消す', destructive: true,
    }, (confirmed) => { if (confirmed) this.revertTo(0); });
  }

  // 建造パネル内の操作かを判定する。
  public contains(target: Node): boolean { return this.panel.element.contains(target); }

  // クリックは指している取り付け先への配置、取り付け先以外ではモジュールの選択、
  // 右クリックは手放す。候補ノードやドラッグの判定は後の作業で切り出す。
  public handlePointer(input: Input, camera: CameraSystem, viewport: Viewport): boolean {
    const session = this.current;
    if (session === null) return false;
    input.takeClicks((point) => {
      if (this.heldValue !== null) {
        this.placeAt();
        return true;
      }
      const ray = camera.rayThroughScreen(point.x, point.y, viewport);
      const hit = session.ship.motion.raycastCompound(ray, session.ship.motion.state.r);
      // 起点ドックは選べないので、クリックしても選択を変えない。
      if (hit === null) {
        this.select(null);
      } else if (hit.moduleId !== session.anchorId) {
        this.select(hit.moduleId);
      }
      return true;
    });
    input.takeRightClicks(() => {
      if (this.heldValue !== null) this.release();
      return true;
    });
    return true;
  }

  // 適用済みの命令を読み、指している取り付け先だけへガイドとゴーストを宣言する。
  public sync(camera: CameraFrame): void {
    this.syncCommandResults();
    const session = this.current;
    if (session === null) {
      this.ghost.sync([]);
      this.guide.syncAll([]);
      return;
    }
    this.normalizeSelection();
    const held = this.effectiveHeld();
    const target = this.pointedTarget();
    const trial = this.pointedTrial();
    // 指している取り付け先だけに接続面のリングを出す。
    const guides: DockSnapGuideDisplay[] = [];
    if (held !== null && target !== null) {
      const guide = constructionTargetGuide(
        session.ship.assembly, session.anchorId, held, target,
        this.effectiveOrientation(session, held), this.symmetry,
        session.ship.motion.state.r, session.ship.motion.att.q, session.ship.motion.centerOffset,
      );
      if (guide !== null) {
        guides.push({
          id: constructionTargetId(target.target),
          position: this.displayPosition(camera, guide.guideEci),
          rotation: qFromUnitVectors(LOCAL_FORWARD, guide.normalEci),
          radius: guide.guideRadius,
          valid: guide.placement.valid && (trial?.valid ?? false),
          selected: true,
        });
      }
    }
    this.guide.syncAll(guides);
    // 試し置きで置いたモジュールをゴーストとして出す。
    const displays: ShipGhostDisplay[] = [];
    if (held !== null && trial !== null) {
      for (const placed of trial.placed) {
        displays.push({
          modelId: this.placedModelId(session, held, placed.moduleId),
          position: this.displayPosition(camera, this.eciOfAssembly(session, placed.transform.position)),
          rotation: qMul(session.ship.motion.att.q, placed.transform.rotation),
          valid: trial.valid,
        });
      }
    }
    this.ghost.sync(displays);
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

  // ---- 内部の導出 ----

  // 試し置き・ガイドが読む手持ち。手が空いていて選択中のモジュールがあれば、その先端部を仮に持つ。
  private effectiveHeld(): ConstructionHeld | null {
    if (this.heldValue !== null) return this.heldValue;
    return this.selectedId === null ? null : { kind: 'piece', moduleId: this.selectedId };
  }

  // 指している取り付け先の一覧項目。無ければ null。
  private pointedTarget(): ConstructionTargetInfo | null {
    if (this.pointedId === null) return null;
    return this.targets().find(info => constructionTargetId(info.target) === this.pointedId) ?? null;
  }

  // 試し置きが読む向き。実際の手持ちは現在の向き、選択中モジュールの仮の手持ちはその根元の向き。
  private effectiveOrientation(session: ConstructionSession, held: ConstructionHeld): ModuleOrientation {
    if (held.kind === 'piece' && this.heldValue === null) {
      return this.orientationOfPiece(session, held.moduleId) ?? this.orientation;
    }
    return this.orientation;
  }

  // 試し置きの結果が効く入力をすべて並べた署名。
  private trialSignature(
    session: ConstructionSession, held: ConstructionHeld,
    target: ConstructionTargetInfo, orientation: ModuleOrientation,
  ): string {
    const heldKey = held.kind === 'catalog' ? `catalog:${held.definitionId}`
      : held.kind === 'piece' ? `piece:${held.moduleId}`
        : `copy:${held.piece.moduleIds.join(',')}`;
    const { assembly } = session.ship;
    return [
      constructionTargetId(target.target), heldKey,
      orientation.roll, orientation.face, this.symmetry,
      assembly.size, assembly.graph.length, Math.round(assembly.totalHp * 8),
    ].join('|');
  }

  // 手持ち・選択が消えたモジュールや列挙から落ちた取り付け先を指さないように戻す。
  private normalizeSelection(): void {
    const session = this.current;
    if (session === null) return;
    if (this.selectedId !== null && session.ship.assembly.module(this.selectedId) === null) {
      this.selectedId = null;
    }
    if (this.heldValue?.kind === 'piece' && session.ship.assembly.module(this.heldValue.moduleId) === null) {
      this.heldValue = null;
    }
    if (this.pointedId !== null && this.pointedTarget() === null) this.pointedId = null;
  }

  // 配置済みモジュールの根元の接続から、いまの向きを読み戻す。読めなければ null。
  private orientationOfPiece(session: ConstructionSession, moduleId: string): ModuleOrientation | null {
    const { assembly } = session.ship;
    const piece = pieceOfModule(assembly.graph, session.anchorId, moduleId);
    if (piece === null) return null;
    const edge = piece.rootConnection;
    const mounted = edge.parentId === moduleId ? inverseTransform(edge.childTransform) : edge.childTransform;
    if (edge.kind === 'axial' || edge.kind === 'construction') {
      return axialPlacementFromTransform(mounted)?.orientation ?? null;
    }
    if (edge.kind === 'side' && edge.sideSlot !== undefined) {
      const ownerId = edge.sideReversed === true ? edge.childId : edge.parentId;
      const ownerDefinition = assembly.definition(ownerId);
      const otherId = ownerId === edge.parentId ? edge.childId : edge.parentId;
      const otherDefinition = assembly.definition(otherId);
      if (ownerDefinition === null || otherDefinition === null) return null;
      const inOwnerFrame = ownerId === moduleId ? inverseTransform(mounted) : mounted;
      const roll = sideRollFromTransform(ownerDefinition, otherDefinition, edge.sideSlot, inOwnerFrame);
      if (roll === null) return null;
      return { roll, face: 'back' };
    }
    return null;
  }

  // 新しく置くモジュールの識別子。catalog は接ぎ木ごとの id、copy は接ぎ木ごとの接頭辞。
  // 未使用の `construction-N` を接ぎ木の数だけ採る。
  private allocateIds(
    session: ConstructionSession, held: ConstructionHeld, target: ConstructionTargetInfo,
  ): readonly string[] {
    if (held.kind === 'piece') return [];
    const placement = placementFor(
      session.ship.assembly, session.anchorId, held, target.target, this.orientation, this.symmetry,
    );
    const ids: string[] = [];
    for (const _plan of placement.attachments) {
      let id: string;
      do id = `construction-${nextConstructionModule++}`;
      while (session.ship.assembly.module(id) !== null || ids.includes(id));
      ids.push(id);
    }
    return ids;
  }

  // 配置で動いたモジュールの識別子を、成功時の操作記録へ載せるために求める。
  private placedIds(
    session: ConstructionSession, held: ConstructionHeld, newIds: readonly string[],
  ): readonly string[] {
    if (held.kind === 'catalog') return newIds;
    if (held.kind === 'piece') {
      const piece = pieceOfModule(session.ship.assembly.graph, session.anchorId, held.moduleId);
      return piece === null ? [] : [...piece.moduleIds];
    }
    return newIds.flatMap(prefix => held.piece.moduleIds.map(id => `${prefix}:${id}`));
  }

  // 手持ちの根の名前。付け替えは掴んだモジュール、それ以外は定義名。
  private heldName(session: ConstructionSession, held: ConstructionHeld): string {
    if (held.kind === 'piece') return constructionModuleLabel(session.ship.assembly, held.moduleId);
    const definition = heldRootDefinition(session.ship.assembly, held);
    return definition?.name ?? '部品';
  }

  // 試し置きで置いたモジュールの表示モデル id。
  private placedModelId(session: ConstructionSession, held: ConstructionHeld, placedId: string): string {
    const fallback = heldRootDefinition(session.ship.assembly, held)?.modelId ?? 'cockpit-standard';
    if (held.kind === 'catalog') return SHIP_MODULE_CATALOG.require(held.definitionId).modelId;
    if (held.kind === 'piece') {
      return session.ship.assembly.definition(placedId)?.modelId ?? fallback;
    }
    const original = placedId.slice(placedId.indexOf(':') + 1);
    return held.piece.definition(original)?.modelId ?? fallback;
  }

  // 操作の拒否を記録し、理由をヒントへ出す。
  private deny(reason: string): void {
    this.denied = { reason, sequence: ++this.operationSequence };
    this.notifier.hint(reason, undefined, 'warn');
  }

  // 命令を列へ積み、成功時の履歴への記録材料を操作の中で捕捉する。
  private submit(
    session: ConstructionSession, action: ConstructionAction, historyName: string,
    moduleIds: readonly string[], closeOnSuccess: boolean, historyIndex: number | null,
    apply: () => void,
  ): void {
    const completion = new CommandCompletion();
    const pending: PendingConstructionCommand = {
      session, action, completion, historyName, historyIndex, moduleIds,
      closeOnSuccess, snapshot: null,
    };
    this.pending.push(pending);
    this.commands.submitWithCompletion(() => {
      apply();
      pending.snapshot = serializeShipAssembly(session.ship.assembly);
    }, completion);
  }

  // 適用済みの応答を表示へ反映する。成功は履歴と操作記録へ、失敗は拒否記録へ。
  private syncCommandResults(): void {
    for (const command of this.pending) {
      const state = command.completion.state;
      if (state.kind === 'pending') continue;
      if (state.kind === 'failed') {
        const reason = state.error instanceof Error ? state.error.message : '建造操作に失敗しました';
        this.denied = { reason, sequence: ++this.operationSequence };
        this.notifier.hint(reason, undefined, 'warn');
      } else if (this.current === command.session) {
        if (command.action === 'restore' && command.historyIndex !== null) {
          command.session.history.moveTo(command.historyIndex);
        } else if (command.snapshot !== null) {
          command.session.history.record(command.historyName, command.snapshot);
        }
        this.operation = {
          kind: command.action === 'reorient' ? 'rotate'
            : command.action === 'restore' ? 'restore' : command.action,
          moduleIds: command.moduleIds,
          sequence: ++this.operationSequence,
        };
        if (command.closeOnSuccess) this.close();
      }
    }
    this.pending = this.pending.filter(command => command.completion.state.kind === 'pending');
  }

  // 船体座標の位置を ECI へ写す。
  private eciOfAssembly(session: ConstructionSession, position: Vec3): Vec3 {
    const q = session.ship.motion.att.q;
    const root = sub(session.ship.motion.state.r, qRotate(q, session.ship.motion.centerOffset));
    return add(root, qRotate(q, position));
  }

  // 物理のECI座標を、このフレームのfloating origin表示座標へ写す。
  private displayPosition(camera: CameraFrame, position: Vec3): Vec3 {
    const p = camera.floatingOrigin.RtoThreeV3(position);
    return v3(p.x, p.y, p.z);
  }

  // ゲーム状態を構造化したHUD snapshotへ変換する。
  private syncPanel(): void {
    const session = this.current;
    if (session === null) return;
    const { assembly } = session.ship;
    const held = this.heldValue;
    const effective = this.effectiveHeld();
    const target = this.pointedTarget();
    const trial = this.pointedTrial();
    const totals = assembly.totals();
    const capabilities = {
      thrust: totals.thrust, mainFuel: totals.mainFuel, rcsFuel: totals.rcsFuel,
      power: totals.power, radiation: totals.radiation,
    };
    const preview = trial !== null && trial.valid && trial.totals !== null ? {
      mass: trial.totals.mass, maxHp: trial.totals.maxHp,
      capabilities: {
        thrust: trial.totals.thrust, mainFuel: trial.totals.mainFuel, rcsFuel: trial.totals.rcsFuel,
        power: trial.totals.power, radiation: trial.totals.radiation,
      },
    } : null;
    const history = this.history();
    this.panel.sync({
      visible: true, shipName: session.ship.name,
      held: held === null ? null : {
        name: this.heldName(session, held),
        catalogId: held.kind === 'catalog' ? held.definitionId : null,
        orientation: this.orientation, symmetry: this.symmetry,
      },
      selection: this.selectedId === null ? null : {
        name: constructionModuleLabel(assembly, this.selectedId),
        canEdit: this.pieceEditable(session, this.selectedId),
      },
      moduleCount: assembly.size, totalMass: totals.mass,
      hp: totals.hp, maxHp: totals.maxHp, capabilities, preview,
      role: assembly.role,
      warning: trial !== null && !trial.valid ? trial.reason : null,
      pointedTargetId: this.pointedId,
      targets: this.targets().map(info => {
        // 色は規則だけで決める — 重なりは指している取り付け先の試し置きだけが見る。
        const placement = effective === null ? null : placementFor(
          assembly, session.anchorId, effective, info.target,
          this.effectiveOrientation(session, effective), this.symmetry,
        );
        return {
          id: constructionTargetId(info.target), label: info.label,
          valid: placement?.valid ?? true, reason: placement?.reason ?? null,
        };
      }),
      history,
      canPlace: (held !== null || this.selectedId !== null)
        && target !== null && (trial?.valid ?? false),
      canRemove: this.selectedId !== null && this.pieceEditable(session, this.selectedId),
    });
  }

  // 選択中の先端部が撤去・付け替え・回転を受け付けるか。接舷の継ぎ目の先は対象外。
  private pieceEditable(session: ConstructionSession, moduleId: string): boolean {
    const piece = pieceOfModule(session.ship.assembly.graph, session.anchorId, moduleId);
    return piece !== null && piece.rootConnection.kind !== 'docking';
  }
}

// 建造セッションの状態と命令の所有者: 起点ドック・手持ち・選択・向き・対称数・
// 指している取り付け先・取り消し履歴を持ち、船体への編集は命令として列へ積む。
// ゴースト・ガイド・接続ノードの描画は読み取り面を通して表示の導出が行う。
import {
  constructionModuleLabel, constructionTargetId, enumerateConstructionTargets, heldRootDefinition,
  placementFor, type ConstructionTargetInfo,
} from './ship-construction-rules';
import {
  constructionTargetGuide, type ConstructionTargetGuide,
} from './ship-construction-candidates';
import { shipConstructionPanelModel } from './ship-construction-panel-model';
import { ShipConstructionPointer } from './ship-construction-pointer';
import { tryConstructionPlacement, type ConstructionTrial } from './ship-construction-preview';
import { ShipConstructionEdits } from './ship-construction-edits';
import { ConstructionHistory } from './ship-construction-history';
import { pieceOfModule } from './ship-assembly-graft';
import {
  axialPlacementFromTransform, inverseTransform, sideRollFromTransform,
  type ModuleOrientation,
} from './ship-assembly-transform';
import { restoreShipAssembly, serializeShipAssembly } from './ship-save';
import {
  hiddenShipConstructionModel,
  type ConstructionCardDrag, type ConstructionCardDragEvent,
  type ConstructionConfirmationPort, type ConstructionDeniedRecord,
  type ConstructionHeld, type ConstructionHistoryView, type ConstructionOperationRecord,
  type ConstructionSymmetry, type ShipConstructionPanelModel,
} from './ship-construction-types';
import type { ShipBlueprint, ShipBlueprintShelf } from './ship-blueprint';
import type { RunEventSink } from '../run-events';
import { CommandCompletion } from '../command-completion';
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
// 'blueprint' は船体を変えない記録系で、成功時に履歴も操作記録も積まない。
type ConstructionAction = 'place' | 'move' | 'remove' | 'reorient' | 'restore' | 'blueprint';

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
let nextBlueprintSequence = 1;

export interface ShipConstructionPanelPort {
  readonly element: { contains(target: Node): boolean };
  onSelectionChange: ((definitionId: string) => void) | null;
  onBlueprintHold: ((blueprintId: string) => void) | null;
  onCardDrag: ((event: ConstructionCardDragEvent) => void) | null;
  onBlueprintRename: ((id: string, name: string) => void) | null;
  onBlueprintDelete: ((id: string) => void) | null;
  onSlotChange: ((slotId: string) => void) | null;
  onPlace: (() => void) | null;
  onRemove: (() => void) | null;
  onDuplicate: (() => void) | null;
  onRelease: (() => void) | null;
  onRotate: ((delta: 1 | -1) => void) | null;
  onSwapEnds: (() => void) | null;
  onCycleSymmetry: (() => void) | null;
  onSaveBlueprint: ((name: string) => void) | null;
  onUndo: (() => void) | null;
  onRedo: (() => void) | null;
  onJumpHistory: ((index: number) => void) | null;
  onFinish: (() => void) | null;
  onDiscard: (() => void) | null;
  // カタログの表示カテゴリをタブの並び順の index で選ぶ。
  selectCatalogCategory(index: number): void;
  sync(model: ShipConstructionPanelModel): void;
}

// 一度に一つの建造セッションを所有し、船体の編集を命令へ、表示へ同期する。
export class ShipConstruction implements OverlayHandle {
  // ポインタとショートカットキーの解釈。操作途中の状態(掴んだドラッグ)を持つ部品。
  private readonly pointer = new ShipConstructionPointer(this);
  private current: ConstructionSession | null = null;
  private pending: PendingConstructionCommand[] = [];
  private heldValue: ConstructionHeld | null = null;
  // 手持ちが設計図の写しのとき、その設計図の id。
  private heldBlueprintId: string | null = null;
  private selectedId: string | null = null;
  private orientation: ModuleOrientation = { roll: 0, face: 'back' };
  private symmetry: ConstructionSymmetry = 1;
  private pointedId: string | null = null;
  // カタログのカードから持ち上げている最中のドラッグ(R5-4 の操作途中の状態)。
  private cardDragValue: ConstructionCardDrag | null = null;
  private previousForceCurrent = false;
  private operationSequence = 0;
  private operation: ConstructionOperationRecord | null = null;
  private denied: ConstructionDeniedRecord | null = null;
  private trialCache: { readonly signature: string; readonly trial: ConstructionTrial } | null = null;

  // 建造規則の結果を、既存のHUD・入力・表示時刻の各装置へ接続する。
  public constructor(
    private readonly input: Input,
    private readonly commands: CommandQueue,
    private readonly panel: ShipConstructionPanelPort,
    private readonly overlayManager: OverlayManager,
    private readonly displayWindow: DisplayWindowManager,
    private readonly notifier: Notifier,
    private readonly confirmation: ConstructionConfirmationPort,
    private readonly blueprints: ShipBlueprintShelf,
    private readonly events: RunEventSink,
    private readonly focusDock: ((ship: ModularShip) => void) | null = null,
  ) {
    // パネルの操作を建造の各操作へ繋ぐ。
    panel.onSelectionChange = (definitionId) => {
      if (this.heldValue?.kind === 'catalog' && this.heldValue.definitionId === definitionId) {
        this.release();
      } else {
        this.hold({ kind: 'catalog', definitionId });
      }
      this.syncPanel();
    };
    panel.onBlueprintHold = (blueprintId) => {
      if (this.heldBlueprintId === blueprintId && this.heldValue !== null) {
        this.release();
      } else {
        this.holdBlueprint(blueprintId);
      }
    };
    panel.onCardDrag = (event) => this.noteCardDrag(event);
    panel.onBlueprintRename = (id, name) => this.renameBlueprint(id, name);
    panel.onBlueprintDelete = (id) => this.deleteBlueprint(id);
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
    panel.onDuplicate = () => this.duplicateSelected();
    panel.onRelease = () => { this.release(); this.select(null); };
    panel.onRotate = (delta) => this.rotate(delta);
    panel.onSwapEnds = () => this.swapEnds();
    panel.onCycleSymmetry = () => this.cycleSymmetry();
    panel.onSaveBlueprint = (name) => this.saveSelectionAsBlueprint(name);
    panel.onUndo = () => this.undo();
    panel.onRedo = () => this.redo();
    panel.onJumpHistory = (index) => this.jumpToHistory(index);
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

  // カタログのカードから持ち上げている最中のドラッグ。持ち上げている手持ちと
  // クライアント座標、離した位置(押している間は null)を返す。
  public get cardDrag(): ConstructionCardDrag | null { return this.cardDragValue; }

  // ドラッグを閉じる。離した位置を読み終えた入力の解釈が呼ぶ。
  public clearCardDrag(): void { this.cardDragValue = null; }

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
          session.ship.assembly, session.anchorId, held, target.target, orientation,
          this.placementSymmetry(held),
        ),
      };
    }
    return this.trialCache.trial;
  }

  // 指している取り付け先の接続面ガイド(ECI 座標)。持つもの・指す先が無ければ null。
  public pointedGuide(): ConstructionTargetGuide | null {
    const session = this.current;
    const held = this.effectiveHeld();
    const target = this.pointedTarget();
    if (session === null || held === null || target === null) return null;
    return this.guideFor(session, held, target);
  }

  // 全取り付け先の接続面ガイド(ECI 座標)。ポインタが指す候補の画面位置の材料。
  public targetGuides(): readonly ConstructionTargetGuide[] {
    const session = this.current;
    const held = this.effectiveHeld();
    if (session === null || held === null) return [];
    const guides: ConstructionTargetGuide[] = [];
    for (const info of this.targets()) {
      const guide = this.guideFor(session, held, info);
      if (guide !== null) guides.push(guide);
    }
    return guides;
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
    this.heldBlueprintId = null;
    this.selectedId = null;
    this.orientation = { roll: 0, face: 'back' };
    this.symmetry = 1;
    this.pointedId = null;
    this.cardDragValue = null;
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
    this.heldBlueprintId = null;
    this.selectedId = null;
    this.pointedId = null;
    this.cardDragValue = null;
    this.trialCache = null;
    this.overlayManager.close('ship-construction-mode');
    this.displayWindow.setForceCurrent(this.previousForceCurrent);
    this.panel.sync(hiddenShipConstructionModel());
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
    this.heldBlueprintId = null;
    this.trialCache = null;
    this.syncPanel();
  }

  // 手に持ったものを手放す。
  public release(): void {
    this.heldValue = null;
    this.heldBlueprintId = null;
    this.trialCache = null;
    this.syncPanel();
  }

  // 理由を出してから手に持ったものを手放す。
  public releaseWithReason(reason: string): void {
    this.deny(reason);
    this.release();
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
        session.ship.assembly, session.anchorId, held, info.target, this.orientation,
        this.placementSymmetry(held),
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
      session.edits.place(held, info.target, this.orientation, this.placementSymmetry(held), newIds);
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

  // ---- 設計図 ----

  // id の設計図の先端部を写しの手持ちにする。棚に無い id では何もしない。
  public holdBlueprint(id: string): void {
    const blueprint = this.blueprints.blueprints.find(entry => entry.id === id) ?? null;
    if (blueprint === null) { this.deny('その設計図はありません'); return; }
    try {
      this.hold({ kind: 'copy', piece: restoreShipAssembly(blueprint.piece) });
      this.heldBlueprintId = id;
    } catch (error) {
      this.deny(error instanceof Error ? error.message : 'その設計図は読み込めません');
    }
  }

  // 選択中のモジュールの先端部を、名前付きで設計図として記録する命令を積む。
  public saveSelectionAsBlueprint(name: string): void {
    const session = this.current;
    const moduleId = this.selectedId;
    if (session === null) return;
    if (moduleId === null) { this.deny('設計図にする部品を選んでください'); return; }
    if (!this.blueprints.canRecord) { this.deny('記録先のセーブデータが無いため設計図を保存できません'); return; }
    const trimmed = name.trim();
    if (trimmed === '') { this.deny('設計図の名前を入力してください'); return; }
    if (!this.pieceEditable(session, moduleId)) {
      this.deny('接舷中の接続の先は、設計図にできません');
      return;
    }
    this.submit(session, 'blueprint', '', [], false, null, () => {
      // 命令の中で、適用時点の船体の写しから先端部を取り出して直列化する。
      const piece = session.ship.assembly.clone().detachPiece(moduleId, session.anchorId);
      const blueprint: ShipBlueprint = {
        id: `blueprint-${Date.now()}-${nextBlueprintSequence++}`,
        name: trimmed,
        createdAtReal: Date.now(),
        piece: serializeShipAssembly(piece),
      };
      this.events.record({ kind: 'blueprintRecorded', blueprint });
    });
  }

  // id の設計図の名前を変える記録を積む。
  public renameBlueprint(id: string, name: string): void {
    const session = this.current;
    if (session === null) return;
    const trimmed = name.trim();
    if (trimmed === '' || !this.blueprints.blueprints.some(entry => entry.id === id)) return;
    this.submit(session, 'blueprint', '', [], false, null,
      () => this.events.record({ kind: 'blueprintRenamed', id, name: trimmed }));
  }

  // id の設計図を消す記録を積む。確認を挟み、手に持っていれば手放す。
  public deleteBlueprint(id: string): void {
    const session = this.current;
    if (session === null) return;
    const blueprint = this.blueprints.blueprints.find(entry => entry.id === id) ?? null;
    if (blueprint === null) return;
    this.confirmation.request({
      title: '設計図を削除',
      message: `設計図「${blueprint.name}」を削除します。続けますか？`,
      confirmLabel: '削除する', destructive: true,
    }, (confirmed) => {
      if (!confirmed) return;
      this.submit(session, 'blueprint', '', [], false, null,
        () => this.events.record({ kind: 'blueprintDeleted', id }));
      if (this.heldBlueprintId === id) this.release();
    });
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

  // カタログのカードのドラッグ通知を操作途中の状態として持つ。start はそのカードを
  // 手持ちにし、end は離した位置を記録する — 離した位置から取り付け先を決めるのは
  // 入力の解釈の仕事で、ここでは状態を持つだけ。
  private noteCardDrag(event: ConstructionCardDragEvent): void {
    if (this.current === null) return;
    const point = { x: event.clientX, y: event.clientY };
    switch (event.phase) {
      case 'start': {
        let held: ConstructionHeld;
        let blueprintId: string | null = null;
        if (event.source.kind === 'module') {
          held = { kind: 'catalog', definitionId: event.source.definitionId };
        } else {
          try {
            held = { kind: 'copy', piece: this.blueprintPiece(event.source.blueprintId) };
            blueprintId = event.source.blueprintId;
          } catch {
            return;
          }
        }
        this.cardDragValue = { held, point, released: null };
        this.hold(held);
        this.heldBlueprintId = blueprintId;
        return;
      }
      case 'move':
        if (this.cardDragValue !== null) this.cardDragValue = { ...this.cardDragValue, point };
        return;
      case 'end':
        if (this.cardDragValue !== null) this.cardDragValue = { ...this.cardDragValue, point, released: point };
        return;
      default:
        return;
    }
  }

  // id の設計図の先端部を復元する。棚に無い・読めないときは例外にする。
  private blueprintPiece(id: string) {
    const blueprint = this.blueprints.blueprints.find(entry => entry.id === id) ?? null;
    if (blueprint === null) throw new Error(`unknown blueprint: ${id}`);
    return restoreShipAssembly(blueprint.piece);
  }

  // ポインタ入力を建造の操作へ写す。建造中だけ呼ぶ。
  public handlePointer(input: Input, camera: CameraSystem, viewport: Viewport): boolean {
    if (this.current === null) return false;
    this.pointer.interpretPointer(input, camera, viewport);
    return true;
  }

  // OverlayHandle 実装: 建造モードのショートカットキーを操作へ写す。
  // 入力を塞ぐモーダル(確認等)が開いている間は受け付けない。
  public handleShortcut(code: string): boolean {
    if (this.current === null || this.overlayManager.isInputGated()) return false;
    return this.pointer.interpretKey(code, this.input);
  }

  // moduleId を根とする先端部が撤去・付け替え・回転を受け付けるか。
  public canEditModule(moduleId: string): boolean {
    const session = this.current;
    return session !== null && this.pieceEditable(session, moduleId);
  }

  // 建造対象の船体へ視点を寄せる。
  public focusShip(): void {
    const session = this.current;
    if (session !== null) this.focusDock?.(session.ship);
  }

  // カタログの表示カテゴリをタブの並び順の index で選ぶ。
  public selectCatalogCategory(index: number): void {
    this.panel.selectCatalogCategory(index);
  }

  // 適用済みの命令を読み、選択・指す先の整合性とパネルを同期する。
  // 表示物への宣言は、この同期の後に読み取り面を経由して表示の導出が組む。
  public sync(): void {
    this.syncCommandResults();
    if (this.current === null) return;
    this.normalizeSelection();
    this.syncPanel();
  }

  // モード終了時にDOM callbackを同じ所有者から解放する。
  public dispose(): void {
    this.close();
    this.panel.onSelectionChange = null;
    this.panel.onBlueprintHold = null;
    this.panel.onCardDrag = null;
    this.panel.onBlueprintRename = null;
    this.panel.onBlueprintDelete = null;
    this.panel.onSlotChange = null;
    this.panel.onPlace = null;
    this.panel.onRemove = null;
    this.panel.onDuplicate = null;
    this.panel.onRelease = null;
    this.panel.onRotate = null;
    this.panel.onSwapEnds = null;
    this.panel.onCycleSymmetry = null;
    this.panel.onSaveBlueprint = null;
    this.panel.onUndo = null;
    this.panel.onRedo = null;
    this.panel.onJumpHistory = null;
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

  // 対称数は新しく置くもの(カタログ・写し)の側面配置にだけ効く。付け替える
  // 先端部には対称が無いので 1 で評価する。
  private placementSymmetry(held: ConstructionHeld): ConstructionSymmetry {
    return held.kind === 'piece' ? 1 : this.symmetry;
  }

  // 取り付け先1つの接続面ガイド(ECI 座標)を求める。
  private guideFor(
    session: ConstructionSession, held: ConstructionHeld, info: ConstructionTargetInfo,
  ): ConstructionTargetGuide | null {
    return constructionTargetGuide(
      session.ship.assembly, session.anchorId, held, info,
      this.effectiveOrientation(session, held), this.placementSymmetry(held),
      session.ship.motion.state.r, session.ship.motion.att.q, session.ship.motion.centerOffset,
    );
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
        // 'blueprint' は船体を変えない記録系なので、履歴にも操作記録にも積まない。
        if (command.action !== 'blueprint') {
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
        }
        if (command.closeOnSuccess) this.close();
      }
    }
    this.pending = this.pending.filter(command => command.completion.state.kind === 'pending');
  }

  // ゲーム状態を構造化したHUD snapshotへ変換する。
  private syncPanel(): void {
    const session = this.current;
    if (session === null) return;
    const held = this.heldValue;
    const effective = this.effectiveHeld();
    const selectedId = this.selectedId;
    this.panel.sync(shipConstructionPanelModel({
      shipName: session.ship.name,
      assembly: session.ship.assembly,
      anchorId: session.anchorId,
      held: held === null ? null : { item: held, name: this.heldName(session, held) },
      heldBlueprintId: this.heldBlueprintId,
      selection: selectedId === null ? null : {
        moduleId: selectedId, editable: this.pieceEditable(session, selectedId),
      },
      orientation: this.orientation,
      symmetry: this.symmetry,
      effective: effective === null ? null : {
        held: effective,
        orientation: this.effectiveOrientation(session, effective),
        symmetry: this.placementSymmetry(effective),
      },
      pointedTargetId: this.pointedId,
      trial: this.pointedTrial(),
      targets: this.targets(),
      history: this.history(),
      blueprints: this.blueprints.blueprints,
      canRecordBlueprints: this.blueprints.canRecord,
    }));
  }

  // 選択中の先端部が撤去・付け替え・回転を受け付けるか。接舷の継ぎ目の先は対象外。
  private pieceEditable(session: ConstructionSession, moduleId: string): boolean {
    const piece = pieceOfModule(session.ship.assembly.graph, session.anchorId, moduleId);
    return piece !== null && piece.rootConnection.kind !== 'docking';
  }
}

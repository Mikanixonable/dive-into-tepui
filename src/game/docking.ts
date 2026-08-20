// 基地まわりの3つの関心事: 艦と基地・艦どうしの物理ドッキング、基地操作ウィンドウの開閉、
// そして艦体の組立セッション(部品をドラッグして取り付ける作業とその確定)。
//
// 組立は作業台セッション(DockWorkbenchSession)の上で行い、実機(Vessel/基地)へ書き戻すのは
// 「確定」を押した瞬間だけである。取消でセッションを捨てれば実機は一度も触られていない。
import * as THREE from 'three/webgpu';
import * as C from './const';
import { v3, len, sub } from '../physics/vec3';
import { kinematicState } from '../physics/kinematic-state';
import { qFromUnitVectors, qInvert, qMul, qRotate, type Quat } from '../physics/attitude';
import { Hud } from './hud/hud';
import { AssemblyPanel } from './hud/assembly-panel';
import { BaseOperationsWindow } from './hud/base-operations-window';
import { ResourceTransferDialog } from './hud/resource-transfer-dialog';
import { Vessel, type VesselDeps } from './vessel/vessel';
import { hasBaseModule } from './vessel/capabilities';
import { createBlueprint } from './vessel/blueprint';
import type { VesselAssembly } from './vessel/assembly';
import { validateBlueprint } from './vessel/blueprint-validation';
import { AssemblyRenderObject } from './vessel/assembly-render-object';
import { AssemblyDragController, type AssemblyDragTarget, type AssemblyPick } from './vessel/assembly-drag-controller';
import type { PartVisualRef } from './vessel/part-visual';
import { DockWorkbenchSession, type WorkbenchTarget } from './vessel/dock-workbench';
import { DockWorkbenchController } from './vessel/dock-workbench-controller';
import { crewedAssembly } from './vessel/vessel-assemblies';
import { productionBlueprintOf, consumeProductionResources } from './vessel/production';
import { producibility } from './economy/producibility';
import { baseFacilities, basePowerAvailable, deriveBaseDockingPorts } from './vessel/base-module';
import { validateBaseAssembly } from './vessel/base-assembly-validation';
import { deriveCapsules } from './vessel/collision-shape';
import { circumradius, type VesselTree } from './vessel/tree';
import { add as addVec, type Vec3 } from '../physics/vec3';
import type { FloatingOrigin } from './floating-origin';
import type { GameEntity } from './game-entity/game-entity';
import type { Input, PointerPoint } from './input/input';
import type { EntityManager } from './simulation/entity-manager';
import type { MapContextActions } from './map-context-actions';
import type { CameraSystem } from './camera/camera-system';
import { CHASE_DIST_MIN, CHASE_DIST_MAX } from './camera/chase-camera';
import type { ViewManager } from './view-manager';
import type { WorldSfx } from '../audio/sfx/world-sfx';
import type { EffectsSystem } from './vfx/effects-system';
import type { MarkerManager } from './marker/marker-manager';
import type { ActiveVesselController } from './active-vessel-controller';
import type { GraphicsSettings } from '../render/graphics-settings';

// 下書きの実体を基地の前方どれだけ離して浮かべるか [m]。基地本体と重ならない距離。
const DRAFT_OFFSET_BASE = 360;
const DRAFT_OFFSET_STEP = 30;

// 基地操作ウィンドウを座標指定なしで開くときの左上角 [px]。
const DEFAULT_WINDOW_X = 120;
const DEFAULT_WINDOW_Y = 120;

// クリップされていない基地操作ウィンドウを同時に高々1枚に保つための排他グループ名。
const BASE_WINDOW_TEMP_GROUP = 'base-operations-temp';

interface DraftEntry {
  readonly id: string;
  name: string;
  assembly: VesselAssembly;
  render: AssemblyRenderObject;
  readonly ownedPartIds: Set<string>;
}

// 組立の対象1つ。基地本体・ドック中の艦・新規船下書きを同じ形で扱う。
interface AssemblyTargetView {
  readonly id: string;
  readonly kind: 'base' | 'vessel' | 'draft';
  readonly name: string;
  readonly vessel: Vessel | null;
  readonly assembly: VesselAssembly;
}

// 3D で拾ったノード・エッジの選択。A4 の断面編集面はここを読む。部品を拾うと選択ではなく
// 掴み上げになるので、この型に part は無い。
export type AssemblySelection =
  | { readonly kind: 'node'; readonly nodeId: string }
  | { readonly kind: 'edge'; readonly edgeId: string }
  | null;

// 進行中の組立セッション。基地1つにつき高々1つ開ける。
interface AssemblySession {
  readonly base: Vessel;
  readonly session: DockWorkbenchSession;
  readonly workbench: DockWorkbenchController;
  readonly panel: AssemblyPanel;
  // セッション開始時点の基地倉庫にあった部品 id。確定時、下書きへ新たに現れた部品のうち
  // ここに載っているものは倉庫から取り付けた(=生産時に課金済みの)ものだと分かる。
  readonly originalInventoryIds: ReadonlySet<string>;
  targetId: string;
  selection: AssemblySelection;
  // セッション開始時点のチェイスカメラの距離。セッション終了時にここへ戻す。
  readonly savedChaseDist: number;
}

// ツリーの外接半径 [m] — 船体ローカル原点からの最遠点までの距離。deriveCapsules は分離機構の
// 辺を飛ばすので、カプセルの両端に加えてノード自身の外接円も見る。
function assemblyExtentRadius(tree: VesselTree): number {
  let radius = 0;
  for (const capsule of deriveCapsules(tree)) {
    radius = Math.max(radius, len(capsule.a) + capsule.radius, len(capsule.b) + capsule.radius);
  }
  for (const node of tree.nodes) {
    radius = Math.max(radius, len(node.pos) + circumradius(node.section));
  }
  return radius;
}

// partVisualRef を持つオブジェクトを描画木から探し、可視/不可視を切り替える。
function setPartMeshVisible(root: THREE.Object3D, partId: string, visible: boolean): void {
  root.traverse((child) => {
    if ((child.userData['partVisualRef'] as PartVisualRef | undefined)?.partId === partId) child.visible = visible;
  });
}

export class Docking {
  readonly transferDialog: ResourceTransferDialog;
  // 選択中の基地。基地操作ウィンドウ・組立の既定の対象になる。
  private _activeBase: Vessel | null = null;

  // 船と船、船と基地の物理ドッキングペア (shipId -> targetEntity)
  private readonly dockedPairs = new Map<string, GameEntity>();

  get activeBase(): Vessel | null { return this._activeBase; }

  // 作業台で艦を組み直すための依存関係。
  private readonly vesselDeps: VesselDeps;
  private readonly drafts = new Map<string, DraftEntry>();
  private draftSequence = 0;
  // 基地 id ごとの操作ウィンドウ。1つの基地に2枚開かない。
  private readonly baseWindows = new Map<string, BaseOperationsWindow>();
  private readonly dragController: AssemblyDragController;
  private assembly: AssemblySession | null = null;
  // 3D から掴み上げた部品の、実機側に残る元のメッシュ。掴んでいる間だけここへ載せて隠し、
  // 掴みが終わるとき(結果を問わず)必ず元へ戻す。
  private heldOriginal: { readonly root: THREE.Object3D; readonly partId: string } | null = null;

  // 基地に関わる各所有者への参照を受け取る。ポーズだけは Game の状態なので、必要な2つの
  // 操作を関数として受ける。
  constructor(
    private readonly pauseGame: () => void,
    private readonly resumeGame: () => void,
    private readonly hud: Hud,
    private readonly worldSfx: WorldSfx,
    scene: THREE.Scene,
    effects: EffectsSystem,
    markerManager: MarkerManager,
    graphics: GraphicsSettings,
    private readonly entities: EntityManager,
    private readonly mapActions: MapContextActions,
    private readonly cameraSystem: CameraSystem,
    private readonly viewManager: ViewManager,
    private readonly activeVessels: ActiveVesselController,
  ) {
    this.viewManager.setDocking(this);
    this.transferDialog = new ResourceTransferDialog(this.hud.layers.view, this.hud.overlayManager);
    this.vesselDeps = { hud, worldSfx, scene, fx: effects, markerManager, graphics };
    this.dragController = new AssemblyDragController(scene);
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

  // ------------------------------------------------------------ 基地操作ウィンドウ

  // 基地の操作ウィンドウ(格納艦艇・部品・生産)を開く。既に開いていれば指定位置へ動かして
  // 最前面へ出す。接岸の有無は問わない — 他の対象のプロパティウィンドウと同じく、基地が
  // 在れば常に開ける。
  openBaseOperations(base: Vessel, clientX = DEFAULT_WINDOW_X, clientY = DEFAULT_WINDOW_Y): void {
    this.selectBase(base);
    const existing = this.baseWindows.get(base.id);
    if (existing) {
      existing.open(base, clientX, clientY);
      return;
    }
    const win = new BaseOperationsWindow(
      this.hud.layers.window, this.hud.layers.popup, this.hud.overlayManager, BASE_WINDOW_TEMP_GROUP,
    );
    win.onLaunchVessel = (ship, from) => this.launch(ship, from);
    win.onClose = () => { this.baseWindows.delete(base.id); };
    this.baseWindows.set(base.id, win);
    win.open(base, clientX, clientY);
  }

  // 消えた基地のウィンドウを閉じる。毎フレームの sync から呼ぶ。
  private syncBaseWindows(): void {
    for (const [id, win] of [...this.baseWindows.entries()]) {
      const base = this.entities.findBaseVessel(id);
      if (base && base.alive) continue;
      this.baseWindows.delete(id);
      win.dispose();
    }
  }

  // 基地が世界から消えるときに、それを指していた選択とウィンドウを畳む。
  clearActiveBaseIf(base: Vessel): void {
    if (this.assembly?.base === base) this.cancelAssembly();
    const win = this.baseWindows.get(base.id);
    if (win) {
      this.baseWindows.delete(base.id);
      win.dispose();
    }
    if (this._activeBase !== base) return;
    this._activeBase = null;
  }

  // ------------------------------------------------------------ 組立セッション

  // 組立セッションが進行中か。発進・生産など、構成が固まっている前提の操作の門になる。
  get assemblyInProgress(): boolean { return this.assembly !== null; }

  // 基地とその格納艦・下書きを対象にした組立セッションを開き、部品棚ウィンドウを出す。
  // 既にこの基地のセッションが開いていれば何もしない。編集はセッション上だけで進み、
  // 実機へ届くのは確定を押したときだけなので、ここで一時停止して物理と時間加速を止める。
  startAssembly(base: Vessel, preferredTargetId?: string): void {
    if (this.assembly?.base === base) return;
    this.cancelAssembly();
    this.selectBase(base);
    const targets = this.assemblyTargets(base);
    if (targets.length === 0) {
      this.hud.hint('この基地には組み立てられる対象がありません');
      return;
    }
    const dockedCount = base.baseState?.dockedVessels.length ?? 0;
    const session = new DockWorkbenchSession(
      {
        targets: targets.map((target) => ({
          id: target.id,
          kind: target.kind === 'base' ? 'base' : target.kind === 'draft' ? 'new-vessel-draft' : 'docked-vessel',
          assembly: target.assembly,
        })),
        inventory: [...(base.baseState?.inventory ?? [])],
      },
      () => ({ valid: true, errors: [] }),
      { targetValidator: (target) => targetValidation(target, dockedCount) },
    );
    // 部品棚ウィンドウは作業台1つに結びつくので、セッションと同じ寿命で作る。
    const workbench = new DockWorkbenchController(session);
    const panel = new AssemblyPanel(
      this.hud.layers.window, this.hud.overlayManager, this.dragController, workbench,
    );
    const initial = targets.find((target) => target.id === preferredTargetId) ?? targets[0]!;
    const originalInventoryIds = new Set((base.baseState?.inventory ?? []).map((part) => part.id));
    const savedChaseDist = this.cameraSystem.combatCamera.chaseCamera.dist;
    const entry: AssemblySession = {
      base, session, workbench, panel, originalInventoryIds, targetId: initial.id, selection: null, savedChaseDist,
    };
    this.assembly = entry;

    panel.onTargetSelect = (targetId) => {
      entry.targetId = targetId;
      entry.selection = null;
      this.frameAssemblyCamera(entry);
    };
    panel.onUndo = () => { workbench.undo(); };
    panel.onRedo = () => { workbench.redo(); };
    panel.onConfirm = () => this.commitAssembly();
    panel.onCancel = () => this.cancelAssembly();
    panel.open(session, session.getTarget(initial.id), DEFAULT_WINDOW_X, DEFAULT_WINDOW_Y);
    this.frameAssemblyCamera(entry);
    this.pauseGame();
  }

  // 選択中の対象へチェイスカメラを寄せる。対象の外接半径 × ASSEMBLY_CAMERA_DISTANCE_MARGIN を
  // 距離に、targetPose の位置・姿勢を追従先にする。慣性系での置かれ方が定まらない対象
  // (draftOffset が解けない下書きなど)では何もしない — 前回のカメラ状態のまま据え置く。
  // 追従先は毎フレーム引き直さず、ここで採った一点を渡す — セッション中は時間が止まっていて
  // 対象が動かないことに依っている。
  private frameAssemblyCamera(entry: AssemblySession): void {
    const view = this.targetById(entry.base, entry.targetId);
    if (!view) return;
    const pose = this.targetPose(entry.base, view);
    if (!pose) return;
    this.cameraSystem.setChaseCameraOverride(pose);
    const extent = assemblyExtentRadius(view.assembly.tree);
    const dist = extent * C.ASSEMBLY_CAMERA_DISTANCE_MARGIN;
    this.cameraSystem.combatCamera.chaseCamera.dist = Math.max(CHASE_DIST_MIN, Math.min(CHASE_DIST_MAX, dist));
  }

  // セッションの内容を実機へ書き戻す。1つでも対象の検証が通らなければ何も適用しない —
  // 検証を通った対象だけ書き戻すと、基地と格納艦の構成が食い違ったまま残りうる。
  private commitAssembly(): void {
    const entry = this.assembly;
    if (!entry) return;
    let snapshot;
    try {
      snapshot = entry.session.snapshotBeforeBuild();
    } catch (error) {
      this.hud.hint(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const target of snapshot.targets) {
      // 下書きへ倉庫から取り付けられた部品は、建造時の二重課金を避けるため先に控えておく
      // (applyTargetAssembly は下書きの assembly を丸ごと差し替えるので、その前に見る)。
      const draft = this.drafts.get(target.id);
      if (draft) {
        for (const placement of target.assembly.placements) {
          if (entry.originalInventoryIds.has(placement.part.id)) draft.ownedPartIds.add(placement.part.id);
        }
      }
      if (!this.applyTargetAssembly(entry.base, target.id, target.assembly)) {
        this.hud.hint('構成を適用できないため、確定を中止しました');
        return;
      }
    }
    const inventory = entry.base.baseState?.inventory;
    if (inventory) inventory.splice(0, inventory.length, ...snapshot.inventory);
    this.endAssembly();
    this.hud.hint('艦体の構成を確定しました');
  }

  // セッションの編集を捨てて閉じる。実機は一度も触られていないので戻す作業は要らない。
  cancelAssembly(): void {
    const entry = this.assembly;
    if (!entry) return;
    entry.workbench.cancel();
    this.endAssembly();
  }

  // 開いていたセッションの持ち物(ドラッグ中の部品・部品棚ウィンドウ)を手放し、
  // チェイスカメラを寄せる前の距離・追従先へ戻し、時間を再開する。
  private endAssembly(): void {
    const entry = this.assembly;
    if (!entry) return;
    this.assembly = null;
    this.dragController.cancelDrag();
    // 掴んだままセッションが終わっても、隠した元のメッシュを残さない。
    this.restoreHeldOriginal();
    entry.panel.onCancel = null;
    entry.panel.close();
    this.cameraSystem.setChaseCameraOverride(null);
    this.cameraSystem.combatCamera.chaseCamera.dist = entry.savedChaseDist;
    this.resumeGame();
  }

  // 3D クリック(input.takeClicks)をここ1箇所へ集約する。掴んでいなければクリックは
  // 拾い上げ(部品なら掴み、ノード・エッジなら選択)、掴んでいればクリックは離す操作になる ——
  // 同じキューを1箇所で消費するので「離した瞬間に置いて、同じ離しで拾い直す」取り違えが
  // 構造的に起きない。セッション中は Game.handlePointerInput が何も読まないので、掴んでいない
  // クリックも含めて毎回消費してよい。カーソルの位置から取り付け位置とゴーストの描き方を
  // 決めるのもここ —— カメラ行列がこのフレームの値になった後(cameraSystem.update の後)に呼ぶ。
  updateAssembly(input: Input): void {
    const entry = this.assembly;
    if (!entry) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    // 誰も他に読まないキューなので、拾えなかったクリックも含めて常に消費してよい。
    input.takeClicks((point) => {
      this.handleAssemblyClick(entry, point, viewport);
      return true;
    });
    if (!this.dragController.draggingPart) return;
    this.dragController.update(
      this.cameraSystem.activeCamera,
      this.cameraSystem.activeCameraPos,
      input.pointerPosition(),
      viewport,
      this.dragTarget(entry),
    );
  }

  // 1クリックぶんの処理。掴んでいれば離し、掴んでいなければ現在の対象の描画木を拾う。
  private handleAssemblyClick(
    entry: AssemblySession, point: PointerPoint, viewport: { readonly width: number; readonly height: number },
  ): void {
    if (this.dragController.draggingPart) {
      this.dragController.release(entry.targetId);
      this.restoreHeldOriginal();
      return;
    }
    const root = this.targetRenderRoot(entry);
    if (!root) return;
    const pick = this.dragController.pickAt(this.cameraSystem.activeCamera, point, viewport, root);
    this.applyPick(entry, pick, root);
  }

  // 拾った先が部品ならその場から掴み上げ(sourceInventory: false)、ノード・エッジなら
  // セッションの選択にする。何も拾わなければ選択を外す。
  private applyPick(entry: AssemblySession, pick: AssemblyPick, root: THREE.Object3D): void {
    if (pick.kind === 'none') { entry.selection = null; return; }
    if (pick.kind !== 'part') { entry.selection = pick; return; }
    const placement = entry.session.getTarget(entry.targetId).assembly.placements
      .find((candidate) => candidate.part.id === pick.partId);
    if (!placement) return;
    entry.selection = null;
    this.dragController.beginDrag(entry.workbench, placement.part, entry.targetId, false);
    this.hideHeldOriginal(root, pick.partId);
  }

  // 対象タブが指す機体の描画木そのもの —— 基地・格納艦は Vessel.renderObject、下書きは
  // AssemblyRenderObject.object。ピック(拾い上げ)とゴースト吸着(dragTarget)は同じ木を指す。
  private targetRenderRoot(entry: AssemblySession): THREE.Object3D | null {
    const view = this.targetById(entry.base, entry.targetId);
    if (!view) return null;
    if (view.vessel) return view.vessel.renderObject;
    return this.drafts.get(entry.targetId)?.render.object ?? null;
  }

  // 3D から掴み上げた部品は、掴んでいる間だけ実機側の元のメッシュを隠す —— カーソルに
  // 追従するゴーストと二重に見えないため。
  private hideHeldOriginal(root: THREE.Object3D, partId: string): void {
    this.heldOriginal = { root, partId };
    setPartMeshVisible(root, partId, false);
  }

  // hideHeldOriginal で隠した元のメッシュを元へ戻す。何も隠していなければ何もしない。
  private restoreHeldOriginal(): void {
    if (!this.heldOriginal) return;
    setPartMeshVisible(this.heldOriginal.root, this.heldOriginal.partId, true);
    this.heldOriginal = null;
  }

  // update が決めた位置・姿勢・色を、掴んでいる部品のゴーストへ押し込む。
  syncAssembly(fo: FloatingOrigin): void {
    this.syncBaseWindows();
    this.assembly?.panel.sync(this.assembly.session, this.assembly.selection);
    this.dragController.sync(fo);
  }

  // 編集中の対象を、セッション上の構成と実機の慣性系での置かれ方の組として返す。
  // 慣性系での置かれ方が決まらない対象では null(掴んだ部品はどこへも吸い寄せられない)。
  private dragTarget(entry: AssemblySession): AssemblyDragTarget | null {
    const view = this.assemblyTargets(entry.base).find((target) => target.id === entry.targetId);
    if (!view) return null;
    const assembly = entry.session.getTarget(entry.targetId).assembly;
    const pose = this.targetPose(entry.base, view);
    if (!pose) return null;
    return { targetId: entry.targetId, assembly, position: pose.position, attitude: pose.attitude };
  }

  // 対象の実体が慣性系のどこにどの姿勢で在るか。格納艦はドックの口へ、下書きは基地の前方へ
  // 置かれているので、いずれも基地の位置と姿勢から求まる。
  private targetPose(base: Vessel, view: AssemblyTargetView): { position: Vec3; attitude: Quat } | null {
    if (view.kind === 'base') return { position: base.state.r, attitude: base.att.q };
    if (view.kind === 'draft') {
      const offset = this.draftOffset(view.id);
      if (offset === null) return null;
      return { position: addVec(base.state.r, qRotate(base.att.q, v3(0, 0, offset))), attitude: base.att.q };
    }
    const entry = base.baseState?.dockedVessels.find((docked) => docked.vessel === view.vessel);
    if (!entry) return null;
    // メッシュは口の法線へ +Z を向けて置かれているので、姿勢も同じ回転で組む。
    const localNormal = qRotate(qInvert(base.att.q), base.getSlotWorldNormal(entry.slotIndex));
    return {
      position: base.getSlotWorldPos(entry.slotIndex),
      attitude: qMul(base.att.q, qFromUnitVectors(v3(0, 0, 1), localNormal)),
    };
  }

  // 下書きを基地の前方どれだけ離して置くか。並び順がそのまま距離になる。
  private draftOffset(draftId: string): number | null {
    const ids = [...this.drafts.keys()];
    const index = ids.indexOf(draftId);
    return index < 0 ? null : DRAFT_OFFSET_BASE + index * DRAFT_OFFSET_STEP;
  }

  // 組立の対象一覧。基地本体・ドック中の艦・下書きを並べる。
  private assemblyTargets(base: Vessel): readonly AssemblyTargetView[] {
    const targets: AssemblyTargetView[] = [];
    if (base.assembly) targets.push({ id: `base:${base.id}`, kind: 'base', name: base.name, vessel: base, assembly: base.assembly });
    for (const entry of base.baseState?.dockedVessels ?? []) {
      if (entry.vessel.assembly) targets.push({ id: `vessel:${entry.id}`, kind: 'vessel', name: entry.name, vessel: entry.vessel, assembly: entry.vessel.assembly });
    }
    for (const draft of this.drafts.values()) {
      targets.push({ id: draft.id, kind: 'draft', name: draft.name, vessel: null, assembly: draft.assembly });
    }
    return targets;
  }

  private targetById(base: Vessel, targetId: string): AssemblyTargetView | null {
    return this.assemblyTargets(base).find((target) => target.id === targetId) ?? null;
  }

  // 下書きの実体を基地の子として並べ、見える位置へ置く。
  private syncDraftRenders(base: Vessel): void {
    for (const draft of this.drafts.values()) {
      draft.render.object.userData['workbenchDraft'] = true;
      if (draft.render.object.parent !== base.renderObject) base.renderObject.add(draft.render.object);
      draft.render.object.position.set(0, 0, this.draftOffset(draft.id) ?? DRAFT_OFFSET_BASE);
      draft.render.object.visible = true;
    }
  }

  /**
   * Atomically replaces one docked vessel with the validated assembly produced by
   * the workbench. The old vessel is kept untouched until validation succeeds.
   */
  commitDockedAssembly(base: Vessel, vesselId: string, assembly: VesselAssembly): { ok: true; vessel: Vessel } | { ok: false; reason: string } {
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
    return { ok: true, vessel: replacement };
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

  private reportEditFailure(message: string): void {
    this.hud.hint(`作業台の変更を適用できません: ${message}`);
  }

  // 検証済みの構成を対象の実機(または下書き)へ書き戻す。適用できたかを返す。
  private applyTargetAssembly(base: Vessel, targetId: string, assembly: VesselAssembly): boolean {
    const target = this.targetById(base, targetId);
    if (!target) return false;
    const error = assemblyError(assembly, target.name);
    if (error) { this.reportEditFailure(error); return false; }
    if (target.kind === 'base') {
      const result = this.commitBaseAssembly(base, assembly);
      if (!result.ok) { this.reportEditFailure(result.reason); return false; }
      return true;
    }
    if (target.kind === 'vessel' && target.vessel) {
      const result = this.commitDockedAssembly(base, target.vessel.id, assembly);
      if (!result.ok) { this.reportEditFailure(result.reason); return false; }
      return true;
    }
    const draft = this.drafts.get(targetId);
    if (!draft) return false;
    draft.render.object.removeFromParent();
    draft.render.dispose();
    draft.assembly = assembly;
    draft.render = new AssemblyRenderObject(assembly);
    this.syncDraftRenders(base);
    return true;
  }

  // 基地本体の構成を差し替える。基地モジュールの同一性と、艦が入っているドックの口が
  // 動いていないことを先に確かめる。
  private commitBaseAssembly(base: Vessel, assembly: VesselAssembly): { ok: true; base: Vessel } | { ok: false; reason: string } {
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
    return { ok: true, base };
  }

  // 既定の有人艦の形から新規船の下書きを作り、組立の対象へ加える。
  createDraft(base: Vessel): void {
    const id = `draft:${base.id}:${++this.draftSequence}`;
    const assembly = crewedAssembly(C.PLAYER_MAX_HP);
    const render = new AssemblyRenderObject(assembly);
    const draft: DraftEntry = { id, name: `新規船下書き ${this.draftSequence}`, assembly, render, ownedPartIds: new Set() };
    this.drafts.set(id, draft);
    this.syncDraftRenders(base);
    // 進行中のセッションは開始時の対象一覧を持っているので、後から生えた下書きは明示的に足す。
    this.assembly?.session.createNewVesselDraft(id, assembly);
    this.hud.hint(`${draft.name} を作成しました。組立ウィンドウで編集してから建造を確定してください`);
  }

  // 下書きを実艦として建造し、基地のドックへ格納する。資源は建造の時点で引く。
  buildDraft(base: Vessel, targetId: string): void {
    const draft = this.drafts.get(targetId);
    if (!draft || !base.baseState) return;
    const slotIndex = base.getAvailableSlotIndex();
    if (slotIndex === null) return this.reportEditFailure('空きドックがありません');
    const blueprint = createBlueprint({ id: `${draft.id}-blueprint`, name: draft.name, tree: draft.assembly.tree, placements: draft.assembly.placements, now: Date.now() });
    // 倉庫から引いた(=生産時にすでに課金済みの)部品は建造費から除く。二重課金を避けるための
    // 課金専用の設計で、実際に組み立てる vessel は draft.assembly をそのまま使う。
    const chargedPlacements = draft.assembly.placements.filter((placement) => !draft.ownedPartIds.has(placement.part.id));
    const chargeBlueprint = createBlueprint({ id: `${draft.id}-charge`, name: draft.name, tree: draft.assembly.tree, placements: chargedPlacements, now: Date.now() });
    const production = productionBlueprintOf(chargeBlueprint);
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
    this.hud.hint(`${vessel.name} をドック ${slotIndex + 1} に格納しました`);
  }

  // 格納艦をドックから切り離して発進させ、操作対象にする。
  private launch(ship: Vessel, base: Vessel): void {
    if (this.assembly) {
      this.hud.hint('組立中の構成を先に確定または取消してください');
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

  // 開いているウィンドウ・進行中のセッション・掴んだままの部品を片付ける。
  dispose(): void {
    this.cancelAssembly();
    this.dragController.dispose();
    for (const win of this.baseWindows.values()) win.dispose();
    this.baseWindows.clear();
  }
}

// 対象1つが構成として成り立つか。基地には基地固有の条件も課す。
function targetValidation(
  target: WorkbenchTarget,
  dockedCount: number,
): { valid: boolean; errors: readonly string[] } {
  const errors: string[] = [];
  if (target.kind === 'base') errors.push(...validateBaseAssembly(target.assembly, dockedCount));
  const error = assemblyError(target.assembly, target.id);
  if (error) errors.push(error);
  return { valid: errors.length === 0, errors };
}

// 構成が設計として成り立つかを確かめ、最初のエラーを返す。成り立つなら null。
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

// 2つのドックの口が同じ位置・同じ法線を向いているか。
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

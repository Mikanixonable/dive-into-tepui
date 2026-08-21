// 艦体の組立セッション —— 部品をドラッグして取り付ける作業と、その確定・取消。
//
// 編集は作業台セッション(DockWorkbenchSession)の上で行い、実機(基地本体・格納艦・下書き)へ
// 書き戻すのは「確定」を押した瞬間だけである。取消でセッションを捨てれば実機は一度も
// 触られていない。
import * as THREE from 'three/webgpu';
import * as C from './const';
import { v3 } from '../physics/vec3';
import { kinematicState } from '../physics/kinematic-state';
import { qFromUnitVectors, qInvert, qMul, qRotate, type Quat } from '../physics/attitude';
import { Hud } from './hud/hud';
import { AssemblyPanel } from './hud/assembly-panel';
import { Vessel, type VesselDeps } from './vessel/vessel';
import { createBlueprint } from './vessel/blueprint';
import type { VesselAssembly } from './vessel/assembly';
import { AssemblyRenderObject } from './vessel/assembly-render-object';
import {
  AssemblyDragController, type AssemblyDragTarget, type AssemblyPick, type MemberCostHook,
} from './vessel/assembly-drag-controller';
import type { MemberSpec } from './vessel/member';
import { DockWorkbenchSession } from './vessel/dock-workbench';
import { targetValidation } from './vessel/dock-workbench-validation';
import { DockWorkbenchController, type DragSource } from './vessel/dock-workbench-controller';
import { crewedAssembly } from './vessel/vessel-assemblies';
import {
  productionBlueprintOf, consumeProductionResources, memberProductionBlueprintOf, affordableProductionRequest,
} from './vessel/production';
import { producibility, type ProducibilityBlueprint } from './economy/producibility';
import { productionCostSummary, type ProductionCostSummary } from './hud/inventory-labels';
import { baseFacilities, basePowerAvailable, deriveBaseDockingPorts } from './vessel/base-module';
import { validateBaseAssembly, type BaseModuleContinuity } from './vessel/base-assembly-validation';
import type { BaseModulePart, DockPort } from './game-entity/parts';
import type { Vec3 } from '../physics/vec3';
import type { FloatingOrigin } from './floating-origin';
import type { Input, PointerPoint } from './input/input';
import type { CameraSystem } from './camera/camera-system';

const DEFAULT_WINDOW_X = 120;
const DEFAULT_WINDOW_Y = 120;

// 下書きの構成そのものはセッションが持つ。ここが持つのは、セッションの外にしか置けないもの
// —— 名前と、建造したときに入るドック枠 —— だけである。
interface DraftEntry {
  readonly id: string;
  name: string;
  readonly slotIndex: number;
}

// 対象1つぶんの表示の写し。基地本体・格納艦・下書きのいずれも同じ形で持つ。render は
// syncTargetRenders が組むので、対象が現れた直後の1フレームだけ null になる。
interface TargetRenderEntry {
  render: AssemblyRenderObject | null;
  // render を組んだときの構成。セッション側が別の値を持っていれば組み直す合図になる。
  renderedAssembly: VesselAssembly | null;
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
  readonly drafts: Map<string, DraftEntry>;
  // 対象1つにつき1つの表示の写し。基地本体・格納艦・下書きを問わず、対象である間は持つ。
  readonly renders: Map<string, TargetRenderEntry>;
  // 対象が消えた・組み直しで置き換わった写し。捨てるのは THREE を触る sync の仕事なので、
  // ここへ預けて渡す。
  readonly retiredRenders: AssemblyRenderObject[];
  targetId: string;
  selection: AssemblySelection;
}

export class AssemblySessionController {
  private readonly dragController: AssemblyDragController;
  private assembly: AssemblySession | null = null;
  private draftSequence = 0;
  // 構造(ノード・エッジ)を露出している対象の写し。選ばれているタブが変わるたびに移す。
  private revealedStructure: AssemblyRenderObject | null = null;

  // 部材を生やす瞬間の資源判定・消費。開いている基地を都度 this.assembly から読むので、
  // セッションの開閉に関わらず1つで足りる。
  private readonly memberCost: MemberCostHook = {
    refusalFor: (member) => this.memberCostRefusal(member),
    charge: (member) => this.chargeMember(member),
  };

  // pauseGame/resumeGame は組立セッションの間だけ時間と物理を止めるための、Game の状態への
  // 唯一の窓口 —— このクラスの外に持ち出す理由がここにしか無いので、クロージャ2つとして
  // 受ける(CLAUDE.md の「`*Ctx` 禁止」の例外として明記された、このクラスに限る暫定形)。
  constructor(
    private readonly pauseGame: () => void,
    private readonly resumeGame: () => void,
    private readonly hud: Hud,
    scene: THREE.Scene,
    private readonly vesselDeps: VesselDeps,
    private readonly cameraSystem: CameraSystem,
    // 基地本体の構成を書き戻したとき、それを Docking 側の「選択中の基地」へも反映するための
    // 通知。組立中に別の基地を選び直していても、確定した基地へ選択を戻す。
    private readonly onBaseAssemblyWritten: (base: Vessel) => void,
  ) {
    this.dragController = new AssemblyDragController(scene, this.memberCost);
  }

  // 開いている基地の在庫で部材1本ぶんの構造材が賄えるか。賄えなければ拒否理由を返す。
  private memberCostRefusal(member: MemberSpec): string | null {
    const base = this.assembly?.base;
    if (!base?.baseState) return '基地の在庫を確認できません';
    return affordableProductionRequest(base, memberProductionBlueprintOf(member)) ? null : '構造材の資源が不足しています';
  }

  // 部材1本ぶんの構造材を基地の在庫から引く。memberCostRefusal が null を返した直後にしか
  // 呼ばれないので、消費は必ず成功する。
  private chargeMember(member: MemberSpec): void {
    const base = this.assembly?.base;
    if (!base?.baseState) return;
    consumeProductionResources(memberProductionBlueprintOf(member), base.baseState.resources);
  }

  // 部材棚の表示用: いまの入力値で部材を1本生やす費用と、賄えるか。
  private memberCostStatus(member: MemberSpec): ProductionCostSummary | null {
    const base = this.assembly?.base;
    if (!base?.baseState) return null;
    return productionCostSummary(base, memberProductionBlueprintOf(member));
  }

  // 組立セッションが進行中か。発進・生産など、構成が固まっている前提の操作の門になる。
  get inProgress(): boolean { return this.assembly !== null; }

  // 基地とその格納艦・下書きを対象にした組立セッションを開き、部品棚ウィンドウを出す。
  // 既にこの基地のセッションが開いていれば何もしない。編集はセッション上だけで進み、
  // 実機へ届くのは確定を押したときだけなので、ここで一時停止して物理と時間加速を止める。
  startAssembly(base: Vessel, preferredTargetId?: string): void {
    if (this.assembly?.base === base) return;
    this.cancelAssembly();
    const targets = this.assemblyTargets(base);
    if (targets.length === 0) {
      this.hud.hint('この基地には組み立てられる対象がありません');
      return;
    }
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
      // 収容艦数・基地モジュールの継続性は build-draft 等で開いている間にも動くので、
      // 都度 base から読み直す。
      {
        targetValidator: (target) => targetValidation(
          target, base.baseState?.dockedVessels.length ?? 0, this.baseModuleContinuity(base),
        ),
      },
    );
    // 部品棚ウィンドウは作業台1つに結びつくので、セッションと同じ寿命で作る。
    const workbench = new DockWorkbenchController(session);
    const panel = new AssemblyPanel(
      this.hud.layers.window, this.hud.overlayManager, this.dragController, workbench,
    );
    const initial = targets.find((target) => target.id === preferredTargetId) ?? targets[0]!;
    const originalInventoryIds = new Set((base.baseState?.inventory ?? []).map((part) => part.id));
    const entry: AssemblySession = {
      base, session, workbench, panel, originalInventoryIds, targetId: initial.id, selection: null,
      drafts: new Map<string, DraftEntry>(), renders: new Map<string, TargetRenderEntry>(),
      retiredRenders: [],
    };
    this.assembly = entry;

    panel.onTargetSelect = (targetId) => {
      // 掴んだまま別の対象へ移ると落とす先と掴み元が食い違うので、切り替えで掴みを捨てる。
      // 部材は在庫という戻り先が無く消えてしまうので、そのときだけ知らせる。
      if (this.dragController.cancelDrag()) this.hud.hint('対象を切り替えたため、掴んでいた部材を破棄しました');
      entry.targetId = targetId;
      entry.selection = null;
      this.frameAssemblyCamera(entry);
    };
    panel.onUndo = () => { workbench.undo(); };
    panel.onRedo = () => { workbench.redo(); };
    panel.onConfirm = () => this.commitAssembly();
    panel.onCancel = () => this.cancelAssembly();
    panel.onCreateDraft = () => this.createDraft(base);
    panel.onBuildDraft = (targetId) => this.buildDraft(base, targetId);
    panel.onRemoveDraft = (targetId) => this.removeDraft(targetId);
    panel.onRemoveSelection = () => this.removeSelection();
    panel.draftBuildStatus = (targetId) => this.draftBuildStatus(base, targetId);
    panel.memberCostStatus = (member) => this.memberCostStatus(member);
    panel.open(session, session.getTarget(initial.id), DEFAULT_WINDOW_X, DEFAULT_WINDOW_Y);
    this.frameAssemblyCamera(entry);
    this.pauseGame();
  }

  // 基地が世界から消えるなど、開いていればこの基地のセッションだけを閉じる。
  cancelIfBase(base: Vessel): void {
    if (this.assembly?.base === base) this.cancelAssembly();
  }

  // セッションの編集を捨てて閉じる。実機は一度も触られていないので戻す作業は要らない。
  cancelAssembly(): void {
    const entry = this.assembly;
    if (!entry) return;
    entry.workbench.cancel();
    this.endAssembly();
  }

  // 選択中の対象へチェイスカメラの追従先を寄せる。targetPose の位置・姿勢を追従先にする。
  // 慣性系での置かれ方が定まらない対象(draftOffset が解けない下書きなど)では何もしない —
  // 前回のカメラ状態のまま据え置く。追従先は毎フレーム引き直さず、ここで採った一点を渡す —
  // セッション中は時間が止まっていて対象が動かないことに依っている。
  private frameAssemblyCamera(entry: AssemblySession): void {
    const view = this.targetById(entry.base, entry.targetId);
    if (!view) return;
    const pose = this.targetPose(entry.base, view);
    if (!pose) return;
    this.cameraSystem.setChaseCameraOverride(pose);
  }

  // セッションの内容を実機へ書き戻す。全対象について適用できるかを副作用なしで先に判定し、
  // 全て通ったあとで初めて書き込む — 検証と書き込みを1対象ずつ交互に行うと、途中の対象で
  // 拒否されたときに基地と格納艦の構成が食い違ったまま残ってしまう。
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
    // 1段目: 副作用なしで全対象の適用可否を確かめる。
    for (const target of snapshot.targets) {
      const reason = this.checkTargetApplicable(entry.base, target.id, target.assembly);
      if (reason) {
        this.reportEditFailure(reason);
        return;
      }
    }
    // 2段目: すべて通ったので、ここで初めて書き込む。
    for (const target of snapshot.targets) {
      this.applyTargetAssembly(entry.base, target.id, target.assembly);
    }
    const inventory = entry.base.baseState?.inventory;
    if (inventory) inventory.splice(0, inventory.length, ...snapshot.inventory);
    this.endAssembly();
    this.hud.hint('艦体の構成を確定しました');
  }

  // 開いていたセッションの持ち物(表示の写し・ドラッグ中の部品・部品棚ウィンドウ)を手放し、
  // 隠していた実艦のメッシュを戻し、チェイスカメラを寄せる前の距離・追従先へ戻して時間を再開する。
  private endAssembly(): void {
    const entry = this.assembly;
    if (!entry) return;
    this.assembly = null;
    for (const targetId of [...entry.renders.keys()]) this.disposeTargetRender(entry, targetId);
    for (const retired of entry.retiredRenders.splice(0)) {
      retired.object.removeFromParent();
      retired.dispose();
    }
    this.restoreEditedRealMeshes(entry.base);
    this.dragController.cancelDrag();
    this.revealTargetStructure(null);
    entry.panel.onCancel = null;
    entry.panel.close();
    this.cameraSystem.setChaseCameraOverride(null);
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
    // このフレームで扱うのは1クリックだけ —— 掴みと離しの間には必ず update を1回挟む必要が
    // あり(挟まないと吸着候補が未確定のまま離したことになる)、同じフレームの2つ目以降は捨てる。
    let handled = false;
    input.takeClicks((point) => {
      if (!handled) {
        handled = true;
        this.handleAssemblyClick(entry, point, viewport);
      }
      return true;
    });
    // 表示の写しの顔ぶれを決めるのは論理側の判断なので、sync ではなくここで済ませる。
    this.reconcileDrafts(entry);
    if (!this.dragController.dragging) return;
    this.dragController.update(
      this.cameraSystem.activeCamera,
      this.cameraSystem.activeCameraPos,
      input.pointerPosition(),
      viewport,
      this.dragTarget(entry),
    );
  }

  // 1クリックぶんの処理。掴んでいれば離し、掴んでいなければ現在の対象の写しを拾う。
  private handleAssemblyClick(
    entry: AssemblySession, point: PointerPoint, viewport: { readonly width: number; readonly height: number },
  ): void {
    if (this.dragController.dragging) {
      const refused = this.dragController.release(entry.targetId);
      if (refused) this.hud.hint(refused);
      return;
    }
    const root = this.targetRenderRoot(entry);
    if (!root) return;
    const pick = this.dragController.pickAt(this.cameraSystem.activeCamera, point, viewport, root);
    this.applyPick(entry, pick);
  }

  // 拾った先が部品ならその場から掴み上げ、ノード・エッジならセッションの選択にする。
  // 何も拾わなければ選択を外す。
  private applyPick(entry: AssemblySession, pick: AssemblyPick): void {
    if (pick.kind === 'none') { entry.selection = null; return; }
    if (pick.kind !== 'part') { entry.selection = pick; return; }
    const placement = entry.session.getTarget(entry.targetId).assembly.placements
      .find((candidate) => candidate.part.id === pick.partId);
    if (!placement) return;
    entry.selection = null;
    const source: DragSource = { kind: 'target', targetId: entry.targetId, targetKind: entry.session.targetKind(entry.targetId) };
    this.dragController.beginDrag(entry.workbench, placement.part, source);
  }

  // 選択中のノード・エッジを削除する。成功すれば選択も外す。拒否理由は文字列で返すだけで、
  // それを画面へどう出すかは呼び出し側(AssemblyPanel)の責務。
  removeSelection(): string | null {
    const entry = this.assembly;
    if (!entry || entry.selection === null) return null;
    const { selection, targetId } = entry;
    const validation = selection.kind === 'node'
      ? entry.workbench.removeNode(targetId, selection.nodeId)
      : entry.workbench.removeEdge(targetId, selection.edgeId);
    if (validation.valid) entry.selection = null;
    return validation.valid ? null : (validation.errors[0] ?? '削除できません');
  }

  // 対象タブが指す表示の写しの描画木。ピック(拾い上げ)とゴースト吸着(dragTarget)は
  // 同じ木を指す。
  private targetRenderRoot(entry: AssemblySession): THREE.Object3D | null {
    return entry.renders.get(entry.targetId)?.render?.object ?? null;
  }

  // update が決めた位置・姿勢・色を、掴んでいる部品のゴーストへ押し込む。編集中の対象は
  // update が決めた論理状態(編集中の対象・掴んでいる部品)を見た目へ押し込む。
  syncAssembly(fo: FloatingOrigin): void {
    if (this.assembly) {
      this.syncTargetRenders(this.assembly.base);
      this.hideEditedRealMeshes(this.assembly.base);
      this.syncHeldPart(this.assembly);
      this.assembly.panel.sync(this.assembly.session, this.assembly.selection);
      this.revealTargetStructure(this.assembly.renders.get(this.assembly.targetId)?.render ?? null);
    }
    this.dragController.sync(fo);
  }

  // 編集中の対象の構造を見せる —— ノードとエッジは写しのワイヤーフレームにしか描かれておらず、
  // 既定では消えているのに、レイキャストは見えていなくても拾ってしまうため。露出をやめた写しは
  // 明示的に戻す。
  private revealTargetStructure(render: AssemblyRenderObject | null): void {
    if (this.revealedStructure && this.revealedStructure !== render) {
      this.revealedStructure.setStructureVisible(false);
    }
    this.revealedStructure = render;
    render?.setStructureVisible(true);
  }

  // 対象上から掴み上げている部品を写し側で隠す。「いま何を掴んでいるか」から毎フレーム
  // 引き直すので、前回隠した分を戻す帳簿は要らない。
  private syncHeldPart(entry: AssemblySession): void {
    const held = this.dragController.heldTargetPart;
    for (const [targetId, target] of entry.renders) {
      target.render?.setHiddenPart(held && held.targetId === targetId ? held.partId : null);
    }
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
    const slotIndex = view.kind === 'draft'
      ? this.assembly?.drafts.get(view.id)?.slotIndex
      : base.baseState?.dockedVessels.find((docked) => docked.vessel === view.vessel)?.slotIndex;
    if (slotIndex === undefined) return null;
    // メッシュは口の法線へ +Z を向けて置かれているので、姿勢も同じ回転で組む。
    const localNormal = qRotate(qInvert(base.att.q), base.getSlotWorldNormal(slotIndex));
    return {
      position: base.getSlotWorldPos(slotIndex),
      attitude: qMul(base.att.q, qFromUnitVectors(v3(0, 0, 1), localNormal)),
    };
  }

  // 組立の対象一覧。基地本体・ドック中の艦・下書きを並べる。
  private assemblyTargets(base: Vessel): readonly AssemblyTargetView[] {
    const targets: AssemblyTargetView[] = [];
    if (base.assembly) targets.push({ id: `base:${base.id}`, kind: 'base', name: base.name, vessel: base, assembly: base.assembly });
    for (const entry of base.baseState?.dockedVessels ?? []) {
      if (entry.vessel.assembly) targets.push({ id: `vessel:${entry.id}`, kind: 'vessel', name: entry.name, vessel: entry.vessel, assembly: entry.vessel.assembly });
    }
    const entry = this.assembly;
    for (const draft of entry?.drafts.values() ?? []) {
      targets.push({ id: draft.id, kind: 'draft', name: draft.name, vessel: null, assembly: entry!.session.getTarget(draft.id).assembly });
    }
    return targets;
  }

  private targetById(base: Vessel, targetId: string): AssemblyTargetView | null {
    return this.assemblyTargets(base).find((target) => target.id === targetId) ?? null;
  }

  // 全対象(基地本体・格納艦・下書き)の表示の写しを、実物と同じ場所へ置く。構成が動いていれば
  // 組み直すので、編集の結果がその場で見える。
  private syncTargetRenders(base: Vessel): void {
    const entry = this.assembly;
    if (!entry) return;
    for (const retired of entry.retiredRenders.splice(0)) {
      retired.object.removeFromParent();
      retired.dispose();
    }
    const targets = this.assemblyTargets(base);
    const liveIds = new Set(targets.map((view) => view.id));
    for (const id of [...entry.renders.keys()]) {
      if (!liveIds.has(id)) this.disposeTargetRender(entry, id);
    }
    for (const view of targets) {
      const assembly = entry.session.getTarget(view.id).assembly;
      let target = entry.renders.get(view.id);
      if (!target) {
        target = { render: null, renderedAssembly: null };
        entry.renders.set(view.id, target);
      }
      if (target.render && assembly !== target.renderedAssembly) {
        entry.retiredRenders.push(target.render);
        target.render = null;
      }
      if (!target.render) {
        target.render = new AssemblyRenderObject(assembly);
        target.renderedAssembly = assembly;
      }
      this.placeTargetRender(base, entry, view, target.render.object);
    }
  }

  // 表示の写しを1つ、実物と同じ場所へ据える。基地本体は自身の原点(恒等姿勢)へ、格納艦・
  // 下書きはドック口へ —— attachDockedVesselMesh/placeAtDockSlot と同じ経路なので、置かれ方が
  // 実物と食い違わない。基地の子として置くので、確定時の Vessel.replaceAssembly が自分の外殻
  // と取り違えないよう workbenchDraft の印を付ける。
  private placeTargetRender(base: Vessel, entry: AssemblySession, view: AssemblyTargetView, object: THREE.Object3D): void {
    object.userData['workbenchDraft'] = true;
    if (view.kind === 'base') {
      object.position.set(0, 0, 0);
      object.quaternion.set(0, 0, 0, 1);
      if (object.parent !== base.renderObject) base.renderObject.add(object);
      return;
    }
    const slotIndex = view.kind === 'draft'
      ? entry.drafts.get(view.id)?.slotIndex
      : base.baseState?.dockedVessels.find((docked) => docked.vessel === view.vessel)?.slotIndex;
    if (slotIndex === undefined) return;
    base.placeAtDockSlot(object, slotIndex);
  }

  // 対象の写しを1つ手放す。実物へは何もしない —— セッションが持つのは表示の写しだけである。
  private disposeTargetRender(entry: AssemblySession, targetId: string): void {
    const target = entry.renders.get(targetId);
    entry.renders.delete(targetId);
    if (target?.render) entry.retiredRenders.push(target.render);
  }

  // 基地の直下の子から、収容艦(どの種別問わず)と表示の写し(workbenchDraft の印)を除いた
  // 残り —— 基地自身の外殻(外皮メッシュ・ワイヤーフレーム)。
  private baseOwnHullChildren(base: Vessel): THREE.Object3D[] {
    const dockedObjects = new Set((base.baseState?.dockedVessels ?? []).map((docked) => docked.vessel.renderObject));
    return base.renderObject.children.filter((child) =>
      !dockedObjects.has(child) && child.userData['workbenchDraft'] !== true);
  }

  // 編集中の対象(基地本体・格納艦)の実艦のメッシュを隠す。写しがその場に立つ。収容艦は
  // entities.vessels から外れて syncVessel が二度と走らないため一度隠せば済むが、収容艦の
  // 顔ぶれや写しの組み直しは毎フレーム動きうるので、基地の外殻はここで毎フレーム引き直す。
  private hideEditedRealMeshes(base: Vessel): void {
    for (const view of this.assemblyTargets(base)) {
      if (view.kind === 'base') {
        for (const child of this.baseOwnHullChildren(base)) child.visible = false;
      } else if (view.kind === 'vessel' && view.vessel) {
        view.vessel.renderObject.visible = false;
      }
    }
  }

  // セッション終了時、隠していた実艦のメッシュをすべて表示へ戻す。収容艦は entities.vessels の
  // 外にあって syncVessel が走らないので、ここで明示的に戻す必要がある。
  private restoreEditedRealMeshes(base: Vessel): void {
    for (const child of this.baseOwnHullChildren(base)) child.visible = true;
    for (const docked of base.baseState?.dockedVessels ?? []) docked.vessel.renderObject.visible = true;
  }

  // 表示の写しをセッションの対象一覧へ合わせる。下書きの作成と削除は取り消せるので、下書きの
  // 側だけ取り残されることがある。枠が空いていない下書きは置き場所が無いので、対象ごと落とす。
  private reconcileDrafts(entry: AssemblySession): void {
    const targets = entry.session.targetsSnapshot();
    const draftIds = new Set(targets.filter((t) => t.kind === 'new-vessel-draft').map((t) => t.id));
    for (const id of [...entry.drafts.keys()]) {
      if (!draftIds.has(id)) this.disposeDraft(entry, id);
    }
    for (const id of draftIds) {
      if (entry.drafts.has(id)) continue;
      const slotIndex = this.freeSlotIndex(entry.base);
      if (slotIndex === null) {
        entry.session.removeTarget(id);
        this.reportEditFailure('空きドックが無いため下書きを戻せません');
        continue;
      }
      entry.drafts.set(id, { id, name: `新規船下書き ${entry.drafts.size + 1}`, slotIndex });
    }
  }

  private reportEditFailure(message: string): void {
    this.hud.hint(`作業台の変更を適用できません: ${message}`);
  }

  // snapshot.targets のすべてが checkTargetApplicable を通ったあとに呼ぶ前提で、対象1つの構成を
  // 実機(または下書き)へ書き戻す。それでも失敗するのは Vessel 側の構築処理自体が例外を
  // 投げた稀なケースだけであり、その旨を知らせるにとどめる(ここまでに書き戻した他の対象を
  // 元に戻す手段は無い)。
  private applyTargetAssembly(base: Vessel, targetId: string, assembly: VesselAssembly): void {
    const target = this.targetById(base, targetId);
    if (!target) return;
    if (target.kind === 'base') {
      const result = this.writeBaseAssembly(base, assembly);
      if (!result.ok) this.reportEditFailure(result.reason);
      return;
    }
    if (target.kind === 'vessel' && target.vessel) {
      const result = this.writeDockedAssembly(base, target.vessel.id, assembly);
      if (!result.ok) this.reportEditFailure(result.reason);
    }
    // 下書きの構成はセッションが持っているので、ここで書き戻すものは無い。
  }

  // 対象1つが実機へ適用できるかを、副作用なしで判定する。基地本体は構造としての成立可否に加え、
  // 基地モジュールの同一性と、艦が入っているドックの口が動いていないかも見る。
  private checkTargetApplicable(base: Vessel, targetId: string, assembly: VesselAssembly): string | null {
    const target = this.targetById(base, targetId);
    if (!target) return '対象が見つかりません';
    if (target.kind === 'base') return this.checkBaseAssemblyApplicable(base, assembly);
    if (target.kind === 'vessel' && target.vessel) return this.checkDockedAssemblyApplicable(base, target.vessel.id);
    return this.assembly?.drafts.has(targetId) ? null : '対象が見つかりません';
  }

  // 基地本体の構成として成り立つか(構造・base_module 個数・継続性)を副作用なしで判定する。
  private checkBaseAssemblyApplicable(base: Vessel, assembly: VesselAssembly): string | null {
    if (!base.baseState) return '基地ではありません';
    const validation = validateBaseAssembly(
      assembly, base.baseState.dockedVessels.length, this.baseModuleContinuity(base),
    );
    return validation.length > 0 ? validation[0]! : null;
  }

  // checkBaseAssemblyApplicable を通った前提で、基地本体の構成を書き戻す。
  private writeBaseAssembly(base: Vessel, assembly: VesselAssembly): { ok: true; base: Vessel } | { ok: false; reason: string } {
    const applied = base.replaceAssembly(assembly);
    if (!applied.ok) return applied;
    this.onBaseAssemblyWritten(base);
    return { ok: true, base };
  }

  /**
   * Atomically replaces one docked vessel with the validated assembly produced by
   * the workbench. The old vessel is kept untouched until validation succeeds.
   */
  commitDockedAssembly(base: Vessel, vesselId: string, assembly: VesselAssembly): { ok: true; vessel: Vessel } | { ok: false; reason: string } {
    const reason = this.checkDockedAssemblyApplicable(base, vesselId);
    if (reason) return { ok: false, reason };
    return this.writeDockedAssembly(base, vesselId, assembly);
  }

  // 対象艦がドックにいるか、副作用なしで判定する。
  private checkDockedAssemblyApplicable(base: Vessel, vesselId: string): string | null {
    if (!base.baseState) return '基地ではありません';
    const index = base.baseState.dockedVessels.findIndex((entry) => entry.id === vesselId);
    return index < 0 ? '対象艦がドックにありません' : null;
  }

  // checkDockedAssemblyApplicable を通った前提で、ドック中の1隻を検証済みの構成へ差し替える。
  private writeDockedAssembly(base: Vessel, vesselId: string, assembly: VesselAssembly): { ok: true; vessel: Vessel } | { ok: false; reason: string } {
    const state = base.baseState;
    if (!state) return { ok: false, reason: '基地ではありません' };
    const index = state.dockedVessels.findIndex((entry) => entry.id === vesselId);
    if (index < 0) return { ok: false, reason: '対象艦がドックにありません' };
    const previous = state.dockedVessels[index]!.vessel;
    const blueprint = createBlueprint({
      id: `${previous.id}-dock-edit`, name: previous.name, tree: assembly.tree,
      placements: assembly.placements, now: Date.now(),
    });
    const replacement = new Vessel({
      blueprintShip: { blueprint, state: previous.state, name: previous.name, id: previous.id },
    }, this.vesselDeps);
    // 差し替えが成り立ってから、初めて旧艦のメッシュ・格納枠を新艦へ引き継ぐ。
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

  // 差し替え後も維持されなければならない基地の性質を、基地の現在の実機状態から都度導く —
  // セッション中に収容艦が出入りしても追従できるよう、セッション開始時の値を焼き込まない。
  private baseModuleContinuity(base: Vessel): BaseModuleContinuity | null {
    if (!base.baseState || !base.assembly) return null;
    const oldModule = base.parts.find(
      (part): part is BaseModulePart => part.type === 'base_module' && part.hp > 0,
    );
    if (!oldModule) return null;
    // 収容中の艦がいるスロットの口だけを覚える —— 空きスロットは動かしてよい。
    const oldPorts = deriveBaseDockingPorts(base.assembly, oldModule).slots;
    const occupiedPorts = new Map<number, DockPort>();
    for (const docked of base.baseState.dockedVessels) {
      const port = oldPorts[docked.slotIndex];
      if (port) occupiedPorts.set(docked.slotIndex, port);
    }
    return { moduleId: oldModule.id, occupiedPorts };
  }

  // 既定の有人艦の形から新規船の下書きを作り、組立の対象へ加える。建造すれば入る枠をこの時点で
  // 押さえる —— 建造の瞬間まで待って断るより、作れないものを作らせない方がよい。
  createDraft(base: Vessel): void {
    const entry = this.assembly;
    if (!entry) return;
    const slotIndex = this.freeSlotIndex(base);
    if (slotIndex === null) return this.reportEditFailure('空きドックがありません');
    const id = `draft:${base.id}:${++this.draftSequence}`;
    const assembly = crewedAssembly(C.PLAYER_MAX_HP);
    const draft: DraftEntry = { id, name: `新規船下書き ${this.draftSequence}`, slotIndex };
    entry.session.createNewVesselDraft(id, assembly);
    entry.drafts.set(id, draft);
    this.hud.hint(`${draft.name} をドック ${slotIndex + 1} に置きました。編集してから建造してください`);
  }

  // 収容中の艦にも、他の下書きが押さえた枠にも使われていない枠。満杯なら null。
  private freeSlotIndex(base: Vessel): number | null {
    const reserved = new Set([...(this.assembly?.drafts.values() ?? [])].map((draft) => draft.slotIndex));
    for (const docked of base.baseState?.dockedVessels ?? []) reserved.add(docked.slotIndex);
    for (let i = 0; i < base.dockCapacity; i++) if (!reserved.has(i)) return i;
    return null;
  }

  // 下書きを捨てる。実機には何も作られていないので、押さえた枠を返すだけで済む。
  removeDraft(targetId: string): void {
    const entry = this.assembly;
    const draft = entry?.drafts.get(targetId);
    if (!entry || !draft) return;
    entry.session.removeTarget(targetId);
    this.disposeDraft(entry, targetId);
    if (entry.targetId === targetId) entry.targetId = entry.session.snapshot().targets[0]?.id ?? targetId;
    this.hud.hint(`${draft.name} を削除しました`);
  }

  // 下書きの写しはこの時点で処分せず、次の syncTargetRenders が対象一覧から漏れたことを見て
  // 処分する —— 表示の写しの寿命はどの対象でも syncTargetRenders 1箇所が決める。
  private disposeDraft(entry: AssemblySession, targetId: string): void {
    entry.drafts.delete(targetId);
  }

  // 下書きを実艦として建造し、押さえてあった枠へ格納する。資源は建造の時点で引く。
  buildDraft(base: Vessel, targetId: string): void {
    const entry = this.assembly;
    const draft = entry?.drafts.get(targetId);
    if (!entry || !draft || !base.baseState) return;
    // 実艦へ渡す部品は可変(hp が変化する)なので、セッション側と共有しないよう複製する。
    const assembly = entry.session.targetSnapshotForBuild(targetId).assembly;
    const blueprint = createBlueprint({
      id: `${draft.id}-blueprint`, name: draft.name, tree: assembly.tree, placements: assembly.placements, now: Date.now(),
    });
    const production = this.draftBuildRequest(entry, draft, assembly);
    const requirements = producibility(production, base.baseState.resources, baseFacilities(base), basePowerAvailable(base));
    if (requirements.length > 0) {
      this.hud.hint(`建造資源・設備が不足しています: ${requirements.map((item) => item.id).join(', ')}`); return;
    }
    if (!consumeProductionResources(production, base.baseState.resources)) return this.reportEditFailure('建造資源を消費できません');
    const vessel = new Vessel({ blueprintShip: {
      blueprint, state: kinematicState(base.state.t, base.state.r, base.state.v), name: draft.name, id: `${draft.id}-built`,
    } }, this.vesselDeps);
    base.baseState.dockedVessels.push({
      id: vessel.id, name: vessel.name, hp: vessel.hp, maxHp: vessel.maxHp, parts: vessel.parts, vessel, slotIndex: draft.slotIndex,
    });
    base.attachDockedVesselMesh(vessel, draft.slotIndex);
    this.consumeMountedInventory(entry, base, assembly);
    entry.session.removeTarget(targetId);
    this.disposeDraft(entry, targetId);
    if (entry.targetId === targetId) entry.targetId = entry.session.snapshot().targets[0]?.id ?? targetId;
    this.hud.hint(`${vessel.name} をドック ${draft.slotIndex + 1} に格納しました`);
  }

  // 建造した艦に載っている、倉庫から取り付けた部品を基地の在庫から実際に取り除く。確定まで待つと、
  // 建造してから取消したときに同じ部品が実機と在庫の両方に残る。
  private consumeMountedInventory(entry: AssemblySession, base: Vessel, assembly: VesselAssembly): void {
    const inventory = base.baseState?.inventory;
    if (!inventory) return;
    for (const placement of assembly.placements) {
      if (!entry.originalInventoryIds.has(placement.part.id)) continue;
      const index = inventory.findIndex((part) => part.id === placement.part.id);
      if (index >= 0) inventory.splice(index, 1);
    }
  }

  // 倉庫から引いた(=生産時にすでに課金済みの)部品は建造費から除く。課金専用の設計で、
  // 実際に組み立てる vessel はセッションの構成をそのまま使う。
  private draftBuildRequest(
    entry: AssemblySession, draft: DraftEntry, assembly: VesselAssembly,
  ): ProducibilityBlueprint {
    const chargedPlacements = assembly.placements.filter((placement) => !entry.originalInventoryIds.has(placement.part.id));
    const chargeBlueprint = createBlueprint({
      id: `${draft.id}-charge`, name: draft.name, tree: assembly.tree, placements: chargedPlacements, now: Date.now(),
    });
    return productionBlueprintOf(chargeBlueprint);
  }

  // 「建造して格納」ボタンの但し書き。対象が下書きでなければ(基地が消える等) null。
  private draftBuildStatus(base: Vessel, targetId: string): ProductionCostSummary | null {
    const entry = this.assembly;
    const draft = entry?.drafts.get(targetId);
    if (!entry || !draft || !base.baseState) return null;
    const request = this.draftBuildRequest(entry, draft, entry.session.getTarget(targetId).assembly);
    return productionCostSummary(base, request);
  }

  // 進行中のセッションと掴んだままの部品を片付ける。
  dispose(): void {
    this.cancelAssembly();
    this.dragController.dispose();
  }
}

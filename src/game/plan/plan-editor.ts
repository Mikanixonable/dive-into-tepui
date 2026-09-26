// 軌道計画の編集(ノードの配置・時刻移動・Δv 調整・選択・削除)と、ノードギズモ・3D 矢印・
// 計画パネルへの反映。ノードの配置・移動先は、描かれている計画折れ線のサンプル列から選ぶ。
import type * as THREE from 'three/webgpu';
import type { KinematicState } from '../../physics/kinematic-state';
import { fromOrbitAxes, kinematicState, orbitAxes } from '../../physics/kinematic-state';
import type { OrbitalElements } from '../../physics/elements';
import { orbitalElementsOf } from '../../physics/elements';
import { bodyAnchorSource, strongestAttractor } from '../../physics/attractor';
import type { Projected } from '../../math/projection';
import type { Vec3 } from '../../math/vec3';
import { add, v3 } from '../../math/vec3';
import { pickNearest } from '../pickable/object-pickable';
import type { HudLayers } from '../hud/hud-layers';
import type { Notifier } from '../../hud/notifier';
import { ContextMenu } from '../hud/windows/context-menu';
import { MenuCommon, type MenuAction } from '../hud/windows/menu-actions';
import type { UiSoundQueue } from '../ui-sound-queue';
import type { Input } from '../../input/input';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { focusPoint } from '../viewer/focus-target';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { AxisHandleSpec, NodeHandleSpec } from './node-gizmo';
import { NodeGizmo } from './node-gizmo';
import { AxisDragGizmo } from './plan-axis-drag';
import { PlanGizmo3D } from '../../render/plan/plan-gizmo-3d';
import { PlanPanel } from './plan-panel';
import type { Plan } from './plan';
import type { DisplayWindowManager } from '../display-window-manager';
import type { PlanCommands } from './plan-commands';
import {
  bodyStateFor, nodeDeltaVLocal, nodeDeltaVMag, periapsisInAtmosphere, rebuildDraggedNode,
} from './plan-node-editing';
import type { SimSpeedCommands } from '../dynamic/sim-speed-commands';
import type { FloatingOrigin } from '../../render/camera/floating-origin';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { ControlSelection } from '../control-selection';
import type { PlanPath } from './plan-path';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { FocusCameraCommands } from '../viewer/camera-commands';

const NODE_PICK_PX = 30; // 軌道クリック判定の許容距離 [px]

const NODE_MIN_DV = 0.5; // Δv がこれ未満のノードは空とみなし、編集の区切りで破棄する [m/s]
const MAX_PLAN_NODE_MARKERS = 12; // 画面上に表示するノードマーカーの上限(HUD要素数の上限)

export class PlanEditor {
  // 編集対象として選択中のノード。index でなく参照で持つので、実行済みノードが列の前方から
  // 取り除かれても選択がずれない。ノードを置き換えたらこの参照も差し替える。
  private selectedNode: KinematicState | null = null;

  // 直前の update() で操作対象だったもの。操作対象の切替を検出する。
  private lastSeenShip: Controllable | null = null;

  // 選択中ノードの現在の index。列に無ければ null。
  public get selectedNodeIdx(): number | null {
    const plan = this.plan;
    if (this.selectedNode === null || plan === null) return null;
    const idx = plan.nodes.indexOf(this.selectedNode);
    return idx < 0 ? null : idx;
  }

  // index で選び直す。null か範囲外なら選択なしになる。
  public set selectedNodeIdx(idx: number | null) {
    this.selectedNode = idx === null ? null : this.plan?.nodes[idx] ?? null;
  }

  // 操作対象(自機船または基地)。
  private get ship(): Controllable | null {
    return this.controlSelection.current;
  }

  // 操作対象自身の計画。操作対象を切り替えると編集対象もその計画へ切り替わる。
  private get plan(): Plan | null { return this.controlSelection.current?.plan ?? null; }

  private readonly gizmo3d: PlanGizmo3D;

  private readonly nodeGizmo: NodeGizmo;
  // ノード以外の計画軌道上を右クリックしたときのメニュー。
  private readonly orbitMenu: ContextMenu<KinematicState, MenuAction>;

  private readonly axisDrag: AxisDragGizmo;

  private readonly panel: PlanPanel;

  // このフレームに積み上がった Δv の、到着軌道基準(PRO/NRM/RAD)成分 [m/s]。加算が
  // 一度も無ければ null。
  private pendingDvLocal: Vec3 | null = null;

  // ノードギズモと計画パネルの DOM を組み立て、両者のコールバックを配線する。
  // path は描画対象の計画折れ線 — ノードの配置・移動・スクリーン座標はそのサンプル列から算出する。
  public constructor(
    private readonly hud: HudLayers & Notifier,
    private readonly uiSounds: UiSoundQueue,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly simSpeedCommands: SimSpeedCommands,
    private readonly celestialBodies: CelestialBodies,
    scene: THREE.Scene,
    private readonly controlSelection: ControlSelection,
    private readonly displayWindowManager: Pick<DisplayWindowManager, 'current' | 'durationSec'>,
    private readonly mapFocusCommands: Pick<FocusCameraCommands, 'setFocus'>,
    private readonly path: PlanPath,
    private readonly planCommands: PlanCommands,
  ) {
    // マップ上の操作物(ノードギズモ・軌道メニュー・3D 矢印・Δv アーム)
    this.nodeGizmo = new NodeGizmo(this.hud.layers.marker, this.hud.overlayManager);
    this.orbitMenu = new ContextMenu<KinematicState, MenuAction>(this.hud.overlayManager);
    this.gizmo3d = new PlanGizmo3D(scene);
    this.axisDrag = new AxisDragGizmo(
      (state) => bodyStateFor(state, this.celestialBodies),
      (r, t) => this.path.projectPoint(r, t),
      (axis, sign, amount) => this.addPendingDv(axis, sign, amount),
    );

    // 計画パネルと、その入力欄の反映先
    this.panel = new PlanPanel(this.hud.mapRoot);
    this.panel.onDvInputChange = (pro, nrm, rad) => this.setNodeDvLocal(pro, nrm, rad);
    this.panel.onPositionInputChange = (secondsFromNow) => this.setSelectedNodeTime(secondsFromNow);

    // メニューとギズモのコールバック
    this.orbitMenu.onSelect = (act, state) => {
      if (act === 'warp') this.warpTo(state.t);
    };
    this.wireNodeGizmo();
  }

  // 直近の進行が確定させた simTime [s]。
  private get simTime(): number { return this.displayWindowManager.current.simTime; }

  // 時刻 t まで自動ワープを始める。既に通過した時刻ならその旨を出すだけで何もしない。
  public warpTo(t: number): void {
    if (!this.simSpeedManager.canAutoWarpTo(t, this.simTime)) {
      this.hud.hint('この時刻は既に通過しています', undefined, 'warn');
      return;
    }
    this.simSpeedCommands.startAutoWarpTo(t, this.simTime);
    this.hud.hint('指定時刻まで自動ワープ開始', undefined, 'nav');
  }

  // NodeGizmo の各種コールバックを配線する。
  private wireNodeGizmo(): void {
    const g = this.nodeGizmo;
    // ノードハンドルと Δv アームのポインタ操作
    g.onNodeSelect = (idx) => {
      this.selectedNodeIdx = idx;
      this.closeMenu();
      this.uiSounds.push('warp');
    };
    g.onNodeDragMove = (idx, clientX, clientY) => {
      this.closeMenu();
      this.dragNodeToNearestSample(idx, clientX, clientY);
    };
    g.onNodeContextMenu = (clientX, clientY) => { this.handleNodeRightClick(clientX, clientY); };
    g.onAxisDrag = (axis, sign, deltaPx) => {
      this.axisDrag.applyAxisDrag(axis, sign, deltaPx, this.ship?.fineAttitude ?? false);
    };
    // ノードのコンテキストメニューの項目
    g.onMenuWarpTo = (idx) => {
      const n = this.plan?.nodes[idx];
      if (n) this.warpTo(n.t);
    };
    g.onMenuDelete = (idx) => {
      this.deleteNode(idx);
    };
    g.onMenuFocus = (idx) => {
      const n = this.plan?.nodes[idx];
      if (!n) return;
      const frames = this.celestialBodies.frames;
      this.mapFocusCommands.setFocus(focusPoint(frames, frames.inertialFrame, n.r, n.t, bodyAnchorSource([], n.t)));
    };
  }

  // ノードのコンテキストメニューを閉じる。
  public closeMenu(): void {
    this.nodeGizmo.closeMenu();
    this.orbitMenu.close();
  }

  // idx 番目のノードを削除する。
  private deleteNode(idx: number): void {
    const plan = this.plan;
    if (!plan?.nodes[idx]) return;
    this.planCommands.removeNode(plan, idx);
    this.closeMenu();
    this.simSpeedCommands.cancelAutoWarp();
    this.hud.hint('ノードを削除', undefined, 'plan');
  }

  // 選択中のノードを削除する。未選択なら計画全体を破棄し、進行中の自動ワープも解除する。
  private deleteSelectedNodeOrPlan(): void {
    if (this.selectedNodeIdx !== null) {
      this.deleteNode(this.selectedNodeIdx);
      return;
    }
    const plan = this.plan;
    if (!plan || plan.nodes.length <= 0) return;
    this.planCommands.clear(plan);
    this.simSpeedCommands.cancelAutoWarp();
    this.hud.hint('マニューバ計画を破棄', undefined, 'plan');
  }

  // 計画キー([X] 削除・[N] 直近ノードへの自動ワープ)の単発入力 commandId を実行する。
  public handleCommand(commandId: string): void {
    if (commandId === K.deleteNode.code) this.deleteSelectedNodeOrPlan();
    if (commandId === K.autoWarpToNode.code) {
      this.simSpeedCommands.toggleAutoWarpToFirstNode(this.plan?.firstNode(), this.simTime);
    }
  }

  // WASDQE・長押しボタン・ラッチによる Δv 編集を進める。
  public updateActions(input: Input, dt: number): void {
    this.updateEditing(input, dt);
  }

  // マップ上のクリック・右クリックをノード選択/配置とコンテキストメニューへ振り分ける。
  // 操作対象がいなければ計画が無いので、クリックは後の受け手へ残す。
  public handleMapPointer(input: Input): void {
    if (this.plan === null) return;
    input.takeRightClicks((p) => this.handleNodeRightClick(p.x, p.y));
    input.takeClicks((p) => {
      this.handleMapClick(p.x, p.y);
      return true;
    });
  }

  // ノードの画面座標を投影する。
  private nodeScreenPos(node: KinematicState): Projected {
    return this.path.projectPoint(node.r, node.t);
  }

  // クリック位置の許容半径内で画面上もっとも近いノードの番号。圏外なら null。
  private pickNodeAt(mx: number, my: number): number | null {
    const nodes = this.plan?.nodes ?? [];
    const node = pickNearest(
      nodes, (n) => this.nodeScreenPos(n), mx, my, NODE_PICK_PX * NODE_PICK_PX);
    return node === null ? null : nodes.indexOf(node);
  }

  // クリック位置に最も近い既存ノードを選択する。ヒットしなければ計画軌道上の最寄り点へ
  // 新規ノードを配置し、それも外れていれば選択を解除する。
  private handleMapClick(mx: number, my: number): void {
    const ship = this.ship;
    if (!ship) return;
    const bestNodeIdx = this.pickNodeAt(mx, my);
    // 選択が外れるクリックを編集の区切りとして、Δv を一度も加えていない空のノードを破棄する。
    // 毎フレーム削除すると、置いた直後にギズモを操作する前に消えてしまう。
    const dropped = this.selectedNodeIdx !== null && this.selectedNodeIdx !== bestNodeIdx
      ? this.selectedEmptyNodeIdx()
      : null;
    if (dropped !== null) this.removeSelectedNode(dropped);
    if (bestNodeIdx !== null) {
      this.selectedNodeIdx = bestNodeIdx;
      this.uiSounds.push('warp');
      return;
    }

    // 見つからなければ計画軌道上の最寄り点にノードを配置。折れ線が自分自身に重なっていれば
    // その位置に最初に到達する時刻(= referenceT を -Infinity にして最早時刻)を選ぶ。
    const picked = this.path.nearestSample(mx, my, NODE_PICK_PX, -Infinity);
    if (picked) {
      // 先頭ノードを捨てた計画は起点ごと落ちるので、置けるかどうかもその後の起点で判定する。
      const shipState = ship.motion.state;
      this.placeNode(ship.plan, picked.state, dropped === 0 ? shipState : ship.plan.anchorOr(shipState));
      return;
    }

    // ノードにも計画軌道にも当たらないクリックは選択解除
    this.selectedNodeIdx = null;
  }

  // i 番目のノードに有意な Δv が入っていないか。到達状態を再計算できない間は判定を保留し、
  // 空とは見なさない(消してよいかどうかがまだ分からないため)。
  private isEmptyNode(i: number, arriving: readonly (KinematicState | null)[]): boolean {
    const plan = this.plan;
    return plan !== null && nodeDeltaVMag(plan, i, arriving) < NODE_MIN_DV;
  }

  // 選択中ノードが実質的に空なら、その index。選択が無いか、空でなければ null。
  private selectedEmptyNodeIdx(): number | null {
    const idx = this.selectedNodeIdx;
    if (idx === null || this.plan === null) return null;
    return this.isEmptyNode(idx, this.path.arrivalStates()) ? idx : null;
  }

  // idx 番目の選択中ノードを削除し、選択を外す。
  private removeSelectedNode(idx: number): void {
    const plan = this.plan;
    if (plan === null) return;
    this.planCommands.removeNode(plan, idx);
    this.selectedNodeIdx = null;
  }

  // 時刻 t の計画軌道上の状態にノードを追加し、選択する。その時刻の計画軌道が
  // 求まらなければ(折れ線の届く範囲外など)ヒントを出すだけで何もしない。
  public addNodeAt(t: number): void {
    const ship = this.ship;
    if (!ship) return;
    const sample = this.path.sampleAt(t);
    if (!sample) {
      this.hud.hint('この時刻の計画軌道が求まりません', undefined, 'warn');
      return;
    }
    this.placeNode(ship.plan, sample, ship.plan.anchorOr(ship.motion.state));
  }

  // 噴射直後の絶対状態 postState を plan へ置き、選択する。anchor は置いた後に効く計画の起点
  // で、その時刻以前は計画の外なので理由を伝えて何もしない。
  private placeNode(plan: Plan, postState: KinematicState, anchor: KinematicState): void {
    if (plan.nodeIndexFor(postState.t, anchor) < 0) {
      this.hud.hint('計画の起点より前にはノードを置けません', undefined, 'warn');
      return;
    }
    this.selectedNode = postState;
    this.planCommands.addNode(plan, postState, anchor);
    this.uiSounds.push('warp');
  }

  // 既存ノード近傍ならそれを選択してコンテキストメニューを開き true を返す。外れは false。
  private handleNodeRightClick(mx: number, my: number): boolean {
    const bestIdx = this.pickNodeAt(mx, my);
    if (bestIdx === null) {
      // 計画軌道上の右クリックは、その位置の時刻へのワープメニュー。
      const picked = this.path.nearestSample(mx, my, NODE_PICK_PX, -Infinity);
      if (!picked) return false;
      this.selectedNodeIdx = null;
      this.orbitMenu.open(mx, my, picked.state, [
        MenuCommon.warp(),
        MenuCommon.cancel(),
      ]);
      return true;
    }
    this.selectedNodeIdx = bestIdx;
    this.orbitMenu.close();
    this.nodeGizmo.openMenu(mx, my, bestIdx);
    return true;
  }

  // ドラッグ中のノードを、置ける時刻範囲の中で最寄りの計画軌道サンプル時刻へ移動する。折れ線が
  // 自分自身に重なる区間では、そのノードの現在時刻に最も近い候補を選ぶ(= 遠い周回のノードを
  // 掴んでも周回0へ飛ばない)。
  private dragNodeToNearestSample(idx: number, clientX: number, clientY: number): void {
    const ship = this.ship;
    if (!ship) return;
    const node = ship.plan.nodes[idx];
    if (!node) return;
    // 置ける時刻範囲の中で、ポインタに最も近いサンプルを引く
    const arriving = this.path.arrivalStates();
    const picked = this.path.nearestSample(
      clientX, clientY, Infinity, node.t,
      ship.plan.nodeTimeRange(
        idx, ship.motion.state, this.celestialBodies.celestialMotions, this.displayWindowManager,
      ),
    );
    // Δv を保ったまま移動先へ置き換える
    if (picked) {
      const moved = rebuildDraggedNode(
        ship.plan, picked.state, picked.arcIdx, idx, arriving, this.celestialBodies,
      ) ?? picked.state;
      this.selectedNode = moved;
      this.planCommands.replaceNode(ship.plan, idx, moved);
    }
  }

  // 選択中ノードを、現在時刻から secondsFromNow 秒後の計画軌道サンプルへ移動する。Δv は到着軌道の
  // ローカル成分を保つ。置ける範囲外・軌道が求まらない時刻ではヒントを出すだけにする。
  private setSelectedNodeTime(secondsFromNow: number): void {
    const ship = this.ship;
    const plan = this.plan;
    const idx = this.selectedNodeIdx;
    if (!ship || !plan || idx === null || !isFinite(secondsFromNow)) return;

    // 指定時刻が置ける範囲に入っているか(丸め誤差ぶんは許す)
    const node = plan.nodes[idx];
    if (!node) return;
    const hasDownstreamNodes = idx < plan.nodes.length - 1;
    const targetT = this.simTime + secondsFromNow;
    const range = plan.nodeTimeRange(
      idx, ship.motion.state, this.celestialBodies.celestialMotions, this.displayWindowManager,
    );
    const epsilon = 1e-6;
    if (targetT < range.min - epsilon || targetT > range.max + epsilon) {
      this.hud.hint('ノード位置は許可された軌道区間内で指定してください', undefined, 'warn');
      return;
    }
    if (Math.abs(targetT - node.t) <= epsilon) return;

    // その時刻の計画軌道のサンプル
    const picked = this.path.sampleAtWithArc(targetT);
    if (!picked) {
      this.hud.hint('この時刻の計画軌道が求まりません', undefined, 'warn');
      return;
    }

    // Δv を保ったまま置き換え、後続ノードがあれば再設定を促す
    const arriving = this.path.arrivalStates();
    const moved = rebuildDraggedNode(
      plan, picked.state, picked.arcIdx, idx, arriving, this.celestialBodies,
    ) ?? picked.state;
    this.selectedNode = moved;
    this.planCommands.replaceNode(plan, idx, moved);
    this.uiSounds.push('warp');
    if (hasDownstreamNodes) this.hud.hint('ノード位置を変更しました。後続ノードを再設定してください', undefined, 'plan');
  }

  // 選択中ノードの axis 方向(sign 込み)へ amount [m/s] の Δv 加算を積む。
  // amount がゼロなら何もしない — 変化のない加算でも下流ノードは破棄されてしまう。
  private addPendingDv(axis: 0 | 1 | 2, sign: 1 | -1, amount: number): void {
    if (amount === 0) return;
    const d = amount * sign;
    const local = v3(axis === 0 ? d : 0, axis === 1 ? d : 0, axis === 2 ? d : 0);
    this.pendingDvLocal = this.pendingDvLocal === null ? local : add(this.pendingDvLocal, local);
  }

  // 積み上がった Δv を、選択中ノードの1つの差し替えへまとめて列へ積む。1フレームの間に
  // 何方向から何度加算しても命令は1つになるので、同じ加算が二重に効かない。
  private submitPendingDv(): void {
    const local = this.pendingDvLocal;
    this.pendingDvLocal = null;
    const idx = this.selectedNodeIdx;
    const plan = this.plan;
    if (local === null || idx === null || plan === null) return;
    // 基底は到着(噴射前)状態で組む — 噴射後の基底ではパネル・3D 矢印・アームの基底と食い違う。
    const arr = this.path.arrivalStates()[idx];
    const node = plan.nodes[idx];
    if (!arr || !node) return;
    const dvWorld = fromOrbitAxes(bodyStateFor(arr, this.celestialBodies), local);
    const burned = kinematicState<'eci'>(node.t, node.r, add(node.v, dvWorld));
    this.selectedNode = burned;
    this.planCommands.replaceNode(plan, idx, burned);
  }

  // 選択中ノードの Δv を、到着軌道基準の成分 (pro, nrm, rad) [m/s] の絶対量で上書きする。
  private setNodeDvLocal(pro: number, nrm: number, rad: number): void {
    const plan = this.plan;
    const idx = this.selectedNodeIdx;
    if (!plan || idx === null) return;
    const arr = this.path.arrivalStates()[idx];
    const node = plan.nodes[idx];
    if (!arr || !node) return;

    // 到着状態の軌道基準枠で組んだ Δv を、到着速度へ足す。
    const dvWorld = fromOrbitAxes(bodyStateFor(arr, this.celestialBodies), v3(pro, nrm, rad));
    const burned = kinematicState<'eci'>(node.t, node.r, add(arr.v, dvWorld));
    this.selectedNode = burned;
    this.planCommands.replaceNode(plan, idx, burned);
    this.uiSounds.push('warp');
  }

  // 表示上限までのノードハンドルと、選択中ノードがあれば Δv アームの仕様を組み立ててギズモへ渡す。
  private syncGizmo(plan: Plan, mapDist: number, fo: FloatingOrigin): void {
    const arriving = this.path.arrivalStates();
    const nodeSpecs: NodeHandleSpec[] = [];
    const limit = Math.min(plan.nodes.length, MAX_PLAN_NODE_MARKERS);
    // 各ノードの画面座標とラベルを組む
    for (let i = 0; i < limit; i++) {
      const node = plan.nodes[i]!;
      const p = this.nodeScreenPos(node);
      if (!p.front) continue;
      nodeSpecs.push({
        idx: i, x: p.x, y: p.y, selected: i === this.selectedNodeIdx,
        dvMag: nodeDeltaVMag(plan, i, arriving),
      });
    }
    // 選択中ノードがあれば Δv アームも組む
    let axisSpecs: AxisHandleSpec[] | null = null;
    let nodeFor3D: KinematicState | null = null;
    let arrFor3D: KinematicState | null = null;
    if (this.selectedNodeIdx !== null) {
      const node = plan.nodes[this.selectedNodeIdx];
      if (node) {
        nodeFor3D = node;
        arrFor3D = arriving[this.selectedNodeIdx] ?? null;
        const p = this.nodeScreenPos(node);
        if (p.front) axisSpecs = this.axisDrag.buildAxisHandles(p.x, p.y, arrFor3D ?? node, mapDist);
      }
    }
    this.nodeGizmo.sync(nodeSpecs, axisSpecs);

    // 3D 矢印は、選択中ノードとその到着状態が揃っているフレームだけ出す
    if (nodeFor3D && arrFor3D) {
      const axes = orbitAxes(bodyStateFor(arrFor3D, this.celestialBodies));
      this.gizmo3d.sync({
        position: fo.RtoThreeV3(this.path.toDisplay(nodeFor3D.r, nodeFor3D.t)),
        prograde: this.path.toDisplayDir(axes.pro, nodeFor3D.t),
        normal: this.path.toDisplayDir(axes.nrm, nodeFor3D.t),
        mapDist,
        stretchedArm: this.nodeGizmo.axisHandleDrag,
      });
    } else {
      this.gizmo3d.sync(null);
    }
  }

  // WASDQE キー・長押しボタン・Δv アームのラッチドラッグから選択中ノードの Δv を加算する。
  private updateEditing(input: Input, dt: number): void {
    if (this.selectedNodeIdx === null) {
      this.axisDrag.resetHold();
      this.pendingDvLocal = null;
      return;
    }
    const fine = this.ship?.fineAttitude ?? false;
    const b = this.panel.dvButtons;
    this.axisDrag.applyHeldDv(0, 1, input.takeHeld(K.dvPrograde) || b.pro.isHeld, dt, fine);
    this.axisDrag.applyHeldDv(0, -1, input.takeHeld(K.dvRetrograde) || b.ret.isHeld, dt, fine);
    this.axisDrag.applyHeldDv(1, 1, input.takeHeld(K.dvNormal) || b.nrm.isHeld, dt, fine);
    this.axisDrag.applyHeldDv(1, -1, input.takeHeld(K.dvAntinormal) || b.anm.isHeld, dt, fine);
    this.axisDrag.applyHeldDv(2, 1, input.takeHeld(K.dvRadialOut) || b.out.isHeld, dt, fine);
    this.axisDrag.applyHeldDv(2, -1, input.takeHeld(K.dvRadialIn) || b.in.isHeld, dt, fine);

    // ラッチ中の Δv アームは、閾値超過量に比例したレートで dt 秒分を加算し続ける。
    const drag = this.nodeGizmo.axisHandleDrag;
    if (drag && drag.excessPx !== null) this.axisDrag.applyLatchDv(drag.axis, drag.sign, drag.excessPx, dt, fine);

    this.submitPendingDv();
  }

  // 現在のノード列と選択中ノードから、計画パネルへ渡す表示値を組み立てて反映する。
  private syncPanel(ship: Controllable): void {
    const plan = ship.plan;
    const arriving = this.path.arrivalStates();
    const nodes = plan.nodes.map((n, i) => ({
      tRel: n.t - this.simTime, dvMag: nodeDeltaVMag(plan, i, arriving),
    }));
    const idx = this.selectedNodeIdx;
    const node = idx === null ? null : plan.nodes[idx];
    const localDv = idx === null ? null : nodeDeltaVLocal(
      plan, idx, arriving, this.celestialBodies,
    );
    // 到着状態が求まっている選択中ノードについて、噴射後の軌道要素と近点の大気圏警告を出す
    let selEl: OrbitalElements | null = null;
    let peInAtmosphere = false;
    if (node && localDv) {
      const center = strongestAttractor(node.r, this.celestialBodies.celestialMotions, node.t);
      selEl = orbitalElementsOf(node, center, node.t);
      peInAtmosphere = selEl !== null && periapsisInAtmosphere(selEl, node.t);
    }
    this.panel.sync(nodes, idx, selEl, localDv, peInAtmosphere);
  }

  // ノードギズモ・軌道右クリックメニュー・パネル・3D ギズモを片付ける。
  public dispose(): void {
    this.nodeGizmo.dispose();
    this.orbitMenu.dispose();
    this.panel.dispose();
    this.gizmo3d.dispose();
  }

  // 操作対象が替わったフレームで、前の艦のノードに開いたままのメニューを畳む。
  public update(): void {
    const ship = this.ship;
    if (ship !== this.lastSeenShip) {
      this.lastSeenShip = ship;
      this.closeMenu();
    }
  }

  // 操作 UI(ノードギズモ・Δv アーム・3D 矢印・計画パネル)を現在の選択と画面座標で組み直す。
  public sync(mapDist: number, fo: FloatingOrigin): void {
    const ship = this.ship;
    if (ship === null) return;
    this.syncGizmo(ship.plan, mapDist, fo);
    this.syncPanel(ship);
  }

  // パネルとギズモを隠し、実質 Δv がゼロの末尾ノードを間引いて計画を整理する。
  public onMapClosed(): void {
    this.panel.hide();
    this.nodeGizmo.sync([], null);
    this.gizmo3d.sync(null);
    const plan = this.plan;
    if (plan) {
      const arriving = this.path.arrivalStates();
      // 末尾から Δv が有意なノードに当たるまで削る。
      let cut = plan.nodes.length;
      while (cut > 0 && this.isEmptyNode(cut - 1, arriving)) cut--;
      if (cut < plan.nodes.length) this.planCommands.removeNode(plan, cut);
    }
    this.selectedNodeIdx = null;
  }
}

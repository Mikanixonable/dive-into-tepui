// 軌道計画の編集(ノードの配置・時刻移動・Δv 調整・選択・削除)と計画パネルへの反映。
// 未来表示(計画折れ線・ゴースト)は PlanDisplay を所有・駆動することで行う。パネルの DOM
// (ノード一覧・Δv 手動入力欄)は PlanPanel が持つ。
import type * as THREE from 'three/webgpu';
import { KinematicState, fromOrbitAxes, kinematicState, orbitAxes } from '../../physics/kinematic-state';
import { OrbitalElements } from '../../physics/elements';
import { Projected } from '../../physics/projection';
import { Vec3, add, dot, len, scale, sub, v3 } from '../../physics/vec3';
import type { Ephemeris } from '../../physics/ephemeris';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { ContextMenu } from '../hud/context-menu';
import { MenuAction, MenuCommon } from '../hud/menu-actions';
import { UiSfx } from '../../audio/ui-sfx';
import type { MarkerManager } from '../marker/marker-manager';
import type { FloatingOrigin } from '../floating-origin';
import type { CameraSystem } from '../camera/camera-system';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { AxisHandleSpec, NodeGizmo, NodeHandleSpec } from './node-gizmo';
import { PlanGizmo3D } from './plan-gizmo-3d';
import { PlanPanel } from './plan-panel';
import { DisplayDurationSource, Plan, PlanData } from './plan';
import { PlanDisplay } from './plan-display';
import { SimSpeedManager } from '../sim-speed-manager';
import type { Player } from '../player/player';
import type { ActivePlayerController } from '../active-player-controller';
import type { FrameControls } from '../hud/frame-controls';
import { focusPoint } from '../camera/focus-target';
import { Attractor, orbitalElementsOf, frameOfAttractor, strongestAttractor } from '../../physics/attractor';
import { toFrameState } from '../../physics/frame';
import { planAttractorProvider, planSourceRevision } from '../simulation/attractors';
import type { EntityManager } from '../simulation/entity-manager';
import type { DisplayWindow } from '../display-window-manager';
import type { PerfCounts } from '../../perf-meter';

// ホールド継続時間 [s] から Δv 加算レートを指数的に求める。押し始めは細かく、長押しで粗くなる。
function rampedDvRate(heldSec: number): number {
  const t = Math.min(heldSec / C.DV_RATE_RAMP_SEC, 1);
  return C.DV_RATE_MIN * (C.DV_RATE_MAX / C.DV_RATE_MIN) ** t;
}

export class PlanEditor {
  // 編集対象として選択中のノード。ノードは不変オブジェクトで、編集のたびに新しい
  // KinematicState へ置き換わる — 選択を参照で持てば、編集で置き換わった場合も、
  // 実行済みとして列の前方から取り除かれた場合も、同じ同一性判定で追随できる。
  private selectedNode: KinematicState | null = null;

  // 直前の update() で操作対象だった艦。切替の検出だけに使う(正本は ActivePlayerController)。
  private lastSeenShip: Player | null = null;

  // 選択中ノードの現在の index。列に無ければ null。
  get selectedNodeIdx(): number | null {
    const plan = this.plan;
    if (this.selectedNode === null || plan === null) return null;
    const idx = plan.nodes.indexOf(this.selectedNode);
    return idx < 0 ? null : idx;
  }

  set selectedNodeIdx(idx: number | null) {
    this.selectedNode = idx === null ? null : this.plan?.nodes[idx] ?? null;
  }

  // 操作対象の艦。ノードの起点として自機状態が要るときだけ引く。
  private get ship(): Player | null { return this.activePlayers.current; }

  // 操作艦自身の計画。艦は自分の計画を所有し続けるので、艦を切り替えると編集対象も
  // その艦の計画へ切り替わる。艦がいなければ編集する計画も無い。
  get plan(): Plan | null { return this.activePlayers.current?.plan ?? null; }

  readonly planDisplay: PlanDisplay;
  private readonly gizmo3d: PlanGizmo3D;

  // 直近の update() が描いた折れ線が届いている終端時刻。一度も描いていなければ NaN。
  private get lastPlanEnd(): number { return this.planDisplay.path.timeRange()?.max ?? NaN; }

  private _editMode = false;
  get editMode(): boolean { return this._editMode; }
  setMapMode(open: boolean): void { this._editMode = open; }

  // Δv 編集中かどうか。編集モードで、かつノードを1つ選択している間だけ真。
  private get dvEditActive(): boolean { return this.editMode && this.selectedNodeIdx !== null; }

  readonly nodeGizmo: NodeGizmo;
  // ノード以外の計画軌道上を右クリックしたときのメニュー。
  private readonly orbitMenu: ContextMenu<KinematicState, MenuAction>;

  // 6 方向それぞれのホールド継続時間 [s]。index は axis*2 + (sign<0 ? 1 : 0)。
  private readonly dvHoldTime: number[] = [0, 0, 0, 0, 0, 0];

  private readonly panel: PlanPanel;
  private simTime = 0;

  // ノードギズモと計画パネルの DOM を組み立て、両者のコールバックを配線する。
  constructor(
    private readonly _hud: Hud,
    private readonly _uiSfx: UiSfx,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly ephemeris: Ephemeris,
    private readonly entities: EntityManager,
    scene: THREE.Scene,
    private readonly markerManager: MarkerManager,
    private readonly activePlayers: ActivePlayerController,
    private readonly displayDuration: DisplayDurationSource,
    private readonly frameControls: FrameControls,
  ) {
    this.planDisplay = new PlanDisplay(scene, markerManager, ephemeris, displayDuration);
    this.nodeGizmo = new NodeGizmo(this._hud.layers.marker, this._hud.layers.popup, this._hud.overlayManager);
    this.orbitMenu = new ContextMenu<KinematicState, MenuAction>(this._hud.layers.popup, this._hud.overlayManager);
    this.gizmo3d = new PlanGizmo3D();
    scene.add(this.gizmo3d.group);

    this.panel = new PlanPanel(this._hud.mapRoot);
    this.panel.onDvInputChange = (pro, nrm, rad) => this.setNodeDvLocal(pro, nrm, rad);
    this.panel.onPositionInputChange = (secondsFromNow) => this.setSelectedNodeTime(secondsFromNow);

    this.orbitMenu.onSelect = (act, state) => {
      if (act !== 'warp') return;
      if (this.simSpeedManager.startAutoWarpTo(state.t, this.simTime)) this._hud.hint('指定位置まで自動ワープ開始');
      else this._hud.hint('この時刻は既に通過しています');
    };
    this.wireNodeGizmo();
  }

  // NodeGizmo の各種コールバックを配線する。
  private wireNodeGizmo(): void {
    const g = this.nodeGizmo;
    g.onNodeSelect = (idx) => {
      this.selectedNodeIdx = idx;
      this.closeMenu();
      this._uiSfx.warp();
    };
    g.onNodeDragMove = (idx, clientX, clientY) => {
      this.closeMenu();
      this.dragNodeToNearestSample(idx, clientX, clientY);
    };
    g.onNodeContextMenu = (clientX, clientY) => { this.handleNodeRightClick(clientX, clientY); };
    g.onAxisDrag = (axis, sign, deltaPx) => {
      this.applyAxisDrag(axis, sign, deltaPx, this.ship?.fineAttitude ?? false);
    };
    // 指定ノードの時刻まで自動ワープを開始する
    g.onMenuWarpTo = (idx) => {
      const n = this.plan?.nodes[idx];
      if (!n) return;
      if (this.simSpeedManager.startAutoWarpTo(n.t, this.simTime)) this._hud.hint('指定時刻まで自動ワープ開始');
      else this._hud.hint('この時刻は既に通過しています');
    };
    g.onMenuDelete = (idx) => {
      this.deleteNode(idx);
    };
    g.onMenuFocus = (idx) => {
      const n = this.plan?.nodes[idx];
      if (n) this.frameControls.setFocus(
        focusPoint(this.ephemeris, this.ephemeris.inertialFrame, n.r, n.t));
    };
  }

  // ノードのコンテキストメニューを閉じる。
  closeMenu(): void {
    this.nodeGizmo.closeMenu();
    this.orbitMenu.close();
  }

  // idx 番目のノードを削除する。
  deleteNode(idx: number): void {
    const plan = this.plan;
    if (!plan?.nodes[idx]) return;
    plan.removeNode(idx);
    this.closeMenu();
    this.simSpeedManager.cancelAutoWarp();
    this._hud.hint('ノードを削除');
  }

  // 選択中のノードを削除する。
  deleteSelected(): void {
    if (this.selectedNodeIdx === null) return;
    this.deleteNode(this.selectedNodeIdx);
  }

  // 選択ノード削除キーと、直近ノードへの自動ワープキーの入力を処理し、続けてΔv編集を進める。
  handleInput(input: Input, dt: number): void {
    if (input.takeKey(K.deleteNode)) this.clearPlanByKey();
    // 編集モード中は WASDQE と同じく [N] も Δv 編集側へ譲る。
    if (!this.editMode && input.takeKey(K.autoWarpToNode)) {
      this.simSpeedManager.toggleAutoWarpToFirstNode(this.plan?.firstNode(), this.simTime);
    }
    this.updateEditing(input, dt);
  }

  // マップ上のクリック・右クリックをノード選択/配置とコンテキストメニューへ振り分ける。
  // 編集モードでなければ、また艦がいなければ計画そのものが無いので、クリックはここで捨てる。
  handleMapPointer(input: Input): void {
    if (!this.editMode || this.plan === null) return;
    input.takeRightClicks((p) => this.handleNodeRightClick(p.x, p.y));
    input.takeClicks((p) => {
      this.handleMapClick(p.x, p.y);
      return true;
    });
  }

  // 編集中は選択ノードを削除し、そうでなければ計画全体を破棄する。
  private clearPlanByKey(): void {
    if (this.editMode) {
      this.deleteSelected();
      return;
    }
    const plan = this.plan;
    if (!plan || plan.nodes.length <= 0) return;
    plan.clear();
    this.simSpeedManager.cancelAutoWarp();
    this._hud.hint('マニューバ計画を破棄');
  }

  // ノードの画面座標を投影する。
  private nodeScreenPos(node: KinematicState): Projected {
    return this.planDisplay.path.projectPoint(node.r, node.t);
  }

  private pickNodeAt(mx: number, my: number): number | null {
    const nodes = this.plan?.nodes ?? [];
    let bestIdx: number | null = null;
    let bestD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (let i = 0; i < nodes.length; i++) {
      const p = this.nodeScreenPos(nodes[i]!);
      if (!p.front) continue;
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  // クリック位置に最も近い既存ノードを選択する。ヒットしなければ計画軌道上の最寄り点へ
  // 新規ノードを配置し、それも外れていれば選択を解除する。
  private handleMapClick(mx: number, my: number): void {
    const ship = this.ship;
    if (!ship) return;
    const bestNodeIdx = this.pickNodeAt(mx, my);
    // ノードを置いた直後に同じノードをクリックした場合は編集を続ける。
    // 別の場所をクリックして選択対象が外れた場合だけ、Δv を一度も加えていない
    // 空のノードを破棄する。update() で毎フレーム削除すると、作成直後に
    // ギズモを操作する前に消えてしまうため、クリックを編集の区切りとする。
    if (this.selectedNodeIdx !== null && this.selectedNodeIdx !== bestNodeIdx) {
      this.removeSelectedIfEmpty();
    }
    if (bestNodeIdx !== null) {
      this.selectedNodeIdx = bestNodeIdx;
      this._uiSfx.warp();
      return;
    }

    // 見つからなければ計画軌道上の最寄り点にノードを配置。折れ線が自分自身に重なっていれば
    // その位置に最初に到達する時刻(= referenceT を -Infinity にして最早時刻)を選ぶ。
    const picked = this.planDisplay.path.nearestSample(mx, my, C.NODE_PICK_PX, -Infinity);
    if (picked) {
      this.selectNewNode(ship.plan.addNode(picked.state, ship.state));
      return;
    }

    // ノードにも計画軌道にも当たらないクリックは選択解除
    this.selectedNodeIdx = null;
  }

  // i 番目のノードに有意な Δv が入っていないか。到達状態を再計算できない間は判定を保留し、
  // 空とは見なさない(消してよいかどうかがまだ分からないため)。
  private isEmptyNode(i: number, arriving: readonly (KinematicState | null)[]): boolean {
    const node = this.plan?.nodes[i];
    const arr = arriving[i];
    if (!node || !arr) return false;
    return len(sub(node.v, arr.v)) < C.NODE_MIN_DV;
  }

  // 選択中ノードが実質的に空なら削除する。
  private removeSelectedIfEmpty(): void {
    const idx = this.selectedNodeIdx;
    if (idx === null) return;
    if (!this.isEmptyNode(idx, this.planDisplay.path.arrivalStates())) return;
    this.plan?.removeNode(idx);
    this.selectedNodeIdx = null;
  }

  // 時刻 t の計画軌道上の状態にノードを追加し、選択する。その時刻の計画軌道が
  // 求まらなければ(折れ線の届く範囲外など)ヒントを出すだけで何もしない。
  addNodeAt(t: number): void {
    const ship = this.ship;
    if (!ship) return;
    const sample = this.planDisplay.path.sampleAt(t);
    if (!sample) {
      this._hud.hint('この時刻の計画軌道が求まりません');
      return;
    }
    this.selectNewNode(ship.plan.addNode(sample, ship.state));
  }

  // addNode の結果を選択する。計画の起点より前は置けないので、その場合は理由を伝える。
  private selectNewNode(idx: number): void {
    if (idx < 0) {
      this._hud.hint('計画の起点より前にはノードを置けません');
      return;
    }
    this.selectedNodeIdx = idx;
    this._uiSfx.warp();
  }

  // 既存ノード近傍ならそれを選択してコンテキストメニューを開き true を返す。外れは false。
  private handleNodeRightClick(mx: number, my: number): boolean {
    const bestIdx = this.pickNodeAt(mx, my);
    if (bestIdx === null) {
      // ノードでなくても計画軌道上を右クリックすれば、その位置の時刻まで
      // 自動ワープできる。描画と同じサンプル列から求めるため、表示変換との
      // ずれや月基準フレームの差を生じさせない。
      const picked = this.planDisplay.path.nearestSample(mx, my, C.NODE_PICK_PX, -Infinity);
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
    const arriving = this.planDisplay.path.arrivalStates();
    const picked = this.planDisplay.path.nearestSample(
      clientX, clientY, Infinity, node.t,
      ship.plan.nodeTimeRange(idx, ship.state, this.ephemeris, this.displayDuration),
    );
    if (picked) {
      this.selectedNode = ship.plan.replaceNode(
        idx, this.rebuildDraggedNode(picked.state, picked.arcIdx, idx, arriving) ?? picked.state,
      );
    }
  }

  // 選択中ノードを、現在時刻から指定した秒数後の計画軌道サンプルへ移動する。位置を
  // 時刻として指定することで、J2・大気抵抗・第三天体摂動を含む数値積分結果とノードの
  // 位置を一致させる。Δv はドラッグ移動と同じく到着軌道のローカル成分を維持する。
  private setSelectedNodeTime(secondsFromNow: number): void {
    const ship = this.ship;
    const plan = this.plan;
    const idx = this.selectedNodeIdx;
    if (!ship || !plan || idx === null || !isFinite(secondsFromNow)) return;

    const node = plan.nodes[idx];
    if (!node) return;
    const hasDownstreamNodes = idx < plan.nodes.length - 1;
    const targetT = this.simTime + secondsFromNow;
    const range = plan.nodeTimeRange(idx, ship.state, this.ephemeris, this.displayDuration);
    const epsilon = 1e-6;
    if (targetT < range.min - epsilon || targetT > range.max + epsilon) {
      this._hud.hint('ノード位置は許可された軌道区間内で指定してください');
      return;
    }
    if (Math.abs(targetT - node.t) <= epsilon) return;

    const picked = this.planDisplay.path.sampleAtWithArc(targetT);
    if (!picked) {
      this._hud.hint('この時刻の計画軌道が求まりません');
      return;
    }

    const arriving = this.planDisplay.path.arrivalStates();
    const rebuilt = this.rebuildDraggedNode(picked.state, picked.arcIdx, idx, arriving);
    const replacement = plan.replaceNode(idx, rebuilt ?? picked.state);
    if (!replacement) return;
    this.selectedNode = replacement;
    this._uiSfx.warp();
    if (hasDownstreamNodes) this._hud.hint('ノード位置を変更しました。後続ノードを再設定してください');
  }

  // ドラッグで時刻を動かしても、ノードのΔv(機体座標系の加減速)は維持する。
  // これにより、同じマニューバを別時刻へ移し替えた計画として再描画できる。
  private rebuildDraggedNode(
    sample: KinematicState,
    arcIdx: number,
    idx: number,
    arriving: readonly (KinematicState | null)[],
  ): KinematicState | null {
    const plan = this.plan;
    if (!plan) return null;
    const node = plan.nodes[idx];
    const arr = arriving[idx];
    if (!node || !arr) return null;

    const dvWorldOld = sub(node.v, arr.v);
    // ノードより後ろの arc のサンプルは、そこへ至るまでに実行されたノードの Δv をすべて
    // 含んだ速度になっているので、加算前(プレバーン)の速度へ戻してから改めて Δv を組み立てる。
    // 置ける時刻範囲は直前の状態から表示期間ぶん伸びるため、2つ以上先の arc の
    // サンプルが範囲に入りうる — 自ノードぶんだけ引くと中間ノードの Δv が残る。
    let baseV = sample.v;
    for (let i = idx; i < arcIdx; i++) {
      const passed = plan.nodes[i];
      const passedArr = arriving[i];
      if (!passed || !passedArr) return null;
      baseV = sub(baseV, sub(passed.v, passedArr.v));
    }

    // 到着軌道基準のローカル Δv 成分を求め、移動先のプレバーン状態基準へ組み直す。
    const axesOld = orbitAxes(this.bodyState(arr));
    const dvLocal = v3(
      dot(dvWorldOld, axesOld.pro),
      dot(dvWorldOld, axesOld.nrm),
      dot(dvWorldOld, axesOld.radOut),
    );

    const newPreBurnState = kinematicState(sample.t, sample.r, baseV);
    const axesNew = orbitAxes(this.bodyState(newPreBurnState));
    const newDvWorld = v3(
      axesNew.pro.x * dvLocal.x + axesNew.nrm.x * dvLocal.y + axesNew.radOut.x * dvLocal.z,
      axesNew.pro.y * dvLocal.x + axesNew.nrm.y * dvLocal.y + axesNew.radOut.y * dvLocal.z,
      axesNew.pro.z * dvLocal.x + axesNew.nrm.z * dvLocal.y + axesNew.radOut.z * dvLocal.z,
    );

    return kinematicState(sample.t, sample.r, add(baseV, newDvWorld));
  }

  // 選択中ノードの axis 方向(sign 込み)へ amount [m/s] の Δv を加算する。ドラッグ・ラッチ・
  // キー/ボタンホールドはすべてここを経由し、加算量の求め方だけがそれぞれ異なる。
  // amount がゼロなら何もしない — 変化のない加算でも下流ノードは破棄されてしまう。
  private applyDv(axis: 0 | 1 | 2, sign: 1 | -1, amount: number): void {
    const idx = this.selectedNodeIdx;
    const plan = this.plan;
    if (idx === null || plan === null || amount === 0) return;
    // 基底は到着(噴射前)状態のもの。パネルの数値も 3D 矢印も画面上のアームも同じ基底で
    // 組まれており、加算だけ噴射後の基底で組むと、Δv が大きいほど「PRO へ動かしたのに
    // PRO 成分が期待どおり増えず他成分も動く」ずれになる。
    const arr = this.planDisplay.path.arrivalStates()[idx];
    if (!arr) return;
    const d = amount * sign;
    const local = v3(axis === 0 ? d : 0, axis === 1 ? d : 0, axis === 2 ? d : 0);
    this.selectedNode = plan.applyNodeDv(idx, fromOrbitAxes(this.bodyState(arr), local));
  }

  // 手動入力フォームから絶対的な Δv (PRO, NRM, RAD) を指定してノードの速度を上書きする。
  private setNodeDvLocal(pro: number, nrm: number, rad: number): void {
    const plan = this.plan;
    if (!plan || this.selectedNodeIdx === null) return;
    const arriving = this.planDisplay.path.arrivalStates();
    const arr = arriving[this.selectedNodeIdx];
    const node = plan.nodes[this.selectedNodeIdx];
    if (!arr || !node) return;

    // 入力は「到着時の軌道基準枠」を基準とした絶対量とする。
    const bodyArr = this.bodyState(arr);
    const dvWorld = fromOrbitAxes(bodyArr, v3(pro, nrm, rad));
    this.selectedNode = plan.replaceNode(this.selectedNodeIdx, kinematicState(node.t, node.r, add(arr.v, dvWorld)));
    this._uiSfx.warp();
  }

  // Δv アームのラッチ前ドラッグ量を選択中ノードの Δv へ加算する。
  private applyAxisDrag(axis: 0 | 1 | 2, sign: 1 | -1, deltaPx: number, fineAttitude: boolean): void {
    const rate = (fineAttitude ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) / 200;
    this.applyDv(axis, sign, deltaPx * rate);
  }

  // axis/sign 方向のキー/ボタンが held の間ホールド時間を積み上げ、そのレートで dt 秒分の
  // Δv を加算する。held が false ならホールド時間をリセットするだけで加算はしない。
  private applyHeldDv(axis: 0 | 1 | 2, sign: 1 | -1, held: boolean, dt: number, fineAttitude: boolean): void {
    const idx = axis * 2 + (sign < 0 ? 1 : 0);
    if (!held) {
      this.dvHoldTime[idx] = 0;
      return;
    }
    this.dvHoldTime[idx] = (this.dvHoldTime[idx] ?? 0) + dt;
    const fineScale = fineAttitude ? C.NODE_DV_RATE_FINE / C.NODE_DV_RATE : 1;
    this.applyDv(axis, sign, rampedDvRate(this.dvHoldTime[idx]!) * fineScale * dt);
  }

  // Δv アーム 6 個の画面方向をノード位置と微小先の投影差分から求める。
  private computeAxisScreenDirs(
    node: KinematicState,
    mapDist: number,
  ): { pro: { x: number; y: number; }; nrm: { x: number; y: number; }; rad: { x: number; y: number; }; } {
    const bodyNode = this.bodyState(node);
    const { r } = node;
    const { pro, nrm, radOut } = orbitAxes(bodyNode);
    const L = mapDist * 0.05;
    const p0 = this.planDisplay.path.projectPoint(r, node.t);
    // 軸方向へわずかに動かした点との投影差分から、画面上の単位方向ベクトルを求める。
    const dirFor = (axisVec: Vec3): { x: number; y: number; } => {
      const p1 = this.planDisplay.path.projectPoint(add(r, scale(axisVec, L)), node.t);
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const m = Math.hypot(dx, dy);
      return m > 1e-6 ? { x: dx / m, y: dy / m } : { x: 0, y: -1 };
    };
    return { pro: dirFor(pro), nrm: dirFor(nrm), rad: dirFor(radOut) };
  }

  // ノード周囲に PRO/RET・NRM/ANM・OUT/IN 6 方向の Δv アームハンドル仕様を配置する。
  private buildAxisHandles(
    nx: number,
    ny: number,
    dirs: { pro: { x: number; y: number; }; nrm: { x: number; y: number; }; rad: { x: number; y: number; }; },
  ): AxisHandleSpec[] {
    const R = C.NODE_GIZMO_HANDLE_PX;
    // 軸・符号・画面方向からハンドル1個分の位置とラベルを組む
    const mk = (axis: 0 | 1 | 2, sign: 1 | -1, d: { x: number; y: number; }, label: string): AxisHandleSpec => ({
      axis,
      sign,
      x: nx + d.x * R * sign,
      y: ny + d.y * R * sign,
      dirx: d.x * sign,
      diry: d.y * sign,
      label,
    });
    return [
      mk(0, 1, dirs.pro, 'PRO'),
      mk(0, -1, dirs.pro, 'RET'),
      mk(1, 1, dirs.nrm, 'NRM'),
      mk(1, -1, dirs.nrm, 'ANM'),
      mk(2, 1, dirs.rad, 'OUT'),
      mk(2, -1, dirs.rad, 'IN'),
    ];
  }

  // ノードギズモを非表示にする。
  private hideGizmo(): void {
    this.nodeGizmo.sync([], null);
    this.gizmo3d.setVisible(false);
  }

  // i 番目のノードの Δv(噴射後速度 − 到達時点速度)を ECI で返す。中心天体相対の差を取ると、
  // 影響圏の境界付近で噴射前後がそれぞれ別の天体を中心に解決され、意味を持たない差になる。
  // 軌道基準枠の成分が要るところでは、この ECI 差を到着状態の基底へ射影して使う。
  private nodeDv(i: number, arriving: readonly (KinematicState | null)[]): Vec3 {
    const node = this.plan?.nodes[i];
    const arr = arriving[i];
    return node && arr ? sub(node.v, arr.v) : v3();
  }

  // center 相対状態。orbitAxes が KinematicState を要求するので、座標系相対の r/v を
  // state の時刻のまま KinematicState へ包み直す。
  private relativeToBody(state: KinematicState, center: Attractor): KinematicState {
    const rel = toFrameState(frameOfAttractor(center), state);
    return kinematicState(state.t, rel.r, rel.v);
  }

  // 軌道要素とΔv方向を解釈するための中心天体相対状態。中心はその位置で最も強く引く天体。
  private bodyState(state: KinematicState): KinematicState {
    return this.relativeToBody(state, strongestAttractor(state.r, this.ephemeris.attractorsAt(state.t)));
  }

  // 表示上限までのノードハンドルと、選択中ノードがあれば Δv アームの仕様を組み立ててギズモへ渡す。
  private syncGizmo(plan: Plan, mapDist: number, fo: FloatingOrigin): void {
    const arriving = this.planDisplay.path.arrivalStates();
    const nodeSpecs: NodeHandleSpec[] = [];
    const limit = Math.min(plan.nodes.length, C.MAX_PLAN_NODE_MARKERS);
    // 各ノードの画面座標とラベルを組む
    for (let i = 0; i < limit; i++) {
      const node = plan.nodes[i]!;
      const p = this.nodeScreenPos(node);
      if (!p.front) continue;
      nodeSpecs.push({ idx: i, x: p.x, y: p.y, selected: i === this.selectedNodeIdx, dvMag: len(this.nodeDv(i, arriving)) });
    }
    // 選択中ノードがあれば Δv アームも組む
    let axisSpecs: AxisHandleSpec[] | null = null;
    let nodeFor3D: KinematicState | null = null;
    let arrFor3D: KinematicState | null = null;
    if (this.selectedNodeIdx !== null) {
      const node = plan.nodes[this.selectedNodeIdx];
      if (node) {
        nodeFor3D = node;
        arrFor3D = arriving[this.selectedNodeIdx] || null;
        const p = this.nodeScreenPos(node);
        if (p.front) {
          const dirs = this.computeAxisScreenDirs(arrFor3D || node, mapDist);
          axisSpecs = this.buildAxisHandles(p.x, p.y, dirs);
        }
      }
    }
    this.nodeGizmo.sync(nodeSpecs, axisSpecs);

    if (nodeFor3D && arrFor3D) {
      this.gizmo3d.setVisible(true);
      const r = this.planDisplay.path.toDisplay(nodeFor3D.r, nodeFor3D.t);
      const scenePos = fo.RtoThreeV3(r);
      const bodyArr = this.bodyState(arrFor3D);
      let { pro, nrm, radOut } = orbitAxes(bodyArr);
      pro = this.planDisplay.path.toDisplayDir(pro, nodeFor3D.t);
      nrm = this.planDisplay.path.toDisplayDir(nrm, nodeFor3D.t);
      radOut = this.planDisplay.path.toDisplayDir(radOut, nodeFor3D.t);
      this.gizmo3d.setPositionAndRotation(scenePos, pro, nrm, radOut, mapDist * 0.002);
      
      // ドラッグ・ラッチ時のアニメーション
      let activeAxis: 0 | 1 | 2 | null = null;
      let activeSign: 1 | -1 | null = null;
      let stretchFactor = 0;
      
      if (this.nodeGizmo.latch) {
        activeAxis = this.nodeGizmo.latch.axis;
        activeSign = this.nodeGizmo.latch.sign;
        // ラッチ量は超過量に比例させる (最大 0.5 程度まで)
        stretchFactor = Math.min(this.nodeGizmo.latch.excessPx * 0.01, 0.5);
      } else if (this.nodeGizmo.activeAxis) {
        activeAxis = this.nodeGizmo.activeAxis.axis;
        activeSign = this.nodeGizmo.activeAxis.sign;
        // ドラッグ中は固定で 0.2 程度伸ばす
        stretchFactor = 0.2;
      }
      this.gizmo3d.setStretch(activeAxis, activeSign, stretchFactor);
    } else {
      this.gizmo3d.setVisible(false);
    }
  }

  // WASDQE キー・長押しボタン・Δv アームのラッチドラッグから選択中ノードの Δv を加算する。
  private updateEditing(input: Input, dt: number): void {
    if (!this.dvEditActive) {
      this.dvHoldTime.fill(0);
      return;
    }
    const fine = this.ship?.fineAttitude ?? false;
    const b = this.panel.dvButtons;
    this.applyHeldDv(0, 1, input.takeHeld(K.dvPrograde) || b.pro.isHeld, dt, fine);
    this.applyHeldDv(0, -1, input.takeHeld(K.dvRetrograde) || b.ret.isHeld, dt, fine);
    this.applyHeldDv(1, 1, input.takeHeld(K.dvNormal) || b.nrm.isHeld, dt, fine);
    this.applyHeldDv(1, -1, input.takeHeld(K.dvAntinormal) || b.anm.isHeld, dt, fine);
    this.applyHeldDv(2, 1, input.takeHeld(K.dvRadialOut) || b.out.isHeld, dt, fine);
    this.applyHeldDv(2, -1, input.takeHeld(K.dvRadialIn) || b.in.isHeld, dt, fine);

    // ラッチ中の Δv アームは、閾値超過量に比例したレートで dt 秒分を加算し続ける。
    const latch = this.nodeGizmo.latch;
    if (latch) {
      const fineScale = fine ? C.NODE_DV_RATE_FINE / C.NODE_DV_RATE : 1;
      // ラッチ後は基点からの超過距離に比例させる。ここを DV_RATE_MAX で
      // 飽和させると、一定距離以上のドラッグがすべて同じ Δv になり、
      // 「大きくドラッグするほど加速が増える」という操作感が失われる。
      const rate = latch.excessPx * C.DV_LATCH_RATE_PER_PX * fineScale;
      this.applyDv(latch.axis, latch.sign, rate * dt);
    }
  }

  // 現在のノード列と選択中ノードから、計画パネルへ渡す表示値を組み立てて反映する。
  private syncPanel(ship: Player, simTime: number): void {
    const plan = ship.plan;
    const arriving = this.planDisplay.path.arrivalStates();
    const nodes = plan.nodes.map((n, i) => ({
      tRel: n.t - simTime,
      dvMag: len(this.nodeDv(i, arriving)),
      selected: i === this.selectedNodeIdx,
    }));
    // 選択中ノードの Δv と噴射後軌道要素を求める
    let selEl: OrbitalElements | null = null;
    let localDv: Vec3 | null = null;
    let nodeSecondsFromNow: number | null = null;
    // 高度・大気圏警告の基準は、選択中ノード(無ければ計画の起点)で最も強く引く天体。
    const centerState = (this.selectedNodeIdx !== null ? plan.nodes[this.selectedNodeIdx] : null) ?? plan.anchorOr(ship.state);
    const center = strongestAttractor(centerState.r, this.ephemeris.attractorsAt(centerState.t));
    if (this.selectedNodeIdx !== null) {
      const node = plan.nodes[this.selectedNodeIdx];
      const arr = arriving[this.selectedNodeIdx];
      if (node && arr) {
        nodeSecondsFromNow = node.t - simTime;
        const bodyNode = this.relativeToBody(node, center);
        const bodyArr = this.relativeToBody(arr, center);
        selEl = orbitalElementsOf(node, center);

        // 到着時基準でのローカルΔv成分を計算
        const dvWorld = sub(bodyNode.v, bodyArr.v);
        const axes = orbitAxes(bodyArr);
        localDv = v3(dot(dvWorld, axes.pro), dot(dvWorld, axes.nrm), dot(dvWorld, axes.radOut));
      }
    }
    // 大気圏警告は「このゲームで大気を持つのは地球だけ」という物理モデル自体の意図的な
    // 簡略化に基づく(CLAUDE.md 既述)ので、ECI 原点(ephemeris.originId)ではなく
    // 地球という天体そのものへの一致で判定する — レジストリに地球が無ければ常に false になり、
    // クラッシュも誤警告もしない。
    this.panel.sync(
      nodes, selEl, localDv, nodeSecondsFromNow, center.id === 'earth', this.selectedNodeIdx !== null,
    );
  }

  // 計画パネルを非表示にする。
  hidePanel(): void {
    this.panel.hide();
  }

  // 計画折れ線を再積分し、ゴースト位置とアプシスアイコンを求め直す。折れ線は戦闘ビューでも
  // 描く — 計画どおりに機体を動かすのは戦闘ビューだから。
  update(displayWindow: DisplayWindow): void {
    // 艦が替わったフレームで、前の艦のノードに対して開いたままのメニューを畳む(選択中ノードは
    // 参照で解決するので、計画が替われば同一性が外れて自然に選択なしになる)。
    const ship = this.ship;
    if (ship !== this.lastSeenShip) {
      this.lastSeenShip = ship;
      this.closeMenu();
    }
    this.simTime = displayWindow.simTime;
    const excludedIds = ship === null ? [] : [ship.id];
    // revision は前フレームの終端(lastPlanEnd)を基準に畳み込む — 今フレームの終端は
    // このあとの planDisplay.update が決めるので、組む時点ではまだ確定していない。
    const attractorProvider = planAttractorProvider(
      this.ephemeris, this.entities, excludedIds,
      planSourceRevision(this.entities, excludedIds, this.plan?.revision ?? 0, this.lastPlanEnd, displayWindow.simTime),
    );
    this.planDisplay.update(this.displayedPlan, displayWindow, attractorProvider);
    this.updateEquatorNodes(displayWindow);
  }

  // 操作艦の赤道交点マーカーを、計画の最終区間(=これから乗る軌道)を代表状態として求め直す。
  // 区間の折れ線も渡すので、交点は解析楕円ではなく実際に描かれている積分線の上に載る。
  private updateEquatorNodes(displayWindow: DisplayWindow): void {
    const ship = this.ship;
    if (!ship) return;
    const segment = this.planDisplay.path.finalSegment();
    ship.ensureEquatorNodes(this.markerManager).update(
      displayWindow.frame, displayWindow.displayTime, this.ephemeris,
      segment?.state0, segment?.samples,
    );
  }

  // 計画折れ線を同期する。編集中はさらに操作 UI(TRAJECTORY パネル・ノードギズモ)も出す。
  sync(cameraSystem: CameraSystem, simTime: number, fo: FloatingOrigin): void {
    const mapDist = cameraSystem.mapCamera.dist;
    if (this.displayedPlan !== null) {
      this.planDisplay.sync(
        fo, cameraSystem.activeCameraProjection, cameraSystem.activeCameraScale,
        cameraSystem.overviewMode, cameraSystem.activeCameraPos, cameraSystem.activeCamera,
      );
    }
    else {
      this.planDisplay.hide();
    }
    const ship = this.ship;
    if (ship !== null && this.editMode) {
      this.syncGizmo(ship.plan, mapDist, fo);
      this.syncPanel(ship, simTime);
    }
  }

  // 負荷確認ウィンドウが読む、直近フレームの計画区間の積分規模。
  perfCounts(): Pick<PerfCounts, 'planArcs' | 'planSteps'> {
    return {
      planArcs: this.planDisplay.path.lastRebuiltArcs,
      planSteps: this.planDisplay.path.lastSteps,
    };
  }

  // このフレームに出す折れ線の材料。出す価値のある折れ線が無ければ null — ノードの無い計画は
  // 自機の現在軌道そのものなので、ノードを置ける編集中だけ出す。
  private get displayedPlan(): PlanData | null {
    const ship = this.ship;
    if (ship === null) return null;
    if (!this.editMode && ship.plan.nodes.length === 0) return null;
    return ship.plan.displayData(ship.state);
  }

  // パネルとギズモを隠し、実質 Δv がゼロの末尾ノードを間引いて計画を整理する。
  onMapClosed(): void {
    this.hidePanel();
    this.hideGizmo();
    const plan = this.plan;
    if (plan) {
      const arriving = this.planDisplay.path.arrivalStates();
      // 末尾から Δv が有意なノードに当たるまで削る。
      for (let i = plan.nodes.length - 1; i >= 0; i--) {
        if (!this.isEmptyNode(i, arriving)) break;
        plan.removeNode(i);
      }
    }
    this.selectedNodeIdx = null;
  }
}

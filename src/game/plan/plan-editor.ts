// 軌道計画の編集(ノードの配置・時刻移動・Δv 調整・選択・削除)と計画パネルへの反映。
// ノードの配置・移動先は、描かれている計画折れ線(PlanPath)のサンプル列から選ぶ。
// パネルの DOM(ノード一覧・Δv 手動入力欄)は PlanPanel が持つ。
import type * as THREE from 'three/webgpu';
import { KinematicState, fromOrbitAxes, kinematicState, orbitAxes } from '../../physics/kinematic-state';
import { OrbitalElements, orbitalElementsOf, positionOnOrbit } from '../../physics/elements';
import { atmosphericDensity, ellipsoidAltitude } from '../../physics/atmosphere';
import { Projected } from '../../math/projection';
import { pickNearest } from '../pickable/object-pickable';
import { Vec3, add, dot, len, sub, v3 } from '../../math/vec3';
import type { CelestialSystem } from '../celestial/celestial-system';
import { Hud } from '../hud/hud';
import { ContextMenu, MenuAction, MenuCommon } from '../hud/windows';
import { UiSfx } from '../../audio/sfx/ui-sfx';
import type { FloatingOrigin } from '../camera/floating-origin';
import { Input } from '../../input/input';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { AxisHandleSpec, NodeGizmo, NodeHandleSpec } from './node-gizmo';
import { AxisDragGizmo, NODE_DV_RATE, NODE_DV_RATE_FINE } from './plan-axis-drag';
import { PlanGizmo3D } from './plan-gizmo-3d';
import { PlanPanel } from './plan-panel';
import { DisplayDurationSource, Plan } from './plan';
import type { PlanPath } from './plan-path';
import { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { ActivePlayerController } from '../active-controllable-controller';
import type { FrameControls } from '../hud/frame/frame-controls';
import { focusPoint } from '../camera/focus-target';
import { bodyAnchorSource, strongestAttractor } from '../../physics/attractor';
import { frameOfCelestialBody } from '../../physics/frame';
import { toFrameState } from '../../physics/frame';
import { DisplayWindow } from '../display-window-manager';

const NODE_PICK_PX = 30; // 軌道クリック判定の許容距離 [px]

const NODE_MIN_DV = 0.5; // これ未満のノードは軌道計画モードを抜けるときに破棄 [m/s]
const MAX_PLAN_NODE_MARKERS = 12; // 画面上に表示するノードマーカーの上限(HUD要素数の上限)

const DV_LATCH_RATE_PER_PX = 3.0; // ラッチ中、閾値超過1pxあたりのΔv加算レート [m/s per 実秒 per px]

const PE_WARN_DENSITY = 2.4e-8; // 噴射後の軌道の近点がこの大気密度に達したら警告する [kg/m^3]。地球の高度 120km 相当

export class PlanEditor {
  // 編集対象として選択中のノード。ノードは不変オブジェクトで、編集のたびに新しい
  // KinematicState へ置き換わる — 選択を参照で持てば、編集で置き換わった場合も、
  // 実行済みとして列の前方から取り除かれた場合も、同じ同一性判定で追随できる。
  private selectedNode: KinematicState | null = null;

  // 直前の update() で操作対象だった艦/基地。切替の検出だけに使う(正本は ActivePlayerController)。
  private lastSeenShip: Controllable | null = null;

  // 選択中ノードの現在の index。列に無ければ null。
  public get selectedNodeIdx(): number | null {
    const plan = this.plan;
    if (this.selectedNode === null || plan === null) return null;
    const idx = plan.nodes.indexOf(this.selectedNode);
    return idx < 0 ? null : idx;
  }

  public set selectedNodeIdx(idx: number | null) {
    this.selectedNode = idx === null ? null : this.plan?.nodes[idx] ?? null;
  }

  // 操作対象（自機船または基地）。ノードの起点として状態が要るときだけ引く。
  private get ship(): Controllable | null {
    return this.activePlayers.currentControllable;
  }

  // 操作対象自身の計画。操作対象を切り替えると編集対象もその計画へ切り替わる。
  public get plan(): Plan | null { return this.activePlayers.currentControllable?.plan ?? null; }

  private readonly gizmo3d: PlanGizmo3D;

  private readonly nodeGizmo: NodeGizmo;
  // ノード以外の計画軌道上を右クリックしたときのメニュー。
  private readonly orbitMenu: ContextMenu<KinematicState, MenuAction>;

  private readonly axisDrag: AxisDragGizmo;

  private readonly panel: PlanPanel;
  private simTime = 0; // 現在の simTime [s]

  // ノードギズモと計画パネルの DOM を組み立て、両者のコールバックを配線する。
  // path は描かれている計画折れ線 — ノードの配置・移動・画面座標はそのサンプル列から解く。
  public constructor(
    private readonly _hud: Hud,
    private readonly _uiSfx: UiSfx,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly celestialSystem: CelestialSystem,
    scene: THREE.Scene,
    private readonly activePlayers: ActivePlayerController,
    private readonly displayDuration: DisplayDurationSource,
    private readonly frameControls: FrameControls,
    private readonly path: PlanPath,
  ) {
    this.nodeGizmo = new NodeGizmo(this._hud.layers.marker, this._hud.layers.popup, this._hud.overlayManager);
    this.orbitMenu = new ContextMenu<KinematicState, MenuAction>(this._hud.layers.popup, this._hud.overlayManager);
    this.gizmo3d = new PlanGizmo3D();
    scene.add(this.gizmo3d.group);
    this.axisDrag = new AxisDragGizmo(
      (state) => this.bodyState(state),
      (r, t) => this.path.projectPoint(r, t),
      (axis, sign, amount) => this.applyDv(axis, sign, amount),
    );

    this.panel = new PlanPanel(this._hud.mapRoot);
    this.panel.onDvInputChange = (pro, nrm, rad) => this.setNodeDvLocal(pro, nrm, rad);
    this.panel.onPositionInputChange = (secondsFromNow) => this.setSelectedNodeTime(secondsFromNow);

    this.orbitMenu.onSelect = (act, state) => {
      if (act === 'warp') this.warpTo(state.t, '指定位置まで自動ワープ開始');
    };
    this.wireNodeGizmo();
  }

  // 時刻 t まで自動ワープを始め、始まれば startedHint を出す。既に通過した時刻ならその旨を出す。
  private warpTo(t: number, startedHint: string): void {
    if (this.simSpeedManager.startAutoWarpTo(t, this.simTime)) this._hud.hint(startedHint);
    else this._hud.hint('この時刻は既に通過しています');
  }

  // NodeGizmo の各種コールバックを配線する。
  private wireNodeGizmo(): void {
    const g = this.nodeGizmo;
    // ノードハンドルと Δv アームのポインタ操作
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
      this.axisDrag.applyAxisDrag(axis, sign, deltaPx, this.ship?.fineAttitude ?? false);
    };
    // ノードのコンテキストメニューの項目
    g.onMenuWarpTo = (idx) => {
      const n = this.plan?.nodes[idx];
      if (n) this.warpTo(n.t, '指定時刻まで自動ワープ開始');
    };
    g.onMenuDelete = (idx) => {
      this.deleteNode(idx);
    };
    g.onMenuFocus = (idx) => {
      const n = this.plan?.nodes[idx];
      if (n) this.frameControls.setFocus(
        focusPoint(this.celestialSystem.frames, this.celestialSystem.frames.inertialFrame, n.r, n.t, bodyAnchorSource([], n.t)));
    };
  }

  // ノードのコンテキストメニューを閉じる。
  public closeMenu(): void {
    this.nodeGizmo.closeMenu();
    this.orbitMenu.close();
  }

  // idx 番目のノードを削除する。
  public deleteNode(idx: number): void {
    const plan = this.plan;
    if (!plan?.nodes[idx]) return;
    plan.removeNode(idx);
    this.closeMenu();
    this.simSpeedManager.cancelAutoWarp();
    this._hud.hint('ノードを削除');
  }

  // 選択中のノードを削除する。
  public deleteSelected(): void {
    if (this.selectedNodeIdx === null) return;
    this.deleteNode(this.selectedNodeIdx);
  }

  // 選択ノードの削除キーと、WASDQE・長押しボタン・ラッチによる Δv 編集を進める。
  public handleInput(input: Input, dt: number): void {
    if (input.takeKey(K.deleteNode)) this.deleteSelected();
    this.updateEditing(input, dt);
  }

  // マップ上のクリック・右クリックをノード選択/配置とコンテキストメニューへ振り分ける。
  // 艦がいなければ計画そのものが無いので、クリックはここで捨てる。
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
    const picked = this.path.nearestSample(mx, my, NODE_PICK_PX, -Infinity);
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
    return len(sub(node.v, arr.v)) < NODE_MIN_DV;
  }

  // 選択中ノードが実質的に空なら削除する。
  private removeSelectedIfEmpty(): void {
    const idx = this.selectedNodeIdx;
    if (idx === null) return;
    if (!this.isEmptyNode(idx, this.path.arrivalStates())) return;
    this.plan?.removeNode(idx);
    this.selectedNodeIdx = null;
  }

  // 時刻 t の計画軌道上の状態にノードを追加し、選択する。その時刻の計画軌道が
  // 求まらなければ(折れ線の届く範囲外など)ヒントを出すだけで何もしない。
  public addNodeAt(t: number): void {
    const ship = this.ship;
    if (!ship) return;
    const sample = this.path.sampleAt(t);
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
    const arriving = this.path.arrivalStates();
    const picked = this.path.nearestSample(
      clientX, clientY, Infinity, node.t,
      ship.plan.nodeTimeRange(idx, ship.state, this.celestialSystem, this.displayDuration),
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
    const range = plan.nodeTimeRange(idx, ship.state, this.celestialSystem, this.displayDuration);
    const epsilon = 1e-6;
    if (targetT < range.min - epsilon || targetT > range.max + epsilon) {
      this._hud.hint('ノード位置は許可された軌道区間内で指定してください');
      return;
    }
    if (Math.abs(targetT - node.t) <= epsilon) return;

    const picked = this.path.sampleAtWithArc(targetT);
    if (!picked) {
      this._hud.hint('この時刻の計画軌道が求まりません');
      return;
    }

    const arriving = this.path.arrivalStates();
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
    const dvLocal = this.nodeDvLocal(idx, arriving);
    if (!plan || dvLocal === null) return null;

    // ノードより後ろの arc のサンプルは、そこへ至るまでに実行されたノードの Δv をすべて
    // 含んだ速度になっているので、加算前(プレバーン)の速度へ戻してから改めて Δv を組み立てる。
    // 置ける時刻範囲は直前の状態から表示期間ぶん伸びるため、2つ以上先の arc の
    // サンプルが範囲に入りうる — 自ノードぶんだけ引くと中間ノードの Δv が残る。
    // 速度 − Δv = 速度。演算の途中は札の落ちた素の Vec3 になる。
    let baseV: Vec3 = sample.v;
    for (let i = idx; i < arcIdx; i++) {
      const passed = plan.nodes[i];
      const passedArr = arriving[i];
      if (!passed || !passedArr) return null;
      baseV = sub(baseV, sub(passed.v, passedArr.v));
    }

    // 到着軌道基準のローカル Δv 成分を、移動先のプレバーン状態基準へ組み直す。
    const newPreBurnState = kinematicState<'eci'>(sample.t, sample.r, baseV);
    const newDvWorld = fromOrbitAxes(this.bodyState(newPreBurnState), dvLocal);

    return kinematicState<'eci'>(sample.t, sample.r, add(baseV, newDvWorld));
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
    const arr = this.path.arrivalStates()[idx];
    if (!arr) return;
    const d = amount * sign;
    const local = v3(axis === 0 ? d : 0, axis === 1 ? d : 0, axis === 2 ? d : 0);
    this.selectedNode = plan.applyNodeDv(idx, fromOrbitAxes(this.bodyState(arr), local));
  }

  // 手動入力フォームから絶対的な Δv (PRO, NRM, RAD) を指定してノードの速度を上書きする。
  private setNodeDvLocal(pro: number, nrm: number, rad: number): void {
    const plan = this.plan;
    if (!plan || this.selectedNodeIdx === null) return;
    const arriving = this.path.arrivalStates();
    const arr = arriving[this.selectedNodeIdx];
    const node = plan.nodes[this.selectedNodeIdx];
    if (!arr || !node) return;

    // 入力は「到着時の軌道基準枠」を基準とした絶対量とする。
    const bodyArr = this.bodyState(arr);
    const dvWorld = fromOrbitAxes(bodyArr, v3(pro, nrm, rad));
    this.selectedNode = plan.replaceNode(this.selectedNodeIdx, kinematicState<'eci'>(node.t, node.r, add(arr.v, dvWorld)));
    this._uiSfx.warp();
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

  // i 番目のノードの Δv を、到着状態の軌道基準枠(PRO/NRM/RAD)成分へ分解する。
  // ノードか到着状態が求まっていなければ null。
  private nodeDvLocal(i: number, arriving: readonly (KinematicState | null)[]): Vec3 | null {
    const arr = arriving[i];
    if (!this.plan?.nodes[i] || !arr) return null;
    const dvWorld = this.nodeDv(i, arriving);
    const axes = orbitAxes(this.bodyState(arr));
    return v3(dot(dvWorld, axes.pro), dot(dvWorld, axes.nrm), dot(dvWorld, axes.radOut));
  }

  // 軌道要素とΔv方向を解釈するための中心天体相対状態。中心はその位置で最も強く引く天体。
  // orbitAxes が KinematicState を要求するので、相対の r/v を state の時刻のまま包み直す。
  private bodyState(state: KinematicState): KinematicState {
    const center = strongestAttractor(state.r, this.celestialSystem.celestialMotions, state.t);
    const rel = toFrameState(frameOfCelestialBody(center, state.t), state);
    return kinematicState<'eci'>(state.t, rel.r, rel.v);
  }

  // 噴射後の軌道 el の近点が、中心天体の大気の中にあるか。大気の高度は基準楕円体から測るので、
  // 真球基準の近点高度ではなく近点の位置そのものから測る。大気を持たない天体では false。
  private peInAtmosphere(el: OrbitalElements, t: number): boolean {
    const atm = el.center.atmosphereAt(t);
    if (atm === null) return false;
    return atmosphericDensity(ellipsoidAltitude(positionOnOrbit(el, 0), atm), atm) >= PE_WARN_DENSITY;
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
        if (p.front) axisSpecs = this.axisDrag.buildAxisHandles(p.x, p.y, arrFor3D ?? node, mapDist);
      }
    }
    this.nodeGizmo.sync(nodeSpecs, axisSpecs);

    if (nodeFor3D && arrFor3D) {
      this.gizmo3d.setVisible(true);
      const r = this.path.toDisplay(nodeFor3D.r, nodeFor3D.t);
      const scenePos = fo.RtoThreeV3(r);
      const axes = orbitAxes(this.bodyState(arrFor3D));
      const pro = this.path.toDisplayDir(axes.pro, nodeFor3D.t);
      const nrm = this.path.toDisplayDir(axes.nrm, nodeFor3D.t);
      this.gizmo3d.setPositionAndRotation(scenePos, pro, nrm, mapDist);
      this.gizmo3d.setActiveDrag(this.nodeGizmo.axisHandleDrag);
    } else {
      this.gizmo3d.setVisible(false);
    }
  }

  // WASDQE キー・長押しボタン・Δv アームのラッチドラッグから選択中ノードの Δv を加算する。
  private updateEditing(input: Input, dt: number): void {
    if (this.selectedNodeIdx === null) {
      this.axisDrag.resetHold();
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
    if (drag && drag.excessPx !== null) {
      const fineScale = fine ? NODE_DV_RATE_FINE / NODE_DV_RATE : 1;
      // ラッチ後は基点からの超過距離に比例させる。ここを DV_RATE_MAX で
      // 飽和させると、一定距離以上のドラッグがすべて同じ Δv になり、
      // 「大きくドラッグするほど加速が増える」という操作感が失われる。
      const rate = drag.excessPx * DV_LATCH_RATE_PER_PX * fineScale;
      this.applyDv(drag.axis, drag.sign, rate * dt);
    }
  }

  // 現在のノード列と選択中ノードから、計画パネルへ渡す表示値を組み立てて反映する。
  private syncPanel(ship: Controllable): void {
    const plan = ship.plan;
    const arriving = this.path.arrivalStates();
    const nodes = plan.nodes.map((n, i) => ({ tRel: n.t - this.simTime, dvMag: len(this.nodeDv(i, arriving)) }));
    const idx = this.selectedNodeIdx;
    const node = idx === null ? null : plan.nodes[idx];
    const localDv = idx === null ? null : this.nodeDvLocal(idx, arriving);
    let selEl: OrbitalElements | null = null;
    let nodeSecondsFromNow: number | null = null;
    let peInAtmosphere = false;
    // 到着状態が求まっている選択中ノードについて、噴射後の軌道要素・近点の大気圏警告・現在時刻からの秒数を出す
    if (node && localDv) {
      nodeSecondsFromNow = node.t - this.simTime;
      const center = strongestAttractor(node.r, this.celestialSystem.celestialMotions, node.t);
      selEl = orbitalElementsOf(node, center, node.t);
      peInAtmosphere = selEl !== null && this.peInAtmosphere(selEl, node.t);
    }
    this.panel.sync(nodes, idx, selEl, localDv, nodeSecondsFromNow, peInAtmosphere);
  }

  // 計画パネルを非表示にする。
  private hidePanel(): void {
    this.panel.hide();
  }

  // ノードギズモ・軌道右クリックメニュー・パネル・3D ギズモを片付ける。
  public dispose(): void {
    this.nodeGizmo.dispose();
    this.orbitMenu.dispose();
    this.panel.dispose();
    this.gizmo3d.dispose();
  }

  // 操作対象の切り替えを検出してメニューを畳み、ワープメニューが使う現在時刻を差し込む。
  public update(displayWindow: DisplayWindow): void {
    // 艦が替わったフレームで、前の艦のノードに対して開いたままのメニューを畳む(選択中ノードは
    // 参照で解決するので、計画が替われば同一性が外れて自然に選択なしになる)。
    const ship = this.ship;
    if (ship !== this.lastSeenShip) {
      this.lastSeenShip = ship;
      this.closeMenu();
    }
    this.simTime = displayWindow.simTime;
  }

  // 操作 UI(ノードギズモ・Δv アーム・TRAJECTORY パネル)を現在の選択と画面座標で組み直す。
  public sync(mapDist: number, fo: FloatingOrigin): void {
    const ship = this.ship;
    if (ship === null) return;
    this.syncGizmo(ship.plan, mapDist, fo);
    this.syncPanel(ship);
  }

  // パネルとギズモを隠し、実質 Δv がゼロの末尾ノードを間引いて計画を整理する。
  public onMapClosed(): void {
    this.hidePanel();
    this.hideGizmo();
    const plan = this.plan;
    if (plan) {
      const arriving = this.path.arrivalStates();
      // 末尾から Δv が有意なノードに当たるまで削る。
      for (let i = plan.nodes.length - 1; i >= 0; i--) {
        if (!this.isEmptyNode(i, arriving)) break;
        plan.removeNode(i);
      }
    }
    this.selectedNodeIdx = null;
  }
}

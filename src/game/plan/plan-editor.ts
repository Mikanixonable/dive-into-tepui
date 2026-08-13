// 軌道計画の編集(ノードの配置・時刻移動・Δv 調整・選択・削除)と計画パネルへの反映。
// 未来表示(計画折れ線・ゴースト)は PlanDisplay を所有・駆動することで行う。
import type * as THREE from 'three/webgpu';
import { KinematicState, fromOrbitAxes, kinematicState, orbitAxes } from '../../physics/kinematic-state';
import { OrbitalElements } from '../../physics/elements';
import { Projected } from '../../physics/projection';
import { Vec3, add, dot, len, scale, sub, v3 } from '../../physics/vec3';
import type { Ephemeris } from '../../physics/ephemeris';
import * as C from '../const';
import { ACCENT, TEXT, TEXT_DIM, FILL_2, AXIS_PROGRADE, AXIS_NORMAL, AXIS_RADIAL } from '../theme';
import { Hud } from '../hud/hud';
import { HudHoldButton } from '../hud/buttons';
import { ContextMenu } from '../hud/context-menu';
import { MenuAction, MenuCommon } from '../hud/menu-actions';
import { fmtDist, fmtTime } from '../hud/utils';
import { Sfx } from '../../audio/sfx';
import type { MarkerManager } from '../marker/marker-manager';
import type { FloatingOrigin } from '../floating-origin';
import type { ProjectFn, ScaleFn } from '../camera/camera-system';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { AxisHandleSpec, NodeGizmo, NodeHandleSpec } from './node-gizmo';
import { PlanGizmo3D } from './plan-gizmo-3d';
import { DisplayDurationSource, Plan } from './plan';
import { apsisAltitudes } from '../../physics/elements';
import { PlanDisplay } from './plan-display';
import { hudDock } from '../hud/dom';
import { SimSpeedManager } from '../sim-speed-manager';
import type { Player } from '../player/player';
import { Attractor, orbitalElementsOf, frameOfAttractor, strongestAttractor } from '../../physics/attractor';
import { toFrameState } from '../../physics/frame';
import type { PlanAttractorProvider } from '../simulation/attractors';
import type { DisplayWindow } from '../display-window-manager';
import type { PerfCounts } from '../../perf-meter';

interface DvButtons {
  readonly pro: HudHoldButton;
  readonly ret: HudHoldButton;
  readonly nrm: HudHoldButton;
  readonly anm: HudHoldButton;
  readonly out: HudHoldButton;
  readonly in: HudHoldButton;
}

// prograde/retrograde/normal/antinormal/radial out/in の長押しボタン6個を組み立てる。
function buildDvButtons(): { row: HTMLElement; buttons: DvButtons; } {
  const row = document.createElement('div');
  row.className = 'hud-seg';
  const mk = (dir: string, key: string): HudHoldButton => new HudHoldButton(`${dir} [${key}]`);
  const buttons: DvButtons = {
    pro: mk('PRO', K.dvPrograde.label),
    ret: mk('RET', K.dvRetrograde.label),
    nrm: mk('NRM', K.dvNormal.label),
    anm: mk('ANM', K.dvAntinormal.label),
    out: mk('OUT', K.dvRadialOut.label),
    in: mk('IN', K.dvRadialIn.label),
  };
  for (const b of Object.values(buttons)) row.appendChild(b.element);
  return { row, buttons };
}

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

  // 選択中ノードの現在の index。列に無ければ null。
  get selectedNodeIdx(): number | null {
    if (this.selectedNode === null) return null;
    const idx = this.plan.nodes.indexOf(this.selectedNode);
    return idx < 0 ? null : idx;
  }

  set selectedNodeIdx(idx: number | null) {
    this.selectedNode = idx === null ? null : this.plan.nodes[idx] ?? null;
  }

  onFocusNode: ((state: KinematicState) => void) | null = null;

  private ship: Player | null;
  private readonly detachedPlan = new Plan();
  // アクティブ艦自身の計画を編集する。艦は自分の計画を所有し続けるので、艦を切り替えると
  // 編集対象もその艦の計画へ切り替わる。
  get plan(): Plan { return this.ship?.plan ?? this.detachedPlan; }

  readonly planDisplay: PlanDisplay;
  private readonly gizmo3d: PlanGizmo3D;

  // 直近の update() が描いた折れ線が届いている終端時刻。一度も描いていなければ NaN。
  get lastPlanEnd(): number { return this.planDisplay.path.timeRange()?.max ?? NaN; }

  private _editMode = false;
  get editMode(): boolean { return this._editMode; }
  setMapMode(open: boolean): void { this._editMode = open; }

  readonly nodeGizmo: NodeGizmo;
  // ノード以外の計画軌道上を右クリックしたときのメニュー。
  private readonly orbitMenu: ContextMenu<KinematicState, MenuAction>;

  private readonly dvButtons = buildDvButtons();
  // 6 方向それぞれのホールド継続時間 [s]。index は axis*2 + (sign<0 ? 1 : 0)。
  private readonly dvHoldTime: number[] = [0, 0, 0, 0, 0, 0];

  private readonly planPanel: HTMLElement;
  private readonly planBody: HTMLElement;
  private readonly editForm: HTMLElement;
  private readonly dvProInput: HTMLInputElement;
  private readonly dvNrmInput: HTMLInputElement;
  private readonly dvRadInput: HTMLInputElement;
  private simTime = 0;

  // 計画パネルの DOM を組み立て、ノードギズモのコールバックを配線する。
  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly ephemeris: Ephemeris,
    scene: THREE.Scene,
    private readonly markerManager: MarkerManager,
    ship: Player | null,
    private readonly displayDuration: DisplayDurationSource,
  ) {
    this.ship = ship;
    this.planDisplay = new PlanDisplay(scene, markerManager, ephemeris, displayDuration);
    this.nodeGizmo = new NodeGizmo(this._hud.layers.marker, this._hud.layers.popup);
    this.orbitMenu = new ContextMenu<KinematicState, MenuAction>(this._hud.layers.popup);
    this.gizmo3d = new PlanGizmo3D();
    scene.add(this.gizmo3d.group);

    this.planPanel = document.createElement('div');
    this.planPanel.id = 'hud-plan';
    this.planPanel.className = 'panel';
    this.planPanel.innerHTML = `
      <h3>軌道計画 [${K.toggleMapMode.label}]</h3>
      <div data-id="planbody"></div>
      <div data-id="planedit" style="display:none; margin-top:8px; padding-top:8px; border-top:1px solid ${FILL_2}">
        <div style="font-size:10px; color:${TEXT_DIM}; margin-bottom:4px;">マニューバ手動入力 (m/s)</div>
        <div class="hud-seg">
          <div class="row" style="width:100%; gap:4px; align-items:center;">
            <span class="k" style="width:28px; color:${AXIS_PROGRADE}; font-weight:bold;">PRO</span>
            <input type="number" id="pe-dv-pro" step="0.1" style="flex:1; width:0;">
          </div>
          <div class="row" style="width:100%; gap:4px; align-items:center;">
            <span class="k" style="width:28px; color:${AXIS_NORMAL}; font-weight:bold;">NRM</span>
            <input type="number" id="pe-dv-nrm" step="0.1" style="flex:1; width:0;">
          </div>
          <div class="row" style="width:100%; gap:4px; align-items:center;">
            <span class="k" style="width:28px; color:${AXIS_RADIAL}; font-weight:bold;">RAD</span>
            <input type="number" id="pe-dv-rad" step="0.1" style="flex:1; width:0;">
          </div>
        </div>
      </div>
    `;
    this.planPanel.style.display = 'none';
    this.planBody = this.planPanel.querySelector<HTMLElement>('[data-id="planbody"]')!;
    this.editForm = this.planPanel.querySelector<HTMLElement>('[data-id="planedit"]')!;
    this.dvProInput = this.planPanel.querySelector<HTMLInputElement>('#pe-dv-pro')!;
    this.dvNrmInput = this.planPanel.querySelector<HTMLInputElement>('#pe-dv-nrm')!;
    this.dvRadInput = this.planPanel.querySelector<HTMLInputElement>('#pe-dv-rad')!;

    const onInputChange = () => {
      this.setNodeDvLocal(
        parseFloat(this.dvProInput.value) || 0,
        parseFloat(this.dvNrmInput.value) || 0,
        parseFloat(this.dvRadInput.value) || 0
      );
    };
    for (const input of [this.dvProInput, this.dvNrmInput, this.dvRadInput]) {
      // Input は window で keydown を購読しているので、欄で押したキーを止めないと
      // 同じキーがゲーム操作としても解釈される。
      input.addEventListener('keydown', (e) => e.stopPropagation());
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
    }
    this.dvProInput.addEventListener('change', onInputChange);
    this.dvNrmInput.addEventListener('change', onInputChange);
    this.dvRadInput.addEventListener('change', onInputChange);
    const stopProp = (e: Event) => e.stopPropagation();
    this.dvProInput.addEventListener('keydown', stopProp);
    this.dvNrmInput.addEventListener('keydown', stopProp);
    this.dvRadInput.addEventListener('keydown', stopProp);

    hudDock(this._hud.layers.panel, 'right').appendChild(this.planPanel);
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
      this._sfx.warp();
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
      const n = this.plan.nodes[idx];
      if (!n) return;
      if (this.simSpeedManager.startAutoWarpTo(n.t, this.simTime)) this._hud.hint('指定時刻まで自動ワープ開始');
      else this._hud.hint('この時刻は既に通過しています');
    };
    g.onMenuDelete = (idx) => {
      this.deleteNode(idx);
    };
    g.onMenuFocus = (idx) => {
      const n = this.plan.nodes[idx];
      if (n) this.onFocusNode?.(n);
    };
  }

  // 編集対象をアクティブ艦の切替に合わせて差し替える。選択中ノード・開いたメニューは
  // 前の艦の計画を指しているので破棄する。
  setActivePlayer(ship: Player | null): void {
    this.ship = ship;
    this.selectedNodeIdx = null;
    this.closeMenu();
  }

  // ノードのコンテキストメニューを閉じる。
  closeMenu(): void {
    this.nodeGizmo.closeMenu();
    this.orbitMenu.close();
  }

  // idx 番目のノードを削除する。
  deleteNode(idx: number): void {
    if (!this.plan.nodes[idx]) return;
    this.plan.removeNode(idx);
    this.closeMenu();
    this.simSpeedManager.cancelAutoWarp();
    this._hud.hint('ノードを削除');
  }

  // 選択中のノードを削除する。
  deleteSelected(): void {
    if (this.selectedNodeIdx === null) return;
    this.deleteNode(this.selectedNodeIdx);
  }

  // 選択ノード削除キーの入力を処理する。
  handleInput(input: Input): void {
    if (input.takeKey(K.deleteNode)) this.clearPlanByKey();
  }

  // マップ上のクリック・右クリックをノード選択/配置とコンテキストメニューへ振り分ける。
  // 艦がいない(detachedPlan)間は計画そのものに意味がないので、クリックはここで捨てる —
  // 素通しすると、艦を持たない detachedPlan の原点固定アンカーから計算される退化した
  // 軌道折れ線に対して当たり判定が成立し、天体アイコンをクリックしてもノードが置けてしまう。
  handleMapPointer(input: Input): void {
    if (this.ship === null) return;
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
    if (this.plan.nodes.length <= 0) return;
    this.plan.clear();
    this.simSpeedManager.cancelAutoWarp();
    this._hud.hint('マニューバ計画を破棄');
  }

  // ノードの画面座標を投影する。
  private nodeScreenPos(node: KinematicState): Projected {
    return this.planDisplay.path.projectPoint(node.r, node.t);
  }

  private pickNodeAt(mx: number, my: number): number | null {
    let bestIdx: number | null = null;
    let bestD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (let i = 0; i < this.plan.nodes.length; i++) {
      const p = this.nodeScreenPos(this.plan.nodes[i]!);
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
      this._sfx.warp();
      return;
    }

    // 見つからなければ計画軌道上の最寄り点にノードを配置。折れ線が自分自身に重なっていれば
    // その位置に最初に到達する時刻(= referenceT を -Infinity にして最早時刻)を選ぶ。
    const picked = this.planDisplay.path.nearestSample(mx, my, C.NODE_PICK_PX, -Infinity);
    if (picked) {
      this.selectNewNode(this.plan.addNode(picked.state));
      return;
    }

    // ノードにも計画軌道にも当たらないクリックは選択解除
    this.selectedNodeIdx = null;
  }

  // i 番目のノードに有意な Δv が入っていないか。到達状態を再計算できない間は判定を保留し、
  // 空とは見なさない(消してよいかどうかがまだ分からないため)。
  private isEmptyNode(i: number, arriving: readonly (KinematicState | null)[]): boolean {
    const node = this.plan.nodes[i];
    const arr = arriving[i];
    if (!node || !arr) return false;
    return len(sub(node.v, arr.v)) < C.NODE_MIN_DV;
  }

  // 選択中ノードが実質的に空なら削除する。
  private removeSelectedIfEmpty(): void {
    const idx = this.selectedNodeIdx;
    if (idx === null) return;
    if (!this.isEmptyNode(idx, this.planDisplay.path.arrivalStates())) return;
    this.plan.removeNode(idx);
    this.selectedNodeIdx = null;
  }

  // 時刻 t の計画軌道上の状態にノードを追加し、選択する。その時刻の計画軌道が
  // 求まらなければ(折れ線の届く範囲外など)ヒントを出すだけで何もしない。
  addNodeAt(t: number): void {
    const sample = this.planDisplay.path.sampleAt(t);
    if (!sample) {
      this._hud.hint('この時刻の計画軌道が求まりません');
      return;
    }
    this.selectNewNode(this.plan.addNode(sample));
  }

  // addNode の結果を選択する。計画の起点より前は置けないので、その場合は理由を伝える。
  private selectNewNode(idx: number): void {
    if (idx < 0) {
      this._hud.hint('計画の起点より前にはノードを置けません');
      return;
    }
    this.selectedNodeIdx = idx;
    this._sfx.warp();
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
    const node = this.plan.nodes[idx];
    if (!node) return;
    const arriving = this.planDisplay.path.arrivalStates();
    const picked = this.planDisplay.path.nearestSample(clientX, clientY, Infinity, node.t, this.plan.nodeTimeRange(idx, this.ephemeris, this.displayDuration));
    if (picked) {
      this.selectedNode = this.plan.replaceNode(
        idx, this.rebuildDraggedNode(picked.state, picked.arcIdx, idx, arriving) ?? picked.state,
      );
    }
  }

  // ドラッグで時刻を動かしても、ノードのΔv(機体座標系の加減速)は維持する。
  // これにより、同じマニューバを別時刻へ移し替えた計画として再描画できる。
  private rebuildDraggedNode(
    sample: KinematicState,
    arcIdx: number,
    idx: number,
    arriving: readonly (KinematicState | null)[],
  ): KinematicState | null {
    const node = this.plan.nodes[idx];
    const arr = arriving[idx];
    if (!node || !arr) return null;

    const dvWorldOld = sub(node.v, arr.v);
    // ノードより後ろの arc のサンプルは、そこへ至るまでに実行されたノードの Δv をすべて
    // 含んだ速度になっているので、加算前(プレバーン)の速度へ戻してから改めて Δv を組み立てる。
    // 置ける時刻範囲は直前の状態から表示期間ぶん伸びるため、2つ以上先の arc の
    // サンプルが範囲に入りうる — 自ノードぶんだけ引くと中間ノードの Δv が残る。
    let baseV = sample.v;
    for (let i = idx; i < arcIdx; i++) {
      const passed = this.plan.nodes[i];
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
    if (idx === null || amount === 0) return;
    // 基底は到着(噴射前)状態のもの。パネルの数値も 3D 矢印も画面上のアームも同じ基底で
    // 組まれており、加算だけ噴射後の基底で組むと、Δv が大きいほど「PRO へ動かしたのに
    // PRO 成分が期待どおり増えず他成分も動く」ずれになる。
    const arr = this.planDisplay.path.arrivalStates()[idx];
    if (!arr) return;
    const d = amount * sign;
    const local = v3(axis === 0 ? d : 0, axis === 1 ? d : 0, axis === 2 ? d : 0);
    this.selectedNode = this.plan.applyNodeDv(idx, fromOrbitAxes(this.bodyState(arr), local));
  }

  // 手動入力フォームから絶対的な Δv (PRO, NRM, RAD) を指定してノードの速度を上書きする。
  private setNodeDvLocal(pro: number, nrm: number, rad: number): void {
    if (this.selectedNodeIdx === null) return;
    const arriving = this.planDisplay.path.arrivalStates();
    const arr = arriving[this.selectedNodeIdx];
    const node = this.plan.nodes[this.selectedNodeIdx];
    if (!arr || !node) return;
    
    // 入力は「到着時の軌道基準枠」を基準とした絶対量とする。
    const bodyArr = this.bodyState(arr);
    const dvWorld = fromOrbitAxes(bodyArr, v3(pro, nrm, rad));
    this.selectedNode = this.plan.replaceNode(this.selectedNodeIdx, kinematicState(node.t, node.r, add(arr.v, dvWorld)));
    this._sfx.warp();
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
    const node = this.plan.nodes[i];
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
  private syncGizmo(mapDist: number, fo: FloatingOrigin): void {
    const arriving = this.planDisplay.path.arrivalStates();
    const nodeSpecs: NodeHandleSpec[] = [];
    const limit = Math.min(this.plan.nodes.length, C.MAX_PLAN_NODE_MARKERS);
    // 各ノードの画面座標とラベルを組む
    for (let i = 0; i < limit; i++) {
      const node = this.plan.nodes[i]!;
      const p = this.nodeScreenPos(node);
      if (!p.front) continue;
      nodeSpecs.push({ idx: i, x: p.x, y: p.y, selected: i === this.selectedNodeIdx, dvMag: len(this.nodeDv(i, arriving)) });
    }
    // 選択中ノードがあれば Δv アームも組む
    let axisSpecs: AxisHandleSpec[] | null = null;
    let nodeFor3D: KinematicState | null = null;
    let arrFor3D: KinematicState | null = null;
    if (this.selectedNodeIdx !== null) {
      const node = this.plan.nodes[this.selectedNodeIdx];
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
  updateEditing(dt: number, input: Input): void {
    const fine = this.ship?.fineAttitude ?? false;
    const b = this.dvButtons.buttons;
    this.applyHeldDv(0, 1, input.down(K.dvPrograde) || b.pro.isHeld, dt, fine);
    this.applyHeldDv(0, -1, input.down(K.dvRetrograde) || b.ret.isHeld, dt, fine);
    this.applyHeldDv(1, 1, input.down(K.dvNormal) || b.nrm.isHeld, dt, fine);
    this.applyHeldDv(1, -1, input.down(K.dvAntinormal) || b.anm.isHeld, dt, fine);
    this.applyHeldDv(2, 1, input.down(K.dvRadialOut) || b.out.isHeld, dt, fine);
    this.applyHeldDv(2, -1, input.down(K.dvRadialIn) || b.in.isHeld, dt, fine);

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

  // 計画パネルの HTML を、現在のノード列と選択中ノードから組み直す。
  private syncPanel(simTime: number): void {
    const arriving = this.planDisplay.path.arrivalStates();
    const nodes = this.plan.nodes.map((n, i) => ({
      tRel: n.t - simTime,
      dvMag: len(this.nodeDv(i, arriving)),
      selected: i === this.selectedNodeIdx,
    }));
    // 選択中ノードの Δv と噴射後軌道要素を求める
    let selEl: OrbitalElements | null = null;
    let localDv: Vec3 | null = null;
    // 高度・大気圏警告の基準は、選択中ノード(無ければ計画の起点)で最も強く引く天体。
    const centerState = (this.selectedNodeIdx !== null ? this.plan.nodes[this.selectedNodeIdx] : null) ?? this.plan.anchor;
    const center = strongestAttractor(centerState.r, this.ephemeris.attractorsAt(centerState.t));
    if (this.selectedNodeIdx !== null) {
      const node = this.plan.nodes[this.selectedNodeIdx];
      const arr = arriving[this.selectedNodeIdx];
      if (node && arr) {
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
    const html = planPanelHtml(nodes, selEl, center.id === 'earth');
    
    // ノードが選択されていない時はパネル全体を非表示にする
    this.planPanel.style.display = this.selectedNodeIdx !== null ? 'block' : 'none';
    
    if (this.planBody.innerHTML !== html) this.planBody.innerHTML = html;

    if (this.selectedNodeIdx !== null && localDv) {
      this.editForm.style.display = 'block';
      // 入力フォームにフォーカスがない時だけ値を同期（ドラッグ操作での変動を反映）
      if (document.activeElement !== this.dvProInput) this.dvProInput.value = localDv.x.toFixed(1);
      if (document.activeElement !== this.dvNrmInput) this.dvNrmInput.value = localDv.y.toFixed(1);
      if (document.activeElement !== this.dvRadInput) this.dvRadInput.value = localDv.z.toFixed(1);
    } else {
      this.editForm.style.display = 'none';
    }
  }

  // 計画パネルを非表示にする。
  hidePanel(): void {
    this.planPanel.style.display = 'none';
  }

  // 計画折れ線を再積分し、ゴースト位置とアプシスアイコンを求め直す。折れ線は戦闘ビューでも
  // 描く — 計画どおりに機体を動かすのは戦闘ビューだから。ただしノードが1つも無い計画は自機の
  // 現在軌道そのものなので、ノードを置ける編集中だけ扱う。
  update(displayWindow: DisplayWindow, attractorProvider: PlanAttractorProvider): void {
    this.simTime = displayWindow.simTime;
    this.planDisplay.update(this.plan, displayWindow, this.planVisible, attractorProvider);
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
  // camera は折れ線の解像度を決める画面上のサジッタを実距離へ換算するための描画カメラ。
  sync(
    mapDist: number, simTime: number, fo: FloatingOrigin, project: ProjectFn, scale: ScaleFn,
    overviewMode: boolean, cameraPos: Vec3, camera: THREE.Camera,
  ): void {
    if (this.planVisible) {
      this.planDisplay.sync(fo, project, scale, overviewMode, cameraPos, camera);
    }
    else {
      this.planDisplay.hide();
    }
    if (this.hasPlan && this.editMode) {
      this.syncGizmo(mapDist, fo);
      this.syncPanel(simTime);
    }
  }

  // 負荷確認ウィンドウが読む、直近フレームの計画区間の積分規模。
  perfCounts(): Pick<PerfCounts, 'planArcs' | 'planSteps'> {
    return {
      planArcs: this.planDisplay.path.lastRebuiltArcs,
      planSteps: this.planDisplay.path.lastSteps,
    };
  }

  // detachedPlan(艦なし)のアンカーは原点固定で実際の軌道を表さないので、計画表示・編集は
  // 艦を持つ間だけ許可する。
  private get hasPlan(): boolean { return this.ship !== null; }

  // 計画軌道の折れ線を出すか。編集中は空の計画でも起点からの軌道を見せる。
  private get planVisible(): boolean { return this.hasPlan && (this.editMode || this.plan.nodes.length > 0); }

  // パネルとギズモを隠し、実質 Δv がゼロの末尾ノードを間引いて計画を整理する。
  onMapClosed(): void {
    this.hidePanel();
    this.hideGizmo();
    const arriving = this.planDisplay.path.arrivalStates();
    // 末尾から Δv が有意なノードに当たるまで削る。
    for (let i = this.plan.nodes.length - 1; i >= 0; i--) {
      if (!this.isEmptyNode(i, arriving)) break;
      this.plan.removeNode(i);
    }
    this.selectedNodeIdx = null;
  }
}

// 計画パネルの定型 HTML。近地点が大気圏内(<120km)なら警告を添える。
function planPanelHtml(
  nodes: { tRel: number; dvMag: number; selected: boolean; }[],
  selEl: OrbitalElements | null,
  warnAtmosphere: boolean,
): string {
  const row = (k: string, v: string) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  let s = '';
  // ノード一覧
  if (nodes.length > 0) {
    s += nodes
      .map((n, i) => {
        const sign = n.tRel >= 0 ? 'T-' : 'T+';
        return `<div class="row"><span class="k">${n.selected ? '▸ ' : ''}◈ NODE${i + 1} ${sign}${fmtTime(Math.abs(n.tRel))}</span><span class="v">${n.dvMag.toFixed(1)} m/s</span></div>`;
      })
      .join('');
  }
  // 噴射後の軌道要素、近地点が大気圏内なら警告
  if (selEl) {
    const apsis = apsisAltitudes(selEl);
    s +=
      `<div style="margin-top:4px;color:${TEXT};font-size:11px;letter-spacing:1px">噴射後の軌道</div>` +
      row('遠地点 AP', fmtDist(apsis.ap)) +
      row('近地点 PE', fmtDist(apsis.pe)) +
      row('傾斜角 INC', isFinite(selEl.incDeg) ? `${selEl.incDeg.toFixed(2)}°` : '---') +
      row('周期 PRD', fmtTime(selEl.period));
    if (warnAtmosphere && isFinite(apsis.pe) && apsis.pe < 120e3) {
      s += `<div style="color:${ACCENT};margin-top:2px">⚠ 近地点が大気圏内</div>`;
    }
  }
  // 操作キーのヒント
  const dvKeys =
    `${K.dvPrograde.label}/${K.dvRetrograde.label}・${K.dvNormal.label}/${K.dvAntinormal.label}・${K.dvRadialOut.label}/${K.dvRadialIn.label}`;
    s += `<div style="margin-top:6px;color:${TEXT_DIM};font-size:11px">[クリック] ノード配置/選択 [ノードをドラッグ] 時刻移動とマニューバ維持 [矢印ハンドル/${dvKeys}/パネルのボタン] 長押しでΔv調整、ハンドルは大きくドラッグし続けると加速 <br>[右クリック] メニュー(自動ワープ/削除) [${K.deleteNode.label}] 選択ノード削除 [${K.fineAttitudeToggle.label}] 微調整 [${K.toggleMapMode.label}] 確定して戻る(時間は進み続ける)</div>`;
  return s;
}

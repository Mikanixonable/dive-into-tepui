// 軌道計画の編集(ノードの配置・時刻移動・Δv 調整・選択・削除)と計画パネルへの反映。
// 未来表示(計画折れ線・ゴースト)は PlanDisplay を所有・駆動することで行う。
import type * as THREE from 'three/webgpu';
import { Elements, OrbitState, elementsFromState, fromOrbitalAxes, orbitState, orbitalAxes } from '../../physics/orbital';
import { Projected } from '../../physics/projection';
import { Vec3, add, dot, len, scale, sub, v3 } from '../../physics/vec3';
import type { Ephemeris } from '../../physics/ephemeris';
import * as C from '../const';
import { ACCENT, TEXT, TEXT_DIM } from '../theme';
import { Hud } from '../hud/hud';
import { HudHoldButton, SegmentedControl } from '../hud/buttons';
import { ContextMenu } from '../hud/context-menu';
import { fmtDist, fmtTime } from '../hud/utils';
import { Sfx } from '../../audio/sfx';
import type { MarkerManager } from '../marker/marker-manager';
import type { FloatingOrigin } from '../floating-origin';
import type { ProjectFn } from '../camera/camera-system';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { AxisHandleSpec, NodeGizmo, NodeHandleSpec } from './node-gizmo';
import { PlanGizmo3D } from './plan-gizmo-3d';
import { apsisAltitudes, Plan } from './plan';
import { PlanDisplay } from './plan-display';
import { hudDock } from '../hud/dom';
import { SimSpeedManager } from '../sim-speed-manager';
import type { Player } from '../player/player';
import { centralBodyDefinition, toCentralBodyState } from '../../physics/central-body';

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
  // 編集対象として選択中のノードの index。null で未選択。
  selectedNodeIdx: number | null = null;

  onFocusNode: ((state: OrbitState) => void) | null = null;

  private ship: Player | null;
  private readonly detachedPlan = new Plan();
  // アクティブ艦自身の計画を編集する。艦は自分の計画を所有し続けるので、艦を切り替えると
  // 編集対象もその艦の計画へ切り替わる。
  get plan(): Plan { return this.ship?.plan ?? this.detachedPlan; }

  readonly planDisplay: PlanDisplay;
  private readonly gizmo3d: PlanGizmo3D;

  private _editMode = false;
  get editMode(): boolean { return this._editMode; }
  setMapMode(open: boolean): void { this._editMode = open; }

  readonly nodeGizmo = new NodeGizmo();
  // ノード以外の計画軌道上を右クリックしたときのメニュー。
  private readonly orbitMenu = new ContextMenu<OrbitState>();

  private readonly dvButtons = buildDvButtons();
  // 6 方向それぞれのホールド継続時間 [s]。index は axis*2 + (sign<0 ? 1 : 0)。
  private readonly dvHoldTime: number[] = [0, 0, 0, 0, 0, 0];

  private readonly planPanel: HTMLElement;
  private readonly planBody: HTMLElement;
  private readonly editForm: HTMLElement;
  private readonly dvProInput: HTMLInputElement;
  private readonly dvNrmInput: HTMLInputElement;
  private readonly dvRadInput: HTMLInputElement;
  private readonly centralBodyControl: SegmentedControl<'earth' | 'moon'>;
  private simTime = 0;

  // 計画パネルの DOM を組み立て、ノードギズモのコールバックを配線する。
  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly ephemeris: Ephemeris,
    scene: THREE.Scene,
    markerManager: MarkerManager,
    private readonly getFineAttitude: () => boolean,
    ship: Player,
  ) {
    this.ship = ship;
    this.planDisplay = new PlanDisplay(scene, this._hud.root, markerManager, ephemeris);
    this.gizmo3d = new PlanGizmo3D();
    scene.add(this.gizmo3d.group);

    this.planPanel = document.createElement('div');
    this.planPanel.id = 'hud-plan';
    this.planPanel.className = 'panel';
    this.planPanel.innerHTML = `
      <h3>MANEUVER PLAN [${K.toggleMapMode.label}]</h3>
      <div data-id="planbody"></div>
      <div data-id="planedit" style="display:none; margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.1)">
        <div style="font-size:10px; color:${TEXT_DIM}; margin-bottom:4px;">マニューバ手動入力 (m/s)</div>
        <div class="hud-seg">
          <div class="row" style="width:100%; gap:4px; align-items:center;">
            <span class="k" style="width:28px; color:#3b82f6; font-weight:bold;">PRO</span>
            <input type="number" id="pe-dv-pro" step="0.1" style="flex:1; width:0;">
          </div>
          <div class="row" style="width:100%; gap:4px; align-items:center;">
            <span class="k" style="width:28px; color:#10b981; font-weight:bold;">NRM</span>
            <input type="number" id="pe-dv-nrm" step="0.1" style="flex:1; width:0;">
          </div>
          <div class="row" style="width:100%; gap:4px; align-items:center;">
            <span class="k" style="width:28px; color:#ef4444; font-weight:bold;">RAD</span>
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
    this.dvProInput.addEventListener('change', onInputChange);
    this.dvNrmInput.addEventListener('change', onInputChange);
    this.dvRadInput.addEventListener('change', onInputChange);
    const stopProp = (e: Event) => e.stopPropagation();
    this.dvProInput.addEventListener('keydown', stopProp);
    this.dvNrmInput.addEventListener('keydown', stopProp);
    this.dvRadInput.addEventListener('keydown', stopProp);

    this.centralBodyControl = new SegmentedControl('基準天体', [['earth', 'EARTH'], ['moon', 'MOON']] as const, (value) => {
      this.plan.centralBody = value;
      this.centralBodyControl.setSelected(value);
      this._hud.hint(`基準天体: ${centralBodyDefinition(this.plan.centralBody).label}`);
    });
    this.centralBodyControl.setSelected(this.plan.centralBody);
    document.getElementById('navball')?.appendChild(this.centralBodyControl.element);
    hudDock(this._hud.root, 'right').appendChild(this.planPanel);
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
      this.applyAxisDrag(axis, sign, deltaPx, this.getFineAttitude());
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
    this.centralBodyControl.setSelected(this.plan.centralBody);
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
    // idx 以降は下流ノードごと消えるので、そこを指していた選択は解除する。
    if (this.selectedNodeIdx !== null && this.selectedNodeIdx >= idx) this.selectedNodeIdx = null;
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
  handleMapPointer(input: Input): void {
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
  private nodeScreenPos(node: OrbitState): Projected {
    return this.planDisplay.traj.projectPoint(node.r, node.t);
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

    // 見つからなければ計画軌道上の最寄り点にノードを配置
    const hit = this.planDisplay.traj.nearestSample(mx, my, C.NODE_PICK_PX);
    if (hit) {
      this.selectedNodeIdx = this.plan.addNode(hit.state);
      this._sfx.warp();
      return;
    }

    // ノードにも計画軌道にも当たらないクリックは選択解除
    this.selectedNodeIdx = null;
  }

  // 選択中ノードが実質的に空なら削除する。到達状態を再計算できない間は保留する。
  private removeSelectedIfEmpty(): void {
    const idx = this.selectedNodeIdx;
    if (idx === null || !this.plan.nodes[idx]) return;
    const arriving = this.planDisplay.traj.arrivalStates();
    const arr = arriving[idx];
    if (!arr || len(sub(this.plan.nodes[idx]!.v, arr.v)) >= C.NODE_MIN_DV) return;
    this.plan.removeNode(idx);
    this.selectedNodeIdx = null;
  }

  // 時刻 t の計画軌道上の状態にノードを追加し、選択する。その時刻の計画軌道が
  // 求まらなければ(折れ線の届く範囲外など)ヒントを出すだけで何もしない。
  addNodeAt(t: number): void {
    const sample = this.planDisplay.traj.sampleAt(t);
    if (!sample) {
      this._hud.hint('この時刻の計画軌道が求まりません');
      return;
    }
    this.selectedNodeIdx = this.plan.addNode(sample);
    this._sfx.warp();
  }

  // 既存ノード近傍ならそれを選択してコンテキストメニューを開き true を返す。外れは false。
  private handleNodeRightClick(mx: number, my: number): boolean {
    const bestIdx = this.pickNodeAt(mx, my);
    if (bestIdx === null) {
      // ノードでなくても計画軌道上を右クリックすれば、その位置の時刻まで
      // 自動ワープできる。描画と同じサンプル列から求めるため、表示変換との
      // ずれや月基準フレームの差を生じさせない。
      const hit = this.planDisplay.traj.nearestSample(mx, my, C.NODE_PICK_PX);
      if (!hit) return false;
      this.selectedNodeIdx = null;
      this.orbitMenu.open(mx, my, hit.state, [
        { label: 'この位置まで時間を加速', act: 'warp' },
        { label: 'キャンセル [ESC]', act: 'cancel', shortcut: 'Escape' },
      ]);
      return true;
    }
    // 見つかればそれを選択してメニューを開い
    this.selectedNodeIdx = bestIdx;
    this.orbitMenu.close();
    this.nodeGizmo.openMenu(mx, my, bestIdx);
    return true;
  }

  // ドラッグ中のノードを、置ける時刻範囲の中で最寄りの計画軌道サンプル時刻へ移動する。
  private dragNodeToNearestSample(idx: number, clientX: number, clientY: number): void {
    if (!this.plan.nodes[idx]) return;
    const arriving = this.planDisplay.traj.arrivalStates();
    const hit = this.planDisplay.traj.nearestSample(clientX, clientY, Infinity, this.plan.nodeTimeRange(idx, this.ephemeris));
    if (hit) {
      this.plan.retimeNode(idx, this.rebuildDraggedNode(hit.state, hit.arcIdx, idx, arriving) ?? hit.state);
      this.selectedNodeIdx = idx;
    }
  }

  // ドラッグで時刻を動かしても、ノードのΔv(機体座標系の加減速)は維持する。
  // これにより、同じマニューバを別時刻へ移し替えた計画として再描画できる。
  private rebuildDraggedNode(
    sample: OrbitState,
    arcIdx: number,
    idx: number,
    arriving: readonly (OrbitState | null)[],
  ): OrbitState | null {
    const node = this.plan.nodes[idx];
    const arr = arriving[idx];
    if (!node || !arr) return null;
    
    // 現在のノードの絶対的な Delta-V を抽出
    const dvWorldOld = sub(node.v, arr.v);
    
    // サンプルがノードより後ろの arc (POST-burn) にある場合、
    // sample.v にはこのノードの Delta-V がすでに加算された状態になっています。
    // 再度加算してしまわないよう、プレバーン時点の速度を逆算します。
    let baseV = sample.v;
    if (arcIdx > idx) {
      baseV = sub(sample.v, dvWorldOld);
    }
    
    // 元の到着軌道基準でのローカル Delta-V 成分を求める
    const axesOld = orbitalAxes(this.bodyState(arr));
    const dvLocal = v3(
      dot(dvWorldOld, axesOld.pro),
      dot(dvWorldOld, axesOld.nrm),
      dot(dvWorldOld, axesOld.radOut),
    );
    
    // 移動先のプレバーン状態基準で、ローカル Delta-V 成分をワールド成分へ変換する
    const newPreBurnState = orbitState(sample.t, sample.r, baseV);
    const axesNew = orbitalAxes(this.bodyState(newPreBurnState));
    const newDvWorld = v3(
      axesNew.pro.x * dvLocal.x + axesNew.nrm.x * dvLocal.y + axesNew.radOut.x * dvLocal.z,
      axesNew.pro.y * dvLocal.x + axesNew.nrm.y * dvLocal.y + axesNew.radOut.y * dvLocal.z,
      axesNew.pro.z * dvLocal.x + axesNew.nrm.z * dvLocal.y + axesNew.radOut.z * dvLocal.z,
    );
    
    // 新しいベース速度に対して Delta-V を加える
    return orbitState(sample.t, sample.r, add(baseV, newDvWorld));
  }

  // 選択中ノードの axis 方向(sign 込み)へ amount [m/s] の Δv を加算する。ドラッグ・ラッチ・
  // キー/ボタンホールドはすべてここを経由し、加算量の求め方だけがそれぞれ異なる。
  // amount がゼロなら何もしない — 変化のない加算でも下流ノードは破棄されてしまう。
  private applyDv(axis: 0 | 1 | 2, sign: 1 | -1, amount: number): void {
    if (this.selectedNodeIdx === null || amount === 0) return;
    const node = this.plan.nodes[this.selectedNodeIdx];
    if (!node) return;
    const d = amount * sign;
    const local = v3(axis === 0 ? d : 0, axis === 1 ? d : 0, axis === 2 ? d : 0);
    this.plan.applyNodeDv(this.selectedNodeIdx, fromOrbitalAxes(this.bodyState(node), local));
  }

  // 手動入力フォームから絶対的な Δv (PRO, NRM, RAD) を指定してノードの速度を上書きする。
  private setNodeDvLocal(pro: number, nrm: number, rad: number): void {
    if (this.selectedNodeIdx === null) return;
    const arriving = this.planDisplay.traj.arrivalStates();
    const arr = arriving[this.selectedNodeIdx];
    const node = this.plan.nodes[this.selectedNodeIdx];
    if (!arr || !node) return;
    
    // 入力は「到着時の軌道基準枠」を基準とした絶対量とする。
    const bodyArr = this.bodyState(arr);
    const dvWorld = fromOrbitalAxes(bodyArr, v3(pro, nrm, rad));
    this.plan.retimeNode(this.selectedNodeIdx, orbitState(node.t, node.r, add(arr.v, dvWorld)));
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
    node: OrbitState,
    mapDist: number,
  ): { pro: { x: number; y: number; }; nrm: { x: number; y: number; }; rad: { x: number; y: number; }; } {
    const bodyNode = this.bodyState(node);
    const { r } = node;
    const { pro, nrm, radOut } = orbitalAxes(bodyNode);
    const L = mapDist * 0.05;
    const p0 = this.planDisplay.traj.projectPoint(r, node.t);
    // 軸方向へわずかに動かした点との投影差分から、画面上の単位方向ベクトルを求める。
    const dirFor = (axisVec: Vec3): { x: number; y: number; } => {
      const p1 = this.planDisplay.traj.projectPoint(add(r, scale(axisVec, L)), node.t);
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

  // i 番目のノードの Δv(噴射後速度 − 到達時点速度)を返す。
  private nodeDv(i: number, arriving: readonly (OrbitState | null)[]): Vec3 {
    const node = this.plan.nodes[i];
    const arr = arriving[i];
    return node && arr ? sub(this.bodyState(node).v, this.bodyState(arr).v) : v3();
  }

  // 軌道要素とΔv方向だけを基準天体中心へ変換する。計画軌道の積分自体は
  // 既存互換の地球ECIで行われるため、月基準選択時も実機状態は変更しない。
  private bodyState(state: OrbitState): OrbitState {
    return toCentralBodyState(state, this.plan.centralBody, this.ephemeris);
  }

  // 表示上限までのノードハンドルと、選択中ノードがあれば Δv アームの仕様を組み立ててギズモへ渡す。
  private syncGizmo(mapDist: number, fo: FloatingOrigin): void {
    const arriving = this.planDisplay.traj.arrivalStates();
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
    let nodeFor3D: OrbitState | null = null;
    let arrFor3D: OrbitState | null = null;
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
      const r = this.planDisplay.traj.toDisplay(nodeFor3D.r, nodeFor3D.t);
      const scenePos = fo.RtoThreeV3(r);
      const bodyArr = this.bodyState(arrFor3D);
      let { pro, nrm, radOut } = orbitalAxes(bodyArr);
      pro = this.planDisplay.traj.toDisplay(pro, nodeFor3D.t);
      nrm = this.planDisplay.traj.toDisplay(nrm, nodeFor3D.t);
      radOut = this.planDisplay.traj.toDisplay(radOut, nodeFor3D.t);
      this.gizmo3d.setPositionAndRotation(v3(scenePos.x, scenePos.y, scenePos.z), pro, nrm, radOut, mapDist * 0.002);
      
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
    const fine = this.getFineAttitude();
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
    const arriving = this.planDisplay.traj.arrivalStates();
    const nodes = this.plan.nodes.map((n, i) => ({
      tRel: n.t - simTime,
      dvMag: len(this.nodeDv(i, arriving)),
      selected: i === this.selectedNodeIdx,
    }));
    // 選択中ノードの Δv と噴射後軌道要素を求める
    let selEl: Elements | null = null;
    let localDv: Vec3 | null = null;
    if (this.selectedNodeIdx !== null) {
      const node = this.plan.nodes[this.selectedNodeIdx];
      const arr = arriving[this.selectedNodeIdx];
      if (node && arr) {
        const bodyNode = this.bodyState(node);
        const bodyArr = this.bodyState(arr);
        selEl = elementsFromState(bodyNode.r, bodyNode.v, centralBodyDefinition(this.plan.centralBody).mu);
        
        // 到着時基準でのローカルΔv成分を計算
        const dvWorld = sub(bodyNode.v, bodyArr.v);
        const axes = orbitalAxes(bodyArr);
        localDv = v3(dot(dvWorld, axes.pro), dot(dvWorld, axes.nrm), dot(dvWorld, axes.radOut));
      }
    }
    const body = centralBodyDefinition(this.plan.centralBody);
    const html = planPanelHtml(nodes, selEl, body.radius, body.id === 'earth');
    
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
  update(simTime: number, displayTime: number): void {
    this.simTime = simTime;
    this.planDisplay.update(this.plan, simTime, displayTime, this.editMode || this.plan.nodes.length > 0);
  }

  // 計画折れ線を同期する。編集中はさらに操作 UI(TRAJECTORY パネル・ノードギズモ)も出す。
  sync(mapDist: number, simTime: number, fo: FloatingOrigin, project: ProjectFn): void {
    if (this.editMode || this.plan.nodes.length > 0) {
      this.planDisplay.sync(fo, project, this.editMode);
    }
    else {
      this.planDisplay.hide();
    }
    if (this.editMode) {
      this.syncGizmo(mapDist, fo);
      this.syncPanel(simTime);
    }
  }

  // パネルとギズモを隠し、実質 Δv がゼロの末尾ノードを間引いて計画を整理する。
  onMapClosed(): void {
    this.hidePanel();
    this.hideGizmo();
    const arriving = this.planDisplay.traj.arrivalStates();
    // 末尾から Δv が有意なノードに当たるまで削る。
    for (let i = this.plan.nodes.length - 1; i >= 0; i--) {
      const arr = arriving[i];
      if (!arr || len(sub(this.plan.nodes[i]!.v, arr.v)) >= C.NODE_MIN_DV) break;
      this.plan.removeNode(i);
    }
    this.selectedNodeIdx = null;
  }
}

// 計画パネルの定型 HTML。近地点が大気圏内(<120km)なら警告を添える。
function planPanelHtml(
  nodes: { tRel: number; dvMag: number; selected: boolean; }[],
  selEl: Elements | null,
  bodyRadius: number,
  warnAtmosphere: boolean,
): string {
  const row = (k: string, v: string) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  let s = '';
  // ノード一覧
  if (nodes.length > 0) {
    s += nodes
      .map((n, i) => {
        const sign = n.tRel >= 0 ? 'T-' : 'T+';
        return `<div class="row"><span class="k">${n.selected ? '▶ ' : '◆ '}NODE${i + 1} ${sign}${fmtTime(Math.abs(n.tRel))}</span><span class="v">${n.dvMag.toFixed(1)} m/s</span></div>`;
      })
      .join('');
  }
  // 噴射後の軌道要素、近地点が大気圏内なら警告
  if (selEl) {
    const apsis = apsisAltitudes(selEl, bodyRadius);
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

// 軌道計画の編集(ノードの配置・時刻移動・Δv 調整・選択・削除)と計画パネルへの反映。
// 未来表示(予測折れ線・ゴースト)は PlanDisplay を所有・駆動することで行う。
import type * as THREE from 'three/webgpu';
import { Elements, OrbitState, elementsFromState, fromOrbitalAxes, orbitState, orbitalAxes } from '../../physics/orbital';
import { Projected } from '../../physics/projection';
import { Vec3, add, len, scale, sub, v3 } from '../../physics/vec3';
import type { Ephemeris } from '../../physics/ephemeris';
import * as C from '../const';
import { ACCENT, TEXT, TEXT_DIM } from '../theme';
import { Hud } from '../hud/hud';
import { fmtDist, fmtTime } from '../hud/utils';
import { Sfx } from '../../audio/sfx';
import type { MarkerManager } from '../marker/marker-manager';
import type { FloatingOrigin } from '../floating-origin';
import type { ProjectFn } from '../camera/camera-system';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { AxisHandleSpec, NodeGizmo, NodeHandleSpec } from './node-gizmo';
import { Plan } from './plan';
import { PlanDisplay } from './plan-display';
import { SimSpeedManager } from '../sim-speed-manager';

export class PlanEditor {
  private selectedNodeId: number | null = null;

  // 選択中ノードの現在の index。内部は ID で保持しているため、上流ノードの削除で繰り上がっても正しいノードを指す。
  get selectedNodeIdx(): number | null {
    return this.selectedNodeId === null ? null : this.plan.indexOfNodeId(this.selectedNodeId);
  }

  // 選択するノードを index で指定する。null で選択解除。
  set selectedNodeIdx(idx: number | null) {
    this.selectedNodeId = idx === null ? null : this.plan.nodeIdAt(idx);
  }

  plan: Plan = new Plan();

  readonly planDisplay: PlanDisplay;

  editMode = false;

  readonly nodeGizmo = new NodeGizmo();

  private readonly planPanel: HTMLElement;
  private readonly planBody: HTMLElement;

  // 計画パネルの DOM を組み立て、ノードギズモのコールバックを配線し、デバッグ用ノードを置く。
  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly simSpeedManager: SimSpeedManager,
    ephemeris: Ephemeris,
    scene: THREE.Scene,
    markerManager: MarkerManager,
    private readonly getFineAttitude: () => boolean,
  ) {
    this.planDisplay = new PlanDisplay(scene, this._hud.root, markerManager, ephemeris);

    this.planPanel = document.createElement('div');
    this.planPanel.id = 'hud-plan';
    this.planPanel.className = 'panel';
    this.planPanel.innerHTML = `<h3>MANEUVER PLAN [${K.toggleMapMode.label}]</h3><div data-id="planbody"></div>`;
    this.planPanel.style.display = 'none';
    this._hud.root.appendChild(this.planPanel);
    this.planBody = this.planPanel.querySelector<HTMLElement>('[data-id="planbody"]')!;
    this.wireNodeGizmo();
    this.addDebugNode();
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
      this.simSpeedManager.startAutoWarpTo(n.t);
      this._hud.hint('指定時刻まで自動ワープ開始');
    };
    g.onMenuDelete = (idx) => {
      this.deleteNode(idx);
    };
  }

  // ノードのコンテキストメニューを閉じる。
  closeMenu(): void {
    this.nodeGizmo.closeMenu();
  }

  // idx 番目のノードを削除する。
  deleteNode(idx: number): void {
    if (!this.plan.nodes[idx]) return;
    // 削除前に確定: 削除後は後続ノードが繰り上がり idx が別ノードを指す。
    const deletingSelected = this.selectedNodeIdx === idx;
    this.plan.removeNode(idx);
    if (deletingSelected) this.selectedNodeIdx = null;
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

  // クリック位置に最も近い既存ノードを選択する。ヒットしなければ予測軌道上の最寄り点へ新規ノードを配置する。
  private handleMapClick(mx: number, my: number): void {
    // 画面距離が最小の既存ノードを探す
    let bestNodeIdx: number | null = null;
    let bestNodeD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (let i = 0; i < this.plan.nodes.length; i++) {
      const p = this.nodeScreenPos(this.plan.nodes[i]!);
      if (!p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestNodeD) {
        bestNodeD = d;
        bestNodeIdx = i;
      }
    }
    if (bestNodeIdx !== null) {
      this.selectedNodeIdx = bestNodeIdx;
      this._sfx.warp();
      return;
    }

    // 見つからなければ予測軌道上の最寄り点にノードを配置
    const sample = this.planDisplay.traj.nearestSample(mx, my, C.NODE_PICK_PX);
    if (sample) {
      this.selectedNodeIdx = this.plan.addNode(sample);
      this._sfx.warp();
    }
  }

  // 既存ノード近傍ならそれを選択してコンテキストメニューを開き true を返す。外れは false。
  private handleNodeRightClick(mx: number, my: number): boolean {
    // 画面距離が最小の既存ノードを探す
    let bestIdx: number | null = null;
    let bestD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (let i = 0; i < this.plan.nodes.length; i++) {
      const p = this.nodeScreenPos(this.plan.nodes[i]!);
      if (!p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    if (bestIdx === null) return false;
    // 見つかればそれを選択してメニューを開く
    this.selectedNodeIdx = bestIdx;
    this.nodeGizmo.openMenu(mx, my, bestIdx);
    return true;
  }

  // ドラッグ中のノードを最寄りの予測軌道サンプル時刻へ移動する。
  private dragNodeToNearestSample(idx: number, clientX: number, clientY: number): void {
    if (!this.plan.nodes[idx]) return;
    const sample = this.planDisplay.traj.nearestSample(clientX, clientY, Infinity);
    if (sample) {
      this.selectedNodeIdx = this.plan.retimeNode(idx, sample);
    }
  }

  // Δv アームのドラッグ量を選択中ノードの Δv へ加算する。
  private applyAxisDrag(axis: 0 | 1 | 2, sign: 1 | -1, deltaPx: number, fineAttitude: boolean): void {
    if (this.selectedNodeIdx === null) return;
    const node = this.plan.nodes[this.selectedNodeIdx];
    if (!node) return;
    const rate = (fineAttitude ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) / 200;
    const d = deltaPx * sign * rate;
    const local = v3(axis === 0 ? d : 0, axis === 1 ? d : 0, axis === 2 ? d : 0);
    this.plan.applyNodeDv(this.selectedNodeIdx, fromOrbitalAxes(node, local));
  }

  // Δv アーム 6 個の画面方向をノード位置と微小先の投影差分から求める。
  private computeAxisScreenDirs(
    node: OrbitState,
    mapDist: number,
  ): { pro: { x: number; y: number; }; nrm: { x: number; y: number; }; rad: { x: number; y: number; }; } {
    const { r } = node;
    const { pro, nrm, radOut } = orbitalAxes(node);
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
  }

  // i 番目のノードの Δv(噴射後速度 − 到達時点速度)を返す。
  private nodeDv(i: number, arriving: readonly (OrbitState | null)[]): Vec3 {
    const node = this.plan.nodes[i];
    const arr = arriving[i];
    return node && arr ? sub(node.v, arr.v) : v3();
  }

  // 表示上限までのノードハンドルと、選択中ノードがあれば Δv アームの仕様を組み立ててギズモへ渡す。
  private updateGizmo(mapDist: number): void {
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
    if (this.selectedNodeIdx !== null) {
      const node = this.plan.nodes[this.selectedNodeIdx];
      if (node) {
        const p = this.nodeScreenPos(node);
        if (p.front) {
          const dirs = this.computeAxisScreenDirs(node, mapDist);
          axisSpecs = this.buildAxisHandles(p.x, p.y, dirs);
        }
      }
    }
    this.nodeGizmo.sync(nodeSpecs, axisSpecs);
  }

  // WASDQE の押下量から選択中ノードの Δv を加算し、計画パネルの表示データを組み立てる。
  updateEditing(dt: number, simTime: number, input: Input): void {
    const arriving = this.planDisplay.traj.arrivalStates();
    const selNode = this.selectedNodeIdx !== null ? this.plan.nodes[this.selectedNodeIdx] : undefined;
    // 選択中ノードへ prograde/normal/radial 方向の Δv を加算
    if (selNode) {
      const i = input;
      const rate = (this.getFineAttitude() ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) * dt;
      const local = v3(
        ((i.down(K.dvPrograde) ? 1 : 0) + (i.down(K.dvRetrograde) ? -1 : 0)) * rate,
        ((i.down(K.dvNormal) ? 1 : 0) + (i.down(K.dvAntinormal) ? -1 : 0)) * rate,
        ((i.down(K.dvRadialOut) ? 1 : 0) + (i.down(K.dvRadialIn) ? -1 : 0)) * rate,
      );
      this.plan.applyNodeDv(this.selectedNodeIdx!, fromOrbitalAxes(selNode, local));
    }

    // パネル表示用のノード一覧を組む
    const nodesInfo = this.plan.nodes.map((n, i) => ({
      tRel: n.t - simTime,
      dvMag: len(this.nodeDv(i, arriving)),
      selected: i === this.selectedNodeIdx,
    }));
    // 選択中ノードの Δv と噴射後軌道要素を求める
    let selDv: Vec3 | null = null;
    let selEl: Elements | null = null;
    if (this.selectedNodeIdx !== null) {
      const node = this.plan.nodes[this.selectedNodeIdx];
      if (node) {
        selDv = this.nodeDv(this.selectedNodeIdx, arriving);
        selEl = elementsFromState(node.r, node.v);
      }
    }
    this.renderPanel(nodesInfo, selDv, selEl);
  }

  // 計画パネルの HTML を差分更新する。
  private renderPanel(
    nodes: { tRel: number; dvMag: number; selected: boolean; }[],
    selDv: Vec3 | null,
    selEl: Elements | null,
  ): void {
    const html = planPanelHtml(nodes, selDv, selEl);
    this.planPanel.style.display = 'block';
    if (this.planBody.innerHTML !== html) this.planBody.innerHTML = html;
  }

  // 計画パネルを非表示にする。
  hidePanel(): void {
    this.planPanel.style.display = 'none';
  }

  // デバッグ用のノードを1つ置く。
  private addDebugNode(): void {
    this.plan.addNode(orbitState(0, v3(0, 0, 6.8e6), v3(7656, 0, 0)));
  }

  // editMode 中は計画の未来表示とノードギズモを同期し、そうでなければ両方隠す。
  sync(
    mapDist: number,
    simTime: number,
    displayTime: number,
    fo: FloatingOrigin,
    project: ProjectFn,
  ): void {
    if (this.editMode) {
      this.planDisplay.sync(this.plan, simTime, displayTime, fo, project);
      this.updateGizmo(mapDist);
    }
    else {
      this.planDisplay.hide();
      this.hideGizmo();
    }
  }

  // パネルを隠し、実質 Δv がゼロの末尾ノードを間引いて計画を整理する。
  onMapClosed(): void {
    this.hidePanel();
    if (this.plan.nodes.length > 0) {
      const arriving = this.planDisplay.traj.arrivalStates();
      for (let i = this.plan.nodes.length - 1; i >= 0; i--) {
        const arr = arriving[i];
        if (arr && len(sub(this.plan.nodes[i]!.v, arr.v)) < C.NODE_MIN_DV) this.plan.removeNode(i);
      }
    }
    this.selectedNodeIdx = null;
  }
}

// 計画パネルの定型 HTML。近地点が大気圏内(<120km)なら警告を添える。
function planPanelHtml(
  nodes: { tRel: number; dvMag: number; selected: boolean; }[],
  selDv: Vec3 | null,
  selEl: Elements | null,
): string {
  const row = (k: string, v: string) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  let s = '';
  // ノード一覧、無ければ配置案内
  if (nodes.length === 0) {
    s += `<div style="color:${TEXT_DIM}">予測軌道(グレー)をクリックしてマニューバノードを配置</div>`;
  } else {
    s += nodes
      .map((n, i) => {
        const sign = n.tRel >= 0 ? 'T-' : 'T+';
        return `<div class="row"><span class="k">${n.selected ? '▶ ' : '◆ '}NODE${i + 1} ${sign}${fmtTime(Math.abs(n.tRel))}</span><span class="v">${n.dvMag.toFixed(1)} m/s</span></div>`;
      })
      .join('');
  }
  // 選択中ノードの Δv 内訳
  if (selDv) {
    s +=
      `<div style="margin-top:4px;color:${TEXT};font-size:11px;letter-spacing:1px">選択中ノードの Δv</div>` +
      row('Δv PRO [W/S]', `${selDv.x.toFixed(1)} m/s`) +
      row('Δv NRM [A/D]', `${selDv.y.toFixed(1)} m/s`) +
      row('Δv RAD [E/Q]', `${selDv.z.toFixed(1)} m/s`) +
      row('合計 Δv', `${Math.hypot(selDv.x, selDv.y, selDv.z).toFixed(1)} m/s`);
  }
  // 噴射後の軌道要素、近地点が大気圏内なら警告
  if (selEl) {
    s +=
      `<div style="margin-top:4px;color:${TEXT};font-size:11px;letter-spacing:1px">噴射後の軌道</div>` +
      row('遠地点 AP', fmtDist(selEl.apAlt)) +
      row('近地点 PE', fmtDist(selEl.peAlt)) +
      row('傾斜角 INC', isFinite(selEl.incDeg) ? `${selEl.incDeg.toFixed(2)}°` : '---') +
      row('周期 PRD', fmtTime(selEl.period));
    if (isFinite(selEl.peAlt) && selEl.peAlt < 120e3) {
      s += `<div style="color:${ACCENT};margin-top:2px">⚠ 近地点が大気圏内</div>`;
    }
  }
  // 操作キーのヒント
  const dvKeys =
    `${K.dvPrograde.label}/${K.dvRetrograde.label}・${K.dvNormal.label}/${K.dvAntinormal.label}・${K.dvRadialOut.label}/${K.dvRadialIn.label}`;
  s += `<div style="margin-top:6px;color:${TEXT_DIM};font-size:11px">[クリック] ノード配置/選択 [ノードをドラッグ] 時刻移動 [矢印ハンドル/${dvKeys}] Δv調整 [右クリック] メニュー(自動ワープ/削除) [${K.deleteNode.label}] 選択ノード削除 [${K.fineAttitudeToggle.label}] 微調整 [${K.toggleMapMode.label}] 確定して戻る(時間は進み続ける)</div>`;
  return s;
}

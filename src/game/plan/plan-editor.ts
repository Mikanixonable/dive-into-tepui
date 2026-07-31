// 軌道計画の編集(ノードの配置・時刻移動・Δv 調整・選択・削除)と計画パネルへの反映。
// 未来表示(予測折れ線・ゴースト)は PlanDisplay を所有・駆動することで行う。
import type * as THREE from 'three/webgpu';
import { Elements, OrbitState, elementsFromState } from '../../physics/orbital';
import { dvToWorld, propagateState } from '../../physics/predict';
import { Projected } from '../../physics/projection';
import { Vec3, add, cross, len, norm, scale, sub, v3 } from '../../physics/vec3';
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

  get selectedNodeIdx(): number | null {
    return this.selectedNodeId === null ? null : this.plan.indexOfNodeId(this.selectedNodeId);
  }

  set selectedNodeIdx(idx: number | null) {
    this.selectedNodeId = idx === null ? null : this.plan.nodeIdAt(idx);
  }

  plan: Plan = new Plan();

  readonly planDisplay: PlanDisplay;

  editMode = false;

  readonly nodeGizmo = new NodeGizmo();

  private readonly planPanel: HTMLElement;
  private readonly planBody: HTMLElement;

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly ephemeris: Ephemeris,
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
  }

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

  private nodeArrivings(): OrbitState[] {
    const out: OrbitState[] = [];
    let state = this.plan.anchor;
    for (const node of this.plan.nodes) {
      out.push(propagateState(state, node.t, this.ephemeris));
      state = node;
    }
    return out;
  }

  closeMenu(): void {
    this.nodeGizmo.closeMenu();
  }

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

  deleteSelected(): void {
    if (this.selectedNodeIdx === null) return;
    this.deleteNode(this.selectedNodeIdx);
  }

  handleInput(input: Input): void {
    if (input.takeKey(K.deleteNode)) this.clearPlanByKey();
  }

  handleMapPointer(input: Input): void {
    input.takeRightClicks((p) => this.handleNodeRightClick(p.x, p.y));
    input.takeClicks((p) => {
      this.handleMapClick(p.x, p.y);
      return true;
    });
  }

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

  private nodeScreenPos(node: OrbitState): Projected {
    return this.planDisplay.traj.projectPoint(node.r, node.t);
  }

  private handleMapClick(mx: number, my: number): void {
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

    const sample = this.planDisplay.traj.nearestSample(mx, my, C.NODE_PICK_PX);
    if (sample) {
      this.selectedNodeIdx = this.plan.addNode(sample);
      this._sfx.warp();
    }
  }

  // 既存ノード近傍ならそれを選択してコンテキストメニューを開き true を返す。外れは false。
  private handleNodeRightClick(mx: number, my: number): boolean {
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
    this.selectedNodeIdx = bestIdx;
    this.nodeGizmo.openMenu(mx, my, bestIdx);
    return true;
  }

  private dragNodeToNearestSample(idx: number, clientX: number, clientY: number): void {
    if (!this.plan.nodes[idx]) return;
    const sample = this.planDisplay.traj.nearestSample(clientX, clientY, Infinity);
    if (sample) {
      this.selectedNodeIdx = this.plan.retimeNode(idx, sample);
    }
  }

  private applyAxisDrag(axis: 0 | 1 | 2, sign: 1 | -1, deltaPx: number, fineAttitude: boolean): void {
    if (this.selectedNodeIdx === null) return;
    const node = this.plan.nodes[this.selectedNodeIdx];
    if (!node) return;
    const rate = (fineAttitude ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) / 200;
    const d = deltaPx * sign * rate;
    const local = v3(axis === 0 ? d : 0, axis === 1 ? d : 0, axis === 2 ? d : 0);
    this.plan.applyNodeDv(this.selectedNodeIdx, dvToWorld(node.r, node.v, local));
  }

  // Δv アーム 6 個の画面方向をノード位置と微小先の投影差分から求める。
  private computeAxisScreenDirs(
    node: OrbitState,
    mapDist: number,
  ): { pro: { x: number; y: number; }; nrm: { x: number; y: number; }; rad: { x: number; y: number; }; } {
    const { r, v } = node;
    const pro = norm(v);
    const h = norm(cross(r, v));
    const radOut = cross(pro, h);
    const L = mapDist * 0.05;
    const p0 = this.planDisplay.traj.projectPoint(r, node.t);
    const dirFor = (axisVec: Vec3): { x: number; y: number; } => {
      const p1 = this.planDisplay.traj.projectPoint(add(r, scale(axisVec, L)), node.t);
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const m = Math.hypot(dx, dy);
      return m > 1e-6 ? { x: dx / m, y: dy / m } : { x: 0, y: -1 };
    };
    return { pro: dirFor(pro), nrm: dirFor(h), rad: dirFor(radOut) };
  }

  private buildAxisHandles(
    nx: number,
    ny: number,
    dirs: { pro: { x: number; y: number; }; nrm: { x: number; y: number; }; rad: { x: number; y: number; }; },
  ): AxisHandleSpec[] {
    const R = C.NODE_GIZMO_HANDLE_PX;
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

  private hideGizmo(): void {
    this.nodeGizmo.sync([], null);
  }

  private nodeDv(i: number, arriving: readonly OrbitState[]): Vec3 {
    const node = this.plan.nodes[i];
    const arr = arriving[i];
    return node && arr ? sub(node.v, arr.v) : v3();
  }

  private updateGizmo(mapDist: number): void {
    const arriving = this.nodeArrivings();
    const nodeSpecs: NodeHandleSpec[] = [];
    const limit = Math.min(this.plan.nodes.length, C.MAX_PLAN_NODE_MARKERS);
    for (let i = 0; i < limit; i++) {
      const node = this.plan.nodes[i]!;
      const p = this.nodeScreenPos(node);
      if (!p.front) continue;
      nodeSpecs.push({ idx: i, x: p.x, y: p.y, selected: i === this.selectedNodeIdx, dvMag: len(this.nodeDv(i, arriving)) });
    }
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

  updateEditing(dt: number, simTime: number, input: Input): void {
    const arriving = this.nodeArrivings();
    const selNode = this.selectedNodeIdx !== null ? this.plan.nodes[this.selectedNodeIdx] : undefined;
    if (selNode) {
      const i = input;
      const rate = (this.getFineAttitude() ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) * dt;
      const local = v3(
        ((i.down(K.dvPrograde) ? 1 : 0) + (i.down(K.dvRetrograde) ? -1 : 0)) * rate,
        ((i.down(K.dvNormal) ? 1 : 0) + (i.down(K.dvAntinormal) ? -1 : 0)) * rate,
        ((i.down(K.dvRadialOut) ? 1 : 0) + (i.down(K.dvRadialIn) ? -1 : 0)) * rate,
      );
      this.plan.applyNodeDv(this.selectedNodeIdx!, dvToWorld(selNode.r, selNode.v, local));
    }

    const nodesInfo = this.plan.nodes.map((n, i) => ({
      tRel: n.t - simTime,
      dvMag: len(this.nodeDv(i, arriving)),
      selected: i === this.selectedNodeIdx,
    }));
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

  private renderPanel(
    nodes: { tRel: number; dvMag: number; selected: boolean; }[],
    selDv: Vec3 | null,
    selEl: Elements | null,
  ): void {
    const html = planPanelHtml(nodes, selDv, selEl);
    this.planPanel.style.display = 'block';
    if (this.planBody.innerHTML !== html) this.planBody.innerHTML = html;
  }

  hidePanel(): void {
    this.planPanel.style.display = 'none';
  }

  sync(
    mapDist: number,
    displayEnd: number,
    simTime: number,
    displayTime: number,
    fo: FloatingOrigin,
    project: ProjectFn,
  ): void {
    if (this.editMode) {
      this.planDisplay.sync(this.plan, displayEnd, simTime, displayTime, fo, project);
      this.updateGizmo(mapDist);
    }
    else {
      this.planDisplay.hide();
      this.hideGizmo();
    }
  }

  onMapClosed(): void {
    this.hidePanel();
    if (this.plan.nodes.length > 0) {
      const arriving = this.nodeArrivings();
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
  if (selDv) {
    s +=
      `<div style="margin-top:4px;color:${TEXT};font-size:11px;letter-spacing:1px">選択中ノードの Δv</div>` +
      row('Δv PRO [W/S]', `${selDv.x.toFixed(1)} m/s`) +
      row('Δv NRM [A/D]', `${selDv.y.toFixed(1)} m/s`) +
      row('Δv RAD [E/Q]', `${selDv.z.toFixed(1)} m/s`) +
      row('合計 Δv', `${Math.hypot(selDv.x, selDv.y, selDv.z).toFixed(1)} m/s`);
  }
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
  const dvKeys =
    `${K.dvPrograde.label}/${K.dvRetrograde.label}・${K.dvNormal.label}/${K.dvAntinormal.label}・${K.dvRadialOut.label}/${K.dvRadialIn.label}`;
  s += `<div style="margin-top:6px;color:${TEXT_DIM};font-size:11px">[クリック] ノード配置/選択 [ノードをドラッグ] 時刻移動 [矢印ハンドル/${dvKeys}] Δv調整 [右クリック] メニュー(自動ワープ/削除) [${K.deleteNode.label}] 選択ノード削除 [${K.fineAttitudeToggle.label}] 微調整 [${K.toggleMapMode.label}] 確定して戻る(時間は進み続ける)</div>`;
  return s;
}

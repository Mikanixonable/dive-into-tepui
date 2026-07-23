// マップモード上での軌道計画(Plan)の編集: クリックでのノード配置・ドラッグでの
// 時刻移動・Δv アーム(mapgizmo.ts)ドラッグ・右クリックメニュー・選択状態・計画パネル
// 表示への反映、および [X] キー(ノード/計画削除)の実処理。ノードの実座標変換
// (太陽回転系表示)は呼び出し側が渡す DisplayFrameFn 経由で plan-display.ts の
// toDisplayFrame に委譲する — 表示とクリック判定の基準角がずれないよう、正はそちら
// 一箇所のみに保つ。ノード削除時の自動ワープ解除(SimSpeedManager)・噴射ガイドの
// 凍結目標クリア(onPlanCleared コールバック、Game 側の状態のため)はここが起点。
import { Elements, elementsFromState } from '../../physics/orbital';
import { PlannedNode } from '../../physics/predict';
import { Vec3, add, cross, len, norm, scale, sub, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Input } from '../input';
import { AxisHandleSpec, MapGizmo, NodeHandleSpec } from '../map-mode/map-gizmo';
import { ProjectFn } from '../camera/camera-system';
import { MapLabel } from '../map-mode/map-markers';
import { DisplayFrameFn } from './plan-display';
import { Plan } from './plan';
import { SimSpeedManager } from '../sim-speed-manager';

// mapGizmo のイベントを外部(MapModeSystem)のロジックへ橋渡しするためのコールバック束。
// mapGizmo 自体は private のため、外部からのコールバック配線はこの一箇所を通す。
export interface MapGizmoCallbacks {
  onNodeSelect: (idx: number) => void;
  onNodeDragMove: (idx: number, clientX: number, clientY: number) => void;
  onNodeContextMenu: (clientX: number, clientY: number) => void;
  onAxisDrag: (axis: 0 | 1 | 2, sign: 1 | -1, deltaPx: number) => void;
  onMenuWarpTo: (idx: number) => void;
  onMenuDelete: (idx: number) => void;
  onMenuFocus: (targetKey: string) => void;
}

export class PlanEditor {
  selectedNodeIdx: number | null = null;
  plan: Plan = new Plan();

  // マップモードの DOM ギズモ(ノードハンドル・Δv アーム・コンテキストメニュー)。
  // イベント配線は bindGizmoCallbacks() 経由のみ(外部に直接公開しない)。
  private readonly mapGizmo = new MapGizmo();

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly onPlanCleared: () => void,
  ) {}

  // mapGizmo (private) のイベントを外部ロジックへ橋渡しする唯一の配線口。
  bindGizmoCallbacks(cb: MapGizmoCallbacks): void {
    this.mapGizmo.onNodeSelect = cb.onNodeSelect;
    this.mapGizmo.onNodeDragMove = cb.onNodeDragMove;
    this.mapGizmo.onNodeContextMenu = cb.onNodeContextMenu;
    this.mapGizmo.onAxisDrag = cb.onAxisDrag;
    this.mapGizmo.onMenuWarpTo = cb.onMenuWarpTo;
    this.mapGizmo.onMenuDelete = cb.onMenuDelete;
    this.mapGizmo.onMenuFocus = cb.onMenuFocus;
  }

  closeMenu(): void {
    this.mapGizmo.closeMenu();
  }

  // ノード削除の唯一の実装(右クリメニュー・[X] キーの両方からここを呼ぶ)。
  // 選択インデックスの繰り上げと、自動ワープ解除・ヒント表示もここで行う。
  deleteNode(idx: number): void {
    if (!this.plan.nodes[idx]) return;
    this.plan.removeNode(idx);
    if (this.selectedNodeIdx === idx) this.selectedNodeIdx = null;
    else if (this.selectedNodeIdx !== null && this.selectedNodeIdx > idx) this.selectedNodeIdx--;
    this.closeMenu();
    this.simSpeedManager.cancelAutoWarp();
    this._hud.hint('ノードを削除');
  }

  // [X] キー向け: 現在選択中のノードを削除する。選択が無ければ何もしない。
  deleteSelected(): void {
    if (this.selectedNodeIdx === null) return;
    this.deleteNode(this.selectedNodeIdx);
  }

  // [X] キー: マップモード中は選択中ノードのみ、マップ外では計画全体を破棄する。
  // 噴射ガイドの凍結目標(planGuide.clearActiveTarget)は Game 側の状態のため、
  // onPlanCleared コールバックで通知する。
  clearPlanByKey(mapMode: boolean): void {
    if (mapMode) {
      this.deleteSelected();
      return;
    }
    if (this.plan.nodes.length <= 0) return;
    this.plan.clear();
    this.onPlanCleared();
    this.simSpeedManager.cancelAutoWarp();
    this._hud.hint('マニューバ計画を破棄');
  }

  nodeScreenPos(
    node: PlannedNode,
    o: Vec3,
    toDisplayFrame: DisplayFrameFn,
    project: ProjectFn,
  ): { x: number; y: number; front: boolean } | null {
    const s = this.plan.sampleAt(node.time);
    if (!s) return null;
    return project(sub(toDisplayFrame(s.r, node.time), o));
  }

  // マップ上のクリック処理: 既存ノードマーカー近傍なら選択、そうでなければ
  // 予測軌道(既存ノードの噴射も反映済みの折れ線)上の最近傍サンプル時刻に
  // 新規ノードを配置して選択する。
  handleMapClick(mx: number, my: number, o: Vec3, toDisplayFrame: DisplayFrameFn, project: ProjectFn): void {
    this.mapGizmo.closeMenu();
    let bestNodeIdx: number | null = null;
    let bestNodeD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (let i = 0; i < this.plan.nodes.length; i++) {
      const p = this.nodeScreenPos(this.plan.nodes[i]!, o, toDisplayFrame, project);
      if (!p || !p.front) continue;
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

    if (this.plan.trajSamples.length < 2) return;
    let bestT: number | null = null;
    let bestD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (const s of this.plan.trajSamples) {
      const p = project(sub(toDisplayFrame(s.r, s.t), o));
      if (!p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestD) {
        bestD = d;
        bestT = s.t;
      }
    }
    if (bestT !== null) {
      const idx = this.plan.addNode({ time: bestT, dv: v3() });
      this.selectedNodeIdx = idx;
      this._sfx.warp();
    }
  }

  // マップモードの右クリック処理: 既存ノードマーカー近傍(NODE_PICK_PX 以内)なら
  // そのノードを選択してコンテキストメニューを開く。それ以外なら開いているメニューを閉じるだけ。
  // ノード削除はこのメニュー経由([X] キーからも可能)。
  handleMapRightClick(
    mx: number,
    my: number,
    o: Vec3,
    toDisplayFrame: DisplayFrameFn,
    project: ProjectFn,
    labels: MapLabel[],
  ): void {
    let bestIdx: number | null = null;
    let bestD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (let i = 0; i < this.plan.nodes.length; i++) {
      const p = this.nodeScreenPos(this.plan.nodes[i]!, o, toDisplayFrame, project);
      if (!p || !p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }

    let bestTargetKey: string | null = null;
    let bestTargetD = C.MAP_LABEL_PICK_PX * C.MAP_LABEL_PICK_PX;
    for (const lbl of labels) {
      const wp = sub(lbl.pos, o);
      const p = project(wp);
      if (!p || !p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestTargetD) {
        bestTargetD = d;
        bestTargetKey = lbl.id;
      }
    }

    if (bestIdx !== null) {
      this.selectedNodeIdx = bestIdx;
      this.mapGizmo.openMenu(mx, my, { idx: bestIdx });
    } else if (bestTargetKey !== null) {
      this.mapGizmo.openMenu(mx, my, { targetKey: bestTargetKey });
    } else {
      this.mapGizmo.closeMenu();
    }
  }

  // ノードハンドルのドラッグ移動: ポインタ最寄りの予測サンプル時刻へノードを移動する
  // (handleMapClick の第二段(軌道クリック配置)と同じピッキング方式)。
  dragNodeToNearestSample(
    idx: number,
    clientX: number,
    clientY: number,
    o: Vec3,
    toDisplayFrame: DisplayFrameFn,
    project: ProjectFn,
  ): void {
    if (!this.plan.nodes[idx] || this.plan.trajSamples.length === 0) return;
    let bestT: number | null = null;
    let bestD = Infinity;
    for (const s of this.plan.trajSamples) {
      const p = project(sub(toDisplayFrame(s.r, s.t), o));
      if (!p.front) continue;
      const d = (p.x - clientX) * (p.x - clientX) + (p.y - clientY) * (p.y - clientY);
      if (d < bestD) {
        bestD = d;
        bestT = s.t;
      }
    }
    if (bestT !== null) {
      this.selectedNodeIdx = this.plan.setNodeTime(idx, bestT);
    }
  }

  // 選択中ノードの Δv アーム(mapgizmo.ts)ドラッグを Δv 成分の変更へ変換する。
  // axis: 0=プログレード(dv.x) 1=法線(dv.y) 2=動径(dv.z)。sign はハンドル自身の向き
  // (mapgizmo.ts の AxisHandleSpec 参照)。deltaPx はポインタ移動のハンドル方向への射影量。
  applyAxisDrag(axis: 0 | 1 | 2, sign: 1 | -1, deltaPx: number, fineAttitude: boolean): void {
    if (this.selectedNodeIdx === null) return;
    const rate = (fineAttitude ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) / 200;
    const d = deltaPx * sign * rate;
    this.plan.adjustNodeDv(this.selectedNodeIdx, axis === 0 ? d : 0, axis === 1 ? d : 0, axis === 2 ? d : 0);
  }

  // 選択中ノードの Δv アーム 6 個(プログレード/レトログレード・ノーマル/アンチノーマル・
  // アウト/イン)の画面方向を求める。トラジェクトリサンプルの r, v からその時点の
  // プログレード・軌道法線・動径アウト方向を求め、toDisplayFrame で表示座標系へ回転した
  // 上でノード位置との画面上の差分を取ることで、3D 回転行列を介さず画面方向を得る。
  computeAxisScreenDirs(
    node: PlannedNode,
    o: Vec3,
    toDisplayFrame: DisplayFrameFn,
    project: ProjectFn,
    mapDist: number,
  ): { pro: { x: number; y: number }; nrm: { x: number; y: number }; rad: { x: number; y: number } } | null {
    const s = this.plan.sampleAt(node.time);
    if (!s) return null;
    const pro = norm(s.v);
    const h = norm(cross(s.r, s.v));
    const radOut = cross(pro, h);
    const L = mapDist * 0.05;
    const p0 = project(sub(toDisplayFrame(s.r, node.time), o));
    const dirFor = (axisVec: Vec3): { x: number; y: number } => {
      const p1 = project(sub(toDisplayFrame(add(s.r, scale(axisVec, L)), node.time), o));
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
    dirs: { pro: { x: number; y: number }; nrm: { x: number; y: number }; rad: { x: number; y: number } },
  ): AxisHandleSpec[] {
    const R = C.NODE_GIZMO_HANDLE_PX;
    const mk = (axis: 0 | 1 | 2, sign: 1 | -1, d: { x: number; y: number }, label: string): AxisHandleSpec => ({
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

  hideGizmo(): void {
    this.mapGizmo.update([], null);
  }

  // 毎フレーム(マップモード中のみ呼ぶ): ノードハンドル群と、選択中ノードがあれば
  // Δv アーム 6 個(無ければ全破棄)を画面座標で更新する。
  updateGizmo(o: Vec3, toDisplayFrame: DisplayFrameFn, project: ProjectFn, mapDist: number): void {
    const nodeSpecs: NodeHandleSpec[] = [];
    const limit = Math.min(this.plan.nodes.length, C.MAX_PLAN_NODE_MARKERS);
    for (let i = 0; i < limit; i++) {
      const node = this.plan.nodes[i]!;
      const p = this.nodeScreenPos(node, o, toDisplayFrame, project);
      if (!p || !p.front) continue;
      nodeSpecs.push({ idx: i, x: p.x, y: p.y, selected: i === this.selectedNodeIdx, dvMag: len(node.dv) });
    }
    let axisSpecs: AxisHandleSpec[] | null = null;
    if (this.selectedNodeIdx !== null) {
      const node = this.plan.nodes[this.selectedNodeIdx];
      if (node) {
        const p = this.nodeScreenPos(node, o, toDisplayFrame, project);
        if (p && p.front) {
          const dirs = this.computeAxisScreenDirs(node, o, toDisplayFrame, project, mapDist);
          if (dirs) axisSpecs = this.buildAxisHandles(p.x, p.y, dirs);
        }
      }
    }
    this.mapGizmo.update(nodeSpecs, axisSpecs);
  }

  // マップ表示中のノード編集(時間・物理は Game.simulate() 側で通常どおり進み続ける。
  // ここではクリックによるノード配置・選択、選択中ノードの Δv 調整、計画パネル・
  // ツールバーの表示を行う)。toolbar は PlanDisplay/MapCamera 側の状態のスナップ
  // ショットで、map-mode-system.ts が毎フレーム組み立てて渡す。
  updateEditing(
    dt: number,
    simTime: number,
    o: Vec3,
    toDisplayFrame: DisplayFrameFn,
    input: Input,
    project: ProjectFn,
    opts: {
      fineAttitude: boolean;
      labels: MapLabel[];
      toolbar: { durationKey: string; frameRotating: boolean; ghostLabel: string | null; focus: string };
    },
  ): void {
    for (const c of input.clicks()) {
      this.handleMapClick(c.x, c.y, o, toDisplayFrame, project);
    }
    for (const rc of input.rightClicks()) {
      this.handleMapRightClick(rc.x, rc.y, o, toDisplayFrame, project, opts.labels);
    }

    // Δv 調整(推進キーを流用、[V] で微調整)。選択中ノードがあるときのみ。
    const selNode = this.selectedNodeIdx !== null ? this.plan.nodes[this.selectedNodeIdx] : undefined;
    if (selNode) {
      const i = input;
      const rate = (opts.fineAttitude ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) * dt;
      const dvx = ((i.down('KeyW') ? 1 : 0) + (i.down('KeyS') ? -1 : 0)) * rate;
      const dvy = ((i.down('KeyA') ? 1 : 0) + (i.down('KeyD') ? -1 : 0)) * rate;
      const dvz = ((i.down('KeyE') ? 1 : 0) + (i.down('KeyQ') ? -1 : 0)) * rate;
      this.plan.adjustNodeDv(this.selectedNodeIdx!, dvx, dvy, dvz);
    }

    const nodesInfo = this.plan.nodes.map((n, i) => ({
      tRel: n.time - simTime,
      dvMag: len(n.dv),
      selected: i === this.selectedNodeIdx,
    }));
    let selDv: Vec3 | null = null;
    let selEl: Elements | null = null;
    if (selNode) {
      selDv = selNode.dv;
      const s = this.plan.sampleAt(selNode.time);
      if (s) selEl = elementsFromState(s.r, s.v);
    }
    this._hud.setPlanPanel(this._hud.planHtml(nodesInfo, selDv, selEl));
    this._hud.setMapToolbarState(
      opts.toolbar.durationKey,
      opts.toolbar.frameRotating,
      opts.toolbar.ghostLabel,
      opts.toolbar.focus,
    );
  }

  // マップモードを閉じる ([M] で確定) ときの後始末: Δv がほぼゼロのまま放置された
  // ノード(クリックしただけで調整しなかった等)を破棄する。
  onMapClosed(): void {
    this.plan.pruneNearZeroDv(C.NODE_MIN_DV);
    this.selectedNodeIdx = null;
  }
}

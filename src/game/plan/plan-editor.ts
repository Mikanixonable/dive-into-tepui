// マップモード上での軌道計画(Plan)の編集: クリックでのノード配置・ドラッグでの
// 時刻移動・Δv アーム(node-gizmo.ts)ドラッグ・右クリックメニュー・選択状態・計画パネル
// 表示への反映、および [X] キー(ノード/計画削除)の実処理。ノードの実座標変換
// (太陽回転系表示)は呼び出し側が渡す DisplayFrameFn 経由で predict-system.ts の
// toDisplayFrame に委譲する — 表示とクリック判定の基準角がずれないよう、正はそちら
// 一箇所のみに保つ。ノード削除時の自動ワープ解除(SimSpeedManager)はここが起点。
// ノード配置・リタイムのピッキングは plan の隣接キャッシュ(plan.trajSamples)を読む。
// 空の計画時には自機状態を基準に計画する。
// 計画が空でないときは自機状態は参照しない。逸脱した既存計画を持って editMode を開いた場合は現在状態に再ベースされない
import { Elements, OrbitState, elementsFromState, orbitState } from '../../physics/orbital';
import { PlannedNode, TrajectorySample, dvToWorld } from '../../physics/predict';
import { Vec3, add, clone, cross, len, norm, scale, sub, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Input } from '../input/input';
import { AxisHandleSpec, NodeGizmo, NodeHandleSpec } from './node-gizmo';
import { ProjectFn } from '../camera/camera-system';
import { DisplayFrameFn } from '../predict/predict-system';
import { Frame } from '../../physics/frame';
import { Plan } from './plan';
import { SimSpeedManager } from '../sim-speed-manager';

export class PlanEditor {
  selectedNodeIdx: number | null = null;
  plan: Plan = new Plan();

  // ノード編集の DOM ギズモ(ハンドル・Δv アーム・ノードメニュー)。イベント配線は
  // 所有者である PlanSystem が nodeGizmo に直接行う(フォーカス選択メニューは別責務で
  // CameraSystem が持つ FocusGizmo 側)。
  readonly nodeGizmo = new NodeGizmo();

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly simSpeedManager: SimSpeedManager,
  ) {}

  closeMenu(): void {
    this.nodeGizmo.closeMenu();
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

  // [X] キー: 計画編集モード中は選択中ノードのみ、モード外では計画全体を破棄する。
  clearPlanByKey(editMode: boolean): void {
    if (editMode) {
      this.deleteSelected();
      return;
    }
    if (this.plan.nodes.length <= 0) return;
    this.plan.clear();
    this.simSpeedManager.cancelAutoWarp();
    this._hud.hint('マニューバ計画を破棄');
  }

  // ノードの画面位置は凍結された実行後位置(postState.r)から直接求める
  // — 予測キャッシュに依存しない(placement/retime のピッキングだけがキャッシュを読む)。
  nodeScreenPos(
    node: PlannedNode,
    toDisplayFrame: DisplayFrameFn,
    project: ProjectFn,
  ): { x: number; y: number; front: boolean } {
    return project(toDisplayFrame(node.postState.r, node.time));
  }

  // マップ上のクリック処理: 既存ノードマーカー近傍なら選択、そうでなければ
  // 予測軌道(既存ノードの噴射も反映済みの折れ線)上の最近傍サンプル時刻に
  // 新規ノードを配置して選択する。
  handleMapClick(mx: number, my: number, toDisplayFrame: DisplayFrameFn, project: ProjectFn): void {
    this.closeMenu();
    let bestNodeIdx: number | null = null;
    let bestNodeD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (let i = 0; i < this.plan.nodes.length; i++) {
      const p = this.nodeScreenPos(this.plan.nodes[i]!, toDisplayFrame, project);
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

    const sample = this.nearestSample(mx, my, toDisplayFrame, project);
    if (sample) {
      // クリック点の予測サンプル状態を凍結してノードにする(初期 Δv = 0)。
      const idx = this.plan.addNode({
        time: sample.t,
        postState: orbitState(clone(sample.r), clone(sample.v)),
      });
      this.selectedNodeIdx = idx;
      this._sfx.warp();
    }
  }

  // ポインタ最寄りの予測サンプルを返す(NODE_PICK_PX 以内、無ければ null)。ノード配置・
  // リタイムのピッキングはここだけが plan の隣接キャッシュ(trajSamples)を読む。
  private nearestSample(
    mx: number,
    my: number,
    toDisplayFrame: DisplayFrameFn,
    project: ProjectFn,
    maxPx: number = C.NODE_PICK_PX,
  ): TrajectorySample | null {
    let best: TrajectorySample | null = null;
    let bestD = maxPx * maxPx;
    for (const s of this.plan.trajSamples) {
      const p = project(toDisplayFrame(s.r, s.t));
      if (!p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  // マップモードの右クリック処理(ノード側): 既存ノードマーカー近傍(NODE_PICK_PX 以内)
  // ならそのノードを選択してコンテキストメニューを開き true を返す(=右クリックを消費)。
  // ノードに当たらなければノードメニューを閉じて false を返し、呼び出し側(game.ts)が
  // フォーカス選択(CameraSystem)へフォールバックさせる。ノード削除はこのメニュー経由
  // ([X] キーからも可能)。
  handleNodeRightClick(mx: number, my: number, toDisplayFrame: DisplayFrameFn, project: ProjectFn): boolean {
    let bestIdx: number | null = null;
    let bestD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (let i = 0; i < this.plan.nodes.length; i++) {
      const p = this.nodeScreenPos(this.plan.nodes[i]!, toDisplayFrame, project);
      if (!p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    if (bestIdx === null) {
      this.nodeGizmo.closeMenu();
      return false;
    }
    this.selectedNodeIdx = bestIdx;
    this.nodeGizmo.openMenu(mx, my, bestIdx);
    return true;
  }

  // ノードハンドルのドラッグ移動: ポインタ最寄りの予測サンプルへノードをリタイムする
  // (handleMapClick の軌道クリック配置と同じピッキング)。凍結 ▸ 再スナップなので、
  // ノードの Δv はリセットされ、下流ノードは破棄される(plan.retimeNode)。
  dragNodeToNearestSample(
    idx: number,
    clientX: number,
    clientY: number,
    toDisplayFrame: DisplayFrameFn,
    project: ProjectFn,
  ): void {
    if (!this.plan.nodes[idx]) return;
    const sample = this.nearestSample(clientX, clientY, toDisplayFrame, project, Infinity);
    if (sample) {
      this.selectedNodeIdx = this.plan.retimeNode(idx, sample.t, orbitState(clone(sample.r), clone(sample.v)));
    }
  }

  // 選択中ノードの Δv アーム(node-gizmo.ts)ドラッグを実行後速度(postState.v)の変更へ
  // 変換する。axis: 0=プログレード 1=法線 2=動径。sign はハンドル自身の向き
  // (node-gizmo.ts の AxisHandleSpec 参照)。deltaPx はポインタ移動のハンドル方向への射影量。
  applyAxisDrag(axis: 0 | 1 | 2, sign: 1 | -1, deltaPx: number, fineAttitude: boolean): void {
    if (this.selectedNodeIdx === null) return;
    const node = this.plan.nodes[this.selectedNodeIdx];
    if (!node) return;
    const rate = (fineAttitude ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) / 200;
    const d = deltaPx * sign * rate;
    const local = v3(axis === 0 ? d : 0, axis === 1 ? d : 0, axis === 2 ? d : 0);
    this.plan.applyNodeDv(this.selectedNodeIdx, dvToWorld(node.postState.r, node.postState.v, local));
  }

  // 選択中ノードの Δv アーム 6 個(プログレード/レトログレード・ノーマル/アンチノーマル・
  // アウト/イン)の画面方向を求める。ノードの実行後状態(postState)からその時点の
  // プログレード・軌道法線・動径アウト方向を求め、toDisplayFrame で表示座標系へ回転した
  // 上でノード位置との画面上の差分を取ることで、3D 回転行列を介さず画面方向を得る。
  computeAxisScreenDirs(
    node: PlannedNode,
    toDisplayFrame: DisplayFrameFn,
    project: ProjectFn,
    mapDist: number,
  ): { pro: { x: number; y: number }; nrm: { x: number; y: number }; rad: { x: number; y: number } } {
    const { r, v } = node.postState;
    const pro = norm(v);
    const h = norm(cross(r, v));
    const radOut = cross(pro, h);
    const L = mapDist * 0.05;
    const p0 = project(toDisplayFrame(r, node.time));
    const dirFor = (axisVec: Vec3): { x: number; y: number } => {
      const p1 = project(toDisplayFrame(add(r, scale(axisVec, L)), node.time));
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
    this.nodeGizmo.sync([], null);
  }

  // ノード i の Δv(= 実行後速度 − 到達時速度)。到達状態 arriving[i] は呼び出し側
  // (PlanSystem、ephemeris を持つ)が predict で導出して渡す — ノードは Δv を正データに
  // 持たず postState だけを持つため。表示専用(ハンドルラベル・計画パネル)。
  private nodeDv(i: number, arriving: readonly OrbitState[]): Vec3 {
    const node = this.plan.nodes[i];
    const arr = arriving[i];
    return node && arr ? sub(node.postState.v, arr.v) : v3();
  }

  // 毎フレーム(マップモード中のみ呼ぶ): ノードハンドル群と、選択中ノードがあれば
  // Δv アーム 6 個(無ければ全破棄)を画面座標で更新する。
  updateGizmo(toDisplayFrame: DisplayFrameFn, project: ProjectFn, mapDist: number, arriving: readonly OrbitState[]): void {
    const nodeSpecs: NodeHandleSpec[] = [];
    const limit = Math.min(this.plan.nodes.length, C.MAX_PLAN_NODE_MARKERS);
    for (let i = 0; i < limit; i++) {
      const node = this.plan.nodes[i]!;
      const p = this.nodeScreenPos(node, toDisplayFrame, project);
      if (!p.front) continue;
      nodeSpecs.push({ idx: i, x: p.x, y: p.y, selected: i === this.selectedNodeIdx, dvMag: len(this.nodeDv(i, arriving)) });
    }
    let axisSpecs: AxisHandleSpec[] | null = null;
    if (this.selectedNodeIdx !== null) {
      const node = this.plan.nodes[this.selectedNodeIdx];
      if (node) {
        const p = this.nodeScreenPos(node, toDisplayFrame, project);
        if (p.front) {
          const dirs = this.computeAxisScreenDirs(node, toDisplayFrame, project, mapDist);
          axisSpecs = this.buildAxisHandles(p.x, p.y, dirs);
        }
      }
    }
    this.nodeGizmo.sync(nodeSpecs, axisSpecs);
  }

  // マップ表示中のノード編集(時間・物理は Game.simulate() 側で通常どおり進み続ける。
  // ここでは選択中ノードの Δv 調整、計画パネル・ツールバーの表示を行う。クリック/右
  // クリックによるノード配置・メニュー呼び出しは game.ts が dispatch する)。toolbar は
  // predictSystem/MapCamera 側の状態のスナップショットで、PlanSystem が毎フレーム組み立てて渡す。
  updateEditing(
    dt: number,
    simTime: number,
    input: Input,
    arriving: readonly OrbitState[],
    opts: {
      fineAttitude: boolean;
      toolbar: { durationKey: string; frame: Frame; plannedPlayerLabel: string | null; focus: string };
    },
  ): void {
    // Δv 調整(推進キーを流用、[V] で微調整)。選択中ノードがあるときのみ。実行後速度
    // (postState.v)を pro/nrm/rad → world で変更する(下流ノードは applyNodeDv が破棄)。
    const selNode = this.selectedNodeIdx !== null ? this.plan.nodes[this.selectedNodeIdx] : undefined;
    if (selNode) {
      const i = input;
      const rate = (opts.fineAttitude ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) * dt;
      const local = v3(
        ((i.down('KeyW') ? 1 : 0) + (i.down('KeyS') ? -1 : 0)) * rate,
        ((i.down('KeyA') ? 1 : 0) + (i.down('KeyD') ? -1 : 0)) * rate,
        ((i.down('KeyE') ? 1 : 0) + (i.down('KeyQ') ? -1 : 0)) * rate,
      );
      this.plan.applyNodeDv(this.selectedNodeIdx!, dvToWorld(selNode.postState.r, selNode.postState.v, local));
    }

    const nodesInfo = this.plan.nodes.map((n, i) => ({
      tRel: n.time - simTime,
      dvMag: len(this.nodeDv(i, arriving)),
      selected: i === this.selectedNodeIdx,
    }));
    let selDv: Vec3 | null = null;
    let selEl: Elements | null = null;
    if (this.selectedNodeIdx !== null) {
      const node = this.plan.nodes[this.selectedNodeIdx];
      if (node) {
        selDv = this.nodeDv(this.selectedNodeIdx, arriving);
        selEl = elementsFromState(node.postState.r, node.postState.v);
      }
    }
    this._hud.setPlanPanel(this._hud.planHtml(nodesInfo, selDv, selEl));
    this._hud.setMapToolbarState(
      opts.toolbar.durationKey,
      opts.toolbar.frame,
      opts.toolbar.plannedPlayerLabel,
      opts.toolbar.focus,
    );
  }

  // マップモードを閉じる ([M] で確定) ときの後始末: 選択を解除する。Δv がほぼゼロの
  // まま放置されたノードの破棄(要 ephemeris で Δv 導出)は PlanSystem.onMapClosed が行う。
  onMapClosed(): void {
    this.selectedNodeIdx = null;
  }
}

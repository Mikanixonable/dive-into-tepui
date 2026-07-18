// マニューバ計画(ノード列)と予測軌道キャッシュ、およびマップモードのノード編集入力
// (クリック配置・ドラッグ・Δv アームギズモ)。マップモードでなくても生きている
// (確定済みノードの噴射ガイドは戦闘ビューで表示される)。
// game.ts を import しない — 依存は PlannerCtx 引数・コンストラクタ注入・コールバックのみ。
import { Elements, R_EARTH, elementsFromState } from '../physics/orbital';
import { sunAzimuth } from '../physics/ephemeris';
import { PlannedNode, PredictOpts, TrajectorySample, predictTrajectory, sampleAt } from '../physics/predict';
import { Vec3, add, cross, len, norm, rotateAxis, scale, sub, v3 } from '../physics/vec3';
import * as C from './const';
import { Hud } from './hud';
import { Sfx } from './audio';
import { Input } from './input';
import { AxisHandleSpec, MapGizmo, NodeHandleSpec } from './mapgizmo';

// スクリーン投影。アクティブカメラに依存するので Game から都度コールバックで渡す。
export type ProjectFn = (rel: Vec3) => { x: number; y: number; front: boolean };

// マップ上のフォーカス対象(地球・月・太陽・ラグランジュ点など)ラベル。
// ラベル自体は MapView の持ち物(現時点では game.ts)なので Game から都度渡す。
export interface MapLabel {
  id: string;
  name: string;
  pos: Vec3;
}

// refresh() / predictDurationSec() が必要とする、Game 側の現在状態のスナップショット。
export interface PlannerCtx {
  simTime: number;
  playerR: Vec3; // player.state.r
  playerV: Vec3; // player.state.v
  sunPhase0: number;
  moonPhase0: number;
  mapMode: boolean;
  mapFrameRotating: boolean;
}

export class MapPlanner {
  // 複数ノード・時間ベースの軌道計画(絶対 simTime を持つノードの列。時刻順)。
  // 各ノードの Δv はノード実行時点の(その時点までの計画を反映した)速度を基準に
  // プログレード/ノーマル/ラジアルアウト成分で保持する — ワープで時間が進んでも
  // ノード自体の実行時刻は絶対時刻なのでドリフトしない。
  planNodes: PlannedNode[] = [];
  selectedNodeIdx: number | null = null;
  // 数値予測(predict.ts)の結果キャッシュ。マップモードのポリライン描画・
  // クリックピッキング・戦闘ビューの噴射ガイドの双方で共有する。
  trajSamples: TrajectorySample[] = [];
  trajDirty = true; // ノード変更等で再計算が必要
  trajGeomDirty = true; // trajLine のジオメトリ再構築が必要(refreshTrajectory 後に立てる)
  trajLastRefreshMs = -Infinity; // performance.now() 基準
  // マップモードの「太陽回転系」表示で、予測サンプルを t_now 時点の太陽方位へ
  // 揃えるための回転角。再計算(refreshTrajectory)のたびに固定し、次の
  // 再計算まではクリック判定・描画とも同じ値を使う(表示と判定の整合を取るため)。
  trajYawRef = 0;
  predictDurationKey: 'orbit' | 'day' | 'week' | 'month' = 'day';

  // マップモードの DOM ギズモ(ノードハンドル・Δv アーム・コンテキストメニュー)。
  readonly mapGizmo = new MapGizmo();

  constructor(private readonly hud: Hud, private readonly sfx: Sfx) {}

  // 選んだ期間、戦闘ビューでは直近の未達成ノードをちょうど含む程度の短い期間だけ
  // 計算する(28日ぶんを毎回計算するのは無駄なコストになるため)。
  predictDurationSec(ctx: PlannerCtx): number {
    if (this.predictDurationKey === 'orbit') {
      const el: Elements | null = elementsFromState(ctx.playerR, ctx.playerV);
      if (el && isFinite(el.period) && el.period > 0) return el.period;
      return C.PREDICT_DUR_DAY; // 双曲線・放物線軌道では1日にフォールバック
    }
    if (this.predictDurationKey === 'week') return C.PREDICT_DUR_WEEK;
    if (this.predictDurationKey === 'month') return C.PREDICT_DUR_MONTH;
    return C.PREDICT_DUR_DAY;
  }

  refresh(ctx: PlannerCtx): void {
    let duration: number;
    if (ctx.mapMode) {
      duration = this.predictDurationSec(ctx);
    } else {
      const first = this.planNodes[0];
      duration = first ? Math.max(60, first.time - ctx.simTime + 120) : 0;
    }
    if (duration <= 0) {
      this.trajSamples = [];
    } else {
      const opts: PredictOpts = {
        sunPhase0: ctx.sunPhase0,
        moonPhase0: ctx.moonPhase0,
        maxSamples: C.PREDICT_MAX_SAMPLES,
      };
      this.trajSamples = predictTrajectory(
        { r: ctx.playerR, v: ctx.playerV },
        ctx.simTime,
        duration,
        this.planNodes,
        opts,
      );
    }
    this.trajYawRef = ctx.mapFrameRotating ? sunAzimuth(ctx.simTime, ctx.sunPhase0) : 0;
    this.trajDirty = false;
    this.trajGeomDirty = true;
    this.trajLastRefreshMs = performance.now();
  }

  // dirty フラグが立っていれば ~5Hz、そうでなければ2秒ごとに予測を再計算する。
  // マップモードでもなくノードもなければ(表示・ガイドとも不要なので)何もしない。
  maybeRefresh(ctx: PlannerCtx): void {
    const needed = ctx.mapMode || this.planNodes.length > 0;
    if (!needed) {
      if (this.trajSamples.length > 0) this.trajSamples = [];
      return;
    }
    const elapsed = performance.now() - this.trajLastRefreshMs;
    const threshold = this.trajDirty ? C.PREDICT_DIRTY_THROTTLE_MS : C.PREDICT_REFRESH_INTERVAL_MS;
    if (elapsed >= threshold) this.refresh(ctx);
  }

  // ------------------------------------------------------- node editing input

  closeMenu(): void {
    this.mapGizmo.closeMenu();
  }

  // ECI 座標 r(時刻 t のもの)をマップの「太陽回転系」表示用に回転させる
  // (非回転系なら無変換)。回転角は直近の refreshTrajectory 時点で固定した
  // trajYawRef を使うので、次回再計算までは描画とクリック判定が一致する。
  toDisplayFrame(r: Vec3, t: number, ctx: PlannerCtx): Vec3 {
    if (!ctx.mapFrameRotating) return r;
    const phi = this.trajYawRef - sunAzimuth(t, ctx.sunPhase0);
    return rotateAxis(r, v3(0, 1, 0), phi);
  }

  nodeScreenPos(node: PlannedNode, o: Vec3, ctx: PlannerCtx, project: ProjectFn): { x: number; y: number; front: boolean } | null {
    const s = sampleAt(this.trajSamples, node.time);
    if (!s) return null;
    return project(sub(this.toDisplayFrame(s.r, node.time, ctx), o));
  }

  // マップ上のクリック処理: 既存ノードマーカー近傍なら選択、そうでなければ
  // 予測軌道(既存ノードの噴射も反映済みの折れ線)上の最近傍サンプル時刻に
  // 新規ノードを配置して選択する。
  handleMapClick(mx: number, my: number, ctx: PlannerCtx, project: ProjectFn): void {
    const o = ctx.playerR;
    this.mapGizmo.closeMenu();
    let bestNodeIdx: number | null = null;
    let bestNodeD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (let i = 0; i < this.planNodes.length; i++) {
      const p = this.nodeScreenPos(this.planNodes[i]!, o, ctx, project);
      if (!p || !p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestNodeD) {
        bestNodeD = d;
        bestNodeIdx = i;
      }
    }
    if (bestNodeIdx !== null) {
      this.selectedNodeIdx = bestNodeIdx;
      this.sfx.warp();
      return;
    }

    if (this.trajSamples.length < 2) return;
    let bestT: number | null = null;
    let bestD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (const s of this.trajSamples) {
      const p = project(sub(this.toDisplayFrame(s.r, s.t, ctx), o));
      if (!p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestD) {
        bestD = d;
        bestT = s.t;
      }
    }
    if (bestT !== null) {
      const newNode: PlannedNode = { time: bestT, dv: v3() };
      this.planNodes.push(newNode);
      this.planNodes.sort((a, b) => a.time - b.time);
      this.selectedNodeIdx = this.planNodes.indexOf(newNode);
      this.trajDirty = true;
      this.sfx.warp();
    }
  }

  // マップモードの右クリック処理: 既存ノードマーカー近傍(NODE_PICK_PX 以内)なら
  // そのノードを選択してコンテキストメニューを開く。それ以外なら開いているメニューを閉じるだけ
  // (右クリックの元の「即削除」動作はメニュー経由に置き換えた。[X] キーは従来どおり残す)。
  handleMapRightClick(mx: number, my: number, ctx: PlannerCtx, project: ProjectFn, labels: MapLabel[]): void {
    const o = ctx.playerR;
    let bestIdx: number | null = null;
    let bestD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (let i = 0; i < this.planNodes.length; i++) {
      const p = this.nodeScreenPos(this.planNodes[i]!, o, ctx, project);
      if (!p || !p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }

    let bestTargetKey: string | null = null;
    let bestTargetD = 20 * 20;
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
  // 移動後は時刻順を保つよう再ソートし、同一ノードオブジェクトを選択し直す
  // (この結果、後続ノードは絶対時刻を保ったままになる=並び順が変わり得る)。
  dragNodeToNearestSample(idx: number, clientX: number, clientY: number, ctx: PlannerCtx, project: ProjectFn): void {
    const node = this.planNodes[idx];
    if (!node || this.trajSamples.length === 0) return;
    const o = ctx.playerR;
    let bestT: number | null = null;
    let bestD = Infinity;
    for (const s of this.trajSamples) {
      const p = project(sub(this.toDisplayFrame(s.r, s.t, ctx), o));
      if (!p.front) continue;
      const d = (p.x - clientX) * (p.x - clientX) + (p.y - clientY) * (p.y - clientY);
      if (d < bestD) {
        bestD = d;
        bestT = s.t;
      }
    }
    if (bestT !== null && bestT !== node.time) {
      node.time = bestT;
      this.planNodes.sort((a, b) => a.time - b.time);
      this.selectedNodeIdx = this.planNodes.indexOf(node);
      this.trajDirty = true;
    }
  }

  // 選択中ノードの Δv アーム(mapgizmo.ts)ドラッグを Δv 成分の変更へ変換する。
  // axis: 0=プログレード(dv.x) 1=法線(dv.y) 2=動径(dv.z)。sign はハンドル自身の向き
  // (mapgizmo.ts の AxisHandleSpec 参照)。deltaPx はポインタ移動のハンドル方向への射影量。
  applyAxisDrag(axis: 0 | 1 | 2, sign: 1 | -1, deltaPx: number, fineAttitude: boolean): void {
    if (this.selectedNodeIdx === null) return;
    const node = this.planNodes[this.selectedNodeIdx];
    if (!node) return;
    const rate = (fineAttitude ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) / 200;
    const d = deltaPx * sign * rate;
    if (axis === 0) node.dv = v3(node.dv.x + d, node.dv.y, node.dv.z);
    else if (axis === 1) node.dv = v3(node.dv.x, node.dv.y + d, node.dv.z);
    else node.dv = v3(node.dv.x, node.dv.y, node.dv.z + d);
    this.trajDirty = true;
  }

  // 選択中ノードの Δv アーム 6 個(プログレード/レトログレード・ノーマル/アンチノーマル・
  // アウト/イン)の画面方向を求める。トラジェクトリサンプルの r, v からその時点の
  // プログレード・軌道法線・動径アウト方向を求め、toDisplayFrame で表示座標系へ回転した
  // 上でノード位置との画面上の差分を取ることで、3D 回転行列を介さず画面方向を得る。
  computeAxisScreenDirs(
    node: PlannedNode,
    o: Vec3,
    ctx: PlannerCtx,
    project: ProjectFn,
    mapDist: number,
  ): { pro: { x: number; y: number }; nrm: { x: number; y: number }; rad: { x: number; y: number } } | null {
    const s = sampleAt(this.trajSamples, node.time);
    if (!s) return null;
    const pro = norm(s.v);
    const h = norm(cross(s.r, s.v));
    const radOut = cross(pro, h);
    const L = mapDist * 0.05;
    const p0 = project(sub(this.toDisplayFrame(s.r, node.time, ctx), o));
    const dirFor = (axisVec: Vec3): { x: number; y: number } => {
      const p1 = project(sub(this.toDisplayFrame(add(s.r, scale(axisVec, L)), node.time, ctx), o));
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const m = Math.hypot(dx, dy);
      return m > 1e-6 ? { x: dx / m, y: dy / m } : { x: 0, y: -1 };
    };
    return { pro: dirFor(pro), nrm: dirFor(h), rad: dirFor(radOut) };
  }

  buildAxisHandles(
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

  // 毎フレーム、マップモードの DOM ギズモ(ノードハンドル・選択中ノードの Δv アーム)を
  // 画面座標で更新する。マップモード外・ノードが背後(front=false)なら該当分を隠す。
  updateMapGizmo(o: Vec3, ctx: PlannerCtx, project: ProjectFn, mapMode: boolean, mapDist: number): void {
    if (!mapMode) {
      this.mapGizmo.update([], null);
      return;
    }
    const nodeSpecs: NodeHandleSpec[] = [];
    const limit = Math.min(this.planNodes.length, C.MAX_PLAN_NODE_MARKERS);
    for (let i = 0; i < limit; i++) {
      const node = this.planNodes[i]!;
      const p = this.nodeScreenPos(node, o, ctx, project);
      if (!p || !p.front) continue;
      nodeSpecs.push({ idx: i, x: p.x, y: p.y, selected: i === this.selectedNodeIdx, dvMag: len(node.dv) });
    }
    let axisSpecs: AxisHandleSpec[] | null = null;
    if (this.selectedNodeIdx !== null) {
      const node = this.planNodes[this.selectedNodeIdx];
      if (node) {
        const p = this.nodeScreenPos(node, o, ctx, project);
        if (p && p.front) {
          const dirs = this.computeAxisScreenDirs(node, o, ctx, project, mapDist);
          if (dirs) axisSpecs = this.buildAxisHandles(p.x, p.y, dirs);
        }
      }
    }
    this.mapGizmo.update(nodeSpecs, axisSpecs);
  }

  // 未来位置ゴースト(スライダー)のラベル文字列
  ghostLabel(ctx: PlannerCtx, mapSliderT: number): string {
    const duration = this.predictDurationSec(ctx);
    const t = ctx.simTime + mapSliderT * duration;
    const s = sampleAt(this.trajSamples, t);
    if (!s) return '';
    const tRel = t - ctx.simTime;
    const alt = len(s.r) - R_EARTH;
    const h = Math.floor(tRel / 3600);
    const m = Math.floor((tRel % 3600) / 60);
    return `T+${h}h${String(m).padStart(2, '0')}m 高度 ${(alt / 1000).toFixed(0)}km`;
  }

  // マップ表示中のノード編集(時間・物理は Game.simulate() 側で通常どおり進み続ける。
  // ここではクリックによるノード配置・選択、選択中ノードの Δv 調整、
  // ツールバー・計画パネルの表示を行う)
  updateEditing(
    dt: number,
    ctx: PlannerCtx,
    input: Input,
    project: ProjectFn,
    opts: { fineAttitude: boolean; mapSliderT: number; mapFocus: string; labels: MapLabel[] },
  ): void {
    for (const c of input.takeClicks()) {
      this.handleMapClick(c.x, c.y, ctx, project);
    }
    for (const rc of input.takeRightClicks()) {
      this.handleMapRightClick(rc.x, rc.y, ctx, project, opts.labels);
    }

    // Δv 調整(推進キーを流用、[V] で微調整)。選択中ノードがあるときのみ。
    const selNode = this.selectedNodeIdx !== null ? this.planNodes[this.selectedNodeIdx] : undefined;
    if (selNode) {
      const i = input;
      const rate = (opts.fineAttitude ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) * dt;
      const dvx = ((i.down('KeyW') ? 1 : 0) + (i.down('KeyS') ? -1 : 0)) * rate;
      const dvy = ((i.down('KeyA') ? 1 : 0) + (i.down('KeyD') ? -1 : 0)) * rate;
      const dvz = ((i.down('KeyE') ? 1 : 0) + (i.down('KeyQ') ? -1 : 0)) * rate;
      if (dvx !== 0 || dvy !== 0 || dvz !== 0) {
        selNode.dv = v3(selNode.dv.x + dvx, selNode.dv.y + dvy, selNode.dv.z + dvz);
        this.trajDirty = true;
      }
    }

    this.hud.setMapToolbarState(
      this.predictDurationKey,
      ctx.mapFrameRotating,
      opts.mapSliderT > 0 ? this.ghostLabel(ctx, opts.mapSliderT) : null,
      opts.mapFocus,
    );

    const nodesInfo = this.planNodes.map((n, i) => ({
      tRel: n.time - ctx.simTime,
      dvMag: len(n.dv),
      selected: i === this.selectedNodeIdx,
    }));
    let selDv: Vec3 | null = null;
    let selEl: Elements | null = null;
    if (selNode) {
      selDv = selNode.dv;
      const s = sampleAt(this.trajSamples, selNode.time);
      if (s) selEl = elementsFromState(s.r, s.v);
    }
    this.hud.setPlanPanel(this.hud.planHtml(nodesInfo, selDv, selEl));
  }
}

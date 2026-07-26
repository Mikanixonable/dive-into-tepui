// マップモード上での軌道計画(Plan)の編集: クリックでのノード配置・ドラッグでの
// 時刻移動・Δv アーム(node-gizmo.ts)ドラッグ・右クリックメニュー・選択状態・計画パネル
// 表示への反映、および [X] キー(ノード/計画削除)の実処理。ノードの画面座標・最寄りサンプルの
// 画面判定は PlanTrajectory(B-2)へ委譲する — `traj.projectPoint(r, t)`(ワールド点→表示座標系→
// 画面)と `traj.nearestSample(mx, my, maxPx)` を呼ぶだけで、座標系(frame)や physics/frame.ts(XX)
// を直接参照しない。描画と同じ変換を通すので表示とクリック判定がずれない。
//
// その B-2 を所有・駆動するのは predict 側(PredictSystem)で、ここは参照を共有するだけ。
// ノードのドラッグ・右クリックは DOM イベント発火時点で画面判定を要するため、毎フレームの
// 引数ではなくコンストラクタで受けた参照を保持する。
//
// 責務: ノード編集ロジック本体に加え、編集モードフラグ(editMode)とノードギズモのイベント配線
// (wireNodeGizmo)を所有する。予測の未来表示(折れ線・ゴースト・ツールバー)は predictSystem、
// マップラベルは cameraSystem の責務で、それらは game が別途駆動する — editor は経由しない。
//
// 計画が空の間は自機状態を基準に計画する(plan.trackAnchor は game が毎フレーム呼ぶ)。
// 計画が空でないときは自機状態は参照しない。逸脱した既存計画を持って editMode を開いた場合は
// 現在状態に再ベースされない。
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
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { AxisHandleSpec, NodeGizmo, NodeHandleSpec } from './node-gizmo';
import { Plan } from './plan';
import { PlanTrajectory } from '../predict/plan-trajectory';
import { SimSpeedManager } from '../sim-speed-manager';

export class PlanEditor {
  selectedNodeIdx: number | null = null;
  plan: Plan = new Plan();

  // 軌道計画の編集モード(WASDQE などの操作系をΔv編集へ振り替え、ノード編集入力を有効化する)。
  // cameraSystem.mapMode(広範囲視点)とは本来独立した責務で、たまたま MapModeToggler が
  // 同時にトグルしているだけ。挙動・入力側の判定はこのフラグ、描画・視点側は mapMode を見る。
  editMode = false;

  // ノード編集の DOM ギズモ(ハンドル・Δv アーム・ノードメニュー)。イベントは wireNodeGizmo で
  // 自身が配線する(フォーカス選択メニューは別責務で CameraSystem が持つ FocusGizmo 側)。
  readonly nodeGizmo = new NodeGizmo();

  // 計画パネル(HUD 左下 "MANEUVER PLAN")。表示内容はノード編集の産物なので editor が所有する。
  // CSS(#hud-plan)は hud/dom.ts の STYLE に一元管理されている。
  private readonly planPanel: HTMLElement;
  private readonly planBody: HTMLElement;

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly ephemeris: Ephemeris,
    // 予測折れ線 + per-arc キャッシュ(B-2)。所有は PredictSystem 側で、ここは画面判定
    // (projectPoint / nearestSample)のために参照を共有する。
    private readonly traj: PlanTrajectory,
    private readonly getFineAttitude: () => boolean,
  ) {
    this.planPanel = document.createElement('div');
    this.planPanel.id = 'hud-plan';
    this.planPanel.className = 'panel';
    this.planPanel.innerHTML = `<h3>MANEUVER PLAN [${K.toggleMapMode.label}]</h3><div data-id="planbody"></div>`;
    this.planPanel.style.display = 'none';
    this._hud.root.appendChild(this.planPanel);
    this.planBody = this.planPanel.querySelector<HTMLElement>('[data-id="planbody"]')!;
    this.wireNodeGizmo();
  }

  // ノードギズモ(ハンドル・Δv アーム・ノードメニュー)のイベントを配線する。どれもノード編集の
  // 責務なのでここで完結する(フォーカス選択は別責務で CameraSystem 側)。
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
    // ハンドル直上の右クリックは必ずそのノードに当たるので、キャンバス右クリックと同じ処理へ流す。
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

  // 各ノードの到達(噴射前)状態。Δv 表示・空ノード判定に使う。arc をアンカー → 各ノード
  // 境界の順に自由伝播して求める(arc の起点はアンカー、以降は前ノードの postState)。予測計算に
  // ephemeris が要るためここで導出する(ノードは Δv を正データに持たず postState だけを持つ)。
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

  // [X] は編集モードの内外どちらでも意味を持つ(編集中は選択ノード削除、戦闘ビューでは計画破棄)
  // ので、マップの開閉に関わらず毎フレーム受ける。
  handleInput(input: Input): void {
    if (input.takeKey(K.deleteNode)) this.clearPlanByKey();
  }

  // マップ編集中のポインタ操作。右クリックはノードに当たったものだけ消費し(外したものは
  // フォーカス選択へ回す)、左クリックはノードの選択/配置として消費する。
  handleMapPointer(input: Input): void {
    input.takeRightClicks((p) => this.handleNodeRightClick(p.x, p.y));
    input.takeClicks((p) => {
      this.handleMapClick(p.x, p.y);
      return true;
    });
  }

  // [X] キー: 計画編集モード中は選択中ノードのみ、モード外では計画全体を破棄する。
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

  // ノードの画面位置は凍結された実行後位置(node.r)から B-2 の表示座標変換で求める。
  private nodeScreenPos(node: OrbitState): Projected {
    return this.traj.projectPoint(node.r, node.t);
  }

  // マップ上のクリック処理: 既存ノードマーカー近傍なら選択、そうでなければ
  // 予測軌道(既存ノードの噴射も反映済みの折れ線)上の最近傍サンプル時刻に
  // 新規ノードを配置して選択する。画面判定は B-2(traj)へ委譲する。
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

    const sample = this.traj.nearestSample(mx, my, C.NODE_PICK_PX);
    if (sample) {
      // クリック点の予測サンプル状態(時刻込み)をそのまま凍結してノードにする(初期 Δv = 0)。
      this.selectedNodeIdx = this.plan.addNode(sample);
      this._sfx.warp();
    }
  }

  // マップモードの右クリック処理(ノード側): 既存ノードマーカー近傍(NODE_PICK_PX 以内)
  // ならそのノードを選択してコンテキストメニューを開き true を返す(=右クリックを消費)。
  // 外したときは false を返し、その右クリックはフォーカス選択(CameraSystem)へ回る。
  // ノード削除はこのメニュー経由([X] キーからも可能)。
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

  // ノードハンドルのドラッグ移動: ポインタ最寄りの予測サンプルへノードをリタイムする
  // (handleMapClick の軌道クリック配置と同じピッキング)。凍結 ▸ 再スナップなので、
  // ノードの Δv はリセットされ、下流ノードは破棄される(plan.retimeNode)。
  private dragNodeToNearestSample(idx: number, clientX: number, clientY: number): void {
    if (!this.plan.nodes[idx]) return;
    const sample = this.traj.nearestSample(clientX, clientY, Infinity);
    if (sample) {
      this.selectedNodeIdx = this.plan.retimeNode(idx, sample);
    }
  }

  // 選択中ノードの Δv アーム(node-gizmo.ts)ドラッグを実行後速度(postState.v)の変更へ
  // 変換する。axis: 0=プログレード 1=法線 2=動径。sign はハンドル自身の向き
  // (node-gizmo.ts の AxisHandleSpec 参照)。deltaPx はポインタ移動のハンドル方向への射影量。
  private applyAxisDrag(axis: 0 | 1 | 2, sign: 1 | -1, deltaPx: number, fineAttitude: boolean): void {
    if (this.selectedNodeIdx === null) return;
    const node = this.plan.nodes[this.selectedNodeIdx];
    if (!node) return;
    const rate = (fineAttitude ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) / 200;
    const d = deltaPx * sign * rate;
    const local = v3(axis === 0 ? d : 0, axis === 1 ? d : 0, axis === 2 ? d : 0);
    this.plan.applyNodeDv(this.selectedNodeIdx, dvToWorld(node.r, node.v, local));
  }

  // 選択中ノードの Δv アーム 6 個(プログレード/レトログレード・ノーマル/アンチノーマル・
  // アウト/イン)の画面方向を求める。ノードの実行後状態(postState)からその時点の
  // プログレード・軌道法線・動径アウト方向を求め、B-2 の projectPoint で表示座標系へ回転した
  // 上でノード位置との画面上の差分を取ることで、3D 回転行列を介さず画面方向を得る。
  private computeAxisScreenDirs(
    node: OrbitState,
    mapDist: number,
  ): { pro: { x: number; y: number; }; nrm: { x: number; y: number; }; rad: { x: number; y: number; }; } {
    const { r, v } = node;
    const pro = norm(v);
    const h = norm(cross(r, v));
    const radOut = cross(pro, h);
    const L = mapDist * 0.05;
    const p0 = this.traj.projectPoint(r, node.t);
    const dirFor = (axisVec: Vec3): { x: number; y: number; } => {
      const p1 = this.traj.projectPoint(add(r, scale(axisVec, L)), node.t);
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

  // ノード i の Δv(= 実行後速度 − 到達時速度)。到達状態 arriving[i] は nodeArrivings() が
  // predict で導出した値。ノードは Δv を正データに持たず実行後状態だけを持つため。
  // 表示専用(ハンドルラベル・計画パネル)。
  private nodeDv(i: number, arriving: readonly OrbitState[]): Vec3 {
    const node = this.plan.nodes[i];
    const arr = arriving[i];
    return node && arr ? sub(node.v, arr.v) : v3();
  }

  // 毎フレーム(マップ表示中のみ呼ぶ): ノードハンドル群と、選択中ノードがあれば
  // Δv アーム 6 個(無ければ全破棄)を画面座標で更新する。
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

  // マップ表示中のノード編集ロジック(game.ts が editMode 中に毎フレーム呼ぶ。時間・物理は
  // Game.update() 側で通常どおり進み続ける)。選択中ノードの Δv 調整と計画パネルの反映を行う。
  // クリック/右クリックによるノード配置・メニュー呼び出しは game.ts が dispatch する。
  updateEditing(dt: number, simTime: number, input: Input): void {
    const arriving = this.nodeArrivings();
    // Δv 調整(推進キーを流用、[V] で微調整)。選択中ノードがあるときのみ。実行後速度
    // (postState.v)を pro/nrm/rad → world で変更する(下流ノードは applyNodeDv が破棄)。
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

  // 計画パネルの内容を更新して表示する。nodes は時刻順のノード一覧(選択中のみ selected=true)、
  // selDv/selEl は選択中ノードの Δv 成分と噴射後の軌道要素(未選択なら null)。
  private renderPanel(
    nodes: { tRel: number; dvMag: number; selected: boolean; }[],
    selDv: Vec3 | null,
    selEl: Elements | null,
  ): void {
    const html = planPanelHtml(nodes, selDv, selEl);
    this.planPanel.style.display = 'block';
    if (this.planBody.innerHTML !== html) this.planBody.innerHTML = html;
  }

  // 計画パネルを隠す。パネル表示はマップ編集中のみで、書き手/隠し手は editor に一本化されている。
  hidePanel(): void {
    this.planPanel.style.display = 'none';
  }

  // 毎フレーム(sync 時)呼ぶ。マップ編集中はノードギズモを画面座標へ更新し、それ以外では
  // 後始末する。mapDist(ギズモの画面基準)は camera 側の状態で game が渡す。ノード位置の
  // 画面判定に使う B-2 は、このフレームぶんの駆動を PredictSystem.sync が先に済ませている。
  sync(mapDist: number): void {
    if (this.editMode) {
      this.updateGizmo(mapDist);
    }
    else {
      this.hideGizmo();
    }
  }

  // マップモードを閉じる ([M] で確定) ときの後始末: Δv がほぼゼロのまま放置されたノード
  // (クリックしただけで調整しなかった等)を破棄し、選択を解除する。Δv 導出に ephemeris が
  // 要るためここで行う。
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

// 計画パネルの定型 HTML(複数ノード対応)。近地点が大気圏内(<120km)なら警告を添える。
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

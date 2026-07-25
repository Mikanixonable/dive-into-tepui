import * as THREE from 'three/webgpu';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Input } from '../input/input';
import { ProjectFn } from '../camera/camera-system';
import { SimSpeedManager } from '../sim-speed-manager';
import { PlanEditor } from './plan-editor';
import { PredictSystem, DisplayFrameFn } from '../predict/predict-system';
import { MapCamera } from '../camera/map-camera';
import { MarkerManager } from '../marker/marker-manager';
import { MapMarkers } from '../camera/map-markers';
import type { Player } from '../player/player';
import type { Ephemeris } from '../../physics/ephemeris';
import { PlanGuide } from './plan-guide';
import { FloatingOrigin } from '../floating-origin';
import { OrbitState } from '../../physics/orbital';
import { arrivingStates } from '../../physics/predict';
import { len, sub } from '../../physics/vec3';
import * as C from '../const';

export class PlanSystem {
  readonly editor: PlanEditor;
  readonly predict: PredictSystem;
  readonly guide: PlanGuide;

  // 軌道計画の編集モード(WASDQE などの操作系をΔv編集へ振り替え、ノード編集入力を有効化する)。
  // cameraSystem.mapMode(広範囲視点)とは本来独立した責務で、たまたま MapModeToggler が
  // 同時にトグルしているだけ。挙動・入力側の判定はこのフラグ、描画・視点側は mapMode を見る。
  editMode = false;

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly markerManager: MarkerManager,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly project: ProjectFn,
    private readonly mapCamera: MapCamera,
    private readonly mapMarkers: MapMarkers,
    scene: THREE.Scene,
    private readonly getFineAttitude: () => boolean,
    private readonly ephemeris: Ephemeris,
  ) {
    this.guide = new PlanGuide(this._hud, this._sfx, this.markerManager, scene);
    this.editor = new PlanEditor(this._hud, this._sfx, this.simSpeedManager);
    this.predict = new PredictSystem(this.markerManager, scene);
    this.wireHudCallbacks();
    this.wireNodeGizmo();
  }

  // ノードハンドルを直接右クリックしたときの通知。実体は「その座標で右クリック消費を
  // 試み、消費できたらフォーカスメニューを閉じる」調停で、上位(game.ts)が受け持つ。
  onNodeHandleRightClick: ((clientX: number, clientY: number) => void) | null = null;

  private wireHudCallbacks(): void {
    this._hud.onDurationSelect = (key) => {
      if (key === 'orbit' || key === 'day' || key === 'week' || key === 'month') {
        this.predict.predictDurationKey = key;
        this.editor.plan.markDirty();
      }
    };
    this._hud.onFrameSelect = (frame) => {
      // 予測軌道の座標系固定(predict)とカメラ視点の回転追従(mapCamera)は別責務だが、
      // ユーザーからは一つの座標系選択なので、ここで両者へ同じ Frame を設定する。
      this.predict.frame = frame;
      this.mapCamera.cameraFrame = frame;
      this.editor.plan.markDirty();
    };
    this._hud.onMapFocusSelect = (focus) => {
      this.mapCamera.focus = focus;
      this.mapCamera.resetPan();
    };
    this._hud.onMapViewReset = () => {
      this.mapCamera.reset();
    };
    this._hud.onSliderChange = (t) => {
      this.predict.sliderT = t;
    };
  }

  // ノードギズモ(ハンドル・Δv アーム・ノードメニュー)のイベントを直接配線する。
  // どれもノード編集の責務なのでここで完結する(フォーカス選択は別責務で CameraSystem 側)。
  private wireNodeGizmo(): void {
    const g = this.editor.nodeGizmo;
    g.onNodeSelect = (idx) => {
      this.editor.selectedNodeIdx = idx;
      this.editor.closeMenu();
      this._sfx.warp();
    };
    g.onNodeDragMove = (idx, clientX, clientY) => {
      this.editor.closeMenu();
      this.editor.dragNodeToNearestSample(idx, clientX, clientY, this.frame(), this.project);
    };
    g.onNodeContextMenu = (clientX, clientY) => this.onNodeHandleRightClick?.(clientX, clientY);
    g.onAxisDrag = (axis, sign, deltaPx) => {
      this.editor.applyAxisDrag(axis, sign, deltaPx, this.getFineAttitude());
    };
    g.onMenuWarpTo = (idx) => {
      const n = this.editor.plan.nodes[idx];
      if (!n) return;
      this.simSpeedManager.startAutoWarpTo(n.time);
      this._hud.hint('指定時刻まで自動ワープ開始');
    };
    g.onMenuDelete = (idx) => {
      this.editor.deleteNode(idx);
    };
  }

  // 現在の外部状態から表示座標変換(太陽回転系対応)を組み立てる。ノードのピッキング/
  // 配置と表示の基準角がずれないよう、正は predict-system.ts の toDisplayFrame 一箇所。
  private frame(): DisplayFrameFn {
    return this.predict.bindDisplayFrame(this.ephemeris);
  }

  // マップ左クリック: 予測軌道上へノード配置、または既存ノード選択(plan-editor に委譲)。
  handleMapClick(clientX: number, clientY: number): void {
    this.editor.handleMapClick(clientX, clientY, this.frame(), this.project);
  }

  // マップ右クリック(ノード側): ノードに当たれば選択+メニューを開き true を返す。
  // 外れたら false を返し、呼び出し側がフォーカス選択へフォールバックする。
  handleNodeRightClick(clientX: number, clientY: number): boolean {
    return this.editor.handleNodeRightClick(clientX, clientY, this.frame(), this.project);
  }

  clearPlanByKey(editMode: boolean): void {
    this.editor.clearPlanByKey(editMode);
  }

  // 計画が空の間、予定 player の起点(アンカー)を現在の自機状態へ追従させる
  // (最初のノードを置くと凍結される)。game.ts が毎フレーム(プレイ中)呼ぶ。
  trackAnchor(player: Player, simTime: number): void {
    this.editor.plan.trackAnchor(simTime, player.state);
  }

  // マップモードを閉じるときの後始末。Δv がほぼゼロのまま放置されたノード(クリック
  // しただけで調整しなかった等)を破棄し、選択を解除する。Δv 導出に ephemeris が要る
  // ため editor ではなくここで行う。
  onMapClosed(): void {
    const plan = this.editor.plan;
    if (plan.nodes.length > 0) {
      const arriving = this.nodeArrivings();
      for (let i = plan.nodes.length - 1; i >= 0; i--) {
        const arr = arriving[i];
        if (arr && len(sub(plan.nodes[i]!.postState.v, arr.v)) < C.NODE_MIN_DV) plan.removeNode(i);
      }
    }
    this.editor.onMapClosed();
  }

  // 各ノードの到達(噴射前)状態。editor の Δv 表示・onMapClosed の空ノード判定に使う。
  // 予測計算に ephemeris が要るためここで導出して渡す(ノードは Δv を正データに持たない)。
  private nodeArrivings(): OrbitState[] {
    const plan = this.editor.plan;
    return arrivingStates(plan.anchor.state, plan.anchor.time, plan.nodes, this.ephemeris);
  }

  // --------------------------------------------------------------- per-frame

  // マップモードのノード編集入力(クリック配置・Δv調整・ツールバー/計画パネル反映)。
  // ツールバー表示は predictSystem/MapCamera 側の状態が要るため、ここで組み立てて渡す
  // (hud への反映自体は editor 側が行う)。
  updateEditing(dt: number, input: Input, player: Player, simTime: number): void {
    const orbitPeriod = player.elements?.period ?? null;
    this.editor.updateEditing(dt, simTime, input, this.nodeArrivings(), {
      fineAttitude: this.getFineAttitude(),
      toolbar: {
        durationKey: this.predict.predictDurationKey,
        frame: this.predict.frame,
        plannedPlayerLabel:
          this.predict.sliderT > 0
            ? this.predict.plannedPlayerLabel(this.editor.plan.trajSamples, orbitPeriod, simTime)
            : null,
        focus: this.mapCamera.focus,
      },
    });
  }

  // マップ表示中(mapMode)のみ意味を持つ: 予測軌道の再計算・折れ線/ゴースト描画・
  // ギズモ座標更新・フォーカスラベル描画。閉じている間は表示物の後始末のみ行う。
  // 予測の「計算+表示」は predictSystem、キャッシュは plan(隣接)、ギズモは editor と
  // 責務が分かれるので、ここは更新トリガと配線だけを担う。
  updateDisplay(mapMode: boolean, fo: FloatingOrigin, player: Player, ephemeris: Ephemeris, simTime: number): void {
    this.guide.syncPlannedLine(this.editor.plan, fo, mapMode);

    if (!mapMode) {
      this.predict.hide();
      this.editor.hideGizmo();
      return;
    }
    const plan = this.editor.plan;
    const orbitPeriod = player.elements?.period ?? null;
    const duration = this.predict.predictDurationSec(orbitPeriod);
    // 予測キャッシュの更新トリガ(スロットルは Plan、予測計算は predictSystem)。予測は
    // frozen アンカー + 凍結ノードだけの純関数で、player.live には依存しない。
    plan.maybeRefresh(() => this.predict.compute(plan.anchor, ephemeris, simTime, plan.nodes, duration));
    this.predict.syncDisplay(
      plan.trajSamples,
      plan.nodes.map((n) => n.time),
      orbitPeriod,
      ephemeris,
      simTime,
      fo,
      this.project,
    );
    this.editor.updateGizmo(this.frame(), this.project, this.mapCamera.dist, this.nodeArrivings());
    this.mapMarkers.syncLabels(simTime, ephemeris, duration, this.predict.sliderT, this.project);
  }

  mapLabelIds(): string[] {
    return this.mapMarkers.labels.map((l) => l.id);
  }
}

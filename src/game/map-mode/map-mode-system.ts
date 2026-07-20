// マップモード(軌道計画モード)folder の唯一の外部窓口。
// MapPlanner(ノード計画・軌道予測キャッシュ・噴射ガイド)/ MapView(マップカメラ・
// フォーカス・スライダー)/ TrajectoryOverlay(予測軌道の描画)/ MapModeController
// (有効フラグと開閉時の後始末)を private に保持し、外部(game.ts / camera-system.ts /
// orbit-line-system.ts)はこのクラスのメソッドのみを呼ぶ — 4クラスへ個別に触れさせない。
//
// PlannerCtx が要求する「現在状態」は getExternalState() で毎回引ける(Game 側の
// simTime/player 状態は非同期な DOM イベント(ギズモドラッグ等)からも参照する必要が
// あるため、コンストラクタ注入のコールバックとして持つ)。project も同様の理由で
// コンストラクタ注入(カメラ依存のクロージャ)。
import * as THREE from 'three/webgpu';
import { Elements, elementsFromState } from '../../physics/orbital';
import { sunAzimuth } from '../../physics/ephemeris';
import { sampleAt } from '../../physics/predict';
import { Vec3 } from '../../physics/vec3';
import * as C from '../const';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Input, MouseDelta } from '../input';
import { TouchControls } from '../touch';
import { ProjectFn } from '../camera/projection';
import { MapPlanner, PlannerCtx } from './planner';
import { MapView } from './mapview';
import { TrajectoryOverlay } from './traj-overlay';
import { MapModeController } from './mapmode-controller';

export interface MapModeExternalState {
  simTime: number;
  playerR: Vec3;
  playerV: Vec3;
  sunPhase0: number;
  moonPhase0: number;
}

export class MapModeSystem {
  private readonly planner: MapPlanner;
  private readonly mapView: MapView;
  private readonly trajOverlay: TrajectoryOverlay;
  private readonly mapModeController: MapModeController;
  private autoWarpUntil: number | null = null;
  private warpIdx: number = 0;

  constructor(
    private readonly hud: Hud,
    private readonly sfx: Sfx,
    private readonly project: ProjectFn,
    private readonly getFineAttitude: () => boolean,
    private readonly getExternalState: () => MapModeExternalState,
  ) {
    this.planner = new MapPlanner(hud, sfx);
    this.mapView = new MapView(hud);
    this.trajOverlay = new TrajectoryOverlay(hud.markers, this.planner);
    this.mapModeController = new MapModeController(hud, this.planner);
    this.wireHudCallbacks();
    this.wireGizmoCallbacks();
  }

  private wireHudCallbacks(): void {
    this.hud.onDurationSelect = (key) => {
      if (key === 'orbit' || key === 'day' || key === 'week' || key === 'month') {
        this.planner.predictDurationKey = key;
        this.planner.trajDirty = true;
      }
    };
    this.hud.onFrameToggle = () => {
      this.mapView.frameRotating = !this.mapView.frameRotating;
      this.planner.trajDirty = true;
    };
    this.hud.onMapFocusSelect = (focus) => {
      this.mapView.focus = focus;
      this.mapView.pan.set(0, 0, 0);
    };
    this.hud.onMapViewReset = () => this.mapView.reset();
    this.hud.onSliderChange = (t) => {
      this.mapView.sliderT = t;
    };
  }

  private wireGizmoCallbacks(): void {
    this.planner.bindGizmoCallbacks({
      onNodeSelect: (idx) => {
        this.planner.selectedNodeIdx = idx;
        this.planner.closeMenu();
        this.sfx.warp();
      },
      onNodeDragMove: (idx, clientX, clientY) => {
        this.planner.closeMenu();
        this.planner.dragNodeToNearestSample(idx, clientX, clientY, this.plannerCtx(), this.project);
      },
      onNodeContextMenu: (clientX, clientY) => {
        this.planner.handleMapRightClick(clientX, clientY, this.plannerCtx(), this.project, this.mapView.labels);
      },
      onAxisDrag: (axis, sign, deltaPx) => {
        this.planner.applyAxisDrag(axis, sign, deltaPx, this.getFineAttitude());
      },
      onMenuWarpTo: (idx) => {
        const n = this.planner.planNodes[idx];
        if (!n) return;
        this.autoWarpUntil = n.time;
        this.hud.hint('指定時刻まで自動ワープ開始');
      },
      onMenuDelete: (idx) => {
        if (!this.planner.planNodes[idx]) return;
        this.planner.planNodes.splice(idx, 1);
        if (this.planner.selectedNodeIdx === idx) this.planner.selectedNodeIdx = null;
        else if (this.planner.selectedNodeIdx !== null && this.planner.selectedNodeIdx > idx) this.planner.selectedNodeIdx--;
        this.planner.clearActiveTarget();
        this.planner.trajDirty = true;
        this.hud.hint('ノードを削除');
      },
      onMenuFocus: (targetKey) => {
        this.mapView.focus = targetKey;
        const lbl = this.mapView.labels.find((l) => l.id === targetKey);
        if (lbl) this.hud.hint(`${lbl.name} にフォーカス`);
      },
    });
  }

  private plannerCtx(): PlannerCtx {
    return {
      ...this.getExternalState(),
      mapMode: this.mapMode,
      mapFrameRotating: this.mapView.frameRotating,
    };
  }

  private clearAutoWarp(): void {
    this.autoWarpUntil = null;
  }

  // --------------------------------------------------------------- lifecycle

  get mapMode(): boolean {
    return this.mapModeController.enabled;
  }

  toggleMap(phase: string, touchControls: TouchControls | null): void {
    this.mapModeController.toggle(phase, touchControls);
  }

  syncMapModeWithPhase(phase: string, touchControls: TouchControls | null): void {
    this.mapModeController.syncWithPhase(phase, touchControls);
  }

  clearPlanByKey(): void {
    if (this.mapMode) {
      if (this.planner.selectedNodeIdx === null) return;
      this.planner.planNodes.splice(this.planner.selectedNodeIdx, 1);
      this.planner.selectedNodeIdx = null;
      this.planner.clearActiveTarget();
      this.planner.trajDirty = true;
      this.clearAutoWarp();
      this.hud.hint('ノードを削除');
      return;
    }
    if (this.planner.planNodes.length <= 0) return;
    this.planner.planNodes = [];
    this.planner.selectedNodeIdx = null;
    this.planner.clearActiveTarget();
    this.planner.trajDirty = true;
    this.clearAutoWarp();
    this.hud.hint('マニューバ計画を破棄');
  }

  // ------------------------------------------------------------------ warp

  warp(): number {
    return C.WARP_LEVELS[this.warpIdx]!;
  }

  shiftWarp(step: number): void {
    this.clearAutoWarp();
    const next = this.warpIdx + step;
    if (next < 0 || next >= C.WARP_LEVELS.length) return;
    this.warpIdx = next;
    this.sfx.warp();
    this.hud.hint(`TIME WARP ×${this.warp()!}`);
  }

  updateAutoWarp(): void {
    if (this.autoWarpUntil === null) return;
    const tRem = this.autoWarpUntil - this.getExternalState().simTime;
    if (tRem <= C.AUTOWARP_STOP) {
      this.autoWarpUntil = null;    
      this.hud.hint('マニューバ実行点に接近 — BURN ガイドの方向へ加速せよ', 5000);
      this.warpIdx = 0;
    }
    let idx = 0;
    for (let i = 0; i < C.WARP_LEVELS.length; i++) {
      if (C.WARP_LEVELS[i]! <= tRem / C.AUTOWARP_MARGIN) idx = i;
    }
    this.warpIdx = idx;
  }

  toggleAutoWarpToFirstNode(phase: string): void {
    if (this.mapMode) return;
    if (this.planner.planNodes.length <= 0 || phase !== 'playing') {
      this.hud.hint('マニューバノードがありません ([M] で計画)');
      return;
    }
    this.autoWarpUntil = this.autoWarpUntil !== null ? null : this.planner.firstNode()!.time;
    this.hud.hint(this.autoWarpUntil !== null ? 'ノードへ自動ワープ開始' : '自動ワープ解除');
  }

  // ---------------------------------------------------------------- camera

  get mapCamera(): THREE.PerspectiveCamera {
    return this.mapView.camera;
  }

  get mapCameraFar(): number {
    return this.mapView.camera.far;
  }

  updateCamera(mouse: MouseDelta, keyYaw: number, keyPitch: number, dt: number): void {
    const s = this.getExternalState();
    const sunAz = sunAzimuth(s.simTime, s.sunPhase0);
    this.mapView.updateCamera(mouse, keyYaw, keyPitch, dt, s.playerR, sunAz);
  }

  // --------------------------------------------------------------- per-frame

  // マップモードのノード編集入力(クリック配置・Δv調整・ツールバー/計画パネル反映)。
  updateEditing(dt: number, input: Input): void {
    this.planner.updateEditing(dt, this.plannerCtx(), input, this.project, {
      fineAttitude: this.getFineAttitude(),
      mapSliderT: this.mapView.sliderT,
      mapFocus: this.mapView.focus,
      labels: this.mapView.labels,
    });
  }

  // 予測軌道の再計算・折れ線/ゴースト描画・ギズモ座標更新・フォーカスラベル描画。
  // 戻り値の plannedEl は戦闘ビューの計画軌道ラインの描画に使う。
  updateDisplay(): { plannedEl: Elements | null } {
    const ctx = this.plannerCtx();
    const origin = ctx.playerR;
    this.planner.maybeRefresh(ctx);
    this.trajOverlay.updateForMapMode(
      this.mapMode,
      origin,
      ctx,
      ctx.simTime,
      this.mapView.sliderT,
      this.project,
      (simTime, duration) => this.mapView.displayTime(simTime, duration),
    );
    this.planner.updateMapGizmo(origin, ctx, this.project, this.mapMode, this.mapView.dist);
    if (this.mapMode) {
      this.mapView.drawLabels(
        origin,
        {
          simTime: ctx.simTime,
          sunPhase0: ctx.sunPhase0,
          moonPhase0: ctx.moonPhase0,
          duration: this.planner.predictDurationSec(ctx),
        },
        this.project,
      );
    }

    let plannedEl: Elements | null = null;
    if (!this.mapMode && this.planner.planNodes.length > 0) {
      const sample = sampleAt(this.planner.trajSamples, this.planner.planNodes[0]!.time);
      if (sample) plannedEl = elementsFromState(sample.r, sample.v);
    }
    return { plannedEl };
  }

  // 噴射ガイドの達成判定と表示(戦闘ビューのみ、mapMode 中は呼ばない)。
  updateGuide(playerEl: Elements | null, playerAlive: boolean): void {
    const ctx = this.plannerCtx();
    const { achieved } = this.planner.updateGuide(ctx, ctx.playerR, ctx.playerV, playerEl, playerAlive, this.project);
    if (achieved) this.clearAutoWarp();
  }

  resolveDisplayTime(): number {
    const ctx = this.plannerCtx();
    if (!this.mapMode || this.mapView.sliderT <= 0) return ctx.simTime;
    return this.mapView.displayTime(ctx.simTime, this.planner.predictDurationSec(ctx));
  }

  mapLabelIds(): string[] {
    return this.mapView.labels.map((l) => l.id);
  }

  get trajLineGroup(): THREE.Object3D {
    return this.trajOverlay.line.group;
  }
}

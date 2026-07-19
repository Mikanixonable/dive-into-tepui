import { Vec3 } from '../physics/vec3';
import * as C from './const';
import { Hud } from '../hud/hud';
import { Sfx } from './audio';
import { MapPlanner, PlannerCtx, ProjectFn } from './planner';
import { MapView } from './mapview';
import { MapModeController } from './map-mode';
import { TrajectoryOverlay } from './traj-overlay';
import { TouchControls } from './touch';

export class ManeuverSystem {
  readonly planner: MapPlanner;
  readonly mapView: MapView;
  readonly trajOverlay: TrajectoryOverlay;
  readonly mapModeController: MapModeController;

  private autoWarpUntil: number | null = null;

  constructor(
    private readonly hud: Hud,
    private readonly sfx: Sfx,
    private readonly project: ProjectFn,
    private readonly getFineAttitude: () => boolean,
  ) {
    this.planner = new MapPlanner(hud, sfx);
    this.mapView = new MapView(hud);
    this.trajOverlay = new TrajectoryOverlay(hud, this.planner);
    this.mapModeController = new MapModeController(hud, this.planner);
  }

  bindCallbacks(getPlannerCtx: () => PlannerCtx): void {
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

    this.planner.mapGizmo.onNodeSelect = (idx) => {
      this.planner.selectedNodeIdx = idx;
      this.planner.mapGizmo.closeMenu();
      this.sfx.warp();
    };
    this.planner.mapGizmo.onNodeDragMove = (idx, clientX, clientY) => {
      this.planner.mapGizmo.closeMenu();
      this.planner.dragNodeToNearestSample(idx, clientX, clientY, getPlannerCtx(), this.project);
    };
    this.planner.mapGizmo.onNodeContextMenu = (clientX, clientY) => {
      this.planner.handleMapRightClick(clientX, clientY, getPlannerCtx(), this.project, this.mapView.labels);
    };
    this.planner.mapGizmo.onAxisDrag = (axis, sign, deltaPx) => {
      this.planner.applyAxisDrag(axis, sign, deltaPx, this.getFineAttitude());
    };
    this.planner.mapGizmo.onMenuWarpTo = (idx) => {
      const n = this.planner.planNodes[idx];
      if (!n) return;
      this.autoWarpUntil = n.time;
      this.hud.hint('指定時刻まで自動ワープ開始');
    };
    this.planner.mapGizmo.onMenuDelete = (idx) => {
      if (!this.planner.planNodes[idx]) return;
      this.planner.planNodes.splice(idx, 1);
      if (this.planner.selectedNodeIdx === idx) this.planner.selectedNodeIdx = null;
      else if (this.planner.selectedNodeIdx !== null && this.planner.selectedNodeIdx > idx) this.planner.selectedNodeIdx--;
      this.planner.clearActiveTarget();
      this.planner.trajDirty = true;
      this.hud.hint('ノードを削除');
    };
    this.planner.mapGizmo.onMenuFocus = (targetKey) => {
      this.mapView.focus = targetKey;
      const lbl = this.mapView.labels.find(l => l.id === targetKey);
      if (lbl) this.hud.hint(`${lbl.name} にフォーカス`);
    };
  }

  get mapMode(): boolean {
    return this.mapModeController.enabled;
  }

  toggleMap(phase: string, touchControls: TouchControls | null): void {
    this.mapModeController.toggle(phase, touchControls);
  }

  syncMapModeWithPhase(phase: string, touchControls: TouchControls | null): void {
    this.mapModeController.syncWithPhase(phase, touchControls);
  }

  clearAutoWarp(): void {
    this.autoWarpUntil = null;
  }

  adjustWarp(currentWarpIdx: number, step: number): number {
    this.clearAutoWarp();
    const next = currentWarpIdx + step;
    if (next < 0 || next >= C.WARP_LEVELS.length) return currentWarpIdx;
    this.sfx.warp();
    this.hud.hint(`TIME WARP ×${C.WARP_LEVELS[next]!}`);
    return next;
  }

  updateAutoWarp(simTime: number, warpIdx: number): { warpIdx: number; hint: string | null } {
    if (this.autoWarpUntil === null) return { warpIdx, hint: null };
    const tRem = this.autoWarpUntil - simTime;
    if (tRem <= C.AUTOWARP_STOP) {
      this.autoWarpUntil = null;
      return { warpIdx: 0, hint: 'マニューバ実行点に接近 — BURN ガイドの方向へ加速せよ' };
    }
    let idx = 0;
    for (let i = 0; i < C.WARP_LEVELS.length; i++) {
      if (C.WARP_LEVELS[i]! <= tRem / C.AUTOWARP_MARGIN) idx = i;
    }
    return { warpIdx: idx, hint: null };
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

  onGuideAchieved(): void {
    this.clearAutoWarp();
  }

  plannerCtx(
    simTime: number,
    playerR: Vec3,
    playerV: Vec3,
    sunPhase0: number,
    moonPhase0: number,
  ): PlannerCtx {
    return {
      simTime,
      playerR,
      playerV,
      sunPhase0,
      moonPhase0,
      mapMode: this.mapMode,
      mapFrameRotating: this.mapView.frameRotating,
    };
  }
}

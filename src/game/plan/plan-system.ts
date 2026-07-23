import * as THREE from 'three/webgpu';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Input } from '../input';
import { ProjectFn } from '../camera/camera-system';
import { SimSpeedManager } from '../sim-speed-manager';
import { PlanEditor } from './plan-editor';
import { PlanDisplay } from './plan-display';
import { MapCamera } from '../camera/map-camera';
import { MarkerManager } from '../marker/marker-manager';
import { MapMarkers } from '../map-mode/map-markers';
import type { Player } from '../player/player';
import type { EphemerisSystem } from '../ephemeris';
import { PlanGuide } from './plan-guide';

export class PlanSystem {
  readonly editor: PlanEditor;
  readonly display: PlanDisplay;
  readonly guide: PlanGuide;
  // editMode: boolean = false; cameraSystem の mapMode フラグの意味の一部をこっちに移動したい。

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
    private readonly getExternalState: () => { player: Player; ephemeris: EphemerisSystem; simTime: number; },
  ) {
    this.guide = new PlanGuide(this._hud, this._sfx, this.markerManager, scene);
    this.editor = new PlanEditor(this._hud, this._sfx, this.simSpeedManager);
    this.display = new PlanDisplay(this.markerManager, scene);
    this.wireHudCallbacks();
    this.wireGizmoCallbacks();
  }

  private wireHudCallbacks(): void {
    this._hud.onDurationSelect = (key) => {
      if (key === 'orbit' || key === 'day' || key === 'week' || key === 'month') {
        this.display.predictDurationKey = key;
        this.editor.plan.markDirty();
      }
    };
    this._hud.onFrameToggle = () => {
      this.mapCamera.frameRotating = !this.mapCamera.frameRotating;
      this.editor.plan.markDirty();
    };
    this._hud.onMapFocusSelect = (focus) => {
      this.mapCamera.focus = focus;
      this.mapCamera.pan.set(0, 0, 0);
    };
    this._hud.onMapViewReset = () => {
      this.mapCamera.reset();
    };
    this._hud.onSliderChange = (t) => {
      this.display.sliderT = t;
    };
  }

  private wireGizmoCallbacks(): void {
    this.editor.bindGizmoCallbacks({
      onNodeSelect: (idx) => {
        this.editor.selectedNodeIdx = idx;
        this.editor.closeMenu();
        this._sfx.warp();
      },
      onNodeDragMove: (idx, clientX, clientY) => {
        this.editor.closeMenu();
        const state = this.getExternalState();
        this.editor.dragNodeToNearestSample(
          idx, clientX, clientY, state.player.state.r,
          this.display.bindDisplayFrame(state.ephemeris, this.mapCamera.frameRotating), this.project);
      },
      onNodeContextMenu: (clientX, clientY) => {
        const state = this.getExternalState();
        this.editor.handleMapRightClick(
          clientX, clientY, state.player.state.r,
          this.display.bindDisplayFrame(state.ephemeris, this.mapCamera.frameRotating), this.project, this.mapMarkers.labels);
      },
      onAxisDrag: (axis, sign, deltaPx) => {
        this.editor.applyAxisDrag(axis, sign, deltaPx, this.getFineAttitude());
      },
      onMenuWarpTo: (idx) => {
        const n = this.editor.plan.nodes[idx];
        if (!n) return;
        this.simSpeedManager.startAutoWarpTo(n.time);
        this._hud.hint('指定時刻まで自動ワープ開始');
      },
      onMenuDelete: (idx) => {
        this.editor.deleteNode(idx);
      },
      onMenuFocus: (targetKey) => {
        this.mapCamera.focus = targetKey;
        const lbl = this.mapMarkers.findLabel(targetKey);
        if (lbl) this._hud.hint(`${lbl.name} にフォーカス`);
      },
    });
  }

  clearPlanByKey(mapMode: boolean): void {
    this.editor.clearPlanByKey(mapMode);
    this.guide.clearActiveTarget();
  }

  // --------------------------------------------------------------- per-frame

  // マップモードのノード編集入力(クリック配置・Δv調整・ツールバー/計画パネル反映)。
  // ツールバー表示は PlanDisplay/MapCamera 側の状態が要るため、ここで組み立てて渡す
  // (hud への反映自体は editor 側が行う)。
  updateEditing(dt: number, input: Input, player: Player, ephemeris: EphemerisSystem, simTime: number): void {
    this.editor.updateEditing(dt, simTime, player.state.r, this.display.bindDisplayFrame(ephemeris, this.mapCamera.frameRotating), input, this.project, {
      fineAttitude: this.getFineAttitude(),
      labels: this.mapMarkers.labels,
      toolbar: {
        durationKey: this.display.predictDurationKey,
        frameRotating: this.mapCamera.frameRotating,
        ghostLabel: this.display.sliderT > 0 ? this.display.ghostLabel(this.editor.plan, player, simTime) : null,
        focus: this.mapCamera.focus,
      },
    });
  }

  // マップ表示中(mapMode)のみ意味を持つ: 予測軌道の再計算・折れ線/ゴースト描画・
  // ギズモ座標更新・フォーカスラベル描画。閉じている間は表示物の後始末のみ行う。
  updateDisplay(mapMode: boolean, player: Player, ephemeris: EphemerisSystem, simTime: number): void {
    const origin = player.state.r;
    
    this.guide.updatePlannedLine(this.editor.plan, { player: player, ephemeris: ephemeris, simTime: simTime }, origin, mapMode);

    if (!mapMode) {
      this.display.hide();
      this.editor.hideGizmo();
      return;
    }
    this.display.update(this.editor.plan, {player, ephemeris, simTime}, origin, this.mapCamera.frameRotating, this.project);
    this.editor.updateGizmo(origin, this.display.bindDisplayFrame(ephemeris, this.mapCamera.frameRotating), this.project, this.mapCamera.dist);
    this.mapMarkers.updateLabels(
      origin,
      simTime,
      ephemeris,
      this.display.predictDurationSec(player),
      this.display.sliderT,
      this.project,
    );
  }

  mapLabelIds(): string[] {
    return this.mapMarkers.labels.map((l) => l.id);
  }
}

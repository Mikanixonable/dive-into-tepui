import * as THREE from 'three/webgpu';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Input } from '../input/input';
import { ProjectFn } from '../camera/camera-system';
import { SimSpeedManager } from '../sim-speed-manager';
import { PlanEditor } from './plan-editor';
import { PlanDisplay } from './plan-display';
import { MapCamera } from '../camera/map-camera';
import { MarkerManager } from '../marker/marker-manager';
import { MapMarkers } from '../camera/map-markers';
import { DisplayFrameFn } from './plan-display';
import type { Player } from '../player/player';
import type { EphemerisSystem } from '../ephemeris';
import { PlanGuide } from './plan-guide';
import { FloatingOrigin } from '../floating-origin';

export class PlanSystem {
  readonly editor: PlanEditor;
  readonly display: PlanDisplay;
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
    private readonly getEphemeris: () => EphemerisSystem,
  ) {
    this.guide = new PlanGuide(this._hud, this._sfx, this.markerManager, scene);
    this.editor = new PlanEditor(this._hud, this._sfx, this.simSpeedManager);
    this.display = new PlanDisplay(this.markerManager, scene);
    this.wireHudCallbacks();
    this.wireNodeGizmo();
  }

  // ノードハンドルを直接右クリックしたときの通知。実体は「その座標で右クリック消費を
  // 試み、消費できたらフォーカスメニューを閉じる」調停で、上位(game.ts)が受け持つ。
  onNodeHandleRightClick: ((clientX: number, clientY: number) => void) | null = null;

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
      this.mapCamera.resetPan();
    };
    this._hud.onMapViewReset = () => {
      this.mapCamera.reset();
    };
    this._hud.onSliderChange = (t) => {
      this.display.sliderT = t;
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
  // 配置と表示の基準角がずれないよう、正は plan-display.ts の toDisplayFrame 一箇所。
  private frame(): DisplayFrameFn {
    return this.display.bindDisplayFrame(this.getEphemeris(), this.mapCamera.frameRotating);
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
    this.guide.clearActiveTarget();
  }

  // --------------------------------------------------------------- per-frame

  // マップモードのノード編集入力(クリック配置・Δv調整・ツールバー/計画パネル反映)。
  // ツールバー表示は PlanDisplay/MapCamera 側の状態が要るため、ここで組み立てて渡す
  // (hud への反映自体は editor 側が行う)。
  updateEditing(dt: number, input: Input, player: Player, simTime: number): void {
    this.editor.updateEditing(dt, simTime, input, {
      fineAttitude: this.getFineAttitude(),
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
  updateDisplay(mapMode: boolean, fo: FloatingOrigin, player: Player, ephemeris: EphemerisSystem, simTime: number): void {
    this.guide.syncPlannedLine(this.editor.plan, { player: player, ephemeris: ephemeris, simTime: simTime }, fo, mapMode);

    if (!mapMode) {
      this.display.hide();
      this.editor.hideGizmo();
      return;
    }
    this.display.sync(this.editor.plan, player, ephemeris, simTime, fo, this.mapCamera.frameRotating, this.project);
    this.editor.updateGizmo(this.display.bindDisplayFrame(ephemeris, this.mapCamera.frameRotating), this.project, this.mapCamera.dist);
    this.mapMarkers.syncLabels(
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

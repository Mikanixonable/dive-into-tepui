// マップモード(軌道計画モード)folder の唯一の外部窓口 — game.ts はこのクラスの
// メソッドのみを呼び、PlanEditor/PlanDisplay/MapMarkers には直接触れない。
// 軌道計画そのもの(Plan)はマップモードの開閉と無関係に存在し続けるデータだが、
// 編集・保持ともここが唯一の場所であるため、editor 経由で Plan インスタンスを直接
// 所有する(plan-guide.ts での実施は Game が `mapModeSystem.editor.plan` 経由で読む)。
// PlanEditor(マップ上でのノード編集)・PlanDisplay(予測軌道・ゴースト表示)を
// それぞれ readonly で公開する(薄いラッパーを増やさず、Game が必要なメソッドを
// 直接呼ぶ)。MapMarkers(フォーカス候補ラベルの算出・描画)は MapCamera も
// フォーカス解決に必要とするため game.ts が構築し、両方へ注入される共有インスタンス。
// MapCamera(マップカメラ・視点操作)は camera-system.ts の CameraSystem が所有し、
// このクラスはコンストラクタで参照を受け取るだけ(駆動は CameraSystem.updateActiveCamera
// が直接呼ぶ)。frameRotating/pan/dist は軌道計画編集(toDisplayFrame・ツールバー・
// ギズモ)がカメラの視点状態を読むための実質的な依存で、単なる薄い転送ではない。
// フォーカス対象(focus: どのラベルを注視するかの文字列 ID)とその解決(ラベル位置→
// フローティングオリジン相対位置)は MapCamera 自身が持つ(MapMarkers を注入されて
// 自力で解決する) — ここでは UI イベント(ツールバー・右クリメニュー)を
// mapCamera.focus への代入へ橋渡しするだけ。
//
// Plan/PlanDisplay/PlanGuide が要求する「現在状態」は getExternalState() で毎回引ける。
// Game 側の simTime/player 状態は非同期な DOM イベント(ギズモドラッグ等)からも参照する
// 必要があるため、コンストラクタ注入のコールバックとして持つ。project も同様の理由で
// コンストラクタ注入(カメラ依存のクロージャ)。
import * as THREE from 'three/webgpu';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Input } from '../input';
import { ProjectFn } from '../camera/camera-system';
import { SimSpeedManager } from '../sim-speed-manager';
import { PlanEditor } from '../plan/plan-editor';
import { PlanDisplay } from '../plan/plan-display';
import { MapCamera } from '../camera/map-camera';
import { MarkerManager } from '../marker/marker-manager';
import { MapMarkers } from './map-markers';
import type { Player } from '../player/player';
import type { EphemerisSystem } from '../ephemeris';

export class MapModeSystem {
  readonly editor: PlanEditor;
  readonly display: PlanDisplay;

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
    onPlanCleared: () => void,
  ) {
    this.editor = new PlanEditor(this._hud, this._sfx, this.simSpeedManager, onPlanCleared);
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
    if (!mapMode) {
      this.display.hide();
      this.editor.hideGizmo();
      return;
    }
    const origin = player.state.r;
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

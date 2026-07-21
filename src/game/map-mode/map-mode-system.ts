// マップモード(軌道計画モード)folder の唯一の外部窓口 — game.ts はこのクラスの
// メソッドのみを呼び、PlanEditor/PlanDisplay/MapHud には直接触れない。
// 軌道計画そのもの(Plan / plan-guide.ts の実施)はマップモードと無関係なデータ・
// ロジックとして game/plan/ に独立して存在し、Game がここへ Plan を注入する。
// PlanEditor(マップ上でのノード編集)・PlanDisplay(予測軌道・ゴースト表示)・
// MapHud(フォーカス対象ラベルの算出・描画)を private に保持する。
// MapCamera(マップカメラ・視点操作)は camera-system.ts の CameraSystem が所有し、
// このクラスはコンストラクタで参照を受け取るだけ(駆動は CameraSystem.updateActiveCamera
// が直接呼ぶ)。frameRotating/pan/dist/sliderT は軌道計画編集(toDisplayFrame・
// ツールバー・ギズモ)がカメラの視点状態を読むための実質的な依存で、単なる薄い転送ではない。
// フォーカス対象(focus: どのラベルを注視するかの文字列 ID)はこのクラスが持つ —
// focus を変更する UI 操作(ツールバー・右クリメニュー)はすべてここに集まるため、
// focus とその解決(focusRel: ラベル位置→フローティングオリジン相対位置)は同じ場所に
// あるべきで、MapCamera へは解決済みの Vec3 だけを渡す。
// シミュレーション速度そのものの管理は SimSpeedManager が別途持ち、ここではノード
// 実行時刻への自動ワープの起点(startAutoWarpTo/cancelAutoWarp の呼び出しどころ)
// としてのみ参照する。
//
// Plan/PlanDisplay/PlanGuide が要求する「現在状態」は getExternalState() で毎回引ける。
// Game 側の simTime/player 状態は非同期な DOM イベント(ギズモドラッグ等)からも参照する
// 必要があるため、コンストラクタ注入のコールバックとして持つ。project も同様の理由で
// コンストラクタ注入(カメラ依存のクロージャ)。
import * as THREE from 'three/webgpu';
import { Vec3, sub, v3 } from '../../physics/vec3';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Input } from '../input';
import { TouchControls } from '../touch';
import { ProjectFn } from '../camera/projection';
import { SimSpeedManager } from '../sim-speed-manager';
import { Plan } from '../plan/plan';
import { PlanEditor } from '../plan/plan-editor';
import { DisplayFrameFn, PlanDisplay } from '../plan/plan-display';
import { MapCamera } from '../camera/map-camera';
import { MapHud } from './map-hud';
import type { Player } from '../player/player';
import type { EphemerisSystem } from '../ephemeris';

export class MapModeSystem {
  private readonly editor: PlanEditor;
  private readonly display: PlanDisplay;
  private readonly mapHud: MapHud;
  private focus: string = 'earth';

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly plan: Plan,
    private readonly project: ProjectFn,
    private readonly mapCamera: MapCamera,
    private readonly getFineAttitude: () => boolean,
    private readonly getExternalState: () => { player: Player; ephemeris: EphemerisSystem; simTime: number },
  ) {
    this.editor = new PlanEditor(this._hud, this._sfx);
    this.display = new PlanDisplay(this._hud.markers);
    this.mapHud = new MapHud(this._hud, this._sfx);
    this.wireHudCallbacks();
    this.wireGizmoCallbacks();
  }

  private wireHudCallbacks(): void {
    this._hud.onDurationSelect = (key) => {
      if (key === 'orbit' || key === 'day' || key === 'week' || key === 'month') {
        this.display.predictDurationKey = key;
        this.plan.markDirty();
      }
    };
    this._hud.onFrameToggle = () => {
      this.mapCamera.frameRotating = !this.mapCamera.frameRotating;
      this.plan.markDirty();
    };
    this._hud.onMapFocusSelect = (focus) => {
      this.focus = focus;
      this.mapCamera.pan.set(0, 0, 0);
    };
    this._hud.onMapViewReset = () => {
      this.focus = 'earth';
      this.mapCamera.reset();
    };
    this._hud.onSliderChange = (t) => {
      this.mapCamera.sliderT = t;
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
        this.editor.dragNodeToNearestSample(this.plan, idx, clientX, clientY, state.player.state.r, this.toDisplayFrame(state.ephemeris), this.project);
      },
      onNodeContextMenu: (clientX, clientY) => {
        const state = this.getExternalState();
        this.editor.handleMapRightClick(this.plan, clientX, clientY, state.player.state.r, this.toDisplayFrame(state.ephemeris), this.project, this.mapHud.labels);
      },
      onAxisDrag: (axis, sign, deltaPx) => {
        this.editor.applyAxisDrag(this.plan, axis, sign, deltaPx, this.getFineAttitude());
      },
      onMenuWarpTo: (idx) => {
        const n = this.plan.nodes[idx];
        if (!n) return;
        this.simSpeedManager.startAutoWarpTo(n.time);
        this._hud.hint('指定時刻まで自動ワープ開始');
      },
      onMenuDelete: (idx) => {
        this.editor.deleteNode(this.plan, idx);
        this.notifyNodeDeleted();
      },
      onMenuFocus: (targetKey) => {
        this.focus = targetKey;
        const lbl = this.mapHud.findLabel(targetKey);
        if (lbl) this._hud.hint(`${lbl.name} にフォーカス`);
      },
    });
  }

  // 太陽回転系表示込みの座標変換を、その正である PlanDisplay へ束縛して渡す。
  // plan-editor.ts のクリック判定・ドラッグ・ギズモ配置は必ずこの1つの変換を通す
  // ことで、描画(plan-display.ts)とずれないようにする。
  private toDisplayFrame(ephemeris: EphemerisSystem): DisplayFrameFn {
    const rotating = this.mapCamera.frameRotating;
    return (r: Vec3, t: number) => this.display.toDisplayFrame(r, t, ephemeris, rotating);
  }

  // --------------------------------------------------------------- lifecycle

  toggleMap(phase: string, touchControls: TouchControls | null, mapMode: boolean): boolean {
    if (phase !== 'playing') return mapMode;
    if (!mapMode) {
      this.editor.selectedNodeIdx = null;
      // マップの表示用予測期間は戦闘ビューの噴射ガイド用期間と異なるため、
      // 開いた直後は必ず作り直す(スロットリングで最大2秒待たされるのを避ける)。
      this.plan.markDirty();
      this._hud.setMapToolbarVisible(true);
      touchControls?.setMapMode(true);
      this._hud.hint(
        '軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [M] で確定',
        5000,
      );
      return true;
    }
    this.editor.onMapClosed(this.plan);
    this._hud.setMapToolbarVisible(false);
    this._hud.setPlanPanel(null);
    this.editor.closeMenu();
    touchControls?.setMapMode(false);
    if (this.plan.nodes.length > 0) {
      this._hud.hint(`マニューバ計画 ${this.plan.nodes.length} 件確定 — [N] で直近ノードへ自動ワープ`, 4500);
    }
    return false;
  }

  syncMapModeWithPhase(phase: string, touchControls: TouchControls | null, mapMode: boolean): boolean {
    if (phase !== 'playing' && mapMode) {
      this._hud.setPlanPanel(null);
      this._hud.setMapToolbarVisible(false);
      this.editor.closeMenu();
      touchControls?.setMapMode(false);
      return false;
    }
    return mapMode;
  }

  // [X] キー(マップモード中のみ): 選択中ノードを削除する(どのノードかの解決は
  // selectedNodeIdx を持つ PlanEditor 自身の責務)。マップ外での計画全破棄は
  // Plan を直接持つ Game 側の責務(game.ts の handleEdgePress 参照 — マップモードと
  // 無関係な操作のため、ここには置かない)。
  deleteSelectedNode(): void {
    if (!this.editor.deleteSelected(this.plan)) return;
    this.notifyNodeDeleted();
  }

  // ノード削除後の副作用(右クリメニュー・[X] キーの両方で共通)。
  private notifyNodeDeleted(): void {
    this.simSpeedManager.cancelAutoWarp();
    this._hud.hint('ノードを削除');
  }

  // [N] キー: 直近ノードの実行時刻までの自動ワープをトグルする(実際の速度管理は
  // SimSpeedManager が持つ — ここではノードの有無/時刻の解決だけを担う)。
  toggleAutoWarpToFirstNode(phase: string, mapMode: boolean): void {
    if (mapMode) return;
    const first = this.plan.firstNode();
    if (!first || phase !== 'playing') {
      this._hud.hint('マニューバノードがありません ([M] で計画)');
      return;
    }
    if (this.simSpeedManager.isAutoWarping) {
      this.simSpeedManager.cancelAutoWarp();
      this._hud.hint('自動ワープ解除');
    } else {
      this.simSpeedManager.startAutoWarpTo(first.time);
      this._hud.hint('ノードへ自動ワープ開始');
    }
  }

  // focus(地球中心 or ラベル ID)を解決し、フローティングオリジン(origin)相対の
  // 位置として返す。CameraSystem.updateActiveCamera の focusRel 引数の供給元 —
  // MapCamera へは解決済みの Vec3 だけを渡す。
  focusRel(origin: Vec3): Vec3 {
    const pos = this.focus === 'earth' ? v3(0, 0, 0) : this.mapHud.findLabel(this.focus)?.pos ?? v3(0, 0, 0);
    return sub(pos, origin);
  }

  // --------------------------------------------------------------- per-frame

  // マップモードのノード編集入力(クリック配置・Δv調整・ツールバー/計画パネル反映)。
  // ツールバー表示は PlanDisplay/MapCamera 側の状態が要るため、ここで組み立てて渡す
  // (hud への反映自体は editor 側が行う)。
  updateEditing(dt: number, input: Input): void {
    const state = this.getExternalState();
    this.editor.updateEditing(this.plan, dt, state.simTime, state.player.state.r, this.toDisplayFrame(state.ephemeris), input, this.project, {
      fineAttitude: this.getFineAttitude(),
      labels: this.mapHud.labels,
      toolbar: {
        durationKey: this.display.predictDurationKey,
        frameRotating: this.mapCamera.frameRotating,
        ghostLabel: this.mapCamera.sliderT > 0 ? this.display.ghostLabel(this.plan, state.player, state.simTime, this.mapCamera.sliderT) : null,
        focus: this.focus,
      },
    });
  }

  // マップ表示中(mapMode)のみ意味を持つ: 予測軌道の再計算・折れ線/ゴースト描画・
  // ギズモ座標更新・フォーカスラベル描画。閉じている間は表示物の後始末のみ行う。
  updateDisplay(mapMode: boolean): void {
    if (!mapMode) {
      this.display.hide();
      this.editor.hideGizmo();
      return;
    }
    const state = this.getExternalState();
    const origin = state.player.state.r;
    this.display.update(this.plan, state, origin, this.mapCamera.frameRotating, this.mapCamera.sliderT, this.project);
    this.editor.updateGizmo(this.plan, origin, this.toDisplayFrame(state.ephemeris), this.project, this.mapCamera.dist);
    this.mapHud.updateLabels(
      origin,
      state.simTime,
      state.ephemeris,
      this.display.predictDurationSec(state.player),
      this.mapCamera.sliderT,
      this.project,
    );
  }

  resolveDisplayTime(mapMode: boolean): number {
    const state = this.getExternalState();
    if (!mapMode || this.mapCamera.sliderT <= 0) return state.simTime;
    return this.display.displayTime(state.simTime, this.display.predictDurationSec(state.player), this.mapCamera.sliderT);
  }

  mapLabelIds(): string[] {
    return this.mapHud.labels.map((l) => l.id);
  }

  get trajLineGroup(): THREE.Object3D {
    return this.display.line.group;
  }
}

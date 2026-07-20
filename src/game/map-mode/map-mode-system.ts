// マップモード(軌道計画モード)folder の唯一の外部窓口。
// 軌道計画そのもの(Plan / plan-guide.ts の実施)はマップモードと無関係なデータ・
// ロジックとして game/plan/ に独立して存在し、Game がここへ Plan を注入する
// (このクラスは Plan を作らず、コンストラクタで受け取るだけ)。
// PlanEditor(マップ上でのノード編集)/ PlanDisplay(マップ上での予測軌道・ゴースト
// 表示)/ MapHud(フォーカス対象ラベルの算出・描画)を private に保持し、有効フラグと
// 開閉時の後始末はこのクラス自身が持つ。MapCamera(マップカメラ・視点操作)はもはや
// カメラ以外の責務を持たないため camera-system.ts の CameraSystem が所有し、このクラスは
// コンストラクタで参照を受け取るだけ(生成しない・カメラ駆動もしない — 駆動は
// CameraSystem.updateActiveCamera が直接呼ぶ)。frameRotating/pan/dist/sliderT は
// 軌道計画編集(toDisplayFrame・ツールバー・ギズモ)がカメラの視点状態を読む必要が
// あるための実質的な依存で、単なる薄い転送ではない。
// フォーカス対象(focus: どのラベルを注視するかの文字列 ID)は MapCamera ではなく
// このクラスが持つ — focus を変更する UI 操作(ツールバー・右クリメニュー)は
// すべてここに集まるため、focus とその解決(focusRel: ラベル位置→フローティング
// オリジン相対位置)は同じ場所にあるべきで、MapCamera は解決済みの Vec3 を受け取る
// だけにする(ラベルという概念自体を知らない)。
// 外部(game.ts / camera-system.ts / orbit-line-system.ts)はこのクラスのメソッドのみを
// 呼ぶ — 3クラスへ個別に触れさせない。
// シミュレーション速度そのものの管理は責務が異なるため SimSpeedManager が別途持ち、
// ここではノード実行時刻への自動ワープの起点(startAutoWarpTo/cancelAutoWarp の
// 呼び出しどころ)としてのみ参照する。
//
// PlanCtx が要求する「現在状態」は planCtx() で毎回引ける(Game 側の simTime/player
// 状態は非同期な DOM イベント(ギズモドラッグ等)からも参照する必要があるため、
// コンストラクタ注入のコールバックとして持つ)。project も同様の理由で
// コンストラクタ注入(カメラ依存のクロージャ)。
import * as THREE from 'three/webgpu';
import { Vec3, sub, v3 } from '../../physics/vec3';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Input } from '../input';
import { TouchControls } from '../touch';
import { ProjectFn } from '../camera/projection';
import { SimSpeedManager } from '../sim-speed-manager';
import { Plan, PlanCtx } from '../plan/plan';
import { PlanEditor } from './plan-editor';
import { DisplayFrameFn, PlanDisplay } from './plan-display';
import { MapCamera } from '../camera/map-camera';
import { MapHud } from './map-hud';

export interface MapModeExternalState {
  simTime: number;
  playerR: Vec3;
  playerV: Vec3;
  sunPhase0: number;
  moonPhase0: number;
}

export class MapModeSystem {
  private readonly editor: PlanEditor;
  private readonly display: PlanDisplay;
  private readonly mapHud: MapHud;
  private enabled = false;
  private focus: string = 'earth';

  constructor(
    private readonly hud: Hud,
    private readonly sfx: Sfx,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly plan: Plan,
    private readonly project: ProjectFn,
    private readonly mapCamera: MapCamera,
    private readonly getFineAttitude: () => boolean,
    private readonly getExternalState: () => MapModeExternalState,
  ) {
    this.editor = new PlanEditor(hud, sfx);
    this.display = new PlanDisplay(hud.markers);
    this.mapHud = new MapHud(hud);
    this.wireHudCallbacks();
    this.wireGizmoCallbacks();
  }

  private wireHudCallbacks(): void {
    this.hud.onDurationSelect = (key) => {
      if (key === 'orbit' || key === 'day' || key === 'week' || key === 'month') {
        this.display.predictDurationKey = key;
        this.plan.markDirty();
      }
    };
    this.hud.onFrameToggle = () => {
      this.mapCamera.frameRotating = !this.mapCamera.frameRotating;
      this.plan.markDirty();
    };
    this.hud.onMapFocusSelect = (focus) => {
      this.focus = focus;
      this.mapCamera.pan.set(0, 0, 0);
    };
    this.hud.onMapViewReset = () => {
      this.focus = 'earth';
      this.mapCamera.reset();
    };
    this.hud.onSliderChange = (t) => {
      this.mapCamera.sliderT = t;
    };
  }

  private wireGizmoCallbacks(): void {
    this.editor.bindGizmoCallbacks({
      onNodeSelect: (idx) => {
        this.editor.selectedNodeIdx = idx;
        this.editor.closeMenu();
        this.sfx.warp();
      },
      onNodeDragMove: (idx, clientX, clientY) => {
        this.editor.closeMenu();
        const ctx = this.planCtx();
        this.editor.dragNodeToNearestSample(this.plan, idx, clientX, clientY, ctx.playerR, this.toDisplayFrame(ctx), this.project);
      },
      onNodeContextMenu: (clientX, clientY) => {
        const ctx = this.planCtx();
        this.editor.handleMapRightClick(this.plan, clientX, clientY, ctx.playerR, this.toDisplayFrame(ctx), this.project, this.mapHud.labels);
      },
      onAxisDrag: (axis, sign, deltaPx) => {
        this.editor.applyAxisDrag(this.plan, axis, sign, deltaPx, this.getFineAttitude());
      },
      onMenuWarpTo: (idx) => {
        const n = this.plan.nodes[idx];
        if (!n) return;
        this.simSpeedManager.startAutoWarpTo(n.time);
        this.hud.hint('指定時刻まで自動ワープ開始');
      },
      onMenuDelete: (idx) => {
        this.editor.deleteNode(this.plan, idx);
        this.notifyNodeDeleted();
      },
      onMenuFocus: (targetKey) => {
        this.focus = targetKey;
        const lbl = this.mapHud.findLabel(targetKey);
        if (lbl) this.hud.hint(`${lbl.name} にフォーカス`);
      },
    });
  }

  private planCtx(): PlanCtx {
    return this.getExternalState();
  }

  // 太陽回転系表示込みの座標変換を、その正である PlanDisplay へ束縛して渡す。
  // plan-editor.ts のクリック判定・ドラッグ・ギズモ配置は必ずこの1つの変換を通す
  // ことで、描画(plan-display.ts)とずれないようにする。
  private toDisplayFrame(ctx: PlanCtx): DisplayFrameFn {
    const rotating = this.mapCamera.frameRotating;
    return (r: Vec3, t: number) => this.display.toDisplayFrame(r, t, ctx, rotating);
  }

  // --------------------------------------------------------------- lifecycle

  get mapMode(): boolean {
    return this.enabled;
  }

  toggleMap(phase: string, touchControls: TouchControls | null): void {
    if (phase !== 'playing') return;
    if (!this.enabled) {
      this.enabled = true;
      this.editor.selectedNodeIdx = null;
      // マップの表示用予測期間は戦闘ビューの噴射ガイド用期間と異なるため、
      // 開いた直後は必ず作り直す(スロットリングで最大2秒待たされるのを避ける)。
      this.plan.markDirty();
      this.hud.setMapToolbarVisible(true);
      touchControls?.setMapMode(true);
      this.hud.hint(
        '軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [M] で確定',
        5000,
      );
      return;
    }
    this.enabled = false;
    this.editor.onMapClosed(this.plan);
    this.hud.setMapToolbarVisible(false);
    this.hud.setPlanPanel(null);
    this.editor.closeMenu();
    touchControls?.setMapMode(false);
    if (this.plan.nodes.length > 0) {
      this.hud.hint(`マニューバ計画 ${this.plan.nodes.length} 件確定 — [N] で直近ノードへ自動ワープ`, 4500);
    }
  }

  syncMapModeWithPhase(phase: string, touchControls: TouchControls | null): void {
    if (phase !== 'playing' && this.enabled) {
      this.enabled = false;
      this.hud.setPlanPanel(null);
      this.hud.setMapToolbarVisible(false);
      this.editor.closeMenu();
      touchControls?.setMapMode(false);
    }
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
    this.hud.hint('ノードを削除');
  }

  // [N] キー: 直近ノードの実行時刻までの自動ワープをトグルする(実際の速度管理は
  // SimSpeedManager が持つ — ここではノードの有無/時刻の解決だけを担う)。
  toggleAutoWarpToFirstNode(phase: string): void {
    if (this.mapMode) return;
    const first = this.plan.firstNode();
    if (!first || phase !== 'playing') {
      this.hud.hint('マニューバノードがありません ([M] で計画)');
      return;
    }
    if (this.simSpeedManager.isAutoWarping) {
      this.simSpeedManager.cancelAutoWarp();
      this.hud.hint('自動ワープ解除');
    } else {
      this.simSpeedManager.startAutoWarpTo(first.time);
      this.hud.hint('ノードへ自動ワープ開始');
    }
  }

  // focus(地球中心 or ラベル ID)を解決し、フローティングオリジン(origin)相対の
  // 位置として返す。CameraUpdateCtx.focusRel の供給元 — MapCamera 自身は focus という
  // 文字列もラベルという概念も知らない。
  focusRel(origin: Vec3): Vec3 {
    const pos = this.focus === 'earth' ? v3(0, 0, 0) : this.mapHud.findLabel(this.focus)?.pos ?? v3(0, 0, 0);
    return sub(pos, origin);
  }

  // --------------------------------------------------------------- per-frame

  // マップモードのノード編集入力(クリック配置・Δv調整・ツールバー/計画パネル反映)。
  // ツールバー表示は PlanDisplay/MapCamera 側の状態が要るため、ここで組み立てて渡す
  // (hud への反映自体は editor 側が行う)。
  updateEditing(dt: number, input: Input): void {
    const ctx = this.planCtx();
    this.editor.updateEditing(this.plan, dt, ctx.simTime, ctx.playerR, this.toDisplayFrame(ctx), input, this.project, {
      fineAttitude: this.getFineAttitude(),
      labels: this.mapHud.labels,
      toolbar: {
        durationKey: this.display.predictDurationKey,
        frameRotating: this.mapCamera.frameRotating,
        ghostLabel: this.mapCamera.sliderT > 0 ? this.display.ghostLabel(this.plan, ctx, this.mapCamera.sliderT) : null,
        focus: this.focus,
      },
    });
  }

  // マップ表示中(mapMode)のみ意味を持つ: 予測軌道の再計算・折れ線/ゴースト描画・
  // ギズモ座標更新・フォーカスラベル描画。閉じている間は表示物の後始末のみ行う。
  updateDisplay(): void {
    if (!this.mapMode) {
      this.display.hide();
      this.editor.hideGizmo();
      return;
    }
    const ctx = this.planCtx();
    const origin = ctx.playerR;
    this.display.update(this.plan, ctx, origin, this.mapCamera.frameRotating, this.mapCamera.sliderT, this.project);
    this.editor.updateGizmo(this.plan, origin, this.toDisplayFrame(ctx), this.project, this.mapCamera.dist);
    this.mapHud.drawLabels(
      origin,
      {
        simTime: ctx.simTime,
        sunPhase0: ctx.sunPhase0,
        moonPhase0: ctx.moonPhase0,
        duration: this.display.predictDurationSec(ctx),
      },
      this.mapCamera.sliderT,
      this.project,
    );
  }

  resolveDisplayTime(): number {
    const ctx = this.planCtx();
    if (!this.mapMode || this.mapCamera.sliderT <= 0) return ctx.simTime;
    return this.display.displayTime(ctx.simTime, this.display.predictDurationSec(ctx), this.mapCamera.sliderT);
  }

  mapLabelIds(): string[] {
    return this.mapHud.labels.map((l) => l.id);
  }

  get trajLineGroup(): THREE.Object3D {
    return this.display.line.group;
  }
}

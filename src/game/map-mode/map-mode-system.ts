// マップモード(軌道計画モード)folder の唯一の外部窓口。
// 軌道計画そのもの(Plan / plan-guide.ts の実施)はマップモードと無関係なデータ・
// ロジックとして game/plan/ に独立して存在し、Game がここへ Plan を注入する
// (このクラスは Plan を作らず、コンストラクタで受け取るだけ)。
// PlanEditor(マップ上でのノード編集)/ PlanDisplay(マップ上での予測軌道・ゴースト
// 表示)/ MapCamera(マップカメラ・視点操作・フォーカスラベル)/ MapModeController
// (有効フラグと開閉時の後始末)を private に保持し、外部(game.ts / camera-system.ts /
// orbit-line-system.ts)はこのクラスのメソッドのみを呼ぶ — 4クラスへ個別に触れさせない。
// シミュレーション速度そのものの管理は責務が異なるため SimSpeedManager が別途持ち、
// ここではノード実行時刻への自動ワープの起点(startAutoWarpTo/cancelAutoWarp の
// 呼び出しどころ)としてのみ参照する。
//
// PlanCtx が要求する「現在状態」は planCtx() で毎回引ける(Game 側の simTime/player
// 状態は非同期な DOM イベント(ギズモドラッグ等)からも参照する必要があるため、
// コンストラクタ注入のコールバックとして持つ)。project も同様の理由で
// コンストラクタ注入(カメラ依存のクロージャ)。
import * as THREE from 'three/webgpu';
import { Elements, elementsFromState } from '../../physics/orbital';
import { sunAzimuth } from '../../physics/ephemeris';
import { Vec3 } from '../../physics/vec3';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Input, MouseDelta } from '../input';
import { TouchControls } from '../touch';
import { ProjectFn } from '../camera/projection';
import { SimSpeedManager } from '../sim-speed-manager';
import { Plan, PlanCtx } from '../plan/plan';
import { guideDurationSec } from '../plan/plan-guide';
import { PlanEditor } from './plan-editor';
import { DisplayFrameFn, PlanDisplay } from './plan-display';
import { MapCamera } from './map-camera';
import { MapModeController } from './mapmode-controller';

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
  private readonly mapCamera: MapCamera;
  private readonly mapModeController: MapModeController;

  constructor(
    private readonly hud: Hud,
    private readonly sfx: Sfx,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly plan: Plan,
    private readonly project: ProjectFn,
    private readonly getFineAttitude: () => boolean,
    private readonly getExternalState: () => MapModeExternalState,
  ) {
    this.editor = new PlanEditor(hud, sfx);
    this.display = new PlanDisplay(hud.markers);
    this.mapCamera = new MapCamera(hud);
    this.mapModeController = new MapModeController(hud, this.editor);
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
      this.mapCamera.focus = focus;
      this.mapCamera.pan.set(0, 0, 0);
    };
    this.hud.onMapViewReset = () => this.mapCamera.reset();
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
        this.editor.handleMapRightClick(this.plan, clientX, clientY, ctx.playerR, this.toDisplayFrame(ctx), this.project, this.mapCamera.labels);
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
        this.simSpeedManager.cancelAutoWarp();
        this.hud.hint('ノードを削除');
      },
      onMenuFocus: (targetKey) => {
        this.mapCamera.focus = targetKey;
        const lbl = this.mapCamera.labels.find((l) => l.id === targetKey);
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
    return this.mapModeController.enabled;
  }

  toggleMap(phase: string, touchControls: TouchControls | null): void {
    this.mapModeController.toggle(phase, touchControls, this.plan);
  }

  syncMapModeWithPhase(phase: string, touchControls: TouchControls | null): void {
    this.mapModeController.syncWithPhase(phase, touchControls);
  }

  // [X] キー(マップモード中のみ): 選択中ノードを削除する。マップ外での計画全破棄は
  // Plan を直接持つ Game 側の責務(game.ts の handleEdgePress 参照 — マップモードと
  // 無関係な操作のため、ここには置かない)。
  deleteSelectedNode(): void {
    const idx = this.editor.selectedNodeIdx;
    if (idx === null) return;
    this.editor.deleteNode(this.plan, idx);
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

  // ---------------------------------------------------------------- camera

  get camera(): THREE.PerspectiveCamera {
    return this.mapCamera.camera;
  }

  get cameraFar(): number {
    return this.mapCamera.camera.far;
  }

  updateCamera(mouse: MouseDelta, keyYaw: number, keyPitch: number, dt: number): void {
    const s = this.getExternalState();
    const sunAz = sunAzimuth(s.simTime, s.sunPhase0);
    this.mapCamera.updateCamera(mouse, keyYaw, keyPitch, dt, s.playerR, sunAz);
  }

  // --------------------------------------------------------------- per-frame

  // マップモードのノード編集入力(クリック配置・Δv調整・ツールバー/計画パネル反映)。
  updateEditing(dt: number, input: Input): void {
    const ctx = this.planCtx();
    this.editor.updateEditing(this.plan, dt, ctx.simTime, ctx.playerR, this.toDisplayFrame(ctx), input, this.project, {
      fineAttitude: this.getFineAttitude(),
      labels: this.mapCamera.labels,
    });
    this.hud.setMapToolbarState(
      this.display.predictDurationKey,
      this.mapCamera.frameRotating,
      this.mapCamera.sliderT > 0 ? this.display.ghostLabel(this.plan, ctx, this.mapCamera.sliderT) : null,
      this.mapCamera.focus,
    );
  }

  // 予測軌道の再計算・折れ線/ゴースト描画・ギズモ座標更新・フォーカスラベル描画。
  // 戻り値の plannedEl は戦闘ビューの計画軌道ラインの描画に使う。
  updateDisplay(): { plannedEl: Elements | null } {
    const ctx = this.planCtx();
    const origin = ctx.playerR;

    if (this.mapMode) {
      this.display.update(this.plan, ctx, origin, this.mapCamera.frameRotating, this.mapCamera.sliderT, this.project);
      this.editor.updateGizmo(this.plan, origin, this.toDisplayFrame(ctx), this.project, this.mapCamera.dist);
      this.mapCamera.drawLabels(
        origin,
        {
          simTime: ctx.simTime,
          sunPhase0: ctx.sunPhase0,
          moonPhase0: ctx.moonPhase0,
          duration: this.display.predictDurationSec(ctx),
        },
        this.project,
      );
    } else {
      this.display.hide();
      this.editor.hideGizmo();
    }

    // 戦闘ビューの計画軌道ライン用: plan-guide.ts の噴射ガイドと同じ期間ポリシー
    // (guideDurationSec)で予測を最新化する。マップの表示用予測期間
    // (display.predictDurationSec、ユーザーが選択する day/week/month)とは
    // 意図的に別物 — こちらは直近ノードだけを短く見る期間。
    let plannedEl: Elements | null = null;
    if (!this.mapMode) {
      const first = this.plan.firstNode();
      if (first) {
        this.plan.maybeRefresh(ctx, guideDurationSec(this.plan, ctx));
        const sample = this.plan.sampleAt(first.time);
        if (sample) plannedEl = elementsFromState(sample.r, sample.v);
      }
    }
    return { plannedEl };
  }

  resolveDisplayTime(): number {
    const ctx = this.planCtx();
    if (!this.mapMode || this.mapCamera.sliderT <= 0) return ctx.simTime;
    return this.display.displayTime(ctx.simTime, this.display.predictDurationSec(ctx), this.mapCamera.sliderT);
  }

  mapLabelIds(): string[] {
    return this.mapCamera.labels.map((l) => l.id);
  }

  get trajLineGroup(): THREE.Object3D {
    return this.display.line.group;
  }
}

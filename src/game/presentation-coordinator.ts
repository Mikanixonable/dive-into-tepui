import type { Input } from '../input/input';
import type { GraphicsSettingsData } from '../render/graphics-settings';
import type { RenderStyle } from '../render/render-style';
import type * as THREE from 'three/webgpu';
import type { DynamicSystem } from './dynamic/dynamic-system';
import type { Predictor } from './dynamic/predictor';
import type { SimSpeedManager } from './dynamic/sim-speed-manager';
import type { FlashEffects } from './vfx/flash-effects';
import type { CelestialSystem } from './celestial/celestial-system';
import type { CameraSystem } from './camera/camera-system';
import type { ControlSelection } from './control-selection';
import type { DisplayWindowManager } from './display-window-manager';
import { timeLabelSettingOf } from './display-window-manager';
import type { EntityLineManager } from './lines/entity-line-manager';
import type { FrameAnchors } from './frame-anchors';
import { SECTION } from './frame-sections';
import type { FrameSections } from './frame-sections';
import type { Hud } from './hud/hud';
import {
  enemiesPanelViewOf,
  mapScaleViewOf,
  orbitPanelViewOf,
  targetPanelDataOf,
  topBarViewOf,
  vesselPanelViewOf,
} from './hud/panel-presenter';
import type { MarkerManager } from './marker/marker-manager';
import type { NavTarget } from './nav-target';
import type { ObjectWindows } from './pickable/object-windows';
import type { OrbitReferenceSelector } from './orbit-reference';
import type { PlanDisplay } from './plan/plan-display';
import type { Stage } from './stages/stage';
import type { Targeter } from './targeter';
import type { ViewBadge } from './hud/view-badge';
import type { ViewManager } from './view/view-manager';

// 表示窓を確定した後の update と、確定値を各表示物へ渡す sync を担当する。
export class PresentationCoordinator {
  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly hud: Hud,
    private readonly viewBadge: ViewBadge,
    private readonly displayWindowManager: DisplayWindowManager,
    private readonly frameAnchors: FrameAnchors,
    private readonly planDisplay: PlanDisplay,
    private readonly predictor: Predictor,
    private readonly cameraSystem: CameraSystem,
    private readonly viewManager: ViewManager,
    private readonly input: Input,
    private readonly dynamicSystem: DynamicSystem,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly celestialSystem: CelestialSystem,
    private readonly markerManager: MarkerManager,
    private readonly targeter: Targeter,
    private readonly navTarget: NavTarget,
    private readonly objectWindows: ObjectWindows,
    private readonly entityLines: EntityLineManager,
    private readonly activeStage: Stage,
    private readonly flashEffects: FlashEffects,
    private readonly orbitReference: OrbitReferenceSelector,
    private readonly controlSelection: ControlSelection,
    private readonly sections: FrameSections,
  ) {}

  // 計画・予測・交点・カメラ・ビュー固有候補・ポインタを、同じ表示窓の順で更新する。
  update(dt: number, isPaused: boolean): void {
    const activeControllable = this.controlSelection.current;
    const displayWindow = this.displayWindowManager.resolve(this.dynamicSystem.simTime, activeControllable);
    // 過去表示に要る履歴の長さを要求する。次の積分がサンプルを積むまでに立っていればよいので、
    // 窓が確定したこの場で渡す。
    this.dynamicSystem.requestHistoryDuration(displayWindow.pastDuration);
    const view = this.viewManager.current;
    const canDisplayFuture = !this.displayWindowManager.forceCurrent;
    // このフレームが天体を引く表示時刻を差し込む: 以降の frameTransformAt 呼び出しは
    // すべてこの frameAnchors を通す。
    this.frameAnchors.update(displayWindow.displayTime);
    // 計画表示、予測伸長、選択候補、カメラはこの順序で同じ時刻の状態へ更新する。
    this.sections.enter(SECTION.plan);
    this.planDisplay.update(displayWindow, this.frameAnchors, view);
    this.sections.exit(SECTION.plan);
    // 予測の伸長対象は軌道分析ウィンドウが見ている個体を含むので、予測より先に確定させる。
    this.hud.updateAnalysisReaders();
    // ポーズ中・決着後も無条件に呼ぶ: simTime が止まっている間はサブステップも進まず、
    // 消費も期限切れの張り直しも起きないので、予測は伸び切ったところで止まるだけで害はない。
    this.sections.enter(SECTION.predict);
    this.predictor.update(
      this.dynamicSystem.simTime, this.dynamicSystem.lastSimDt, activeControllable, displayWindow.duration,
      canDisplayFuture, this.planDisplay.growableArcs(),
    );
    this.sections.exit(SECTION.predict);
    // 交点を置く先は計画折れ線か解析軌道楕円のどちらかなので、折れ線を組み終えた計画表示と、
    // 楕円が引く予測列を伸ばした後に通す。
    this.sections.enter(SECTION.plan);
    this.dynamicSystem.updateEquatorNodes({
      displayTime: displayWindow.displayTime,
      celestialSystem: this.celestialSystem,
      frameAnchors: this.frameAnchors,
      markerManager: this.markerManager,
      paths: this.planDisplay,
    }, activeControllable);
    this.sections.exit(SECTION.plan);
    this.sections.enter(SECTION.camera);
    this.cameraSystem.update(
      displayWindow.displayTime, this.input, dt, this.viewManager.activeView.pickables,
      this.frameAnchors, activeControllable,
    );
    this.sections.exit(SECTION.camera);
    // カメラ更新の後に置く: 候補列の組み直しが読む近傍系抽出・遮蔽判定・可視マーカー更新は
    // cameraSystem.activeCameraPos を使うので、先に組むとこのフレームの sync が1フレーム古い
    // カメラ位置基準の判定を読むことになる。
    this.sections.enter(SECTION.mapPick);
    this.viewManager.activeView.update(displayWindow);
    this.sections.exit(SECTION.mapPick);
    this.sections.enter(SECTION.pointer);
    this.handlePointerInput(isPaused);
    this.sections.exit(SECTION.pointer);
  }

  // ポインタ入力を現在のビューへ配る。cameraSystem.update 後の投影を使い、ポーズ中と入力ゲート中は戻る。
  private handlePointerInput(isPaused: boolean): void {
    if (isPaused || this.hud.overlayManager.isInputGated()) return;
    this.viewManager.activeView.handlePointer(this.dynamicSystem.simTime);
  }

  // update で確定した表示時刻・座標系を、既存の表示順のまま各システムへ同期する。
  sync(graphics: GraphicsSettingsData, style: RenderStyle, isPaused: boolean): void {
    const controlled = this.controlSelection.current;
    // update() が確定させた、このフレームの表示窓。
    const displayWindow = this.displayWindowManager.current;
    this.viewBadge.sync(
      this.activeStage.stageClass.selectLabel, this.cameraSystem.activeFocus,
      controlled, this.navTarget.name,
    );

    // 表示時刻 = 未来ゴーストのスライダーぶん先取りした simTime。
    const { displayTime, simTime } = displayWindow;
    const celestialBodies = this.celestialSystem.celestialMotions;

    // 最初に行う: 後続の sync とマーカー投影がこのフレームのカメラ行列と描画原点を読む。
    this.cameraSystem.sync();
    const fo = this.cameraSystem.getFloatingOrigin();
    // 天体ラベルの間引きは、この後のマーカー同期が近接判定に読むので先に済ませる。
    this.viewManager.activeView.syncLabels(displayWindow);

    // 表示・選択可否はこのフレームの update フェーズで現在のビューが確定させたものを読む
    // (選べる対象と描かれる対象が同じ判定から出るようにする)。
    const visibilityPolicy = this.viewManager.activeView.visibilityPolicy;
    // 3D 軌道線を軌道パネルと同じ基準で解く。
    const orbitRef = controlled
      ? this.orbitReference.resolve(
        controlled.state.r, celestialBodies, this.navTarget,
        this.dynamicSystem, this.celestialSystem, controlled.state.t,
      )
      : undefined;

    this.celestialSystem.sync(
      fo, displayTime,
      this.cameraSystem, graphics, style, visibilityPolicy, this.markerManager,
    );
    this.celestialSystem.bakeClouds(this.renderer, displayTime);

    // 通過時刻ラベルの設定は、赤道交点と航法ターゲットの両方が同じものを読む。
    const timeLabel = timeLabelSettingOf(displayWindow);
    this.dynamicSystem.sync(
      fo, displayTime, controlled, visibilityPolicy, this.cameraSystem, style, graphics,
      orbitRef, this.frameAnchors, timeLabel,
    );
    // ビルボードはこのフレームのカメラ姿勢へ向けるので、cameraSystem.sync より後に通す。
    this.flashEffects.sync(fo, this.cameraSystem.activeCamera, this.cameraSystem.zoomActive);

    this.targeter.sync(controlled, this.cameraSystem, displayTime, simTime, visibilityPolicy);
    this.navTarget.sync(
      this.cameraSystem, this.frameAnchors.bodies, this.frameAnchors.bodiesPivot, timeLabel);

    // 戦闘中に開いたプロパティウィンドウも最新値を表示し続ける必要があるので、ビューに依らず呼ぶ。
    this.objectWindows.sync(simTime, displayTime);
    this.planDisplay.sync(this.cameraSystem, fo, displayWindow);

    // 計画軌道の折れ線と同じ座標系で描かないと、同一画面上で並べたときに比較にならない。
    this.entityLines.sync(
      controlled, this.targeter.aliveTarget, this.viewManager.current, displayWindow, visibilityPolicy, orbitRef,
      fo, this.cameraSystem.activeCamera, this.frameAnchors, this.celestialSystem);
    // ビュー専用のパネル・表示物と軌道線の右クリック候補。軌道線が今フレーム焼いたサンプルを
    // 読むため、celestialSystem.sync/entityLines.sync の後に置く。
    this.viewManager.activeView.syncPanels(displayWindow, fo);

    this.activeStage.sync(fo, this.cameraSystem, displayTime, visibilityPolicy);

    this.hud.syncPanels(
      this.viewManager.current,
      topBarViewOf({
        simTime: this.dynamicSystem.simTime,
        displayWindowManager: this.displayWindowManager,
        simSpeedManager: this.simSpeedManager,
        isPaused,
      }),
      orbitPanelViewOf({
        activeControllable: controlled,
        celestialSystem: this.celestialSystem,
        orbitReference: this.orbitReference,
        navTarget: this.navTarget,
        dynamicSystem: this.dynamicSystem,
      }),
      mapScaleViewOf({
        viewManager: this.viewManager,
        cameraSystem: this.cameraSystem,
      }),
      vesselPanelViewOf({
        activeControllable: controlled,
        viewManager: this.viewManager,
        activeStage: this.activeStage,
        cameraSystem: this.cameraSystem,
      }),
      targetPanelDataOf({
        activeControllable: controlled,
        targeter: this.targeter,
        celestialSystem: this.celestialSystem,
      }),
      enemiesPanelViewOf({
        activeControllable: controlled,
        activeStage: this.activeStage,
        dynamicSystem: this.dynamicSystem,
        targeter: this.targeter,
      }),
      controlled?.boosters?.managementViewModel() ?? null,
    );

    // このフレームのマーカーが出揃った後でなければならないので最後に置く。
    this.markerManager.resolveCollisions(this.viewManager.current);
  }
}

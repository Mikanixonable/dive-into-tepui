// 2台のカメラ視点を入力命令と表示用 Viewpoint へ結び、ガンサイトと画角遷移を重ねる。
import type { Input } from '../../input/input';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import type { Viewpoint } from '../../math/projection';
import type { Vec3 } from '../../math/vec3';
import { v3 } from '../../math/vec3';
import { bodyAnchorSource } from '../../physics/attractor';
import type { FrameAnchorSource } from '../../physics/frame';
import type { Viewport } from '../../render/viewport';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { AnchorEntities } from '../frame-anchors';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import { screenRay } from './screen-ray';
import type { Ray } from '../../math/ray';
import type { HudLayers } from '../hud/hud-layers';
import type { ViewMode } from '../view/view-mode';
import type { CameraCommands } from '../viewer/camera-commands';
import { COMBAT_CAMERA_FOV, type CameraFrameSamples, type CameraSelectionSource } from '../viewer/camera-selection';
import type { CameraFrameSample, FocusCameraSource } from '../viewer/focus-camera-selection';
import { focusTargetId, type FocusTarget } from '../viewer/focus-target';
import type { ViewSelectionSource } from '../viewer/view-selection';
import { cameraOperation } from './camera-operator';
import { CameraRig } from './camera-rig';
import type { FocusCandidate } from './focus-derivation';
import { GunsightCamera } from './gunsight-camera';

const ZOOM_LERP_RATE = 9; // ガンサイトとの画角遷移の追従速度 [1/s]

export class CameraSystem {
  private readonly combatRig: CameraRig;
  private readonly mapRig: CameraRig;
  private readonly gunsightCamera: GunsightCamera;
  private readonly viewResetButton: HTMLElement | null;
  private samples: CameraFrameSamples;
  private zoomRequested = false;
  private useGunsight = false;
  private combatViewpoint: Viewpoint;
  private transitionStartFov = COMBAT_CAMERA_FOV;
  private transitionTargetFov = COMBAT_CAMERA_FOV;
  private transitionStartMs = 0;

  private get view(): ViewMode { return this.viewSelection.current; }
  private get activeSource(): FocusCameraSource { return this.cameraSelection.camera(this.view); }
  public get activeFocus(): FocusTarget { return this.activeSource.focus; }
  // 表に出ているビューの視点。
  public get activeViewpoint(): Viewpoint {
    return this.view === 'map' ? this.mapRig.viewpoint : this.combatViewpoint;
  }
  public get activeCameraPos(): Vec3 { return this.activeViewpoint.position; }
  public get mapResolvedFocus(): Vec3 { return this.mapRig.resolvedFocus; }
  public get zoomActive(): boolean { return this.view === 'combat' && this.zoomRequested; }
  public get clipFovDeg(): number { return this.activeSource.fov; }
  public get clipDistance(): number { return this.activeSource.distance; }
  // 表に出ているビューの注視点の速度。定まらなければ 0。
  public get focusVelocity(): Vec3 {
    const velocity = this.view === 'map' ? this.mapRig.focusVelocity : this.combatRig.focusVelocity;
    return velocity ?? v3();
  }

  // 2台のリグと入力ハンドラを構成する。
  public constructor(
    hud: Pick<HudLayers, 'root'>,
    celestialBodies: CelestialBodies,
    private readonly cameraSelection: CameraSelectionSource,
    private readonly commands: CameraCommands,
    private readonly viewSelection: Pick<ViewSelectionSource, 'current'>,
    private readonly anchorEntities: Pick<AnchorEntities, 'attitudeOf'>,
    viewport: Viewport,
  ) {
    this.combatRig = new CameraRig(celestialBodies);
    this.mapRig = new CameraRig(celestialBodies);
    // 初回 sampleProgress までの初期フレーム値として、空の天体アンカーを割り当てる。
    const initialAnchors = bodyAnchorSource([], 0);
    const initialSample: CameraFrameSample = {
      displayTime: 0,
      frameAnchors: initialAnchors,
      attitude: null,
      referenceUp: v3(0, 1, 0),
      lostFocus: null,
    };
    this.samples = { combat: initialSample, map: initialSample };
    this.combatViewpoint = {
      position: v3(),
      up: v3(0, 1, 0),
      lookTarget: v3(),
      fovDeg: COMBAT_CAMERA_FOV,
      aspect: viewport.width / viewport.height,
    };
    this.gunsightCamera = new GunsightCamera(viewport);
    // HUD の視点リセットボタンを、表に出ているビューのリセットへ繋ぐ。
    this.viewResetButton = hud.root.querySelector('#hud-chase-reset') as HTMLElement | null;
    this.viewResetButton?.addEventListener('pointerdown', this.handleViewReset);
  }

  // 現在の進行値から、命令と導出が共有する2台分のフレーム材料を作る。
  public sampleProgress(displayTime: number, frameAnchors: FrameAnchorSource): CameraFrameSamples {
    // 注視対象の姿勢・基準の上方向・注視の見失いは、そのカメラの注視と導出器から引く。
    const sample = (source: FocusCameraSource, rig: CameraRig): CameraFrameSample => {
      const id = focusTargetId(source.focus);
      const base = { displayTime, frameAnchors };
      return {
        ...base,
        attitude: id === undefined ? null : this.anchorEntities.attitudeOf(id, displayTime),
        referenceUp: rig.referenceUp(base),
        lostFocus: rig.lostFocus,
      };
    };
    // 入力の命令と導出が同じ材料を読むよう、2台ぶんを持っておく。
    this.samples = {
      combat: sample(this.cameraSelection.combat, this.combatRig),
      map: sample(this.cameraSelection.map, this.mapRig),
    };
    return this.samples;
  }

  // view のカメラの、直近の sampleProgress が作った材料。
  public sample(view: ViewMode): CameraFrameSample {
    return view === 'map' ? this.samples.map : this.samples.combat;
  }

  public rayThroughScreen(clientX: number, clientY: number, viewport: Viewport): Ray {
    return screenRay(this.activeViewpoint, viewport, clientX, clientY);
  }

  // 建造対象の艦へ戦闘カメラを寄せる。以後の orbit／zoom 操作は通常のカメラ命令が担う。
  public focusConstruction(shipId: string, radius: number): void {
    this.commands.combat.setFocus({ kind: 'object', id: shipId });
    this.commands.combat.setDistance(Math.max(12, radius * 2.5));
  }

  // 入力を現在のビューの視点命令へ変換する。命令は同じフレームの進行先頭で適用される。
  public handleInput(input: Input, dt: number, viewport: Viewport, controlled: Controllable | null): void {
    const view = this.view;
    const commands = this.commands.camera(view);
    const sample = this.sample(view);
    // 中クリックは視点のリセット。
    input.takeMiddleClicks(() => {
      commands.reset(sample);
      return true;
    });
    // ガンサイトを覗いている間は、視点を動かす入力を止める。
    this.zoomRequested = input.down(K.gunsightZoom);
    const suppressMotion = view === 'combat' && this.zoomRequested && controlled?.fire != null;
    const operation = cameraOperation(input, dt, viewport, suppressMotion);
    // マップではロールのリセットを視点のリセットとして積む。
    if (operation.rollReset && view === 'map') this.commands.map.reset(this.samples.map);
    commands.applyInput(operation.input, sample);
  }

  // router から姿勢追従の単発入力を受け、現在のビューへ積む。
  public handleCommand(commandId: string): void {
    if (commandId !== K.followAttitudeToggle.code) return;
    this.commands.camera(this.view).toggleAttitudeFollow(this.sample(this.view));
  }

  // 視点状態と進行値から現在のビューの Viewpoint を導出する。
  public update(
    candidates: readonly FocusCandidate[],
    controlled: Controllable | null,
    viewport: Viewport,
    nowMs: number,
  ): void {
    if (this.view === 'map') {
      this.mapRig.update(this.cameraSelection.map, this.samples.map, candidates, viewport);
      return;
    }
    this.combatRig.update(this.cameraSelection.combat, this.samples.combat, candidates, viewport);
    this.useGunsight = this.zoomRequested && controlled?.fire != null;
    if (this.useGunsight && controlled !== null) this.gunsightCamera.update(controlled, viewport);
    const target = this.useGunsight ? this.gunsightCamera.viewpoint : this.combatRig.viewpoint;
    this.combatViewpoint = { ...target, fovDeg: this.transitionFov(target.fovDeg, nowMs) };
  }

  // 視点リセットボタンへ登録したハンドラを解除する。
  public dispose(): void {
    this.viewResetButton?.removeEventListener('pointerdown', this.handleViewReset);
  }

  // 実時刻から指数遷移を評価し、フレーム刻みに依存しない画角を返す。
  private transitionFov(targetFov: number, nowMs: number): number {
    if (targetFov !== this.transitionTargetFov) {
      this.transitionStartFov = this.fovAt(nowMs);
      this.transitionTargetFov = targetFov;
      this.transitionStartMs = nowMs;
    }
    return this.fovAt(nowMs);
  }

  // 実時刻 nowMs [ms] における遷移中の画角 [deg]。
  private fovAt(nowMs: number): number {
    const elapsedSec = Math.max(0, nowMs - this.transitionStartMs) / 1000;
    const remain = Math.exp(-ZOOM_LERP_RATE * elapsedSec);
    return this.transitionTargetFov + (this.transitionStartFov - this.transitionTargetFov) * remain;
  }

  // 視点リセットボタンの押下を、表に出ているビューのリセットの命令として積む。
  private readonly handleViewReset = (event: PointerEvent): void => {
    event.stopPropagation();
    this.commands.camera(this.view).reset(this.sample(this.view));
  };
}

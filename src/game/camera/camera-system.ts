import type { HudLayers } from '../hud/hud-layers';
import type { Notifier } from '../../hud/notifier';
import { GunsightCamera } from './gunsight-camera';
import { defaultMapViewInitial, FocusCamera } from './focus-camera';
import type { FocusTarget } from './focus-target';
import { frameRoleAnchorId } from '../../physics/frame';
import type { FocusCandidate } from './focus-target';
import { Input } from '../../input/input';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { Vec3, v3 } from '../../math/vec3';
import { screenProjection, Viewpoint, type ProjectFn } from '../../math/projection';
import type { FrameAnchorSource } from '../../physics/frame';
import type { Quat } from '../../math/quat';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { ViewMode } from '../../render/view-mode';
import type { Viewport } from '../../render/viewport';
import { CameraSaveData } from '../save/save-data';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';

// 戦闘ビューの初期視点: 操作対象の後方やや上から見下ろす(役割フォーカス+姿勢追従)。
const COMBAT_CAMERA_FOV = 55; // 通常時の垂直画角 [deg]
const COMBAT_CAMERA_INIT_ANGLES = { yaw: -Math.PI / 2, pitch: 0.3 - (10 * Math.PI) / 180, roll: 0 };
const COMBAT_CAMERA_INIT_DIST = 38;

const ZOOM_LERP_RATE = 9; // ガンサイトとの画角遷移の追従速度 [1/s]

// current から target へ、fovDeg だけを指数的に近づけた Viewpoint を返す(position/lookTarget/up/
// aspect はアニメーションせず target の値をそのまま採用する — カメラの向き自体は毎フレーム
// 追従してよく、揺れて見えるのは FOV だけで十分なため)。
function lerpViewpointFov(current: Viewpoint, target: Viewpoint, dt: number): Viewpoint {
  const k = 1 - Math.exp(-ZOOM_LERP_RATE * dt);
  return { ...target, fovDeg: current.fovDeg + (target.fovDeg - current.fovDeg) * k };
}

// 矢印キーでの視点回転 [rad/s]。マウスドラッグと同じ感覚になる値。
const CAM_KEY_YAW_RATE = 1.4;
const CAM_KEY_PITCH_RATE = 1.0;
const CAM_KEY_ROLL_RATE = 1.4; // テンキー0/1での視点ロール [rad/s]
const CAM_KEY_PAN_RATE = 600; // @/:/;/]での視点平行移動、中クリックドラッグと同じ px/s 換算で加算

// 同じ注視カメラ(FocusCamera)の戦闘用・マップ用の2インスタンスを、ビューに応じて切り替えて
// 駆動する。戦闘ビューではガンサイトズーム([Z])と画角遷移をその上に重ねる。
export class CameraSystem {
  readonly combatCamera: FocusCamera;
  readonly mapCamera: FocusCamera;
  private readonly gunsightCamera: GunsightCamera;
  private _zoomActive = false;
  // 戦闘ビューの表示視点。軌道視点とガンサイトの間で fovDeg だけを指数的に遷移させた後の値。
  private combatViewpoint: Viewpoint;
  // 現在のビュー。ビューの正本(ViewManager)から毎回読む。
  get view(): ViewMode { return this.currentView(); }
  // マップビューのインスタンスがアクティブか。
  private get mapActive(): boolean { return this.currentView() === 'map'; }

  private readonly viewResetBtn: HTMLElement | null;

  // 視点リセットボタン押下で、現在のビューに応じたカメラをリセットする。
  private readonly handleViewReset = (e: PointerEvent): void => {
    e.stopPropagation();
    this.resetActiveCamera();
  };

  // 現在のビューの視点をリセットする。戦闘は初期状態(操作対象へフォーカス・姿勢追従・
  // 既定の後方見下ろし)へ、マップはロールとパンだけを戻す。
  private resetActiveCamera(): void {
    if (this.mapActive) {
      this.mapCamera.reset();
      return;
    }
    this.combatCamera.resetToInitial();
    this.hud.hint('視点をリセット');
  }

  // 両カメラを構築し、視点リセットボタンを配線する。
  // saved があれば両カメラをその視点から組む。currentView はビューの正本を引く関数 —
  // ViewManager より先に生成されるため、参照でなく遅延評価で受ける。
  // attitudeOf はフォーカス機体の姿勢追従に使う解決関数(FocusCameraConfig 参照)。
  constructor(
    private readonly hud: HudLayers & Notifier,
    celestialBodies: CelestialBodies,
    private readonly currentView: () => ViewMode,
    attitudeOf: (id: string, t: number) => Quat | null,
    saved: Pick<CameraSaveData, 'chase' | 'overview'> | undefined,
    viewport: Viewport,
  ) {
    this.combatViewpoint = {
      position: v3(),
      up: v3(0, 1, 0),
      lookTarget: v3(),
      fovDeg: COMBAT_CAMERA_FOV,
      aspect: viewport.width / viewport.height,
    };
    this.gunsightCamera = new GunsightCamera(viewport);
    // ChaseSaveDataV1 形の戦闘視点は読み捨て、既定視点で組む。
    const savedChase = saved?.chase;
    const combatSaved = savedChase !== undefined && !('rot' in savedChase) ? savedChase : undefined;
    this.combatCamera = new FocusCamera(hud, celestialBodies, {
      focusLossPolicy: 'hold',
      initial: {
        angles: COMBAT_CAMERA_INIT_ANGLES,
        dist: COMBAT_CAMERA_INIT_DIST,
        fovDeg: COMBAT_CAMERA_FOV,
        focus: { kind: 'object', id: frameRoleAnchorId('controlled') },
        follow: { kind: 'attitude' },
      },
      eulerPole: 'attitude',
      attitudeOf,
    }, combatSaved, viewport);
    this.mapCamera = new FocusCamera(
      hud, celestialBodies,
      {
        focusLossPolicy: 'fallToOrigin',
        initial: defaultMapViewInitial(celestialBodies),
        eulerPole: 'reference',
        attitudeOf,
      },
      saved?.overview, viewport,
    );
    this.viewResetBtn = hud.root.querySelector('#hud-chase-reset') as HTMLElement | null;
    this.viewResetBtn?.addEventListener('pointerdown', this.handleViewReset);
  }

  // 視点リセットボタンへの配線を解く。
  dispose(): void {
    this.viewResetBtn?.removeEventListener('pointerdown', this.handleViewReset);
  }

  // 駆動・描画に使うカメラ実体。ビューの切替で、どちらの実体を通すかだけが変わる。
  private get activeFocusCamera(): FocusCamera {
    return this.mapActive ? this.mapCamera : this.combatCamera;
  }

  get activeViewpoint(): Viewpoint {
    return this.mapActive ? this.mapCamera.viewpoint : this.combatViewpoint;
  }

  // アクティブカメラの位置(描画原点になる値)を返す。
  get activeCameraPos(): Vec3 {
    return this.activeViewpoint.position;
  }

  // アクティブカメラの視点から viewport の画面座標への射影を返す。
  public activeProjection(viewport: Viewport): ProjectFn {
    return screenProjection(this.activeViewpoint, viewport.width, viewport.height);
  }

  // 現在のビューのカメラが注視しているフォーカス対象。
  get activeFocus(): FocusTarget {
    return this.activeFocusCamera.focus;
  }

  // 戦闘ビューでズーム視点(照準ズーム)が有効かどうか。
  get zoomActive(): boolean {
    return !this.mapActive && this._zoomActive;
  }

  // 入力からカメラの向き・ズームを更新する。ビューに応じてどちらか一方のインスタンスだけを
  // 駆動する。displayTime/frameAnchors は座標系変換に使う — 線・メッシュと同じ表示時刻でないと
  // 回転系選択時にカメラだけが現在時刻に取り残される。controlled は照準ズームの可否と
  // その視点を決める。
  update(
    displayTime: number,
    input: Input,
    dt: number,
    focusCandidates: readonly FocusCandidate[],
    frameAnchors: FrameAnchorSource,
    controlled: Controllable | null,
    viewport: Viewport,
  ): void {
    // 中クリックで視点リセット
    input.takeMiddleClicks(() => {
      this.resetActiveCamera();
      return true;
    });

    // [G]: フォーカスが機体のとき、姿勢追従⇄慣性系をトグルする(両ビュー)。
    if (input.takeKey(K.followAttitudeToggle)) {
      const active = this.activeFocusCamera;
      if (active.toggleAttitudeFollow()) {
        const on = active.rotationFollow?.kind === 'attitude';
        this.hud.hint(`視点の姿勢追従: ${on ? 'ON(機体姿勢に追従)' : 'OFF(慣性系)'}`);
      }
    }

    // キー/マウスによる旋回入力をまとめる
    const keyYawRad = ((input.down(K.cameraYawLeft) ? 1 : 0) + (input.down(K.cameraYawRight) ? -1 : 0))
      * CAM_KEY_YAW_RATE * dt;
    const keyPitchRad = ((input.down(K.cameraPitchDown) ? 1 : 0) + (input.down(K.cameraPitchUp) ? -1 : 0))
      * CAM_KEY_PITCH_RATE * dt;
    const keyRollLeft = input.down(K.cameraRollLeft);
    const keyRollRight = input.down(K.cameraRollRight);
    
    // /_ の同時押し（ロール左右の同時入力）でマップカメラのロールをリセット
    if (keyRollLeft && keyRollRight) {
      if (this.mapActive) this.mapCamera.reset();
    }
    const keyRoll = (keyRollLeft ? 1 : 0) + (keyRollRight ? -1 : 0);
    const keyPanX = (input.down(K.cameraPanLeft) ? 1 : 0) + (input.down(K.cameraPanRight) ? -1 : 0);
    const keyPanY = (input.down(K.cameraPanUp) ? 1 : 0) + (input.down(K.cameraPanDown) ? -1 : 0);
    const mouse = { ...input.mouse() };
    mouse.panDx += keyPanX * CAM_KEY_PAN_RATE * dt;
    mouse.panDy += keyPanY * CAM_KEY_PAN_RATE * dt;
    mouse.roll += keyRoll * CAM_KEY_ROLL_RATE * dt;

    if (this.mapActive) {
      this.mapCamera.update(mouse, keyYawRad, keyPitchRad, displayTime, focusCandidates, frameAnchors, viewport);
      return;
    }
    this._zoomActive = input.down(K.gunsightZoom);
    // 照準ズームは機関砲の照準器なので、砲を積んでいる操作対象にしか無い。持たない相手を
    // 操作している間はズーム要求を無視して軌道視点のままにする。
    const useGunsight = this._zoomActive && controlled?.fire != null;
    // ガンサイト中の視点操作は、覗いていない軌道視点へ届かせない(解除時に視点が跳ぶ)。
    const stillMouse = { ...mouse, dx: 0, dy: 0, wheel: 0, panDx: 0, panDy: 0, roll: 0 };
    this.combatCamera.update(
      useGunsight ? stillMouse : mouse,
      useGunsight ? 0 : keyYawRad,
      useGunsight ? 0 : keyPitchRad,
      displayTime, focusCandidates, frameAnchors, viewport,
    );
    if (useGunsight) this.gunsightCamera.update(controlled, viewport);
    const target = useGunsight ? this.gunsightCamera.viewpoint : this.combatCamera.viewpoint;
    this.combatViewpoint = lerpViewpointFov(this.combatViewpoint, target, dt);
  }

  // 近遠クリップ面を決める軌道視点の垂直画角 [deg]。ガンサイトへ絞り込む前の値を答える。
  get clipFovDeg(): number {
    return this.activeFocusCamera.fov;
  }

  // 近遠クリップ面を決める軌道視点の注視距離 [m]。
  get clipDistance(): number {
    return this.activeFocusCamera.dist;
  }

  // アクティブカメラが注視している点の ECI 速度。カメラの並進はこの点が決める —
  // 注視点まわりの旋回・パン・ズームは含めない。
  // 速度を答えられない対象(点マーカー)を注視しているあいだは慣性系静止として扱う。
  get focusVelocity(): Vec3 {
    return this.activeFocusCamera.focusVelocity ?? v3();
  }

  // 両サブカメラの視点状態をセーブデータへ書き出す。どちらが表示中かは ViewManager の責務。
  serialize(): Pick<CameraSaveData, 'chase' | 'overview'> {
    return { chase: this.combatCamera.serialize(), overview: this.mapCamera.serialize() };
  }
}

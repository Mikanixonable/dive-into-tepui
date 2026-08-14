// マップモードの「カメラ」「軌道」パネル。マップカメラの視点と未来表示(計画折れ線・
// 予測軌道線・交点マーカー)の描画基準という、別々の持ち主にある状態を横断して書き換える。
// 状態そのものは両クラスに置いたままにし、ここは参照を受け取って書くだけに留める。
import { Attractor } from '../../physics/attractor';
import type { Ephemeris } from '../../physics/ephemeris';
import * as C from '../const';
import { Vec3 } from '../../physics/vec3';
import { systemMembersAt } from '../celestial/body-visibility';
import { CameraReferencePlane, OverviewCamera } from '../camera/overview-camera';
import { focusPoint, focusTargetId, FocusTarget } from '../camera/focus-target';
import { AnchorZone } from './anchor-zone';
import { RotationZone } from './rotation-zone';
import { Button, SegmentedControl, Slider, ToggleSwitch, ValueInput } from './widgets';
import { celestialBodyName } from './frame-labels';
import { hudRail } from './hud-root';
import type { MapPickable } from '../map-pickable';
import type { DisplayWindowManager } from '../display-window-manager';
import type { OverlayManager } from './overlay-manager';

// マップ左レールへ置く独立した設定ウィンドウを組む。
function buildPanel(root: HTMLElement, id: string, titleText: string): HTMLElement {
  const panel = document.createElement('div');
  panel.id = id;
  panel.className = 'panel hidden hud-frame-controls';
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());
  const title = document.createElement('h3');
  title.textContent = titleText;
  panel.appendChild(title);
  hudRail(root, 'left').appendChild(panel);
  return panel;
}

export class FrameControls {
  private readonly cameraPanel: HTMLElement;
  private readonly orbitPanel: HTMLElement;
  private readonly cameraCenterZone: AnchorZone;
  private readonly cameraRotationZone: RotationZone;
  private readonly cameraRotationModeToggle: ToggleSwitch;
  private readonly projectionToggle: ToggleSwitch;
  private readonly fovSlider: Slider;
  private readonly fovInput: ValueInput;
  private readonly referencePlaneControl: SegmentedControl<CameraReferencePlane>;
  private readonly aboveButton: Button;
  private readonly sideButton: Button;
  private readonly planCenterZone: AnchorZone;
  private readonly planRotationZone: RotationZone;
  private readonly followToggle: ToggleSwitch;
  private readonly cameraSummary: HTMLElement;
  private readonly orbitSummary: HTMLElement;
  // 計画折れ線の中心をカメラの注視対象へ追随させるか。表示を変えるだけの操作(フォーカス移動)が
  // 描画基準まで動かすと、線の形が変わった理由が操作から読めなくなるので、明示の選択にする。
  private followCamera = true;
  // 固定解除は DOM イベント(フレームの外)から起きるので、直近の sync が見た時刻を控える。
  private lastTime = 0;

  // panelRoot はパネル自体(左ドック)の置き場所、popupRoot は ObjectPicker のポップアップの置き場所。
  public constructor(
    panelRoot: HTMLElement,
    popupRoot: HTMLElement,
    private readonly ephemeris: Ephemeris,
    private readonly overviewCamera: OverviewCamera,
    private readonly displayWindow: DisplayWindowManager,
    overlayManager: OverlayManager,
  ) {
    this.cameraPanel = buildPanel(panelRoot, 'hud-camera-controls', 'カメラ');
    this.cameraCenterZone = new AnchorZone(popupRoot, '基準にする天体', ephemeris, '固定を解除', overlayManager);
    this.cameraCenterZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-origin-zone');
    this.cameraCenterZone.onSelect = (id) => this.selectCameraCenter(id);
    this.cameraPanel.appendChild(this.cameraCenterZone.element);

    this.cameraRotationZone = new RotationZone('視点を一緒に回す', ephemeris);
    this.cameraRotationZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-rotation-zone');
    this.cameraRotationZone.onSelect = (rotatingWith) => overviewCamera.setCameraRotation(rotatingWith);
    this.cameraPanel.appendChild(this.cameraRotationZone.element);

    this.cameraRotationModeToggle = new ToggleSwitch('オイラー操作', (on) => {
      overviewCamera.setCameraRotationMode(on ? 'euler' : 'quaternion');
    });
    this.cameraPanel.appendChild(this.cameraRotationModeToggle.element);

    this.projectionToggle = new ToggleSwitch('平行投影', (on) => {
      overviewCamera.setProjectionMode(on ? 'orthographic' : 'perspective');
    });
    this.cameraPanel.appendChild(this.projectionToggle.element);

    const fovGroup = document.createElement('div');
    fovGroup.className = 'camera-fov-control';
    const fovLabel = document.createElement('span');
    fovLabel.className = 'camera-control-label';
    fovLabel.textContent = '画角';
    fovGroup.appendChild(fovLabel);
    this.fovSlider = new Slider({
      min: C.OVERVIEW_CAMERA_FOV_MIN,
      max: C.OVERVIEW_CAMERA_FOV_MAX,
      step: C.OVERVIEW_CAMERA_FOV_STEP,
    }, (value) => overviewCamera.setFovDeg(value));
    fovGroup.appendChild(this.fovSlider.element);
    this.fovInput = new ValueInput({
      type: 'number',
      min: C.OVERVIEW_CAMERA_FOV_MIN,
      max: C.OVERVIEW_CAMERA_FOV_MAX,
      step: C.OVERVIEW_CAMERA_FOV_STEP,
    }, (text) => overviewCamera.setFovDeg(Number(text)));
    fovGroup.appendChild(this.fovInput.element);
    const fovUnit = document.createElement('span');
    fovUnit.className = 'camera-control-unit';
    fovUnit.textContent = '°';
    fovGroup.appendChild(fovUnit);
    this.cameraPanel.appendChild(fovGroup);

    this.referencePlaneControl = new SegmentedControl<CameraReferencePlane>('視点の基準面', [
      ['ecliptic', '黄道面'],
      ['equator', '赤道面'],
      ['moonOrbit', '月軌道面'],
    ], (plane) => overviewCamera.setReferencePlane(plane));
    this.cameraPanel.appendChild(this.referencePlaneControl.element);

    const referenceViewGroup = document.createElement('div');
    referenceViewGroup.className = 'camera-reference-view-buttons';
    this.aboveButton = new Button('真上', () => overviewCamera.setReferenceView('above'));
    this.sideButton = new Button('真横', () => overviewCamera.setReferenceView('side'));
    referenceViewGroup.append(this.aboveButton.element, this.sideButton.element);
    this.cameraPanel.appendChild(referenceViewGroup);

    this.cameraSummary = document.createElement('div');
    this.cameraSummary.className = 'frame-summary';
    this.cameraPanel.appendChild(this.cameraSummary);

    this.orbitPanel = buildPanel(panelRoot, 'hud-orbit-controls', '軌道');
    // 描く線は必ずどこかの座標系に焼き込まれるので「どこにも固定しない」状態が無く、
    // 太陽系空間への固定はプルダウンの恒星そのものにあたる。
    this.planCenterZone = new AnchorZone(popupRoot, '基準にする天体', ephemeris, null, overlayManager);
    this.planCenterZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-origin-zone');
    this.planCenterZone.onSelect = (id) => {
      if (id === null) return;
      displayWindow.frame = ephemeris.frameOf(id, displayWindow.frame.rotatingWith);
    };
    this.orbitPanel.appendChild(this.planCenterZone.element);

    this.planRotationZone = new RotationZone('線を一緒に回す', ephemeris);
    this.planRotationZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-rotation-zone');
    this.planRotationZone.onSelect = (rotatingWith) => {
      displayWindow.frame = ephemeris.frameOf(displayWindow.frame.center, rotatingWith);
    };
    this.orbitPanel.appendChild(this.planRotationZone.element);

    this.followToggle = new ToggleSwitch('カメラの基準に追随', (on: boolean) => { this.followCamera = on; });
    this.followToggle.setOn(this.followCamera);
    this.orbitPanel.appendChild(this.followToggle.element);

    this.orbitSummary = document.createElement('div');
    this.orbitSummary.className = 'frame-summary';
    this.orbitPanel.appendChild(this.orbitSummary);
  }

  // カメラの基準天体を選び直す。解除は、いま見ている位置を恒星中心の慣性系へ焼き込んだ
  // 固定点にする — どの天体にも追随しないが、視線はその場に留まる。
  private selectCameraCenter(id: string | null): void {
    if (id !== null) {
      this.setFocus({ kind: 'object', id });
      return;
    }
    const starId = this.ephemeris.starId;
    const frame = starId !== null ? this.ephemeris.frameOf(starId, null) : this.ephemeris.inertialFrame;
    this.setFocus(focusPoint(this.ephemeris, frame, this.overviewCamera.resolvedFocus, this.lastTime));
  }

  // マップカメラのフォーカスを target へ移す。追随が有効で target が登録天体を指しているときは
  // 計画折れ線の中心も同じ天体へ合わせる(回転側は現状を保つ)。
  public setFocus(target: FocusTarget): void {
    this.overviewCamera.setFocusTarget(target);
    if (!this.followCamera) return;
    const id = focusTargetId(target);
    if (id !== undefined && id in this.ephemeris.registry) {
      this.displayWindow.frame = this.ephemeris.frameOf(id, this.displayWindow.frame.rotatingWith);
    }
  }

  // いま選ばれているカメラ側の座標系を1行で述べる。
  private cameraSummaryText(): string {
    const camId = focusTargetId(this.overviewCamera.focus);
    const camCenter = camId === undefined ? '固定なし' : celestialBodyName(camId);
    const camRot = this.overviewCamera.cameraFrame.rotatingWith;
    const rotText = (id: string | null): string => (id === null ? '慣性系' : `${celestialBodyName(id)}回転系`);
    const modeText = this.overviewCamera.cameraRotationMode === 'euler' ? 'オイラー' : 'クォータニオン';
    const projectionText = this.overviewCamera.projection === 'orthographic' ? '平行' : '透視';
    return `基準: ${camCenter}・${rotText(camRot)} / ${modeText}・${projectionText}・画角 ${this.overviewCamera.fov.toFixed(0)}°`;
  }

  // いま選ばれている軌道側の座標系を1行で述べる。
  private orbitSummaryText(): string {
    const planCenter = celestialBodyName(this.displayWindow.frame.center);
    const planRot = this.displayWindow.frame.rotatingWith;
    const rotText = (id: string | null): string => (id === null ? '慣性系' : `${celestialBodyName(id)}回転系`);
    return `基準: ${planCenter}・${rotText(planRot)}`;
  }

  // パネルの表示と4ゾーンの選択肢・選択表示を、他モジュールの状態へ合わせる。
  public sync(
    pickables: readonly MapPickable[], cameraPos: Vec3, attractors: readonly Attractor[],
    simTime: number, visible: boolean,
  ): void {
    this.lastTime = simTime;
    this.cameraPanel.classList.toggle('hidden', !visible);
    this.orbitPanel.classList.toggle('hidden', !visible);
    if (!visible) return;

    const members = systemMembersAt(this.ephemeris.registry, cameraPos, attractors);

    this.cameraCenterZone.setItems(pickables);
    this.cameraCenterZone.setNearby(members, pickables);
    this.cameraCenterZone.setSelected(focusTargetId(this.overviewCamera.focus) ?? null);
    this.cameraRotationZone.setNearby(members);
    this.cameraRotationZone.setSelected(this.overviewCamera.cameraFrame.rotatingWith);
    this.cameraRotationModeToggle.setOn(this.overviewCamera.cameraRotationMode === 'euler');
    const isOrthographic = this.overviewCamera.projection === 'orthographic';
    this.projectionToggle.setOn(isOrthographic);
    this.fovSlider.element.disabled = isOrthographic;
    this.fovInput.element.disabled = isOrthographic;
    this.fovSlider.element.title = isOrthographic ? '平行投影では画角は使用しません' : '画角';
    this.fovInput.element.title = isOrthographic ? '平行投影では画角は使用しません' : '画角';
    this.fovSlider.setValue(this.overviewCamera.fov);
    if (document.activeElement !== this.fovInput.element) {
      this.fovInput.setValue(this.overviewCamera.fov.toFixed(0));
    }
    this.referencePlaneControl.setSelected(this.overviewCamera.referencePlane);

    this.planCenterZone.setItems(pickables);
    this.planCenterZone.setNearby(members, pickables);
    this.planCenterZone.setSelected(this.displayWindow.frame.center);
    this.planRotationZone.setNearby(members);
    this.planRotationZone.setSelected(this.displayWindow.frame.rotatingWith);

    this.followToggle.setOn(this.followCamera);
    this.cameraSummary.textContent = this.cameraSummaryText();
    this.orbitSummary.textContent = this.orbitSummaryText();
  }
}

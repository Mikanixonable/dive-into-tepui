// マップモードの「カメラ」パネル。カメラの注視対象・回転系・平行/透視投影・画角・基準面設定を担当する。
import type { Ephemeris } from '../../../physics/ephemeris';
import { FrameRole, frameRoleOf } from '../../../physics/frame';
import * as C from '../../const';
import { CameraReferencePlane, CameraReferenceView, MapCamera } from '../../camera/map-camera';
import { focusTargetId } from '../../camera/focus-target';
import { AnchorZone } from './anchor-zone';
import { RotationZone } from './rotation-zone';
import { Button, Pulldown, type PulldownColumn, Slider, ToggleSwitch, ValueInput } from '../widgets';
import { celestialBodyName, frameRoleName, rotationSourceLabel } from './frame-labels';
import type { MapPickable } from '../../pickable/map-pickable';
import type { OverlayManager } from '../overlay-manager';
import { buildPanel } from './frame-controls';

const ANGLE_COLUMNS = [
  { description: '面', items: [['ecliptic', '黄道面'], ['equator', '赤道面'], ['moonOrbit', '月軌道面']] },
  { description: '視点', items: [['above', '真上'], ['side', '真横']] },
] as const satisfies readonly [PulldownColumn<CameraReferencePlane>, PulldownColumn<CameraReferenceView>];

export class CameraFramePanel {
  private readonly panel: HTMLElement;
  private readonly cameraCenterZone: AnchorZone;
  private readonly cameraRotationZone: RotationZone;
  private readonly cameraRotationModeToggle: ToggleSwitch;
  private readonly projectionToggle: ToggleSwitch;
  private readonly fovSlider: Slider;
  private readonly fovInput: ValueInput;
  private readonly fovResetButton: Button;
  private readonly angleControl: Pulldown<typeof ANGLE_COLUMNS>;
  private readonly cameraSummary: HTMLElement;

  public onSelectCenter: ((id: string | null) => void) | null = null;

  // panelRoot はパネル自身の設置先、popupRoot は AnchorZone のポップアップの親。
  public constructor(
    panelRoot: HTMLElement,
    popupRoot: HTMLElement,
    ephemeris: Ephemeris,
    private readonly mapCamera: MapCamera,
    overlayManager: OverlayManager,
  ) {
    this.panel = buildPanel(panelRoot, 'hud-camera-controls', 'カメラ');

    this.cameraCenterZone = new AnchorZone(popupRoot, '基準', ephemeris, '固定を解除', overlayManager);
    this.cameraCenterZone.element.classList.add('hud-frame-origin-zone');
    this.cameraCenterZone.onSelect = (id) => this.onSelectCenter?.(id);
    this.panel.appendChild(this.cameraCenterZone.element);

    this.cameraRotationZone = new RotationZone('回転追従', ephemeris);
    this.cameraRotationZone.element.classList.add('hud-frame-rotation-zone');
    this.cameraRotationZone.onSelect = (rotatingWith) => mapCamera.setCameraRotation(rotatingWith);
    this.panel.appendChild(this.cameraRotationZone.element);

    this.cameraRotationModeToggle = new ToggleSwitch('クオータニオン操作', (on) => {
      mapCamera.setCameraRotationMode(on ? 'quaternion' : 'euler');
    });
    this.panel.appendChild(this.cameraRotationModeToggle.element);

    this.projectionToggle = new ToggleSwitch('平行投影', (on) => {
      mapCamera.setProjectionMode(on ? 'orthographic' : 'perspective');
    });
    this.panel.appendChild(this.projectionToggle.element);

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
    }, (value) => mapCamera.setFovDeg(value));
    fovGroup.appendChild(this.fovSlider.element);
    this.fovInput = new ValueInput({
      type: 'number',
      min: C.OVERVIEW_CAMERA_FOV_MIN,
      max: C.OVERVIEW_CAMERA_FOV_MAX,
      step: C.OVERVIEW_CAMERA_FOV_STEP,
    }, (text) => mapCamera.setFovDeg(Number(text)));
    fovGroup.appendChild(this.fovInput.element);
    const fovUnit = document.createElement('span');
    fovUnit.className = 'camera-control-unit';
    fovUnit.textContent = '°';
    fovGroup.appendChild(fovUnit);
    this.fovResetButton = new Button('リセット', () => mapCamera.resetFov());
    this.fovResetButton.element.title = '画角をデフォルトに戻す';
    fovGroup.appendChild(this.fovResetButton.element);
    this.panel.appendChild(fovGroup);

    // 面を確定させてから視点をジャンプさせる——真上/真横は現在の基準面からの相対視点のため。
    this.angleControl = new Pulldown('角度', ANGLE_COLUMNS, 'セット', ([plane, view]) => {
      mapCamera.setReferencePlane(plane);
      mapCamera.setReferenceView(view);
    });
    this.angleControl.element.classList.add('camera-angle-group');
    this.panel.appendChild(this.angleControl.element);

    this.cameraSummary = document.createElement('div');
    this.cameraSummary.className = 'frame-summary';
    this.panel.appendChild(this.cameraSummary);
  }

  // パネル下部に表示するサマリ行の文字列を組み立てる。
  private cameraSummaryText(): string {
    const camId = focusTargetId(this.mapCamera.focus);
    const camRole = camId === undefined ? null : frameRoleOf(camId);
    const camCenter = camId === undefined ? '固定なし' : camRole !== null ? frameRoleName(camRole) : celestialBodyName(camId);
    const camRot = this.mapCamera.cameraFrame.rotatingWith;
    const modeText = this.mapCamera.cameraRotationMode === 'euler' ? 'オイラー' : 'クォータニオン';
    const projectionText = this.mapCamera.projection === 'orthographic' ? '平行' : '透視';
    return `基準: ${camCenter}・${rotationSourceLabel(camRot)} / ${modeText}・${projectionText}・画角 ${this.mapCamera.fov.toFixed(0)}°`;
  }

  // パネルの表示と各ウィジェットの選択・有効状態を、渡された時刻・カメラ状態へ合わせる。
  public sync(
    pickables: readonly MapPickable[], members: readonly string[], displayTime: number,
    validRoles: readonly FrameRole[], isVisible: boolean,
  ): void {
    this.panel.classList.toggle('hidden', !isVisible);
    if (!isVisible) return;

    // カメラ基準は表示設定に左右されず、登録済みの全天体を選択できるようにする。
    this.cameraCenterZone.setItems(pickables, true);
    this.cameraCenterZone.setNearby(members, pickables);
    this.cameraCenterZone.setSelected(focusTargetId(this.mapCamera.focus) ?? null);

    // 回転追従の選択肢と、クオータニオン/オイラーの操作モード表示を合わせる。
    this.cameraRotationZone.setNearby(members, displayTime, validRoles);
    this.cameraRotationZone.setSelected(this.mapCamera.cameraFrame.rotatingWith);
    this.cameraRotationModeToggle.setOn(this.mapCamera.cameraRotationMode === 'quaternion');

    // 平行投影は画角という概念自体を欠くため、画角の操作系一式を無効化して案内を出す。
    const isOrthographic = this.mapCamera.projection === 'orthographic';
    this.projectionToggle.setOn(isOrthographic);
    this.fovSlider.element.disabled = isOrthographic;
    this.fovInput.element.disabled = isOrthographic;
    this.fovResetButton.setEnabled(!isOrthographic);
    this.fovSlider.element.title = isOrthographic ? '平行投影では画角は使用しません' : '画角';
    this.fovInput.element.title = isOrthographic ? '平行投影では画角は使用しません' : '画角';
    this.fovSlider.setValue(this.mapCamera.fov);
    if (document.activeElement !== this.fovInput.element) {
      this.fovInput.setValue(this.mapCamera.fov.toFixed(0));
    }

    // 角度プルダウンの選択表示とサマリ行を最後に合わせる。
    this.angleControl.setSelected(0, this.mapCamera.referencePlane);
    this.cameraSummary.textContent = this.cameraSummaryText();
  }

  // 保持しているゾーンとパネル要素を片付ける。
  public dispose(): void {
    this.cameraCenterZone.dispose();
    this.panel.remove();
  }
}

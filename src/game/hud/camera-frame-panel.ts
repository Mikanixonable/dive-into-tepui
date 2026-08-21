// マップモードの「カメラ」パネル。カメラの注視対象・回転系・平行/透視投影・画角・基準面設定を担当する。
import type { Ephemeris } from '../../physics/ephemeris';
import * as C from '../const';
import { CameraReferencePlane, CameraReferenceView, MapCamera } from '../camera/map-camera';
import { focusTargetId } from '../camera/focus-target';
import { AnchorZone } from './anchor-zone';
import { RotationZone } from './rotation-zone';
import { Button, Pulldown, Slider, ToggleSwitch, ValueInput } from './widgets';
import { celestialBodyName } from './frame-labels';
import { hudRail } from './hud-root';
import type { MapPickable } from '../map-pickable';
import type { OverlayManager } from './overlay-manager';

const PLANE_ITEMS: readonly (readonly [CameraReferencePlane, string])[] = [
  ['ecliptic', '黄道面'],
  ['equator', '赤道面'],
  ['moonOrbit', '月軌道面'],
];

const VIEW_ITEMS: readonly (readonly [CameraReferenceView, string])[] = [
  ['above', '真上'],
  ['side', '真横'],
];

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

export class CameraFramePanel {
  private readonly panel: HTMLElement;
  private readonly cameraCenterZone: AnchorZone;
  private readonly cameraRotationZone: RotationZone;
  private readonly cameraRotationModeToggle: ToggleSwitch;
  private readonly projectionToggle: ToggleSwitch;
  private readonly fovSlider: Slider;
  private readonly fovInput: ValueInput;
  private readonly fovResetButton: Button;
  private readonly planeControl: Pulldown<CameraReferencePlane>;
  private readonly viewControl: Pulldown<CameraReferenceView>;
  private readonly cameraSummary: HTMLElement;

  public onSelectCenter: ((id: string | null) => void) | null = null;

  public constructor(
    panelRoot: HTMLElement,
    popupRoot: HTMLElement,
    ephemeris: Ephemeris,
    private readonly mapCamera: MapCamera,
    overlayManager: OverlayManager,
  ) {
    this.panel = buildPanel(panelRoot, 'hud-camera-controls', 'カメラ');

    this.cameraCenterZone = new AnchorZone(popupRoot, '基準天体', ephemeris, '固定を解除', overlayManager);
    this.cameraCenterZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-origin-zone');
    this.cameraCenterZone.onSelect = (id) => this.onSelectCenter?.(id);
    this.panel.appendChild(this.cameraCenterZone.element);

    this.cameraRotationZone = new RotationZone('回転フレーム', ephemeris);
    this.cameraRotationZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-rotation-zone');
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

    this.planeControl = new Pulldown<CameraReferencePlane>('角度', PLANE_ITEMS, 'セット', (plane) => mapCamera.setReferencePlane(plane));
    this.planeControl.element.classList.add('camera-angle-group');
    this.panel.appendChild(this.planeControl.element);

    this.viewControl = new Pulldown<CameraReferenceView>('視点', VIEW_ITEMS, 'セット', (view) => mapCamera.setReferenceView(view));
    this.viewControl.element.classList.add('camera-angle-group');
    this.panel.appendChild(this.viewControl.element);

    this.cameraSummary = document.createElement('div');
    this.cameraSummary.className = 'frame-summary';
    this.panel.appendChild(this.cameraSummary);
  }

  private cameraSummaryText(): string {
    const camId = focusTargetId(this.mapCamera.focus);
    const camCenter = camId === undefined ? '固定なし' : celestialBodyName(camId);
    const camRot = this.mapCamera.cameraFrame.rotatingWith;
    const rotText = (id: string | null): string => (id === null ? '慣性系' : `${celestialBodyName(id)}回転系`);
    const modeText = this.mapCamera.cameraRotationMode === 'euler' ? 'オイラー' : 'クォータニオン';
    const projectionText = this.mapCamera.projection === 'orthographic' ? '平行' : '透視';
    return `基準: ${camCenter}・${rotText(camRot)} / ${modeText}・${projectionText}・画角 ${this.mapCamera.fov.toFixed(0)}°`;
  }

  public sync(pickables: readonly MapPickable[], members: readonly string[], isVisible: boolean): void {
    this.panel.classList.toggle('hidden', !isVisible);
    if (!isVisible) return;

    this.cameraCenterZone.setItems(pickables);
    this.cameraCenterZone.setNearby(members, pickables);
    this.cameraCenterZone.setSelected(focusTargetId(this.mapCamera.focus) ?? null);
    this.cameraRotationZone.setNearby(members);
    this.cameraRotationZone.setSelected(this.mapCamera.cameraFrame.rotatingWith);
    this.cameraRotationModeToggle.setOn(this.mapCamera.cameraRotationMode === 'quaternion');
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
    this.planeControl.setSelected(this.mapCamera.referencePlane);
    this.cameraSummary.textContent = this.cameraSummaryText();
  }

  public dispose(): void {
    this.cameraCenterZone.dispose();
    this.panel.remove();
  }
}

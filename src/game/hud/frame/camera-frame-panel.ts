// マップビューの詳細な「カメラ」パネル。カメラの注視対象・回転追従・平行/透視投影・画角・
// 基準面設定を担当する。
import { frameRoleOf } from '../../../physics/frame';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import {
  CameraReferencePlane, CameraReferenceView, FOCUS_CAMERA_FOV_MIN, FOCUS_CAMERA_FOV_MAX,
  type CameraRotationFollow,
} from '../../viewer/focus-camera-selection';
import { AnchorZone } from './anchor-zone';
import { CameraRotationZone } from './rotation-zone';
import { Button, Pulldown, type PulldownColumn, Slider, ToggleSwitch, ValueInput } from '../../../hud/widgets';
import { CameraRotationModeControl, type CameraRotationModeCommands } from './camera-rotation-mode-control';
import { frameRoleName, rotationFollowLabel } from './frame-labels';
import type { OverlayManager } from '../../../hud/overlay-manager';
import { buildPanel } from './frame-panel';
import type { ListedObject } from '../../pickable/listed-object';
import type { CameraRotationMode } from '../../viewer/camera-orientation';
import type { ProjectionMode } from '../../../math/projection';

const FOCUS_CAMERA_FOV_STEP = 1; // HUD から入力する画角の刻み [deg]

const ANGLE_COLUMNS = [
  { description: '面', items: [['ecliptic', '黄道面'], ['equator', '赤道面'], ['moonOrbit', '月軌道面']] },
  { description: '視点', items: [['above', '真上'], ['side', '真横']] },
] as const satisfies readonly [PulldownColumn<CameraReferencePlane>, PulldownColumn<CameraReferenceView>];

// カメラパネルが1フレームに映すカメラの状態。
export interface CameraFrameViewModel {
  // 注視している対象の天体 id。どこにも固定していなければ null。
  readonly focusId: string | null;
  readonly rotationFollow: CameraRotationFollow | null;
  readonly availableRotationFollows: readonly CameraRotationFollow[];
  readonly cameraRotationMode: CameraRotationMode;
  readonly projection: ProjectionMode;
  readonly fovDeg: number;
  readonly referencePlane: CameraReferencePlane;
}

// カメラパネルの操作を受け付けるインターフェース。
export interface CameraFrameCommands extends CameraRotationModeCommands {
  setRotationFollow(follow: CameraRotationFollow | null): void;
  setProjectionMode(mode: ProjectionMode): void;
  setFovDeg(fovDeg: number): void;
  resetFov(): void;
  setReferencePlane(plane: CameraReferencePlane): void;
  setReferenceView(view: CameraReferenceView): void;
}

export class CameraFramePanel {
  private readonly panel: HTMLElement;
  private readonly cameraCenterZone: AnchorZone;
  private readonly cameraRotationZone: CameraRotationZone;
  private readonly cameraRotationModeControl: CameraRotationModeControl;
  private readonly projectionToggle: ToggleSwitch;
  private readonly fovSlider: Slider;
  private readonly fovInput: ValueInput;
  private readonly fovResetButton: Button;
  private readonly fovNote: HTMLElement;
  private readonly angleControl: Pulldown<typeof ANGLE_COLUMNS>;
  private readonly stateFocus: HTMLElement;
  private readonly stateLens: HTMLElement;
  private readonly stateFov: HTMLElement;
  private readonly stateRotation: HTMLElement;
  private readonly stateBasis: HTMLElement;

  public onSelectCenter: ((id: string | null) => void) | null = null;

  // panelRoot はパネル自身の設置先、popupRoot は AnchorZone のポップアップの親。
  // 操作は commands へ返し、初期の回転モードだけトグルの点灯に使う。
  public constructor(
    panelRoot: HTMLElement,
    popupRoot: HTMLElement,
    private readonly celestialBodies: CelestialBodies,
    commands: CameraFrameCommands,
    overlayManager: OverlayManager,
    initialRotationMode: CameraRotationMode,
  ) {
    this.panel = buildPanel(panelRoot, 'hud-camera-controls', 'CAMERA', 'CAM');

    const state = document.createElement('section');
    state.className = 'editorial-state camera-state';
    state.innerHTML = `
      <div class="editorial-state-hero">
        <span class="ui-data-label">FOCUS</span>
        <strong data-camera-state="focus">—</strong>
      </div>
      <div class="camera-state-lens">
        <div>
          <span class="ui-data-label">LENS</span>
          <strong class="ui-data-major" data-camera-state="lens">—</strong>
        </div>
        <div>
          <span class="ui-data-label">FIELD OF VIEW</span>
          <strong class="ui-data-hero" data-camera-state="fov">—</strong>
        </div>
      </div>
      <div class="editorial-state-grid">
        <div class="editorial-state-cell"><span class="ui-data-label">ROTATION</span><span data-camera-state="rotation">—</span></div>
        <div class="editorial-state-cell"><span class="ui-data-label">ATTITUDE BASIS</span><span data-camera-state="basis">—</span></div>
      </div>`;
    this.panel.appendChild(state);
    this.stateFocus = state.querySelector<HTMLElement>('[data-camera-state="focus"]')!;
    this.stateLens = state.querySelector<HTMLElement>('[data-camera-state="lens"]')!;
    this.stateFov = state.querySelector<HTMLElement>('[data-camera-state="fov"]')!;
    this.stateRotation = state.querySelector<HTMLElement>('[data-camera-state="rotation"]')!;
    this.stateBasis = state.querySelector<HTMLElement>('[data-camera-state="basis"]')!;

    const controls = document.createElement('div');
    controls.className = 'editorial-control-zone camera-control-zone';
    this.panel.appendChild(controls);

    this.cameraCenterZone = new AnchorZone(popupRoot, '基準', celestialBodies, '固定を解除', overlayManager);
    this.cameraCenterZone.element.classList.add('hud-frame-origin-zone');
    this.cameraCenterZone.onSelect = (id) => this.onSelectCenter?.(id);
    controls.appendChild(this.cameraCenterZone.element);

    this.cameraRotationZone = new CameraRotationZone('回転追従', celestialBodies);
    this.cameraRotationZone.element.classList.add('hud-frame-rotation-zone');
    this.cameraRotationZone.onSelect = (follow) => commands.setRotationFollow(follow);
    controls.appendChild(this.cameraRotationZone.element);

    this.cameraRotationModeControl = new CameraRotationModeControl(commands, initialRotationMode);
    controls.appendChild(this.cameraRotationModeControl.element);

    this.projectionToggle = new ToggleSwitch('平行投影', (on) => {
      commands.setProjectionMode(on ? 'orthographic' : 'perspective');
    });
    controls.appendChild(this.projectionToggle.element);

    const fovGroup = document.createElement('div');
    fovGroup.className = 'camera-fov-control';
    const fovLabel = document.createElement('span');
    fovLabel.className = 'camera-control-label';
    fovLabel.textContent = '画角';
    fovGroup.appendChild(fovLabel);
    this.fovSlider = new Slider({
      min: FOCUS_CAMERA_FOV_MIN,
      max: FOCUS_CAMERA_FOV_MAX,
      step: FOCUS_CAMERA_FOV_STEP,
    }, (value) => commands.setFovDeg(value));
    fovGroup.appendChild(this.fovSlider.element);
    this.fovInput = new ValueInput({
      type: 'number',
      min: FOCUS_CAMERA_FOV_MIN,
      max: FOCUS_CAMERA_FOV_MAX,
      step: FOCUS_CAMERA_FOV_STEP,
    }, (text) => commands.setFovDeg(Number(text)));
    fovGroup.appendChild(this.fovInput.element);
    const fovUnit = document.createElement('span');
    fovUnit.className = 'camera-control-unit';
    fovUnit.textContent = '°';
    fovGroup.appendChild(fovUnit);
    this.fovResetButton = new Button('リセット', () => commands.resetFov());
    this.fovResetButton.element.title = '画角をデフォルトに戻す';
    fovGroup.appendChild(this.fovResetButton.element);
    // 平行投影で画角一式が効かない理由はホバー説明に置かず、常時表示の注記で示す。
    this.fovNote = document.createElement('small');
    this.fovNote.className = 'camera-fov-note hidden';
    this.fovNote.textContent = '平行投影では画角は使用しません';
    fovGroup.appendChild(this.fovNote);
    controls.appendChild(fovGroup);

    // 面を確定させてから視点をジャンプさせる——真上/真横は現在の基準面からの相対視点のため。
    this.angleControl = new Pulldown('角度', ANGLE_COLUMNS, 'セット', ([plane, view]) => {
      commands.setReferencePlane(plane);
      commands.setReferenceView(view);
    });
    this.angleControl.element.classList.add('camera-angle-group');
    controls.appendChild(this.angleControl.element);

  }

  private focusLabel(view: CameraFrameViewModel): string {
    const camId = view.focusId;
    const camRole = camId === null ? null : frameRoleOf(camId);
    return camId === null ? 'UNBOUND'
      : camRole !== null ? frameRoleName(camRole) : this.celestialBodies.nameOf(camId);
  }

  // 各ウィジェットの選択・有効状態を、渡された候補列とカメラの状態へ合わせる。
  public sync(
    pickables: readonly ListedObject[], members: readonly string[], view: CameraFrameViewModel,
  ): void {
    // カメラ基準は表示設定に左右されず、登録済みの全天体を選択できるようにする。
    this.cameraCenterZone.setItems(pickables, true);
    this.cameraCenterZone.setNearby(members, pickables);
    this.cameraCenterZone.setSelected(view.focusId);

    // 回転追従の選択肢と、クォータニオン/オイラーの操作モード表示を合わせる。
    this.cameraRotationZone.setChoices(view.availableRotationFollows);
    this.cameraRotationZone.setSelected(view.rotationFollow);
    this.cameraRotationModeControl.sync(view.cameraRotationMode);

    // 平行投影は画角という概念自体を欠くため、画角の操作系一式を無効化して案内を出す。
    const isOrthographic = view.projection === 'orthographic';
    this.projectionToggle.setOn(isOrthographic);
    this.fovSlider.element.disabled = isOrthographic;
    this.fovInput.element.disabled = isOrthographic;
    this.fovResetButton.setEnabled(!isOrthographic);
    this.fovSlider.element.title = isOrthographic ? '平行投影では画角は使用しません' : '画角';
    this.fovInput.element.title = isOrthographic ? '平行投影では画角は使用しません' : '画角';
    this.fovNote.classList.toggle('hidden', !isOrthographic);
    this.fovSlider.setValue(view.fovDeg);
    if (document.activeElement !== this.fovInput.element) {
      this.fovInput.setValue(view.fovDeg.toFixed(0));
    }

    // 角度プルダウンと、上段の「現在状態」表示を最後に合わせる。
    this.angleControl.setSelected(0, view.referencePlane);
    this.stateFocus.textContent = this.focusLabel(view);
    this.stateLens.textContent = view.projection === 'orthographic' ? 'ORTHOGRAPHIC' : 'PERSPECTIVE';
    this.stateFov.textContent = isOrthographic ? 'N/A' : `${view.fovDeg.toFixed(0)}°`;
    this.stateRotation.textContent = rotationFollowLabel(this.celestialBodies, view.rotationFollow);
    this.stateBasis.textContent = view.cameraRotationMode === 'euler' ? 'EULER' : 'QUATERNION';
  }

  // 保持しているゾーンとパネル要素を片付ける。
  public dispose(): void {
    this.cameraCenterZone.dispose();
    this.panel.remove();
  }
}

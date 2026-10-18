// マップビューの詳細な「カメラ」パネル。カメラの注視対象・回転追従・平行/透視投影・画角・
// 基準面設定を担当する。見出しに投影と画角、識別行に注視対象を示し、操作部は選択状態をそのまま映す。
import { frameRoleOf } from '../../../physics/frame';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import {
  type CameraReferencePlane, type CameraReferenceView, FOCUS_CAMERA_FOV_MIN, FOCUS_CAMERA_FOV_MAX,
  type CameraRotationFollow,
} from '../../viewer/focus-camera-selection';
import { AnchorZone } from './anchor-zone';
import { CameraRotationZone } from './rotation-zone';
import { Button, Pulldown, type PulldownColumn, Slider, ToggleSwitch, ValueInput } from '../../../hud/widgets';
import { CameraRotationModeControl, type CameraRotationModeCommands } from './camera-rotation-mode-control';
import { frameRoleName } from './frame-labels';
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

// buildFovControl が組み立てた画角行の部品一式。
interface CameraFovDom {
  readonly element: HTMLElement;
  readonly slider: Slider;
  readonly input: ValueInput;
  readonly resetButton: Button;
  readonly note: HTMLElement;
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
  private readonly headMeta: HTMLElement;
  private readonly focusName: HTMLElement;

  public onSelectCenter: ((id: string | null) => void) | null = null;

  // panelRoot はパネル自身の設置先。
  // 操作は commands へ返し、初期の回転モードだけトグルの点灯に使う。
  public constructor(
    panelRoot: HTMLElement,
    private readonly celestialBodies: CelestialBodies,
    commands: CameraFrameCommands,
    overlayManager: OverlayManager,
    initialRotationMode: CameraRotationMode,
  ) {
    this.panel = buildPanel(panelRoot, 'hud-camera-controls', 'カメラ', 'CAM');

    this.headMeta = this.panel.querySelector<HTMLElement>('.ui-head-meta')!;

    // 注視対象の識別行。
    const ident = document.createElement('div');
    ident.className = 'ui-ident';
    const identGlyph = document.createElement('span');
    identGlyph.className = 'ui-ident-glyph';
    identGlyph.setAttribute('aria-hidden', 'true');
    identGlyph.textContent = '◎';
    this.focusName = document.createElement('span');
    this.focusName.className = 'ui-ident-name';
    const identRole = document.createElement('span');
    identRole.className = 'ui-ident-role';
    identRole.textContent = 'FOCUS';
    ident.append(identGlyph, this.focusName, identRole);
    this.panel.appendChild(ident);

    // 投影・画角・操作モードの行。選択状態は操作部がそのまま示す。
    const rows = document.createElement('div');
    rows.className = 'ui-rows camera-rows';
    this.panel.appendChild(rows);
    this.projectionToggle = new ToggleSwitch('平行投影', (on) => {
      commands.setProjectionMode(on ? 'orthographic' : 'perspective');
    });
    rows.appendChild(this.projectionToggle.element);
    const fov = this.buildFovControl(commands);
    this.fovSlider = fov.slider;
    this.fovInput = fov.input;
    this.fovResetButton = fov.resetButton;
    this.fovNote = fov.note;
    rows.appendChild(fov.element);
    this.cameraRotationModeControl = new CameraRotationModeControl(commands, initialRotationMode);
    rows.appendChild(this.cameraRotationModeControl.element);

    // 回転追従。
    this.cameraRotationZone = new CameraRotationZone('回転追従', celestialBodies);
    this.cameraRotationZone.onSelect = (follow) => commands.setRotationFollow(follow);
    this.panel.appendChild(this.cameraRotationZone.element);

    // 視点を合わせる: 基準と、基準面からの角度。
    const align = document.createElement('div');
    align.className = 'ui-sub';
    align.textContent = '視点を合わせる';
    this.panel.appendChild(align);
    this.cameraCenterZone = new AnchorZone('基準', celestialBodies, '固定を解除', overlayManager);
    this.cameraCenterZone.onSelect = (id) => this.onSelectCenter?.(id);
    this.panel.appendChild(this.cameraCenterZone.element);
    // 面を確定させてから視点をジャンプさせる——真上/真横は現在の基準面からの相対視点のため。
    this.angleControl = new Pulldown('角度', ANGLE_COLUMNS, 'セット', ([plane, view]) => {
      commands.setReferencePlane(plane);
      commands.setReferenceView(view);
    });
    this.angleControl.element.classList.add('camera-angle-group');
    this.panel.appendChild(this.angleControl.element);
  }

  // 画角のスライダー・数値入力・リセット・平行投影時の注記を一行に組む。
  // 平行投影で効かない理由はホバー説明に置かず、常時表示の注記で示す。
  private buildFovControl(commands: CameraFrameCommands): CameraFovDom {
    const element = document.createElement('div');
    element.className = 'camera-fov-control';
    const label = document.createElement('span');
    label.className = 'camera-control-label';
    label.textContent = '画角';
    element.appendChild(label);
    const slider = new Slider({
      min: FOCUS_CAMERA_FOV_MIN,
      max: FOCUS_CAMERA_FOV_MAX,
      step: FOCUS_CAMERA_FOV_STEP,
    }, (value) => commands.setFovDeg(value));
    element.appendChild(slider.element);
    const input = new ValueInput({
      type: 'number',
      min: FOCUS_CAMERA_FOV_MIN,
      max: FOCUS_CAMERA_FOV_MAX,
      step: FOCUS_CAMERA_FOV_STEP,
    }, (text) => commands.setFovDeg(Number(text)));
    element.appendChild(input.element);
    const unit = document.createElement('span');
    unit.className = 'camera-control-unit';
    unit.textContent = '°';
    element.appendChild(unit);
    const resetButton = new Button('⟲', () => commands.resetFov(), undefined, 'icon');
    resetButton.element.title = '画角をデフォルトに戻す';
    resetButton.element.setAttribute('aria-label', '画角をデフォルトに戻す');
    element.appendChild(resetButton.element);
    const note = document.createElement('small');
    note.className = 'camera-fov-note hidden';
    note.textContent = '平行投影では画角は使用しません';
    element.appendChild(note);
    return { element, slider, input, resetButton, note };
  }

  private focusLabel(view: CameraFrameViewModel): string {
    const camId = view.focusId;
    const camRole = camId === null ? null : frameRoleOf(camId);
    return camId === null ? '固定なし'
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

    // 角度プルダウンと、見出し・識別行の表示を最後に合わせる。
    this.angleControl.setSelected(0, view.referencePlane);
    this.renderText(this.focusName, this.focusLabel(view));
    this.renderText(this.headMeta, isOrthographic ? '平行' : `透視 ${view.fovDeg.toFixed(0)}°`);
  }

  // 変わったときだけ文字を書く(毎フレームの再代入はレイアウト再計算を招く)。
  private renderText(el: HTMLElement, text: string): void {
    if (el.textContent !== text) el.textContent = text;
  }

  // 保持しているゾーンとパネル要素を片付ける。
  public dispose(): void {
    this.cameraCenterZone.dispose();
    this.panel.remove();
  }
}

// 座標系パネル下段の光学バー(投影切替・操作軸チップ・詳細展開)と詳細ドロワー(FOV・操作軸)。
import type { ProjectionMode } from '../../../math/projection';
import type { CameraRotationMode } from '../../viewer/camera-orientation';
import { FOCUS_CAMERA_FOV_MAX, FOCUS_CAMERA_FOV_MIN } from '../../viewer/focus-camera-selection';
import { Button, Slider, ValueInput } from '../../../hud/widgets';
import { expandHitTarget } from '../../../hud/widgets/widget-base';
import { CameraRotationModeControl, type CameraRotationModeCommands } from './camera-rotation-mode-control';
import { projectionGlyphSvg } from './frame-glyphs';

const FOCUS_CAMERA_FOV_STEP = 1; // 画角入力の刻み [deg]

export interface CameraOpticsCommands extends CameraRotationModeCommands {
  setProjectionMode(mode: ProjectionMode): void;
  setFovDeg(fovDeg: number): void;
  resetFov(): void;
}

export class CameraOpticsBar {
  public readonly element: HTMLElement;
  private readonly projBtn: HTMLButtonElement;
  private readonly projIcon: HTMLElement;
  private readonly projLabel: HTMLElement;
  private readonly rotModeChip: HTMLButtonElement;
  private readonly detailToggle: HTMLButtonElement;
  private readonly detailDrawer: HTMLElement;
  private readonly fovSlider: Slider;
  private readonly fovInput: ValueInput;
  private readonly fovResetButton: Button;
  private readonly fovNote: HTMLElement;
  private readonly rotModeControl: CameraRotationModeControl;

  private lastOrtho = false;
  private lastQuat = false;
  private lastProjGlyphOrtho: boolean | null = null;
  private detailOpen = false;

  public constructor(
    private readonly commands: CameraOpticsCommands,
    initialRotationMode: CameraRotationMode,
  ) {
    this.element = document.createElement('div');

    const footer = document.createElement('div');
    footer.className = 'fc-footer-bar';
    const chips = document.createElement('div');
    chips.className = 'fc-footer-chips';

    this.projBtn = document.createElement('button');
    this.projBtn.type = 'button';
    this.projBtn.className = 'fc-chip';
    expandHitTarget(this.projBtn);
    this.projBtn.title = '透視投影と平行投影を切り替える';
    this.projIcon = document.createElement('span');
    this.projIcon.className = 'fc-chip-icon';
    this.projLabel = document.createElement('span');
    this.projBtn.append(this.projIcon, this.projLabel);
    this.projBtn.addEventListener('click', (e) => {
      if (e.isTrusted) this.projBtn.blur();
      this.commands.setProjectionMode(this.lastOrtho ? 'perspective' : 'orthographic');
    });

    this.rotModeChip = document.createElement('button');
    this.rotModeChip.type = 'button';
    this.rotModeChip.className = 'fc-chip fc-chip-mono';
    expandHitTarget(this.rotModeChip);
    this.rotModeChip.title = 'カメラの回転操作軸(オイラー / クォータニオン)を切り替える';
    this.rotModeChip.addEventListener('click', (e) => {
      if (e.isTrusted) this.rotModeChip.blur();
      this.commands.setCameraRotationMode(this.lastQuat ? 'euler' : 'quaternion');
    });

    chips.append(this.projBtn, this.rotModeChip);

    this.detailToggle = document.createElement('button');
    this.detailToggle.type = 'button';
    this.detailToggle.className = 'fc-chip';
    expandHitTarget(this.detailToggle);
    this.detailToggle.setAttribute('aria-expanded', 'false');
    this.detailToggle.textContent = '詳細 ▾';
    this.detailToggle.addEventListener('click', (e) => {
      if (e.isTrusted) this.detailToggle.blur();
      this.detailOpen = !this.detailOpen;
      this.detailDrawer.classList.toggle('hidden', !this.detailOpen);
      this.detailToggle.setAttribute('aria-expanded', String(this.detailOpen));
      this.detailToggle.textContent = this.detailOpen ? '詳細 ▴' : '詳細 ▾';
    });

    footer.append(chips, this.detailToggle);
    this.element.appendChild(footer);

    // 詳細ドロワー(画角スライダー・入力・リセット + 操作軸トグル)。
    this.detailDrawer = document.createElement('div');
    this.detailDrawer.className = 'fc-detail-drawer hidden';
    const fovRow = document.createElement('div');
    fovRow.className = 'camera-fov-control';
    const fovTitle = document.createElement('span');
    fovTitle.className = 'camera-control-label';
    fovTitle.textContent = '画角 (FOV)';
    this.fovSlider = new Slider({
      min: FOCUS_CAMERA_FOV_MIN, max: FOCUS_CAMERA_FOV_MAX, step: FOCUS_CAMERA_FOV_STEP,
    }, (value) => commands.setFovDeg(value));
    this.fovInput = new ValueInput({
      type: 'number', min: FOCUS_CAMERA_FOV_MIN, max: FOCUS_CAMERA_FOV_MAX, step: FOCUS_CAMERA_FOV_STEP,
    }, (text) => commands.setFovDeg(Number(text)));
    const unit = document.createElement('span');
    unit.className = 'camera-control-unit';
    unit.textContent = '°';
    this.fovResetButton = new Button('既定', () => commands.resetFov());
    this.fovResetButton.element.title = '画角をデフォルトに戻す';
    this.fovNote = document.createElement('small');
    this.fovNote.className = 'camera-fov-note hidden';
    this.fovNote.textContent = '平行投影では画角は使用しません';
    fovRow.append(
      fovTitle, this.fovSlider.element, this.fovInput.element, unit,
      this.fovResetButton.element, this.fovNote,
    );
    this.rotModeControl = new CameraRotationModeControl(commands, initialRotationMode);
    this.detailDrawer.append(fovRow, this.rotModeControl.element);
    this.element.appendChild(this.detailDrawer);
  }

  public sync(projection: ProjectionMode, fovDeg: number, rotationMode: CameraRotationMode): void {
    this.lastOrtho = projection === 'orthographic';
    this.lastQuat = rotationMode === 'quaternion';

    this.projBtn.classList.toggle('on', this.lastOrtho);
    this.projBtn.setAttribute('aria-pressed', String(this.lastOrtho));
    if (this.lastProjGlyphOrtho !== this.lastOrtho) {
      this.lastProjGlyphOrtho = this.lastOrtho;
      this.projIcon.innerHTML = projectionGlyphSvg(this.lastOrtho);
    }
    this.projLabel.textContent = this.lastOrtho ? '平行投影' : `透視 ${fovDeg.toFixed(0)}°`;

    this.rotModeChip.textContent = this.lastQuat ? 'QUAT' : 'EUL';
    this.rotModeChip.classList.toggle('on', this.lastQuat);
    this.rotModeChip.setAttribute('aria-pressed', String(this.lastQuat));

    this.rotModeControl.sync(rotationMode);
    this.fovSlider.element.disabled = this.lastOrtho;
    this.fovInput.element.disabled = this.lastOrtho;
    this.fovResetButton.setEnabled(!this.lastOrtho);
    this.fovSlider.element.title = this.lastOrtho ? '平行投影では画角は使用しません' : '画角';
    this.fovInput.element.title = this.lastOrtho ? '平行投影では画角は使用しません' : '画角';
    this.fovNote.classList.toggle('hidden', !this.lastOrtho);
    this.fovSlider.setValue(fovDeg);
    if (document.activeElement !== this.fovInput.element) {
      this.fovInput.setValue(fovDeg.toFixed(0));
    }
  }
}

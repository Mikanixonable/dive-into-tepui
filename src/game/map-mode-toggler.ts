import { Hud } from './hud/hud';
import { CameraSystem } from './camera/camera-system';
import { TouchControls } from './input/touch';
import type { Input } from './input/input';
import { KEY_MAPPING as K } from './input/key-mapping';
import { PlanEditor } from './plan/plan-editor';
import { DisplayTimeManager } from './display-time-manager';
import { MapPicker } from './map-picker';

export class MapModeToggler {
  private _mapMode: boolean;
  private touchControls: TouchControls | null = null;

  get mapMode(): boolean { return this._mapMode; }

  constructor(
    private readonly hud: Hud,
    private readonly editor: PlanEditor,
    private readonly cameraSystem: CameraSystem,
    private readonly displayTimeManager: DisplayTimeManager,
    private readonly mapPicker: MapPicker,
    initialMapMode = false,
  ) {
    this._mapMode = initialMapMode;
    this.apply(initialMapMode);
  }

  setTouchControls(controls: TouchControls | null): void {
    this.touchControls = controls;
    controls?.setMapMode(this._mapMode);
  }

  ensureOpen(): void {
    if (!this._mapMode) this.open();
  }

  private apply(open: boolean): void {
    this._mapMode = open;
    this.touchControls?.setMapMode(open);
    this.cameraSystem.setMapMode(open);
    this.editor.setMapMode(open);
    this.displayTimeManager.forceCurrent = !open;
  }

  private open(): void {
    this.editor.selectedNodeIdx = null;
    this.apply(true);
  }

  private close(): void {
    this.editor.onMapClosed();
    this.editor.closeMenu();
    this.mapPicker.close();
    this.apply(false);
  }

  update(input: Input, isPlaying: boolean, canToggleView: boolean): void {
    if (!isPlaying) {
      if (this._mapMode) this.close();
      return;
    }
    if (!canToggleView || !input.takeKey(K.toggleMapMode)) return;

    if (this._mapMode) {
      this.close();
      if (this.editor.plan.nodes.length > 0) {
        this.hud.hint(`マニューバ計画 ${this.editor.plan.nodes.length} 件確定 — [${K.autoWarpToNode.label}] で直近ノードへ自動ワープ`, 4500);
      }
      return;
    }

    this.open();
    this.hud.hint(
      `軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [${K.toggleMapMode.label}] で確定`,
      5000,
    );
  }
}

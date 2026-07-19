import { Hud } from '../../hud/hud';
import { MapPlanner } from './planner';
import { TouchControls } from '../touch';

export class MapModeController {
  enabled = false;

  constructor(
    private readonly hud: Hud,
    private readonly planner: MapPlanner,
  ) {}

  syncWithPhase(phase: string, touchControls: TouchControls | null): void {
    if (phase !== 'playing' && this.enabled) {
      this.enabled = false;
      this.hud.setPlanPanel(null);
      this.hud.setMapToolbarVisible(false);
      this.planner.closeMenu();
      touchControls?.setMapMode(false);
    }
  }

  toggle(phase: string, touchControls: TouchControls | null): void {
    if (phase !== 'playing') return;
    if (!this.enabled) {
      this.enabled = true;
      this.planner.selectedNodeIdx = null;
      this.planner.trajDirty = true;
      this.hud.setMapToolbarVisible(true);
      touchControls?.setMapMode(true);
      this.hud.hint(
        '軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [M] で確定',
        5000,
      );
      return;
    }
    this.enabled = false;
    this.planner.onMapClosed();
    this.hud.setMapToolbarVisible(false);
    this.hud.setPlanPanel(null);
    this.planner.closeMenu();
    touchControls?.setMapMode(false);
    if (this.planner.planNodes.length > 0) {
      this.hud.hint(`マニューバ計画 ${this.planner.planNodes.length} 件確定 — [N] で直近ノードへ自動ワープ`, 4500);
    }
  }
}

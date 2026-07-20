import { Hud } from '../../hud/hud';
import { Plan } from '../plan/plan';
import { PlanEditor } from './plan-editor';
import { TouchControls } from '../touch';

export class MapModeController {
  enabled = false;

  constructor(
    private readonly hud: Hud,
    private readonly editor: PlanEditor,
  ) {}

  syncWithPhase(phase: string, touchControls: TouchControls | null): void {
    if (phase !== 'playing' && this.enabled) {
      this.enabled = false;
      this.hud.setPlanPanel(null);
      this.hud.setMapToolbarVisible(false);
      this.editor.closeMenu();
      touchControls?.setMapMode(false);
    }
  }

  toggle(phase: string, touchControls: TouchControls | null, plan: Plan): void {
    if (phase !== 'playing') return;
    if (!this.enabled) {
      this.enabled = true;
      this.editor.selectedNodeIdx = null;
      // マップの表示用予測期間は戦闘ビューの噴射ガイド用期間と異なるため、
      // 開いた直後は必ず作り直す(スロットリングで最大2秒待たされるのを避ける)。
      plan.markDirty();
      this.hud.setMapToolbarVisible(true);
      touchControls?.setMapMode(true);
      this.hud.hint(
        '軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [M] で確定',
        5000,
      );
      return;
    }
    this.enabled = false;
    this.editor.onMapClosed(plan);
    this.hud.setMapToolbarVisible(false);
    this.hud.setPlanPanel(null);
    this.editor.closeMenu();
    touchControls?.setMapMode(false);
    if (plan.nodes.length > 0) {
      this.hud.hint(`マニューバ計画 ${plan.nodes.length} 件確定 — [N] で直近ノードへ自動ワープ`, 4500);
    }
  }
}

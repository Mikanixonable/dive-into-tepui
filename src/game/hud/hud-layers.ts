// 窓・ポップアップ・パネルの配置場所と、折りたたみトグルの配線役をまとめたインターフェース。
import type { PanelCollapse } from './panel-shell';
import type { OverlayLayers } from '../../hud/overlay-layer';
import type { OverlayManager } from '../../hud/overlay-manager';

export interface HudLayers {
  // HUD 全体の根。
  readonly root: HTMLElement;
  // 重ね順ごとの層(窓・ポップアップなど)。
  readonly layers: OverlayLayers;
  // 開いている窓の重なりと入力の取り合いを裁く役。
  readonly overlayManager: OverlayManager;
  // 戦闘ビュー専用の根。
  readonly combatRoot: HTMLElement;
  // マップビュー専用の根。
  readonly mapRoot: HTMLElement;
  // 折りたたみトグルの配線役。
  readonly panelCollapse: PanelCollapse;
}

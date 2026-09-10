// HUD の描画先。窓・ポップアップ・パネルを置く側は、置き場所だけをここから受け取り、
// HUD が何を持っているかは知らない。
import type { OverlayLayers } from '../../hud/overlay-layer';
import type { OverlayManager } from '../../hud/overlay-manager';

export interface HudLayers {
  // HUD 全体の根。
  readonly root: HTMLElement;
  // 重ね順ごとの層(窓・ポップアップなど)。
  readonly layers: OverlayLayers;
  // 開いている窓の重なりと入力の取り合いを裁く役。
  readonly overlayManager: OverlayManager;
  // 戦闘ビュー専用の根。ビューを切り替えると active クラスが移る。
  readonly combatRoot: HTMLElement;
  // マップビュー専用の根。
  readonly mapRoot: HTMLElement;
}

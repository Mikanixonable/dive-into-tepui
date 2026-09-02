// HUD の骨格 CSS (SKELETON_STYLE の統合エクスポート)。
// レイアウト/レール、画面固定バッジ/通知、3Dマーカー意匠の各サブモジュールをまとめ、
// レスポンシブメディアクエリ・prefers-reduced-motion をアセンブルする。
import { HUD_LAYOUT_STYLE } from './hud-layout-style';
import { HUD_BADGE_STYLE } from './hud-badge-style';
import { MARKER_STYLE } from './marker-style';
import { MQ_COARSE, MQ_COARSE_SHORT, MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT } from '../breakpoints';

const RESPONSIVE_SKELETON_STYLE = `
/* モバイル / 狭幅画面: パネルを縮小してタッチパッドと共存させる */
@media ${MQ_MEDIUM_DOWN} {
  #hud { font-size: var(--font-s); }
  #hud .panel { padding: var(--space-3) var(--space-4); line-height: 1.4; }
  #hud .panel h3 { font-size: var(--font-xs); letter-spacing: 1.5px; margin-bottom: var(--space-2); }
  #hud .row { gap: var(--space-4); }
  #hud .row .v { min-width: 64px; }
  #hud:not(.map-ui-active) #hud-viewbadge { display: none; }
  #hud-toast { max-width: 92vw; padding: var(--space-5) var(--space-5); font-size: var(--font-l); }
  #hud .hud-rail { top: 8px; bottom: 8px; gap: var(--space-3); }
  #hud .hud-rail-left { left: 8px; }
  #hud .hud-rail-right { right: 8px; }
  #hud-chase-reset { top: calc(60px + var(--space-5)); width: 28px; height: 28px; }
  #hud-chase-reset svg { width: 14px; height: 14px; }
  #hud-map-scale { right: 8px; bottom: 8px; font-size: var(--font-xxs); }
  #hud .hud-rail { top: 40px; }
}
@media ${MQ_COMPACT} {
  #hud .hud-rail { font-size: var(--font-xxs); }
  #hud .hud-map-root.active .hud-rail { bottom: calc(28vh + 16px); bottom: calc(28dvh + 16px); }
}
@media ${MQ_COARSE} {
  #hud .hud-rail { bottom: 62px; }
  #hud-map-scale { bottom: 62px; }
}
@media ${MQ_COARSE_SHORT} {
  #hud .hud-rail { bottom: 52px; }
  #hud-chase-reset { top: calc(40px + var(--space-4)); }
}
@media ${MQ_SHORT} {
  #hud-map-scale { bottom: 52px; }
}
@media (prefers-reduced-motion: reduce) {
  #hud *, #hud *::before, #hud *::after {
    animation-duration: 0.001ms !important; animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important; scroll-behavior: auto !important;
  }
}
`;

export const SKELETON_STYLE = HUD_LAYOUT_STYLE + HUD_BADGE_STYLE + MARKER_STYLE + RESPONSIVE_SKELETON_STYLE;

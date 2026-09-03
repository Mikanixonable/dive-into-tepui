// HUD の骨格 CSS: #hud ルート・重なり順・スクロールバー・PanelShell 外枠・左右レールと、
// 置き場を持たない画面固定バッジ・通知。末尾でブレークポイントごとの上書きと
// prefers-reduced-motion を当てる。
import { OVERLAY_LAYER_STYLE } from '../overlay-layer';
import { LIGHT_PALETTE } from '../../theme';
import {
  MQ_COARSE, MQ_COARSE_SHORT, MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT,
} from '../breakpoints';

export const SKELETON_STYLE = `
/* レイアウト骨格: #hud ルート・重なり順・スクロールバー・PanelShell 外枠・左右レール。 */
#hud, #hud * { box-sizing: border-box; margin: 0; padding: 0; }
#hud {
  position: fixed; inset: 0; pointer-events: none; overflow: hidden;
  font-family: var(--font-family);
  color: var(--text); color-scheme: var(--theme-tone); user-select: text; z-index: var(--z-hud);
  font-size: var(--font-l);
}
/* タイトル選択画面は #hud より前面にあるので、その上でシステム窓を開いている間だけ #hud を上げる。 */
body.title-screen-open.hud-overlay-modal-open #hud { z-index: var(--z-hud-title-menu); }

/* 明るい縁取りと暗い縁取りを重ね、背景の明暗によらずフォーカスを常に視認できるようにする。 */
#hud :focus-visible, #touch-ui :focus-visible {
  outline-color: var(--color-focus);
  box-shadow: 0 0 0 1px var(--color-focus-contrast);
}

/* 選択無効化対象 */
#hud .ctx-menu-item,
#hud .mk, #hud .rail-toggle, #hud-chase-reset,
#hud-viewbadge .vb-view-btn { user-select: none; }

${OVERLAY_LAYER_STYLE}

/* スクロールバー装飾 */
#hud, #hud * { scrollbar-color: var(--edge) transparent; }
#hud ::-webkit-scrollbar { width: 8px; height: 8px; }
#hud ::-webkit-scrollbar-track { background: transparent; }
#hud ::-webkit-scrollbar-thumb { background: var(--edge); border-radius: var(--radius-m); }
#hud ::-webkit-scrollbar-thumb:hover { background: var(--color-primary-hover); }

#hud-overlay-shield { display: none; position: absolute; inset: 0; pointer-events: none; background: var(--shade-1); }
body.hud-overlay-modal-open #hud-overlay-shield { display: block; }
body.hud-overlay-modal-open #touch-ui { display: none; }

/* 表示/非表示ユーティリティ */
#hud .hidden { display: none !important; }
#hud .hud-view-root { position: absolute; inset: 0; display: none; pointer-events: none; }
#hud .hud-view-root.active { display: block; }

/* 模式図では3D世界の背景が白くなり、ガラス地が白を透かして文字が読みにくくなるため、
   ガラストークンだけ不透明寄りへ差し替える(参照側はどこも var(--glass-*) 経由なので
   ここ1箇所で全パネル/ウィンドウへ効く)。 */
#hud[data-render-style="schematic"] {
  --glass-quiet: color-mix(in srgb, var(--surface-1) 94%, transparent);
  --glass-focus: color-mix(in srgb, var(--surface-1) 97%, transparent);
  --space-label-background: transparent;
  --space-label-text: ${LIGHT_PALETTE.title};
  --space-label-subtext: ${LIGHT_PALETTE.muted};
}

/* Panel 外枠 */
#hud .panel {
  position: absolute; background: var(--glass-quiet);
  border: 0; border-radius: var(--radius-panel);
  padding: var(--space-5); line-height: 1.5;
  box-shadow: 0 12px 32px var(--shade-1);
  backdrop-filter: blur(14px) saturate(82%);
}
#hud .panel h3 {
  font-size: var(--font-s); letter-spacing: 0.06em; color: var(--title);
  border: 0; margin-bottom: var(--space-4); padding: 0;
  font-weight: 600; text-transform: none;
}
/* PanelShell 共通ヘッド */
#hud .panel-shell-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
#hud .panel-shell-head h3 { flex: 1 1 auto; min-width: 0; cursor: pointer; }
#hud .panel-shell-collapse {
  flex: 0 0 auto; width: 24px; height: 24px; background: transparent; border: 0;
  border-radius: var(--radius-micro); color: var(--muted); font: inherit; cursor: pointer; pointer-events: auto;
}
#hud .panel-shell-collapse:hover { color: var(--color-primary-hover); background: var(--surface-2); }
#hud .panel-shell-collapse:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
#hud .panel-shell-body.collapsed { display: none !important; }
#hud .row { display: flex; justify-content: space-between; gap: var(--space-5); }
#hud .row .k { color: var(--text-dim); }
#hud .row .v { color: var(--text); min-width: 90px; text-align: right; font-variant-numeric: tabular-nums; }
#hud .panel input[type="number"], #hud .panel input[type="text"] { width: 64px; }

/* 左右レール */
#hud .hud-rail {
  position: absolute; top: 78px; bottom: 12px;
  display: flex; flex-direction: column; align-items: stretch; gap: 7px;
  pointer-events: none; min-height: 0; overflow-x: hidden; overflow-y: auto;
  scrollbar-width: thin; overscroll-behavior: contain;
}
#hud .hud-rail > .panel { position: relative; inset: auto; transform: none; pointer-events: auto; flex: 0 0 auto; }
#hud .hud-rail-left { left: 12px; width: var(--rail-w-left); }
#hud .hud-rail-right { right: 12px; width: var(--rail-w-right); }
#hud .hud-map-root.active .hud-rail { pointer-events: auto; touch-action: pan-y; }
#hud .rail-toggle {
  width: 30px; height: 30px; border: 0; border-radius: var(--radius-control);
  background: var(--surface-2); color: var(--color-primary); cursor: pointer; pointer-events: auto;
  transition: color var(--transition-fast), background var(--transition-fast);
}
#hud .rail-toggle:hover { color: var(--color-primary-hover); background: var(--surface-3); }
#hud .rail-toggle:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
#hud .rail-toggle { display: none; position: absolute; top: 8px; z-index: var(--z-hud-rail-toggle); }
#hud:not(.base-mode) .rail-toggle { display: block; }
#hud .hud-view-root .rail-toggle-left { left: 8px; }
#hud .hud-view-root .rail-toggle-right { right: 8px; }
#hud:not(.base-mode) .hud-rail.collapsed { width: 0; }
#hud:not(.base-mode) .hud-rail.collapsed > .panel { display: none !important; }
#hud.base-mode .rail-toggle { display: none; }

/* 画面固定バッジ・ステータスバー・通知(視点バッジ・スケール定規・トースト・カメラリセット)。 */
#hud-topbar {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  pointer-events: auto;
  padding: var(--space-3) var(--space-5); border-radius: 0 0 var(--radius-panel) var(--radius-panel);
  background: var(--glass-quiet); border: 0; backdrop-filter: blur(14px) saturate(82%);
  font-size: var(--font-s); letter-spacing: 1px; font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  display: flex; flex-direction: column; align-items: center; gap: var(--space-2);
  max-width: calc(100vw - var(--space-6) * 2);
}
#hud-topbar .gs-row {
  display: flex; align-items: center; gap: var(--space-4); white-space: nowrap;
  max-width: 100%; overflow-x: auto; scrollbar-width: none;
}
#hud-topbar .v { color: var(--text); }
#hud-topbar .gs-speed-select {
  min-width: 76px; padding: var(--space-1) var(--space-5) var(--space-1) var(--space-2);
  border: 1px solid var(--edge); border-radius: var(--radius-micro);
  background: var(--surface-2); color: var(--text); font: inherit; font-size: var(--font-s);
  font-variant-numeric: tabular-nums; cursor: pointer;
}
#hud-topbar .gs-speed-select:hover,
#hud-topbar .gs-speed-select:focus { border-color: var(--color-primary); background: var(--surface-3); }
#hud-topbar .gs-speed-select.sim-speed-hot { color: var(--color-primary); }
#hud-topbar .gs-sep { color: var(--edge); }

#hud-viewbadge {
  gap: var(--space-3);
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: 1.2px; opacity: 0.9;
}
#hud-viewbadge .vb-title { color: var(--color-primary); }
#hud-viewbadge .vb-mode { color: var(--text-dim); }
#hud-viewbadge .vb-field { display: inline-flex; align-items: center; gap: var(--space-1); min-width: 0; }
#hud-viewbadge .vb-field > span:first-child { color: var(--text-dim); }
#hud-viewbadge .vb-field > span:last-child { color: var(--text); max-width: 18em; overflow: hidden; text-overflow: ellipsis; }
#hud-viewbadge .vb-sep { color: var(--edge); }
#hud-viewbadge span.vb-view-btn {
  background: var(--surface-2);
  border-radius: var(--radius-micro); padding: var(--space-1) var(--space-3);
  color: var(--text-dim); font: inherit; letter-spacing: inherit;
}
#hud-viewbadge span.vb-view-btn:hover { color: var(--text); border-color: var(--color-primary-hover); }

#hud-map-scale {
  position: absolute; right: 12px; bottom: 12px; display: none; pointer-events: none;
  padding: var(--space-2) var(--space-4) var(--space-3); border: 0; border-radius: var(--radius-control);
  background: var(--glass-quiet); backdrop-filter: blur(14px) saturate(82%);
  color: var(--text-dim); font-size: var(--font-xxs); line-height: 1.1;
  font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap;
}
#hud-map-scale .map-scale-value { color: var(--text); }
#hud-map-scale .map-scale-ruler { position: relative; height: 10px; margin-top: var(--space-1); margin-left: auto; }
#hud-map-scale .map-scale-ruler::before {
  content: ''; position: absolute; left: 0; right: 0; top: 5px; border-top: 1px solid var(--text-dim);
}
#hud-map-scale .map-scale-tick {
  position: absolute; top: 1px; height: 9px; border-left: 1px solid var(--text);
}
#hud-map-scale .map-scale-tick.start { left: 0; }
#hud-map-scale .map-scale-tick.q1 { left: 25%; }
#hud-map-scale .map-scale-tick.mid { left: 50%; }
#hud-map-scale .map-scale-tick.q3 { left: 75%; }
#hud-map-scale .map-scale-tick.end { right: 0; }

#hud-chase-reset {
  position: absolute; top: calc(64px + var(--space-5)); left: 50%; transform: translateX(-50%);
  pointer-events: auto; cursor: pointer;
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; justify-content: center; align-items: center;
  padding: 0;
  border: 0; background: var(--glass-quiet); color: var(--text-dim);
  backdrop-filter: blur(14px) saturate(82%);
}
#hud-chase-reset:hover { background: var(--surface-2); color: var(--color-primary-hover); }
#hud-chase-reset:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
@media ${MQ_COARSE} {
  #hud-chase-reset { min-width: var(--hit-target-min); min-height: var(--hit-target-min); }
}

#hud-help-badge {
  position: absolute; top: var(--space-5); right: var(--space-5);
  pointer-events: auto; cursor: pointer;
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; justify-content: center; align-items: center;
  padding: 0;
  border: 0; background: var(--glass-quiet); color: var(--text-dim);
  font: inherit; font-size: var(--font-l); font-weight: 700;
  backdrop-filter: blur(14px) saturate(82%);
}
#hud-help-badge:hover { background: var(--surface-2); color: var(--color-primary-hover); }
#hud-help-badge:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
@media ${MQ_COARSE} {
  #hud-help-badge { min-width: var(--hit-target-min); min-height: var(--hit-target-min); }
}

#hud-toast {
  position: absolute; top: calc(64px + var(--space-5) + 32px + var(--space-1)); left: 50%; transform: translateX(-50%);
  background: var(--glass-focus); border: 0; border-radius: var(--radius-panel); padding: var(--space-5) var(--space-6);
  color: var(--text); font-size: var(--font-xl); text-align: center;
  box-shadow: 0 16px 48px var(--shade-1); backdrop-filter: blur(20px) saturate(82%);
  transition: opacity var(--transition-slow); opacity: 0; line-height: 1.8;
}

#hud .sim-speed-hot { color: var(--color-primary); }
#hud .mode-tgt { color: var(--color-primary); }
#hud .warn-hot { color: var(--color-error); }

/* ここから下はブレークポイントごとの上書きと prefers-reduced-motion。
   モバイル / 狭幅画面: パネルを縮小してタッチパッドと共存させる。 */
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

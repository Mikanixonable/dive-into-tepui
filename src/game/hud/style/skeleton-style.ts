// HUD の骨格 CSS: #hud ルート・重なり順・スクロールバー・PanelShell 外枠・左右レールと、
// 置き場を持たない画面固定バッジ・通知。末尾でブレークポイントごとの上書きと
// prefers-reduced-motion を適用する。
import { OVERLAY_LAYER_STYLE } from '../../../hud/overlay-layer';
import { LIGHT_PALETTE } from '../../../theme';
import {
  MQ_COARSE, MQ_COARSE_SHORT, MQ_COMPACT, MQ_MEDIUM_DOWN,
} from '../../../hud/breakpoints';

export const SKELETON_STYLE = `
/* レイアウト骨格: #hud ルート・重なり順・スクロールバー・PanelShell 外枠・左右レール。 */
#hud, #hud * { box-sizing: border-box; }
/* コンポーネントの padding まで消す全称リセットは避ける。文書要素だけを低詳細度で正規化する。 */
#hud :where(h1, h2, h3, h4, p, dl, dd, ol, ul, figure) { margin: 0; padding: 0; }
#hud :where(button, input, select, textarea) { font: inherit; }
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
#hud .rail-toggle, #hud-chase-reset,
#hud-viewbadge .vb-view-btn { user-select: none; }

${OVERLAY_LAYER_STYLE}

/* スクロールバー装飾 */
#hud, #hud * { scrollbar-color: var(--edge) transparent; }
#hud ::-webkit-scrollbar { width: 8px; height: 8px; }
#hud ::-webkit-scrollbar-track { background: transparent; }
#hud ::-webkit-scrollbar-thumb { background: var(--edge); border-radius: var(--radius-m); }
#hud ::-webkit-scrollbar-thumb:hover { background: var(--color-primary-hover); }

#hud-overlay-shield { display: none; position: absolute; inset: 0; pointer-events: none; background: var(--shade-1); }
body.hud-overlay-dim-background #hud-overlay-shield { display: block; }
body.hud-overlay-modal-open #touch-ui,
body.hud-construction-mode #touch-ui { display: none; }

/* 表示/非表示ユーティリティ */
#hud .hidden { display: none !important; }
#hud.construction-mode #hud-view-options,
#hud.construction-mode #hud-trajectory-frame,
#hud.construction-mode #hud-stage-controls,
#hud.construction-mode #hud-physical-object-list,
#hud.construction-mode #hud-topbar,
#hud.construction-mode #hud-viewbadge,
#hud.construction-mode #hud-vessel-status,
#hud.construction-mode #hud-orbit,
#hud.construction-mode #burn-management-panel,
#hud.construction-mode #hud-target,
#hud.construction-mode #hud-enemies,
#hud.construction-mode #hud-map-scale,
#hud.construction-mode #hud-chase-reset,
#hud.construction-mode #hud-help-badge,
#hud.construction-mode .rail-toggle { display: none !important; }
#hud .hud-view-root { position: absolute; inset: 0; display: none; pointer-events: none; }
#hud .hud-view-root.active { display: block; }

/* 模式図表示では背景が白基調となり透過ガラス上の文字視認性が落ちるため、
   ガラストークンを不透明寄りに差し替える（var(--glass-*) 経由のため一括で反映される）。 */
#hud[data-render-style="schematic"] {
  --glass-quiet: color-mix(in srgb, var(--surface-1) 94%, transparent);
  --glass-focus: color-mix(in srgb, var(--surface-1) 97%, transparent);
  --glass-inset: color-mix(in srgb, var(--surface-0) 94%, transparent);
  --glass-control: color-mix(in srgb, var(--surface-2) 94%, transparent);
  --glass-control-hover: color-mix(in srgb, var(--surface-3) 94%, transparent);
  --space-label-background: transparent;
  --space-label-text: ${LIGHT_PALETTE.title};
  --space-label-subtext: ${LIGHT_PALETTE.muted};
}

/* Panel 外枠 */
#hud .panel {
  position: absolute;
  padding: var(--space-5); line-height: 1.5;
}
#hud .panel h3 {
  font-size: var(--font-s); letter-spacing: 0.06em; color: var(--text);
  border: 0; margin-bottom: var(--space-4); padding: 0;
  font-weight: 600; text-transform: none;
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  #hud-topbar,
  #hud-map-scale,
  #hud-chase-reset,
  #hud-help-badge,
  #hud-toast { background: var(--surface-opaque); }
}
/* PanelShell 共通ヘッド */
#hud .panel-shell-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
#hud .panel-shell-head h3 { flex: 1 1 auto; min-width: 0; cursor: pointer; }
#hud .panel-shell-collapse {
  flex: 0 0 auto; width: 24px; height: 24px; background: transparent; border: 0;
  border-radius: 50%; color: var(--text-dim); font: inherit; cursor: pointer; pointer-events: auto;
}
#hud .panel-shell-collapse:hover { color: var(--color-primary-hover); background: var(--surface-2); }
#hud .panel-shell-collapse:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
#hud .panel-shell-body.collapsed { display: none !important; }
#hud .row { display: flex; justify-content: space-between; gap: var(--space-5); }
#hud .row .k { color: var(--text-dim); }
#hud .row .v { color: var(--text); min-width: 0; text-align: right; font-variant-numeric: tabular-nums; }
#hud .panel input[type="number"], #hud .panel input[type="text"] { max-width: 100%; }

/* 左右レール */
#hud .hud-rail {
  position: absolute; top: var(--hud-rail-top); bottom: var(--hud-rail-bottom);
  display: flex; flex-direction: column; align-items: stretch; gap: 7px;
  pointer-events: none; min-height: 0; overflow-x: hidden; overflow-y: auto;
  scrollbar-width: thin; overscroll-behavior: contain;
}
#hud .hud-rail > .panel { position: relative; inset: auto; transform: none; pointer-events: auto; flex: 0 0 auto; }
#hud .hud-rail-left { left: 12px; width: var(--rail-w-left); }
#hud .hud-rail-right { right: 12px; width: var(--rail-w-right); }
#hud .hud-map-root.active .hud-rail { pointer-events: auto; touch-action: pan-y; }
#hud .rail-toggle {
  width: var(--hud-rail-toggle-size); height: var(--hud-rail-toggle-size); border: 0; border-radius: 50%;
  background: var(--glass-control); color: var(--color-primary); cursor: pointer; pointer-events: auto;
  transition: color var(--transition-fast), background var(--transition-fast);
}
#hud .rail-toggle:hover { color: var(--color-primary-hover); background: var(--glass-control-hover); }
#hud .rail-toggle:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
#hud .rail-toggle { display: none; position: absolute; top: var(--space-4); z-index: var(--z-hud-rail-toggle); }
#hud:not(.base-mode) .rail-toggle { display: block; }
#hud .hud-view-root .rail-toggle-left { left: var(--space-4); }
#hud .hud-view-root .rail-toggle-right { right: var(--space-4); }
#hud:not(.base-mode) .hud-rail.collapsed { width: 0; }
#hud:not(.base-mode) .hud-rail.collapsed > .panel { display: none !important; }
#hud.base-mode .rail-toggle { display: none; }

/* 画面固定バッジ・ステータスバー・通知(視点バッジ・スケール定規・トースト・カメラリセット)。 */
#hud-chrome {
  position: absolute; top: 0; left: 0; right: 0;
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 820px) minmax(0, 1fr);
  grid-auto-rows: max-content; align-items: start;
  padding-inline: 12px; pointer-events: none;
}
#hud-topbar {
  position: relative; grid-column: 2; justify-self: center;
  pointer-events: auto;
  border-radius: 0 0 var(--radius-panel) var(--radius-panel);
  padding: var(--space-2) var(--space-5) var(--space-3);
  font-size: var(--font-s); letter-spacing: var(--tracking-label); font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  display: flex; flex-direction: column; align-items: stretch; gap: var(--space-2);
  width: 100%;
  max-width: 820px;
}
#hud-topbar .gs-status-head {
  display: flex; align-items: baseline; gap: var(--space-2);
}
#hud-topbar .gs-workspace { margin-left: auto; }
#hud[data-workspace="flight"] #hud-topbar .gs-workspace::after { content: 'FLIGHT'; }
#hud[data-workspace="map"] #hud-topbar .gs-workspace::after { content: 'MAP'; }
#hud[data-workspace="construction"] #hud-topbar .gs-workspace::after { content: 'BUILD · PAUSED'; }
#hud-topbar .gs-row {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4);
  max-width: 100%; min-width: 0; overflow: visible;
}
#hud-topbar .gs-metrics {
  display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: end; gap: var(--space-5);
  padding-top: var(--space-2);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-dim) 18%, transparent);
}
#hud-topbar .gs-metric { display: grid; gap: 2px; min-width: 0; }
#hud-topbar .gs-metric-time .v {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text); font-size: var(--font-s);
}
#hud-topbar .v { color: var(--text); }
#hud-topbar .gs-speed-select {
  min-width: 76px; padding: var(--space-1) var(--space-5) var(--space-1) var(--space-2);
  border: 0; border-radius: var(--radius-micro);
  background: var(--glass-control); color: var(--text); font: inherit; font-size: var(--font-s);
  font-variant-numeric: tabular-nums; cursor: pointer;
}
#hud-topbar .gs-speed-select:hover,
#hud-topbar .gs-speed-select:focus { background: var(--glass-control-hover); }
#hud-topbar .gs-speed-select.sim-speed-hot { color: var(--color-primary); }
#hud-topbar .gs-sep { color: var(--edge); }

#hud-viewbadge {
  gap: var(--space-3);
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: var(--tracking-label); opacity: 0.9;
}
#hud-viewbadge .vb-mode {
  color: var(--color-primary); font-weight: 700; letter-spacing: var(--tracking-label);
}
#hud-viewbadge .vb-field { display: inline-flex; align-items: center; gap: var(--space-1); min-width: 0; }
#hud-viewbadge .vb-field > span:first-child { color: var(--text-dim); }
#hud-viewbadge .vb-field > span:last-child {
  color: var(--text); max-width: 18em; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap;
}
#hud-viewbadge .vb-sep { color: var(--edge); }
#hud-viewbadge span.vb-view-btn {
  background: var(--glass-control);
  border-radius: var(--radius-micro); padding: var(--space-1) var(--space-3);
  color: var(--text-dim); font: inherit; letter-spacing: inherit;
}
#hud-viewbadge span.vb-view-btn:hover { color: var(--text); }

#hud-map-scale {
  position: absolute; right: 12px; bottom: var(--hud-map-scale-bottom); display: none; pointer-events: none;
  padding: var(--space-2) var(--space-3) var(--space-3); border-radius: var(--radius-micro);
  color: var(--text-dim); font-size: var(--font-xxs); line-height: 1.1;
  font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap;
}
#hud-map-scale .map-scale-label {
  margin-right: var(--space-2); color: var(--color-primary); font-weight: 700; letter-spacing: var(--tracking-code);
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
  position: relative; grid-column: 2; justify-self: center; margin-top: var(--space-2);
  pointer-events: auto; cursor: pointer;
  min-width: 0; width: auto; height: 30px; border-radius: var(--radius-micro);
  display: flex; justify-content: center; align-items: center; gap: var(--space-2);
  padding: 0 var(--space-3); border: 0; color: var(--text-dim);
}
#hud-chase-reset:hover { background: var(--surface-2); color: var(--color-primary-hover); }
#hud-chase-reset:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
@media ${MQ_COARSE} {
  #hud-chase-reset { min-width: var(--hit-target-min); min-height: var(--hit-target-min); }
}

#hud-help-badge {
  position: absolute; top: var(--space-4);
  right: calc(var(--space-4) + var(--hud-rail-toggle-size) + var(--space-2));
  pointer-events: auto; cursor: pointer;
  min-width: 0; width: auto; height: 30px; border-radius: var(--radius-micro);
  display: flex; justify-content: center; align-items: center; gap: var(--space-2);
  padding: 0 var(--space-3); color: var(--text-dim);
  font: inherit; font-size: var(--font-s); font-weight: 700;
}
#hud-help-badge:hover { background: var(--surface-2); color: var(--color-primary-hover); }
#hud .hud-mini-code {
  color: var(--color-primary); font-size: var(--font-xxs); font-weight: 700; letter-spacing: var(--tracking-code);
}
#hud-help-badge:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
@media ${MQ_COARSE} {
  #hud-help-badge { min-width: var(--hit-target-min); min-height: var(--hit-target-min); }
}

#hud-toast {
  position: absolute; top: calc(var(--hud-chrome-h) + var(--space-2)); left: 50%; transform: translateX(-50%);
  display: flex; align-items: baseline; gap: var(--space-3);
  max-width: min(720px, calc(100vw - var(--space-6) * 2));
  border-radius: var(--radius-micro); padding: var(--space-3) var(--space-4);
  color: var(--text); font-size: var(--font-s); text-align: left;
  transition: opacity var(--transition-slow); opacity: 0; line-height: 1.45;
}
#hud-toast .toast-code {
  flex: 0 0 auto; color: var(--color-primary); font-size: var(--font-xxs);
  font-weight: 700; letter-spacing: var(--tracking-code);
}
#hud-toast.warn .toast-code { color: var(--color-warning); }
#hud-toast .toast-message { min-width: 0; overflow-wrap: anywhere; }

#hud .sim-speed-hot { color: var(--color-primary); }
#hud .mode-tgt { color: var(--color-primary); }
#hud .warn-hot { color: var(--color-error); }

/* ここから下はブレークポイントごとの上書きと prefers-reduced-motion。
   モバイル / 狭幅画面: パネルを縮小してタッチパッドと共存させる。 */
@media ${MQ_MEDIUM_DOWN} {
  #hud { font-size: var(--font-s); }
  #hud-topbar { padding-block: var(--space-1) var(--space-2); }
  #hud-topbar .gs-status-head { display: none; }
  #hud-topbar .gs-metrics { padding-top: 0; box-shadow: none; }
  #hud-topbar .gs-metric .ui-data-label { display: none; }
  #hud .panel { padding: var(--space-3) var(--space-4); line-height: 1.4; }
  #hud .panel h3 { font-size: var(--font-xs); letter-spacing: 1.5px; margin-bottom: var(--space-2); }
  #hud .row { gap: var(--space-4); }
  #hud .row .v { min-width: 0; }
  #hud:not(.map-ui-active) #hud-viewbadge { display: none; }
  #hud-toast { max-width: 92vw; padding: var(--space-5) var(--space-5); font-size: var(--font-l); }
  #hud .hud-rail { gap: var(--space-3); }
  #hud .hud-rail-left { left: 8px; }
  #hud .hud-rail-right { right: 8px; }
  #hud-chase-reset { width: auto; height: 28px; }
  #hud-chase-reset svg { width: 14px; height: 14px; }
  #hud-map-scale { right: 8px; font-size: var(--font-xxs); }
}
@media ${MQ_COMPACT} {
  #hud .hud-rail { font-size: var(--font-xs); }
  #hud .hud-map-root.active .hud-rail { bottom: var(--hud-map-rail-bottom); }
  #hud-topbar {
    width: 100%;
    padding-inline: var(--space-3);
  }
  #hud-topbar .gs-status-head { gap: var(--space-1); }
  #hud-topbar .gs-metrics { grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); }
  #hud-topbar .gs-metric:last-child { display: none; }
  #hud-topbar .gs-metric-time .v { font-size: var(--font-xxs); }
}
@media ${MQ_COARSE_SHORT} {
  #hud-chase-reset .hud-mini-code { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  #hud *, #hud *::before, #hud *::after {
    animation-duration: 0.001ms !important; animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important; scroll-behavior: auto !important;
  }
}
`;

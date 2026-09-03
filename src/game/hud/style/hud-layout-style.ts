// HUD のレイアウト骨格 CSS: #hud ルート・重なり順・スクロールバー・PanelShell 外枠・左右レール。
import { OVERLAY_LAYER_STYLE } from '../overlay-layer';
import { LIGHT_PALETTE } from '../../theme';

export const HUD_LAYOUT_STYLE = `
#hud, #hud * { box-sizing: border-box; margin: 0; padding: 0; }
#hud {
  position: fixed; inset: 0; pointer-events: none; overflow: hidden;
  font-family: var(--font-family);
  color: var(--text); color-scheme: var(--theme-tone); user-select: text; z-index: var(--z-hud);
  font-size: var(--font-l);
}
/* ステージ選択画面より前面に出す既存の一時停止メニュー */
#hud.title-menu-open { z-index: var(--z-hud-title-menu); }

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
`;

// タンパク質対象詳細、燃焼管理パネル、常設パネルの操作ボタン列の CSS。
export const COMBAT_PANEL_ROWS_STYLE = `
  .protein-target-details { margin-top: var(--space-3); padding-top: var(--space-3); }
  .protein-target-heading { display: flex; justify-content: space-between; color: var(--text-muted); font-size: var(--font-xxs); letter-spacing: .08em; }
  .protein-site-row { display: grid; grid-template-columns: 1rem 5.2rem minmax(3rem, 1fr) auto; gap: var(--space-2); align-items: center; margin-top: var(--space-2); font-size: var(--font-xxs); }
  .protein-site-glyph { color: var(--color-signal); font-size: var(--font-xs); line-height: 1; opacity: calc(.25 + var(--protein-site-hp) * .75); }
  .protein-site-row.disabled .protein-site-glyph { color: var(--text-dim); }
  .protein-site-label { min-width: 0; }
  .protein-site-hp-icon { color: var(--color-signal); font-size: var(--font-xs); line-height: 1; }
  .protein-site-hp-icon svg { display: block; width: 1em; height: 1em; }
  .protein-site-row.disabled .protein-site-hp-icon { color: var(--text-dim); }
/* 通常のマップビューでは艦固有の情報を右クリックのプロパティウィンドウで参照するので、常設の
   SHIP STATUS は畳んでパネル占有面積を減らす。クリエイティブでは配置後の操作用に表示する。 */
#hud:not(.creative-mode) .hud-map-root.active #hud-vessel-status { display: none; }
#burn-management-panel .burn-management-metrics { gap: 1px; }
#burn-management-panel .burn-fuel-readout {
  display: inline-grid; grid-template-columns: minmax(64px, 1fr) auto;
  align-items: center; gap: 6px; width: 128px;
}
#burn-management-panel .burn-fuel-value {
  min-width: 48px; color: var(--text); font-size: var(--font-xxs);
  text-align: right; white-space: nowrap;
}
/* 常設パネルの操作ボタン列。 */
.combat-panel .panel-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); }
.combat-panel .panel-actions .w-btn { font-size: var(--font-xxs); padding: var(--space-2) var(--space-3); }
#hud .hud-rail-right > #hud-target { width: 100%; box-sizing: border-box; font-size: var(--font-xs); }
#hud-orbit .orbit-controls {
  display: grid; gap: var(--space-2); padding-top: var(--space-3);
}
#hud-orbit .orbit-controls .w-segmented { width: 100%; }

/* engagement はレイアウトを移動せず、現在の対象だけを強く見せる。 */
#hud[data-attention="engagement"] #hud-orbit { opacity: .86; }
#hud[data-attention="nominal"] #hud-orbit { opacity: 1; }
`;

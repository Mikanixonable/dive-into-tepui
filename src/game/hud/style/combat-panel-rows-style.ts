// タンパク質対象詳細、SHIP STATUS/ORBIT/TARGET/CONTACTS の計器行、燃焼管理パネルの CSS。
export const COMBAT_PANEL_ROWS_STYLE = `
  .protein-target-details { margin-top: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--line-subtle); }
  .protein-target-heading { display: flex; justify-content: space-between; color: var(--text-muted); font-size: var(--font-xxs); letter-spacing: .08em; }
  .protein-site-row { display: grid; grid-template-columns: 1rem 5.2rem minmax(3rem, 1fr) auto; gap: var(--space-2); align-items: center; margin-top: var(--space-2); font-size: var(--font-xxs); }
  .protein-site-glyph { color: var(--color-signal); font-size: var(--font-xs); line-height: 1; opacity: calc(.25 + var(--protein-site-hp) * .75); }
  .protein-site-row.disabled .protein-site-glyph { color: var(--text-dim); }
  .protein-site-label { min-width: 0; }
  .protein-site-hp-icon { color: var(--color-signal); font-size: var(--font-xs); line-height: 1; }
  .protein-site-hp-icon svg { display: block; width: 1em; height: 1em; }
  .protein-site-row.disabled .protein-site-hp-icon { color: var(--text-dim); }
#hud-vessel-status h3 { font-size: var(--font-xxs); }
/* 通常のマップビューでは艦固有の情報を右クリックのプロパティウィンドウで参照するので、常設の
   SHIP STATUS は畳んでパネル占有面積を減らす。クリエイティブでは配置後の操作用に表示する。 */
#hud:not(.creative-mode) .hud-map-root.active #hud-vessel-status { display: none; }
#hud-orbit h3 { font-size: var(--font-xxs); }
#hud-vessel-status .v, #hud-orbit .v { min-width: 75px; }
#hud-vessel-status .vessel-meter-readout {
  display: inline-grid;
  grid-template-columns: minmax(64px, 1fr) auto;
  align-items: center;
  gap: 6px;
  width: 128px;
}
#hud-vessel-status .vessel-meter-value {
  min-width: 48px;
  color: var(--text);
  font-size: var(--font-xxs);
  text-align: right;
  white-space: nowrap;
}
#burn-management-panel .burn-management-metrics { gap: 1px; }
#burn-management-panel .burn-fuel-readout {
  display: inline-grid; grid-template-columns: minmax(64px, 1fr) auto;
  align-items: center; gap: 6px; width: 128px;
}
#burn-management-panel .burn-fuel-value {
  min-width: 48px; color: var(--text); font-size: var(--font-xxs);
  text-align: right; white-space: nowrap;
}
#burn-management-panel .burn-actions { margin-top: var(--space-3); }
#burn-management-panel .burn-actions .w-btn { min-width: 0; }
#hud-vessel-status .vessel-deploy-controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
  margin-top: var(--space-3);
}
/* パドル/放熱板の展開度と損耗をボタン内の塗りつぶしで示す。 */
#hud-vessel-status span.vessel-deploy-btn {
  position: relative; overflow: hidden; width: 100%; min-width: 0;
  padding: var(--space-2) var(--space-3); text-align: left;
}
#hud-vessel-status .vessel-deploy-btn .fill {
  position: absolute; inset: 0; z-index: 0;
  transition: width var(--transition-fast), background var(--transition-fast);
}
#hud-vessel-status .vessel-deploy-btn .label {
  position: relative; z-index: 1; color: var(--text); font-size: var(--font-xxs); line-height: 1.5;
  text-shadow: 0 0 3px var(--bg), 0 0 3px var(--bg); transition: color var(--transition-fast);
}
#hud-vessel-status .vessel-deploy-btn.on { border-color: var(--color-primary); }
#hud-vessel-status .vessel-deploy-btn.on .label { color: var(--color-primary); }
/* 常設パネルの操作ボタン列(艦ステータスの R/F/G/T 代替、軌道情報の分析パネル起動、
   いずれもタッチ・マウスどちらでも常設)。 */
.combat-panel .panel-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); }
.combat-panel .panel-actions .w-btn { font-size: var(--font-xxs); padding: var(--space-2) var(--space-3); }
/* スロットル 1-4 の SegmentedControl。タッチ UI が出ている間だけ表示する — 表示条件は
   body.touch-ui-active と同じものに載せ、ここで別の判定を作らない。 */
#hud-vessel-status .status-throttle-touch { display: none; margin-top: var(--space-3); }
body.touch-ui-active #hud-vessel-status .status-throttle-touch { display: flex; }
#hud .hud-rail-right > #hud-target { width: 100%; box-sizing: border-box; font-size: var(--font-xs); }
#hud .hud-rail-right > #hud-target h3 { font-size: var(--font-xxs); }
#hud-enemies h3 { font-size: var(--font-xxs); }
#hud-enemies .erow { display: flex; justify-content: space-between; gap: var(--space-4); color: var(--text-dim); }
#hud-enemies .erow.tgt { color: var(--color-primary); }
`;

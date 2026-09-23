// タンパク質対象詳細、SHIP STATUS/ORBIT/TARGET/CONTACTS の計器行、燃焼管理パネルの CSS。
export const COMBAT_PANEL_ROWS_STYLE = `
  .protein-target-details { margin-top: var(--space-3); padding-top: var(--space-3); }
  .protein-target-heading { display: flex; justify-content: space-between; color: var(--text-muted); font-size: var(--font-xxs); letter-spacing: var(--tracking-label); }
  .protein-site-row { display: grid; grid-template-columns: 1rem 5.2rem minmax(3rem, 1fr) auto; gap: var(--space-2); align-items: center; margin-top: var(--space-2); font-size: var(--font-xxs); }
  .protein-site-glyph { color: var(--color-signal); font-size: var(--font-xs); line-height: 1; opacity: calc(.25 + var(--protein-site-hp) * .75); }
  .protein-site-row.disabled .protein-site-glyph { color: var(--text-dim); }
  .protein-site-label { min-width: 0; }
  .protein-site-hp-icon { color: var(--color-signal); font-size: var(--font-xs); line-height: 1; }
  .protein-site-hp-icon svg { display: block; width: 1em; height: 1em; }
  .protein-site-row.disabled .protein-site-hp-icon { color: var(--text-dim); }
#hud-vessel-status h3 { font-size: var(--font-xs); }
/* 通常のマップビューでは艦固有の情報を右クリックのプロパティウィンドウで参照するので、常設の
   SHIP STATUS は畳んでパネル占有面積を減らす。クリエイティブでは配置後の操作用に表示する。 */
#hud:not(.creative-mode) .hud-map-root.active #hud-vessel-status { display: none; }
#hud-orbit h3 { font-size: var(--font-xs); }
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
#hud-vessel-status .vessel-deploy-btn.on { color: var(--color-primary); }
#hud-vessel-status .vessel-deploy-btn.on .label { color: var(--color-primary); }
/* 常設パネルの操作ボタン列(艦ステータスの R/F/G/T 代替、軌道情報の分析パネル起動、
   いずれもタッチ・マウスどちらでも常設)。 */
.combat-panel .panel-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); }
.combat-panel .panel-actions .w-btn { font-size: var(--font-xs); padding: var(--space-2) var(--space-3); }
/* スロットル 1-4 の SegmentedControl。タッチ UI が出ている間だけ表示する — 表示条件は
   body.touch-ui-active と同じものに載せ、ここで別の判定を作らない。 */
#hud-vessel-status .status-throttle-touch { display: none; margin-top: var(--space-3); }
body.touch-ui-active #hud-vessel-status .status-throttle-touch { display: flex; }
#hud .hud-rail-right > #hud-target { width: 100%; box-sizing: border-box; font-size: var(--font-xs); }
#hud .hud-rail-right > #hud-target h3 { font-size: var(--font-xs); }
#hud-enemies h3 { font-size: var(--font-xs); }
#hud-enemies .erow { display: flex; justify-content: space-between; gap: var(--space-4); color: var(--text-dim); }
#hud-enemies .erow.tgt { color: var(--color-primary); }

/* ORBIT: 文脈 → 主値 → 軌道形状 → 二次要素 → 環境負荷の順に読む。 */
#hud-orbit .panel-shell-head { margin-bottom: var(--space-2); }
#hud-orbit .panel-shell-head h3 { margin-bottom: 0; }
#hud-orbit .orbit-context-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3);
  margin-bottom: var(--space-4); min-width: 0;
}
#hud-orbit .orbit-context-row .orbit-center-name {
  min-width: 0; overflow: hidden; color: var(--text); font-size: var(--font-xxs);
  text-overflow: ellipsis; white-space: nowrap;
}
#hud-orbit .orbit-primary-grid {
  display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, .75fr);
  align-items: end; gap: var(--space-4); margin-bottom: var(--space-5);
}
#hud-orbit .orbit-primary { display: grid; gap: var(--space-2); min-width: 0; }
#hud-orbit .orbit-speed { text-align: right; }
#hud-orbit .orbit-altitude .ui-data-hero,
#hud-orbit .orbit-speed .ui-data-major { white-space: nowrap; }
#hud-orbit .orbit-apsides {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2);
  margin-bottom: var(--space-4);
}
#hud-orbit .orbit-apsis {
  display: grid; gap: var(--space-1); min-width: 0;
  padding: var(--space-3); border-radius: var(--radius-micro); background: var(--glass-inset);
}
#hud-orbit .orbit-apsis output { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#hud-orbit .orbit-secondary-grid {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3);
  margin-bottom: var(--space-4);
}
#hud-orbit .orbit-secondary-grid > div {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2);
}
#hud-orbit .orbit-secondary-grid dd {
  color: var(--text); font-size: var(--font-xs); font-variant-numeric: tabular-nums; white-space: nowrap;
}
#hud-orbit .orbit-environment { display: grid; gap: var(--space-3); margin-bottom: var(--space-4); }
#hud-orbit .orbit-env-row {
  display: grid; gap: var(--space-1); padding: var(--space-2) 0;
  transition: background var(--transition-fast), padding var(--transition-fast);
}
#hud-orbit .orbit-env-head {
  display: flex; justify-content: space-between; gap: var(--space-3); align-items: baseline;
}
#hud-orbit .orbit-env-head output {
  color: var(--text-muted); font-size: var(--font-xxs); font-variant-numeric: tabular-nums;
}
#hud-orbit .orbit-env-meter { width: 100%; height: 4px; overflow: hidden; }
#hud-orbit .orbit-env-row.warn-hot {
  margin-inline: calc(var(--space-2) * -1); padding: var(--space-3) var(--space-2);
  border-radius: var(--radius-micro); background: var(--color-warning-fill);
}
#hud-orbit .orbit-controls {
  display: grid; gap: var(--space-2); padding-top: var(--space-3);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-dim) 22%, transparent);
}
#hud-orbit .orbit-controls .w-segmented { width: 100%; }
#hud[data-workspace="map"] #hud-orbit .ui-data-hero { font-size: var(--font-2xl); }
#hud[data-workspace="map"] #hud-orbit .orbit-apsis { background: var(--color-primary-fill-weak); }

/* engagement はレイアウトを移動せず、現在の対象だけを強く見せる。 */
#hud[data-attention="engagement"] #hud-target {
  box-shadow: inset 2px 0 0 var(--color-primary), var(--glass-shadow);
  background: var(--glass-focus);
}
#hud[data-attention="engagement"] #hud-target .target-primary-value {
  color: var(--text-strong); font-size: var(--font-l);
}
#hud[data-attention="engagement"] #hud-orbit { opacity: .86; }
#hud[data-attention="nominal"] #hud-orbit { opacity: 1; }
`;

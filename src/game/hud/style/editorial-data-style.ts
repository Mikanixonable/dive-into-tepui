// タイトル画面の Editorial × aerospace instrumentation の語彙をゲーム HUD へ持ち込む。
// 色や外部フォントは増やさず、既存 theme token のサイズ差・余白・注釈で情報階層を作る。
export const EDITORIAL_DATA_STYLE = `
#hud .ui-section-code {
  display: inline-block;
  margin-right: var(--space-2);
  color: var(--color-primary);
  font-size: var(--font-xxs);
  font-weight: 700;
  letter-spacing: .16em;
  vertical-align: baseline;
}
#hud .ui-data-context {
  color: var(--text-dim);
  font-size: var(--font-xxs);
  letter-spacing: .12em;
  text-transform: uppercase;
}
#hud .ui-data-hero {
  color: var(--text-strong);
  font-size: var(--font-3xl);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.045em;
  line-height: .95;
}
#hud .ui-data-major {
  color: var(--text);
  font-size: var(--font-xl);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.02em;
}
#hud .ui-data-label {
  color: var(--text-dim);
  font-size: var(--font-xxs);
  letter-spacing: .11em;
  text-transform: uppercase;
}
#hud .ui-data-secondary {
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
}
#hud .ui-annotation {
  color: var(--text-dim);
  font-size: var(--font-xxs);
  line-height: 1.45;
}
#hud .ui-delta {
  color: var(--color-primary);
  font-size: var(--font-xxs);
  font-variant-numeric: tabular-nums;
}
#hud .ui-data-grid {
  display: grid;
  gap: var(--space-3);
}

/* タイトル画面から抽出した共通レイアウト文法。見た目のコピーではなく、情報階層を共通化する。 */
#hud .editorial-control-sheet,
#hud .editorial-index,
#hud .editorial-instrument {
  --editorial-rule: color-mix(in srgb, var(--text-dim) 24%, transparent);
}
#hud .editorial-panel-head {
  display: flex; align-items: baseline; gap: var(--space-2);
  margin-bottom: var(--space-3);
}
#hud .editorial-panel-head h3,
#hud h3.editorial-panel-title {
  margin: 0; color: var(--text); font-size: var(--font-xs);
  font-weight: 600; letter-spacing: .08em;
}
#hud .editorial-state {
  display: grid; gap: var(--space-3);
  margin-bottom: var(--space-4); padding-bottom: var(--space-4);
  box-shadow: inset 0 -1px 0 var(--editorial-rule);
}
#hud .editorial-state-hero {
  display: grid; gap: var(--space-1); min-width: 0;
}
#hud .editorial-state-hero strong {
  min-width: 0; overflow: hidden; color: var(--text-strong);
  font-size: var(--font-2xl); font-weight: 650; letter-spacing: -.035em;
  line-height: 1; text-overflow: ellipsis; white-space: nowrap;
}
#hud .editorial-state-grid {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2) var(--space-4);
}
#hud .editorial-state-cell {
  display: grid; gap: 2px; min-width: 0;
}
#hud .editorial-state-cell > :last-child {
  min-width: 0; overflow: hidden; color: var(--text);
  font-size: var(--font-xs); font-variant-numeric: tabular-nums;
  text-overflow: ellipsis; white-space: nowrap;
}
#hud .editorial-divider {
  display: flex; align-items: center; gap: var(--space-2);
  margin: var(--space-4) 0 var(--space-2);
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: .1em;
  text-transform: uppercase;
}
#hud .editorial-divider::after {
  content: ''; flex: 1 1 auto; height: 1px; background: var(--editorial-rule);
}
#hud .editorial-index-row {
  position: relative; display: grid; grid-template-columns: 2.4em minmax(0, 1fr) auto;
  align-items: baseline; gap: var(--space-2); min-height: var(--hit-target-min);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
}
#hud .editorial-index-row::before {
  content: attr(data-index); color: var(--text-dim); font-size: var(--font-xxs);
  font-variant-numeric: tabular-nums; letter-spacing: .08em;
}
#hud .editorial-index-row.is-active {
  box-shadow: inset 2px 0 0 var(--color-primary);
}
#hud .editorial-index-status {
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: .08em;
}
#hud .editorial-control-zone {
  padding-top: var(--space-3);
  box-shadow: inset 0 1px 0 var(--editorial-rule);
}
#hud .editorial-workspace-title {
  color: var(--text-strong); font-size: var(--font-3xl); font-weight: 650;
  letter-spacing: -.055em; line-height: .84;
}

// 艦のステータス(#hud-vessel-status)の区画の意匠: 展開部品の行、単発操作、タッチ環境の推力段とモードのボタン。
// 計器とモードの行の文法は共通の計器スタイルが持つ。
export const VESSEL_STATUS_STYLE = `
/* 展開部品: [ラベル][左の面][右の面]。面は「展開の点と左右の語・キーキャップ」。 */
#hud-vessel-status .vessel-deploy-row {
  display: grid; grid-template-columns: minmax(var(--instrument-label-min), 1fr) auto auto;
  column-gap: var(--space-3); align-items: center;
  min-height: calc(var(--row-min-h-s) + var(--space-3));
  font-size: var(--font-xs);
}
#hud-vessel-status .vessel-deploy-row .w-btn {
  display: inline-flex; align-items: center; justify-content: space-between; gap: var(--space-3);
  min-width: calc(var(--instrument-key-col) * 3); white-space: nowrap;
}
#hud-vessel-status .vessel-deploy-row .w-btn .ui-pip { color: inherit; letter-spacing: 0; font-size: inherit; }
#hud-vessel-status .vessel-deploy-row .w-btn .ui-pip.on::before { background: currentColor; box-shadow: none; }
#hud-vessel-status .vessel-deploy .ui-row { font-size: var(--font-xs); }

/* 操作: ターゲット選択だけがターゲットの色。 */
#hud-vessel-status .panel-actions .w-btn.is-target { background: var(--role-target-fill); color: var(--role-target); }
#hud-vessel-status .panel-actions .w-btn.is-target .ui-key { color: var(--role-target); }

/* タッチ環境(body.touch-ui-active と同じ判定)では、推力段の行が4つのボタンに、モードの行が点灯ボタンの列に替わる。 */
#hud-vessel-status .status-throttle-touch, #hud-vessel-status .status-modes-touch { display: none; }
body.touch-ui-active #hud-vessel-status .vessel-throttle-rows,
body.touch-ui-active #hud-vessel-status .vessel-mode-rows { display: none; }
body.touch-ui-active #hud-vessel-status .status-throttle-touch { display: block; margin-top: var(--space-3); }
body.touch-ui-active #hud-vessel-status .status-throttle-touch .w-group { gap: var(--space-2); }
body.touch-ui-active #hud-vessel-status .status-throttle-touch .w-group-title { flex: 0 0 100%; }
body.touch-ui-active #hud-vessel-status .status-throttle-touch .w-btn {
  flex: 1 1 0; padding-inline: var(--space-2); text-align: center; white-space: nowrap;
}
body.touch-ui-active #hud-vessel-status .status-modes-touch {
  display: grid; gap: var(--space-2); margin-top: var(--space-3);
}
`;

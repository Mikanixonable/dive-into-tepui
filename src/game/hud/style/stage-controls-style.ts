// ステージ操作パネル(#hud-stage-controls、クリエイティブモードの敵/形状設定)の CSS。
export const STAGE_CONTROLS_STYLE = `
#hud-stage-controls { width: 100%; pointer-events: auto; }
#hud-stage-controls .editorial-panel-head { margin-bottom: var(--space-3); }
#hud-stage-controls .stage-controls-body {
  display: grid; gap: var(--space-2); margin-top: 0; padding-top: var(--space-3);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-dim) 20%, transparent);
}
#hud-stage-controls .stage-control-section {
  display: grid; gap: var(--space-2); margin-top: var(--space-2); padding-top: var(--space-3);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-dim) 14%, transparent);
}
#hud-stage-controls .stage-control-section-title {
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: .1em; text-transform: uppercase;
}
#hud-stage-controls .stage-control-select { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); color: var(--text-dim); font-size: var(--font-xxs); }
#hud-stage-controls .stage-control-select .w-group-title { min-width: 0; font-size: var(--font-xxs); letter-spacing: normal; }
#hud-stage-controls .stage-control-select .w-select { min-width: 86px; }
#hud-stage-controls .stage-control-select .w-input { width: 72px; text-align: right; }
`;

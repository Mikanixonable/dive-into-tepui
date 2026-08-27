// ステージ操作パネル(#hud-stage-controls、クリエイティブモードの敵/形状/タンパク質設定)の CSS。
export const STAGE_CONTROLS_STYLE = `
#hud-stage-controls { width: 100%; pointer-events: auto; }
#hud-stage-controls .stage-controls-body { display: grid; gap: var(--space-2); margin-top: var(--space-3); }
#hud-stage-controls .stage-control-enemy-tabs { display: flex; gap: var(--space-2); }
#hud-stage-controls .stage-control-enemy-tabs .w-btn { flex: 1 1 0; min-width: 0; }
#hud-stage-controls .stage-control-section { display: grid; gap: var(--space-2); padding-top: var(--space-2); border-top: 1px solid var(--edge); }
#hud-stage-controls .stage-control-section-title { color: var(--text); font-size: var(--font-xxs); letter-spacing: .04em; }
#hud-stage-controls .stage-control-shapes { display: flex; flex-wrap: wrap; gap: var(--space-2); }
#hud-stage-controls .stage-control-shapes .w-group-title { flex: 0 0 100%; }
#hud-stage-controls .stage-control-shapes .w-btn { flex: 1 1 0; min-width: 0; }
#hud-stage-controls .stage-control-shapes .w-btn.on { background: var(--color-primary-fill); border-color: var(--color-primary); color: var(--color-primary); }
#hud-stage-controls .stage-control-protein-representation,
#hud-stage-controls .stage-control-protein-colors { display: flex; flex-wrap: wrap; gap: var(--space-2); }
#hud-stage-controls .stage-control-protein-representation .w-group-title,
#hud-stage-controls .stage-control-protein-colors .w-group-title { flex: 0 0 100%; }
#hud-stage-controls .stage-control-protein-representation .w-btn,
#hud-stage-controls .stage-control-protein-colors .w-btn { flex: 1 1 0; min-width: 0; }
/* 着色は長い分析用ラベルを含むため2列へ折り返し、全文をボタン内に収める。 */
#hud-stage-controls .stage-control-protein-colors .w-btn {
  flex: 1 1 calc(50% - var(--space-2)); min-width: 110px; white-space: normal; overflow-wrap: anywhere;
}
#hud-stage-controls .stage-control-protein-representation .w-btn.on,
#hud-stage-controls .stage-control-protein-colors .w-btn.on { background: var(--color-primary-fill); border-color: var(--color-primary); color: var(--color-primary); }
#hud-stage-controls .stage-control-select { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); color: var(--text-dim); font-size: var(--font-xxs); }
#hud-stage-controls .stage-control-select .w-select { min-width: 86px; }
#hud-stage-controls .stage-control-select .w-input { width: 72px; text-align: right; }
`;

// 軌道ガイドタブ(.orbit-guide-*)の CSS。
export const ORBIT_GUIDE_STYLE = `
/* 軌道ガイドタブ: 種類ごとの区画(見出し+軸行+値行)。独立トグル行(系/点/南北)は
   見出し+ボタン列を折り返す。 */
.orbit-guide-tab {
  /* スライダー列の最小幅と、それに添える数値入力欄の幅。 */
  --orbit-guide-slider-min-w: 60px;
  --orbit-guide-value-w: 60px;
}
.orbit-guide-tab .w-tabs { margin-bottom: var(--space-3); }
.orbit-guide-group-body.hidden { display: none; }
.orbit-guide-system-row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-2); }
.orbit-guide-kind-row { margin-bottom: var(--space-2); }
.orbit-guide-kind-heading { margin-bottom: var(--space-1); }
.orbit-guide-kind-heading-btn { width: 100%; text-align: left; }
.orbit-guide-kind-heading-btn-resonant { padding: 10.5px calc(var(--space-5) * 1.5); font-size: calc(var(--font-s) * 1.5); text-align: center; }
.orbit-guide-combined-heading { font-size: var(--font-xxs); font-weight: 600; padding: var(--space-2) 0; }
.orbit-guide-kind-config { display: flex; flex-direction: column; gap: var(--space-2); padding-left: var(--space-3); border-left: 1px solid var(--line-subtle); }
.orbit-guide-kind-config.hidden { display: none; }
.orbit-guide-toggle-row { flex-wrap: wrap; }
.orbit-guide-value-row { flex-wrap: nowrap; align-items: center; }
.orbit-guide-value-row .slider-col { flex: 1 1 var(--orbit-guide-slider-min-w); min-width: var(--orbit-guide-slider-min-w); }
.orbit-guide-value-row .w-slider { width: 100%; }
.orbit-guide-value-row .w-input { width: var(--orbit-guide-value-w); }
.orbit-guide-value-row.hidden { display: none; }
.orbit-guide-value-unit { color: var(--text-dim); font-size: var(--font-xs); }
.orbit-guide-color-row { align-items: center; }
.orbit-guide-color-row .w-input { width: 44px; height: 24px; padding: 2px; }
.orbit-guide-color-row.hidden { display: none; }
.orbit-guide-line-count-warning { color: var(--color-error); font-size: var(--font-xs); margin-top: var(--space-2); }
.orbit-guide-line-count-warning.hidden { display: none; }
.orbit-guide-zero-velocity-range { display: flex; flex-direction: column; gap: var(--space-2); }
.orbit-guide-zero-velocity-range.hidden { display: none; }
.orbit-guide-section-divider-wrap { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-3); }
`;

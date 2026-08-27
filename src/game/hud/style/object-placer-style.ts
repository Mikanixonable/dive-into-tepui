// 物体配置パネル(#hud-object-placer、クリエイティブモード限定)の CSS。
export const OBJECT_PLACER_STYLE = `
/* 物体配置パネル(クリエイティブモード限定): MANEUVER PLAN の下、右上に縦積みする。 */
#hud-object-placer { width: 100%; pointer-events: auto; max-height: 70vh; max-height: 70dvh; overflow-y: auto; }
#hud-object-placer .w-close { border-radius: 50%; }
#hud-object-placer .shipplacer-btn-row { display: flex; gap: var(--space-4); margin-top: var(--space-5); }
#hud-object-placer .slider-field { margin-bottom: var(--space-4); }
#hud-object-placer .slider-field .w-group { flex-wrap: nowrap; margin-bottom: 0; }
#hud-object-placer .slider-field .slider-col { flex: 1 1 60px; min-width: 60px; }
#hud-object-placer .slider-field input[type="range"] { width: 100%; pointer-events: auto; accent-color: var(--color-primary); }
#hud-object-placer .slider-field .slider-ticks { display: flex; justify-content: space-between; margin-top: var(--space-1); }
#hud-object-placer .slider-field .slider-ticks span { flex: 0 1 auto; min-width: 0; font-size: calc(var(--font-xxs) * 0.82); color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#hud-object-placer .slider-field .slider-ticks span:first-child { text-align: left; }
#hud-object-placer .slider-field .slider-ticks span:last-child { text-align: right; }
#hud-object-placer input[type="text"] { flex: 1; width: auto; }
#hud-object-placer .preset-row { flex-wrap: wrap; gap: var(--space-3); }
#hud-object-placer .field-issue { border: 1px solid var(--color-error); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); }
#hud-object-placer .issue-list { margin: var(--space-4) 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--color-error); border-radius: var(--radius-s); background: var(--color-error-fill); }
#hud-object-placer .issue-list .issue-line { font-size: var(--font-s); color: var(--color-error); }
`;

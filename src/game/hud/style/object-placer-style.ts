// 物体配置パネル(#hud-object-placer、クリエイティブモード限定)の CSS。
import { MQ_COMPACT } from '../../../hud/breakpoints';

export const OBJECT_PLACER_STYLE = `
/* 右上(上部クロームの下)から始まる浮遊ウィンドウ。ドラッグ・クランプで left/top へ
   焼き付けられた後は、ここの right/top は使われなくなる。 */
#hud-object-placer {
  position: fixed; top: calc(var(--hud-chrome-h, 0px) + var(--space-2)); right: 20px;
  width: max-content; pointer-events: auto;
  max-height: 70vh; max-height: 70dvh; overflow-y: auto;
}
/* compact: 画面下端のシートとして開く。inline style で残った left/top/right/width は
   moveTo がコンパクトの間クリアするので、ここでは CSS だけで位置を決める。 */
@media ${MQ_COMPACT} {
  #hud-object-placer {
    top: auto; right: 0; bottom: 0; left: 0; width: 100%;
    border-radius: var(--radius-panel) var(--radius-panel) 0 0;
    max-height: var(--overlay-max-h-l);
  }
}
#hud-object-placer .editorial-panel-head {
  margin-bottom: var(--space-3); padding-bottom: var(--space-3); cursor: move;
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 22%, transparent);
}
@media ${MQ_COMPACT} {
  #hud-object-placer .editorial-panel-head { cursor: default; }
}
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
#hud-object-placer .field-issue { border: 0; border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); color: var(--color-error); }
#hud-object-placer .issue-list { margin: var(--space-4) 0; }
#hud-object-placer .issue-list .issue-line { color: inherit; }
`;

// 常時小計器(#hud-mini-left / #hud-mini-right)の意匠。スマホ横持ちでだけ出る、画面の上の両端の2枚。
// 行の文法は共通の計器スタイルが持ち、ここは置き場と密度だけを持つ。
import { MQ_COARSE_SHORT } from '../../../hud/breakpoints';

export const MINI_INSTRUMENTS_STYLE = `
#hud-mini-left, #hud-mini-right { display: none; }
#hud.construction-mode #hud-mini-left, #hud.construction-mode #hud-mini-right { display: none !important; }
@media ${MQ_COARSE_SHORT} {
  #hud-mini-left, #hud-mini-right {
    position: absolute; display: block; box-sizing: border-box; pointer-events: none;
    top: calc(var(--space-3) + var(--strip-h) + var(--space-2)); padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-control);
  }
  #hud-mini-left { left: calc(var(--safe-l) + var(--space-4)); width: var(--hud-mini-w); }
  #hud-mini-right { right: calc(var(--safe-r) + var(--space-4)); width: var(--hud-mini-w); }
  #hud-mini-left .ui-readout-value { font-size: var(--font-xl); }
  /* 遠地点・近地点はマップでだけ出す。 */
  #hud:not(.map-ui-active) #hud-mini-left [data-id="mini-ap-row"],
  #hud:not(.map-ui-active) #hud-mini-left [data-id="mini-pe-row"] { display: none; }
  #hud.map-ui-active #hud-mini-right { display: none; }
}
`;

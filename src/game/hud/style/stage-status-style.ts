// ステージ状態表示(#hud-stagestatus)の CSS。
import { MQ_COARSE_SHORT, MQ_MEDIUM_DOWN, MQ_SHORT } from '../../../hud/breakpoints';

export const STAGE_STATUS_STYLE = `
/* ステージ状態が見えている間だけ combat rail の下端を予約する。
   map rail や、ステージ状態を持たない場面の高さは削らない。 */
#hud:has(#hud-stagestatus:not(.hidden)) { --hud-stage-bottom-occupied: 104px; }
#hud .hud-combat-root.active .hud-rail {
  bottom: max(var(--hud-rail-bottom), var(--hud-stage-bottom-occupied, 0px));
}
#hud-stagestatus {
  bottom: calc(12px + var(--safe-b)); left: 50%; transform: translateX(-50%);
  display: flex; align-items: flex-start; gap: var(--space-6);
  text-align: left; min-width: 720px; padding: var(--space-4) var(--space-6);
}
#hud-stagestatus .t {
  font-size: var(--font-s); letter-spacing: 2px; color: var(--text); font-variant-numeric: tabular-nums;
  display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-4); align-items: center;
}
#hud-stagestatus .t .w-meter { width: 240px; }
#hud-stagestatus .k { font-size: var(--font-s); color: var(--text-dim); line-height: 1.8; white-space: nowrap; }
#hud-stagestatus .k-widgets:not(:empty) { margin-top: var(--space-3); }
@media ${MQ_MEDIUM_DOWN} {
  #hud:has(#hud-stagestatus:not(.hidden)) { --hud-stage-bottom-occupied: 70px; }
  #hud-stagestatus { bottom: 8px; width: min(62vw, 440px); min-width: 0; max-height: 62px; overflow-y: auto; padding: var(--space-3) var(--space-5); gap: var(--space-4); }
  #hud-stagestatus .t { font-size: var(--font-s); }
  #hud-stagestatus .k { font-size: var(--font-xxs); line-height: 1.35; white-space: normal; }
}
@media ${MQ_SHORT} {
  #hud:has(#hud-stagestatus:not(.hidden)) { --hud-stage-bottom-occupied: 54px; }
  #hud-stagestatus { max-height: 46px; }
}
@media ${MQ_COARSE_SHORT} {
  /* 下端はドックと武装の帯が使うので、ステージ状態はその上へ置く。 */
  #hud { --hud-stage-bottom: calc(var(--hud-rail-bottom) + var(--row-min-h-s) + var(--space-5)); }
  #hud:has(#hud-stagestatus:not(.hidden)) { --hud-stage-bottom-occupied: calc(var(--hud-stage-bottom) + 46px); }
  #hud-stagestatus { bottom: var(--hud-stage-bottom); max-height: 46px; }
  #hud[data-sheet] #hud-stagestatus { display: none; }
}
`;

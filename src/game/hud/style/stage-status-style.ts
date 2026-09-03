// ステージ状態表示(#hud-stagestatus)の CSS。
import { MQ_COARSE_SHORT, MQ_MEDIUM_DOWN, MQ_SHORT } from '../../../hud/breakpoints';

export const STAGE_STATUS_STYLE = `
/* ステージ状態表示(#hud-stagestatus)。 */
#hud-stagestatus {
  bottom: calc(12px + var(--safe-b)); left: 50%; transform: translateX(-50%);
  display: flex; align-items: flex-start; gap: var(--space-6);
  text-align: left; min-width: 720px; padding: var(--space-4) var(--space-6);
}
#hud-stagestatus .t {
  font-size: var(--font-s); letter-spacing: 2px; color: var(--text); font-variant-numeric: tabular-nums;
  display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-4); align-items: center;
}
#hud-stagestatus .t.warn { color: var(--color-warning); }
#hud-stagestatus .t .w-meter { width: 240px; }
#hud-stagestatus .k { font-size: var(--font-s); color: var(--text-dim); line-height: 1.8; white-space: nowrap; }
#hud-stagestatus .k-widgets:not(:empty) { margin-top: var(--space-3); }
@media ${MQ_MEDIUM_DOWN} {
  #hud-stagestatus { bottom: 8px; width: min(62vw, 440px); min-width: 0; max-height: 62px; overflow-y: auto; padding: var(--space-3) var(--space-5); gap: var(--space-4); }
  #hud-stagestatus .t { font-size: var(--font-s); }
  #hud-stagestatus .k { font-size: var(--font-xxs); line-height: 1.35; white-space: normal; }
}
@media ${MQ_COARSE_SHORT} {
  #hud-stagestatus { max-height: 46px; }
}
@media ${MQ_SHORT} {
  #hud-stagestatus { max-height: 46px; }
}`;

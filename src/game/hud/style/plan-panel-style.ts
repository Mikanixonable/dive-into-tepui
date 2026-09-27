// MANEUVER PLAN パネル(#hud-plan)の CSS。マップ操作の主パネルとして右レールの最上段に置く。
import { MQ_MEDIUM_DOWN } from '../../../hud/breakpoints';

export const PLAN_PANEL_STYLE = `
#hud .hud-rail > #hud-plan { width: 100%; min-width: 0; max-width: none; max-height: none; overflow: visible; }
#hud .hud-rail-right > #hud-plan {
  order: -1;
  align-self: flex-end;
  margin-left: auto;
}

#hud-plan { min-width: 0; width: 100%; max-width: 300px; overflow-wrap: anywhere; }
@media ${MQ_MEDIUM_DOWN} {
  #hud-plan { min-width: 0; max-width: none; }
}

/* 計画も同じ Control Sheet として扱う。 */
#hud-plan.editorial-control-sheet .plan-panel-head {
  display: flex; align-items: baseline; gap: var(--space-2);
  margin-bottom: var(--space-3); padding-bottom: var(--space-3);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 24%, transparent);
}
#hud-plan .plan-node-hero {
  display: grid; gap: var(--space-1); margin-bottom: var(--space-3);
}
#hud-plan .plan-node-hero strong {
  color: var(--text-strong); font-size: var(--font-2xl);
  font-variant-numeric: tabular-nums; letter-spacing: -.03em;
}
#hud-plan .plan-state .editorial-state-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2);
}
#hud-plan .plan-state .editorial-state-cell > :last-child { font-size: var(--font-xxs); }
#hud-plan .plan-post-orbit {
  margin-top: var(--space-3); padding-top: var(--space-3);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-dim) 22%, transparent);
}
#hud-plan .plan-help {
  margin-top: var(--space-3); color: var(--text-dim); font-size: var(--font-xxs); line-height: 1.5;
}
`;

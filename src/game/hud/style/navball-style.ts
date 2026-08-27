// ナビボール(#navball)の CSS。
import * as C from '../../const';
import { MQ_COARSE_SHORT, MQ_MEDIUM_DOWN } from '../breakpoints';

export const NAVBALL_STYLE = `
#navball { top: 12px; left: 12px; width: 190px; pointer-events: auto; }
#navball .nb-ball { display: block; width: 100%; height: auto; margin: var(--space-2) 0 var(--space-4); }
#navball .nb-rim { fill: var(--fill-1); stroke: var(--edge); stroke-width: 1; }
#navball .nb-grid { fill: none; stroke: var(--text-dim); stroke-width: 0.6; opacity: 0.35; }
#navball .nb-equator { fill: none; stroke: var(--text-dim); stroke-width: 0.9; opacity: 0.55; }
#navball .nb-bore line { stroke: ${C.COLOR_MARKER_BORESIGHT}; stroke-width: 1; opacity: 0.8; }
#navball text { font-size: var(--font-xxs); text-anchor: middle; dominant-baseline: middle; }
#navball .nb-pro { fill: var(--axis-prograde); }
#navball .nb-nrm { fill: var(--axis-normal); }
#navball .nb-rad { fill: var(--axis-radial); }
@media ${MQ_MEDIUM_DOWN} {
  #navball { top: 76px; width: 96px !important; height: auto !important; }
}
@media ${MQ_COARSE_SHORT} {
  #navball { top: 60px; width: 72px !important; }
}
`;

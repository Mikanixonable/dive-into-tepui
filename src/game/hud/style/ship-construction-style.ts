import { MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT } from '../../../hud/breakpoints';

export const SHIP_CONSTRUCTION_STYLE = `
/* 建造は通常レールから独立した workspace。中央は3D船体のため意図的に空ける。 */
#ship-construction-panel {
  position: absolute; inset: 0; z-index: 2;
  display: grid; grid-template-columns: minmax(250px, 320px) minmax(220px, 1fr) minmax(270px, 350px);
  gap: var(--space-5); padding: calc(var(--hud-rail-top) + var(--space-4)) var(--space-5) var(--space-5);
  pointer-events: none;
}
#ship-construction-panel.hidden { display: none !important; }
#ship-construction-panel .construction-pane {
  min-height: 0; overflow: auto; pointer-events: auto;
  border-radius: var(--radius-panel); padding: var(--space-5);
}
#ship-construction-panel .construction-pane-left,
#ship-construction-panel .construction-pane-right {
  align-self: stretch;
  display: flex; flex-direction: column;
}
#ship-construction-panel .construction-target {
  display: grid; grid-template-columns: auto 1fr; align-items: baseline; gap: var(--space-1) var(--space-2);
  margin-bottom: var(--space-4); padding-bottom: var(--space-4);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 24%, transparent);
}
#ship-construction-panel .construction-target strong {
  grid-column: 1 / -1; min-width: 0; overflow: hidden; color: var(--text-strong);
  font-size: var(--font-l); text-overflow: ellipsis; white-space: nowrap;
}
#ship-construction-panel .construction-target-dock {
  grid-column: 1 / -1; color: var(--text-dim); font-size: var(--font-xxs);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#ship-construction-panel .construction-catalog { display: flex; flex: 1 1 auto; min-height: 0; flex-direction: column; }
#ship-construction-panel .construction-category-tabs {
  display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 3px; margin-bottom: var(--space-3);
}
#ship-construction-panel .construction-category-tabs .w-btn {
  min-width: 0; padding: var(--space-2) 2px; font-size: var(--font-xxs);
}
#ship-construction-panel .construction-module-cards {
  display: grid; flex: 1 1 auto; min-height: 0; align-content: start; gap: var(--space-2);
  overflow-y: auto; padding-right: 2px; scrollbar-width: thin;
}
#ship-construction-panel .construction-module-card .w-btn {
  display: grid; width: 100%; min-height: 58px; gap: 2px; padding: var(--space-3);
  text-align: left; white-space: normal;
}
#ship-construction-panel .construction-module-name { color: var(--text); font-size: var(--font-xs); font-weight: 650; }
#ship-construction-panel .construction-module-spec,
#ship-construction-panel .construction-module-ability {
  color: var(--text-dim); font-size: var(--font-xxs); font-variant-numeric: tabular-nums;
}
#ship-construction-panel .construction-module-card .w-btn.on {
  box-shadow: inset 2px 0 0 var(--color-primary); background: var(--color-primary-fill);
}
#ship-construction-panel .construction-center {
  align-self: start; justify-self: center; display: grid; grid-template-columns: auto auto;
  align-items: baseline; gap: var(--space-2); max-width: min(520px, 100%);
  margin-top: var(--space-2); padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-pill); background: var(--surface-weak);
  text-align: center; pointer-events: none;
}
#ship-construction-panel .construction-center-note {
  grid-column: 1 / -1; color: var(--text-dim); font-size: var(--font-xxs);
}
#ship-construction-panel .construction-selection {
  display: grid; gap: var(--space-2); margin-bottom: var(--space-4); padding-bottom: var(--space-4);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 24%, transparent);
}
#ship-construction-panel .construction-selection-row {
  display: flex; justify-content: space-between; gap: var(--space-3); align-items: baseline;
}
#ship-construction-panel .construction-selection-row span { color: var(--text-dim); font-size: var(--font-xxs); }
#ship-construction-panel .construction-selection-row strong {
  min-width: 0; overflow: hidden; color: var(--text); font-size: var(--font-xxs);
  text-align: right; text-overflow: ellipsis; white-space: nowrap;
}
#ship-construction-panel .construction-slots {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px;
  max-height: 154px; overflow-y: auto; scrollbar-width: thin;
}
#ship-construction-panel .construction-slot-button {
  min-height: 44px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#ship-construction-panel .construction-slot-button[data-valid="false"] { color: var(--color-warning); }
#ship-construction-panel .construction-metrics {
  display: grid; flex: 1 1 auto;
  grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2);
  min-height: 0; overflow-y: auto; padding-right: 2px;
}
#ship-construction-panel .construction-metric {
  display: grid; align-content: start; gap: 2px; min-width: 0;
  padding: var(--space-3); border-radius: var(--radius-micro); background: var(--glass-inset);
}
#ship-construction-panel .construction-metric output {
  min-width: 0; overflow: hidden; color: var(--text); font-size: var(--font-xs);
  font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap;
}
#ship-construction-panel .construction-metric small { min-height: 1.3em; }
#ship-construction-panel .construction-hp-row { grid-column: 1 / -1; }
#ship-construction-panel .construction-hp-meter,
#ship-construction-panel .construction-hp-meter .w-meter-track { width: 100%; }
#ship-construction-panel .construction-actions {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2);
  margin-top: auto; padding-top: var(--space-4);
}
#ship-construction-panel .construction-warning {
  margin-top: var(--space-3); padding: var(--space-3); border-radius: var(--radius-micro);
  color: var(--color-warning); background: var(--color-warning-fill); font-size: var(--font-xxs);
}
#ship-construction-panel .construction-destructive-actions {
  grid-column: 1 / -1; margin-top: var(--space-1); padding-top: var(--space-2);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-dim) 25%, transparent);
}
#ship-construction-panel .construction-destructive-actions .w-btn { width: 100%; }
#ship-construction-panel [data-id="construction-role"][data-role="ship"] { color: var(--color-primary); }
#ship-construction-panel [data-id="construction-role"][data-role="base"] { color: var(--color-signal); }
#ship-construction-panel [data-id="construction-role"][data-role="material"] { color: var(--color-warning); }
#ship-construction-panel .construction-mobile-tabs { display: none; }

@media ${MQ_MEDIUM_DOWN} {
  #ship-construction-panel {
    grid-template-columns: minmax(220px, .9fr) minmax(240px, 1.1fr);
    grid-template-rows: auto minmax(0, 1fr);
    gap: var(--space-3); padding-inline: var(--space-3);
  }
  #ship-construction-panel .construction-center { grid-column: 1 / -1; grid-row: 1; margin-top: 0; }
  #ship-construction-panel .construction-pane-left { grid-column: 1; grid-row: 2; }
  #ship-construction-panel .construction-pane-right { grid-column: 2; grid-row: 2; }
  #ship-construction-panel .construction-pane { padding: var(--space-4); }
  #ship-construction-panel .construction-metrics { grid-template-columns: minmax(0, 1fr); }
  #ship-construction-panel .construction-hp-row { grid-column: auto; }
}
@media ${MQ_COMPACT} {
  #ship-construction-panel {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(140px, 34vh) auto minmax(0, 1fr);
    padding: calc(var(--hud-rail-top) + var(--space-3)) var(--space-3) var(--space-3);
  }
  #ship-construction-panel .construction-center {
    grid-row: 1; grid-column: 1; align-self: start; margin-top: 0;
  }
  #ship-construction-panel .construction-mobile-tabs {
    grid-row: 2; grid-column: 1; width: min(100%, 560px); justify-self: center; pointer-events: auto;
  }
  #ship-construction-panel .construction-pane {
    grid-row: 3; grid-column: 1; width: min(100%, 560px); justify-self: center;
  }
  #ship-construction-panel .construction-pane-left,
  #ship-construction-panel .construction-pane-right { display: none; }
  #ship-construction-panel[data-mobile-pane="catalog"] .construction-pane-left,
  #ship-construction-panel[data-mobile-pane="status"] .construction-pane-right { display: flex; }
  #ship-construction-panel .construction-mobile-tabs {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2);
    margin-bottom: var(--space-3);
  }
  #ship-construction-panel .construction-module-cards { max-height: none; }
}
@media ${MQ_SHORT} {
  #ship-construction-panel { padding-top: calc(var(--space-5) + 32px); }
  #ship-construction-panel .construction-center-note { display: none; }
  #ship-construction-panel .construction-target { margin-bottom: var(--space-2); padding-bottom: var(--space-2); }
}

/* 確認ダイアログは workspace の上に独立して出す。 */
#ship-construction-confirm {
  position: absolute; top: 50%; left: 50%;
  width: min(420px, calc(100vw - var(--space-8))); max-height: var(--overlay-max-h-s);
  transform: translate(-50%, -50%); overflow-y: auto;
  gap: var(--space-4); padding: var(--space-6);
}
#ship-construction-confirm h3 { margin: 0; }
#ship-construction-confirm p { margin: 0; color: var(--text-dim); line-height: 1.6; }
#ship-construction-confirm[data-destructive="true"] h3 { color: var(--color-warning); }
#ship-construction-confirm .construction-confirm-actions {
  display: flex; justify-content: flex-end; gap: var(--space-3);
}
`;

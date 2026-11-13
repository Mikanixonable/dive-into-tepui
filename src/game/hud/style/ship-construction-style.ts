import { MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT } from '../../../hud/breakpoints';

export const SHIP_CONSTRUCTION_STYLE = `
/* 建造は通常レールから独立した workspace。左にカタログ、右に船体の状態、中央列の
   下段に手元バーを置き、中央の残りは3D船体のため意図的に空ける。 */
#ship-construction-panel {
  position: absolute; inset: 0; z-index: 2;
  display: grid;
  grid-template-columns: minmax(250px, 320px) minmax(220px, 1fr) minmax(270px, 350px);
  grid-template-rows: minmax(0, 1fr) auto;
  gap: var(--space-5); padding: calc(var(--hud-chrome-h) + var(--space-4)) var(--space-5) var(--space-5);
  pointer-events: none;
}
#ship-construction-panel.hidden { display: none !important; }
#ship-construction-panel .construction-pane {
  min-height: 0; overflow: auto; pointer-events: auto;
  border-radius: var(--radius-panel); padding: var(--space-5);
}
#ship-construction-panel .construction-pane-left { grid-column: 1; grid-row: 1 / -1; }
#ship-construction-panel .construction-pane-right { grid-column: 3; grid-row: 1 / -1; }
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
#ship-construction-panel .construction-catalog { display: flex; flex: 1 1 auto; min-height: 0; flex-direction: column; }
#ship-construction-panel .construction-category-tabs {
  display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 3px; margin-bottom: var(--space-3);
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
  text-align: left; white-space: normal; touch-action: none;
}
#ship-construction-panel .construction-module-name { color: var(--text); font-size: var(--font-xs); font-weight: 650; }
#ship-construction-panel .construction-module-spec,
#ship-construction-panel .construction-module-ability {
  color: var(--text-dim); font-size: var(--font-xxs); font-variant-numeric: tabular-nums;
}
#ship-construction-panel .construction-module-card .w-btn.on {
  box-shadow: inset 2px 0 0 var(--color-primary); background: var(--color-primary-fill);
}
#ship-construction-panel .construction-blueprint-card .w-btn { cursor: grab; }
#ship-construction-panel .construction-blueprint-tools {
  display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-1);
}
#ship-construction-panel .construction-blueprint-rename { width: 100%; }
#ship-construction-panel .construction-blueprint-empty {
  margin: 0; color: var(--text-dim); font-size: var(--font-xxs); line-height: 1.5;
}

/* 手元バー: 中央列の下段に流し込む1セル。状態の言い切りと、その状態で効く操作を持つ。 */
#ship-construction-panel .construction-hand {
  grid-column: 2; grid-row: 2;
  align-self: end; justify-self: center;
  display: flex; flex-direction: column; gap: var(--space-3);
  width: min(100%, 560px); padding: var(--space-3) var(--space-4);
  pointer-events: auto;
}
#ship-construction-panel .construction-hand-status {
  display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap;
}
#ship-construction-panel .construction-hand-state { color: var(--text-dim); font-size: var(--font-xs); }
#ship-construction-panel .construction-hand-name {
  min-width: 0; overflow: hidden; color: var(--text); font-size: var(--font-s);
  text-overflow: ellipsis; white-space: nowrap;
}
#ship-construction-panel .construction-hand-orientation {
  min-width: 0; overflow: hidden; color: var(--text-dim); font-size: var(--font-xxs);
  margin-left: auto; text-overflow: ellipsis; white-space: nowrap;
}
#ship-construction-panel .construction-hand-blueprint {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); align-items: center;
}
#ship-construction-panel .construction-hand-reason { margin: 0; }
#ship-construction-panel .construction-button-row {
  display: flex; flex-wrap: wrap; gap: var(--space-2);
}
#ship-construction-panel .construction-note {
  margin: 0; color: var(--color-warning); font-size: var(--font-xxs); line-height: 1.5;
}

/* 船体の状態: 役割と締めのボタンはタブによらず常に見え、選んだタブの本文が内側でスクロールする。 */
#ship-construction-panel .construction-role-row {
  display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-3);
  margin-bottom: var(--space-3);
}
#ship-construction-panel .construction-role-row output { font-size: var(--font-s); }
#ship-construction-panel .construction-state-tabs { margin-bottom: var(--space-3); }
#ship-construction-panel .construction-state-tabs .w-btn { flex: 1; }
#ship-construction-panel .construction-state-body {
  display: flex; flex: 1 1 auto; min-height: 0; flex-direction: column; gap: var(--space-3);
  overflow-y: auto; scrollbar-width: thin;
}
#ship-construction-panel .construction-metrics {
  display: grid; flex: 0 0 auto;
  grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2);
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
#ship-construction-panel .construction-slots {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px;
  max-height: 154px; overflow-y: auto; scrollbar-width: thin;
}
#ship-construction-panel .construction-slot-button {
  min-height: 44px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#ship-construction-panel .construction-slot-button[data-valid="false"] { color: var(--color-warning); }
#ship-construction-panel .construction-slot-reason {
  display: block; color: var(--color-warning); font-size: var(--font-xxs); font-weight: 400;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#ship-construction-panel .construction-history-list {
  display: grid; gap: 3px; max-height: 154px; overflow-y: auto; scrollbar-width: thin;
}
#ship-construction-panel .construction-history-item {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;
}
#ship-construction-panel .construction-close-actions {
  display: grid; gap: var(--space-2); padding-top: var(--space-4);
}
#ship-construction-panel .construction-destructive-actions {
  margin-top: var(--space-1); padding-top: var(--space-2);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-dim) 25%, transparent);
}
#ship-construction-panel .construction-destructive-actions .w-btn { width: 100%; }
#ship-construction-panel [data-id="construction-role"][data-role="ship"] { color: var(--color-primary); }
#ship-construction-panel [data-id="construction-role"][data-role="base"] { color: var(--color-signal); }
#ship-construction-panel [data-id="construction-role"][data-role="material"] { color: var(--color-warning); }
#ship-construction-panel .construction-mobile-tabs { display: none; }

@media ${MQ_MEDIUM_DOWN} {
  #ship-construction-panel {
    grid-template-columns: minmax(220px, 280px) minmax(140px, 1fr) minmax(240px, 300px);
    gap: var(--space-3); padding-inline: var(--space-3);
  }
  #ship-construction-panel .construction-pane { padding: var(--space-4); }
  #ship-construction-panel .construction-metrics { grid-template-columns: minmax(0, 1fr); }
  #ship-construction-panel .construction-hp-row { grid-column: auto; }
}
@media ${MQ_COMPACT} {
  /* 縦に 3D の空き → 切り替え → 選んだペイン → 手元バー。手元バーは画面の下端に固定され、
     3D とともに切り替えによらず常に見える。3D の行に最小高さを持たせ、縮むのはペインの行。 */
  #ship-construction-panel {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(140px, 34vh) auto minmax(0, 1fr) auto;
    grid-template-rows: minmax(140px, 34dvh) auto minmax(0, 1fr) auto;
    padding: calc(var(--hud-chrome-h) + var(--space-3)) var(--space-3) var(--space-3);
  }
  #ship-construction-panel .construction-hand { grid-column: 1; grid-row: 4; }
  #ship-construction-panel .construction-mobile-tabs {
    grid-column: 1; grid-row: 2;
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2);
    width: min(100%, 560px); justify-self: center; margin-bottom: var(--space-3);
    pointer-events: auto;
  }
  #ship-construction-panel .construction-pane {
    grid-column: 1; grid-row: 3; width: min(100%, 560px); justify-self: center;
  }
  #ship-construction-panel .construction-pane-left,
  #ship-construction-panel .construction-pane-right { display: none; }
  #ship-construction-panel[data-mobile-pane="catalog"] .construction-pane-left,
  #ship-construction-panel[data-mobile-pane="status"] .construction-pane-right { display: flex; }
  #ship-construction-panel .construction-module-cards { max-height: none; }
}
@media ${MQ_SHORT} {
  #ship-construction-panel { padding-top: calc(var(--space-5) + 32px); }
  #ship-construction-panel .construction-target { margin-bottom: var(--space-2); padding-bottom: var(--space-2); }
}
`;

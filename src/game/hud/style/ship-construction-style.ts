export const SHIP_CONSTRUCTION_STYLE = `
#ship-construction-panel {
  min-height: 0;
}
#ship-construction-panel .panel-shell-body {
  min-height: 0;
}
#ship-construction-panel .construction-target {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: var(--space-3);
  padding: var(--space-3);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-primary) 35%, transparent);
  border-radius: var(--radius-micro);
  background: var(--glass-inset);
}
#ship-construction-panel .construction-target strong {
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
#ship-construction-panel .construction-target-dock,
#ship-construction-panel .construction-selection-row span,
#ship-construction-panel .metric small {
  color: var(--text-dim);
  font-size: var(--font-xxs);
}
#ship-construction-panel .construction-category-tabs {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 3px;
  margin-bottom: var(--space-2);
}
#ship-construction-panel .construction-category-tabs .w-btn {
  min-width: 0;
  padding: var(--space-2) 2px;
  font-size: var(--font-xxs);
}
#ship-construction-panel .construction-module-cards {
  display: grid;
  gap: var(--space-2);
  max-height: 154px;
  overflow-y: auto;
  padding-right: 2px;
  scrollbar-width: thin;
}
#ship-construction-panel .construction-module-card .w-btn {
  width: 100%;
  min-height: 44px;
  text-align: left;
  white-space: normal;
}
#ship-construction-panel .construction-selection {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-3) 0;
  padding: var(--space-3);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--text-dim) 35%, transparent);
  border-radius: var(--radius-micro);
  background: var(--glass-inset);
}
#ship-construction-panel .construction-selection-row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: baseline;
}
#ship-construction-panel .construction-selection-row strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-size: var(--font-xxs);
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#ship-construction-panel .construction-slots {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 3px;
  max-height: 142px;
  overflow-y: auto;
  scrollbar-width: thin;
}
#ship-construction-panel .construction-slot-button {
  min-height: 44px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#ship-construction-panel .construction-slot-button[data-valid="false"] {
  color: var(--color-warning);
}
#ship-construction-panel .construction-hp-row .v {
  display: grid;
  gap: 2px;
}
#ship-construction-panel .construction-hp-meter,
#ship-construction-panel .construction-hp-meter .w-meter-track {
  width: 100%;
}
#ship-construction-panel .construction-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
  margin-top: var(--space-3);
}
#ship-construction-panel .construction-warning {
  color: var(--color-warning);
  margin: var(--space-2) 0 0;
  font-size: var(--font-xxs);
}
#ship-construction-panel .construction-destructive-actions {
  grid-column: 1 / -1;
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-dim) 25%, transparent);
}
#ship-construction-panel .construction-destructive-actions .w-btn { width: 100%; }
#ship-construction-panel [data-id="construction-role"][data-role="ship"] { color: var(--color-primary); }
#ship-construction-panel [data-id="construction-role"][data-role="base"] { color: var(--color-signal); }
#ship-construction-panel [data-id="construction-role"][data-role="material"] { color: var(--color-warning); }
#ship-construction-confirm {
  position: absolute;
  top: 50%;
  left: 50%;
  width: min(420px, calc(100vw - var(--space-8)));
  transform: translate(-50%, -50%);
  gap: var(--space-4);
  padding: var(--space-6);
}
#ship-construction-confirm h3 { margin: 0; }
#ship-construction-confirm p {
  margin: 0;
  color: var(--text-dim);
  line-height: 1.6;
}
#ship-construction-confirm[data-destructive="true"] h3 { color: var(--color-warning); }
#ship-construction-confirm .construction-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
}
`;

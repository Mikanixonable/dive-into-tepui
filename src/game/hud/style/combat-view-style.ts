// 戦闘ビュー専用の意匠。常設計器は背後の戦場を隠しすぎない Quiet Glass とし、
// 有彩色は第一対象・隣接・第二対象/同期・危険を表す小さな箇所だけへ限定する。
import { MQ_COARSE, MQ_MEDIUM_DOWN } from '../../../hud/breakpoints';

export const COMBAT_VIEW_STYLE = `
#hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status,
#hud:not(.base-mode) .hud-combat-root.active #hud-orbit,
#hud:not(.base-mode) .hud-combat-root.active #burn-management-panel,
#hud:not(.base-mode) .hud-combat-root.active #ship-construction-panel,
#hud:not(.base-mode) .hud-combat-root.active #hud-enemies,
#hud:not(.base-mode) .hud-combat-root.active #hud-target,
#hud:not(.base-mode) .hud-combat-root.active #hud-combat-camera-controls {
  padding: 10px var(--space-5);
  max-height: none;
  overflow: visible;
}
#hud:not(.base-mode) .hud-combat-root.active .hud-rail-right > #hud-vessel-status,
#hud:not(.base-mode) .hud-combat-root.active .hud-rail-left > #hud-orbit,
#hud:not(.base-mode) .hud-combat-root.active .hud-rail-left > #burn-management-panel,
#hud:not(.base-mode) .hud-combat-root.active .hud-rail-right > #ship-construction-panel,
#hud:not(.base-mode) .hud-combat-root.active .hud-rail-right > #hud-enemies,
#hud:not(.base-mode) .hud-combat-root.active .hud-rail-left > #hud-combat-camera-controls {
  width: 100%;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-combat-camera-controls h3 {
  margin-bottom: var(--space-3);
  color: var(--text);
  font-size: var(--font-s);
  font-weight: 600;
  letter-spacing: 0;
  line-height: 1.35;
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-shell-collapse {
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-dim);
  line-height: 1;
  transition: color var(--transition-fast), background var(--transition-fast);
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-shell-collapse:hover {
  background: var(--fill-1);
  color: var(--color-primary-hover);
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .metric-list {
  display: grid;
  gap: 1px;
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .metric {
  min-height: 22px;
  align-items: baseline;
  padding: 3px 0;
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .metric .k {
  color: var(--text-dim);
  font-size: var(--font-xs);
  line-height: 1.35;
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .metric .v {
  color: var(--text);
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel kbd {
  padding: 1px var(--space-2);
  border: 0;
  border-radius: var(--radius-micro);
  background: var(--fill-1);
  color: var(--text-dim);
  font: inherit;
  font-size: 0.9em;
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-actions {
  gap: 5px;
  margin-top: 7px;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status .status-throttle-touch {
  margin-top: 7px;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status .status-throttle-touch .w-group-title {
  color: var(--text-dim);
  letter-spacing: 0;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status .status-throttle-touch .w-btn {
  border: 0;
  border-radius: var(--radius-control);
  background: var(--fill-1);
}
#hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status .status-throttle-touch .w-btn.on {
  background: var(--color-primary-fill);
  color: var(--color-primary);
}
#hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status .vessel-deploy-controls .vessel-deploy-btn {
  border: 0;
  border-radius: var(--radius-control);
  background: var(--fill-1);
  color: var(--text-dim);
  font-size: var(--font-xxs);
}
#hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status .vessel-deploy-controls .vessel-deploy-btn.on {
  background: var(--color-primary-fill);
  color: var(--color-primary);
}
#hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status .vessel-deploy-controls .vessel-deploy-btn:hover {
  background: var(--fill-2);
  color: var(--color-primary-hover);
}

#hud:not(.base-mode) .hud-combat-root.active #hud-target .target-help {
  margin-top: var(--space-3);
  color: var(--text-dim);
  font-size: var(--font-xxs);
  line-height: 1.45;
}

#hud:not(.base-mode) #hud-topbar {
  border-radius: 0 0 var(--radius-panel) var(--radius-panel);
}
#hud:not(.base-mode) #hud-simulation-status .k { color: var(--text-dim); }
#hud:not(.base-mode) #hud-simulation-status .gs-sep { color: var(--fill-4); }
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-shell-collapse:focus-visible,
#hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status .w-btn:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}

@media ${MQ_MEDIUM_DOWN} {
  #hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status,
  #hud:not(.base-mode) .hud-combat-root.active #hud-orbit,
  #hud:not(.base-mode) .hud-combat-root.active #hud-enemies,
  #hud:not(.base-mode) .hud-combat-root.active #hud-target,
  #hud:not(.base-mode) .hud-combat-root.active #hud-combat-camera-controls {
    padding: var(--space-4) 10px;
  }
}
@media ${MQ_COARSE} {
  #hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-shell-collapse {
    min-width: var(--hit-target-min);
    min-height: var(--hit-target-min);
  }
}
`;

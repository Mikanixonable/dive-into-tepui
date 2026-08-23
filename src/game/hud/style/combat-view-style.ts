// 戦闘ビュー専用の意匠。常設計器は背後の戦場を隠しすぎない Quiet Glass とし、
// 有彩色は第一対象・隣接・第二対象/同期・危険を表す小さな箇所だけへ限定する。
import { MQ_COARSE, MQ_MEDIUM_DOWN } from '../breakpoints';

export const COMBAT_VIEW_STYLE = `
#hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status,
#hud:not(.base-mode) .hud-combat-root.active #hud-orbit,
#hud:not(.base-mode) .hud-combat-root.active #hud-enemies,
#hud:not(.base-mode) .hud-combat-root.active #hud-target {
  background: var(--glass-quiet, var(--surface));
  border: 0;
  border-radius: var(--radius-panel, 16px);
  padding: 10px 12px;
  backdrop-filter: blur(14px) saturate(82%);
  -webkit-backdrop-filter: blur(14px) saturate(82%);
  box-shadow: 0 12px 30px var(--shade-1);
  max-height: var(--combat-panel-max-h);
  overflow-y: auto;
}
#hud:not(.base-mode) .hud-combat-root.active .hud-rail-right > #hud-vessel-status,
#hud:not(.base-mode) .hud-combat-root.active .hud-rail-left > #hud-orbit,
#hud:not(.base-mode) .hud-combat-root.active .hud-rail-right > #hud-enemies {
  width: 100%;
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-shell-head {
  align-items: center;
  margin-bottom: 7px;
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-shell-head h3 {
  margin: 0;
  padding: 0;
  border: 0;
  color: var(--text);
  font-size: var(--font-s);
  font-weight: 600;
  letter-spacing: 0.01em;
  line-height: 1.35;
  text-transform: none;
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-shell-collapse {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--radius-control, 11px);
  background: transparent;
  color: var(--text-dim);
  line-height: 1;
  transition: color 140ms, background 140ms;
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
  padding: 1px 4px;
  border: 0;
  border-radius: var(--radius-micro, 8px);
  background: var(--fill-1);
  color: var(--text-dim);
  font: inherit;
  font-size: 0.9em;
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .state-near {
  color: var(--color-primary-hover);
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .state-signal {
  color: var(--color-signal);
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-actions {
  gap: 5px;
  margin-top: 7px;
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-actions .w-btn {
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius-control, 11px);
  background: var(--fill-1);
  color: var(--text-dim);
  font-size: var(--font-xxs);
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-actions .w-btn.on {
  background: var(--color-primary-fill);
  color: var(--color-primary);
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-actions .w-btn:hover {
  background: var(--fill-2);
  color: var(--color-primary-hover);
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-actions .status-action-primary {
  background: var(--color-primary-fill-weak);
  color: var(--color-primary);
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
  border-radius: var(--radius-control, 11px);
  background: var(--fill-1);
}
#hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status .status-throttle-touch .w-btn.on {
  background: var(--color-primary-fill);
  color: var(--color-primary);
}
#hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status .vessel-deploy-controls .vessel-deploy-btn {
  border: 0;
  border-radius: var(--radius-control, 11px);
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

#hud:not(.base-mode) .hud-combat-root.active #hud-target .target-identity {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 2px 7px;
  margin-bottom: 7px;
  padding: 7px 8px;
  border-radius: var(--radius-control, 11px);
  background: color-mix(in srgb, var(--color-signal) 8%, transparent);
}
#hud:not(.base-mode) .hud-combat-root.active #hud-target .target-lock-glyph {
  grid-row: 1 / span 2;
  color: var(--color-signal);
  font-size: var(--font-xl);
}
#hud:not(.base-mode) .hud-combat-root.active #hud-target .target-name {
  min-width: 0;
  overflow: hidden;
  color: var(--color-signal);
  font-size: var(--font-l);
  font-weight: 600;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-target .target-role {
  color: var(--text-dim);
  font-size: var(--font-xxs);
  line-height: 1.25;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-target .target-primary-value { color: var(--color-signal); }
#hud:not(.base-mode) .hud-combat-root.active #hud-target .armor-readout {
  display: inline-grid;
  grid-template-columns: minmax(64px, 1fr) auto;
  align-items: center;
  gap: 6px;
  width: 128px;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-target .armor-meter {
  height: 6px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--bar-bg);
}
#hud:not(.base-mode) .hud-combat-root.active #hud-target .armor-meter-fill {
  display: block;
  width: 0;
  height: 100%;
  border-radius: inherit;
  background: var(--color-signal);
  transition: width 180ms;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-target .armor-meter.critical .armor-meter-fill {
  background: var(--color-error);
}
#hud:not(.base-mode) .hud-combat-root.active #hud-target .armor-value {
  min-width: 48px;
  color: var(--text);
  font-size: var(--font-xxs);
  text-align: right;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-target .target-help {
  margin-top: 6px;
  color: var(--text-dim);
  font-size: var(--font-xxs);
  line-height: 1.45;
}

#hud:not(.base-mode) .hud-combat-root.active #hud-enemies .panel-count {
  margin-left: 5px;
  color: var(--text-dim);
  font-size: var(--font-xxs);
  font-weight: 500;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-enemies .contact-list {
  display: grid;
  gap: 2px;
  list-style: none;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-enemies .contact-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 7px;
  min-height: 24px;
  padding: 4px 6px;
  border-radius: var(--radius-micro, 8px);
  color: var(--text-dim);
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-enemies .contact-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-enemies .contact-distance { color: currentColor; }
#hud:not(.base-mode) .hud-combat-root.active #hud-enemies .contact-role {
  min-width: 28px;
  color: currentColor;
  font-size: var(--font-xxs);
  text-align: right;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-enemies .contact-row.primary {
  background: var(--color-primary-fill-weak);
  color: var(--color-primary);
}
#hud:not(.base-mode) .hud-combat-root.active #hud-enemies .contact-row.near {
  color: var(--color-primary-hover);
}
#hud:not(.base-mode) .hud-combat-root.active #hud-enemies .contact-row.secondary {
  color: var(--color-signal);
}
#hud:not(.base-mode) .hud-combat-root.active #hud-enemies .contact-empty {
  padding: 4px 0;
  color: var(--text-dim);
  font-size: var(--font-xs);
}

#hud:not(.base-mode) #hud-simulation-status {
  border: 0;
  border-radius: 0 0 var(--radius-panel, 16px) var(--radius-panel, 16px);
  background: var(--glass-quiet, var(--surface));
  backdrop-filter: blur(14px) saturate(82%);
  -webkit-backdrop-filter: blur(14px) saturate(82%);
  box-shadow: 0 10px 28px var(--shade-1);
}
#hud:not(.base-mode) #hud-simulation-status .k { color: var(--text-dim); }
#hud:not(.base-mode) #hud-simulation-status .gs-sep { color: var(--fill-4); }
#hud:not(.base-mode) .hud-combat-root.active #hud-chase-reset {
  border: 0;
  border-radius: var(--radius-control, 11px);
  background: var(--glass-quiet, var(--surface));
  color: var(--text-dim);
  backdrop-filter: blur(14px) saturate(82%);
  -webkit-backdrop-filter: blur(14px) saturate(82%);
  box-shadow: 0 8px 22px var(--shade-1);
  transition: color 140ms, background 140ms;
}
#hud:not(.base-mode) .hud-combat-root.active #hud-chase-reset { border-radius: 50%; }
#hud:not(.base-mode) .hud-combat-root.active #hud-chase-reset:hover {
  background: var(--fill-2);
  color: var(--color-primary-hover);
}
#hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-shell-collapse:focus-visible,
#hud:not(.base-mode) .hud-combat-root.active #hud-chase-reset:focus-visible,
#hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status .w-btn:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  #hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status,
  #hud:not(.base-mode) .hud-combat-root.active #hud-orbit,
  #hud:not(.base-mode) .hud-combat-root.active #hud-enemies,
  #hud:not(.base-mode) .hud-combat-root.active #hud-target,
  #hud:not(.base-mode) .hud-combat-root.active #hud-chase-reset {
    background: var(--surface);
  }
  #hud:not(.base-mode) #hud-simulation-status {
    background: var(--surface);
  }
}
@media ${MQ_MEDIUM_DOWN} {
  #hud:not(.base-mode) .hud-combat-root.active #hud-vessel-status,
  #hud:not(.base-mode) .hud-combat-root.active #hud-orbit,
  #hud:not(.base-mode) .hud-combat-root.active #hud-enemies,
  #hud:not(.base-mode) .hud-combat-root.active #hud-target {
    padding: 8px 10px;
  }
}
@media ${MQ_COARSE} {
  #hud:not(.base-mode) .hud-combat-root.active .combat-panel .panel-shell-collapse,
  #hud:not(.base-mode) .hud-combat-root.active #hud-chase-reset {
    min-width: var(--hit-target-min);
    min-height: var(--hit-target-min);
  }
}
@media (prefers-reduced-motion: reduce) {
  #hud:not(.base-mode) .hud-combat-root.active .combat-panel *,
  #hud:not(.base-mode) .hud-combat-root.active #hud-chase-reset,
  #hud:not(.base-mode) #hud-simulation-status {
    transition-duration: 0.001ms !important;
  }
}
`;

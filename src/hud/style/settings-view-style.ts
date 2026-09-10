// ESCメニュー内の設定詳細面(.pm-settings-view)の CSS。
import { MQ_MEDIUM_DOWN } from '../breakpoints';

export const SETTINGS_VIEW_STYLE = `
#hud-pause-menu .pm-settings-view {
  display: block; pointer-events: auto; padding: var(--space-2) 0 var(--space-4);
}
#hud-pause-menu .pm-settings-view .sv-header,
#hud-pause-menu .pm-settings-view .sv-description,
#hud-pause-menu .pm-settings-view .sv-section { width: 100%; margin-inline: auto; }
#hud-pause-menu .pm-settings-view .sv-header {
  display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);
  border-bottom: 1px solid var(--edge); padding-bottom: var(--space-5);
}
#hud-pause-menu .pm-settings-view .sv-heading-group { display: flex; flex-direction: column; gap: var(--space-2); }
#hud-pause-menu .pm-settings-view .sv-header h2 { color: var(--title); font-size: var(--font-2xl); letter-spacing: 0.1em; }
#hud-pause-menu .pm-settings-view .sv-eyebrow { color: var(--color-primary); font-size: var(--font-xxs); letter-spacing: 0.12em; }
#hud-pause-menu .pm-settings-view .sv-description {
  margin-top: var(--space-5); padding-left: var(--space-4); border-left: 2px solid var(--color-primary);
  color: var(--text-dim); font-size: var(--font-s); line-height: 1.6;
}
#hud-pause-menu .pm-settings-view .sv-tabs {
  width: min(100%, 760px); margin: var(--space-6) auto 0;
  gap: var(--space-1); padding: var(--space-1); border: 1px solid var(--glass-edge);
  border-radius: var(--radius-panel); background: var(--glass-inset);
}
#hud-pause-menu .pm-settings-view .sv-tabs .w-btn {
  display: flex; flex: 1 1 0; min-width: 0; min-height: 62px;
  align-items: center; justify-content: center; padding: var(--space-4) var(--space-3) var(--space-3);
  border: 1px solid transparent; border-radius: var(--radius-control); text-align: center;
  font-size: var(--font-m); font-weight: 600; letter-spacing: 0.06em;
  background: transparent; color: var(--text-dim); box-shadow: none;
}
#hud-pause-menu .pm-settings-view .sv-tabs .w-btn:hover {
  background: var(--glass-control); color: var(--color-primary-hover); transform: none;
}
#hud-pause-menu .pm-settings-view .sv-tabs .w-btn.on {
  border-color: var(--color-primary-edge-soft); background: var(--color-primary-fill); color: var(--color-primary);
}
#hud-pause-menu .pm-settings-view .sv-section {
  position: relative; margin-top: var(--space-7); padding: var(--space-6);
  border: 1px solid var(--glass-edge); border-radius: var(--radius-panel);
  background: linear-gradient(145deg, var(--glass-highlight), transparent 48%), var(--glass-inset);
}
#hud-pause-menu .pm-settings-view .sv-tab-panel[hidden] { display: none; }
#hud-pause-menu .pm-settings-view .sv-section h3 {
  display: flex; align-items: center; gap: var(--space-3); margin: 0;
  color: var(--title); font-size: var(--font-m); letter-spacing: 0.08em;
}
#hud-pause-menu .pm-settings-view .sv-section h3::before {
  width: var(--space-2); height: var(--font-m); border-radius: var(--radius-micro); background: var(--color-primary); content: '';
}
#hud-pause-menu .pm-settings-view .sv-theme-options {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--space-3);
  margin-top: var(--space-4);
}
#hud-pause-menu .pm-settings-view .sv-theme-button {
  display: flex; align-items: center; gap: var(--space-2); min-height: 48px; width: 100%;
  padding: var(--space-2) var(--space-3); border: 1px solid var(--glass-edge);
  border-radius: var(--radius-control); text-align: left;
  background: var(--glass-control); box-shadow: none;
}
#hud-pause-menu .pm-settings-view .sv-theme-button:not(.on) {
  color: var(--sv-theme-title);
}
#hud-pause-menu .pm-settings-view .sv-theme-button:not(.on):hover {
  background: var(--glass-control-hover);
  color: var(--sv-theme-title);
}
#hud-pause-menu .pm-settings-view .sv-theme-button.on {
  border-color: var(--color-primary-edge-soft); background: var(--color-primary-fill);
  color: var(--sv-theme-title);
}
#hud-pause-menu .pm-settings-view .sv-theme-button.on::after {
  margin-left: auto; color: var(--color-primary); content: '選択中'; font-size: var(--font-xxs); white-space: nowrap;
}
#hud-pause-menu .pm-settings-view .sv-theme-button .w-btn-icon {
  display: inline-flex; align-items: center; gap: 3px; width: auto; height: auto; margin-right: var(--space-2);
}
#hud-pause-menu .pm-settings-view .sv-theme-icon { display: inline-flex; align-items: center; }
#hud-pause-menu .pm-settings-view .sv-theme-preview {
  display: inline-flex; align-items: center; gap: 4px; width: auto; height: 25px; padding: 3px;
  border: 1px solid var(--glass-edge); border-radius: var(--radius-micro); box-sizing: border-box;
}
#hud-pause-menu .pm-settings-view .sv-theme-swatch {
  display: block; width: 14px; height: 14px; border-radius: 50%;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--sv-theme-title) 28%, transparent);
}
#hud-pause-menu .pm-settings-view .sv-preview-button,
#hud-pause-menu .pm-settings-view .sv-track-actions .w-btn {
  border: 1px solid var(--glass-edge); border-radius: var(--radius-control);
  background: var(--glass-control); box-shadow: none;
}
#hud-pause-menu .pm-settings-view .sv-preview-button:hover,
#hud-pause-menu .pm-settings-view .sv-track-actions .w-btn:hover {
  border-color: var(--glass-edge); background: var(--glass-control-hover); color: var(--color-primary-hover);
}
#hud-pause-menu .pm-settings-view .sv-volume-row {
  display: flex; align-items: center; gap: var(--space-4); margin-top: var(--space-4);
  padding: var(--space-4); background: var(--glass-inset); border: 1px solid var(--glass-edge); border-radius: var(--radius-control);
}
#hud-pause-menu .pm-settings-view .sv-label { width: 4em; color: var(--text-dim); }
#hud-pause-menu .pm-settings-view .sv-volume-row .w-slider { flex: 1; }
#hud-pause-menu .pm-settings-view .sv-volume-value { width: 4em; color: var(--text); text-align: right; font-variant-numeric: tabular-nums; }
#hud-pause-menu .pm-settings-view .sv-track-list { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-4); }
#hud-pause-menu .pm-settings-view .sv-track-row {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);
  min-height: var(--hit-target-min); padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
  background: var(--glass-inset); border: 1px solid var(--glass-edge); border-radius: var(--radius-control);
}
#hud-pause-menu .pm-settings-view .sv-track-row:has(.w-btn.on) {
  border-color: var(--color-primary-edge-soft); background: var(--color-primary-fill-weak);
}
#hud-pause-menu .pm-settings-view .sv-track-label { display: flex; align-items: baseline; gap: var(--space-4); color: var(--text); }
#hud-pause-menu .pm-settings-view .sv-track-number { color: var(--text-dim); font-size: var(--font-xxs); font-variant-numeric: tabular-nums; }
#hud-pause-menu .pm-settings-view .sv-preview-button { min-width: 76px; text-align: center; }
#hud-pause-menu .pm-settings-view .sv-track-actions { margin-top: var(--space-4); text-align: right; }
@media ${MQ_MEDIUM_DOWN} {
  #hud-pause-menu .pm-settings-view { padding-inline: 0; }
}
`;

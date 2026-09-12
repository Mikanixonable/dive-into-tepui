// ESCメニュー内の設定詳細面(.pm-settings-view)の CSS。
import { MQ_MEDIUM_DOWN } from '../breakpoints';

export const SETTINGS_VIEW_STYLE = `
#hud-pause-menu .pm-settings-view {
  --sv-content-inset: var(--space-4);
  display: block; min-width: 0; pointer-events: auto; padding: var(--space-1) 0 var(--space-2);
}
#hud-pause-menu .pm-settings-view .sv-header,
#hud-pause-menu .pm-settings-view .sv-description,
#hud-pause-menu .pm-settings-view .sv-section { width: 100%; margin-inline: auto; }
#hud-pause-menu .pm-settings-view .sv-header {
  display: flex; align-items: flex-start; padding: 0 var(--sv-content-inset) var(--space-2);
}
#hud-pause-menu .pm-settings-view .sv-heading-group { display: flex; flex-direction: column; gap: var(--space-2); }
#hud-pause-menu .pm-settings-view .sv-header h2 { color: var(--title); font-size: var(--font-2xl); letter-spacing: 0.1em; }
#hud-pause-menu .pm-settings-view .sv-eyebrow { color: var(--color-primary); font-size: var(--font-xxs); letter-spacing: 0.12em; }
#hud-pause-menu .pm-settings-view .sv-description {
  margin-top: var(--space-3); padding-inline: var(--sv-content-inset);
  color: var(--text-dim); font-size: var(--font-s); line-height: 1.6;
}
#hud-pause-menu .pm-settings-view .sv-section {
  margin-top: var(--space-4); padding: var(--sv-content-inset);
  border: 0; border-radius: var(--radius-panel);
}
#hud-pause-menu .pm-settings-view .sv-section-body { min-width: 0; margin-top: var(--space-4); }
#hud-pause-menu .pm-settings-view .sv-tab-panel[hidden] { display: none; }
#hud-pause-menu .pm-settings-view .sv-section h3 {
  display: flex; align-items: center; gap: var(--space-3); margin: 0;
  color: var(--title); font-size: var(--font-m); letter-spacing: 0.08em;
}
#hud-pause-menu .pm-settings-view .sv-section h3::before {
  width: var(--space-2); height: var(--font-m); border-radius: var(--radius-micro); background: var(--color-primary); content: '';
}
#hud-pause-menu .pm-settings-view .sv-theme-options {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(min(190px, 100%), 1fr)); gap: var(--space-3);
}
#hud-pause-menu .pm-settings-view .sv-theme-button {
  display: flex; align-items: center; gap: var(--space-2); min-height: var(--hit-target-min); width: 100%;
  padding: var(--space-2) var(--space-3); border: 0;
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
  background: var(--color-primary-fill);
  color: var(--sv-theme-title);
}
#hud-pause-menu .pm-settings-view .sv-theme-button.on::after {
  flex: 0 0 auto; margin-left: auto; color: var(--color-primary); content: '選択中';
  font-size: var(--font-xxs); white-space: nowrap;
}
#hud-pause-menu .pm-settings-view .sv-theme-button .w-btn-icon {
  display: inline-flex; align-items: center; gap: var(--space-2); width: auto; height: auto; margin-right: 0;
}
#hud-pause-menu .pm-settings-view .sv-theme-icon { display: inline-flex; align-items: center; }
#hud-pause-menu .pm-settings-view .sv-theme-button > span:last-of-type {
  min-width: 0; overflow-wrap: anywhere;
}
#hud-pause-menu .pm-settings-view .sv-theme-preview {
  display: inline-flex; align-items: center; gap: var(--space-2); width: auto; height: var(--font-2xl); padding: var(--space-1);
  border: 0; border-radius: var(--radius-micro); box-sizing: border-box;
}
#hud-pause-menu .pm-settings-view .sv-theme-swatch {
  display: block; width: var(--font-m); height: var(--font-m); border-radius: 50%;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--sv-theme-title) 28%, transparent);
}
#hud-pause-menu .pm-settings-view .sv-preview-button,
#hud-pause-menu .pm-settings-view .sv-track-actions .w-btn {
  border: 0; border-radius: var(--radius-control);
  background: var(--glass-control); box-shadow: none;
}
#hud-pause-menu .pm-settings-view .sv-preview-button:hover,
#hud-pause-menu .pm-settings-view .sv-track-actions .w-btn:hover {
  background: var(--glass-control-hover); color: var(--color-primary-hover);
}
#hud-pause-menu .pm-settings-view .sv-volume-row {
  display: flex; align-items: center; gap: var(--space-4); margin-top: var(--space-2);
  padding: var(--space-2); background: var(--glass-inset); border: 0; border-radius: var(--radius-control);
}
#hud-pause-menu .pm-settings-view .sv-label { flex: 0 0 4em; width: auto; color: var(--text-dim); }
#hud-pause-menu .pm-settings-view .sv-volume-row .w-slider { flex: 1 1 auto; min-width: 0; }
#hud-pause-menu .pm-settings-view .sv-volume-row .w-slider:disabled { cursor: not-allowed; opacity: 0.35; }
#hud-pause-menu .pm-settings-view .sv-volume-value {
  flex: 0 0 4em; width: auto; color: var(--text); text-align: right; font-variant-numeric: tabular-nums;
}
#hud-pause-menu .pm-settings-view .sv-track-list { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-2); }
#hud-pause-menu .pm-settings-view .sv-track-row {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);
  min-height: var(--hit-target-min); padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
  background: var(--glass-inset); border: 0; border-radius: var(--radius-control);
}
#hud-pause-menu .pm-settings-view .sv-track-row:has(.w-btn.on) {
  background: var(--color-primary-fill-weak);
}
#hud-pause-menu .pm-settings-view .sv-track-label {
  display: flex; flex: 1 1 auto; align-items: baseline; gap: var(--space-4); min-width: 0; color: var(--text);
}
#hud-pause-menu .pm-settings-view .sv-track-label > :last-child { min-width: 0; overflow-wrap: anywhere; }
#hud-pause-menu .pm-settings-view .sv-track-number { color: var(--text-dim); font-size: var(--font-xxs); font-variant-numeric: tabular-nums; }
#hud-pause-menu .pm-settings-view .sv-preview-button { flex: 0 0 auto; min-width: 76px; text-align: center; }
#hud-pause-menu .pm-settings-view .sv-track-actions { margin-top: var(--space-2); text-align: right; }
@media ${MQ_MEDIUM_DOWN} {
  #hud-pause-menu .pm-settings-view { padding-inline: 0; }
}
`;

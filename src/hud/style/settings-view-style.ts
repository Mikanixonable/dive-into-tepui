// 設定画面(#hud-settings-view、ドック版を含む)の CSS。
import { MQ_MEDIUM_DOWN } from '../breakpoints';

export const SETTINGS_VIEW_STYLE = `
#hud-settings-view {
  inset: 0; display: none; overflow-y: auto; pointer-events: auto;
  padding: clamp(24px, 7vh, 72px) max(var(--space-6), 6vw); padding: clamp(24px, 7dvh, 72px) max(var(--space-6), 6vw);
  border-radius: 0; background: var(--scrim); box-shadow: none;
}
#hud-settings-view.settings-dock {
  inset: auto; width: 100%; max-height: min(70dvh, 720px); padding: var(--space-4);
  overflow-y: auto; background: var(--surface-0); border: 1px solid var(--edge);
  border-radius: var(--radius-panel); box-shadow: none; backdrop-filter: none;
}
#hud-settings-view.settings-dock .sv-header { padding-bottom: var(--space-3); }
#hud-settings-view.settings-dock .sv-header h2 { font-size: var(--font-l); }
#hud-settings-view.settings-dock .sv-brand,
#hud-settings-view.settings-dock .sv-eyebrow,
#hud-settings-view.settings-dock .sv-description { display: none; }
#hud-settings-view.settings-dock .sv-tabs { margin-top: var(--space-4); }
#hud-settings-view.settings-dock .sv-tabs .w-btn { min-height: var(--hit-target-min); padding: var(--space-4) var(--space-2) var(--space-3); font-size: var(--font-xs); }
#hud-settings-view.settings-dock .sv-section { margin-top: var(--space-4); padding: var(--space-4); }
#hud-settings-view.settings-dock .sv-theme-options { grid-template-columns: 1fr; }
#hud-settings-view.settings-dock .sv-theme-button { min-height: var(--hit-target-min); padding-inline: var(--space-3); }
#hud-settings-view .sv-brand,
#hud-settings-view .sv-header,
#hud-settings-view .sv-description,
#hud-settings-view .sv-section { width: min(100%, 760px); margin-inline: auto; }
#hud-settings-view .sv-brand {
  display: flex; flex-direction: column; align-items: center; gap: var(--space-2);
  padding-bottom: var(--space-4);
}
#hud-settings-view .sv-brand-logo { width: 2.5rem; height: 2.5rem; border-radius: var(--radius-control); }
#hud-settings-view .sv-brand-text { display: flex; flex-direction: column; align-items: center; gap: var(--space-1); }
#hud-settings-view .sv-brand-title { color: var(--title); font-size: var(--font-m); letter-spacing: 0.08em; }
#hud-settings-view .sv-brand-version { color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: 0.06em; }
#hud-settings-view .sv-header {
  display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);
  border-bottom: 1px solid var(--edge); padding-bottom: var(--space-5);
}
#hud-settings-view .sv-heading-group { display: flex; flex-direction: column; gap: var(--space-2); }
#hud-settings-view .sv-header h2 { color: var(--title); font-size: var(--font-2xl); letter-spacing: 0.1em; }
#hud-settings-view .sv-header .w-close {
  flex: 0 0 auto; width: var(--hit-target-min); height: var(--hit-target-min); border-radius: var(--radius-control);
  border-color: var(--edge); background: var(--surface-1);
}
#hud-settings-view .sv-header .w-close:hover { border-color: var(--color-primary); background: var(--surface-2); }
#hud-settings-view .sv-eyebrow { color: var(--color-primary); font-size: var(--font-xxs); letter-spacing: 0.12em; }
#hud-settings-view .sv-description {
  margin-top: var(--space-5); padding-left: var(--space-4); border-left: 2px solid var(--color-primary);
  color: var(--text-dim); font-size: var(--font-s); line-height: 1.6;
}
#hud-settings-view .sv-tabs {
  width: min(100%, 760px); margin: var(--space-6) auto 0; padding: 0;
  gap: var(--space-4); border: 0; border-bottom: 1px solid var(--edge); border-radius: 0;
  background: transparent;
}
#hud-settings-view .sv-tabs .w-btn {
  position: relative; display: flex; flex: 1 1 0; min-width: 0; min-height: 62px;
  align-items: center; justify-content: center; padding: var(--space-4) var(--space-3) var(--space-3);
  border: 0; border-radius: 0; text-align: center;
  font-size: var(--font-m); font-weight: 600; letter-spacing: 0.06em;
  background: transparent; color: var(--text-dim); box-shadow: none;
}
#hud-settings-view .sv-tabs .w-btn::before {
  display: none;
}
#hud-settings-view .sv-tabs .w-btn::after {
  position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; border-radius: 0;
  background: var(--color-primary); content: '';
  opacity: 0; transform: scaleX(0.35); transition: opacity var(--transition-fast), transform var(--transition-fast);
}
#hud-settings-view .sv-tabs .w-btn:hover {
  background: transparent; color: var(--color-primary-hover); transform: none;
}
#hud-settings-view .sv-tabs .w-btn.on {
  border: 0; background: transparent; color: var(--color-primary);
}
#hud-settings-view .sv-tabs .w-btn.on::after { opacity: 1; transform: scaleX(1); }
#hud-settings-view .sv-section {
  position: relative; margin-top: var(--space-7); padding: var(--space-6);
  border: 1px solid var(--edge); border-radius: var(--radius-panel); background: var(--surface-0);
}
#hud-settings-view .sv-tab-panel[hidden] { display: none; }
#hud-settings-view .sv-section h3 {
  display: flex; align-items: center; gap: var(--space-3); margin: 0;
  color: var(--title); font-size: var(--font-m); letter-spacing: 0.08em;
}
#hud-settings-view .sv-section h3::before {
  width: var(--space-2); height: var(--font-m); border-radius: var(--radius-micro); background: var(--color-primary); content: '';
}
#hud-settings-view .sv-theme-options {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--space-3);
  margin-top: var(--space-4);
}
#hud-settings-view .sv-theme-button {
  display: flex; align-items: center; gap: var(--space-2); min-height: 48px; width: 100%;
  padding-inline: var(--space-2); border: 0; border-radius: 0; text-align: left;
  background: transparent; box-shadow: none;
}
#hud-settings-view .sv-theme-button:not(.on) {
  background: color-mix(in srgb, var(--sv-theme-title) 8%, var(--sv-theme-page));
  color: var(--sv-theme-title);
}
#hud-settings-view .sv-theme-button:not(.on):hover {
  background: color-mix(in srgb, var(--sv-theme-title) 16%, var(--sv-theme-page));
  color: var(--sv-theme-title);
}
#hud-settings-view .sv-theme-button.on {
  background: color-mix(in srgb, var(--color-primary) 18%, var(--sv-theme-page));
  color: var(--sv-theme-title);
}
#hud-settings-view .sv-theme-button.on::after {
  margin-left: auto; color: var(--color-primary); content: '選択中'; font-size: var(--font-xxs); white-space: nowrap;
}
#hud-settings-view .sv-theme-button .w-btn-icon {
  display: inline-flex; align-items: center; gap: 3px; width: auto; height: auto; margin-right: var(--space-2);
}
#hud-settings-view .sv-theme-icon { display: inline-flex; align-items: center; }
#hud-settings-view .sv-theme-preview {
  display: inline-flex; align-items: center; gap: 4px; width: auto; height: 25px; padding: 3px;
  border: 0; border-radius: 0; box-sizing: border-box;
}
#hud-settings-view .sv-theme-swatch {
  display: block; width: 14px; height: 14px; border-radius: 50%;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--sv-theme-title) 28%, transparent);
}
#hud-settings-view .sv-header .w-close,
#hud-settings-view .sv-preview-button,
#hud-settings-view .sv-track-actions .w-btn {
  border: 0; border-radius: 0; background: transparent; box-shadow: none;
}
#hud-settings-view .sv-header .w-close:hover,
#hud-settings-view .sv-preview-button:hover,
#hud-settings-view .sv-track-actions .w-btn:hover {
  border: 0; background: transparent; color: var(--color-primary-hover);
}
#hud-settings-view .gp-body { display: flex; flex-direction: column; gap: var(--space-4); margin-top: var(--space-4); }
#hud-settings-view .gp-group {
  display: flex; flex-direction: column; gap: var(--space-4);
  padding-top: var(--space-4); border-top: 1px solid var(--edge);
}
#hud-settings-view .gp-group-title {
  margin: 0; color: var(--color-primary); font-size: var(--font-xxs); letter-spacing: 0.12em;
}
#hud-settings-view .sv-volume-row {
  display: flex; align-items: center; gap: var(--space-4); margin-top: var(--space-4);
  padding: var(--space-4); background: var(--surface-1); border: 1px solid var(--edge); border-radius: var(--radius-control);
}
#hud-settings-view .sv-label { width: 4em; color: var(--text-dim); }
#hud-settings-view .sv-volume-row .w-slider { flex: 1; }
#hud-settings-view .sv-volume-value { width: 4em; color: var(--text); text-align: right; font-variant-numeric: tabular-nums; }
#hud-settings-view .sv-track-list { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-4); }
#hud-settings-view .sv-track-row {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);
  min-height: var(--hit-target-min); padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
  background: var(--surface-1); border: 0; border-radius: 0;
}
#hud-settings-view .sv-track-row:has(.w-btn.on) { background: var(--surface-2); }
#hud-settings-view .sv-track-label { display: flex; align-items: baseline; gap: var(--space-4); color: var(--text); }
#hud-settings-view .sv-track-number { color: var(--text-dim); font-size: var(--font-xxs); font-variant-numeric: tabular-nums; }
#hud-settings-view .sv-preview-button { min-width: 76px; text-align: center; }
#hud-settings-view .sv-track-actions { margin-top: var(--space-4); text-align: right; }
@media ${MQ_MEDIUM_DOWN} {
  #hud-settings-view { padding-inline: var(--space-5); }
}
`;

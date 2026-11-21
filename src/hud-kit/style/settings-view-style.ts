// ESCメニュー内の設定詳細面(.pm-settings-view)の CSS。
import { MQ_COMPACT } from '../breakpoints';

export const SETTINGS_VIEW_STYLE = `
/* 左に内側タブの縦並び、右に選んだ面の本文。 */
#hud-pause-menu .pm-settings-view {
  --sv-tabs-width: 9.5em;
  /* 描画の各項目のラベル領域の幅。同じ面の操作領域をこの右へ揃える。 */
  --sv-label-width: 11em;
  display: grid; grid-template-columns: var(--sv-tabs-width) minmax(0, 1fr);
  align-items: start; gap: var(--space-6); min-width: 0; pointer-events: auto;
}
#hud-pause-menu .pm-settings-view .sv-tabs {
  position: sticky; top: 0; display: flex; flex-direction: column; gap: var(--space-1);
}
#hud-pause-menu .pm-settings-view .sv-tabs .w-btn {
  display: flex; justify-content: flex-start; min-height: var(--hit-target-min);
  padding: var(--space-3) var(--space-4); border: 0; border-radius: var(--radius-control); text-align: left;
  font-size: var(--font-m); font-weight: 600;
  background: transparent; color: var(--text-dim); box-shadow: none;
}
#hud-pause-menu .pm-settings-view .sv-tabs .w-btn:hover { background: var(--glass-control); color: var(--color-primary-hover); transform: none; }
#hud-pause-menu .pm-settings-view .sv-tabs .w-btn.on { background: var(--color-primary-fill); color: var(--color-primary); }
#hud-pause-menu .pm-settings-view .sv-panes { min-width: 0; }
#hud-pause-menu .pm-settings-view .sv-tab-panel[hidden] { display: none; }

/* 描画: プリセットの行と、群ごとの見出し+項目の行の束。各行はラベル領域と操作領域に分ける。 */
#hud-pause-menu .pm-settings-view .gp-body {
  display: flex; flex-direction: column; gap: var(--space-5);
}
#hud-pause-menu .pm-settings-view .gp-group { display: flex; flex-direction: column; gap: 0; }
#hud-pause-menu .pm-settings-view .gp-group-title {
  padding: 0 var(--space-2) var(--space-3);
  color: var(--text); font-size: var(--font-s); font-weight: 600; letter-spacing: 0;
}
#hud-pause-menu .pm-settings-view .gp-body > .w-group,
#hud-pause-menu .pm-settings-view .gp-group > .w-group,
#hud-pause-menu .pm-settings-view .gp-group > .w-toggle {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-start; gap: var(--space-3);
  min-height: var(--hit-target-min); padding: var(--space-3) var(--space-5);
  background: var(--glass-inset);
}
#hud-pause-menu .pm-settings-view .gp-body > .w-group { border-radius: var(--radius-panel); }
#hud-pause-menu .pm-settings-view .gp-group > .gp-group-title + * { border-radius: var(--radius-panel) var(--radius-panel) 0 0; }
#hud-pause-menu .pm-settings-view .gp-group > :last-child { border-bottom-left-radius: var(--radius-panel); border-bottom-right-radius: var(--radius-panel); }
#hud-pause-menu .pm-settings-view .gp-group > * + :not(.gp-group-title):not(.gp-group-title + *) {
  box-shadow: inset 0 1px 0 var(--fill-1);
}
#hud-pause-menu .pm-settings-view .w-group-title,
#hud-pause-menu .pm-settings-view .w-toggle-title {
  flex: 0 0 var(--sv-label-width); min-width: 0;
  color: var(--text-muted); font-size: var(--font-s); letter-spacing: 0;
}
#hud-pause-menu .pm-settings-view .gp-group > .w-group .w-select { min-width: 0; max-width: 100%; }

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
@media ${MQ_COMPACT} {
  /* 内側タブを本文の上に横に並べ、ラベルは1行目を独占して操作部品を下の行へ回す。 */
  #hud-pause-menu .pm-settings-view { grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
  #hud-pause-menu .pm-settings-view .sv-tabs { position: static; flex-direction: row; }
  #hud-pause-menu .pm-settings-view .sv-tabs .w-btn { flex: 1 1 0; justify-content: center; min-width: 0; }
  #hud-pause-menu .pm-settings-view .w-group-title,
  #hud-pause-menu .pm-settings-view .gp-group > .w-group .w-group-title { flex: 0 0 100%; }
}
`;

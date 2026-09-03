// ヘルプ画面(#hud-help)の CSS。
import { MQ_COARSE, MQ_COMPACT, MQ_MEDIUM_DOWN } from '../../../hud/breakpoints';

export const HELP_PANEL_STYLE = `
#hud-help {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  display: none; width: min(920px, calc(100vw - 24px)); min-width: 0;
  max-height: min(90vh, 900px); max-height: min(90dvh, 900px); overflow: hidden; pointer-events: auto;
}
#hud-help .help-header {
  display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-5);
  padding-bottom: var(--space-4); border-bottom: 1px solid var(--edge);
}
#hud-help .help-header h3 { margin: 0; }
#hud-help .help-close-hint { color: var(--text-dim); font-size: var(--font-xxs); font-weight: 400; letter-spacing: 0; }
#hud-help .help-close-button {
  flex: 0 0 auto; width: 28px; height: 28px; padding: 0; border: 1px solid var(--edge);
  border-radius: var(--radius-control); background: var(--surface-2); color: var(--text-dim);
  font: inherit; font-size: var(--font-l); line-height: 1; cursor: pointer;
}
@media ${MQ_COARSE} {
  #hud-help .help-close-button { min-width: var(--hit-target-min); min-height: var(--hit-target-min); }
}
#hud-help .help-close-button:hover, #hud-help .help-close-button:focus-visible { color: var(--color-primary-hover); border-color: var(--color-primary); }
#hud-help .help-mode-status { margin-top: var(--space-2); color: var(--color-primary-hover); font-size: var(--font-xxs); letter-spacing: .04em; }
#hud-help .help-toolbar { display: grid; gap: var(--space-3); padding: var(--space-4) 0; }
#hud-help .help-toolbar-row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
#hud-help .help-toolbar-label { color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: .06em; }
#hud-help .help-tab {
  min-height: var(--row-min-h-s); padding: var(--space-2) var(--space-3); border: 1px solid var(--edge); border-radius: var(--radius-control);
  background: var(--surface-2); color: var(--text-dim); font: inherit; font-size: var(--font-xxs); cursor: pointer;
}
#hud-help .help-tab:hover, #hud-help .help-tab:focus-visible { color: var(--text); border-color: var(--color-primary-edge); }
#hud-help .help-tab.on { background: var(--color-primary-fill); border-color: var(--color-primary-edge); color: var(--color-primary-hover); }
#hud-help .help-search {
  display: flex; align-items: center; gap: var(--space-2); flex: 1 1 220px; min-width: 180px;
  color: var(--text-dim);
}
#hud-help .help-search .w-input { flex: 1 1 auto; width: 100%; }
#hud-help .help-category-tabs { display: flex; gap: var(--space-2); flex-wrap: wrap; }
#hud-help .help-body { overflow-y: auto; max-height: calc(min(90vh, 900px) - 190px); max-height: calc(min(90dvh, 900px) - 190px); padding-right: var(--space-2); }
#hud-help .help-section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-4); margin: var(--space-2) 0 var(--space-3); }
#hud-help .help-section-heading h4 { margin: 0; color: var(--text); font-size: var(--font-s); letter-spacing: .06em; }
#hud-help .help-section-heading > span { color: var(--text-dim); font-size: var(--font-xxs); }
#hud-help .help-quickstart { padding: var(--space-4); border: 1px solid var(--color-primary-edge-soft); background: var(--color-primary-fill-weak); }
#hud-help .help-quickstart-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-2); }
#hud-help .help-recipe {
  display: flex; align-items: center; gap: var(--space-3); min-height: 40px; padding: var(--space-2) var(--space-3);
  border-left: 2px solid var(--color-primary); background: var(--surface-1); color: var(--text); font-size: var(--font-xxs);
}
#hud-help .help-recipe-number { color: var(--color-primary-hover); font-variant-numeric: tabular-nums; }
#hud-help kbd, #hud-help .help-entry-key {
  display: inline-flex; align-items: center; justify-content: center; min-width: 2.1em; min-height: 1.7em;
  padding: 0 var(--space-2); border: 1px solid var(--color-primary-edge); border-radius: var(--radius-micro);
  background: var(--surface-2); color: var(--color-primary-hover); font: inherit; font-size: var(--font-xxs); font-weight: 700;
}
#hud-help .help-keyboard-section { margin-top: var(--space-5); }
#hud-help .help-legend { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); margin-bottom: var(--space-3); }
#hud-help .help-legend-item { display: inline-flex; align-items: center; gap: var(--space-2); color: var(--text-dim); font-size: var(--font-xxs); }
#hud-help .help-legend-item i, #hud-help .help-group summary i { font-style: normal; margin-right: var(--space-2); }
#hud-help .help-legend-item.cat-basic i, #hud-help .help-group.cat-basic summary i { color: var(--color-info); }
#hud-help .help-legend-item.cat-combat i, #hud-help .help-group.cat-combat summary i { color: var(--color-error); }
#hud-help .help-legend-item.cat-camera i, #hud-help .help-group.cat-camera summary i { color: var(--color-success); }
#hud-help .help-legend-item.cat-time i, #hud-help .help-group.cat-time summary i { color: var(--color-warning); }
#hud-help .help-legend-item.cat-map i, #hud-help .help-group.cat-map summary i { color: var(--color-primary-hover); }
#hud-help .help-legend-item.cat-ui i, #hud-help .help-group.cat-ui summary i { color: var(--text); }
#hud-help .help-legend-item.cat-gesture i, #hud-help .help-group.cat-gesture summary i { color: var(--color-signal); }
#hud-help .help-keyboard { display: grid; gap: 3px; padding: var(--space-3); border: 1px solid var(--edge); background: var(--surface-0); }
#hud-help .help-keyboard-row { display: flex; gap: 3px; }
#hud-help .help-key {
  flex: 1 1 0; min-width: 0; height: 30px; padding: 0 2px; overflow: hidden; border: 1px solid var(--edge);
  border-radius: var(--radius-micro); background: var(--surface-1); color: var(--text-faint); font: inherit; font-size: var(--font-xxs);
  cursor: pointer; transition: border-color var(--transition-fast), background var(--transition-fast), color var(--transition-fast), transform var(--transition-fast);
}
#hud-help .help-key.wide { flex-grow: 1.55; }
#hud-help .help-key.xwide { flex-grow: 2.1; }
#hud-help .help-key.space { flex-grow: 5.2; }
#hud-help .help-key.mapped { color: var(--text); border-color: var(--category-edge, var(--color-primary-edge)); }
#hud-help .help-key.cat-basic { --category-edge: var(--color-info); --category-fill: var(--color-info-fill); }
#hud-help .help-key.cat-combat { --category-edge: var(--color-error); --category-fill: var(--color-error-fill); }
#hud-help .help-key.cat-camera { --category-edge: var(--color-success); --category-fill: var(--color-success-fill); }
#hud-help .help-key.cat-time { --category-edge: var(--color-warning); --category-fill: var(--color-warning-fill); }
#hud-help .help-key.cat-map { --category-edge: var(--color-primary); --category-fill: var(--color-primary-fill); }
#hud-help .help-key.cat-ui { --category-edge: var(--text); --category-fill: var(--surface-3); }
#hud-help .help-key:hover, #hud-help .help-key:focus-visible, #hud-help .help-key.is-selected {
  color: var(--text-strong); border-color: var(--category-edge, var(--color-primary)); background: var(--category-fill, var(--color-primary-fill));
}
#hud-help .help-key.is-selected, #hud-help .help-entry.is-selected { box-shadow: 0 0 0 2px var(--color-focus); }
#hud-help .help-key.search-muted { opacity: .2; }
#hud-help .help-keyboard-aux { display: flex; align-items: center; gap: 3px; margin-top: var(--space-2); }
#hud-help .help-keyboard-aux .help-key { flex: 0 1 58px; }
#hud-help .help-keyboard-aux-label { margin-right: var(--space-2); color: var(--text-dim); font-size: var(--font-xxs); }
#hud-help .help-content { display: grid; gap: var(--space-2); margin-top: var(--space-5); }
#hud-help .help-group { border: 1px solid var(--edge); background: var(--surface-1); }
#hud-help .help-group summary {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) var(--space-4);
  color: var(--text); font-size: var(--font-xs); letter-spacing: .05em; cursor: pointer; list-style: none;
}
#hud-help .help-group summary::-webkit-details-marker { display: none; }
#hud-help .help-group summary::after { content: '+'; color: var(--text-dim); font-size: var(--font-m); }
#hud-help .help-group[open] summary::after { content: '−'; }
#hud-help .help-group summary em { color: var(--text-dim); font-size: var(--font-xxs); font-style: normal; }
#hud-help .help-group-body { border-top: 1px solid var(--edge); }
#hud-help .help-entry { display: grid; grid-template-columns: minmax(120px, 25%) minmax(0, 1fr); gap: var(--space-4); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--line-subtle); }
#hud-help .help-entry:last-child { border-bottom: 0; }
#hud-help .help-entry:hover, #hud-help .help-entry.is-selected { background: var(--surface-2); }
#hud-help .help-entry-keyset { display: flex; flex-wrap: wrap; align-content: flex-start; justify-content: flex-end; gap: var(--space-1); }
#hud-help .help-entry-key { cursor: pointer; }
#hud-help .help-entry-key:hover, #hud-help .help-entry-key:focus-visible, #hud-help .help-entry-key.is-selected { border-color: var(--color-focus); background: var(--color-primary-fill-strong); }
#hud-help .help-entry-key.muted { color: var(--text-dim); border-style: dashed; }
#hud-help .help-key-separator { align-self: center; color: var(--text-dim); }
#hud-help .help-gesture { display: inline-flex; align-items: center; min-height: 1.7em; padding: 0 var(--space-2); color: var(--color-signal); font-size: var(--font-xxs); }
#hud-help .help-entry-title { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
#hud-help .help-entry-title strong { color: var(--text); font-size: var(--font-xs); }
#hud-help .help-entry-copy p { margin: var(--space-1) 0 0; color: var(--text-dim); font-size: var(--font-xxs); line-height: 1.55; }
#hud-help .help-entry-tags { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-1); }
#hud-help .help-behavior, #hud-help .help-input-tag { padding: 1px var(--space-2); border: 1px solid var(--edge); color: var(--text-dim); font-size: 9px; letter-spacing: .04em; white-space: nowrap; }
#hud-help .help-behavior { color: var(--color-warning); border-color: var(--color-warning-edge); }
#hud-help .help-input-tag.input-keyboard { color: var(--color-info); border-color: var(--color-info-edge); }
#hud-help .help-input-tag.input-mouse { color: var(--color-success); border-color: var(--color-success-edge); }
#hud-help .help-input-tag.input-touch { color: var(--color-signal); border-color: color-mix(in srgb, var(--color-signal) 45%, transparent); }
#hud-help .help-example { margin-top: var(--space-2); color: var(--color-primary-hover); font-size: var(--font-xxs); }
#hud-help .help-no-results { padding: var(--space-6); color: var(--text-dim); text-align: center; }
#hud-help .help-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media ${MQ_MEDIUM_DOWN} {
  #hud-help { min-width: 0; width: 94vw; max-height: 88vh; max-height: 88dvh; }
  #hud-help .help-body { max-height: calc(min(88vh, 900px) - 190px); max-height: calc(min(88dvh, 900px) - 190px); }
  #hud-help .help-quickstart-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media ${MQ_COMPACT} {
  #hud-help { width: calc(100vw - 16px); }
  #hud-help .help-header { gap: var(--space-2); }
  #hud-help .help-close-hint { display: block; margin-top: var(--space-1); }
  #hud-help .help-toolbar { gap: var(--space-2); }
  #hud-help .help-toolbar-row { gap: var(--space-2); }
  #hud-help .help-search { order: -1; flex-basis: 100%; }
  #hud-help .help-category-tabs { max-height: 62px; overflow-y: auto; }
  #hud-help .help-keyboard { padding: var(--space-2); gap: 2px; }
  #hud-help .help-keyboard-row { gap: 2px; }
  #hud-help .help-key { height: 25px; font-size: 9px; }
  #hud-help .help-entry { grid-template-columns: 1fr; gap: var(--space-2); }
  #hud-help .help-entry-keyset { justify-content: flex-start; }
  #hud-help .help-entry-title { display: block; }
  #hud-help .help-entry-tags { display: flex; justify-content: flex-start; margin-top: var(--space-2); }
}
`;

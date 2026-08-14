// マップビュー固有の視覚階層。骨格配置は skeleton-style.ts、共通コントロールは
// widgets/widget-style.ts が持ち、ここでは Quiet / Focus Glass とマップ内の意味色だけを上書きする。
import { MQ_COMPACT, MQ_MEDIUM_DOWN } from './breakpoints';

export const MAP_VIEW_STYLE = `
/* マップでは戦闘固有の棚とターゲット計器を外し、計画用のレールへ視線を集中させる。 */
#hud.map-mode #hud-combat-shelf-wrap,
#hud.map-mode #hud-target { display: none; }

/* Quiet Glass: 視野を隠さない常設情報。 */
#hud.map-mode #hud-object-list,
#hud.map-mode #hud-view-options {
  border: 0;
  border-radius: var(--radius-panel);
  background: var(--glass-quiet);
  box-shadow: 0 12px 30px var(--shade-1);
  backdrop-filter: blur(14px) saturate(82%);
  -webkit-backdrop-filter: blur(14px) saturate(82%);
}

/* Focus Glass: 時間スクラブと座標系編集は、意思決定中だけ一段密度を上げる。 */
#hud.map-mode #hud-predict,
#hud.map-mode .hud-frame-controls,
#hud.map-mode #hud-plan {
  border: 0;
  border-radius: var(--radius-panel);
  background: var(--glass-focus);
  box-shadow: 0 16px 38px var(--shade-1);
  backdrop-filter: blur(22px) saturate(82%);
  -webkit-backdrop-filter: blur(22px) saturate(82%);
}

#hud.map-mode #hud-object-list h3,
#hud.map-mode #hud-view-options h3,
#hud.map-mode #hud-predict h3,
#hud.map-mode .hud-frame-controls h3,
#hud.map-mode #hud-plan h3 {
  color: var(--title);
  border: 0;
  padding-bottom: 0;
  margin-bottom: var(--space-3);
  font-size: var(--font-s);
  font-weight: 600;
  letter-spacing: 0;
}

#hud.map-mode .rail-toggle,
#hud.map-mode #hud-predict-toggle {
  border: 0;
  border-radius: var(--radius-control);
  background: var(--glass-quiet);
  color: var(--muted);
  backdrop-filter: blur(14px) saturate(82%);
  -webkit-backdrop-filter: blur(14px) saturate(82%);
}
#hud.map-mode .rail-toggle:hover,
#hud.map-mode #hud-predict-toggle:hover { color: var(--accent-near); background: var(--surface-2); }
#hud.map-mode .rail-toggle:focus-visible,
#hud.map-mode #hud-predict-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Object list: 現在の選択だけを Accent、カメラの関連軌道を Near accent で分ける。 */
#hud.map-mode #hud-object-list { max-height: min(576px, 64dvh); }
#hud.map-mode #hud-object-list .object-list-head {
  background: color-mix(in srgb, var(--surface-1) 86%, transparent);
  border-radius: var(--radius-panel) var(--radius-panel) 0 0;
  backdrop-filter: blur(18px) saturate(82%);
  -webkit-backdrop-filter: blur(18px) saturate(82%);
}
#hud.map-mode #hud-object-list .object-list-search { padding: 0 0 var(--space-2); }
#hud.map-mode #hud-object-list .object-list-search .w-input {
  min-height: 30px;
  border: 0;
  border-radius: var(--radius-control);
  background: var(--surface-2);
  color: var(--title);
}
#hud.map-mode #hud-object-list .object-list-head .w-group {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  gap: var(--space-2);
  padding: var(--space-1) 0;
}
#hud.map-mode #hud-object-list .object-list-head .w-group-title {
  min-width: 0;
  color: var(--muted);
  letter-spacing: 0;
}
#hud.map-mode #hud-object-list .object-list-head .w-btn {
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
}
#hud.map-mode #hud-object-list .object-list-head .w-btn:hover { color: var(--accent-near); background: var(--surface-2); }
#hud.map-mode #hud-object-list .object-list-head .w-btn.on { color: var(--accent); background: var(--surface-2); }
#hud.map-mode #hud-object-list .object-list-breadcrumb {
  margin: var(--space-2) 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-radius: var(--radius-control);
  background: color-mix(in srgb, var(--surface-2) 68%, transparent);
  color: var(--muted);
}
#hud.map-mode #hud-object-list .object-list-section-header {
  border: 0;
  border-radius: var(--radius-control);
  color: var(--body);
  background: transparent;
  letter-spacing: 0;
  cursor: pointer;
}
#hud.map-mode #hud-object-list .object-list-section-header:hover { color: var(--accent-near); background: var(--surface-2); }
#hud.map-mode #hud-object-list .object-list-section-header:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
#hud.map-mode #hud-object-list .erow {
  min-height: 28px;
  border-radius: var(--radius-control);
  color: var(--muted);
  transition: color var(--transition-fast), background var(--transition-fast);
}
#hud.map-mode #hud-object-list .erow:hover { color: var(--title); background: var(--surface-2); }
#hud.map-mode #hud-object-list .erow.related-orbit { color: var(--accent-near); }
#hud.map-mode #hud-object-list .erow.on {
  outline: 0;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
#hud.map-mode #hud-object-list .erow:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
#hud.map-mode #hud-object-list .object-list-glyph {
  flex: 0 0 16px;
  color: currentColor;
  text-align: center;
  font-size: var(--font-xs);
}
#hud.map-mode #hud-object-list .object-list-detail { color: var(--muted); }

/* View: 種別、表示要素、参照面を先に読ませ、選択色は小さな点灯へ絞る。 */
#hud.map-mode #hud-view-options .view-options-section-heading {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  align-items: end;
  gap: var(--space-3);
  margin: var(--space-5) 0 var(--space-2);
}
#hud.map-mode #hud-view-options .view-options-section-heading:first-child { margin-top: 0; }
#hud.map-mode #hud-view-options .view-options-section-title {
  color: var(--body);
  font-size: var(--font-xs);
  font-weight: 600;
}
#hud.map-mode #hud-view-options .view-options-column-legend {
  display: grid;
  grid-template-columns: repeat(3, minmax(30px, 1fr));
  gap: var(--space-1);
}
#hud.map-mode #hud-view-options .view-options-column {
  color: var(--muted);
  font-size: var(--font-xxs);
  text-align: center;
  white-space: nowrap;
}
#hud.map-mode #hud-view-options .body-class-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: var(--space-3);
  margin-bottom: var(--space-1);
}
#hud.map-mode #hud-view-options .body-class-row .body-class-title {
  position: relative;
  width: auto;
  min-width: 0;
  border: 0;
  border-radius: var(--radius-control);
  padding-left: var(--space-5);
  color: var(--body);
  background: transparent;
  letter-spacing: 0;
}
#hud.map-mode #hud-view-options .body-class-row .body-class-title::before {
  content: '';
  position: absolute;
  left: var(--space-2);
  top: 50%;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--muted);
  transform: translateY(-50%);
}
#hud.map-mode #hud-view-options .body-class-row .body-class-btns {
  display: grid;
  grid-template-columns: repeat(3, minmax(30px, 1fr));
  gap: var(--space-1);
}
#hud.map-mode #hud-view-options span.body-class-icon-btn {
  position: relative;
  min-width: 0;
  border: 0;
  border-radius: var(--radius-control);
  padding: var(--space-2);
  color: var(--muted);
  background: transparent;
}
#hud.map-mode #hud-view-options .body-class-row .w-btn:hover { color: var(--accent-near); background: var(--surface-2); }
#hud.map-mode #hud-view-options .body-class-row .body-class-icon-btn.on {
  color: var(--title);
  background: var(--surface-2);
}
#hud.map-mode #hud-view-options .body-class-row .body-class-title.on {
  color: var(--title);
  background: transparent;
}
#hud.map-mode #hud-view-options .body-class-row .body-class-title.on::before { background: var(--accent); }
#hud.map-mode #hud-view-options .body-class-row .body-class-icon-btn.on::after {
  content: '';
  position: absolute;
  top: 4px;
  right: 4px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--accent);
}
#hud.map-mode #hud-view-options .body-class-row.category-off { opacity: .52; }
#hud.map-mode #hud-view-options .body-class-row.category-off .body-class-icon-btn.on::after { display: none; }

/* Predict: 未来は Accent、隣接する過去範囲は Near accent。Secondary は同期状態用に残す。 */
#hud.map-mode #hud-predict .w-btn,
#hud.map-mode #hud-predict .predict-edit-btn,
#hud.map-mode #hud-predict .w-input {
  border: 0;
  border-radius: var(--radius-control);
  background: var(--surface-2);
}
#hud.map-mode #hud-predict .w-btn:hover,
#hud.map-mode #hud-predict .predict-edit-btn:hover { color: var(--accent-near); background: var(--surface-3); }
#hud.map-mode #hud-predict .w-btn.on { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface-2)); }
#hud.map-mode #hud-predict .predict-past .w-btn.on {
  color: var(--accent-near);
  background: color-mix(in srgb, var(--accent-near) 10%, var(--surface-2));
}
#hud.map-mode #hud-predict .w-group-title,
#hud.map-mode #hud-predict .w-toggle-title,
#hud.map-mode #hud-predict .predict-absolute,
#hud.map-mode #hud-predict .slider-ticks span { color: var(--muted); letter-spacing: 0; }
#hud.map-mode #hud-predict .predict-elapsed { color: var(--title); }
#hud.map-mode #hud-predict .predict-elapsed:hover { color: var(--accent-near); }

/* Frame controls: ウィンドウ見出し > 操作 > 読み取り専用サマリーの順に弱くする。 */
#hud.map-mode .hud-frame-controls .frame-summary {
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  color: var(--muted);
  font-size: var(--font-xxs);
  line-height: 1.55;
}
#hud.map-mode .hud-frame-controls .w-btn,
#hud.map-mode .hud-frame-controls .w-toggle-track {
  border: 0;
  border-radius: var(--radius-control);
  background: var(--surface-2);
}
#hud.map-mode .hud-frame-controls .w-btn:hover { color: var(--accent-near); background: var(--surface-3); }
#hud.map-mode .hud-frame-controls .w-btn.on { color: var(--accent); }
#hud.map-mode .hud-frame-controls .w-toggle-track.on { background: var(--accent-secondary); }

/* Map scale は視野端の小さな Quiet Glass に留める。 */
#hud-map-scale {
  border: 0;
  border-radius: var(--radius-control);
  background: var(--glass-quiet);
  color: var(--muted);
  box-shadow: 0 10px 24px var(--shade-1);
  backdrop-filter: blur(14px) saturate(82%);
  -webkit-backdrop-filter: blur(14px) saturate(82%);
}
#hud-map-scale .map-scale-label {
  display: block;
  margin-bottom: var(--space-1);
  color: var(--muted);
  font-size: var(--font-xxs);
}
#hud-map-scale .map-scale-value { color: var(--title); }
#hud-map-scale .map-scale-ruler::before { border-color: var(--muted); }
#hud-map-scale .map-scale-tick { border-color: var(--title); }

@media ${MQ_MEDIUM_DOWN} {
  #hud.map-mode #hud-object-list,
  #hud.map-mode #hud-view-options,
  #hud.map-mode .hud-frame-controls { border-radius: var(--radius-panel); }
  #hud.map-mode #hud-view-options .view-options-section-heading,
  #hud.map-mode #hud-view-options .body-class-row { grid-template-columns: 82px minmax(0, 1fr); }
  #hud.map-mode #hud-view-options .view-options-column { font-size: 8px; }
}

@media ${MQ_COMPACT} {
  /* compact では既存の初期収納を保ち、開いたレールも両側合計100%未満に納める。 */
  #hud.map-mode {
    --rail-w-left: calc(42vw - 8px);
    --rail-w-right: calc(54vw - 8px);
  }
  #hud.map-mode #hud-object-list .object-list-head .w-group {
    grid-template-columns: 42px minmax(0, 1fr);
  }
  #hud.map-mode #hud-object-list .object-list-head .w-group-title,
  #hud.map-mode #hud-object-list .object-list-detail { font-size: 8px; }
  #hud.map-mode #hud-view-options .view-options-section-heading,
  #hud.map-mode #hud-view-options .body-class-row { grid-template-columns: 68px minmax(0, 1fr); }
  #hud.map-mode #hud-view-options .view-options-column { overflow: hidden; text-overflow: ellipsis; }
  #hud.map-mode #hud-predict .predict-row1 { align-items: flex-start; }
}
`;

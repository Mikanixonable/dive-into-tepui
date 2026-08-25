// マップビュー固有の視覚階層。骨格配置は skeleton-style.ts、共通コントロールは
// widgets/widget-style.ts が持ち、ここでは Quiet / Focus Glass とマップ内の意味色だけを上書きする。
import {
  MQ_COARSE, MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT,
} from '../breakpoints';

export const MAP_VIEW_STYLE = `
/* マップでは戦闘固有の棚とターゲット計器を外し、計画用のレールへ視線を集中させる。 */
#hud .hud-map-root.active #hud-target { display: none; }

/* 宇宙空間は常に暗いため、ライトテーマでも天体ラベルは暗色の札と明色文字で読む。 */
#hud .hud-map-root.active .mk-poi .lbl {
  background: var(--space-label-background);
  color: var(--space-label-text);
  text-shadow: none;
}
#hud .hud-map-root.active .mk-poi:not(.mk-lagrange) .lbl .lbl-main { color: var(--space-label-text); }
#hud .hud-map-root.active .mk-poi:not(.mk-lagrange) .lbl .lbl-sub { color: var(--space-label-subtext); }

/* Quiet Glass: 視野を隠さない常設情報。 */
#hud .hud-map-root.active #hud-physical-object-list,
#hud .hud-map-root.active #hud-view-options,
#hud .hud-map-root.active #hud-orbit,
#hud .hud-map-root.active #burn-management-panel {
  border: 0;
  border-radius: var(--radius-panel);
  background: var(--glass-quiet);
  box-shadow: 0 12px 30px var(--shade-1);
  backdrop-filter: blur(14px) saturate(82%);
  -webkit-backdrop-filter: blur(14px) saturate(82%);
}

/* Orbit は表示設定の上に置く。初期状態は PanelShell のビュー別既定値で収納される。 */
#hud .hud-map-root.active .hud-rail-left > #hud-orbit {
  width: 100%;
  max-height: min(360px, 48dvh);
  overflow-y: auto;
}
#hud .hud-map-root.active .hud-rail-left > #burn-management-panel {
  width: 100%;
  max-height: min(260px, 36dvh);
  overflow-y: auto;
}
/* 軌道ガイドタブは項目数に応じて際限なく伸びうるため、他のレールパネル同様に自身の高さへ
   上限をかける——無いと下に続くカメラパネルをレールの下方へ押し出し、隠れて見える。
   タブによって内容量が変わるため、内容が少ないタブでも隣の常設レールパネルより著しく
   縮まないよう最小高さも持つ。 */
#hud .hud-map-root.active .hud-rail-left > #hud-view-options {
  min-height: min(260px, 36dvh);
  max-height: min(420px, 56dvh);
  overflow-y: auto;
}
@media ${MQ_COARSE}, ${MQ_SHORT} {
  #hud .hud-map-root.active .hud-rail-left > #hud-orbit,
  #hud .hud-map-root.active .hud-rail-left > #burn-management-panel,
  #hud .hud-map-root.active .hud-rail-left > #hud-view-options,
  #hud .hud-map-root.active .hud-rail-left > .hud-frame-controls,
  #hud .hud-map-root.active #hud-physical-object-list {
    max-height: var(--rail-panel-max-h);
  }
}

/* Focus Glass: 時間スクラブと座標系編集は、意思決定中だけ一段密度を上げる。 */
#hud .hud-map-root.active #hud-predict,
#hud .hud-map-root.active .hud-frame-controls,
#hud .hud-map-root.active #hud-plan {
  border: 0;
  border-radius: var(--radius-panel);
  background: var(--glass-focus);
  box-shadow: 0 16px 38px var(--shade-1);
  backdrop-filter: blur(22px) saturate(82%);
  -webkit-backdrop-filter: blur(22px) saturate(82%);
}

#hud .hud-map-root.active #hud-physical-object-list h3,
#hud .hud-map-root.active #hud-view-options h3,
#hud .hud-map-root.active #hud-orbit h3,
#hud .hud-map-root.active #burn-management-panel h3,
#hud .hud-map-root.active #hud-predict h3,
#hud .hud-map-root.active .hud-frame-controls h3,
#hud .hud-map-root.active #hud-plan h3 {
  color: var(--title);
  border: 0;
  padding-bottom: 0;
  margin-bottom: var(--space-3);
  font-size: var(--font-s);
  font-weight: 600;
  letter-spacing: 0;
}

#hud .hud-map-root.active .rail-toggle,
#hud .hud-map-root.active #hud-predict-toggle {
  border: 0;
  border-radius: var(--radius-control);
  background: var(--glass-quiet);
  color: var(--muted);
  backdrop-filter: blur(14px) saturate(82%);
  -webkit-backdrop-filter: blur(14px) saturate(82%);
}
#hud .hud-map-root.active .rail-toggle:hover,
#hud .hud-map-root.active #hud-predict-toggle:hover { color: var(--color-primary-hover); background: var(--surface-2); }
#hud .hud-map-root.active .rail-toggle:focus-visible,
#hud .hud-map-root.active #hud-predict-toggle:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

/* Object list: 現在の選択だけを Accent、カメラの関連軌道を Near accent で分ける。 */
#hud .hud-map-root.active #hud-physical-object-list { max-height: min(576px, 64dvh); }
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-head {
  background: color-mix(in srgb, var(--surface-1) 86%, transparent);
  border-radius: var(--radius-panel) var(--radius-panel) 0 0;
  backdrop-filter: blur(18px) saturate(82%);
  -webkit-backdrop-filter: blur(18px) saturate(82%);
}
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-search { padding: 0 0 var(--space-2); }
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-search .w-input {
  min-height: 30px;
  border: 0;
  border-radius: var(--radius-control);
  background: var(--surface-2);
  color: var(--title);
}
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-head .w-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  row-gap: var(--space-1);
  padding: var(--space-1) 0;
}
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-head .w-group-title {
  flex: 1 0 100%;
  min-width: 0;
  color: var(--muted);
  letter-spacing: 0;
}
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-head .w-btn {
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
}
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-head .w-btn:hover { color: var(--color-primary-hover); background: var(--surface-2); }
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-head .w-btn.on { color: var(--color-primary); background: var(--surface-2); }
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-breadcrumb {
  margin: var(--space-2) 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-radius: var(--radius-control);
  background: color-mix(in srgb, var(--surface-2) 68%, transparent);
  color: var(--muted);
}
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-section-header {
  border: 0;
  border-radius: var(--radius-control);
  color: var(--body);
  background: transparent;
  letter-spacing: 0;
  cursor: pointer;
}
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-section-header:hover { color: var(--color-primary-hover); background: var(--surface-2); }
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-section-header:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
#hud .hud-map-root.active #hud-physical-object-list .erow {
  min-height: var(--row-min-h-s);
  border-radius: var(--radius-control);
  color: var(--muted);
  transition: color var(--transition-fast), background var(--transition-fast);
}
#hud .hud-map-root.active #hud-physical-object-list .erow:hover { color: var(--title); background: var(--surface-2); }
#hud .hud-map-root.active #hud-physical-object-list .erow.related-orbit {
  color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}
#hud .hud-map-root.active #hud-physical-object-list .erow.on {
  outline: 0;
  color: var(--color-signal);
  background: color-mix(in srgb, var(--color-signal) 12%, transparent);
}
#hud .hud-map-root.active #hud-physical-object-list .erow:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-glyph {
  flex: 0 0 16px;
  height: 16px;
  color: currentColor;
  text-align: center;
  font-size: var(--font-xs);
}
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-glyph svg {
  display: block;
  width: 100%;
  height: 100%;
}
#hud .hud-map-root.active #hud-physical-object-list .physical-object-list-detail { color: var(--muted); }

/* View: 種別、表示要素、天球を先に読ませ、選択色は小さな点灯へ絞る。 */
#hud .hud-map-root.active #hud-view-options .view-options-section-heading {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  align-items: end;
  gap: var(--space-3);
  margin: var(--space-5) 0 var(--space-2);
}
#hud .hud-map-root.active #hud-view-options .view-options-section-heading:first-child { margin-top: 0; }

/* サブグループ(天体/機体と設備)の区切り。列凡例は持たず、ラベルだけを細く挟む。 */
#hud .hud-map-root.active #hud-view-options .view-options-section-divider {
  margin: var(--space-3) 0 var(--space-1);
  padding-left: var(--space-5);
  color: var(--muted);
  font-size: var(--font-xxs);
  letter-spacing: 1px;
}
/* 凡例は行見出しぶんの1列目を空けて、実際に説明しているトグル列の上へ載せる。 */
#hud .hud-map-root.active #hud-view-options .view-options-column-legend {
  grid-column: 2;
  display: grid;
  grid-template-columns: repeat(4, minmax(24px, 1fr));
  gap: var(--space-1);
}
#hud .hud-map-root.active #hud-view-options .view-options-column {
  color: var(--muted);
  font-size: var(--font-xxs);
  text-align: center;
  white-space: nowrap;
}
#hud .hud-map-root.active #hud-view-options .body-class-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: var(--space-3);
  margin-bottom: var(--space-1);
}
#hud .hud-map-root.active #hud-view-options .body-class-row .body-class-title {
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
#hud .hud-map-root.active #hud-view-options .body-class-row .body-class-title::before {
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
#hud .hud-map-root.active #hud-view-options .body-class-row .body-class-btns {
  display: grid;
  grid-template-columns: repeat(2, minmax(30px, 1fr));
  gap: var(--space-1);
}
#hud .hud-map-root.active #hud-view-options .body-class-row.grid-class-row .body-class-btns {
  grid-template-columns: repeat(4, minmax(24px, 1fr));
}
/* 面/極/網を持たない行(月軌道・月赤道)の空セル。列位置だけ他行と揃える。 */
#hud .hud-map-root.active #hud-view-options .body-class-icon-btn-empty { min-width: 0; }
#hud .hud-map-root.active #hud-view-options span.body-class-icon-btn {
  position: relative;
  min-width: 0;
  border: 0;
  border-radius: var(--radius-control);
  padding: var(--space-2);
  color: var(--muted);
  background: transparent;
}
#hud .hud-map-root.active #hud-view-options .body-class-row .w-btn:hover { color: var(--color-primary-hover); background: var(--surface-2); }
#hud .hud-map-root.active #hud-view-options .body-class-row .body-class-icon-btn.on {
  color: var(--title);
  background: var(--surface-2);
}
#hud .hud-map-root.active #hud-view-options .body-class-row .body-class-title.on {
  color: var(--title);
  background: transparent;
}
#hud .hud-map-root.active #hud-view-options .body-class-row .body-class-title.on::before { background: var(--color-primary); }
#hud .hud-map-root.active #hud-view-options .body-class-row .body-class-icon-btn.on::after {
  content: '';
  position: absolute;
  top: 4px;
  right: 4px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--color-primary);
}
#hud .hud-map-root.active #hud-view-options .body-class-row.category-off { opacity: var(--toggle-off-opacity); }
#hud .hud-map-root.active #hud-view-options .body-class-row.category-off .body-class-icon-btn.on::after { display: none; }

/* 対象は1行1ボタン。状態はボタンタイトル左のアイコンで表し、ラベル/軌道列を分けずに
   現在の表示状態を読み取れるようにする。 */
#hud .hud-map-root.active #hud-view-options .target-class-group {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-1) var(--space-2);
}
#hud .hud-map-root.active #hud-view-options .target-class-group .target-class-row { margin-bottom: 0; }
#hud .hud-map-root.active #hud-view-options .body-class-row.target-class-row {
  grid-template-columns: minmax(0, 1fr);
}
#hud .hud-map-root.active #hud-view-options .target-class-row .body-class-mode-button {
  display: flex; align-items: center; justify-content: flex-start; gap: var(--space-2);
  width: 100%; padding-right: var(--space-3);
  background: var(--surface-2); color: var(--muted);
}
#hud .hud-map-root.active #hud-view-options .target-class-row .body-class-mode-button .w-btn-icon {
  flex: 0 0 auto; width: 1.1em; height: 1.1em; margin-right: 0; color: var(--muted);
}
#hud .hud-map-root.active #hud-view-options .target-class-row .body-class-mode-button[data-display-mode="orbit"] {
  color: var(--title); background: color-mix(in srgb, var(--color-primary) 12%, var(--surface-2));
}
#hud .hud-map-root.active #hud-view-options .target-class-row .body-class-mode-button[data-display-mode="orbit"] .w-btn-icon {
  color: var(--color-primary);
}
#hud .hud-map-root.active #hud-view-options .target-class-row .body-class-mode-button[data-display-mode="label"] {
  color: var(--title); background: var(--surface-2);
}
#hud .hud-map-root.active #hud-view-options .target-class-row .body-class-mode-button[data-display-mode="label"] .w-btn-icon {
  color: var(--color-primary-hover);
}
#hud .hud-map-root.active #hud-view-options .target-class-row .body-class-mode-button[data-display-mode="hidden"] {
  background: transparent;
}

/* Predict: 未来は Accent、隣接する過去範囲は Near accent。Secondary は同期状態用に残す。 */
#hud .hud-map-root.active #hud-predict .w-btn,
#hud .hud-map-root.active #hud-predict .w-input {
  border: 0;
  border-radius: var(--radius-control);
  background: var(--surface-2);
}
#hud .hud-map-root.active #hud-predict .w-btn:hover { color: var(--color-primary-hover); background: var(--surface-3); }
#hud .hud-map-root.active #hud-predict .w-btn.on { color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 12%, var(--surface-2)); }
#hud .hud-map-root.active #hud-predict .predict-past .w-btn.on {
  color: var(--color-primary-hover);
  background: color-mix(in srgb, var(--color-primary-hover) 10%, var(--surface-2));
}
#hud .hud-map-root.active #hud-predict .w-group-title,
#hud .hud-map-root.active #hud-predict .w-toggle-title,
#hud .hud-map-root.active #hud-predict .predict-absolute,
#hud .hud-map-root.active #hud-predict .slider-ticks span { color: var(--muted); letter-spacing: 0; }
#hud .hud-map-root.active #hud-predict .predict-elapsed { color: var(--title); }
#hud .hud-map-root.active #hud-predict .predict-elapsed:hover { color: var(--color-primary-hover); }

/* Frame controls: ウィンドウ見出し > 操作 > 読み取り専用サマリーの順に弱くする。 */
#hud .hud-map-root.active .hud-frame-controls .frame-summary {
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  color: var(--muted);
  font-size: var(--font-xxs);
  line-height: 1.55;
}
#hud .hud-map-root.active .hud-frame-controls .w-btn,
#hud .hud-map-root.active .hud-frame-controls .w-toggle-track {
  border: 0;
  border-radius: var(--radius-control);
  background: var(--surface-2);
}
#hud .hud-map-root.active .hud-frame-controls .w-btn:hover { color: var(--color-primary-hover); background: var(--surface-3); }
#hud .hud-map-root.active .hud-frame-controls .w-btn.on { color: var(--color-primary); }
#hud .hud-map-root.active .hud-frame-controls .w-toggle-track.on { background: var(--color-signal); }

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
  #hud .hud-map-root.active #hud-physical-object-list,
  #hud .hud-map-root.active #hud-view-options,
  #hud .hud-map-root.active .hud-frame-controls { border-radius: var(--radius-panel); }
  #hud .hud-map-root.active #hud-view-options .view-options-section-heading,
  #hud .hud-map-root.active #hud-view-options .body-class-row { grid-template-columns: 82px minmax(0, 1fr); }
  #hud .hud-map-root.active #hud-view-options .body-class-row.target-class-row { grid-template-columns: minmax(0, 1fr); }
  #hud .hud-map-root.active #hud-view-options .view-options-column { font-size: 8px; }
}

@media ${MQ_COMPACT} {
  /* compact では既存の初期収納を保ち、開いたレールも両側合計100%未満に納める。 */
  #hud .hud-map-root.active {
    --rail-w-left: calc(42vw - 8px);
    --rail-w-right: calc(54vw - 8px);
  }
  #hud .hud-map-root.active #hud-physical-object-list .physical-object-list-head .w-group-title,
  #hud .hud-map-root.active #hud-physical-object-list .physical-object-list-detail { font-size: 8px; }
  #hud .hud-map-root.active #hud-view-options .view-options-section-heading,
  #hud .hud-map-root.active #hud-view-options .body-class-row { grid-template-columns: 68px minmax(0, 1fr); }
  #hud .hud-map-root.active #hud-view-options .body-class-row.target-class-row { grid-template-columns: minmax(0, 1fr); }
  #hud .hud-map-root.active #hud-view-options .target-class-group { grid-template-columns: minmax(0, 1fr); }
  #hud .hud-map-root.active #hud-view-options .view-options-column { overflow: hidden; text-overflow: ellipsis; }
  #hud .hud-map-root.active #hud-predict .predict-row1 { align-items: flex-start; }
}

/* マウス等の精密ポインタでは44pxタップ最小の制約がないため、表示パネルの行間・余白を詰める
   (UI-DESIGN.md のタップ最小寸法規則はタッチ環境限定)。 */
@media (pointer: fine) {
  #hud .hud-map-root.active #hud-view-options .body-class-row { margin-bottom: 2px; }
  #hud .hud-map-root.active #hud-view-options .view-options-section-heading { margin: var(--space-4) 0 var(--space-1); }
  #hud .hud-map-root.active #hud-view-options .view-options-section-divider { margin: var(--space-2) 0 2px; }
  #hud .hud-map-root.active #hud-view-options span.body-class-icon-btn { padding: 3px var(--space-2); }
}
`;

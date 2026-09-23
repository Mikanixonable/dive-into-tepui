// マップビューで開くパネル(MANEUVER PLAN・表示設定・予測軌道・座標系/カメラ・
// 軌道ガイド・ステージ操作・物体配置)の CSS。パネルが共有する行部品
// (.w-group / .w-toggle / .body-class-row)もここが持つ。
import { MQ_COARSE, MQ_COARSE_SHORT, MQ_COMPACT, MQ_MEDIUM_DOWN } from '../../../hud/breakpoints';

export const MAP_PANEL_STYLE = `
/* MANEUVER PLAN パネルと、表示設定パネル群が共有する行部品。 */
#hud .hud-rail > #hud-object-placer { max-height: none; overflow: visible; }
#hud .hud-rail > #hud-plan { width: 100%; min-width: 0; max-width: none; max-height: none; overflow: visible; }
/* MANEUVER PLAN はマップ操作の主パネルとして右レールの最上段に固定する。 */
#hud .hud-rail-right > #hud-plan {
  order: -1;
  align-self: flex-end;
  margin-left: auto;
}

#hud-plan { min-width: 0; width: 100%; max-width: 300px; overflow-wrap: anywhere; }
#hud .w-group { margin-bottom: var(--space-3); }
#hud .w-toggle { margin-bottom: var(--space-3); }
/* body-class-row: カテゴリー見出し + 名前/軌道線トグルの1行(太陽系・表示パネル)。
   見出しは幅を固定して縦に揃え、長い名前(ラグランジュ点など)は省略する。 */
#hud .body-class-row { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-2); }
#hud .body-class-row .body-class-title {
  width: 96px; min-width: 96px; text-align: left; font-size: var(--font-xs); letter-spacing: var(--tracking-label);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#hud .body-class-row .body-class-btns { display: flex; gap: var(--space-2); }
/* 旧全称リセットには依存せず、このパネル固有の密度として操作ボタン寸法を定義する。 */
#hud span.body-class-icon-btn { min-width: 20px; padding: var(--space-2) var(--space-3); text-align: center; font-size: var(--font-m); }
@media ${MQ_COARSE} {
  #hud span.body-class-icon-btn { min-width: var(--hit-target-min); min-height: var(--hit-target-min); }
}
@media ${MQ_MEDIUM_DOWN} {
  #hud-plan { min-width: 0; max-width: none; }
}
@media ${MQ_COMPACT} {
  #hud .hud-map-root.active .w-group { gap: var(--space-2); }
  #hud .hud-map-root.active .w-btn { padding: var(--space-2) var(--space-3); font-size: var(--font-xs); }
}

/* 表示設定パネル(#hud-view-options)のコンテナ・タイトル・本体と、タブ本体。 */
#hud-view-options { width: 100%; pointer-events: auto; }
#hud-view-options .view-options-title { flex: 0 0 auto; display: flex; align-items: center; gap: var(--space-2); cursor: pointer; }
#hud-view-options .view-options-collapse { margin-left: auto; background: none; border: none; color: var(--text-dim); font: inherit; cursor: pointer; pointer-events: auto; }
/* タブ切替(.w-tabs)は常に見えたまま、選択中のタブ本文だけをスクロールさせる——
   タイトル行・タブ切替をスクロールへ巻き込むと、下までスクロールした状態でタブへ
   手が届かなくなる。 */
#hud-view-options .view-options-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
#hud-view-options .view-options-body.collapsed { display: none !important; }
/* 表示パネルのタブ列と、選択中以外のタブ本体を隠す。選択中のタブ本体だけが
   view-options-body の残り高さを占めてスクロールする。 */
#hud-view-options .w-tabs { flex: 0 0 auto; margin-bottom: var(--space-3); }
#hud-view-options .view-options-tab-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-width: thin;
}
#hud-view-options .view-options-tab-body.hidden { display: none !important; }

/* 予測軌道パネル(#hud-predict / #hud-predict-wrap / #hud-predict-toggle)。 */
#hud-predict .predict-head { margin-bottom: var(--space-2); }
#hud-predict .predict-state {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end; gap: var(--space-5);
  margin-bottom: var(--space-3); padding-bottom: var(--space-3);
}
#hud-predict .predict-state .editorial-state-hero strong {
  font-size: var(--font-xl);
}
#hud-predict .predict-state-progress {
  display: grid; justify-items: end; gap: 2px; min-width: 72px;
}
#hud-predict .predict-state-progress .ui-data-secondary {
  color: var(--color-primary); font-size: var(--font-m); font-weight: 650;
}
#hud-predict .predict-controls {
  display: grid; gap: var(--space-2); padding-top: var(--space-3);
}
#hud-predict .predict-controls .predict-row1 { margin-bottom: 0; }
#hud-predict .predict-controls .predict-row2 {
  margin-top: var(--space-1); padding-top: var(--space-2);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-dim) 14%, transparent);
}

/* 下部の固定バーとその開閉トグル。両者を縦積みの flex にして画面下端に揃え、パネルを畳んでも
   トグルだけがその場(バーがあった位置の上端)に残るようにする。マップビューでは
   #hud-stagestatus は常に非表示なので、他の下端揃えパネル(.hud-rail 等)と同じ bottom まで詰める。
   左右レール(.hud-rail-left/.hud-rail-right)の内側に収まる幅だけを使い、レールのパネルに重ねない。 */
#hud-predict-wrap {
  position: absolute; bottom: 12px;
  left: calc(var(--hud-left-rail-occupied, calc(12px + var(--rail-w-left))) + 8px);
  right: calc(var(--hud-right-rail-occupied, calc(12px + var(--rail-w-right))) + 8px);
  display: flex; flex-direction: column; gap: var(--space-2); pointer-events: none;
}
/* #hud を重ねた ID セレクタで、.panel 共通規則(position:absolute)より詳細度を上げて打ち消す。
   表示/非表示は .hidden(ゲーム状態)/.collapsed(利用者の折りたたみ)の2軸だけに委ねる —
   ここで display を確定させると、どちらの軸がクラスを外しても表示に戻れなくなる。 */
#hud #hud-predict {
  position: relative; inset: auto; order: 2; box-sizing: border-box;
  max-height: 40vh; max-height: 40dvh; overflow-y: auto; pointer-events: auto;
}
#hud-predict.collapsed { display: none !important; }
#hud-predict-toggle {
  display: none; order: 1; align-self: center; pointer-events: auto; cursor: pointer;
  border: 0; border-radius: 50%;
  background: var(--surface); color: var(--color-primary);
}
#hud .hud-map-root.active #hud-predict-toggle { display: block; }
#hud-predict .predict-row1, #hud-predict .predict-row2 { display: flex; align-items: center; gap: var(--space-3); }
#hud-predict .predict-row1 { flex-wrap: wrap; margin-bottom: var(--space-2); }
#hud-predict .predict-pills { display: inline-flex; gap: var(--space-3); flex-wrap: wrap; align-items: center; }
/* span. まで指定して .w-btn 側の display/padding より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#hud-predict span.predict-reset {
  flex: 0 0 auto; padding: 0;
  display: flex; align-items: center; justify-content: center; border-radius: 50%;
  font-size: var(--font-m);
}
#hud-predict span.predict-reset:hover { color: var(--color-primary); }
#hud-predict .predict-slider-wrap { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; height: 22px; }
#hud-predict input[type="range"] { width: 100%; height: 22px; margin: 0; pointer-events: auto; accent-color: var(--color-primary); }
#hud-predict .predict-elapsed {
  flex: 0 0 auto; pointer-events: auto; cursor: pointer;
  font-size: var(--font-s); color: var(--text-dim); font-variant-numeric: tabular-nums; white-space: nowrap;
}
#hud-predict .predict-elapsed:hover { color: var(--text); }
#hud-predict .predict-absolute {
  flex: 0 0 auto; font-size: var(--font-s); color: var(--text-dim);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
#hud-predict .predict-value-input { display: inline-flex; align-items: center; gap: var(--space-2); margin: 0; }
#hud-predict .predict-value-input input[type="number"] { width: 112px; }
#hud-predict .slider-ticks { position: relative; height: 11px; margin-top: var(--space-1); }
#hud-predict .slider-ticks span {
  position: absolute;
  font-size: var(--font-xxs); color: var(--text-dim); white-space: nowrap;
}
@media ${MQ_MEDIUM_DOWN} {
  #hud-predict-wrap { bottom: 8px; }
}
@media ${MQ_COMPACT} {
  #hud-predict .slider-ticks { display: none; }
  /* 幅が足りないので、行2はスクラバーと T+ 読み値だけ残す。 */
  #hud-predict .predict-absolute { display: none; }
  #hud-predict-wrap { left: 8px; right: 8px; bottom: 8px; }
  #hud-predict { max-height: 28vh; max-height: 28dvh; }
}
@media ${MQ_COARSE} {
  #hud-predict-wrap { bottom: 62px; }
}
@media ${MQ_COARSE_SHORT} {
  #hud-predict-wrap { bottom: 52px; }
}

/* 座標系・カメラ FOV/角度操作パネル(.hud-frame-controls)。 */
#hud .hud-frame-controls {
  width: 100%; pointer-events: auto;
  max-height: none; overflow: visible;
}
/* 座標系の候補が増えても、見出しの右側へボタンを押し出さない。 */
#hud .hud-frame-controls .hud-frame-origin-zone > .w-group:first-child > .w-group-title,
#hud .hud-frame-controls .hud-frame-rotation-zone > .w-group-title {
  flex: 0 0 100%; min-width: 0;
}
/* タイトルを独立行にし、次の行へスライダー・数値入力・リセットボタンを並べる。 */
#hud .hud-frame-controls .camera-fov-control {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3);
}
#hud .hud-frame-controls .camera-control-label {
  flex: 0 0 100%; color: var(--text-dim); font-size: var(--font-xs); letter-spacing: var(--tracking-label);
}
#hud .hud-frame-controls .camera-fov-control .w-slider { flex: 1 1 auto; min-width: 60px; }
#hud .hud-frame-controls .camera-fov-control .w-slider:disabled,
#hud .hud-frame-controls .camera-fov-control .w-input:disabled { opacity: .4; cursor: not-allowed; }
#hud .hud-frame-controls .camera-fov-control .w-input { width: 54px; }
#hud .hud-frame-controls .camera-control-unit { color: var(--text-dim); font-size: var(--font-xs); }
/* 「角度」プルダウン: 見出しを独立行にし、次の行へ選択欄とセットボタンを並べる。 */
#hud .hud-frame-controls .camera-angle-group > .w-group-title { flex: 0 0 100%; min-width: 0; }
#hud .hud-frame-controls .camera-angle-group .w-select { flex: 1 1 auto; min-width: 80px; }

/* 軌道ガイドタブ(.orbit-guide-*): 種類ごとの区画(見出し+軸行+値行)。
   独立トグル行(系/点/南北)は見出し+ボタン列を折り返す。 */
.orbit-guide-tab {
  /* スライダー列の最小幅と、それに添える数値入力欄の幅。 */
  --orbit-guide-slider-min-w: 60px;
  --orbit-guide-value-w: 60px;
}
.orbit-guide-tab .w-tabs { margin-bottom: var(--space-3); }
.orbit-guide-group-body.hidden { display: none; }
.orbit-guide-system-row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-2); }
.orbit-guide-kind-row { margin-bottom: var(--space-2); }
.orbit-guide-kind-heading { margin-bottom: var(--space-1); }
.orbit-guide-kind-heading-btn { width: 100%; text-align: left; }
.orbit-guide-kind-heading-btn-resonant { padding: 10.5px calc(var(--space-5) * 1.5); font-size: calc(var(--font-s) * 1.5); text-align: center; }
.orbit-guide-combined-heading { font-size: var(--font-xxs); font-weight: 600; padding: var(--space-2) 0; }
.orbit-guide-kind-config { display: flex; flex-direction: column; gap: var(--space-2); padding-left: var(--space-3); }
.orbit-guide-kind-config.hidden { display: none; }
.orbit-guide-toggle-row { flex-wrap: wrap; }
.orbit-guide-value-row { flex-wrap: nowrap; align-items: center; }
.orbit-guide-value-row .slider-col { flex: 1 1 var(--orbit-guide-slider-min-w); min-width: var(--orbit-guide-slider-min-w); }
.orbit-guide-value-row .w-slider { width: 100%; }
.orbit-guide-value-row .w-input { width: var(--orbit-guide-value-w); }
.orbit-guide-value-row.hidden { display: none; }
.orbit-guide-value-unit { color: var(--text-dim); font-size: var(--font-xs); }
.orbit-guide-color-row { align-items: center; }
.orbit-guide-color-row .w-input { width: 44px; height: 24px; padding: 2px; }
.orbit-guide-color-row.hidden { display: none; }
.orbit-guide-line-count-warning { color: var(--color-error); font-size: var(--font-xs); margin-top: var(--space-2); }
.orbit-guide-line-count-warning.hidden { display: none; }
.orbit-guide-zero-velocity-range { display: flex; flex-direction: column; gap: var(--space-2); }
.orbit-guide-zero-velocity-range.hidden { display: none; }
.orbit-guide-section-divider-wrap { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-3); }

/* ステージ操作パネル(#hud-stage-controls、クリエイティブモードの敵/形状/タンパク質設定)。 */
#hud-stage-controls { width: 100%; pointer-events: auto; }
#hud-stage-controls .editorial-panel-head { margin-bottom: var(--space-3); }
#hud-stage-controls .stage-controls-body {
  display: grid; gap: var(--space-2); margin-top: 0; padding-top: var(--space-3);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-dim) 20%, transparent);
}
#hud-stage-controls .stage-control-enemy-tabs { display: flex; gap: var(--space-2); }
#hud-stage-controls .stage-control-enemy-tabs .w-btn { flex: 1 1 0; min-width: 0; }
#hud-stage-controls .stage-control-section {
  display: grid; gap: var(--space-2); margin-top: var(--space-2); padding-top: var(--space-3);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-dim) 14%, transparent);
}
#hud-stage-controls .stage-control-section-title {
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: .1em; text-transform: uppercase;
}
#hud-stage-controls .stage-control-shapes { display: flex; flex-wrap: wrap; gap: var(--space-2); }
#hud-stage-controls .stage-control-shapes .w-group-title { flex: 0 0 100%; }
#hud-stage-controls .stage-control-shapes .w-btn { flex: 1 1 0; min-width: 0; }
#hud-stage-controls .stage-control-shapes .w-btn.on { background: var(--color-primary-fill); color: var(--color-primary); }
#hud-stage-controls .stage-control-protein-representation,
#hud-stage-controls .stage-control-protein-colors { display: flex; flex-wrap: wrap; gap: var(--space-2); }
#hud-stage-controls .stage-control-protein-representation .w-group-title,
#hud-stage-controls .stage-control-protein-colors .w-group-title { flex: 0 0 100%; }
#hud-stage-controls .stage-control-protein-representation .w-btn,
#hud-stage-controls .stage-control-protein-colors .w-btn { flex: 1 1 0; min-width: 0; }
/* 着色は長い分析用ラベルを含むため2列へ折り返し、全文をボタン内に収める。 */
#hud-stage-controls .stage-control-protein-colors .w-btn {
  flex: 1 1 calc(50% - var(--space-2)); min-width: 110px; white-space: normal; overflow-wrap: anywhere;
}
#hud-stage-controls .stage-control-protein-representation .w-btn.on,
#hud-stage-controls .stage-control-protein-colors .w-btn.on { background: var(--color-primary-fill); color: var(--color-primary); }
#hud-stage-controls .stage-control-select { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); color: var(--text-dim); font-size: var(--font-xxs); }
#hud-stage-controls .stage-control-select .w-select { min-width: 86px; }
#hud-stage-controls .stage-control-select .w-input { width: 72px; text-align: right; }

/* 物体配置パネル(#hud-object-placer、クリエイティブモード限定): MANEUVER PLAN の下、
   右上に縦積みする。 */
#hud-object-placer {
  width: 100%; pointer-events: auto; max-height: 70vh; max-height: 70dvh; overflow-y: auto;
}
#hud-object-placer .editorial-panel-head {
  margin-bottom: var(--space-3); padding-bottom: var(--space-3);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 22%, transparent);
}
#hud-object-placer .w-close { border-radius: 50%; }
#hud-object-placer .shipplacer-btn-row { display: flex; gap: var(--space-4); margin-top: var(--space-5); }
#hud-object-placer .slider-field { margin-bottom: var(--space-4); }
#hud-object-placer .slider-field .w-group { flex-wrap: nowrap; margin-bottom: 0; }
#hud-object-placer .slider-field .slider-col { flex: 1 1 60px; min-width: 60px; }
#hud-object-placer .slider-field input[type="range"] { width: 100%; pointer-events: auto; accent-color: var(--color-primary); }
#hud-object-placer .slider-field .slider-ticks { display: flex; justify-content: space-between; margin-top: var(--space-1); }
#hud-object-placer .slider-field .slider-ticks span { flex: 0 1 auto; min-width: 0; font-size: calc(var(--font-xxs) * 0.82); color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#hud-object-placer .slider-field .slider-ticks span:first-child { text-align: left; }
#hud-object-placer .slider-field .slider-ticks span:last-child { text-align: right; }
#hud-object-placer input[type="text"] { flex: 1; width: auto; }
#hud-object-placer .preset-row { flex-wrap: wrap; gap: var(--space-3); }
#hud-object-placer .field-issue { border: 0; border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); color: var(--color-error); }
#hud-object-placer .issue-list { margin: var(--space-4) 0; padding: var(--space-3) var(--space-4); border: 0; border-radius: var(--radius-s); background: var(--color-error-fill); }
#hud-object-placer .issue-list .issue-line { font-size: var(--font-s); color: var(--color-error); }


/* DISPLAY INDEX — タイトル画面の stage list と同じ「名称 + 右端状態」の索引型。 */
#hud-view-options .view-options-render-row {
  grid-template-columns: 2.4em minmax(0, 1fr) auto;
  margin: var(--space-3) 0 var(--space-2);
  padding-inline: var(--space-2);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 16%, transparent);
}
#hud-view-options .view-options-render-label { display: grid; gap: 2px; min-width: 0; }
#hud-view-options .view-options-render-label > span {
  color: var(--text); font-size: var(--font-xs); letter-spacing: 0;
}
#hud-view-options .view-options-render-label > small {
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: var(--tracking-label);
}
#hud-view-options .view-options-render-choices {
  display: inline-flex; justify-self: end; align-items: stretch; gap: 1px;
  min-width: 0;
}
#hud-view-options .view-options-render-choice {
  min-width: 0; padding-inline: var(--space-3); border-radius: 0;
  background: transparent; color: var(--text-dim);
}
#hud-view-options .view-options-render-choice.on {
  background: var(--color-primary-fill-weak); color: var(--color-primary);
}
#hud-view-options .view-options-render-choice:first-child {
  border-radius: var(--radius-control) 0 0 var(--radius-control);
}
#hud-view-options .view-options-render-choice:last-child {
  border-radius: 0 var(--radius-control) var(--radius-control) 0;
}
@media ${MQ_MEDIUM_DOWN} {
  #hud-view-options .view-options-render-row {
    grid-template-columns: 2.4em minmax(0, 1fr);
  }
  #hud-view-options .view-options-render-choices {
    grid-column: 2; justify-self: stretch; width: 100%;
  }
  #hud-view-options .view-options-render-choice { flex: 1 1 0; text-align: center; }
}

#hud-view-options .view-options-title {
  align-items: baseline; padding-bottom: var(--space-3);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 24%, transparent);
}
#hud-view-options .view-options-context {
  min-width: 0; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#hud-view-options .view-options-title .view-options-collapse { margin-left: var(--space-2); }
#hud-view-options .view-options-body > .w-tabs { margin-top: var(--space-3); }
#hud-view-options .view-options-section-divider {
  margin-top: var(--space-4); margin-bottom: var(--space-1);
}
#hud-view-options .target-class-group { display: grid; gap: 1px; }
#hud-view-options .target-class-row {
  display: grid; grid-template-columns: 2.4em minmax(0, 1fr) auto;
  align-items: center; gap: var(--space-2);
  margin: 0; min-height: var(--hit-target-min);
}
#hud-view-options .target-class-row .body-class-title {
  display: flex; grid-column: 2 / 4; align-items: center; gap: var(--space-2);
  width: 100%; min-width: 0; min-height: var(--hit-target-min); padding: var(--space-2) 0;
  border: 0; border-radius: 0; background: transparent; box-shadow: none;
}
#hud-view-options .target-class-row .body-class-title .w-btn-icon { display: none; }
#hud-view-options .target-class-row .body-class-title::after {
  content: attr(data-display-label); margin-left: auto;
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: var(--tracking-label);
}
#hud-view-options .target-class-row .body-class-title.on {
  color: var(--text); background: transparent;
}
#hud-view-options .target-class-row .body-class-title.on::after { color: var(--color-primary); }
#hud-view-options .target-class-row:hover { background: var(--glass-control-hover); }
#hud-view-options .view-options-section-heading {
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: var(--tracking-label);
}
#hud-view-options .grid-class-row {
  padding-block: var(--space-1); box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 12%, transparent);
}

/* CAMERA / FRAME — 現在状態を先に読み、操作は下段へ分離する。 */
#hud .hud-frame-controls .editorial-panel-head { margin-bottom: var(--space-3); }
#hud .hud-frame-controls .editorial-state { margin-top: var(--space-1); }
#hud .hud-frame-controls .camera-state-lens {
  display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr);
  align-items: end; gap: var(--space-3);
}
#hud .hud-frame-controls .camera-state-lens > div { display: grid; gap: var(--space-1); min-width: 0; }
#hud .hud-frame-controls .camera-state-lens > div:last-child { text-align: right; }
#hud .hud-frame-controls .camera-state-lens .ui-data-hero { font-size: var(--font-2xl); }
#hud .hud-frame-controls .editorial-control-zone > :last-child { margin-bottom: 0; }
#hud .hud-frame-controls-compact {
  max-height: none; overflow: visible;
}
#hud .hud-frame-controls-compact .editorial-panel-head { margin-bottom: var(--space-2); }
#hud .trajectory-frame-state [data-frame-hero="true"] {
  text-transform: uppercase;
}

/* MANEUVER PLAN — 計画も同じ Control Sheet として扱う。 */
#hud-plan.editorial-control-sheet .plan-panel-head {
  display: flex; align-items: baseline; gap: var(--space-2);
  margin-bottom: var(--space-3); padding-bottom: var(--space-3);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 24%, transparent);
}
#hud-plan .plan-node-hero {
  display: grid; gap: var(--space-1); margin-bottom: var(--space-3);
}
#hud-plan .plan-node-hero strong {
  color: var(--text-strong); font-size: var(--font-xl);
  font-variant-numeric: tabular-nums; letter-spacing: var(--tracking-title);
}
#hud-plan .plan-state .editorial-state-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2);
}
#hud-plan .plan-state .editorial-state-cell > :last-child { font-size: var(--font-xxs); }
#hud-plan .plan-post-orbit {
  margin-top: var(--space-3); padding-top: var(--space-3);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-dim) 22%, transparent);
}
#hud-plan .plan-help {
  margin-top: var(--space-3); color: var(--text-dim); font-size: var(--font-xxs); line-height: 1.5;
}
`;

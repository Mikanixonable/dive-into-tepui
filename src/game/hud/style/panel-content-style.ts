// 個々のパネルの中身の CSS: SHIP STATUS/ORBIT/TARGET/CONTACTS の行、軌道物体一覧、
// 軌道計画、表示設定、表示時刻、カメラ・軌道、物体配置、ナビボール、ステージステータス、
// 設定・ヘルプ・終了画面。骨格(層・レール・シェルフ・バッジ)は skeleton-style.ts が持つ。
import * as C from '../../const';
import { MQ_COARSE, MQ_COARSE_SHORT, MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT } from '../breakpoints';

export const PANEL_CONTENT_STYLE = `
  .protein-target-details { margin-top: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--line-subtle); }
  .protein-target-heading { display: flex; justify-content: space-between; color: var(--text-muted); font-size: var(--font-xxs); letter-spacing: .08em; }
  .protein-site-row { display: grid; grid-template-columns: 1rem 5.2rem minmax(3rem, 1fr) auto; gap: var(--space-2); align-items: center; margin-top: var(--space-2); font-size: var(--font-xxs); }
  .protein-site-glyph { color: var(--color-signal); font-size: var(--font-xs); line-height: 1; opacity: calc(.25 + var(--protein-site-hp) * .75); }
  .protein-site-row.disabled .protein-site-glyph { color: var(--text-dim); }
  .protein-site-label { min-width: 0; }
  .protein-site-meter { height: 4px; background: var(--line-subtle); overflow: hidden; }
  .protein-site-meter i { display: block; height: 100%; background: var(--signal); }
#hud-vessel-status h3 { font-size: var(--font-xxs); }
/* 通常のマップビューでは艦固有の情報を右クリックのプロパティウィンドウで参照するので、常設の
   SHIP STATUS は畳んでパネル占有面積を減らす。クリエイティブでは配置後の操作用に表示する。 */
#hud:not(.creative-mode) .hud-map-root.active #hud-vessel-status { display: none; }
#hud-orbit h3 { font-size: var(--font-xxs); }
#hud-vessel-status .v, #hud-orbit .v { min-width: 75px; }
#hud-vessel-status .vessel-meter-readout {
  display: inline-grid;
  grid-template-columns: minmax(64px, 1fr) auto;
  align-items: center;
  gap: 6px;
  width: 128px;
}
#hud-vessel-status .vessel-meter {
  height: 6px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--bar-bg);
}
#hud-vessel-status .vessel-meter-fill {
  display: block;
  width: 0;
  height: 100%;
  border-radius: inherit;
  background: var(--color-primary);
  transition: width 180ms;
}
#hud-vessel-status .vessel-meter.critical .vessel-meter-fill {
  background: var(--color-error);
}
#hud-vessel-status .vessel-meter-value {
  min-width: 48px;
  color: var(--text);
  font-size: var(--font-xxs);
  text-align: right;
  white-space: nowrap;
}
#hud-vessel-status .vessel-deploy-controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
  margin-top: var(--space-3);
}
/* パドル/放熱板の展開度と損耗をボタン内の塗りつぶしで示す。 */
#hud-vessel-status span.vessel-deploy-btn {
  position: relative; overflow: hidden; width: 100%; min-width: 0;
  padding: var(--space-2) var(--space-3); text-align: left;
}
#hud-vessel-status .vessel-deploy-btn .fill {
  position: absolute; inset: 0; z-index: 0;
  transition: width var(--transition-fast), background var(--transition-fast);
}
#hud-vessel-status .vessel-deploy-btn .label {
  position: relative; z-index: 1; color: var(--text); font-size: var(--font-xxs); line-height: 1.5;
  text-shadow: 0 0 3px var(--bg), 0 0 3px var(--bg); transition: color var(--transition-fast);
}
#hud-vessel-status .vessel-deploy-btn.on { border-color: var(--color-primary); }
#hud-vessel-status .vessel-deploy-btn.on .label { color: var(--color-primary); }
/* 常設パネルの操作ボタン列(艦ステータスの R/F/G/T 代替、軌道情報の分析パネル起動、
   いずれもタッチ・マウスどちらでも常設)。 */
.combat-panel .panel-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); }
.combat-panel .panel-actions .w-btn { font-size: var(--font-xxs); padding: var(--space-2) var(--space-3); }
/* スロットル 1-4 の SegmentedControl。§7-1 の決定によりタッチ UI が出ている間だけ表示する —
   表示条件はタッチパッドの出し入れ(touch.ts の setPointerKind が付ける body.touch-ui-active)と
   同じものに載せ、ここで別の判定を作らない。 */
#hud-vessel-status .status-throttle-touch { display: none; margin-top: var(--space-3); }
body.touch-ui-active #hud-vessel-status .status-throttle-touch { display: flex; }
#hud .hud-rail-right > #hud-target { width: 100%; box-sizing: border-box; font-size: var(--font-xs); }
#hud .hud-rail-right > #hud-target h3 { font-size: var(--font-xxs); }
#hud-enemies h3 { font-size: var(--font-xxs); }
#hud-enemies .erow { display: flex; justify-content: space-between; gap: var(--space-4); color: var(--text-dim); }
#hud-enemies .erow.tgt { color: var(--color-primary); }

#hud .hud-rail > #hud-object-placer { max-height: none; overflow: visible; }
#hud .hud-rail > #hud-plan { width: 100%; min-width: 0; max-width: none; max-height: none; overflow: visible; }
/* MANEUVER PLAN はマップ操作の主パネルとして右レールの最上段に固定する。 */
#hud .hud-rail-right > #hud-plan {
  order: -1;
  align-self: flex-end;
  margin-left: auto;
}

#hud-physical-object-list { max-height: 544px; max-height: min(544px, 60dvh); overflow-y: auto; }
/* パネルの padding 分だけ食い込ませて幅いっぱいに広げ、スクロール中も先頭に張り付かせる */
#hud-physical-object-list .physical-object-list-head { position: sticky; top: calc(var(--space-4) * -1); margin: calc(var(--space-4) * -1) calc(var(--space-5) * -1) 0; padding: var(--space-4) var(--space-5) 0; background: var(--surface-opaque); z-index: 1; }
#hud-physical-object-list .physical-object-list-search { padding: var(--space-1) var(--space-2); }
#hud-physical-object-list .physical-object-list-search .w-input { width: 100%; }
#hud-physical-object-list .physical-object-list-head .w-group { padding: var(--space-1) var(--space-2); }
#hud-physical-object-list .physical-object-list-head .w-group-title { flex: 1 0 100%; }
#hud-physical-object-list .physical-object-list-head .w-btn { font-size: var(--font-xxs); }
#hud-physical-object-list .physical-object-list-collapse {
  margin-left: auto; background: none; border: none; color: var(--text-dim); font: inherit; cursor: pointer; pointer-events: auto;
}
#hud-physical-object-list .physical-object-list-title { display: flex; align-items: center; gap: var(--space-2); }
#hud-physical-object-list .physical-object-list-body.collapsed { display: none !important; }
#hud-physical-object-list .physical-object-list-breadcrumb { padding: var(--space-1) var(--space-3); font-size: var(--font-xxs); color:var(--text-dim); border-bottom:1px solid var(--edge); }
#hud-physical-object-list .physical-object-list-section-header {
  display: block; width: 100%; text-align: left; margin: var(--space-2) 0 var(--space-1);
  padding: var(--space-2) var(--space-4); font-size: var(--font-xs); letter-spacing: 1px;
}
#hud-physical-object-list .physical-object-list-section-body { padding-left: var(--space-2); }
#hud-physical-object-list .physical-object-list-section-body.collapsed { display: none !important; }
#hud-physical-object-list .erow { padding: var(--space-2) var(--space-2); color: var(--text-dim); cursor: pointer; display: flex; align-items: center; gap: var(--space-2); }
#hud-physical-object-list .physical-object-list-detail { margin-left: auto; font-size: var(--font-xxs); color: var(--text-dim); white-space: nowrap; }
#hud-physical-object-list .erow:hover { color: var(--text); }
#hud-physical-object-list .erow.tgt {
  color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}
#hud-physical-object-list .erow.on {
  outline: 0; color: var(--color-signal); background: color-mix(in srgb, var(--color-signal) 12%, transparent);
}
#hud-physical-object-list .erow.cluster { opacity: .55; }
#hud-physical-object-list .physical-object-list-toggle { width: 10px; text-align: center; flex: none; }
#hud-physical-object-list .physical-object-list-children { padding-left: var(--space-5); }
#hud-physical-object-list .physical-object-list-children.collapsed { display: none !important; }
#hud-physical-object-list .physical-object-list-empty { padding: var(--space-6); text-align: center; color: var(--text-dim); }

#hud-plan { min-width: 0; width: 100%; max-width: 300px; overflow-wrap: anywhere; }
#hud .w-group { margin-bottom: var(--space-3); }
#hud .w-toggle { margin-bottom: var(--space-3); }
/* body-class-row: カテゴリー見出し + 名前/軌道線トグルの1行(太陽系・表示パネル)。
   見出しは幅を固定して縦に揃え、長い名前(ラグランジュ点など)は省略する。 */
#hud .body-class-row { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-2); }
#hud .body-class-row .body-class-title {
  width: 96px; min-width: 96px; text-align: left; font-size: var(--font-xs); letter-spacing: 1px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#hud .body-class-row .body-class-btns { display: flex; gap: var(--space-2); }
/* span. まで指定して .w-btn 側の padding/font-size より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#hud span.body-class-icon-btn { min-width: 20px; padding: var(--space-2) var(--space-3); text-align: center; font-size: var(--font-m); }
#hud .body-class-row.category-off .body-class-icon-btn.on { border-color: var(--edge); color: var(--text-dim); font-weight: 700; opacity: .65; }
/* 太陽系パネルの左列は navball ウィンドウの右に置き、重なりを避ける。 */
#hud-view-options { width: 100%; pointer-events: auto; }
#hud-view-options .view-options-title { display: flex; align-items: center; gap: var(--space-2); }
#hud-view-options .view-options-collapse { margin-left: auto; background: none; border: none; color: var(--text-dim); font: inherit; cursor: pointer; pointer-events: auto; }
#hud-view-options .view-options-body.collapsed { display: none !important; }
/* 下部の固定バーとその開閉トグル。両者を縦積みの flex にして画面下端に揃え、パネルを畳んでも
   トグルだけがその場(バーがあった位置の上端)に残るようにする。マップビューでは
   #hud-stagestatus は常に非表示なので、他の下端揃えパネル(.hud-rail 等)と同じ bottom まで詰める。
   左右レール(.hud-rail-left/.hud-rail-right)の内側に収まる幅だけを使い、レールのパネルに重ねない。 */
#hud-predict-wrap {
  position: absolute; bottom: 12px;
  left: calc(12px + var(--rail-w-left) + 8px); right: calc(12px + var(--rail-w-right) + 8px);
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
  width: 26px; height: 26px; border: 1px solid var(--edge); border-radius: var(--radius-m);
  background: var(--surface); color: var(--color-primary);
}
#hud .hud-map-root.active #hud-predict-toggle { display: block; }
#hud.dock-mode #hud-predict-toggle { display: none; }
#hud-predict .predict-row1, #hud-predict .predict-row2 { display: flex; align-items: center; gap: var(--space-3); }
#hud-predict .predict-row1 { flex-wrap: wrap; margin-bottom: var(--space-2); }
#hud-predict .predict-pills { display: inline-flex; gap: var(--space-3); flex-wrap: wrap; align-items: center; }
/* span. まで指定して .w-btn 側の display/padding より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#hud-predict span.predict-reset {
  flex: 0 0 auto; padding: 0;
  width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
  font-size: var(--font-m);
}
#hud-predict span.predict-reset:hover { border-color: var(--color-primary); color: var(--color-primary); }
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
/* 単位の SegmentedControl は見出しを持たないので、共通規則の見出し幅を出さない。 */
#hud-predict .predict-value-input .seg-title { display: none; }
#hud-predict .predict-value-input input[type="number"] { width: 112px; }
#hud-predict .slider-ticks { position: relative; height: 11px; margin-top: var(--space-1); }
#hud-predict .slider-ticks span {
  position: absolute;
  font-size: var(--font-xxs); color: var(--text-dim); white-space: nowrap;
}
#hud .hud-frame-controls { width: 100%; pointer-events: auto; }
#hud .hud-frame-controls .hud-frame-scroll-zone {
  max-height: min(240px, 30vh); max-height: min(240px, 30dvh); overflow-y: auto;
  scrollbar-width: thin;
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
  flex: 0 0 100%; color: var(--text-dim); font-size: var(--font-xs); letter-spacing: 1px;
}
#hud .hud-frame-controls .camera-fov-control .w-slider { flex: 1 1 auto; min-width: 60px; }
#hud .hud-frame-controls .camera-fov-control .w-slider:disabled,
#hud .hud-frame-controls .camera-fov-control .w-input:disabled { opacity: .4; cursor: not-allowed; }
#hud .hud-frame-controls .camera-fov-control .w-input { width: 54px; }
#hud .hud-frame-controls .camera-control-unit { color: var(--text-dim); font-size: var(--font-xs); }
/* 「角度」プルダウン: 見出しを独立行にし、次の行へ選択欄とセットボタンを並べる。 */
#hud .hud-frame-controls .camera-angle-group > .w-group-title { flex: 0 0 100%; min-width: 0; }
#hud .hud-frame-controls .camera-angle-group .w-select { flex: 1 1 auto; min-width: 80px; }
#hud-stage-controls { width: 100%; pointer-events: auto; }
#hud-stage-controls .stage-controls-body { display: grid; gap: var(--space-2); margin-top: var(--space-3); }
#hud-stage-controls .stage-control-enemy-tabs { display: flex; gap: var(--space-2); }
#hud-stage-controls .stage-control-enemy-tabs .w-btn { flex: 1 1 0; min-width: 0; }
#hud-stage-controls .stage-control-section { display: grid; gap: var(--space-2); padding-top: var(--space-2); border-top: 1px solid var(--edge); }
#hud-stage-controls .stage-control-section-title { color: var(--text); font-size: var(--font-xxs); letter-spacing: .04em; }
#hud-stage-controls .stage-control-shapes { display: flex; flex-wrap: wrap; gap: var(--space-2); }
#hud-stage-controls .stage-control-shapes .w-group-title { flex: 0 0 100%; }
#hud-stage-controls .stage-control-shapes .w-btn { flex: 1 1 0; min-width: 0; }
#hud-stage-controls .stage-control-shapes .w-btn.on { background: var(--color-primary-fill); border-color: var(--color-primary); color: var(--color-primary); }
#hud-stage-controls .stage-control-protein-representation,
#hud-stage-controls .stage-control-protein-colors { display: flex; flex-wrap: wrap; gap: var(--space-2); }
#hud-stage-controls .stage-control-protein-representation .w-group-title,
#hud-stage-controls .stage-control-protein-colors .w-group-title { flex: 0 0 100%; }
#hud-stage-controls .stage-control-protein-representation .w-btn,
#hud-stage-controls .stage-control-protein-colors .w-btn { flex: 1 1 0; min-width: 0; }
#hud-stage-controls .stage-control-protein-representation .w-btn.on,
#hud-stage-controls .stage-control-protein-colors .w-btn.on { background: var(--color-primary-fill); border-color: var(--color-primary); color: var(--color-primary); }
#hud-stage-controls .stage-control-select { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); color: var(--text-dim); font-size: var(--font-xxs); }
#hud-stage-controls .stage-control-select .w-select { min-width: 86px; }
#hud-stage-controls .stage-control-select .w-input { width: 72px; text-align: right; }
/* 物体配置パネル(クリエイティブモード限定): MANEUVER PLAN の下、右上に縦積みする。 */
#hud-object-placer { width: 100%; pointer-events: auto; max-height: 70vh; max-height: 70dvh; overflow-y: auto; }
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
#hud-object-placer .field-issue { border: 1px solid var(--color-error); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); }
#hud-object-placer .issue-list { margin: var(--space-4) 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--color-error); border-radius: var(--radius-s); background: var(--color-error-fill); }
#hud-object-placer .issue-list .issue-line { font-size: var(--font-s); color: var(--color-error); }
#navball { top: 12px; left: 12px; width: 190px; pointer-events: auto; }
#navball .nb-ball { display: block; width: 100%; height: auto; margin: var(--space-2) 0 var(--space-4); }
#navball .nb-rim { fill: var(--fill-1); stroke: var(--edge); stroke-width: 1; }
#navball .nb-grid { fill: none; stroke: var(--text-dim); stroke-width: 0.6; opacity: 0.35; }
#navball .nb-equator { fill: none; stroke: var(--text-dim); stroke-width: 0.9; opacity: 0.55; }
#navball .nb-bore line { stroke: ${C.COLOR_MARKER_BORESIGHT}; stroke-width: 1; opacity: 0.8; }
#navball text { font-size: var(--font-xxs); text-anchor: middle; dominant-baseline: middle; }
#navball .nb-pro { fill: var(--axis-prograde); }
#navball .nb-nrm { fill: var(--axis-normal); }
#navball .nb-rad { fill: var(--axis-radial); }

#hud-result {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  background: var(--scrim); backdrop-filter: blur(3px);
  flex-direction: column; text-align: center;
}
#hud-result h1 { font-size: var(--font-3xl); letter-spacing: 6px; margin-bottom: var(--space-6); }
#hud-result.win h1 { color: var(--text); }
#hud-result.lose h1 { color: var(--color-primary); }
#hud-result .detail {
  font-size: var(--font-xl); line-height: 2; color: var(--text);
  background: var(--surface); border: 1px solid var(--edge); border-radius: var(--radius-m); padding: var(--space-6) var(--space-6);
}
#hud-result .restart { margin-top: var(--space-6); color: var(--color-primary-hover); font-size: var(--font-l); }
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
#hud-help .help-close-button:hover, #hud-help .help-close-button:focus-visible { color: var(--color-primary-hover); border-color: var(--color-primary); }
#hud-help .help-mode-status { margin-top: var(--space-2); color: var(--color-primary-hover); font-size: var(--font-xxs); letter-spacing: .04em; }
#hud-help .help-toolbar { display: grid; gap: var(--space-3); padding: var(--space-4) 0; }
#hud-help .help-toolbar-row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
#hud-help .help-toolbar-label { color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: .06em; }
#hud-help .help-tab {
  min-height: 28px; padding: var(--space-2) var(--space-3); border: 1px solid var(--edge); border-radius: var(--radius-control);
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

#hud-stagestatus {
  bottom: calc(12px + var(--safe-b)); left: 50%; transform: translateX(-50%);
  display: flex; align-items: flex-start; gap: var(--space-6);
  text-align: left; min-width: 720px; padding: var(--space-4) var(--space-6);
}
#hud-stagestatus .t {
  font-size: var(--font-s); letter-spacing: 2px; color: var(--text); font-variant-numeric: tabular-nums;
  display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-4); align-items: center;
}
#hud-stagestatus .t.warn { color: var(--color-warning); }
#hud-stagestatus .t .w-meter { width: 240px; }
#hud-stagestatus .k { font-size: var(--font-s); color: var(--text-dim); line-height: 1.8; white-space: nowrap; }
#hud-stagestatus .k-widgets:not(:empty) { margin-top: var(--space-3); }
#hud-pause-menu {
  position: fixed; display: none; width: 320px; pointer-events: auto;
}
#hud-pause-menu .pm-header {
  display: flex; align-items: center; gap: var(--space-6); cursor: move;
}
#hud-pause-menu .pm-header h3 { flex: 1 1 auto; min-width: 0; margin: 0; }
#hud-pause-menu .pm-header-actions {
  display: flex; align-items: center; gap: var(--space-2); flex: 0 0 auto;
}
#hud-pause-menu .pm-header .w-close, #hud-pause-menu .pm-minimize {
  flex: 0 0 auto; width: 20px; height: 20px; border-radius: 50%;
}
#hud-pause-menu .pm-minimize {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0; font: inherit; font-size: var(--font-m); border: 1px solid transparent;
  background: var(--surface-2); color: var(--body); cursor: pointer;
}
#hud-pause-menu .pm-minimize:hover { color: var(--color-primary-hover); background: var(--surface-3); }
#hud-pause-menu .pm-body.hidden { display: none; }
#hud-pause-menu .pm-row {
  display: flex; justify-content: space-between; align-items: center; gap: var(--space-6); padding: var(--space-3) 0;
}
/* span. まで指定して .w-btn 側の padding/font-size より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#hud-pause-menu span.pm-menu-btn {
  width: 100%; box-sizing: border-box; text-align: center;
  padding: var(--space-4) var(--space-5); font-size: var(--font-m);
}
#hud-pause-menu span.pm-quit { margin-top: var(--space-5); }
#hud-settings-view {
  inset: 0; display: none; overflow-y: auto; pointer-events: auto;
  padding: clamp(24px, 7vh, 72px) max(var(--space-6), 6vw);
  border-radius: 0; background: var(--scrim); box-shadow: none;
}
#hud-settings-view.settings-dock {
  inset: auto; width: 100%; max-height: min(70dvh, 720px); padding: var(--space-4);
  overflow-y: auto; background: var(--surface-0); border: 1px solid var(--edge);
  border-radius: var(--radius-panel); box-shadow: none; backdrop-filter: none;
}
#hud-settings-view.settings-dock .sv-header { padding-bottom: var(--space-3); }
#hud-settings-view.settings-dock .sv-header h2 { font-size: var(--font-l); }
#hud-settings-view.settings-dock .sv-eyebrow,
#hud-settings-view.settings-dock .sv-description { display: none; }
#hud-settings-view.settings-dock .sv-tabs { margin-top: var(--space-4); }
#hud-settings-view.settings-dock .sv-tabs .w-btn { min-height: var(--hit-target-min); padding: var(--space-4) var(--space-2) var(--space-3); font-size: var(--font-xs); }
#hud-settings-view.settings-dock .sv-section { margin-top: var(--space-4); padding: var(--space-4); }
#hud-settings-view.settings-dock .sv-theme-options { grid-template-columns: 1fr; }
#hud-settings-view.settings-dock .sv-theme-button { min-height: var(--hit-target-min); padding-inline: var(--space-3); }
#hud-settings-view .sv-header,
#hud-settings-view .sv-description,
#hud-settings-view .sv-section { width: min(100%, 760px); margin-inline: auto; }
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
  background: color-mix(in srgb, var(--sv-theme-title) 8%, var(--surface-0));
  color: var(--sv-theme-title);
}
#hud-settings-view .sv-theme-button:not(.on):hover {
  background: color-mix(in srgb, var(--sv-theme-title) 16%, var(--surface-0));
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
  #hud-plan { min-width: 0; max-width: none; }
  #hud-help { min-width: 0; width: 94vw; max-height: 88vh; max-height: 88dvh; }
  #hud-help .help-body { max-height: calc(min(88vh, 900px) - 190px); max-height: calc(min(88dvh, 900px) - 190px); }
  #hud-help .help-quickstart-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  #hud-result h1 { font-size: var(--font-2xl); letter-spacing: 3px; }
  #hud-result .detail { font-size: var(--font-l); padding: var(--space-5) var(--space-6); max-width: 92vw; }
  #navball { top: 76px; width: 96px !important; height: auto !important; }
  #hud-pause-menu { min-width: 0; width: 78vw; }
  #hud-settings-view { padding-inline: var(--space-5); }
  #hud-stagestatus { bottom: 8px; width: min(62vw, 440px); min-width: 0; max-height: 62px; overflow-y: auto; padding: var(--space-3) var(--space-5); gap: var(--space-4); }
  /* このブレークポイントのレール幅に合わせて左右の隙間を再計算する。 */
  #hud-predict-wrap {
    bottom: 8px;
    left: calc(8px + var(--rail-w-left) + 8px); right: calc(8px + var(--rail-w-right) + 8px);
  }
  #hud-stagestatus .t { font-size: var(--font-s); }
  #hud-stagestatus .k { font-size: var(--font-xxs); line-height: 1.35; white-space: normal; }
}
@media ${MQ_COMPACT} {
  #hud .w-group { gap: var(--space-2); }
  #hud .w-btn { padding: var(--space-2) var(--space-3); font-size: var(--font-xxs); }
  #hud-predict .slider-ticks { display: none; }
  /* 幅が足りないので、行2はスクラバーと T+ 読み値だけ残す。 */
  #hud-predict .predict-absolute { display: none; }
  #hud-predict-wrap { left: 8px; right: 8px; bottom: 8px; }
  #hud-predict { max-height: 28vh; max-height: 28dvh; }
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
@media ${MQ_COARSE} {
  #hud-predict-wrap { bottom: 62px; }
}
@media ${MQ_COARSE_SHORT} {
  #hud-stagestatus { max-height: 46px; }
  #navball { top: 60px; width: 72px !important; }
  #hud-predict-wrap { bottom: 52px; }
}
@media ${MQ_SHORT} {
  #hud-stagestatus { max-height: 46px; }
}
`;

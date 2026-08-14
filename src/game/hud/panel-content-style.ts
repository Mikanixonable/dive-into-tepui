// 個々のパネルの中身の CSS: SHIP STATUS/ORBIT/TARGET/CONTACTS の行、軌道オブジェクト一覧、
// 軌道計画、表示設定、表示時刻、カメラ・軌道、艦艇配置、ナビボール、ステージステータス、
// 設定・ヘルプ・終了画面。骨格(層・レール・シェルフ・バッジ)は skeleton-style.ts が持つ。
import * as C from '../const';
import { MQ_COARSE, MQ_COARSE_SHORT, MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT } from './breakpoints';

export const PANEL_CONTENT_STYLE = `
#hud-status h3 { font-size: var(--font-xxs); }
/* 通常のマップビューでは艦固有の情報を右クリックのプロパティウィンドウで参照するので、常設の
   SHIP STATUS は畳んでパネル占有面積を減らす。クリエイティブでは配置後の操作用に表示する。 */
#hud:not(.creative-mode) .hud-map-root.active #hud-status { display: none; }
#hud-orbit h3 { font-size: var(--font-xxs); }
#hud-status .v, #hud-orbit .v { min-width: 75px; }
/* R/F/G/T の代替操作ボタン(タッチ・マウスどちらでも常設)。 */
#hud-status .status-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); }
#hud-status .status-actions .w-btn { font-size: var(--font-xxs); padding: var(--space-2) var(--space-3); }
/* スロットル 1-4 の SegmentedControl。§7-1 の決定によりタッチ UI が出ている間だけ表示する —
   表示条件はタッチパッドの出し入れ(touch.ts の setPointerKind が付ける body.touch-ui-active)と
   同じものに載せ、ここで別の判定を作らない。 */
#hud-status .status-throttle-touch { display: none; margin-top: var(--space-3); }
body.touch-ui-active #hud-status .status-throttle-touch { display: flex; }
#hud .hud-rail-right > #hud-target { width: 100%; box-sizing: border-box; font-size: var(--font-xs); }
#hud .hud-rail-right > #hud-target h3 { font-size: var(--font-xxs); }
#hud-enemies h3 { font-size: var(--font-xxs); }
#hud-enemies .erow { display: flex; justify-content: space-between; gap: var(--space-4); color: var(--text-dim); }
#hud-enemies .erow.tgt { color: var(--accent); }

#hud .hud-rail > #hud-shipplacer { max-height: none; overflow: visible; }
#hud .hud-rail > #hud-plan { width: 100%; min-width: 0; max-width: none; max-height: none; overflow: visible; }
/* MANEUVER PLAN はマップ操作の主パネルとして右レールの最上段に固定する。 */
#hud .hud-rail-right > #hud-plan {
  order: -1;
  align-self: flex-end;
  margin-left: auto;
}

#hud-object-list { max-height: 544px; max-height: min(544px, 60dvh); overflow-y: auto; }
/* パネルの padding 分だけ食い込ませて幅いっぱいに広げ、スクロール中も先頭に張り付かせる */
#hud-object-list .object-list-head { position: sticky; top: calc(var(--space-4) * -1); margin: calc(var(--space-4) * -1) calc(var(--space-5) * -1) 0; padding: var(--space-4) var(--space-5) 0; background: var(--surface-opaque); z-index: 1; }
#hud-object-list .object-list-search { padding: var(--space-1) var(--space-2); }
#hud-object-list .object-list-search .w-input { width: 100%; }
#hud-object-list .object-list-head .w-group { padding: var(--space-1) var(--space-2); }
#hud-object-list .object-list-head .w-btn { font-size: var(--font-xxs); }
#hud-object-list .object-list-collapse {
  margin-left: auto; background: none; border: none; color: var(--text-dim); font: inherit; cursor: pointer; pointer-events: auto;
}
#hud-object-list .object-list-title { display: flex; align-items: center; gap: var(--space-2); }
#hud-object-list .object-list-body.collapsed { display: none !important; }
#hud-object-list .object-list-breadcrumb { padding: var(--space-1) var(--space-3); font-size: var(--font-xxs); color:var(--text-dim); border-bottom:1px solid var(--edge); }
#hud-object-list .object-list-section-header {
  display: block; width: 100%; text-align: left; margin: var(--space-2) 0 var(--space-1);
  padding: var(--space-2) var(--space-4); font-size: var(--font-xs); letter-spacing: 1px;
}
#hud-object-list .object-list-section-body { padding-left: var(--space-2); }
#hud-object-list .object-list-section-body.collapsed { display: none !important; }
#hud-object-list .erow { padding: var(--space-2) var(--space-2); color: var(--text-dim); cursor: pointer; display: flex; align-items: center; gap: var(--space-2); }
#hud-object-list .object-list-detail { margin-left: auto; font-size: var(--font-xxs); color: var(--text-dim); white-space: nowrap; }
#hud-object-list .erow:hover { color: var(--text); }
#hud-object-list .erow.tgt { color: var(--accent); }
#hud-object-list .erow.on { outline: 1px solid var(--edge); color: var(--text); }
#hud-object-list .object-list-toggle { width: 10px; text-align: center; flex: none; }
#hud-object-list .object-list-children { padding-left: var(--space-5); }
#hud-object-list .object-list-children.collapsed { display: none !important; }

#hud-plan { min-width: 0; width: 100%; max-width: 300px; overflow-wrap: anywhere; }
#hud .w-group { margin-bottom: var(--space-3); }
#hud .w-toggle { margin-bottom: var(--space-3); }
/* body-class-row: カテゴリー見出し + アイコン/ラベル/軌道線トグルの1行(太陽系・表示パネル)。
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
#hud .body-class-row.category-off .body-class-icon-btn.disabled { opacity: .35; }
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
  background: var(--surface); color: var(--accent);
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
#hud-predict span.predict-reset:hover { border-color: var(--accent); color: var(--accent); }
#hud-predict .predict-slider-wrap { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; height: 22px; }
#hud-predict input[type="range"] { width: 100%; height: 22px; margin: 0; pointer-events: auto; accent-color: var(--accent); }
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
#hud-predict .predict-value-input input[type="number"] { width: 56px; }
#hud-predict .predict-edit-btn {
  pointer-events: auto; cursor: pointer; padding: var(--space-1) var(--space-3); font-size: var(--font-s);
  border: 1px solid var(--edge); border-radius: var(--radius-m); background: var(--surface); color: var(--text-dim);
}
#hud-predict .predict-edit-btn:hover { border-color: var(--accent); color: var(--accent); }
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
#hud .hud-frame-controls .camera-fov-control {
  display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3);
}
#hud .hud-frame-controls .camera-control-label {
  flex: 0 0 42px; color: var(--text-dim); font-size: var(--font-xs); letter-spacing: 1px;
}
#hud .hud-frame-controls .camera-fov-control .w-slider { flex: 1 1 auto; min-width: 60px; }
#hud .hud-frame-controls .camera-fov-control .w-slider:disabled,
#hud .hud-frame-controls .camera-fov-control .w-input:disabled { opacity: .4; cursor: not-allowed; }
#hud .hud-frame-controls .camera-fov-control .w-input { width: 54px; }
#hud .hud-frame-controls .camera-control-unit { color: var(--text-dim); font-size: var(--font-xs); }
#hud .hud-frame-controls .camera-fov-reset { width: 100%; box-sizing: border-box; margin-bottom: var(--space-3); text-align: center; }
#hud .hud-frame-controls .camera-reference-view-buttons { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); }
#hud .hud-frame-controls .camera-reference-view-buttons .w-btn { flex: 1 1 0; text-align: center; }
#hud-creative-options { width: 100%; pointer-events: auto; }
/* 艦艇配置パネル(クリエイティブモード限定): MANEUVER PLAN の下、右上に縦積みする。 */
#hud-shipplacer { width: 100%; pointer-events: auto; max-height: 70vh; max-height: 70dvh; overflow-y: auto; }
#hud-shipplacer .shipplacer-btn-row { display: flex; gap: var(--space-4); margin-top: var(--space-5); }
#hud-shipplacer .slider-field { margin-bottom: var(--space-4); }
#hud-shipplacer .slider-field .w-group { flex-wrap: nowrap; margin-bottom: 0; }
#hud-shipplacer .slider-field .slider-col { flex: 1 1 60px; min-width: 60px; }
#hud-shipplacer .slider-field input[type="range"] { width: 100%; pointer-events: auto; accent-color: var(--accent); }
#hud-shipplacer .slider-field .slider-ticks { display: flex; justify-content: space-between; margin-top: var(--space-1); }
#hud-shipplacer .slider-field .slider-ticks span { flex: 0 1 auto; min-width: 0; font-size: var(--font-xxs); color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#hud-shipplacer .slider-field .slider-ticks span:first-child { text-align: left; }
#hud-shipplacer .slider-field .slider-ticks span:last-child { text-align: right; }
#hud-shipplacer input[type="text"] { flex: 1; width: auto; }
#hud-shipplacer .preset-row { flex-wrap: wrap; gap: var(--space-3); }
#hud-shipplacer .field-issue { border: 1px solid var(--danger); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); }
#hud-shipplacer .issue-list { margin: var(--space-4) 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--danger); border-radius: var(--radius-s); background: var(--danger-fill); }
#hud-shipplacer .issue-list .issue-line { font-size: var(--font-s); color: var(--danger); }
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
#hud-result.win h1 { color: var(--text); text-shadow: 0 0 18px color-mix(in srgb, var(--text) var(--glow-weak), transparent); }
#hud-result.lose h1 { color: var(--accent); text-shadow: 0 0 18px color-mix(in srgb, var(--accent) var(--glow-strong), transparent); }
#hud-result .detail {
  font-size: var(--font-xl); line-height: 2; color: var(--text);
  background: var(--surface); border: 1px solid var(--edge); border-radius: var(--radius-m); padding: var(--space-6) var(--space-6);
}
#hud-result .restart { margin-top: var(--space-6); color: var(--accent-soft); font-size: var(--font-l); }
#hud-help {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  display: none; min-width: min(480px, calc(100vw - 24px)); max-height: 86vh; max-height: 86dvh; overflow-y: auto; pointer-events: auto;
}
#hud-help table { border-collapse: collapse; width: 100%; }
#hud-help td { padding: var(--space-2) var(--space-5); color: var(--text); }
#hud-help td.key { color: var(--accent-soft); text-align: right; white-space: nowrap; }

#hud-stagestatus {
  bottom: calc(12px + var(--safe-b)); left: 50%; transform: translateX(-50%);
  display: flex; align-items: flex-start; gap: var(--space-6);
  text-align: left; min-width: 480px; padding: var(--space-4) var(--space-6);
}
#hud-stagestatus .t {
  font-size: var(--font-s); letter-spacing: 2px; color: var(--text); font-variant-numeric: tabular-nums;
  display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-4); align-items: center;
}
#hud-stagestatus .t.warn { color: var(--accent); }
#hud-stagestatus .t .w-meter { width: 160px; }
#hud-stagestatus .k { font-size: var(--font-s); color: var(--text-dim); line-height: 1.8; white-space: nowrap; }
#hud-stagestatus .k-widgets:not(:empty) { margin-top: var(--space-3); }
#hud-stagestatus .radiators { display: flex; flex-direction: column; gap: var(--space-3); }
/* span. まで指定して .w-btn 側の padding より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#hud-stagestatus span.radiator-btn {
  position: relative; overflow: hidden; width: 132px; padding: var(--space-2) var(--space-4); text-align: left;
}
#hud-stagestatus .radiator-btn .fill {
  position: absolute; inset: 0; z-index: 0; transition: width var(--transition-fast), background var(--transition-fast);
}
#hud-stagestatus .radiator-btn .label {
  position: relative; z-index: 1; color: var(--text); font-size: var(--font-xs); line-height: 1.5;
  text-shadow: 0 0 3px var(--bg), 0 0 3px var(--bg); transition: color var(--transition-fast);
}
#hud-stagestatus .radiator-btn.on { border-color: var(--accent); }
#hud-stagestatus .radiator-btn.on .label { color: var(--accent); }
#hud-pause-menu {
  position: absolute; bottom: 40px; top: auto; left: 50%; transform: translateX(-50%);
  display: none; min-width: 260px; pointer-events: auto;
}
#hud-pause-menu .pm-row {
  display: flex; justify-content: space-between; align-items: center; gap: var(--space-6); padding: var(--space-3) 0;
}
#hud-pause-menu .pm-theme-row { align-items: center; }
#hud-pause-menu .pm-theme-preview { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 3px; }
#hud-pause-menu .pm-theme-swatch { width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 0 1px color-mix(in srgb, var(--title) 24%, transparent); }
#hud-pause-menu .pm-theme-select { flex: 1 1 180px; min-width: 0; color-scheme: var(--theme-tone); }
/* span. まで指定して .w-btn 側の padding/font-size より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#hud-pause-menu span.pm-quit { margin-top: var(--space-5); text-align: center; padding: var(--space-4) var(--space-5); font-size: var(--font-m); }
#hud-pause-menu .pm-close-row { margin-top: var(--space-5); text-align: center; }
#hud-pause-menu .w-tabs { margin-bottom: var(--space-4); }
#hud-pause-menu .gp-body { display: flex; flex-direction: column; gap: var(--space-4); }

@media ${MQ_MEDIUM_DOWN} {
  #hud-plan { min-width: 0; max-width: none; }
  #hud-help { min-width: 0; width: 94vw; max-height: 78vh; max-height: 78dvh; }
  #hud-result h1 { font-size: var(--font-2xl); letter-spacing: 3px; }
  #hud-result .detail { font-size: var(--font-l); padding: var(--space-5) var(--space-6); max-width: 92vw; }
  #navball { top: 76px; width: 96px !important; height: auto !important; }
  #hud-pause-menu { min-width: 0; width: 78vw; }
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

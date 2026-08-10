// HUD の静的 DOM/スタイル構築。
import * as C from '../const';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { ACCENT, ACCENT_SOFT, ACCENT_RGB, ACCENT_SECONDARY, WARNING, SURFACE, SURFACE_OPAQUE, EDGE, BG, TEXT as INK, TEXT_DIM as INK_SOFT, FONT } from '../theme';
import { buildOverlayLayers, OVERLAY_LAYER_STYLE, type OverlayLayers } from './overlay-layer';
import { ModalController } from './modal-controller';


const throttleKeyLabels = [K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax].map((k) => k.label).join(' / ');

const STYLE = `
#hud, #hud * { box-sizing: border-box; margin: 0; padding: 0; }
#hud {
  position: fixed; inset: 0; pointer-events: none; overflow: hidden;
  font-family: ${FONT};
  /* body 直下の他要素(タッチ操作パッド・天球グリッドのラベル層)との前後関係を決める。
     #hud の内側の重なり順は overlay-layer.ts のレイヤが持つ。 */
  color: ${INK}; user-select: text; z-index: 10;
  font-size: 13px;
}
/* 読み取りたい数値は選択できるようにするが、操作部品とマーカーは対象外にする —
   ボタンの連打やカメラドラッグのたびにラベルが選択されると操作の邪魔になる。 */
#hud .seg-btn, #hud .hold-btn, #hud .hud-toggle, #hud .ctx-menu-item,
#hud .mk, #hud .dock-toggle, #hud-chase-reset, #hud-viewbadge .vb-view-btn { user-select: none; }
${OVERLAY_LAYER_STYLE}
/* #hud 直下の兄弟同士の重なり順は overlay-layer.ts のレイヤが持つ。
   マーカー内優先度: 宇宙船(4) > 敵(3) > 弾薬(2) > 軌道要素・その他(1) > デフォルト(0) */
/* スクロール可能な領域は既定のブラウザ配色ではダークテーマと調和しないため、
   パネルの縁色・アクセント色に揃える。 */
#hud, #hud * { scrollbar-color: ${EDGE} transparent; }
#hud ::-webkit-scrollbar { width: 8px; height: 8px; }
#hud ::-webkit-scrollbar-track { background: transparent; }
#hud ::-webkit-scrollbar-thumb { background: ${EDGE}; border-radius: 4px; }
#hud ::-webkit-scrollbar-thumb:hover { background: ${ACCENT_SOFT}; }
#hud .mk { z-index: 0; }
#hud .mk-node, #hud .mk-mnode, #hud .mk-burn, #hud .mk-poi, #hud .mk-base, #hud .mk-nav, #hud .mk-dir, #hud .mk-boardpass, #hud .mk-lead, #hud .mk-pro, #hud .mk-retro, #hud .mk-nrm, #hud .mk-rad, #hud .mk-tgtdir, #hud .mk-boresight { z-index: 1; }
#hud .mk-ammo { z-index: 2; }
#hud .mk-enemy, #hud .mk-target, #hud .mk-secondary-target { z-index: 3; }
#hud .mk-self { z-index: 4; }
#hud-modal-shield { display: none; position: absolute; inset: 0; pointer-events: none; background: rgba(6,7,9,.3); }
body.hud-modal-open #hud-modal-shield { display: block; }
body.hud-modal-open #touch-ui { display: none; }
#hud .panel {
  position: absolute; background: ${SURFACE};
  border: 1px solid ${EDGE}; border-radius: 6px;
  padding: 9px 12px; line-height: 1.5; backdrop-filter: blur(4px);
}
/* マップ系パネルは左右のドック内で通常フローに積む。内容が増えても他の
   パネルを押し退けるだけで、固定座標による重なりを起こさない。 */
#hud .hud-dock {
  position: absolute; top: 40px; bottom: 12px;
  display: flex; flex-direction: column; align-items: stretch; gap: 8px;
  pointer-events: none; min-height: 0; overflow-x: hidden; overflow-y: auto;
  scrollbar-width: thin; overscroll-behavior: contain;
}
#hud .hud-dock > .panel { position: relative; inset: auto; transform: none; pointer-events: auto; flex: 0 0 auto; }
#hud .hud-dock-left { left: 12px; width: min(300px, 30vw); }
#hud .hud-dock-right { right: 12px; width: min(300px, 33vw); }
#hud .hud-dock > .panel[style*="display: none"] { display: none !important; }
#hud .dock-toggle {
  display: none; position: absolute; top: 8px; z-index: 20; pointer-events: auto;
  width: 26px; height: 26px; border: 1px solid ${EDGE}; border-radius: 4px;
  background: ${SURFACE}; color: ${ACCENT}; cursor: pointer;
}
#hud.map-mode .dock-toggle { display: block; }
#hud #hud-dock-toggle-left { left: 8px; }
#hud #hud-dock-toggle-right { right: 8px; }
#hud .hud-dock.collapsed { width: 0; }
#hud .hud-dock.collapsed > .panel { display: none !important; }
#hud .hud-dock > #hud-shipplacer { max-height: none; overflow: visible; }
#hud .hud-dock > #hud-plan { width: 100%; min-width: 0; max-width: none; max-height: none; overflow: visible; }
/* MANEUVER PLAN はマップ操作の主パネルとして右ドックの最上段に固定する。 */
#hud .hud-dock-right > #hud-plan {
  order: -1;
  align-self: flex-end;
  margin-left: auto;
}
#hud .panel h3 {
  font-size: 11px; letter-spacing: 2.5px; color: ${ACCENT};
  border-bottom: 1px solid rgba(${ACCENT_RGB}, 0.25); margin-bottom: 6px; padding-bottom: 4px;
  font-weight: 600;
}
/* マップモードでは #hud-dock-toggle-right(right:8px, 26px 角)がこの位置に重なるので、
   その右端(8+26=34px)より確実に外側へ避けておく。 */
#hud-viewbadge {
  position: absolute; top: 8px; right: 44px;
  display: flex; align-items: center; gap: 6px;
  color: ${INK_SOFT}; font-size: 9px; letter-spacing: 1.2px;
  white-space: nowrap; opacity: 0.9;
}
#hud-viewbadge .vb-title { color: ${ACCENT}; }
#hud-viewbadge .vb-mode { color: ${INK_SOFT}; }
#hud-viewbadge .vb-view-btn {
  pointer-events: auto; cursor: pointer; background: transparent;
  border: 1px solid ${EDGE}; border-radius: 4px; padding: 2px 6px;
  color: ${INK_SOFT}; font: inherit; letter-spacing: inherit;
}
#hud-viewbadge .vb-view-btn:hover { color: ${INK}; border-color: ${ACCENT_SOFT}; }
#hud-globalstatus {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  pointer-events: auto;
  padding: 4px 14px; border-radius: 0 0 6px 6px;
  background: ${SURFACE}; border: 1px solid ${EDGE}; border-top: none; backdrop-filter: blur(4px);
  font-size: 11px; letter-spacing: 1px; font-variant-numeric: tabular-nums;
  color: ${INK_SOFT};
  display: flex; align-items: center; gap: 8px; white-space: nowrap;
}
#hud-globalstatus .v { color: ${INK}; }
#hud-globalstatus .gs-sep { color: ${EDGE}; }
#hud .row { display: flex; justify-content: space-between; gap: 12px; }
#hud .row .k { color: ${INK_SOFT}; }
#hud .row .v { color: ${INK}; min-width: 90px; text-align: right; }
#hud-status { bottom: 12px; left: 12px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-status h3 { font-size: 8.8px; }
/* マップビューでは艦固有の情報を右クリックのプロパティウィンドウで参照するので、常設の
   SHIP STATUS は畳んでパネル占有面積を減らす。戦闘ビューでは従来どおり常設のまま。 */
#hud.map-mode #hud-status { display: none; }
#hud-orbit { bottom: 12px; left: 252px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-orbit h3 { font-size: 8.8px; }
#hud.map-mode #hud-orbit { font-size: inherit; }
#hud.map-mode #hud-orbit h3 { font-size: 11px; }
#hud-status .v, #hud-orbit .v { min-width: 75px; }
#hud .hud-dock-right > #hud-target { width: 100%; box-sizing: border-box; font-size: 10.4px; }
#hud .hud-dock-right > #hud-target h3 { font-size: 8.8px; }
#hud-enemies { bottom: 12px; right: 12px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-enemies h3 { font-size: 8.8px; }
#hud-enemies .erow { display: flex; justify-content: space-between; gap: 8px; color: ${INK_SOFT}; }
#hud-enemies .erow.tgt { color: ${WARNING}; }
#hud-map-scale {
  position: absolute; right: 12px; bottom: 12px; display: none; pointer-events: none;
  padding: 4px 7px 5px; border: 1px solid ${EDGE}; border-radius: 4px;
  background: ${SURFACE}; color: ${INK_SOFT}; font-size: 9px; line-height: 1.1;
  font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap;
}
#hud-map-scale .map-scale-value { color: ${INK}; }
#hud-map-scale .map-scale-ruler { position: relative; height: 10px; margin-top: 2px; margin-left: auto; }
#hud-map-scale .map-scale-ruler::before {
  content: ''; position: absolute; left: 0; right: 0; top: 5px; border-top: 1px solid ${INK_SOFT};
}
#hud-map-scale .map-scale-tick {
  position: absolute; top: 1px; height: 9px; border-left: 1px solid ${INK};
}
#hud-map-scale .map-scale-tick.start { left: 0; }
#hud-map-scale .map-scale-tick.q1 { left: 25%; }
#hud-map-scale .map-scale-tick.mid { left: 50%; }
#hud-map-scale .map-scale-tick.q3 { left: 75%; }
#hud-map-scale .map-scale-tick.end { right: 0; }
#hud-object-list { max-height: 544px; overflow-y: auto; }
/* パネルの padding 分だけ食い込ませて幅いっぱいに広げ、スクロール中も先頭に張り付かせる */
#hud-object-list .object-list-head { position: sticky; top: -9px; margin: -9px -12px 0; padding: 9px 12px 0; background: ${SURFACE_OPAQUE}; z-index: 1; }
#hud-object-list .object-list-search { padding:2px 4px; }
#hud-object-list .object-list-search input { width:100%; box-sizing:border-box; background:${SURFACE}; color:${INK}; border:1px solid ${EDGE}; font:inherit; }
#hud-object-list .object-list-tools { display:flex; gap:3px; flex-wrap:wrap; padding:2px 4px; }
#hud-object-list .object-list-tools button {
  font-size:8px; padding:2px 4px; border:1px solid ${EDGE}; border-radius:4px;
  background:${SURFACE}; color:${INK_SOFT};
}
#hud-object-list .object-list-tools button[aria-pressed="true"] { color:${ACCENT}; border-color:${ACCENT}; }
#hud-object-list .object-list-breadcrumb { padding:2px 5px; font-size:8px; color:${INK_SOFT}; border-bottom:1px solid ${EDGE}; }
#hud-object-list .object-list-section-header {
  display: block; width: 100%; text-align: left; margin: 4px 0 2px;
  padding: 3px 8px; font-size: 10px; letter-spacing: 1px;
}
#hud-object-list .object-list-section-body { padding-left: 4px; }
#hud-object-list .erow { padding: 3px 4px; color: ${INK_SOFT}; cursor: pointer; display: flex; align-items: center; gap: 4px; }
#hud-object-list .object-list-detail { margin-left: auto; font-size: 8px; color: ${INK_SOFT}; white-space: nowrap; }
#hud-object-list .erow:hover { color: ${INK}; }
#hud-object-list .erow.tgt { color: ${ACCENT}; }
#hud-object-list .erow.selected { outline: 1px solid ${EDGE}; color: ${INK}; }
#hud-object-list .object-list-toggle { width: 10px; text-align: center; flex: none; }
#hud-object-list .object-list-children { padding-left: 12px; }
#hud-combat-shelf { display: contents; }

#hud-hint {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  background: ${SURFACE}; border: 1px solid rgba(${ACCENT_RGB}, 0.35); border-radius: 4px;
  padding: 8px 18px;
  color: ${ACCENT_SOFT}; font-size: 14px;
  transition: opacity 0.4s; opacity: 0; text-align: center;
}
#hud-chase-reset {
  position: absolute; top: 40px; left: 50%; transform: translateX(-50%);
  pointer-events: auto; cursor: pointer;
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; justify-content: center; align-items: center;
  padding: 0;
  border: 1px solid ${EDGE}; background: ${SURFACE}; color: ${INK_SOFT};
}
#hud-chase-reset:hover { border-color: ${ACCENT}; color: ${ACCENT}; }
#hud-toast {
  position: absolute; top: 18%; left: 50%; transform: translateX(-50%);
  background: ${SURFACE}; border: 1px solid ${EDGE}; border-radius: 4px; padding: 14px 26px;
  color: ${INK}; font-size: 15px; text-align: center;
  transition: opacity 1s; opacity: 0; line-height: 1.8;
}
#hud .sim-speed-hot { color: ${ACCENT}; }
#hud .mode-tgt { color: ${WARNING}; }
.mk {
  position: absolute; transform: translate(-50%, -50%);
  text-align: center; white-space: nowrap; text-shadow: 0 0 4px #000, 0 0 2px #000;
  width: 24px; height: 24px;
}
.mk .sym { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 22px; line-height: 1; }
.mk .lbl { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); font-size: 10px; letter-spacing: 1px; }
#hud .mk .lbl { margin-top: 2px; }
.mk-enemy .lbl, .mk-target .lbl { font-size: 9px; line-height: 1.2; white-space: pre; }
.mk-dir { color: #ffffff; font-size: 11px; text-shadow: none; }
.mk-boresight { color: #ffffff; font-size: 36px; }
#mk-bore .sym { width: 48px; height: 48px; }
#mk-bore .lbl { top: -14px; left: 19px; transform: none; font-size: 8px; letter-spacing: .4px; color: ${INK_SOFT}; text-shadow: 0 0 3px #000; }
.mk-target { color: #ffffff; }
.mk-secondary-target { color: ${ACCENT_SECONDARY}; }
.mk-enemy { color: #ffffff; }
.mk-lead { color: ${WARNING}; }
.mk-pro { color: ${C.COLOR_MARKER_PROGRADE}; }
.mk-retro { color: ${C.COLOR_MARKER_PROGRADE}; }
.mk-nrm { color: ${C.COLOR_MARKER_NORMAL}; }
.mk-rad { color: ${C.COLOR_MARKER_RADIAL}; }
.mk-tgtdir { color: ${C.COLOR_MARKER_TGTDIR}; }
.mk-node { color: ${C.COLOR_MARKER_NODE}; }
.mk-boardpass { color: ${C.COLOR_MARKER_BOARDPASS}; text-shadow: 0 0 5px rgba(255,255,255,0.9), 0 0 10px rgba(255,255,255,0.45); }
.mk-boardpass .sym { font-size: 8px; }
.mk-mnode { color: ${ACCENT_SOFT}; }
.mk-mnode .lbl { white-space: pre; line-height: 1.25; }
.mk-burn { color: ${ACCENT}; text-shadow: 0 0 8px rgba(${ACCENT_RGB}, 0.7); }
.mk-self { color: ${C.COLOR_MARKER_SELF}; }
.mk-ammo { color: ${ACCENT_SOFT}; text-shadow: 0 0 6px rgba(255,144,64,0.6), 0 0 3px #000; }
#hud .warn-hot { color: ${WARNING}; }
#hud-plan { min-width: 0; width: 100%; max-width: 300px; overflow-wrap: anywhere; }
#hud .hud-seg { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
#hud .hud-seg .seg-title { font-size: 10px; letter-spacing: 1px; color: ${INK_SOFT}; min-width: 28px; }
#hud .seg-btn {
  pointer-events: auto; cursor: pointer; padding: 3px 10px; font-size: 11px;
  border: 1px solid ${EDGE}; border-radius: 6px; background: ${SURFACE}; color: ${INK_SOFT};
  line-height: 1.2;
}
#hud .seg-btn.on { border-color: ${ACCENT}; color: ${ACCENT}; }
#hud .seg-btn.disabled { opacity: 0.35; pointer-events: none; }
#hud .seg-btn.hold-btn:active { border-color: ${ACCENT}; color: ${ACCENT}; background: rgba(${ACCENT_RGB}, 0.16); }
#hud .icon-toggle-btn { min-width: 20px; padding: 3px 6px; text-align: center; font-size: 12px; }
#hud .body-class-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
#hud .body-class-row .body-class-title { width: 96px; min-width: 96px; text-align: left; font-size: 10px; letter-spacing: 1px; }
#hud .body-class-row .body-class-btns { display: flex; gap: 4px; }
#hud .body-class-row.category-off .icon-toggle-btn.on { border-color: ${EDGE}; color: ${INK_SOFT}; font-weight: 700; opacity: .65; }
#hud .body-class-row.category-off .icon-toggle-btn.disabled { opacity: .35; }
#hud .category-toggle-btn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#hud .hud-toggle { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
#hud .hud-toggle .toggle-title { font-size: 10px; letter-spacing: 1px; color: ${INK_SOFT}; }
#hud .hud-toggle .toggle-track {
  pointer-events: auto; cursor: pointer; position: relative; display: inline-block;
  width: 34px; height: 18px; border-radius: 9px; border: 1px solid ${EDGE};
  background: ${SURFACE}; transition: border-color 0.15s, background 0.15s;
}
#hud .hud-toggle .toggle-track.on { border-color: ${ACCENT}; background: rgba(${ACCENT_RGB}, 0.25); }
#hud .hud-toggle .toggle-knob {
  position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
  background: ${INK_SOFT}; transition: left 0.15s, background 0.15s;
}
#hud .hud-toggle .toggle-track.on .toggle-knob { left: 18px; background: ${ACCENT}; }
/* MAP VIEW の左列は navball ウィンドウの右に置き、重なりを避ける。 */
#hud-overview-camera { display: none; width: 100%; pointer-events: auto; }
/* 下部の固定バーとその開閉トグル。両者を縦積みの flex にして画面下端に揃え、パネルを畳んでも
   トグルだけがその場(バーがあった位置の上端)に残るようにする。マップビューでは
   #hud-stagestatus は常に非表示なので、他の下端揃えパネル(.hud-dock 等)と同じ bottom まで詰める。
   左右ドック(.hud-dock-left/.hud-dock-right)の内側に収まる幅だけを使い、ドックのパネルに重ねない。 */
#hud-displaytime-wrap {
  position: absolute; bottom: 12px;
  left: calc(12px + min(300px, 30vw) + 8px); right: calc(12px + min(300px, 33vw) + 8px);
  display: flex; flex-direction: column; gap: 4px; pointer-events: none;
}
/* #hud を重ねた ID セレクタで、.panel 共通規則(position:absolute)より詳細度を上げて打ち消す。 */
#hud #hud-displaytime {
  display: none; position: relative; inset: auto; order: 2; box-sizing: border-box;
  max-height: 40vh; overflow-y: auto; pointer-events: auto;
}
#hud-displaytime.collapsed { display: none !important; }
#hud-displaytime-toggle {
  display: none; order: 1; align-self: center; pointer-events: auto; cursor: pointer;
  width: 26px; height: 26px; border: 1px solid ${EDGE}; border-radius: 4px;
  background: ${SURFACE}; color: ${ACCENT};
}
#hud.map-mode #hud-displaytime-toggle { display: block; }
#hud.dock-mode #hud-displaytime-toggle { display: none; }
#hud-displaytime input[type="range"] { width: 100%; pointer-events: auto; accent-color: ${ACCENT}; }
/* パネル内の数値・テキスト入力欄の共通見た目(スライダーは上の range 規則が受け持つ)。 */
#hud .panel input[type="number"], #hud .panel input[type="text"] {
  pointer-events: auto; width: 64px; padding: 3px 6px; font-size: 11px;
  border: 1px solid ${EDGE}; border-radius: 6px; background: ${SURFACE}; color: ${INK};
}
#hud .settings-btn {
  pointer-events: auto; cursor: pointer; padding: 4px 8px; font-size: 11px;
  border: 1px solid ${EDGE}; border-radius: 4px; background: ${SURFACE}; color: ${INK};
}
#hud .settings-btn:hover { background: rgba(255, 255, 255, 0.05); }
#hud .settings-btn:active { background: rgba(255, 255, 255, 0.1); border-color: ${ACCENT_SOFT}; }
#hud-displaytime .slider-ticks { position: relative; height: 11px; margin-top: 2px; }
#hud-displaytime .slider-ticks span {
  position: absolute; transform: translateX(-50%);
  font-size: 9px; color: ${INK_SOFT}; white-space: nowrap;
}
#hud-displaytime .slider-ticks span:first-child { transform: none; }
#hud-displaytime .slider-ticks span:last-child { transform: translateX(-100%); }
#hud-displaytime .slider-label { font-size: 11px; color: ${INK_SOFT}; margin-top: 4px; text-align: center; }
#hud-frame-controls { display: none; width: 100%; pointer-events: auto; }
#hud-frame-controls .hud-frame-scroll-zone {
  max-height: min(240px, 30vh); overflow-y: auto;
  scrollbar-width: thin; overscroll-behavior-y: contain;
}
/* 座標系の候補が増えても、見出しの右側へボタンを押し出さない。 */
#hud-frame-controls .hud-frame-origin-zone > .hud-seg:first-child > .seg-title,
#hud-frame-controls .hud-frame-rotation-zone > .seg-title {
  flex: 0 0 100%; min-width: 0;
}
#hud-creative-logistics { display: none; width: 100%; pointer-events: auto; }
/* 艦艇配置パネル(クリエイティブモード限定): MANEUVER PLAN の下、右上に縦積みする。 */
#hud-shipplacer { display: none; width: 100%; pointer-events: auto; max-height: 70vh; overflow-y: auto; }
#hud-shipplacer .slider-field { margin-bottom: 8px; }
#hud-shipplacer .slider-field .hud-seg { flex-wrap: nowrap; margin-bottom: 0; }
#hud-shipplacer .slider-field .slider-col { flex: 1 1 60px; min-width: 60px; }
#hud-shipplacer .slider-field input[type="range"] { width: 100%; pointer-events: auto; accent-color: ${ACCENT}; }
#hud-shipplacer .slider-field .slider-ticks { display: flex; justify-content: space-between; margin-top: 2px; }
#hud-shipplacer .slider-field .slider-ticks span { flex: 0 1 auto; min-width: 0; font-size: 9px; color: ${INK_SOFT}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#hud-shipplacer .slider-field .slider-ticks span:first-child { text-align: left; }
#hud-shipplacer .slider-field .slider-ticks span:last-child { text-align: right; }
#hud-shipplacer input[type="text"] { flex: 1; width: auto; }
#hud-shipplacer .preset-row { flex-wrap: wrap; gap: 6px; }
#hud-shipplacer .field-issue { border: 1px solid ${WARNING}; border-radius: 3px; padding: 2px 4px; }
#hud-shipplacer .issue-list { margin: 8px 0; padding: 6px 8px; border: 1px solid ${WARNING}; border-radius: 3px; background: rgba(255,79,94,0.08); }
#hud-shipplacer .issue-list .issue-line { font-size: 11px; color: ${WARNING}; }
#navball { top: 12px; left: 12px; width: 190px; pointer-events: auto; }
#navball .nb-ball { display: block; width: 100%; height: auto; margin: 4px 0 8px; }
#navball .nb-rim { fill: rgba(255, 255, 255, 0.03); stroke: ${EDGE}; stroke-width: 1; }
#navball .nb-grid { fill: none; stroke: ${INK_SOFT}; stroke-width: 0.6; opacity: 0.35; }
#navball .nb-equator { fill: none; stroke: ${INK_SOFT}; stroke-width: 0.9; opacity: 0.55; }
#navball .nb-bore line { stroke: ${C.COLOR_MARKER_BORESIGHT}; stroke-width: 1; opacity: 0.8; }
#navball text { font-size: 9px; text-anchor: middle; dominant-baseline: middle; }
#navball .nb-pro { fill: ${C.COLOR_MARKER_PROGRADE}; }
#navball .nb-nrm { fill: ${C.COLOR_MARKER_NORMAL}; }
#navball .nb-rad { fill: ${C.COLOR_MARKER_RADIAL}; }
#mk-bore .lbl { top: auto; left: 100%; bottom: 100%; margin: 0 0 2px 5px; white-space: pre; text-align: left; font-size: 9px; line-height: 1.2; }
.mk-planned { color: ${C.COLOR_MARKER_PLANNED}; text-shadow: 0 0 6px rgba(143,208,255,0.6), 0 0 3px #000; }
.mk-apsis { color: ${C.COLOR_MARKER_PLANNED}; text-shadow: 0 0 6px rgba(143,208,255,0.6), 0 0 3px #000; }
.mk-impact { color: ${WARNING}; text-shadow: 0 0 6px rgba(255,79,94,0.6), 0 0 3px #000; }
.mk-plantick { color: ${INK_SOFT}; }
.mk-plantick .sym svg { display: block; }
.mk-poi { color: #ffffff; text-shadow: 0 0 4px #000; }
.mk-poi .sym { font-size: 5px; }
.mk-poi .lbl { font-size: 11px; border-radius: 2px; background: rgba(13,15,18,0.6); }
.mk-base { color: ${C.COLOR_BASE_ORBIT_LINE}; text-shadow: 0 0 4px #000; }
.mk-base .lbl { font-size: 11px; border-radius: 2px; background: rgba(13,15,18,0.6); border: 1px solid rgba(255,255,255,0.2); }
#hud .mk-poi .lbl, #hud .mk-base .lbl { margin-top: 4px; padding: 2px 4px; }
#hud-end {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  background: rgba(6, 7, 9, 0.82); backdrop-filter: blur(3px);
  flex-direction: column; text-align: center;
}
#hud-end h1 { font-size: 34px; letter-spacing: 6px; margin-bottom: 18px; }
#hud-end.win h1 { color: ${INK}; text-shadow: 0 0 18px rgba(230,232,235,0.35); }
#hud-end.lose h1 { color: ${ACCENT}; text-shadow: 0 0 18px rgba(${ACCENT_RGB}, 0.4); }
#hud-end .detail {
  font-size: 15px; line-height: 2; color: ${INK};
  background: ${SURFACE}; border: 1px solid ${EDGE}; border-radius: 4px; padding: 18px 30px;
}
#hud-end .restart { margin-top: 22px; color: ${ACCENT_SOFT}; font-size: 13px; }
#hud-help {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  display: none; min-width: 480px; max-height: 86vh; overflow-y: auto; pointer-events: auto;
}
#hud-help table { border-collapse: collapse; width: 100%; }
#hud-help td { padding: 3px 10px; color: ${INK}; }
#hud-help td.key { color: ${ACCENT_SOFT}; text-align: right; white-space: nowrap; }

#hud-stagestatus {
  bottom: 12px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: flex-start; gap: 22px;
  text-align: left; min-width: 480px; padding: 8px 16px;
}
#hud-stagestatus .t { font-size: 11px; letter-spacing: 2px; color: ${INK}; font-variant-numeric: tabular-nums; }
#hud-stagestatus .t.warn { color: ${ACCENT}; }
#hud-stagestatus .k { font-size: 11px; color: ${INK_SOFT}; line-height: 1.8; white-space: nowrap; }
#hud-stagestatus .k-widgets:not(:empty) { margin-top: 6px; }
#hud-stagestatus .radiators { display: flex; flex-direction: column; gap: 6px; }
#hud-stagestatus .radiator-btn {
  pointer-events: auto; cursor: pointer; position: relative; overflow: hidden;
  width: 132px; padding: 4px 8px; border: 1px solid ${EDGE}; border-radius: 4px;
  background: ${SURFACE}; text-align: left;
}
#hud-stagestatus .radiator-btn .fill {
  position: absolute; inset: 0; z-index: 0; transition: width 0.2s, background 0.2s;
}
#hud-stagestatus .radiator-btn .label {
  position: relative; z-index: 1; color: ${INK}; font-size: 10px; line-height: 1.5;
  text-shadow: 0 0 3px #000, 0 0 3px #000; transition: color 0.2s;
}
#hud-stagestatus .radiator-btn.on { border-color: ${ACCENT}; }
#hud-stagestatus .radiator-btn.on .label { color: ${ACCENT}; }
#hud-settings {
  position: absolute; bottom: 40px; top: auto; left: 50%; transform: translateX(-50%);
  display: none; min-width: 260px; pointer-events: auto;
}
#hud-settings .srow {
  display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 6px 0;
}
#hud-settings .stoggle {
  pointer-events: auto; cursor: pointer; padding: 4px 16px; min-width: 46px; text-align: center;
  border: 1px solid ${EDGE}; border-radius: 4px; background: ${SURFACE}; color: ${INK_SOFT};
}
#hud-settings .stoggle.on { border-color: ${ACCENT}; color: ${ACCENT}; }
#hud-settings .squit {
  margin-top: 14px; text-align: center; padding: 8px 10px; cursor: pointer;
  border: 1px solid ${EDGE}; border-radius: 4px; background: ${SURFACE}; color: ${INK_SOFT}; font-size: 12px;
}
#hud-settings .squit:hover { border-color: ${ACCENT}; color: ${ACCENT}; }
#hud-settings .sclose {
  margin-top: 10px; text-align: center; color: ${INK_SOFT}; font-size: 11px; cursor: pointer;
}

/* --- モバイル / 狭幅画面: パネルを縮小してタッチパッドと共存させる --- */
@media (max-width: 900px), (pointer: coarse) {
  #hud { font-size: 11px; }
  #hud .panel { padding: 6px 8px; line-height: 1.4; }
  #hud .panel h3 { font-size: 10px; letter-spacing: 1.5px; margin-bottom: 4px; }
  #hud.map-mode #hud-orbit h3 { font-size: 10px; }
  #hud .row { gap: 8px; }
  #hud .row .v { min-width: 64px; }
  #hud-combat-shelf {
    position: absolute; display: flex; left: 8px; right: 8px; top: 76px;
    gap: 6px; overflow-x: auto; overflow-y: hidden; pointer-events: auto;
    scrollbar-width: thin; overscroll-behavior-x: contain; z-index: 1;
  }
  #hud-combat-shelf > .panel {
    position: relative; inset: auto; transform: none; flex: 0 0 178px;
    width: 178px; min-width: 0; max-height: 116px; overflow-y: auto;
  }
  #hud-status, #hud-orbit, #hud-target, #hud-enemies { top: auto; right: auto; bottom: auto; left: auto; }
  #hud:not(.map-mode) #hud-viewbadge { display: none; }
  #hud-controls { display: none; }
  #hud-hint { bottom: auto; top: 26%; max-width: 92vw; white-space: normal; }
  #hud-toast { max-width: 92vw; padding: 10px 14px; font-size: 13px; }
  #hud .hud-dock { top: 8px; bottom: 8px; gap: 6px; }
  #hud .hud-dock-left { left: 8px; width: min(220px, calc(46vw - 8px)); }
  #hud .hud-dock-right { right: 8px; width: min(260px, calc(54vw - 8px)); }
  #hud-plan { min-width: 0; max-width: none; }
  #hud-help { min-width: 0; width: 94vw; max-height: 78vh; }
  #hud-end h1 { font-size: 24px; letter-spacing: 3px; }
  #hud-end .detail { font-size: 13px; padding: 12px 18px; max-width: 92vw; }
  #navball { top: 76px; width: 96px !important; height: auto !important; }
  #navball .hud-seg, #navball .hud-toggle { display: none; }
  #hud-hint {
    top: calc(50% - 40px); transform: translateX(-50%); max-height: 72px;
    overflow-y: auto; padding: 6px 10px; font-size: 11px;
  }
  #hud-settings { min-width: 0; width: 78vw; }
  #hud-stagestatus { bottom: 8px; width: min(62vw, 440px); min-width: 0; max-height: 62px; overflow-y: auto; padding: 6px 10px; gap: 8px; }
  /* このブレークポイントのドック幅に合わせて左右の隙間を再計算する。 */
  #hud-displaytime-wrap {
    bottom: 8px;
    left: calc(8px + min(220px, calc(46vw - 8px)) + 8px); right: calc(8px + min(260px, calc(54vw - 8px)) + 8px);
  }
  #hud-stagestatus .t { font-size: 11px; }
  #hud-stagestatus .k { font-size: 9px; line-height: 1.35; white-space: normal; }
  #hud-chase-reset { top: 40px; width: 28px; height: 28px; }
  #hud-chase-reset svg { width: 14px; height: 14px; }
  #hud-map-scale { right: 8px; bottom: 8px; font-size: 8px; }
  #hud .hud-dock { top: 40px; }
}
@media (max-width: 520px) {
  #hud .hud-dock { font-size: 9px; }
  #hud .hud-dock-left { width: calc(44vw - 8px); }
  #hud .hud-dock-right { width: calc(56vw - 8px); }
  #hud .hud-seg { gap: 3px; }
  #hud .seg-btn { padding: 3px 5px; font-size: 9px; }
  #hud-displaytime .slider-ticks { display: none; }
  /* 左右ドックが幅を使い切り隙間が残らないため、ドックの下端を上げて帯の分を空け、バーは全幅に戻す。
     bottom はここで確保した帯の高さ(28vh)に収まる値まで詰め直す。 */
  #hud.map-mode .hud-dock { bottom: calc(28vh + 16px); }
  #hud-displaytime-wrap { left: 8px; right: 8px; bottom: 8px; }
  #hud-displaytime { max-height: 28vh; }
  #hud-combat-shelf { top: 72px; }
  #hud-combat-shelf > .panel { flex-basis: min(168px, calc(100vw - 16px)); width: min(168px, calc(100vw - 16px)); }
}
@media (pointer: coarse) {
  #hud .hud-dock { bottom: 62px; }
  #hud-combat-shelf > .panel { max-height: 104px; }
  #hud-map-scale { bottom: 62px; }
  #hud-displaytime-wrap { bottom: 62px; }
}
@media (pointer: coarse) and (orientation: landscape) and (max-height: 500px) {
  #hud .hud-dock { bottom: 52px; }
  #hud-combat-shelf { top: 60px; }
  #hud-combat-shelf > .panel { max-height: 82px; }
  #hud-stagestatus { max-height: 46px; }
  #navball { top: 60px; width: 72px !important; }
  #hud-chase-reset { top: 34px; }
  #hud-displaytime-wrap { bottom: 52px; }
}
@media (orientation: landscape) and (max-height: 500px) {
  #hud-combat-shelf { top: 60px; }
  #hud-combat-shelf > .panel { max-height: 82px; }
  #hud-stagestatus { max-height: 46px; }
  #hud-map-scale { bottom: 52px; }
}
/* ===== DockView ===== */
/* 戦闘・マップと対等な全画面ビュー。背後の 3D は描画自体が止まるので、
   透過させず不透明な地の色で塗り切る。 */
#dock-view.dock-view-overlay {
  position: fixed; inset: 0;
  display: flex;
  background: ${BG};
  font-family: ${FONT};
  pointer-events: auto;
  /* 右上のビューバッジは全ビュー共通の枠なのでドック中も残る。その帯を避けて中身を始める。 */
  padding-top: 30px;
}
/* マップ左右ドックの開閉ボタンは、背後のマップごと覆われるので出さない。 */
#hud.dock-mode .dock-toggle { display: none; }
#dock-view .dock-panel {
  flex: 1 1 auto; min-width: 0;
  display: flex; flex-direction: column; overflow: hidden;
}
#dock-view .dock-header {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px; border-bottom: 1px solid ${EDGE};
  flex: 0 0 auto;
  width: min(1100px, 100%); margin: 0 auto;
}
#dock-view .dock-title {
  font-size: 15px; font-weight: 700; letter-spacing: 0.12em;
  color: ${ACCENT}; flex: 0 0 auto;
}
#dock-view .dock-tabs { display: flex; gap: 4px; flex: 1; }
#dock-view .dock-tab-btn {
  padding: 4px 14px; border: 1px solid ${EDGE}; border-radius: 4px;
  background: transparent; color: ${INK_SOFT}; cursor: pointer;
  font-size: 12px; transition: color .15s, border-color .15s;
}
#dock-view .dock-tab-btn:hover { color: ${INK}; border-color: ${ACCENT_SOFT}; }
#dock-view .dock-tab-btn.active { color: ${ACCENT}; border-color: ${ACCENT}; background: rgba(${ACCENT_RGB},.08); }
#dock-view .dock-close-btn {
  padding: 4px 10px; border: 1px solid ${EDGE}; border-radius: 4px;
  background: transparent; color: ${INK_SOFT}; cursor: pointer; font-size: 14px;
}
#dock-view .dock-close-btn:hover { color: ${INK}; }
#dock-view .dock-status-bar {
  padding: 5px 16px; border-bottom: 1px solid ${EDGE};
  font-size: 12px; color: ${INK_SOFT}; flex: 0 0 auto;
  width: min(1100px, 100%); margin: 0 auto;
}
#dock-view .dock-body {
  flex: 1 1 0; overflow-y: auto; padding: 12px 16px;
  scrollbar-width: thin;
  width: min(1100px, 100%); margin: 0 auto;
}
#dock-view .dock-empty { color: ${INK_SOFT}; padding: 24px; text-align: center; line-height: 1.8; }
/* Ships tab */
#dock-view .dock-ship-list { display: flex; flex-direction: column; gap: 8px; }
#dock-view .dock-ship-row {
  display: flex; align-items: center; gap: 12px; padding: 10px 12px;
  border: 1px solid ${EDGE}; border-radius: 6px; cursor: pointer;
  transition: border-color .15s;
}
#dock-view .dock-ship-row:hover { border-color: ${ACCENT_SOFT}; }
#dock-view .dock-ship-row.selected { border-color: ${ACCENT}; background: rgba(${ACCENT_RGB},.06); }
#dock-view .dock-ship-info { flex: 1; display: flex; flex-direction: column; gap: 2px; }
#dock-view .dock-ship-name { font-size: 13px; }
#dock-view .dock-ship-hp { font-size: 11px; color: ${INK_SOFT}; }
#dock-view .dock-ship-actions { display: flex; gap: 6px; }
/* Parts tab */
#dock-view .dock-parts-header {
  display: flex; align-items: center; gap: 12px; margin-bottom: 10px;
  padding-bottom: 8px; border-bottom: 1px solid ${EDGE};
}
#dock-view .dock-ship-label { font-size: 12px; color: ${INK_SOFT}; flex: 1; }
#dock-view .dock-part-list { display: flex; flex-direction: column; gap: 6px; }
#dock-view .dock-part-row {
  display: grid; grid-template-columns: 1fr 120px 60px auto;
  align-items: center; gap: 10px; padding: 6px 10px;
  border: 1px solid ${EDGE}; border-radius: 4px;
}
#dock-view .dock-part-info { display: flex; flex-direction: column; gap: 2px; }
#dock-view .dock-part-name { font-size: 12px; }
#dock-view .dock-part-type { font-size: 10px; color: ${INK_SOFT}; }
#dock-view .dock-part-hp-bar { height: 6px; background: rgba(255,255,255,.08); border-radius: 3px; overflow: hidden; }
#dock-view .dock-part-hp-fill { height: 100%; border-radius: 3px; transition: width .3s; }
#dock-view .dock-part-hp-text { font-size: 11px; color: ${INK_SOFT}; text-align: right; }
#dock-view .dock-part-row { display: flex; flex-direction: column; gap: 6px; }
#dock-view .dock-part-row-main {
  display: grid; grid-template-columns: 1fr 120px 60px auto;
  align-items: center; gap: 10px;
}
#dock-view .dock-warehouse-row-main { grid-template-columns: 1fr 60px auto; }
#dock-view .dock-part-actions { display: flex; align-items: center; gap: 6px; }
#dock-view .dock-part-swap-row {
  display: flex; align-items: center; gap: 8px;
  padding-top: 6px; border-top: 1px solid ${EDGE};
  font-size: 11px; color: ${INK_SOFT};
}
#dock-view .dock-part-swap-select {
  flex: 1; background: rgba(255,255,255,.04); color: ${INK};
  border: 1px solid ${EDGE}; border-radius: 4px; padding: 3px 6px; font-size: 11px;
}
#dock-view .dock-parts-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
#dock-view .dock-parts-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
#dock-view .dock-col-title { font-size: 12px; color: ${INK_SOFT}; border-bottom: 1px solid ${EDGE}; padding-bottom: 4px; }
/* Shop tab */
#dock-view .dock-shop-header { margin-bottom: 10px; font-size: 11px; color: ${INK_SOFT}; }
#dock-view .dock-shop-list { display: flex; flex-direction: column; gap: 6px; }
#dock-view .dock-shop-item {
  display: flex; align-items: center; gap: 12px; padding: 8px 12px;
  border: 1px solid ${EDGE}; border-radius: 4px;
}
#dock-view .dock-shop-info { flex: 1; display: flex; flex-direction: column; gap: 2px; }
#dock-view .dock-shop-name { font-size: 13px; }
#dock-view .dock-shop-type { font-size: 10px; color: ${INK_SOFT}; }
#dock-view .dock-shop-props { font-size: 11px; color: ${INK_SOFT}; }
#dock-view .dock-shop-stats { font-size: 10px; color: ${INK_SOFT}; }
#dock-view .dock-shop-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
#dock-view .dock-shop-price { font-size: 12px; color: ${ACCENT}; }
/* Common buttons */
#dock-view .dock-btn {
  padding: 4px 12px; border: 1px solid ${EDGE}; border-radius: 4px;
  background: rgba(${ACCENT_RGB},.08); color: ${ACCENT}; cursor: pointer;
  font-size: 11px; transition: background .15s;
}
#dock-view .dock-btn:hover:not(.disabled) { background: rgba(${ACCENT_RGB},.18); }
#dock-view .dock-btn.disabled, #dock-view .dock-btn:disabled { opacity: 0.38; cursor: not-allowed; }
#dock-view .dock-btn-repair-all {
  font-size: 11px; padding: 4px 12px;
}
/* ===== SaveBrowser ===== */
#save-browser {
  position: fixed; inset: 0; display: none;
  align-items: center; justify-content: center;
  background: rgba(6, 7, 9, 0.82); backdrop-filter: blur(3px);
  font-family: ${FONT}; pointer-events: auto;
}
#save-browser .sb-panel {
  width: min(1100px, 94vw); height: min(760px, 88vh);
  display: flex; flex-direction: column; overflow: hidden;
  background: ${BG}; border: 1px solid ${EDGE}; border-radius: 8px;
}
#save-browser .sb-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; border-bottom: 1px solid ${EDGE}; flex: 0 0 auto;
}
#save-browser .sb-title { font-size: 13px; font-weight: 700; letter-spacing: 0.12em; color: ${INK}; }
#save-browser .sb-close-btn {
  padding: 3px 9px; border: 1px solid ${EDGE}; border-radius: 4px;
  background: transparent; color: ${INK_SOFT}; cursor: pointer; font-size: 13px;
}
#save-browser .sb-close-btn:hover { color: ${INK}; border-color: ${INK_SOFT}; }
#save-browser .sb-body { flex: 1 1 0; min-height: 0; display: flex; gap: 1px; background: ${EDGE}; }
#save-browser .sb-pane {
  flex: 1 1 0; min-width: 0; overflow-y: auto; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 6px; background: ${BG};
  scrollbar-width: thin;
}
#save-browser .sb-pane-slots { flex: 0 0 34%; }
#save-browser .sb-pane-title { font-size: 10px; letter-spacing: 1.5px; color: ${INK_SOFT}; }
#save-browser .sb-empty { color: ${INK_SOFT}; padding: 12px; text-align: center; line-height: 1.7; font-size: 11px; }
#save-browser .sb-slot-list { display: flex; flex-direction: column; gap: 4px; }
/* アクティブ行の識別は色数を増やさず、左端 2px のオレンジ帯のみで示す。
   「見ている」行は背景をわずかに明るくするだけで区別する。 */
#save-browser .sb-slot-row {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 6px;
  border: 1px solid ${EDGE}; border-left: 2px solid transparent; border-radius: 5px; cursor: pointer;
}
#save-browser .sb-slot-row.viewed { background: rgba(255,255,255,.05); }
#save-browser .sb-slot-row.active { border-left-color: ${ACCENT}; }
#save-browser .sb-slot-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
#save-browser .sb-slot-name { font-size: 11.5px; }
#save-browser .sb-slot-meta { font-size: 9.5px; color: ${INK_SOFT}; }
#save-browser .sb-slot-actions { display: flex; gap: 3px; flex-wrap: wrap; justify-content: flex-end; }
/* 左ペインは幅が狭いので、フッターのボタンは横並びにせず縦積みにして折り返しを防ぐ。 */
#save-browser .sb-slot-footer { display: flex; flex-direction: column; gap: 5px; margin-top: auto; padding-top: 6px; }
#save-browser .sb-btn {
  padding: 4px 9px; border: 1px solid ${EDGE}; border-radius: 4px;
  background: rgba(255,255,255,.04); color: ${INK_SOFT}; cursor: pointer; font-size: 10.5px;
  white-space: nowrap;
}
#save-browser .sb-btn:hover:not(:disabled) { background: rgba(255,255,255,.09); color: ${INK}; }
#save-browser .sb-btn:disabled { opacity: 0.38; cursor: not-allowed; }
#save-browser .sb-btn-sm { padding: 3px 6px; }
#save-browser .sb-btn-play { color: ${INK}; border-color: ${INK_SOFT}; }
/* このパネルで唯一の「押すと今の状態が増える」操作 — 注目させるためオレンジを残す。 */
#save-browser #sb-capture-now {
  background: rgba(${ACCENT_RGB},.12); color: ${ACCENT}; border-color: rgba(${ACCENT_RGB},.4);
}
#save-browser #sb-capture-now:hover:not(:disabled) { background: rgba(${ACCENT_RGB},.2); }
#save-browser .sb-stage-tabs { display: flex; gap: 3px; }
#save-browser .sb-tab-btn {
  padding: 3px 9px; border: 1px solid ${EDGE}; border-radius: 4px;
  background: transparent; color: ${INK_SOFT}; cursor: pointer; font-size: 10.5px;
}
#save-browser .sb-tab-btn.active { color: ${INK}; border-color: ${INK_SOFT}; background: rgba(255,255,255,.05); }
#save-browser .sb-snapshot-groups { display: flex; flex-direction: column; gap: 4px; }
#save-browser .sb-snapshot-group-title { font-size: 10px; color: ${INK_SOFT}; margin-top: 4px; }
#save-browser .sb-snapshot-list { display: flex; flex-direction: column; gap: 4px; }
#save-browser .sb-snap-card {
  display: flex; flex-direction: column; gap: 3px; padding: 6px 8px;
  border: 1px solid ${EDGE}; border-radius: 5px;
}
#save-browser .sb-snap-loadable { cursor: pointer; }
#save-browser .sb-snap-loadable:hover { border-color: ${INK_SOFT}; background: rgba(255,255,255,.03); }
#save-browser .sb-snap-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#save-browser .sb-snap-name { font-size: 11px; }
#save-browser .sb-snap-badge {
  font-size: 8.5px; letter-spacing: .5px; padding: 1px 6px; border-radius: 8px;
  border: 1px solid ${EDGE}; color: ${INK_SOFT};
}
#save-browser .sb-snap-badge-checkpoint { color: ${INK}; border-color: ${INK_SOFT}; }
#save-browser .sb-snap-row { font-size: 10px; color: ${INK_SOFT}; }
/* HP バーは細く、満タンでもオレンジで塗らない — このパネルの主役はセーブ操作であって
   HP 表示ではないため、他の注目要素と競合しないモノトーンに留める。 */
#save-browser .sb-snap-hp-bar { height: 3px; background: rgba(255,255,255,.08); border-radius: 2px; overflow: hidden; }
#save-browser .sb-snap-hp-fill { height: 100%; background: ${INK_SOFT}; }
#save-browser .sb-snap-actions { display: flex; gap: 3px; flex-wrap: wrap; }
/* クリップ済み(pin)状態だけは注目対象として残す — この行の意味は「消えずに残る」なので. */
#save-browser .sb-btn-pin[data-pinned="true"] {
  background: rgba(${ACCENT_RGB},.12); color: ${ACCENT}; border-color: rgba(${ACCENT_RGB},.4);
}
#save-browser .sb-status { min-height: 20px; padding: 3px 14px; font-size: 10.5px; color: ${INK_SOFT}; border-top: 1px solid ${EDGE}; }
#save-browser .sb-status.error { color: ${WARNING}; }
`;


// 指定タグ・id・class の要素を作り、parent に追加して返す。
function el(tag: string, id: string, parent: HTMLElement, className = ''): HTMLElement {
  const e = document.createElement(tag);
  e.id = id;
  if (className) e.className = className;
  parent.appendChild(e);
  return e;
}

export interface HudDomRefs {
  root: HTMLElement;
  layers: OverlayLayers;
  svgOverlay: SVGSVGElement;
  modalController: ModalController;
  els: Map<string, HTMLElement>;
}

/** 動的に生成されるマップ系パネルの配置先を返す。 */
export function hudDock(root: HTMLElement, side: 'left' | 'right'): HTMLElement {
  const id = `hud-dock-${side}`;
  return root.querySelector<HTMLElement>(`#${id}`) ?? root;
}

export interface CollapseToggleLabels {
  readonly expandedGlyph: string;
  readonly collapsedGlyph: string;
  readonly expandedTitle: string;
  readonly collapsedTitle: string;
}

// マップビュー下部の PREDICT バー用トグルの見た目。開閉先(display-time-panel.ts)と
// リセット先(resetHudDocks)の両方が同じラベルを参照するのでここに一つだけ持つ。
export const PREDICT_TOGGLE_LABELS: CollapseToggleLabels = {
  expandedGlyph: '▼',
  collapsedGlyph: '▲',
  expandedTitle: '下部パネルを閉じる',
  collapsedTitle: '下部パネルを開く',
};

function dockToggleLabels(side: 'left' | 'right'): CollapseToggleLabels {
  const label = side === 'left' ? '左' : '右';
  return {
    expandedGlyph: side === 'left' ? '◀' : '▶',
    collapsedGlyph: side === 'left' ? '▶' : '◀',
    expandedTitle: `${label}マップパネルを閉じる`,
    collapsedTitle: `${label}マップパネルを開く`,
  };
}

// button の見た目(グリフ・aria-expanded・title)を target の collapsed クラスに合わせる。
export function syncCollapseToggle(button: HTMLElement, target: HTMLElement, labels: CollapseToggleLabels): void {
  const collapsed = target.classList.contains('collapsed');
  button.textContent = collapsed ? labels.collapsedGlyph : labels.expandedGlyph;
  button.setAttribute('aria-expanded', String(!collapsed));
  button.title = collapsed ? labels.collapsedTitle : labels.expandedTitle;
}

// target の表示/非表示を collapsed クラスで切り替えるボタンを1つ組み、root へ追加して返す。
export function buildCollapseToggle(
  root: HTMLElement, id: string, className: string, target: HTMLElement, labels: CollapseToggleLabels,
): HTMLElement {
  const button = el('button', id, root, className);
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('click', () => {
    target.classList.toggle('collapsed');
    syncCollapseToggle(button, target, labels);
  });
  syncCollapseToggle(button, target, labels);
  return button;
}

function resetCollapseToggle(root: HTMLElement, targetId: string, buttonId: string, labels: CollapseToggleLabels): void {
  const target = root.querySelector<HTMLElement>(`#${targetId}`);
  const button = root.querySelector<HTMLElement>(`#${buttonId}`);
  if (!target || !button) return;
  target.classList.remove('collapsed');
  syncCollapseToggle(button, target, labels);
}

export function resetHudDocks(root: HTMLElement): void {
  for (const side of ['left', 'right'] as const) {
    resetCollapseToggle(root, `hud-dock-${side}`, `hud-dock-toggle-${side}`, dockToggleLabels(side));
  }
  resetCollapseToggle(root, 'hud-displaytime', 'hud-displaytime-toggle', PREDICT_TOGGLE_LABELS);
}

export function syncNavballPlacement(root: HTMLElement, mapMode: boolean): void {
  const navball = root.querySelector<HTMLElement>('#navball');
  const target = mapMode ? root.querySelector<HTMLElement>('#hud-dock-left') : root;
  if (navball && target && navball.parentElement !== target) target.appendChild(navball);
}

function buildDockToggle(root: HTMLElement, dock: HTMLElement, side: 'left' | 'right'): void {
  buildCollapseToggle(root, `hud-dock-toggle-${side}`, 'dock-toggle', dock, dockToggleLabels(side));
}

// STYLE の CSS を <head> に注入する。
function injectStyle(): void {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// マーカーのリード線を描く SVG オーバーレイを作る。
function buildSvgOverlay(root: HTMLElement): SVGSVGElement {
  const svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgOverlay.style.position = 'absolute';
  svgOverlay.style.inset = '0';
  svgOverlay.style.width = '100%';
  svgOverlay.style.height = '100%';
  svgOverlay.style.pointerEvents = 'none';
  svgOverlay.style.zIndex = '0';
  root.appendChild(svgOverlay);
  return svgOverlay;
}

// 常設の情報パネル(SHIP STATUS/ORBIT/TARGET/CONTACTS)を組む。
function buildInfoPanels(root: HTMLElement, targetDock: HTMLElement): void {
  const shelf = el('div', 'hud-combat-shelf', root);

  // SHIP STATUS パネル
  const status = el('div', 'hud-status', shelf, 'panel');
  status.innerHTML = `
    <h3>SHIP STATUS</h3>
    <div class="row"><span class="k">RCS制動 [${K.rcsDampToggle.label}]</span><span class="v" data-id="rcs"></span></div>
    <div class="row"><span class="k">並進出力 [${K.throttleLow.label}-${K.throttleMax.label}]</span><span class="v" data-id="throttle"></span></div>
    <div class="row"><span class="k">微調整 [${K.fineAttitudeToggle.label}]</span><span class="v" data-id="fine"></span></div>
    <div class="row"><span class="k">進行方向ホールド [${K.progradeHoldToggle.label}]</span><span class="v" data-id="prohold"></span></div>
    <div class="row"><span class="k">視点のRCS追従 [${K.followAttitudeToggle.label}]</span><span class="v" data-id="camfollow"></span></div>
    <div class="row"><span class="k">弾薬 AMMO</span><span class="v" data-id="ammo"></span></div>`;

  // ORBIT パネル
  const orbit = el('div', 'hud-orbit', shelf, 'panel');
  orbit.innerHTML = `
    <h3>ORBIT</h3>
    <div class="row"><span class="k">基準天体</span><span class="v" data-id="center"></span></div>
    <div class="row"><span class="k">高度 ALT</span><span class="v" data-id="alt"></span></div>
    <div class="row"><span class="k">速度 VEL</span><span class="v" data-id="spd"></span></div>
    <div class="row"><span class="k">遠地点 AP</span><span class="v" data-id="ap"></span></div>
    <div class="row"><span class="k">近地点 PE</span><span class="v" data-id="pe"></span></div>
    <div class="row"><span class="k">傾斜角 INC</span><span class="v" data-id="inc"></span></div>
    <div class="row"><span class="k">周期 PRD</span><span class="v" data-id="prd"></span></div>
    <div class="row"><span class="k">動圧 Q</span><span class="v" data-id="qdyn"></span></div>
    <div class="row"><span class="k">機体温度</span><span class="v" data-id="temp"></span></div>`;

  // TARGET パネル
  const target = el('div', 'hud-target', targetDock, 'panel');
  target.style.display = 'none';
  target.innerHTML = `
    <h3 data-id="tgtname">TARGET</h3>
    <div data-id="tgtbody"></div>`;

  // CONTACTS パネル
  const enemies = el('div', 'hud-enemies', shelf, 'panel');
  enemies.innerHTML = `
    <h3>CONTACTS <span data-id="count"></span></h3>
    <div data-id="elist"></div>`;

  // マップ視点の縮尺バー。描画自体は HudPanels.sync がカメラの注視点基準で更新する。
  const mapScale = el('div', 'hud-map-scale', root);
  mapScale.dataset.id = 'map-scale';
  mapScale.setAttribute('aria-label', 'マップ縮尺');
  mapScale.innerHTML = `
    <div><span class="map-scale-value" data-id="map-scale-value"></span></div>
    <div class="map-scale-ruler" data-id="map-scale-ruler">
      <span class="map-scale-tick start"></span><span class="map-scale-tick q1"></span>
      <span class="map-scale-tick mid"></span><span class="map-scale-tick q3"></span>
      <span class="map-scale-tick end"></span>
    </div>`;
}

// 画面全体のグローバルステータス(MET・時間加速・NODE WARP)を組む。
function buildGlobalStatus(root: HTMLElement): void {
  const bar = el('div', 'hud-globalstatus', root);
  bar.innerHTML = `
    <span class="v" data-id="met"></span>
    <span class="gs-sep">|</span>
    <span class="k">時間加速</span><span class="v" data-id="sim-speed"></span>
    <span class="gs-sep">|</span>
    <span class="k">NODE WARP</span><span class="v" data-id="node-warp-remain">—</span>`;
}

// 追従カメラの視点リセットボタンを組む。
function buildChaseReset(root: HTMLElement): void {
  const chaseReset = el('div', 'hud-chase-reset', root);
  chaseReset.dataset.id = 'chase-reset';
  chaseReset.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>`;
}

// 全操作の説明表([H]で開閉するヘルプパネル)を組む。
function buildHelpPanel(root: HTMLElement): void {
  const help = el('div', 'hud-help', root, 'panel');
  // キーと説明を1行ずつ対応させた表。
  help.innerHTML = `
    <h3>操作方法 [${K.help.label} で閉じる]</h3>
    <table>
      <tr><td class="key">
        <div style="display:inline-block; text-align:center; line-height:1.2; font-family:monospace; margin-right:8px; vertical-align:middle;">
          <div>W</div><div>A S D</div>
        </div>
        / 
        <div style="display:inline-block; text-align:center; line-height:1.2; font-family:monospace; margin-left:8px; vertical-align:middle;">
          <div>↑</div><div>← ↓ →</div>
        </div>
      </td><td>並進 (前 / 後 / 左 / 右 / 上 / 下)<br><span style="font-size:10px; color:${INK_SOFT};">※ 上下は Q/E</span></td></tr>
      <tr><td class="key">
        <div style="display:inline-block; text-align:center; line-height:1.2; font-family:monospace; vertical-align:middle;">
          <div>I</div><div>J K L</div>
        </div>
        <div style="display:inline-block; text-align:center; line-height:1.2; font-family:monospace; margin-left:8px; vertical-align:middle;">
          <div>U O</div>
        </div>
      </td><td>回転 (ピッチ / ヨー / ロール)</td></tr>
      <tr><td class="key">${K.rcsDampToggle.label}</td><td>RCS 回転制動 ON/OFF</td></tr>
      <tr><td class="key">${K.progradeReset.label}</td><td>プログレード姿勢リセット (機首を進行方向へ即座に向ける)</td></tr>
      <tr><td class="key">${throttleKeyLabels}</td><td>並進出力の切替 (${C.THROTTLE_LABELS.join(' / ')})。並進 6 方向に共通で適用される</td></tr>
      <tr><td class="key">${K.fineAttitudeToggle.label}</td><td>姿勢微調整モード ON/OFF (角加速度・角速度を絞って小刻みに操作)</td></tr>
      <tr><td class="key">${K.progradeHoldToggle.label}</td><td>進行方向ホールド ON/OFF (機首をプログレード方向へ自動で向け続ける。手動回転で解除)</td></tr>
      <tr><td class="key">${K.radiatorDeployLeft.label} / ${K.radiatorDeployRight.label}</td><td>ラジエーター展開/収納 (左 / 右)</td></tr>
      <tr><td class="key">${K.followAttitudeToggle.label}</td><td>視点のRCS追従 ON/OFF (既定 ON: 視点が機体姿勢を基準に回転し、RCS操作と一体的に動く。OFF で軌道基準の独立視点になる)</td></tr>
      <tr><td class="key">${K.gunsightZoom.label} (長押し)</td><td>照準ズーム (機首方向を画面中心に拡大表示、自機は非表示になる)</td></tr>
      <tr><td class="key">右クリック (敵)</td><td>敵をターゲット固定 / 解除 (固定中はターゲット名が画面右上に表示される)</td></tr>
      <tr><td class="key">${K.targetSelect.label}</td><td>照準に近い敵をターゲット選択 (短時間の連打で第二ターゲットを順送り)</td></tr>
      <tr><td class="key">▲AN / ▽DN マーカー</td><td>自機軌道とターゲット軌道面の交点。面変更(ノーマル/アンチノーマル)burn の目安位置</td></tr>
      <tr><td class="key">✦ マーカー</td><td>ターゲット位置に自機側を向けた仮想標的面を弾が通過した点。次弾の照準修正の目安</td></tr>
      <tr><td class="key">方向マーカー</td><td>軌道基準の6方向 (PRO/RET・NRM/ANM・OUT/IN) を示すマーカー。並進は機体基準なので、この6方向へ加速するには機首をマーカーへ向ける</td></tr>
      <tr><td class="key">${K.toggleMapMode.label}</td><td>軌道計画モード。地球中心ビューで数値積分した計画軌道(折れ線)をクリックしてノードを複数配置でき、再度 ${K.toggleMapMode.label} で確定(時間は進み続けるのでワープも可)</td></tr>
      <tr><td class="key">ノードのドラッグ</td><td>ノード上の丸ハンドルをドラッグすると、ポインタに最も近い軌道上の時刻へノードを移動する(小さな動きはドラッグでなくクリック=選択として扱う)</td></tr>
      <tr><td class="key">Δv 矢印ハンドル</td><td>選択中ノードの周囲に PRO/RET・NRM/ANM・OUT/IN の6ハンドルを表示。ドラッグした向きに応じて対応する Δv 成分を増減する(マップモード中のみ ${K.dvPrograde.label}/${K.dvRetrograde.label}・${K.dvNormal.label}/${K.dvAntinormal.label}・${K.dvRadialOut.label}/${K.dvRadialIn.label} キーでも同じ成分を調整可能、[${K.fineAttitudeToggle.label}] で微調整)</td></tr>
      <tr><td class="key">PREDICT パネル</td><td>マップモード下部。期間 = スライダーが指せる未来の長さ(1周回は現在の周期、双曲線等では1日にフォールバック)、スライダー = 期間内の任意の時刻へゴースト位置(⬡)を表示(0で非表示)</td></tr>
      <tr><td class="key">TRAJECTORY パネル</td><td>マップモード下部。軌道 = 計画軌道の折れ線を描く座標系</td></tr>
      <tr><td class="key">MAP VIEW パネル</td><td>マップモード左上。注視 = カメラの注視対象(それ以外の天体・ラグランジュ点はラベルを右クリック)、視点 = カメラを固定する座標系、視点リセット = 距離と向きを初期値へ戻す</td></tr>
      <tr><td class="key">慣性系/太陽回転系</td><td>計画軌道とカメラの座標系はそれぞれ独立に選べる。太陽回転系では太陽方向が画面上でほぼ固定される(遷移計画の目安)</td></tr>
      <tr><td class="key">${K.autoWarpToNode.label}</td><td>直近のマニューバノードへ時間を自動加速(実行点の直前で自動解除)</td></tr>
      <tr><td class="key">右クリック</td><td>マップモード中、ノード近傍で右クリックするとコンテキストメニュー(この時刻まで自動ワープ / ノードを削除 / キャンセル)を開く。ノードが無い位置での右クリックや、開いたメニュー外への右クリックは閉じるだけ</td></tr>
      <tr><td class="key">${K.deleteNode.label}</td><td>マップモード中は選択中のノードを削除(右クリックメニューのフォールバック)、戦闘ビューでは計画全体を破棄</td></tr>
      <tr><td class="key">◆/▶NODE / ⬢BURN</td><td>直近のマニューバ実行点(▶は選択中)と噴射ガイド。BURN の方向へ加速し、噴射後の計画軌道に十分近づくとそのノードを達成として次のノードへ進む</td></tr>
      <tr><td class="key">オレンジの軌道線</td><td>ターゲットの軌道(自機軌道とほぼ重なる場合は上に重ねて描画)</td></tr>
      <tr><td class="key">弾薬 / ▣ AMMO</td><td>${C.MAG_ROUNDS}発でマガジン1連を消費(右舷のベルトから自動給弾)。残弾が少なくなると付近の軌道に補給が投入されるので、▣ マーカーへ接近して回収</td></tr>
      <tr><td class="key">${K.reload.label}</td><td>マニュアル装填(残弾のあるマガジンを捨てて新しい1連を装填)。決着後は同じステージで再出撃</td></tr>
      <tr><td class="key">${K.fire.label} / 右クリック</td><td>機関砲発射 (ワープ×${C.MAX_PHYS_SIM_SPEED}以下)。撃ち始めは起動音とともに一瞬遅れて連射開始</td></tr>
      <tr><td class="key">${K.warpSlower.label} / ${K.warpFaster.label}</td><td>時間加速 減 / 増</td></tr>
      <tr><td class="key">左ドラッグ / ホイール</td><td>カメラ回転 / 距離ズーム</td></tr>
      <tr><td class="key">矢印キー (${K.cameraYawLeft.label}${K.cameraYawRight.label}${K.cameraPitchUp.label}${K.cameraPitchDown.label})</td><td>マウスの代わりにキーボードで視点回転</td></tr>
      <tr><td class="key">${K.pauseMenu.label}</td><td>一時停止メニュー (設定 / タイトルへ戻る)</td></tr>
    </table>`;
}

// data-id 属性を持つ要素を、その id をキーにした Map にまとめて返す。
function collectDataIdElements(root: HTMLElement): Map<string, HTMLElement> {
  const els = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>('[data-id]').forEach((e) => {
    els.set(e.dataset['id']!, e);
  });
  return els;
}

// HUD のスタイル・レイヤ・各パネル・SVG オーバーレイを一括構築し、DOM 参照をまとめて返す。
export function buildHudDom(): HudDomRefs {
  injectStyle();
  const root = el('div', 'hud', document.body);
  const layers = buildOverlayLayers(root);
  const svgOverlay = buildSvgOverlay(layers.marker);
  el('div', 'hud-dock-left', layers.panel, 'hud-dock hud-dock-left');
  const rightDock = el('div', 'hud-dock-right', layers.panel, 'hud-dock hud-dock-right');
  const leftDock = layers.panel.querySelector<HTMLElement>('#hud-dock-left')!;
  buildDockToggle(layers.panel, leftDock, 'left');
  buildDockToggle(layers.panel, rightDock, 'right');

  // 常設パネル群を組む。
  buildInfoPanels(layers.panel, rightDock);
  buildGlobalStatus(layers.panel);
  buildChaseReset(layers.panel);
  const modalShield = el('div', 'hud-modal-shield', layers.notify);
  const modalController = new ModalController(modalShield, layers.notify);

  el('div', 'hud-hint', layers.notify);
  el('div', 'hud-toast', layers.notify);

  buildHelpPanel(layers.system);

  el('div', 'hud-end', layers.system);

  const els = collectDataIdElements(root);
  return { root, layers, svgOverlay, modalController, els };
}

// HUD の静的 DOM/スタイル構築。
import * as C from '../const';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { injectThemeVariables } from '../theme';
import { buildOverlayLayers, OVERLAY_LAYER_STYLE, type OverlayLayers } from './overlay-layer';
import { ModalController } from './modal-controller';


const throttleKeyLabels = [K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax].map((k) => k.label).join(' / ');

const STYLE = `
#hud, #hud * { box-sizing: border-box; margin: 0; padding: 0; }
#hud {
  position: fixed; inset: 0; pointer-events: none; overflow: hidden;
  font-family: var(--font-family);
  /* body 直下の他要素(タッチ操作パッド・天球グリッドのラベル層)との前後関係を決める。
     #hud の内側の重なり順は overlay-layer.ts のレイヤが持つ。 */
  color: var(--text); user-select: text; z-index: 10;
  font-size: var(--font-l);
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
#hud, #hud * { scrollbar-color: var(--edge) transparent; }
#hud ::-webkit-scrollbar { width: 8px; height: 8px; }
#hud ::-webkit-scrollbar-track { background: transparent; }
#hud ::-webkit-scrollbar-thumb { background: var(--edge); border-radius: var(--radius-m); }
#hud ::-webkit-scrollbar-thumb:hover { background: var(--accent-soft); }
#hud .mk { z-index: 0; }
#hud .mk-node, #hud .mk-mnode, #hud .mk-burn, #hud .mk-poi, #hud .mk-base, #hud .mk-nav, #hud .mk-dir, #hud .mk-bearing-triangle, #hud .mk-boardpass, #hud .mk-lead, #hud .mk-pro, #hud .mk-retro, #hud .mk-nrm, #hud .mk-rad, #hud .mk-tgtdir, #hud .mk-boresight { z-index: 1; }
#hud .mk-ammo { z-index: 2; }
#hud .mk-enemy, #hud .mk-target, #hud .mk-secondary-target { z-index: 3; }
#hud .mk-self { z-index: 4; }
#hud-modal-shield { display: none; position: absolute; inset: 0; pointer-events: none; background: var(--shade-1); }
body.hud-modal-open #hud-modal-shield { display: block; }
body.hud-modal-open #touch-ui { display: none; }
#hud .panel {
  position: absolute; background: var(--surface);
  border: 1px solid var(--edge); border-radius: var(--radius-m);
  padding: var(--space-4) var(--space-5); line-height: 1.5; backdrop-filter: blur(4px);
}
/* マップ系パネルは左右のドック内で通常フローに積む。内容が増えても他の
   パネルを押し退けるだけで、固定座標による重なりを起こさない。 */
#hud .hud-dock {
  position: absolute; top: 40px; bottom: 12px;
  display: flex; flex-direction: column; align-items: stretch; gap: var(--space-4);
  pointer-events: none; min-height: 0; overflow-x: hidden; overflow-y: auto;
  scrollbar-width: thin; overscroll-behavior: contain;
}
#hud .hud-dock > .panel { position: relative; inset: auto; transform: none; pointer-events: auto; flex: 0 0 auto; }
#hud .hud-dock-left { left: 12px; width: min(300px, 30vw); }
#hud .hud-dock-right { right: 12px; width: min(300px, 33vw); }
#hud .hud-dock > .panel[style*="display: none"] { display: none !important; }
#hud .dock-toggle {
  display: none; position: absolute; top: 8px; z-index: 20; pointer-events: auto;
  width: 26px; height: 26px; border: 1px solid var(--edge); border-radius: var(--radius-m);
  background: var(--surface); color: var(--accent); cursor: pointer;
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
  font-size: var(--font-s); letter-spacing: 2.5px; color: var(--accent);
  border-bottom: 1px solid var(--accent-edge-soft); margin-bottom: var(--space-3); padding-bottom: var(--space-2);
  font-weight: 600;
}
/* マップモードでは #hud-dock-toggle-right(right:8px, 26px 角)がこの位置に重なるので、
   その右端(8+26=34px)より確実に外側へ避けておく。 */
#hud-viewbadge {
  position: absolute; top: 8px; right: 44px;
  display: flex; align-items: center; gap: var(--space-3);
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: 1.2px;
  white-space: nowrap; opacity: 0.9;
}
#hud-viewbadge .vb-title { color: var(--accent); }
#hud-viewbadge .vb-mode { color: var(--text-dim); }
#hud-viewbadge .vb-view-btn {
  pointer-events: auto; cursor: pointer; background: transparent;
  border: 1px solid var(--edge); border-radius: var(--radius-m); padding: var(--space-1) var(--space-3);
  color: var(--text-dim); font: inherit; letter-spacing: inherit;
}
#hud-viewbadge .vb-view-btn:hover { color: var(--text); border-color: var(--accent-soft); }
#hud-globalstatus {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  pointer-events: auto;
  padding: var(--space-2) var(--space-5); border-radius: 0 0 var(--radius-m) var(--radius-m);
  background: var(--surface); border: 1px solid var(--edge); border-top: none; backdrop-filter: blur(4px);
  font-size: var(--font-s); letter-spacing: 1px; font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  display: flex; align-items: center; gap: var(--space-4); white-space: nowrap;
}
#hud-globalstatus .v { color: var(--text); }
#hud-globalstatus .gs-sep { color: var(--edge); }
#hud .row { display: flex; justify-content: space-between; gap: var(--space-5); }
#hud .row .k { color: var(--text-dim); }
#hud .row .v { color: var(--text); min-width: 90px; text-align: right; }
#hud-status { bottom: 12px; left: 12px; width: 228px; box-sizing: border-box; font-size: var(--font-xs); }
#hud-status h3 { font-size: var(--font-xxs); }
/* マップビューでは艦固有の情報を右クリックのプロパティウィンドウで参照するので、常設の
   SHIP STATUS は畳んでパネル占有面積を減らす。戦闘ビューでは従来どおり常設のまま。 */
#hud.map-mode #hud-status { display: none; }
#hud-orbit { bottom: 12px; left: 252px; width: 228px; box-sizing: border-box; font-size: var(--font-xs); }
#hud-orbit h3 { font-size: var(--font-xxs); }
#hud.map-mode #hud-orbit { font-size: inherit; }
#hud.map-mode #hud-orbit h3 { font-size: var(--font-s); }
#hud-status .v, #hud-orbit .v { min-width: 75px; }
#hud .hud-dock-right > #hud-target { width: 100%; box-sizing: border-box; font-size: var(--font-xs); }
#hud .hud-dock-right > #hud-target h3 { font-size: var(--font-xxs); }
#hud-enemies { bottom: 12px; right: 12px; width: 228px; box-sizing: border-box; font-size: var(--font-xs); }
#hud-enemies h3 { font-size: var(--font-xxs); }
#hud-enemies .erow { display: flex; justify-content: space-between; gap: var(--space-4); color: var(--text-dim); }
#hud-enemies .erow.tgt { color: var(--danger); }
#hud-map-scale {
  position: absolute; right: 12px; bottom: 12px; display: none; pointer-events: none;
  padding: var(--space-2) var(--space-4) var(--space-3); border: 1px solid var(--edge); border-radius: var(--radius-m);
  background: var(--surface); color: var(--text-dim); font-size: var(--font-xxs); line-height: 1.1;
  font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap;
}
#hud-map-scale .map-scale-value { color: var(--text); }
#hud-map-scale .map-scale-ruler { position: relative; height: 10px; margin-top: var(--space-1); margin-left: auto; }
#hud-map-scale .map-scale-ruler::before {
  content: ''; position: absolute; left: 0; right: 0; top: 5px; border-top: 1px solid var(--text-dim);
}
#hud-map-scale .map-scale-tick {
  position: absolute; top: 1px; height: 9px; border-left: 1px solid var(--text);
}
#hud-map-scale .map-scale-tick.start { left: 0; }
#hud-map-scale .map-scale-tick.q1 { left: 25%; }
#hud-map-scale .map-scale-tick.mid { left: 50%; }
#hud-map-scale .map-scale-tick.q3 { left: 75%; }
#hud-map-scale .map-scale-tick.end { right: 0; }
#hud-object-list { max-height: 544px; overflow-y: auto; }
/* パネルの padding 分だけ食い込ませて幅いっぱいに広げ、スクロール中も先頭に張り付かせる */
#hud-object-list .object-list-head { position: sticky; top: calc(var(--space-4) * -1); margin: calc(var(--space-4) * -1) calc(var(--space-5) * -1) 0; padding: var(--space-4) var(--space-5) 0; background: var(--surface-opaque); z-index: 1; }
#hud-object-list .object-list-search { padding: var(--space-1) var(--space-2); }
#hud-object-list .object-list-search input { width:100%; box-sizing:border-box; background:var(--surface); color:var(--text); border:1px solid var(--edge); font:inherit; }
#hud-object-list .object-list-tools { display:flex; gap: var(--space-2); flex-wrap:wrap; padding: var(--space-1) var(--space-2); }
#hud-object-list .object-list-tools button {
  font-size: var(--font-xxs); padding: var(--space-1) var(--space-2); border:1px solid var(--edge); border-radius: var(--radius-m);
  background:var(--surface); color:var(--text-dim);
}
#hud-object-list .object-list-tools button[aria-pressed="true"] { color:var(--accent); border-color:var(--accent); }
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
#hud-object-list .erow { padding: var(--space-2) var(--space-2); color: var(--text-dim); cursor: pointer; display: flex; align-items: center; gap: var(--space-2); }
#hud-object-list .object-list-detail { margin-left: auto; font-size: var(--font-xxs); color: var(--text-dim); white-space: nowrap; }
#hud-object-list .erow:hover { color: var(--text); }
#hud-object-list .erow.tgt { color: var(--accent); }
#hud-object-list .erow.selected { outline: 1px solid var(--edge); color: var(--text); }
#hud-object-list .object-list-toggle { width: 10px; text-align: center; flex: none; }
#hud-object-list .object-list-children { padding-left: var(--space-5); }
#hud-combat-shelf { display: contents; }

#hud-hint {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  background: var(--surface); border: 1px solid var(--accent-edge); border-radius: var(--radius-m);
  padding: var(--space-4) var(--space-6);
  color: var(--accent-soft); font-size: var(--font-xl);
  transition: opacity var(--transition-slow); opacity: 0; text-align: center;
}
#hud-chase-reset {
  position: absolute; top: 40px; left: 50%; transform: translateX(-50%);
  pointer-events: auto; cursor: pointer;
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; justify-content: center; align-items: center;
  padding: 0;
  border: 1px solid var(--edge); background: var(--surface); color: var(--text-dim);
}
#hud-chase-reset:hover { border-color: var(--accent); color: var(--accent); }
#hud-toast {
  position: absolute; top: 18%; left: 50%; transform: translateX(-50%);
  background: var(--surface); border: 1px solid var(--edge); border-radius: var(--radius-m); padding: var(--space-5) var(--space-6);
  color: var(--text); font-size: var(--font-xl); text-align: center;
  transition: opacity var(--transition-slow); opacity: 0; line-height: 1.8;
}
#hud .sim-speed-hot { color: var(--accent); }
#hud .mode-tgt { color: var(--danger); }
.mk {
  position: absolute; transform: translate(-50%, -50%);
  text-align: center; white-space: nowrap; text-shadow: 0 0 4px var(--bg), 0 0 2px var(--bg);
  width: 24px; height: 24px;
}
.mk .sym { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: var(--glyph-base); line-height: 1; }
.mk .lbl { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); font-size: var(--font-xs); letter-spacing: 1px; }
#hud .mk .lbl { margin-top: var(--space-1); }
.mk-enemy .lbl, .mk-target .lbl { font-size: var(--font-xxs); line-height: 1.2; white-space: pre; }
.mk-dir { color: var(--text-strong); font-size: var(--font-s); text-shadow: none; }
#hud .mk-bearing-triangle .sym { font-size: var(--glyph-2-3); }
#hud .mk-ally-dir .sym { font-size: var(--glyph-1-3); }
.mk-boresight { color: var(--text-strong); font-size: var(--glyph-boresight); }
#mk-bore .sym { width: 48px; height: 48px; }
#mk-bore .lbl { top: -14px; left: 19px; transform: none; font-size: var(--font-xxs); letter-spacing: .4px; color: var(--text-dim); text-shadow: 0 0 3px var(--bg); }
.mk-target { color: var(--text-strong); }
.mk-secondary-target { color: var(--accent-secondary); }
.mk-enemy { color: var(--text-strong); }
.mk-lead { color: var(--danger); }
.mk-pro { color: ${C.COLOR_MARKER_PROGRADE}; }
.mk-retro { color: ${C.COLOR_MARKER_PROGRADE}; }
.mk-nrm { color: ${C.COLOR_MARKER_NORMAL}; }
.mk-rad { color: ${C.COLOR_MARKER_RADIAL}; }
.mk-tgtdir { color: ${C.COLOR_MARKER_TGTDIR}; }
.mk-node { color: ${C.COLOR_MARKER_NODE}; }
.mk-boardpass { color: ${C.COLOR_MARKER_BOARDPASS}; text-shadow: 0 0 5px color-mix(in srgb, ${C.COLOR_MARKER_BOARDPASS} var(--glow-strong), transparent), 0 0 10px color-mix(in srgb, ${C.COLOR_MARKER_BOARDPASS} var(--glow-weak), transparent); }
.mk-boardpass .sym { font-size: var(--font-xxs); }
.mk-mnode { color: var(--accent-soft); }
.mk-mnode .lbl { white-space: pre; line-height: 1.25; }
.mk-burn { color: var(--accent); text-shadow: 0 0 8px color-mix(in srgb, var(--accent) var(--glow-strong), transparent); }
.mk-self { color: ${C.COLOR_MARKER_SELF}; }
.mk-ammo { color: var(--accent-soft); text-shadow: 0 0 6px color-mix(in srgb, var(--accent-soft) var(--glow-strong), transparent), 0 0 3px var(--bg); }
#hud .warn-hot { color: var(--danger); }
#hud-plan { min-width: 0; width: 100%; max-width: 300px; overflow-wrap: anywhere; }
#hud .hud-seg { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); flex-wrap: wrap; }
#hud .hud-seg .seg-title { font-size: var(--font-xs); letter-spacing: 1px; color: var(--text-dim); min-width: 28px; }
#hud .seg-btn {
  pointer-events: auto; cursor: pointer; padding: var(--space-2) var(--space-5); font-size: var(--font-s);
  border: 1px solid var(--edge); border-radius: var(--radius-m); background: var(--surface); color: var(--text-dim);
  line-height: 1.2;
}
#hud .seg-btn.on { border-color: var(--accent); color: var(--accent); }
#hud .seg-btn.disabled { opacity: 0.35; pointer-events: none; }
#hud .seg-btn.hold-btn:active { border-color: var(--accent); color: var(--accent); background: var(--accent-fill); }
#hud .icon-toggle-btn { min-width: 20px; padding: var(--space-2) var(--space-3); text-align: center; font-size: var(--font-m); }
#hud .body-class-row { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-2); }
#hud .body-class-row .body-class-title { width: 96px; min-width: 96px; text-align: left; font-size: var(--font-xs); letter-spacing: 1px; }
#hud .body-class-row .body-class-btns { display: flex; gap: var(--space-2); }
#hud .body-class-row.category-off .icon-toggle-btn.on { border-color: var(--edge); color: var(--text-dim); font-weight: 700; opacity: .65; }
#hud .body-class-row.category-off .icon-toggle-btn.disabled { opacity: .35; }
#hud .category-toggle-btn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#hud .hud-toggle { display: flex; align-items: center; gap: var(--space-4); margin-bottom: var(--space-3); }
#hud .hud-toggle .toggle-title { font-size: var(--font-xs); letter-spacing: 1px; color: var(--text-dim); }
#hud .hud-toggle .toggle-track {
  pointer-events: auto; cursor: pointer; position: relative; display: inline-block;
  width: 34px; height: 18px; border-radius: var(--radius-l); border: 1px solid var(--edge);
  background: var(--surface); transition: border-color var(--transition-fast), background var(--transition-fast);
}
#hud .hud-toggle .toggle-track.on { border-color: var(--accent); background: var(--accent-fill-strong); }
#hud .hud-toggle .toggle-knob {
  position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
  background: var(--text-dim); transition: left var(--transition-fast), background var(--transition-fast);
}
#hud .hud-toggle .toggle-track.on .toggle-knob { left: 18px; background: var(--accent); }
/* MAP VIEW の左列は navball ウィンドウの右に置き、重なりを避ける。 */
#hud-overview-camera { display: none; width: 100%; pointer-events: auto; }
#hud-overview-camera .overview-camera-title { display: flex; align-items: center; gap: var(--space-2); }
#hud-overview-camera .overview-camera-collapse { margin-left: auto; background: none; border: none; color: var(--text-dim); font: inherit; cursor: pointer; pointer-events: auto; }
#hud-overview-camera .overview-camera-body.collapsed { display: none !important; }
/* 下部の固定バーとその開閉トグル。両者を縦積みの flex にして画面下端に揃え、パネルを畳んでも
   トグルだけがその場(バーがあった位置の上端)に残るようにする。マップビューでは
   #hud-stagestatus は常に非表示なので、他の下端揃えパネル(.hud-dock 等)と同じ bottom まで詰める。
   左右ドック(.hud-dock-left/.hud-dock-right)の内側に収まる幅だけを使い、ドックのパネルに重ねない。 */
#hud-displaytime-wrap {
  position: absolute; bottom: 12px;
  left: calc(12px + min(300px, 30vw) + 8px); right: calc(12px + min(300px, 33vw) + 8px);
  display: flex; flex-direction: column; gap: var(--space-2); pointer-events: none;
}
/* #hud を重ねた ID セレクタで、.panel 共通規則(position:absolute)より詳細度を上げて打ち消す。 */
#hud #hud-displaytime {
  display: none; position: relative; inset: auto; order: 2; box-sizing: border-box;
  max-height: 40vh; overflow-y: auto; pointer-events: auto;
}
#hud-displaytime.collapsed { display: none !important; }
#hud-displaytime-toggle {
  display: none; order: 1; align-self: center; pointer-events: auto; cursor: pointer;
  width: 26px; height: 26px; border: 1px solid var(--edge); border-radius: var(--radius-m);
  background: var(--surface); color: var(--accent);
}
#hud.map-mode #hud-displaytime-toggle { display: block; }
#hud.dock-mode #hud-displaytime-toggle { display: none; }
#hud-displaytime .dtp-row1, #hud-displaytime .dtp-row2 { display: flex; align-items: center; gap: var(--space-3); }
#hud-displaytime .dtp-row1 { flex-wrap: wrap; margin-bottom: var(--space-2); }
#hud-displaytime .dtp-pills { display: inline-flex; gap: var(--space-3); flex-wrap: wrap; align-items: center; }
#hud-displaytime .dtp-reset {
  pointer-events: auto; cursor: pointer; flex: 0 0 auto;
  width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--edge); border-radius: var(--radius-m); background: var(--surface); color: var(--text-dim); font-size: var(--font-m);
}
#hud-displaytime .dtp-reset:hover { border-color: var(--accent); color: var(--accent); }
#hud-displaytime .dtp-slider-wrap { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; height: 22px; }
#hud-displaytime input[type="range"] { width: 100%; height: 22px; margin: 0; pointer-events: auto; accent-color: var(--accent); }
#hud-displaytime .dtp-elapsed {
  flex: 0 0 auto; pointer-events: auto; cursor: pointer;
  font-size: var(--font-s); color: var(--text-dim); font-variant-numeric: tabular-nums; white-space: nowrap;
}
#hud-displaytime .dtp-elapsed:hover { color: var(--text); }
#hud-displaytime .dtp-absolute {
  flex: 0 0 auto; font-size: var(--font-s); color: var(--text-dim);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
#hud-displaytime .dtp-value-input { display: inline-flex; align-items: center; gap: var(--space-2); margin: 0; }
/* 単位の SegmentedControl は見出しを持たないので、共通規則の見出し幅を出さない。 */
#hud-displaytime .dtp-value-input .seg-title { display: none; }
#hud-displaytime .dtp-value-input input[type="number"] { width: 56px; }
#hud-displaytime .dtp-edit-btn {
  pointer-events: auto; cursor: pointer; padding: var(--space-1) var(--space-3); font-size: var(--font-s);
  border: 1px solid var(--edge); border-radius: var(--radius-m); background: var(--surface); color: var(--text-dim);
}
#hud-displaytime .dtp-edit-btn:hover { border-color: var(--accent); color: var(--accent); }
/* パネル内の数値・テキスト入力欄の共通見た目(スライダーは上の range 規則が受け持つ)。 */
#hud .panel input[type="number"], #hud .panel input[type="text"] {
  pointer-events: auto; width: 64px; padding: var(--space-2) var(--space-3); font-size: var(--font-s);
  border: 1px solid var(--edge); border-radius: var(--radius-m); background: var(--surface); color: var(--text);
}
#hud .settings-btn {
  pointer-events: auto; cursor: pointer; padding: var(--space-2) var(--space-4); font-size: var(--font-s);
  border: 1px solid var(--edge); border-radius: var(--radius-m); background: var(--surface); color: var(--text);
}
#hud .settings-btn:hover { background: var(--fill-1); }
#hud .settings-btn:active { background: var(--fill-2); border-color: var(--accent-soft); }
#hud-displaytime .slider-ticks { position: relative; height: 11px; margin-top: var(--space-1); }
#hud-displaytime .slider-ticks span {
  position: absolute;
  font-size: var(--font-xxs); color: var(--text-dim); white-space: nowrap;
}
#hud-frame-controls { display: none; width: 100%; pointer-events: auto; }
#hud-frame-controls .hud-frame-scroll-zone {
  max-height: min(240px, 30vh); overflow-y: auto;
  scrollbar-width: thin;
}
/* 座標系の候補が増えても、見出しの右側へボタンを押し出さない。 */
#hud-frame-controls .hud-frame-origin-zone > .hud-seg:first-child > .seg-title,
#hud-frame-controls .hud-frame-rotation-zone > .seg-title {
  flex: 0 0 100%; min-width: 0;
}
<<<<<<< HEAD
#hud-creative-settings { display: none; width: 100%; pointer-events: auto; }
/* 艦艇配置パネル(クリエイティブモード限定): MANEUVER PLAN の下、右上に縦積みする。 */
=======
#hud-logistics { display: none; width: 100%; pointer-events: auto; }
/* 艦艇配置パネル: MANEUVER PLAN の下、右上に縦積みする。 */
>>>>>>> origin/workspace4
#hud-shipplacer { display: none; width: 100%; pointer-events: auto; max-height: 70vh; overflow-y: auto; }
#hud-shipplacer .slider-field { margin-bottom: var(--space-4); }
#hud-shipplacer .slider-field .hud-seg { flex-wrap: nowrap; margin-bottom: 0; }
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
#navball .nb-pro { fill: ${C.COLOR_MARKER_PROGRADE}; }
#navball .nb-nrm { fill: ${C.COLOR_MARKER_NORMAL}; }
#navball .nb-rad { fill: ${C.COLOR_MARKER_RADIAL}; }
#mk-bore .lbl { top: auto; left: 100%; bottom: 100%; margin: 0 0 var(--space-1) var(--space-3); white-space: pre; text-align: left; font-size: var(--font-xxs); line-height: 1.2; }
.mk-planned { color: ${C.COLOR_MARKER_PLANNED}; text-shadow: 0 0 6px color-mix(in srgb, ${C.COLOR_MARKER_PLANNED} var(--glow-strong), transparent), 0 0 3px var(--bg); }
.mk-apsis { color: ${C.COLOR_MARKER_PLANNED}; text-shadow: 0 0 6px color-mix(in srgb, ${C.COLOR_MARKER_PLANNED} var(--glow-strong), transparent), 0 0 3px var(--bg); }
.mk-impact { color: var(--danger); text-shadow: 0 0 6px color-mix(in srgb, var(--danger) var(--glow-strong), transparent), 0 0 3px var(--bg); }
.mk-plantick { color: var(--text-dim); }
.mk-plantick .sym svg { display: block; }
.mk-poi { color: var(--text-strong); text-shadow: 0 0 4px var(--bg); }
.mk-poi .sym { font-size: var(--glyph-poi); }
.mk-poi .lbl { font-size: var(--font-s); border-radius: var(--radius-s); background: var(--surface-weak); }
.mk-base { color: ${C.COLOR_BASE_ORBIT_LINE}; text-shadow: 0 0 4px var(--bg); }
.mk-base .lbl { font-size: var(--font-s); border-radius: var(--radius-s); background: var(--surface-weak); border: 1px solid var(--fill-3); }
#hud .mk-poi .lbl, #hud .mk-base .lbl { margin-top: var(--space-2); padding: var(--space-1) var(--space-2); }
#hud-end {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  background: var(--scrim); backdrop-filter: blur(3px);
  flex-direction: column; text-align: center;
}
#hud-end h1 { font-size: var(--font-3xl); letter-spacing: 6px; margin-bottom: var(--space-6); }
#hud-end.win h1 { color: var(--text); text-shadow: 0 0 18px color-mix(in srgb, var(--text) var(--glow-weak), transparent); }
#hud-end.lose h1 { color: var(--accent); text-shadow: 0 0 18px color-mix(in srgb, var(--accent) var(--glow-strong), transparent); }
#hud-end .detail {
  font-size: var(--font-xl); line-height: 2; color: var(--text);
  background: var(--surface); border: 1px solid var(--edge); border-radius: var(--radius-m); padding: var(--space-6) var(--space-6);
}
#hud-end .restart { margin-top: var(--space-6); color: var(--accent-soft); font-size: var(--font-l); }
#hud-help {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  display: none; min-width: 480px; max-height: 86vh; overflow-y: auto; pointer-events: auto;
}
#hud-help table { border-collapse: collapse; width: 100%; }
#hud-help td { padding: var(--space-2) var(--space-5); color: var(--text); }
#hud-help td.key { color: var(--accent-soft); text-align: right; white-space: nowrap; }

#hud-stagestatus {
  bottom: 12px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: flex-start; gap: var(--space-6);
  text-align: left; min-width: 480px; padding: var(--space-4) var(--space-6);
}
#hud-stagestatus .t { font-size: var(--font-s); letter-spacing: 2px; color: var(--text); font-variant-numeric: tabular-nums; }
#hud-stagestatus .t.warn { color: var(--accent); }
#hud-stagestatus .k { font-size: var(--font-s); color: var(--text-dim); line-height: 1.8; white-space: nowrap; }
#hud-stagestatus .k-widgets:not(:empty) { margin-top: var(--space-3); }
#hud-stagestatus .radiators { display: flex; flex-direction: column; gap: var(--space-3); }
#hud-stagestatus .radiator-btn {
  pointer-events: auto; cursor: pointer; position: relative; overflow: hidden;
  width: 132px; padding: var(--space-2) var(--space-4); border: 1px solid var(--edge); border-radius: var(--radius-m);
  background: var(--surface); text-align: left;
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
#hud-settings {
  position: absolute; bottom: 40px; top: auto; left: 50%; transform: translateX(-50%);
  display: none; min-width: 260px; pointer-events: auto;
}
#hud-settings .srow {
  display: flex; justify-content: space-between; align-items: center; gap: var(--space-6); padding: var(--space-3) 0;
}
#hud-settings .stoggle {
  pointer-events: auto; cursor: pointer; padding: var(--space-2) var(--space-6); min-width: 46px; text-align: center;
  border: 1px solid var(--edge); border-radius: var(--radius-m); background: var(--surface); color: var(--text-dim);
}
#hud-settings .stoggle.on { border-color: var(--accent); color: var(--accent); }
#hud-settings .squit {
  margin-top: var(--space-5); text-align: center; padding: var(--space-4) var(--space-5); cursor: pointer;
  border: 1px solid var(--edge); border-radius: var(--radius-m); background: var(--surface); color: var(--text-dim); font-size: var(--font-m);
}
#hud-settings .squit:hover { border-color: var(--accent); color: var(--accent); }
#hud-settings .sclose {
  margin-top: var(--space-5); text-align: center; color: var(--text-dim); font-size: var(--font-s); cursor: pointer;
}

/* --- モバイル / 狭幅画面: パネルを縮小してタッチパッドと共存させる --- */
@media (max-width: 900px), (pointer: coarse) {
  #hud { font-size: var(--font-s); }
  #hud .panel { padding: var(--space-3) var(--space-4); line-height: 1.4; }
  #hud .panel h3 { font-size: var(--font-xs); letter-spacing: 1.5px; margin-bottom: var(--space-2); }
  #hud.map-mode #hud-orbit h3 { font-size: var(--font-xs); }
  #hud .row { gap: var(--space-4); }
  #hud .row .v { min-width: 64px; }
  #hud-combat-shelf {
    position: absolute; display: flex; left: 8px; right: 8px; top: 76px;
    gap: var(--space-3); overflow-x: auto; overflow-y: hidden; pointer-events: auto;
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
  #hud-toast { max-width: 92vw; padding: var(--space-5) var(--space-5); font-size: var(--font-l); }
  #hud .hud-dock { top: 8px; bottom: 8px; gap: var(--space-3); }
  #hud .hud-dock-left { left: 8px; width: min(220px, calc(46vw - 8px)); }
  #hud .hud-dock-right { right: 8px; width: min(260px, calc(54vw - 8px)); }
  #hud-plan { min-width: 0; max-width: none; }
  #hud-help { min-width: 0; width: 94vw; max-height: 78vh; }
  #hud-end h1 { font-size: var(--font-2xl); letter-spacing: 3px; }
  #hud-end .detail { font-size: var(--font-l); padding: var(--space-5) var(--space-6); max-width: 92vw; }
  #navball { top: 76px; width: 96px !important; height: auto !important; }
  #navball .hud-seg, #navball .hud-toggle { display: none; }
  #hud-hint {
    top: calc(50% - 40px); transform: translateX(-50%); max-height: 72px;
    overflow-y: auto; padding: var(--space-3) var(--space-5); font-size: var(--font-s);
  }
  #hud-settings { min-width: 0; width: 78vw; }
  #hud-stagestatus { bottom: 8px; width: min(62vw, 440px); min-width: 0; max-height: 62px; overflow-y: auto; padding: var(--space-3) var(--space-5); gap: var(--space-4); }
  /* このブレークポイントのドック幅に合わせて左右の隙間を再計算する。 */
  #hud-displaytime-wrap {
    bottom: 8px;
    left: calc(8px + min(220px, calc(46vw - 8px)) + 8px); right: calc(8px + min(260px, calc(54vw - 8px)) + 8px);
  }
  #hud-stagestatus .t { font-size: var(--font-s); }
  #hud-stagestatus .k { font-size: var(--font-xxs); line-height: 1.35; white-space: normal; }
  #hud-chase-reset { top: 40px; width: 28px; height: 28px; }
  #hud-chase-reset svg { width: 14px; height: 14px; }
  #hud-map-scale { right: 8px; bottom: 8px; font-size: var(--font-xxs); }
  #hud .hud-dock { top: 40px; }
}
@media (max-width: 520px) {
  #hud .hud-dock { font-size: var(--font-xxs); }
  #hud .hud-dock-left { width: calc(44vw - 8px); }
  #hud .hud-dock-right { width: calc(56vw - 8px); }
  #hud .hud-seg { gap: var(--space-2); }
  #hud .seg-btn { padding: var(--space-2) var(--space-3); font-size: var(--font-xxs); }
  #hud-displaytime .slider-ticks { display: none; }
  /* 幅が足りないので、行2はスクラバーと T+ 読み値だけ残す。 */
  #hud-displaytime .dtp-absolute { display: none; }
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
  background: var(--bg);
  font-family: var(--font-family);
  pointer-events: auto;
  /* 右上のビューバッジは全ビュー共通の枠なのでドック中も残る。その帯を避けて中身を始める。 */
  padding-top: var(--space-6);
}
/* マップ左右ドックの開閉ボタンは、背後のマップごと覆われるので出さない。 */
#hud.dock-mode .dock-toggle { display: none; }
#dock-view .dock-panel {
  flex: 1 1 auto; min-width: 0;
  display: flex; flex-direction: column; overflow: hidden;
}
#dock-view .dock-header {
  display: flex; align-items: center; gap: var(--space-5);
  padding: var(--space-5) var(--space-6); border-bottom: 1px solid var(--edge);
  flex: 0 0 auto;
  width: min(1100px, 100%); margin: 0 auto;
}
#dock-view .dock-title {
  font-size: var(--font-xl); font-weight: 700; letter-spacing: 0.12em;
  color: var(--accent); flex: 0 0 auto;
}
#dock-view .dock-tabs { display: flex; gap: var(--space-2); flex: 1; }
#dock-view .dock-tab-btn {
  padding: var(--space-2) var(--space-5); border: 1px solid var(--edge); border-radius: var(--radius-m);
  background: transparent; color: var(--text-dim); cursor: pointer;
  font-size: var(--font-m); transition: color var(--transition-fast), border-color var(--transition-fast);
}
#dock-view .dock-tab-btn:hover { color: var(--text); border-color: var(--accent-soft); }
#dock-view .dock-tab-btn.active { color: var(--accent); border-color: var(--accent); background: var(--accent-fill-weak); }
#dock-view .dock-close-btn {
  padding: var(--space-2) var(--space-5); border: 1px solid var(--edge); border-radius: var(--radius-m);
  background: transparent; color: var(--text-dim); cursor: pointer; font-size: var(--font-xl);
}
#dock-view .dock-close-btn:hover { color: var(--text); }
#dock-view .dock-status-bar {
  padding: var(--space-3) var(--space-6); border-bottom: 1px solid var(--edge);
  font-size: var(--font-m); color: var(--text-dim); flex: 0 0 auto;
  width: min(1100px, 100%); margin: 0 auto;
}
#dock-view .dock-body {
  flex: 1 1 0; overflow-y: auto; padding: var(--space-5) var(--space-6);
  scrollbar-width: thin;
  width: min(1100px, 100%); margin: 0 auto;
}
#dock-view .dock-empty { color: var(--text-dim); padding: var(--space-6); text-align: center; line-height: 1.8; }
/* Ships tab */
#dock-view .dock-ship-list { display: flex; flex-direction: column; gap: var(--space-4); }
#dock-view .dock-ship-row {
  display: flex; align-items: center; gap: var(--space-5); padding: var(--space-5) var(--space-5);
  border: 1px solid var(--edge); border-radius: var(--radius-m); cursor: pointer;
  transition: border-color var(--transition-fast);
}
#dock-view .dock-ship-row:hover { border-color: var(--accent-soft); }
#dock-view .dock-ship-row.selected { border-color: var(--accent); background: var(--accent-fill-weak); }
#dock-view .dock-ship-info { flex: 1; display: flex; flex-direction: column; gap: var(--space-1); }
#dock-view .dock-ship-name { font-size: var(--font-l); }
#dock-view .dock-ship-hp { font-size: var(--font-s); color: var(--text-dim); }
#dock-view .dock-ship-actions { display: flex; gap: var(--space-3); }
/* Parts tab */
#dock-view .dock-parts-header {
  display: flex; align-items: center; gap: var(--space-5); margin-bottom: var(--space-5);
  padding-bottom: var(--space-4); border-bottom: 1px solid var(--edge);
}
#dock-view .dock-ship-label { font-size: var(--font-m); color: var(--text-dim); flex: 1; }
#dock-view .dock-part-list { display: flex; flex-direction: column; gap: var(--space-3); }
#dock-view .dock-part-row {
  display: grid; grid-template-columns: 1fr 120px 60px auto;
  align-items: center; gap: var(--space-5); padding: var(--space-3) var(--space-5);
  border: 1px solid var(--edge); border-radius: var(--radius-m);
}
#dock-view .dock-part-info { display: flex; flex-direction: column; gap: var(--space-1); }
#dock-view .dock-part-name { font-size: var(--font-m); }
#dock-view .dock-part-type { font-size: var(--font-xs); color: var(--text-dim); }
#dock-view .dock-part-hp-bar { height: 6px; background: var(--fill-2); border-radius: var(--radius-s); overflow: hidden; }
#dock-view .dock-part-hp-fill { height: 100%; border-radius: var(--radius-s); transition: width var(--transition-slow); }
#dock-view .dock-part-hp-text { font-size: var(--font-s); color: var(--text-dim); text-align: right; }
#dock-view .dock-part-row { display: flex; flex-direction: column; gap: var(--space-3); }
#dock-view .dock-part-row-main {
  display: grid; grid-template-columns: 1fr 120px 60px auto;
  align-items: center; gap: var(--space-5);
}
#dock-view .dock-warehouse-row-main { grid-template-columns: 1fr 60px auto; }
#dock-view .dock-part-actions { display: flex; align-items: center; gap: var(--space-3); }
#dock-view .dock-part-swap-row {
  display: flex; align-items: center; gap: var(--space-4);
  padding-top: var(--space-3); border-top: 1px solid var(--edge);
  font-size: var(--font-s); color: var(--text-dim);
}
#dock-view .dock-part-swap-select {
  flex: 1; background: var(--fill-1); color: var(--text);
  border: 1px solid var(--edge); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); font-size: var(--font-s);
}
#dock-view .dock-parts-columns { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-6); }
#dock-view .dock-parts-col { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
#dock-view .dock-col-title { font-size: var(--font-m); color: var(--text-dim); border-bottom: 1px solid var(--edge); padding-bottom: var(--space-2); }
/* Shop tab */
#dock-view .dock-shop-header { margin-bottom: var(--space-5); font-size: var(--font-s); color: var(--text-dim); }
#dock-view .dock-shop-list { display: flex; flex-direction: column; gap: var(--space-3); }
#dock-view .dock-shop-item {
  display: flex; align-items: center; gap: var(--space-5); padding: var(--space-4) var(--space-5);
  border: 1px solid var(--edge); border-radius: var(--radius-m);
}
#dock-view .dock-shop-info { flex: 1; display: flex; flex-direction: column; gap: var(--space-1); }
#dock-view .dock-shop-name { font-size: var(--font-l); }
#dock-view .dock-shop-type { font-size: var(--font-xs); color: var(--text-dim); }
#dock-view .dock-shop-props { font-size: var(--font-s); color: var(--text-dim); }
#dock-view .dock-shop-stats { font-size: var(--font-xs); color: var(--text-dim); }
#dock-view .dock-shop-actions { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-2); }
#dock-view .dock-shop-price { font-size: var(--font-m); color: var(--accent); }
/* Common buttons */
#dock-view .dock-btn {
  padding: var(--space-2) var(--space-5); border: 1px solid var(--edge); border-radius: var(--radius-m);
  background: var(--accent-fill-weak); color: var(--accent); cursor: pointer;
  font-size: var(--font-s); transition: background var(--transition-fast);
}
#dock-view .dock-btn:hover:not(.disabled) { background: var(--accent-fill); }
#dock-view .dock-btn.disabled, #dock-view .dock-btn:disabled { opacity: 0.38; cursor: not-allowed; }
#dock-view .dock-btn-repair-all {
  font-size: var(--font-s); padding: var(--space-2) var(--space-5);
}
/* ===== SaveBrowser ===== */
#save-browser {
  position: fixed; inset: 0; display: none;
  align-items: center; justify-content: center;
  background: var(--scrim); backdrop-filter: blur(3px);
  font-family: var(--font-family); pointer-events: auto;
}
#save-browser .sb-panel {
  width: min(1100px, 94vw); height: min(760px, 88vh);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg); border: 1px solid var(--edge); border-radius: var(--radius-l);
}
#save-browser .sb-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--space-5) var(--space-6); border-bottom: 1px solid var(--edge); flex: 0 0 auto;
}
#save-browser .sb-title { font-size: var(--font-l); font-weight: 700; letter-spacing: 0.12em; color: var(--text); }
#save-browser .sb-close-btn {
  padding: var(--space-2) var(--space-4); border: 1px solid var(--edge); border-radius: var(--radius-m);
  background: transparent; color: var(--text-dim); cursor: pointer; font-size: var(--font-l);
}
#save-browser .sb-close-btn:hover { color: var(--text); border-color: var(--text-dim); }
#save-browser .sb-body { flex: 1 1 0; min-height: 0; display: flex; gap: 1px; background: var(--edge); }
#save-browser .sb-pane {
  flex: 1 1 0; min-width: 0; overflow-y: auto; padding: var(--space-5) var(--space-5);
  display: flex; flex-direction: column; gap: var(--space-3); background: var(--bg);
  scrollbar-width: thin;
}
#save-browser .sb-pane-slots { flex: 0 0 34%; }
#save-browser .sb-pane-title { font-size: var(--font-xs); letter-spacing: 1.5px; color: var(--text-dim); }
#save-browser .sb-empty { color: var(--text-dim); padding: var(--space-5); text-align: center; line-height: 1.7; font-size: var(--font-s); }
#save-browser .sb-slot-list { display: flex; flex-direction: column; gap: var(--space-2); }
/* アクティブ行の識別は色数を増やさず、左端 2px のオレンジ帯のみで示す。
   「見ている」行は背景をわずかに明るくするだけで区別する。 */
#save-browser .sb-slot-row {
  display: flex; align-items: center; gap: var(--space-4); padding: var(--space-3) var(--space-4) var(--space-3) var(--space-3);
  border: 1px solid var(--edge); border-left: 2px solid transparent; border-radius: var(--radius-m); cursor: pointer;
}
#save-browser .sb-slot-row.viewed { background: var(--fill-1); }
#save-browser .sb-slot-row.active { border-left-color: var(--accent); }
#save-browser .sb-slot-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
#save-browser .sb-slot-name { font-size: var(--font-s); }
#save-browser .sb-slot-meta { font-size: var(--font-xxs); color: var(--text-dim); }
#save-browser .sb-slot-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; justify-content: flex-end; }
/* 左ペインは幅が狭いので、フッターのボタンは横並びにせず縦積みにして折り返しを防ぐ。 */
#save-browser .sb-slot-footer { display: flex; flex-direction: column; gap: var(--space-3); margin-top: auto; padding-top: var(--space-3); }
#save-browser .sb-btn {
  padding: var(--space-2) var(--space-4); border: 1px solid var(--edge); border-radius: var(--radius-m);
  background: var(--fill-1); color: var(--text-dim); cursor: pointer; font-size: var(--font-xs);
  white-space: nowrap;
}
#save-browser .sb-btn:hover:not(:disabled) { background: var(--fill-2); color: var(--text); }
#save-browser .sb-btn:disabled { opacity: 0.38; cursor: not-allowed; }
#save-browser .sb-btn-sm { padding: var(--space-2) var(--space-3); }
#save-browser .sb-btn-play { color: var(--text); border-color: var(--text-dim); }
/* このパネルで唯一の「押すと今の状態が増える」操作 — 注目させるためオレンジを残す。 */
#save-browser #sb-capture-now {
  background: var(--accent-fill-weak); color: var(--accent); border-color: var(--accent-edge);
}
#save-browser #sb-capture-now:hover:not(:disabled) { background: var(--accent-fill); }
#save-browser .sb-stage-tabs { display: flex; gap: var(--space-2); }
#save-browser .sb-tab-btn {
  padding: var(--space-2) var(--space-4); border: 1px solid var(--edge); border-radius: var(--radius-m);
  background: transparent; color: var(--text-dim); cursor: pointer; font-size: var(--font-xs);
}
#save-browser .sb-tab-btn.active { color: var(--text); border-color: var(--text-dim); background: var(--fill-1); }
#save-browser .sb-snapshot-groups { display: flex; flex-direction: column; gap: var(--space-2); }
#save-browser .sb-snapshot-group-title { font-size: var(--font-xs); color: var(--text-dim); margin-top: var(--space-2); }
#save-browser .sb-snapshot-list { display: flex; flex-direction: column; gap: var(--space-2); }
#save-browser .sb-snap-card {
  display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4);
  border: 1px solid var(--edge); border-radius: var(--radius-m);
}
#save-browser .sb-snap-loadable { cursor: pointer; }
#save-browser .sb-snap-loadable:hover { border-color: var(--text-dim); background: var(--fill-1); }
#save-browser .sb-snap-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); }
#save-browser .sb-snap-name { font-size: var(--font-s); }
#save-browser .sb-snap-badge {
  font-size: var(--font-xxs); letter-spacing: .5px; padding: 1px var(--space-3); border-radius: var(--radius-l);
  border: 1px solid var(--edge); color: var(--text-dim);
}
#save-browser .sb-snap-badge-checkpoint { color: var(--text); border-color: var(--text-dim); }
#save-browser .sb-snap-row { font-size: var(--font-xs); color: var(--text-dim); }
/* HP バーは細く、満タンでもオレンジで塗らない — このパネルの主役はセーブ操作であって
   HP 表示ではないため、他の注目要素と競合しないモノトーンに留める。 */
#save-browser .sb-snap-hp-bar { height: 3px; background: var(--fill-2); border-radius: var(--radius-s); overflow: hidden; }
#save-browser .sb-snap-hp-fill { height: 100%; background: var(--text-dim); }
#save-browser .sb-snap-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
/* クリップ済み(pin)状態だけは注目対象として残す — この行の意味は「消えずに残る」なので. */
#save-browser .sb-btn-pin[data-pinned="true"] {
  background: var(--accent-fill-weak); color: var(--accent); border-color: var(--accent-edge);
}
#save-browser .sb-status { min-height: 20px; padding: var(--space-2) var(--space-5); font-size: var(--font-xs); color: var(--text-dim); border-top: 1px solid var(--edge); }
#save-browser .sb-status.error { color: var(--danger); }
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

// 縦方向の開閉トグルの字形。マップのマーカーとは字形の族を分け、開いている状態と
// 閉じている状態でどちらを向くかを画面内で一貫させる。
export const COLLAPSE_EXPANDED_GLYPH = '▾';
export const COLLAPSE_COLLAPSED_GLYPH = '▸';

export interface CollapseToggleLabels {
  readonly expandedGlyph: string;
  readonly collapsedGlyph: string;
  readonly expandedTitle: string;
  readonly collapsedTitle: string;
}

// マップビュー下部の PREDICT バー用トグルの見た目。
export const PREDICT_TOGGLE_LABELS: CollapseToggleLabels = {
  expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
  collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
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
function syncCollapseToggle(button: HTMLElement, target: HTMLElement, labels: CollapseToggleLabels): void {
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
      </td><td>並進 (前 / 後 / 左 / 右 / 上 / 下)<br><span style="font-size:var(--font-xs); color:var(--text-dim);">※ 上下は Q/E</span></td></tr>
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
  injectThemeVariables();
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

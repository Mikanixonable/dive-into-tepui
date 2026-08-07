// HUD の静的 DOM/スタイル構築。
import * as C from '../const';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { ACCENT, ACCENT_SOFT, ACCENT_RGB, ACCENT_SECONDARY, WARNING, SURFACE, EDGE, TEXT as INK, TEXT_DIM as INK_SOFT, FONT } from '../theme';


const throttleLabels = [K.throttleLow, K.throttleMid, K.throttleHigh].map((k) => k.label).join(' / ');

const STYLE = `
#hud, #hud * { box-sizing: border-box; margin: 0; padding: 0; }
#hud {
  position: fixed; inset: 0; pointer-events: none; overflow: hidden;
  font-family: ${FONT};
  color: ${INK}; user-select: none; z-index: 10;
  font-size: 13px;
}
/* --- 重なり順: マーカーは実行時に DOM 末尾へ追加されるため z-index を明示しないとパネルの上に出る。
     マーカー内優先度: 宇宙船(4) > 敵(3) > 弾薬(2) > 軌道要素・その他(1) > デフォルト(0)
     マーカー群(0-9) < 常設パネル(10) < ドックビュー(15) < トースト・ヒント(20) < 終了画面・ヘルプ(30) < ESCメニュー(40)
     ドックビューは画面全体を占めるビューなので常設パネルを覆うが、トースト・ヒントと
     システム窓(ヘルプ・ESCメニュー)はその上に出す。 */
#hud .mk { z-index: 0; }
#hud .mk-node, #hud .mk-mnode, #hud .mk-burn, #hud .mk-poi, #hud .mk-nav, #hud .mk-dir, #hud .mk-boardhit, #hud .mk-lead, #hud .mk-pro, #hud .mk-retro, #hud .mk-nrm, #hud .mk-rad, #hud .mk-tgtdir, #hud .mk-boresight { z-index: 1; }
#hud .mk-ammo { z-index: 2; }
#hud .mk-enemy, #hud .mk-target, #hud .mk-secondary-target { z-index: 3; }
#hud .mk-self { z-index: 4; }
#hud-status, #hud-orbit, #hud-target, #hud-enemies, #hud-controls,
#hud-plan, #hud-displaytime, #hud-trajframe, #hud-overview-camera, #hud-stagestatus, #hud-gear, #navball, #hud-shipplacer, #hud-object-list { z-index: 10; }
#dock-view { z-index: 15; }
#hud-toast, #hud-hint { z-index: 20; }
#hud-viewbadge { z-index: 20; }
#hud-end, #hud-help { z-index: 30; }
#hud-settings { z-index: 40; }
#hud-modal-shield { display: none; position: absolute; inset: 0; z-index: 20; pointer-events: none; background: rgba(6,7,9,.3); }
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
#hud .row { display: flex; justify-content: space-between; gap: 12px; }
#hud .row .k { color: ${INK_SOFT}; }
#hud .row .v { color: ${INK}; min-width: 90px; text-align: right; }
#hud-status { bottom: 12px; left: 12px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-status h3 { font-size: 8.8px; }
#hud-orbit { bottom: 12px; left: 252px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-orbit h3 { font-size: 8.8px; }
#hud-status .v, #hud-orbit .v { min-width: 75px; }
#hud-target { bottom: 12px; right: 252px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-target h3 { font-size: 8.8px; }
#hud.map-mode #hud-target {
  top: auto; right: 12px; bottom: 12px; left: auto;
}
#hud-enemies { bottom: 12px; right: 12px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-enemies h3 { font-size: 8.8px; }
#hud-enemies .erow { display: flex; justify-content: space-between; gap: 8px; color: ${INK_SOFT}; }
#hud-enemies .erow.tgt { color: ${WARNING}; }
#hud-object-list { max-height: 320px; overflow-y: auto; }
#hud-object-list .object-list-title-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
#hud-object-list .object-list-title-row h3 { margin-bottom: 0; border-bottom: none; padding-bottom: 0; }
#hud-object-list .object-list-section-header {
  display: block; width: 100%; text-align: left; margin: 4px 0 2px;
  padding: 3px 8px; font-size: 10px; letter-spacing: 1px;
}
#hud-object-list .object-list-section-body { padding-left: 4px; }
#hud-object-list .erow { padding: 3px 4px; color: ${INK_SOFT}; cursor: pointer; }
#hud-object-list .erow:hover { color: ${INK}; }
#hud-object-list .erow.tgt { color: ${ACCENT}; }
#hud-combat-shelf { display: contents; }

#hud-hint {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  background: ${SURFACE}; border: 1px solid rgba(${ACCENT_RGB}, 0.35); border-radius: 4px;
  padding: 8px 18px;
  color: ${ACCENT_SOFT}; font-size: 14px;
  transition: opacity 0.4s; opacity: 0; text-align: center;
}
#hud-chase-reset {
  position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
  pointer-events: auto; cursor: pointer;
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; justify-content: center; align-items: center;
  padding: 0;
  border: 1px solid ${EDGE}; background: ${SURFACE}; color: ${INK_SOFT};
  z-index: 10;
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
.mk .lbl { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); font-size: 10px; margin-top: 2px; letter-spacing: 1px; }
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
.mk-boardhit { color: ${C.COLOR_MARKER_BOARDHIT}; text-shadow: 0 0 5px rgba(255,255,255,0.9), 0 0 10px rgba(255,255,255,0.45); }
.mk-boardhit .sym { font-size: 8px; }
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
/* MAP VIEW/PREDICT/TRAJECTORY の左列は navball ウィンドウの右に置き、重なりを避ける。 */
#hud-overview-camera { display: none; width: 100%; pointer-events: auto; }
#hud-displaytime { display: none; width: 100%; pointer-events: auto; }
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
#hud-displaytime .slider-ticks { display: flex; justify-content: space-between; margin-top: 2px; }
#hud-displaytime .slider-ticks span { font-size: 9px; color: ${INK_SOFT}; white-space: nowrap; }
#hud-displaytime .slider-label { font-size: 11px; color: ${INK_SOFT}; margin-top: 4px; text-align: center; }
#hud-trajframe { display: none; width: 100%; pointer-events: auto; }
/* 艦艇配置パネル(クリエイティブモード限定): MANEUVER PLAN の下、右上に縦積みする。 */
#hud-shipplacer { display: none; width: 100%; pointer-events: auto; max-height: 70vh; overflow-y: auto; }
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
.mk-poi { color: #ffffff; text-shadow: 0 0 4px #000; }
.mk-poi .sym { font-size: 5px; }
.mk-poi .lbl { font-size: 11px; margin-top: 4px; padding: 2px 4px; border-radius: 2px; background: rgba(13,15,18,0.6); border: 1px solid rgba(255,255,255,0.2); }
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
  top: 12px; left: 50%; transform: translateX(-50%);
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
  #hud-stagestatus { top: 8px; width: min(62vw, 440px); min-width: 0; max-height: 62px; overflow-y: auto; padding: 6px 10px; gap: 8px; }
  #hud-stagestatus .t { font-size: 11px; }
  #hud-stagestatus .k { font-size: 9px; line-height: 1.35; white-space: normal; }
  #hud-chase-reset { bottom: 12px; width: 28px; height: 28px; }
  #hud-chase-reset svg { width: 14px; height: 14px; }
  #hud .hud-dock { top: 40px; }
}
@media (max-width: 520px) {
  #hud .hud-dock { font-size: 9px; }
  #hud .hud-dock-left { width: calc(44vw - 8px); }
  #hud .hud-dock-right { width: calc(56vw - 8px); }
  #hud .hud-seg { gap: 3px; }
  #hud .seg-btn { padding: 3px 5px; font-size: 9px; }
  #hud-displaytime .slider-ticks span:not(:first-child):not(:last-child) { display: none; }
  #hud-displaytime .slider-ticks span:last-child { margin-left: auto; }
  #hud-combat-shelf { top: 72px; }
  #hud-combat-shelf > .panel { flex-basis: min(168px, calc(100vw - 16px)); width: min(168px, calc(100vw - 16px)); }
}
@media (pointer: coarse) {
  #hud .hud-dock { bottom: 62px; }
  #hud-combat-shelf > .panel { max-height: 104px; }
}
@media (pointer: coarse) and (orientation: landscape) and (max-height: 500px) {
  #hud .hud-dock { bottom: 52px; }
  #hud-combat-shelf { top: 60px; }
  #hud-combat-shelf > .panel { max-height: 82px; }
  #hud-stagestatus { max-height: 46px; }
  #navball { top: 60px; width: 72px !important; }
  #hud-chase-reset { bottom: 6px; }
}
@media (orientation: landscape) and (max-height: 500px) {
  #hud-combat-shelf { top: 60px; }
  #hud-combat-shelf > .panel { max-height: 82px; }
  #hud-stagestatus { max-height: 46px; }
}
/* ===== DockView ===== */
.dock-view-overlay {
  position: fixed; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.75); backdrop-filter: blur(6px);
  font-family: ${FONT};
  pointer-events: auto;
}
.dock-panel {
  background: ${SURFACE}; border: 1px solid ${EDGE}; border-radius: 10px;
  width: min(900px,94vw); max-height: 82vh;
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 8px 40px rgba(0,0,0,0.7);
}
.dock-header {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px; border-bottom: 1px solid ${EDGE};
  flex: 0 0 auto;
}
.dock-title {
  font-size: 15px; font-weight: 700; letter-spacing: 0.12em;
  color: ${ACCENT}; flex: 0 0 auto;
}
.dock-tabs { display: flex; gap: 4px; flex: 1; }
.dock-tab-btn {
  padding: 4px 14px; border: 1px solid ${EDGE}; border-radius: 4px;
  background: transparent; color: ${INK_SOFT}; cursor: pointer;
  font-size: 12px; transition: color .15s, border-color .15s;
}
.dock-tab-btn:hover { color: ${INK}; border-color: ${ACCENT_SOFT}; }
.dock-tab-btn.active { color: ${ACCENT}; border-color: ${ACCENT}; background: rgba(${ACCENT_RGB},.08); }
.dock-close-btn {
  padding: 4px 10px; border: 1px solid ${EDGE}; border-radius: 4px;
  background: transparent; color: ${INK_SOFT}; cursor: pointer; font-size: 14px;
}
.dock-close-btn:hover { color: ${INK}; }
.dock-status-bar {
  padding: 5px 16px; border-bottom: 1px solid ${EDGE};
  font-size: 12px; color: ${INK_SOFT}; flex: 0 0 auto;
}
.dock-body {
  flex: 1 1 0; overflow-y: auto; padding: 12px 16px;
  scrollbar-width: thin;
}
.dock-empty { color: ${INK_SOFT}; padding: 24px; text-align: center; line-height: 1.8; }
/* Ships tab */
.dock-ship-list { display: flex; flex-direction: column; gap: 8px; }
.dock-ship-row {
  display: flex; align-items: center; gap: 12px; padding: 10px 12px;
  border: 1px solid ${EDGE}; border-radius: 6px; cursor: pointer;
  transition: border-color .15s;
}
.dock-ship-row:hover { border-color: ${ACCENT_SOFT}; }
.dock-ship-row.selected { border-color: ${ACCENT}; background: rgba(${ACCENT_RGB},.06); }
.dock-ship-info { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.dock-ship-name { font-size: 13px; }
.dock-ship-hp { font-size: 11px; color: ${INK_SOFT}; }
.dock-ship-actions { display: flex; gap: 6px; }
/* Parts tab */
.dock-parts-header {
  display: flex; align-items: center; gap: 12px; margin-bottom: 10px;
  padding-bottom: 8px; border-bottom: 1px solid ${EDGE};
}
.dock-ship-label { font-size: 12px; color: ${INK_SOFT}; flex: 1; }
.dock-part-list { display: flex; flex-direction: column; gap: 6px; }
.dock-part-row {
  display: grid; grid-template-columns: 1fr 120px 60px auto;
  align-items: center; gap: 10px; padding: 6px 10px;
  border: 1px solid ${EDGE}; border-radius: 4px;
}
.dock-part-info { display: flex; flex-direction: column; gap: 2px; }
.dock-part-name { font-size: 12px; }
.dock-part-type { font-size: 10px; color: ${INK_SOFT}; }
.dock-part-hp-bar { height: 6px; background: rgba(255,255,255,.08); border-radius: 3px; overflow: hidden; }
.dock-part-hp-fill { height: 100%; border-radius: 3px; transition: width .3s; }
.dock-part-hp-text { font-size: 11px; color: ${INK_SOFT}; text-align: right; }
/* Shop tab */
.dock-shop-header { margin-bottom: 10px; font-size: 11px; color: ${INK_SOFT}; }
.dock-shop-list { display: flex; flex-direction: column; gap: 6px; }
.dock-shop-item {
  display: flex; align-items: center; gap: 12px; padding: 8px 12px;
  border: 1px solid ${EDGE}; border-radius: 4px;
}
.dock-shop-info { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.dock-shop-name { font-size: 13px; }
.dock-shop-type { font-size: 10px; color: ${INK_SOFT}; }
.dock-shop-props { font-size: 11px; color: ${INK_SOFT}; }
.dock-shop-stats { font-size: 10px; color: ${INK_SOFT}; }
.dock-shop-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.dock-shop-price { font-size: 12px; color: ${ACCENT}; }
/* Common buttons */
.dock-btn {
  padding: 4px 12px; border: 1px solid ${EDGE}; border-radius: 4px;
  background: rgba(${ACCENT_RGB},.08); color: ${ACCENT}; cursor: pointer;
  font-size: 11px; transition: background .15s;
}
.dock-btn:hover:not(.disabled) { background: rgba(${ACCENT_RGB},.18); }
.dock-btn.disabled, .dock-btn:disabled { opacity: 0.38; cursor: not-allowed; }
.dock-btn-repair-all {
  font-size: 11px; padding: 4px 12px;
}
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
  svgOverlay: SVGSVGElement;
  els: Map<string, HTMLElement>;
}

/** 動的に生成されるマップ系パネルの配置先を返す。 */
export function hudDock(root: HTMLElement, side: 'left' | 'right'): HTMLElement {
  const id = `hud-dock-${side}`;
  return root.querySelector<HTMLElement>(`#${id}`) ?? root;
}

function syncDockToggle(button: HTMLElement, dock: HTMLElement, side: 'left' | 'right'): void {
  const expandedGlyph = side === 'left' ? '◀' : '▶';
  const collapsedGlyph = side === 'left' ? '▶' : '◀';
  const collapsed = dock.classList.contains('collapsed');
  button.textContent = collapsed ? collapsedGlyph : expandedGlyph;
  button.setAttribute('aria-expanded', String(!collapsed));
  button.title = `${side === 'left' ? '左' : '右'}マップパネルを${collapsed ? '開く' : '閉じる'}`;
}

export function resetHudDocks(root: HTMLElement): void {
  for (const side of ['left', 'right'] as const) {
    const dock = root.querySelector<HTMLElement>(`#hud-dock-${side}`);
    const button = root.querySelector<HTMLElement>(`#hud-dock-toggle-${side}`);
    if (!dock || !button) continue;
    dock.classList.remove('collapsed');
    syncDockToggle(button, dock, side);
  }
}

export function syncNavballPlacement(root: HTMLElement, mapMode: boolean): void {
  const navball = root.querySelector<HTMLElement>('#navball');
  const target = mapMode ? root.querySelector<HTMLElement>('#hud-dock-left') : root;
  if (navball && target && navball.parentElement !== target) target.appendChild(navball);
}

export function syncHudModalState(): void {
  const helpOpen = getComputedStyle(document.getElementById('hud-help')!).display !== 'none';
  const settingsOpen = getComputedStyle(document.getElementById('hud-settings')!).display !== 'none';
  const open = helpOpen || settingsOpen;
  document.body.classList.toggle('hud-modal-open', open);
  if (open) window.dispatchEvent(new Event('tepui-release-touch-inputs'));
}

function buildDockToggle(root: HTMLElement, dock: HTMLElement, side: 'left' | 'right'): void {
  const button = el('button', `hud-dock-toggle-${side}`, root, 'dock-toggle');
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('click', () => {
    dock.classList.toggle('collapsed');
    syncDockToggle(button, dock, side);
  });
  syncDockToggle(button, dock, side);
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
function buildInfoPanels(root: HTMLElement): void {
  const shelf = el('div', 'hud-combat-shelf', root);

  // SHIP STATUS パネル
  const status = el('div', 'hud-status', shelf, 'panel');
  status.innerHTML = `
    <h3>SHIP STATUS</h3>
    <div class="row"><span class="k">MET</span><span class="v" data-id="met"></span></div>
    <div class="row"><span class="k">時間加速</span><span class="v" data-id="sim-speed"></span></div>
    <div class="row"><span class="k">NODE WARP</span><span class="v" data-id="node-warp-remain">—</span></div>

    <div class="row"><span class="k">RCS制動 [${K.rcsDampToggle.label}]</span><span class="v" data-id="rcs"></span></div>
    <div class="row"><span class="k">並進出力 [${K.throttleLow.label}-${K.throttleHigh.label}]</span><span class="v" data-id="throttle"></span></div>
    <div class="row"><span class="k">微調整 [${K.fineAttitudeToggle.label}]</span><span class="v" data-id="fine"></span></div>
    <div class="row"><span class="k">進行方向ホールド [${K.progradeHoldToggle.label}]</span><span class="v" data-id="prohold"></span></div>
    <div class="row"><span class="k">視点のRCS追従 [${K.followAttitudeToggle.label}]</span><span class="v" data-id="camfollow"></span></div>
    <div class="row"><span class="k">弾薬 AMMO</span><span class="v" data-id="ammo"></span></div>`;

  // ORBIT パネル
  const orbit = el('div', 'hud-orbit', shelf, 'panel');
  orbit.innerHTML = `
    <h3>ORBIT</h3>
    <div class="row"><span class="k">高度 ALT</span><span class="v" data-id="alt"></span></div>
    <div class="row"><span class="k">速度 VEL</span><span class="v" data-id="spd"></span></div>
    <div class="row"><span class="k">遠地点 AP</span><span class="v" data-id="ap"></span></div>
    <div class="row"><span class="k">近地点 PE</span><span class="v" data-id="pe"></span></div>
    <div class="row"><span class="k">傾斜角 INC</span><span class="v" data-id="inc"></span></div>
    <div class="row"><span class="k">周期 PRD</span><span class="v" data-id="prd"></span></div>
    <div class="row"><span class="k">動圧 Q</span><span class="v" data-id="qdyn"></span></div>
    <div class="row"><span class="k">機体温度</span><span class="v" data-id="temp"></span></div>`;

  // TARGET パネル
  const target = el('div', 'hud-target', shelf, 'panel');
  target.innerHTML = `
    <h3 data-id="tgtname">TARGET</h3>
    <div data-id="tgtbody"></div>`;

  // CONTACTS パネル
  const enemies = el('div', 'hud-enemies', shelf, 'panel');
  enemies.innerHTML = `
    <h3>CONTACTS <span data-id="count"></span></h3>
    <div data-id="elist"></div>`;
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
      <tr><td class="key">${throttleLabels}</td><td>並進出力の切替 (弱 / 中 / 強)。並進 6 方向に共通で適用される</td></tr>
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

// HUD のスタイル・各パネル・SVG オーバーレイを一括構築し、DOM 参照をまとめて返す。
export function buildHudDom(): HudDomRefs {
  injectStyle();
  const root = el('div', 'hud', document.body);
  const svgOverlay = buildSvgOverlay(root);
  el('div', 'hud-dock-left', root, 'hud-dock hud-dock-left');
  const rightDock = el('div', 'hud-dock-right', root, 'hud-dock hud-dock-right');
  const leftDock = root.querySelector<HTMLElement>('#hud-dock-left')!;
  buildDockToggle(root, leftDock, 'left');
  buildDockToggle(root, rightDock, 'right');

  // 常設パネル群を組む。
  buildInfoPanels(root);
  buildChaseReset(root);
  el('div', 'hud-modal-shield', root);

  el('div', 'hud-hint', root);
  el('div', 'hud-toast', root);

  buildHelpPanel(root);

  el('div', 'hud-end', root);

  const els = collectDataIdElements(root);
  return { root, svgOverlay, els };
}

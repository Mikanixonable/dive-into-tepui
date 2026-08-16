// HUD の骨格 CSS: #hud 自体・レイヤ・マーカー面の重なり順・パネル外枠(PanelShell)の
// 共通部・左右レール(マップ/戦闘ビューそれぞれ自身のレール)・画面固定バッジ。
// 個々のパネルの中身は panel-content-style.ts が持つ。
import * as C from '../const';
import { OVERLAY_LAYER_STYLE } from './overlay-layer';
import { MQ_COARSE, MQ_COARSE_SHORT, MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT } from './breakpoints';

export const SKELETON_STYLE = `
#hud, #hud * { box-sizing: border-box; margin: 0; padding: 0; }
#hud {
  position: fixed; inset: 0; pointer-events: none; overflow: hidden;
  font-family: var(--font-family);
  /* body 直下の他要素(タッチ操作パッド・天球グリッドのラベル層)との前後関係を決める。
     #hud の内側の重なり順は overlay-layer.ts のレイヤが持つ。 */
  color: var(--text); color-scheme: var(--theme-tone); user-select: text; z-index: 10;
  font-size: var(--font-l);
}
/* ステージ選択画面より前面に出す既存の一時停止メニュー。タイトル中だけ付く。 */
#hud.title-menu-open { z-index: 110; }
/* 読み取りたい数値は選択できるようにするが、操作部品とマーカーは対象外にする —
   ボタンの連打やカメラドラッグのたびにラベルが選択されると操作の邪魔になる。 */
#hud .ctx-menu-item,
#hud .mk, #hud .rail-toggle, #hud-chase-reset,
#hud-viewbadge .vb-view-btn { user-select: none; }
${OVERLAY_LAYER_STYLE}
/* #hud 直下の兄弟同士の重なり順は overlay-layer.ts のレイヤが持つ。
   マーカー内優先度: タッチ長押し(5) > 宇宙船(4) > 敵(3) > 弾薬(2) > 軌道要素・その他(1) > デフォルト(0) */
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
#hud .mk-longpress { z-index: 5; }
#hud-overlay-shield { display: none; position: absolute; inset: 0; pointer-events: none; background: var(--shade-1); }
body.hud-overlay-modal-open #hud-overlay-shield { display: block; }
body.hud-overlay-modal-open #touch-ui { display: none; }

/* ゲーム状態由来の表示/非表示。パネルの折りたたみ(利用者の好み)とは別軸。 */
#hud .hidden { display: none !important; }
#hud .hud-world-root {
  position: absolute; inset: 0; display: none; pointer-events: none;
}
#hud .hud-world-root.active { display: block; }
#hud .panel {
  position: absolute; background: var(--glass-quiet);
  border: 0; border-radius: var(--radius-panel);
  padding: var(--space-5); line-height: 1.5;
  box-shadow: 0 12px 32px var(--shade-1);
  backdrop-filter: blur(14px) saturate(82%);
}
#hud .panel h3 {
  font-size: var(--font-s); letter-spacing: 0.06em; color: var(--title);
  border: 0; margin-bottom: var(--space-4); padding: 0;
  font-weight: 600; text-transform: none;
}
/* PanelShell: 見出し行に折りたたみトグルを添える共通外枠。 */
#hud .panel-shell-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
#hud .panel-shell-head h3 { flex: 1 1 auto; min-width: 0; }
#hud .panel-shell-collapse {
  flex: 0 0 auto; width: 24px; height: 24px; background: transparent; border: 0;
  border-radius: var(--radius-micro); color: var(--muted); font: inherit; cursor: pointer; pointer-events: auto;
}
#hud .panel-shell-collapse:hover { color: var(--accent-near); background: var(--surface-2); }
#hud .panel-shell-collapse:focus-visible { outline: 2px solid var(--accent-near); outline-offset: 2px; }
#hud .panel-shell-body.collapsed { display: none !important; }
#hud .row { display: flex; justify-content: space-between; gap: var(--space-5); }
#hud .row .k { color: var(--text-dim); }
#hud .row .v {
  color: var(--text); min-width: 90px; text-align: right; font-variant-numeric: tabular-nums;
}
/* パネル内の数値・テキスト入力欄(ValueInput)の既定幅。見た目自体は widgets/ の .w-input が持つ。 */
#hud .panel input[type="number"], #hud .panel input[type="text"] { width: 64px; }

/* マップ系パネルは左右のレール内で通常フローに積む。内容が増えても他の
   パネルを押し退けるだけで、固定座標による重なりを起こさない。 */
#hud .hud-rail {
  position: absolute; top: 48px; bottom: 12px;
  display: flex; flex-direction: column; align-items: stretch; gap: 7px;
  pointer-events: none; min-height: 0; overflow-x: hidden; overflow-y: auto;
  scrollbar-width: thin; overscroll-behavior: contain;
}
#hud .hud-rail > .panel { position: relative; inset: auto; transform: none; pointer-events: auto; flex: 0 0 auto; }
#hud .hud-rail-left { left: 12px; width: var(--rail-w-left); }
#hud .hud-rail-right { right: 12px; width: var(--rail-w-right); }
/* マップモード中はレールの空き領域を掴んでもタッチスクロールできる —
   カメラドラッグとの競合はレールが奪ってよい(レールは置き場であって 3D 操作面ではない)。
   常時 auto にすると、マップ以外でパネルが1枚も無い空のレールが背後のカメラ操作を阻害する。 */
#hud .hud-map-root.active .hud-rail { pointer-events: auto; touch-action: pan-y; }
#hud .rail-toggle {
  width: 30px; height: 30px; border: 0; border-radius: var(--radius-control);
  background: var(--surface-2); color: var(--accent); cursor: pointer; pointer-events: auto;
  transition: color var(--transition-fast), background var(--transition-fast);
}
#hud .rail-toggle:hover { color: var(--accent-near); background: var(--surface-3); }
#hud .rail-toggle:focus-visible {
  outline: 2px solid var(--accent-near); outline-offset: 2px;
}
#hud .rail-toggle { display: none; position: absolute; top: 8px; z-index: 20; }
#hud:not(.base-mode) .rail-toggle { display: block; }
#hud .hud-world-root .rail-toggle-left { left: 8px; }
#hud .hud-world-root .rail-toggle-right { right: 8px; }
/* 左右ドックの収納はマップ/戦闘の両ビューで使う。基地ビューではトグルごと隠す。 */
#hud:not(.base-mode) .hud-rail.collapsed { width: 0; }
#hud:not(.base-mode) .hud-rail.collapsed > .panel { display: none !important; }
/* 基地ビュー(造船ドック)が背後のマップごとレールを覆うので、開閉トグルは出さない。 */
#hud.base-mode .rail-toggle { display: none; }

/* 画面固定バッジ(④): マップの縮尺・視点リセット・グローバルステータス・トースト等。 */
/* マップモードでは #hud-rail-toggle-left(left:8px, 26px 角)がこの位置に重なるので、
   その右端(8+26=34px)より確実に外側へ避けておく。 */
#hud-viewbadge {
  position: absolute; top: 8px; left: 48px;
  display: flex; align-items: center; gap: var(--space-3);
  padding: var(--space-2) var(--space-4); border-radius: var(--radius-control);
  background: var(--glass-quiet); backdrop-filter: blur(14px) saturate(82%);
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: 1.2px;
  white-space: nowrap; opacity: 0.9;
}
#hud-viewbadge .vb-title { color: var(--accent); }
#hud-viewbadge .vb-mode { color: var(--text-dim); }
/* span. まで指定して .w-btn 側の font-size/padding/background より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#hud-viewbadge span.vb-view-btn {
  background: var(--surface-2);
  border-radius: var(--radius-micro); padding: var(--space-1) var(--space-3);
  color: var(--text-dim); font: inherit; letter-spacing: inherit;
}
#hud-viewbadge span.vb-view-btn:hover { color: var(--text); border-color: var(--accent-soft); }
#hud-simulation-status {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  pointer-events: auto;
  padding: var(--space-3) var(--space-5); border-radius: 0 0 var(--radius-panel) var(--radius-panel);
  background: var(--glass-quiet); border: 0; backdrop-filter: blur(14px) saturate(82%);
  font-size: var(--font-s); letter-spacing: 1px; font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  display: flex; align-items: center; gap: var(--space-4); white-space: nowrap;
  max-width: calc(100vw - var(--space-6) * 2); overflow-x: auto; scrollbar-width: none;
}
#hud-simulation-status .v { color: var(--text); }
#hud-simulation-status .gs-sep { color: var(--edge); }
#hud-map-scale {
  position: absolute; right: 12px; bottom: 12px; display: none; pointer-events: none;
  padding: var(--space-2) var(--space-4) var(--space-3); border: 0; border-radius: var(--radius-control);
  background: var(--glass-quiet); backdrop-filter: blur(14px) saturate(82%);
  color: var(--text-dim); font-size: var(--font-xxs); line-height: 1.1;
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
#hud-hint {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  background: var(--glass-focus); border: 0; border-radius: var(--radius-panel);
  padding: var(--space-4) var(--space-6);
  color: var(--accent-soft); font-size: var(--font-xl);
  box-shadow: 0 16px 48px var(--shade-1); backdrop-filter: blur(20px) saturate(82%);
  transition: opacity var(--transition-slow); opacity: 0; text-align: center;
}
#hud-chase-reset {
  position: absolute; top: 40px; left: 50%; transform: translateX(-50%);
  pointer-events: auto; cursor: pointer;
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; justify-content: center; align-items: center;
  padding: 0;
  border: 0; background: var(--glass-quiet); color: var(--text-dim);
  backdrop-filter: blur(14px) saturate(82%);
}
#hud-chase-reset:hover { background: var(--surface-2); color: var(--accent-near); }
#hud-chase-reset:focus-visible { outline: 2px solid var(--accent-near); outline-offset: 2px; }
#hud-toast {
  position: absolute; top: 18%; left: 50%; transform: translateX(-50%);
  background: var(--glass-focus); border: 0; border-radius: var(--radius-panel); padding: var(--space-5) var(--space-6);
  color: var(--text); font-size: var(--font-xl); text-align: center;
  box-shadow: 0 16px 48px var(--shade-1); backdrop-filter: blur(20px) saturate(82%);
  transition: opacity var(--transition-slow); opacity: 0; line-height: 1.8;
}
#hud .sim-speed-hot { color: var(--accent); }
#hud .mode-tgt { color: var(--accent); }
#hud .warn-hot { color: var(--danger); }

/* マーカー面(層)の意匠。位置固定バッジ・マップパネルとは異なる世界座標投影の側。 */
.mk {
  position: absolute; transform: translate(-50%, -50%);
  text-align: center; white-space: nowrap; text-shadow: 0 0 4px var(--bg), 0 0 2px var(--bg);
  width: 24px; height: 24px; transition: opacity 300ms ease;
}
.mk .sym { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: var(--glyph-base); line-height: 1; transition: opacity 200ms ease; }
.mk .lbl { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); font-size: var(--font-xs); letter-spacing: 1px; transition: opacity 200ms ease; }
.mk .sym.priority-hidden, .mk .lbl.priority-hidden { opacity: 0; pointer-events: none; }
#hud .mk .lbl { margin-top: var(--space-1); }
.mk-enemy .lbl, .mk-target .lbl { font-size: var(--font-xxs); line-height: 1.2; white-space: pre; }
.mk-dir { color: var(--text-strong); font-size: var(--font-s); text-shadow: none; }
#hud .mk-bearing-triangle .sym { font-size: var(--glyph-2-3); }
#hud .mk-ally-dir .sym { font-size: var(--glyph-1-3); }
.mk-boresight { color: var(--text-strong); font-size: var(--glyph-boresight); }
.mk-boresight .sym { width: 48px; height: 48px; }
.mk-boresight .lbl { top: -14px; left: 19px; transform: none; font-size: var(--font-xxs); letter-spacing: .4px; color: var(--text-dim); text-shadow: 0 0 3px var(--bg); }
.mk-target { color: var(--accent); }
.mk-secondary-target { color: var(--accent-secondary); }
.mk-enemy { color: var(--text-strong); }
.mk-lead { color: var(--accent); }
.mk-pro { color: var(--axis-prograde); }
.mk-retro { color: var(--axis-prograde); }
.mk-nrm { color: var(--axis-normal); }
.mk-rad { color: var(--axis-radial); }
.mk-tgtdir { color: ${C.COLOR_MARKER_TGTDIR}; }
.mk-node { color: ${C.COLOR_MARKER_NODE}; }
.mk-boardpass { color: ${C.COLOR_MARKER_BOARDPASS}; }
.mk-boardpass .sym { font-size: var(--font-xxs); }
.mk-mnode { color: var(--accent-soft); }
.mk-mnode .lbl { white-space: pre; line-height: 1.25; }
#hud .mk-mnode .lbl, #hud .mk-burn .lbl { margin-top: var(--space-2); }
.mk-burn { color: var(--accent); }
.mk-self { color: ${C.COLOR_MARKER_SELF}; }
.mk-planet-nearby-label .lbl { margin-top: 18px; font-size: var(--font-xxs); white-space: nowrap; }
.mk-ammo { color: var(--accent-soft); }
.mk-boresight .lbl { top: auto; left: 100%; bottom: 100%; margin: 0 0 var(--space-1) var(--space-3); white-space: pre; text-align: left; font-size: var(--font-xxs); line-height: 1.2; }
.mk-planned { color: ${C.COLOR_MARKER_PLANNED}; }
.mk-apsis { color: ${C.COLOR_MARKER_PLANNED}; }
.mk-impact { color: var(--danger); }
.mk-plantick { color: var(--text-dim); }
.mk-plantick .sym svg { display: block; }
.mk-poi { color: var(--text-strong); text-shadow: 0 0 4px var(--bg); }
.mk-poi .sym { font-size: var(--glyph-poi); }
.mk-poi .lbl { font-size: var(--font-s); border-radius: var(--radius-s); background: var(--surface-weak); }
.mk-poi.mk-lagrange .lbl { font-size: calc(var(--font-s) * 0.7); white-space: pre; line-height: 1.25; text-align: center; }
.mk-poi.mk-lagrange .lbl::first-line { font-size: var(--font-s); }
.mk-base { color: ${C.COLOR_BASE_ORBIT_LINE}; text-shadow: 0 0 4px var(--bg); }
#hud .mk-poi .lbl { margin-top: var(--space-2); padding: var(--space-1) var(--space-2); }
.mk-longpress { width: 40px; height: 40px; }
.mk-longpress .sym { border: 2px solid var(--accent); border-radius: 50%; box-sizing: border-box; }

/* --- モバイル / 狭幅画面: パネルを縮小してタッチパッドと共存させる --- */
@media ${MQ_MEDIUM_DOWN} {
  #hud { font-size: var(--font-s); }
  #hud .panel { padding: var(--space-3) var(--space-4); line-height: 1.4; }
  #hud .panel h3 { font-size: var(--font-xs); letter-spacing: 1.5px; margin-bottom: var(--space-2); }
  #hud .row { gap: var(--space-4); }
  #hud .row .v { min-width: 64px; }
  #hud:not(.map-ui-active) #hud-viewbadge { display: none; }
  #hud-hint { bottom: auto; top: 26%; max-width: 92vw; white-space: normal; }
  #hud-toast { max-width: 92vw; padding: var(--space-5) var(--space-5); font-size: var(--font-l); }
  #hud .hud-rail { top: 8px; bottom: 8px; gap: var(--space-3); }
  #hud .hud-rail-left { left: 8px; }
  #hud .hud-rail-right { right: 8px; }
  #hud-hint {
    top: calc(50% - 40px); transform: translateX(-50%); max-height: 72px;
    overflow-y: auto; padding: var(--space-3) var(--space-5); font-size: var(--font-s);
  }
  #hud-chase-reset { top: 40px; width: 28px; height: 28px; }
  #hud-chase-reset svg { width: 14px; height: 14px; }
  #hud-map-scale { right: 8px; bottom: 8px; font-size: var(--font-xxs); }
  #hud .hud-rail { top: 40px; }
}
@media ${MQ_COMPACT} {
  #hud .hud-rail { font-size: var(--font-xxs); }
#hud .hud-map-root.active .hud-rail { bottom: calc(28vh + 16px); bottom: calc(28dvh + 16px); }
}
@media ${MQ_COARSE} {
  #hud .hud-rail { bottom: 62px; }
  #hud-map-scale { bottom: 62px; }
}
@media ${MQ_COARSE_SHORT} {
  #hud .hud-rail { bottom: 52px; }
  #hud-chase-reset { top: 34px; }
}
@media ${MQ_SHORT} {
  #hud-map-scale { bottom: 52px; }
  /* 右レールは STATUS の下に CONTACTS が積まれる2段構成(TARGET はロック時のみ表示) —
     short 高さでは画面中央近くまで達するので、ヒントの上端をその下へ逃がす。40px は
     この高さで有効な .hud-rail 自身の top(MQ_MEDIUM_DOWN)、--combat-panel-max-h の
     2枚分 + 間の --space-3 が両パネルとも上限いっぱいに伸びた最悪ケースの下端、
     15px はその下端からの余白 — --combat-panel-max-h が変わってもヒントはこの式で
     追従する。 */
  #hud-hint { top: calc(40px + var(--combat-panel-max-h) * 2 + var(--space-3) + 15px); }
}
@media (prefers-reduced-motion: reduce) {
  #hud *, #hud *::before, #hud *::after {
    animation-duration: 0.001ms !important; animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important; scroll-behavior: auto !important;
  }
}
`;

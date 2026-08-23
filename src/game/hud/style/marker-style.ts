// HUD 3D スクリーン投影マーカー CSS (.mk, 各種マーカーシンボル, ラベル, 重なり順).
import * as C from '../../const';

export const MARKER_STYLE = `
/* マーカー層 Z-Index トークン定義 */
#hud {
  --z-mk-base: 0;
  --z-mk-node: 1;
  --z-mk-ammo: 2;
  --z-mk-enemy: 3;
  --z-mk-self: 4;
  --z-mk-longpress: 5;

  --mk-scale-vessel: 0.6667;
  --mk-scale-element: 0.5;
  --mk-scale-poi: 0.8;
  --mk-scale-lagrange: 1.5;
}

#hud .mk { z-index: var(--z-mk-base); }
#hud .mk-node, #hud .mk-mnode, #hud .mk-burn, #hud .mk-poi, #hud .mk-base, #hud .mk-nav, #hud .mk-dir, #hud .mk-bearing-triangle, #hud .mk-boardpass, #hud .mk-lead, #hud .mk-pro, #hud .mk-retro, #hud .mk-nrm, #hud .mk-rad, #hud .mk-tgtdir, #hud .mk-boresight { z-index: var(--z-mk-node); }
#hud .mk-ammo { z-index: var(--z-mk-ammo); }
#hud .mk-enemy, #hud .mk-target, #hud .mk-ally { z-index: var(--z-mk-enemy); }
#hud .mk-self { z-index: var(--z-mk-self); }
#hud .mk-longpress { z-index: var(--z-mk-longpress); }

/* マーカーコンテナ共通構造 */
.mk {
  position: absolute; transform: translate(-50%, -50%);
  text-align: center; white-space: nowrap; text-shadow: 0 0 4px var(--bg), 0 0 2px var(--bg);
  width: 24px; height: 24px; transition: opacity 300ms ease;
}
.mk .sym {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: var(--glyph-base); line-height: 1; transition: opacity 200ms ease; transform-origin: 50% 50%;
}
.mk .sym svg { display: block; width: 100%; height: 100%; }

/* インライン SVG 寸法（目盛ドット等）を優先保持するクラス */
.mk-raw-svg .sym svg, .mk-plantick .sym svg { display: block; width: auto !important; height: auto !important; }

.mk .lbl {
  position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
  font-size: var(--font-xs); letter-spacing: 1px; transition: opacity 200ms ease;
}
.mk .sym.priority-hidden, .mk .lbl.priority-hidden { opacity: 0; pointer-events: none; }
#hud .mk .lbl { margin-top: var(--space-1); }

/* 各種エンティティ・要素別スタイル */
.mk-enemy .lbl, .mk-target .lbl, .mk-ally .lbl, .mk-self .lbl { font-size: var(--font-xxs); line-height: 1.2; white-space: pre; }
.mk-dir { color: var(--text-strong); font-size: var(--font-s); text-shadow: none; }
#hud .mk-bearing-triangle .sym { font-size: var(--glyph-2-3); }
#hud .mk-ally-dir .sym { font-size: var(--glyph-1-3); }

.mk-boresight { color: var(--text-strong); font-size: var(--glyph-boresight); }
.mk-boresight .sym { width: 48px; height: 48px; }
.mk-boresight .lbl {
  top: auto; left: 100%; bottom: 100%; margin: 0 0 var(--space-1) var(--space-3);
  white-space: pre; text-align: left; font-size: var(--font-xxs); line-height: 1.2;
}

.mk-target { color: var(--color-signal); }
.mk-enemy { color: var(--text-strong); }
.mk-ally { color: ${C.COLOR_MARKER_ALLY}; }
.mk-lead { color: var(--color-primary); }
.mk-pro { color: var(--axis-prograde); }
.mk-retro { color: var(--axis-prograde); }
.mk-nrm { color: var(--axis-normal); }
.mk-rad { color: var(--axis-radial); }
.mk-tgtdir { color: ${C.COLOR_MARKER_TGTDIR}; }
.mk-node { color: ${C.COLOR_MARKER_NODE}; }
.mk-boardpass { color: ${C.COLOR_MARKER_BOARDPASS}; }
.mk-boardpass .sym { font-size: var(--font-xxs); }
.mk-mnode { color: var(--color-primary-hover); }
.mk-mnode .lbl { white-space: pre; line-height: 1.25; }
#hud .mk-mnode .lbl, #hud .mk-burn .lbl { margin-top: var(--space-2); }
.mk-burn { color: var(--color-primary); }
.mk-self { color: ${C.COLOR_MARKER_SELF}; }
.mk-ammo { color: var(--text-dim); }
.mk-planned { color: ${C.COLOR_MARKER_PLANNED}; }
.mk-apsis { color: ${C.COLOR_MARKER_PLANNED}; }
.mk-impact { color: var(--color-error); }
.mk-plantick { color: var(--text-dim); }

.mk-poi { color: var(--text-strong); text-shadow: 0 0 4px var(--bg); }
.mk-poi:not(.mk-lagrange) .sym { font-size: calc(var(--glyph-poi) * var(--mk-scale-poi)); }
.mk-poi.mk-lagrange .sym { font-size: calc(var(--glyph-poi) * var(--mk-scale-lagrange)); }
.mk-poi .lbl { font-size: var(--font-s); border-radius: var(--radius-s); background: var(--surface-weak); white-space: pre; line-height: 1.25; text-align: center; display: inline-flex; flex-direction: column; align-items: flex-start; }
.mk-poi:not(.mk-lagrange) .lbl { font-size: calc(var(--font-s) * 0.85); }
.mk-poi:not(.mk-lagrange) .lbl .lbl-main { align-self: center; font-size: var(--font-s); font-weight: 500; color: var(--text-strong); }
.mk-poi:not(.mk-lagrange) .lbl .lbl-sub { font-size: calc(var(--font-s) * 0.78); color: var(--text-dim); opacity: 0.85; line-height: 1.2; white-space: nowrap; text-align: left; font-weight: normal; }
.mk-poi.mk-lagrange .lbl { font-size: calc(var(--font-s) * 0.7); white-space: pre; line-height: 1.25; text-align: center; }
.mk-poi.mk-lagrange .lbl::first-line { font-size: var(--font-s); }
#hud .mk-poi .lbl { margin-top: var(--space-2); padding: var(--space-1) var(--space-2); }

.mk-base { color: ${C.COLOR_BASE_ORBIT_LINE}; text-shadow: 0 0 4px var(--bg); }
.mk-geolabel { color: var(--text-dim); font-size: var(--font-xxs); pointer-events: none; }
.mk-geolabel .sym { font-size: var(--font-xxs); letter-spacing: 1.2px; white-space: nowrap; text-shadow: 0 0 3px var(--bg); }

/* スケール用 CSS トークンによる標準化設定 */
.mk-apsis .sym, .mk-node .sym, .mk-mnode .sym, .mk-burn .sym, .mk-planned .sym { font-size: calc(var(--glyph-base) * var(--mk-scale-element)); }
.mk-apsis .sym svg, .mk-node .sym svg, .mk-mnode .sym svg, .mk-burn .sym svg, .mk-planned .sym svg {
  width: calc(100% * var(--mk-scale-element)); height: calc(100% * var(--mk-scale-element));
}

.mk-self .sym, .mk-enemy .sym, .mk-target .sym, .mk-ally .sym { font-size: calc(var(--glyph-base) * var(--mk-scale-vessel)); }
.mk-self .sym svg, .mk-enemy .sym svg, .mk-target .sym svg, .mk-ally .sym svg {
  width: calc(100% * var(--mk-scale-vessel)); height: calc(100% * var(--mk-scale-vessel));
}

.mk-longpress { width: 40px; height: 40px; }
.mk-longpress .sym { border: 2px solid var(--color-primary); border-radius: 50%; box-sizing: border-box; }
`;

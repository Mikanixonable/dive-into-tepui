// マーカーの骨格の CSS。枠・シンボル・ラベルの置き方、間引きで伏せる指定、引き出し線の太さ、
// そして種別ごとの見た目が読む重なり順・大きさのトークンを持つ。
// 種別ごとの色と字送りは意味なので、宣言を組む側が別に注入する。

const STYLE_ID = 'marker-structure-style';

const MARKER_STRUCTURE_STYLE = `
.mk {
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

  position: absolute; transform: translate(-50%, -50%);
  text-align: center; white-space: nowrap; text-shadow: 0 0 4px var(--bg), 0 0 2px var(--bg);
  width: 24px; height: 24px; transition: opacity var(--transition-slow) ease;
  user-select: none;
}
.mk .sym {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: var(--glyph-base); line-height: 1; transition: opacity var(--transition-slow) ease; transform-origin: 50% 50%;
}
.mk .sym svg { display: block; width: 100%; height: 100%; }

.mk .lbl {
  position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
  font-size: var(--font-xs); letter-spacing: 1px; transition: opacity var(--transition-slow) ease;
}
.mk .sym.priority-hidden, .mk .lbl.priority-hidden { opacity: 0; pointer-events: none; }
`;

// マーカーの骨格の CSS を document へ注入する。同じ id への二度目の呼び出しは何もしない。
export function injectMarkerStructureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = MARKER_STRUCTURE_STYLE;
  document.head.appendChild(style);
}

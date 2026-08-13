// レール幅・戦闘シェルフ高の CSS 変数。値はブレークポイントごとにここで再代入し、
// 参照側(hud-dock/PREDICT バー/戦闘シェルフ)は var() 越しに読むだけにする —
// 同じ長さをブレークポイントの数だけ複数箇所へ書き写さない。
export const LAYOUT_TOKENS_STYLE = `
:root {
  --rail-w-left: min(300px, 30vw);
  --rail-w-right: min(300px, 33vw);
  --shelf-h: none;
}
@media (max-width: 900px), (pointer: coarse) {
  :root {
    --rail-w-left: min(220px, calc(46vw - 8px));
    --rail-w-right: min(260px, calc(54vw - 8px));
    --shelf-h: 116px;
  }
}
@media (max-width: 520px) {
  :root {
    --rail-w-left: calc(44vw - 8px);
    --rail-w-right: calc(56vw - 8px);
  }
}
@media (pointer: coarse) {
  :root { --shelf-h: 104px; }
}
@media (pointer: coarse) and (orientation: landscape) and (max-height: 500px) {
  :root { --shelf-h: 82px; }
}
@media (orientation: landscape) and (max-height: 500px) {
  :root { --shelf-h: 82px; }
}
`;

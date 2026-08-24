// レール幅・戦闘パネル高上限・淡色化の不透明度の CSS 変数。値はブレークポイントごとにここで再代入し、
// 参照側(hud-rail/PREDICT バー/戦闘ビューの常設パネル)は var() 越しに読むだけにする —
// 同じ長さをブレークポイントの数だけ複数箇所へ書き写さない。
import {
  MQ_COARSE, MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT,
} from '../breakpoints';

export const LAYOUT_TOKENS_STYLE = `
:root {
  --rail-w-left: min(300px, 30vw);
  --rail-w-right: min(300px, 33vw);
  --combat-panel-max-h: none;
  /* 表示トグルが OFF の行・区画を淡色化するときの不透明度。 */
  --toggle-off-opacity: .52;
}
@media ${MQ_MEDIUM_DOWN} {
  :root {
    --rail-w-left: min(220px, calc(46vw - 8px));
    --rail-w-right: min(260px, calc(54vw - 8px));
    --combat-panel-max-h: 116px;
  }
}
@media ${MQ_COMPACT} {
  :root {
    --rail-w-left: calc(44vw - 8px);
    --rail-w-right: calc(56vw - 8px);
  }
}
@media ${MQ_COARSE} {
  :root { --combat-panel-max-h: min(140px, 22dvh); }
}
@media ${MQ_SHORT} {
  :root { --combat-panel-max-h: 82px; }
}
`;

// レール幅の CSS 変数。値はブレークポイントごとにここで再代入し、
// 参照側(hud-rail/PREDICT バー)は var() 越しに読むだけにする —
// 同じ長さをブレークポイントの数だけ複数箇所へ書き写さない。
import { MQ_COMPACT, MQ_MEDIUM_DOWN } from './breakpoints';

export const LAYOUT_TOKENS_STYLE = `
:root {
  --rail-w-left: min(300px, 30vw);
  --rail-w-right: min(300px, 33vw);
}
@media ${MQ_MEDIUM_DOWN} {
  :root {
    --rail-w-left: min(220px, calc(46vw - 8px));
    --rail-w-right: min(260px, calc(54vw - 8px));
  }
}
@media ${MQ_COMPACT} {
  :root {
    --rail-w-left: calc(44vw - 8px);
    --rail-w-right: calc(56vw - 8px);
  }
}
`;

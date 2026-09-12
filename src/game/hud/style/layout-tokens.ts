// レール幅・レール/戦闘パネル高上限・行の最小高さ・淡色化の不透明度の CSS 変数を定義する。値は
// ブレークポイントごとにここで再代入し、判定式そのものをこの1箇所へ集約する。
import {
  MQ_COARSE, MQ_COARSE_SHORT, MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT,
} from '../../../hud/breakpoints';

export const LAYOUT_TOKENS_STYLE = `
:root {
  --rail-w-left: min(300px, 30vw);
  --rail-w-right: min(300px, 33vw);
  --combat-panel-max-h: none;
  --rail-panel-max-h: none;
  /* レールと画面固定スケールの上下位置。ブレークポイントごとの再配置をここへ集約する。 */
  --hud-rail-top: 78px;
  --hud-rail-bottom: 12px;
  --hud-map-scale-bottom: 12px;
  /* 画面右上の収納トグルと固定バッジを隣接させるための配置寸法。 */
  --hud-rail-toggle-size: 30px;
  /* 常設パネル1行の最小高さ(タブ・行系の見出しに共通)。 */
  --row-min-h-s: 28px;
  /* 表示トグルが OFF の行・区画を淡色化するときの不透明度。 */
  --toggle-off-opacity: .52;
}
@media ${MQ_MEDIUM_DOWN} {
  :root {
    --rail-w-left: min(220px, calc(46vw - 8px));
    --rail-w-right: min(260px, calc(54vw - 8px));
    --combat-panel-max-h: 116px;
    --hud-rail-top: 40px;
    --hud-rail-bottom: 8px;
    --hud-map-scale-bottom: 8px;
  }
}
@media ${MQ_COMPACT} {
  :root {
    --rail-w-left: calc(44vw - 8px);
    --rail-w-right: calc(56vw - 8px);
    --hud-map-rail-bottom: calc(28vh + 16px);
    --hud-map-rail-bottom: calc(28dvh + 16px);
  }
}
@media ${MQ_COARSE} {
  :root {
    --combat-panel-max-h: min(140px, 22dvh);
    --rail-panel-max-h: min(140px, 22dvh);
    --hud-rail-bottom: 62px;
    --hud-map-scale-bottom: 62px;
  }
}
@media ${MQ_COARSE_SHORT} {
  :root { --hud-rail-bottom: 52px; }
}
@media ${MQ_SHORT} {
  :root {
    --combat-panel-max-h: 82px;
    --rail-panel-max-h: 82px;
    --hud-map-scale-bottom: 52px;
  }
}
`;

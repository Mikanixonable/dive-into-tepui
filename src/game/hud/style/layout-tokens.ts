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
  /* 上部クロームは実寸を JS で同期する。初期描画前だけこの値をフォールバックとして使う。 */
  --hud-chrome-h: 78px;
  /* 中央HUDは rail-w を直接読まず、この実占有量だけを参照する。JSが描画後に実寸へ上書きする。 */
  --hud-left-rail-occupied: calc(12px + var(--rail-w-left));
  --hud-right-rail-occupied: calc(12px + var(--rail-w-right));
  --hud-rail-bottom: 12px;
  --hud-map-scale-bottom: 12px;
  /* overlay の高さを役割別の3段階に揃える。 */
  --overlay-max-h-s: min(56dvh, 520px);
  --overlay-max-h-m: min(72dvh, 720px);
  --overlay-max-h-l: min(88dvh, 900px);
  /* Editorial UI の字間。局所的な .06/.11/.16em の増殖を避ける。 */
  --tracking-label: .08em;
  --tracking-code: .14em;
  --tracking-title: -.025em;
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
    --combat-panel-max-h: none;
    --hud-chrome-h: 58px;
    --hud-left-rail-occupied: calc(8px + var(--rail-w-left));
    --hud-right-rail-occupied: calc(8px + var(--rail-w-right));
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
    --combat-panel-max-h: none;
    --rail-panel-max-h: none;
    --hud-rail-bottom: 62px;
    --hud-map-scale-bottom: 62px;
  }
}
@media ${MQ_COARSE_SHORT} {
  :root { --hud-rail-bottom: 52px; }
}
@media ${MQ_SHORT} {
  :root {
    --combat-panel-max-h: none;
    --rail-panel-max-h: none;
    --hud-map-scale-bottom: 52px;
  }
}
`;

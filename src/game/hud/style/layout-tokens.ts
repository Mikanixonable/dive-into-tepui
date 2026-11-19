// レール幅・上部クローム高・レール占有量・下端余白・トグル寸法の CSS 変数を定義する。値は
// ブレークポイントごとにここで再代入し、判定式そのものをこの1箇所へ集約する。
import {
  MQ_COARSE, MQ_COARSE_SHORT, MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT,
} from '../../../hud/breakpoints';

export const LAYOUT_TOKENS_STYLE = `
:root {
  --rail-w-left: min(300px, 30vw);
  --rail-w-right: min(300px, 33vw);
  /* 上部クロームは実寸を JS で同期する。初期描画前だけこの値をフォールバックとして使う。 */
  --hud-chrome-h: 78px;
  /* 中央HUDは rail-w を直接読まず、この実占有量だけを参照する。JSが描画後に実寸へ上書きする。 */
  --hud-left-rail-occupied: calc(12px + var(--rail-w-left));
  --hud-right-rail-occupied: calc(12px + var(--rail-w-right));
  --hud-rail-bottom: 12px;
  --hud-map-scale-bottom: 12px;
  /* 画面右上の収納トグルと固定バッジを隣接させるための配置寸法。 */
  --hud-rail-toggle-size: 30px;
}
@media ${MQ_MEDIUM_DOWN} {
  :root {
    --rail-w-left: min(220px, calc(46vw - 8px));
    --rail-w-right: min(260px, calc(54vw - 8px));
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
  }
}
@media ${MQ_COARSE} {
  :root {
    --hud-rail-bottom: 62px;
    --hud-map-scale-bottom: 62px;
  }
}
@media ${MQ_COARSE_SHORT} {
  :root { --hud-rail-bottom: 52px; }
}
@media ${MQ_SHORT} {
  :root {
    --hud-map-scale-bottom: 52px;
  }
}
`;

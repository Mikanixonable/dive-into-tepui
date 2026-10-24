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
  /* 画面右上の収納トグルと固定バッジを隣接させるための配置寸法。 */
  --hud-rail-toggle-size: 30px;
  /* スマホ横持ちの下端のドック(制動・微動・ホールド・計器、マップでは ノードへ・戦闘へ・計器)の1ボタンの幅。 */
  --hud-dock-btn-w: calc(var(--hit-target-min) * 4 / 3);
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
  }
}
@media ${MQ_COARSE} {
  :root {
    /* タッチでは収納トグルもタップ最小寸法(UI-DESIGN §6)。 */
    --hud-rail-toggle-size: var(--hit-target-min);
    --combat-panel-max-h: none;
    --rail-panel-max-h: none;
    --hud-rail-bottom: 62px;
    --hud-map-scale-bottom: 62px;
  }
}
@media ${MQ_SHORT} {
  :root {
    --combat-panel-max-h: none;
    --rail-panel-max-h: none;
    --hud-map-scale-bottom: 52px;
  }
}
@media ${MQ_COARSE_SHORT} {
  :root {
    /* 下端のドック(タップ最小寸法)の上。左右のレールは無いので、下端に置く常設のものはここを基準にする。 */
    --hud-rail-bottom: calc(var(--safe-b) + var(--space-4) + var(--hit-target-min) + var(--space-3));
    --hud-map-scale-bottom: var(--hud-rail-bottom);
    /* 画面中央に残る幅を測る基準: 左の推力段と並進パッドの端まで、上の左右の小計器の端まで。 */
    --hud-pad-side: calc(
      max(var(--safe-l), var(--safe-r)) + var(--space-4) * 2 + var(--hit-target-min) * 4 + var(--space-2) * 2
    );
    --hud-mini-side: calc(max(var(--safe-l), var(--safe-r)) + var(--space-4) + var(--hud-mini-w));
    --hud-mini-w: 12em;
  }
}
`;

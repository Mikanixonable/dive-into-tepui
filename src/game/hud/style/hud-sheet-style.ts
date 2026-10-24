// 計器シートの意匠。スマホ横持ち(粗いポインタかつ低い画面)では左右のレールを出さず、シートを開いている間
// だけ、選ばれたタブのパネルを載せたレールが下から出る。パネルは既存のものをそのまま使い、ここでは
// 見せ分けと、浅いシートへ収めるための列の流し方だけを持つ。開閉の状態は #hud の data-sheet と、見せる
// パネルの data-sheet-shown(HudSheet が当てる)で表す。
import { MQ_COARSE_SHORT } from '../../../hud/breakpoints';

export const HUD_SHEET_STYLE = `
@media ${MQ_COARSE_SHORT} {
  :root {
    --hud-sheet-h: var(--overlay-max-h-s);
    --hud-sheet-edge: var(--space-4);
    --hud-sheet-head-h: calc(var(--hit-target-min) + var(--space-2) * 2);
    --hud-sheet-body-h: calc(var(--hud-sheet-h) - var(--hud-sheet-head-h) - var(--space-2));
    --hud-sheet-col-w: 240px;
  }
  /* シートを開いていない間、レールは無い。収納トグルもレールと一緒に無くなる。 */
  #hud .hud-rail, #hud:not(.base-mode) .rail-toggle { display: none; }

  /* 頭: [握り][タブ …………][✕]。タブも✕もタップ最小寸法。 */
  #hud-sheet-head {
    position: fixed; display: none; box-sizing: border-box; align-items: center; gap: var(--space-3);
    left: calc(var(--safe-l) + var(--hud-sheet-edge)); right: calc(var(--safe-r) + var(--hud-sheet-edge));
    bottom: calc(var(--safe-b) + var(--hud-sheet-body-h) + var(--space-2));
    height: var(--hud-sheet-head-h); padding: 0 var(--space-3);
    border-radius: var(--radius-panel) var(--radius-panel) var(--radius-micro) var(--radius-micro);
    pointer-events: auto;
  }
  #hud-sheet-grabber {
    position: absolute; top: var(--space-1); left: 50%; width: var(--space-6); height: var(--space-1);
    border-radius: var(--radius-pill); background: var(--role-hairline); transform: translateX(-50%);
  }
  #hud-sheet-head .w-tabs { flex: 1 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  #hud-sheet-head .w-tabs .w-btn { min-height: var(--hit-target-min); white-space: nowrap; }

  /* 本体: 選ばれたタブのパネルを載せたレールだけが、頭の下に出る。左右の両方に載るときは半分ずつ。 */
  #hud[data-sheet] .hud-view-root.active .hud-rail:has(.panel[data-sheet-shown]:not(.hidden)) {
    display: flex; flex-direction: column; gap: var(--space-2); box-sizing: border-box;
    top: auto; bottom: var(--safe-b); width: auto; height: var(--hud-sheet-body-h);
    left: calc(var(--safe-l) + var(--hud-sheet-edge)); right: calc(var(--safe-r) + var(--hud-sheet-edge));
    overflow-x: hidden; overflow-y: auto; pointer-events: auto;
  }
  #hud[data-sheet] .hud-view-root.active:has(.hud-rail-left > .panel[data-sheet-shown]:not(.hidden)):has(.hud-rail-right > .panel[data-sheet-shown]:not(.hidden)) .hud-rail-left {
    right: calc(50% + var(--space-2));
  }
  #hud[data-sheet] .hud-view-root.active:has(.hud-rail-left > .panel[data-sheet-shown]:not(.hidden)):has(.hud-rail-right > .panel[data-sheet-shown]:not(.hidden)) .hud-rail-right {
    left: calc(50% + var(--space-2));
  }
  /* 利用者がレールやパネルを畳んでいても、シートでは開いて見せる。 */
  #hud[data-sheet] .hud-rail > .panel { display: none !important; }
  #hud[data-sheet] .hud-rail > .panel[data-sheet-shown]:not(.hidden) {
    display: block !important; width: auto; max-height: none; flex: 0 0 auto; overflow: visible;
    border-radius: var(--radius-micro) var(--radius-micro) var(--radius-panel) var(--radius-panel);
  }
  #hud[data-sheet] .hud-rail > .panel > .ui-head { display: none; }
  #hud[data-sheet] .hud-rail > .panel > .panel-shell-body { display: block !important; }
  /* 浅いシートは、パネルの本体を列に流して横へ使う。 */
  #hud[data-sheet] .hud-rail > .panel > .panel-shell-body {
    columns: 3 var(--hud-sheet-col-w); column-gap: var(--space-6);
  }
  #hud[data-sheet] .hud-rail > .panel .ui-row, #hud[data-sheet] .hud-rail > .panel .ui-readout,
  #hud[data-sheet] .hud-rail > .panel .ui-item, #hud[data-sheet] .hud-rail > .panel .w-group,
  #hud[data-sheet] .hud-rail > .panel .vessel-deploy-row { break-inside: avoid; }
  #hud[data-sheet] .hud-rail > .panel .ui-sub { break-after: avoid; }

  /* シートの下に隠れる常設のものと、シートが同じ値を見せる小計器は出さない。通知はシートの頭の上へ上げる。 */
  #hud[data-sheet] #hud-weapon-strip, #hud[data-sheet] #hud-predict-wrap,
  #hud[data-sheet] #hud-mini-left, #hud[data-sheet] #hud-mini-right, #hud[data-sheet] #hud-briefing { display: none; }
  /* 縮尺バーの display は MapScaleBadge がインラインで切り替える。 */
  #hud[data-sheet] #hud-map-scale { display: none !important; }
  #hud[data-sheet] #hud-toast { bottom: calc(var(--safe-b) + var(--hud-sheet-h) + var(--space-4)); }
}
`;

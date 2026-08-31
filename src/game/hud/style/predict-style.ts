// 予測軌道パネル(#hud-predict/#hud-predict-wrap/#hud-predict-toggle)の CSS。
import {
  MQ_COARSE, MQ_COARSE_SHORT, MQ_COMPACT, MQ_MEDIUM_DOWN,
} from '../breakpoints';

export const PREDICT_STYLE = `
/* 下部の固定バーとその開閉トグル。両者を縦積みの flex にして画面下端に揃え、パネルを畳んでも
   トグルだけがその場(バーがあった位置の上端)に残るようにする。マップビューでは
   #hud-stagestatus は常に非表示なので、他の下端揃えパネル(.hud-rail 等)と同じ bottom まで詰める。
   左右レール(.hud-rail-left/.hud-rail-right)の内側に収まる幅だけを使い、レールのパネルに重ねない。 */
#hud-predict-wrap {
  position: absolute; bottom: 12px;
  left: calc(12px + var(--rail-w-left) + 8px); right: calc(12px + var(--rail-w-right) + 8px);
  display: flex; flex-direction: column; gap: var(--space-2); pointer-events: none;
}
/* #hud を重ねた ID セレクタで、.panel 共通規則(position:absolute)より詳細度を上げて打ち消す。
   表示/非表示は .hidden(ゲーム状態)/.collapsed(利用者の折りたたみ)の2軸だけに委ねる —
   ここで display を確定させると、どちらの軸がクラスを外しても表示に戻れなくなる。 */
#hud #hud-predict {
  position: relative; inset: auto; order: 2; box-sizing: border-box;
  max-height: 40vh; max-height: 40dvh; overflow-y: auto; pointer-events: auto;
}
#hud-predict.collapsed { display: none !important; }
#hud-predict-toggle {
  display: none; order: 1; align-self: center; pointer-events: auto; cursor: pointer;
  width: 26px; height: 26px; border: 1px solid var(--edge); border-radius: var(--radius-m);
  background: var(--surface); color: var(--color-primary);
}
#hud .hud-map-root.active #hud-predict-toggle { display: block; }
#hud.dock-mode #hud-predict-toggle { display: none; }
#hud-predict .predict-row1, #hud-predict .predict-row2 { display: flex; align-items: center; gap: var(--space-3); }
#hud-predict .predict-row1 { flex-wrap: wrap; margin-bottom: var(--space-2); }
#hud-predict .predict-pills { display: inline-flex; gap: var(--space-3); flex-wrap: wrap; align-items: center; }
/* span. まで指定して .w-btn 側の display/padding より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#hud-predict span.predict-reset {
  flex: 0 0 auto; padding: 0;
  width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
  font-size: var(--font-m);
}
#hud-predict span.predict-reset:hover { border-color: var(--color-primary); color: var(--color-primary); }
#hud-predict .predict-slider-wrap { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; height: 22px; }
#hud-predict input[type="range"] { width: 100%; height: 22px; margin: 0; pointer-events: auto; accent-color: var(--color-primary); }
#hud-predict .predict-elapsed {
  flex: 0 0 auto; pointer-events: auto; cursor: pointer;
  font-size: var(--font-s); color: var(--text-dim); font-variant-numeric: tabular-nums; white-space: nowrap;
}
#hud-predict .predict-elapsed:hover { color: var(--text); }
#hud-predict .predict-absolute {
  flex: 0 0 auto; font-size: var(--font-s); color: var(--text-dim);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
#hud-predict .predict-value-input { display: inline-flex; align-items: center; gap: var(--space-2); margin: 0; }
/* 単位の SegmentedControl は見出しを持たないので、共通規則の見出し幅を出さない。 */
#hud-predict .predict-value-input .seg-title { display: none; }
#hud-predict .predict-value-input input[type="number"] { width: 112px; }
#hud-predict .slider-ticks { position: relative; height: 11px; margin-top: var(--space-1); }
#hud-predict .slider-ticks span {
  position: absolute;
  font-size: var(--font-xxs); color: var(--text-dim); white-space: nowrap;
}
@media ${MQ_MEDIUM_DOWN} {
  /* このブレークポイントのレール幅に合わせて左右の隙間を再計算する。 */
  #hud-predict-wrap {
    bottom: 8px;
    left: calc(8px + var(--rail-w-left) + 8px); right: calc(8px + var(--rail-w-right) + 8px);
  }
}
@media ${MQ_COMPACT} {
  #hud-predict .slider-ticks { display: none; }
  /* 幅が足りないので、行2はスクラバーと T+ 読み値だけ残す。 */
  #hud-predict .predict-absolute { display: none; }
  #hud-predict-wrap { left: 8px; right: 8px; bottom: 8px; }
  #hud-predict { max-height: 28vh; max-height: 28dvh; }
}
@media ${MQ_COARSE} {
  #hud-predict-wrap { bottom: 62px; }
}
@media ${MQ_COARSE_SHORT} {
  #hud-predict-wrap { bottom: 52px; }
}
`;

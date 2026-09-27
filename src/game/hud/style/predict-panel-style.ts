// 予測軌道パネル(#hud-predict)と、それを収める下部シート(#hud-predict-wrap /
// #hud-predict-toggle)の CSS。
import {
  MQ_COARSE, MQ_COARSE_SHORT, MQ_COMPACT, MQ_MEDIUM_DOWN,
} from '../../../hud/breakpoints';

export const PREDICT_PANEL_STYLE = `
#hud-predict .predict-head { margin-bottom: var(--space-2); }
#hud-predict .predict-state {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end; gap: var(--space-5);
  margin-bottom: var(--space-3); padding-bottom: var(--space-3);
}
#hud-predict .predict-state .editorial-state-hero strong {
  font-size: var(--font-xl);
}
#hud-predict .predict-state-progress {
  display: grid; justify-items: end; gap: 2px; min-width: 72px;
}
#hud-predict .predict-state-progress .ui-data-secondary {
  color: var(--color-primary); font-size: var(--font-m); font-weight: 650;
}
#hud-predict .predict-controls {
  display: grid; gap: var(--space-2); padding-top: var(--space-3);
}
#hud-predict .predict-controls .predict-row1 { margin-bottom: 0; }
#hud-predict .predict-controls .predict-row2 {
  margin-top: var(--space-1); padding-top: var(--space-2);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-dim) 14%, transparent);
}

/* 下部の固定バーとその開閉トグル。両者を縦積みの flex にして画面下端に揃え、パネルを畳んでも
   トグルだけがその場(バーがあった位置の上端)に残るようにする。マップビューでは
   #hud-stagestatus は常に非表示なので、他の下端揃えパネル(.hud-rail 等)と同じ bottom まで詰める。
   左右レール(.hud-rail-left/.hud-rail-right)の内側に収まる幅だけを使い、レールのパネルに重ねない。 */
#hud-predict-wrap {
  position: absolute; bottom: 12px;
  left: calc(var(--hud-left-rail-occupied) + 8px);
  right: calc(var(--hud-right-rail-occupied) + 8px);
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
  border: 0; border-radius: 50%;
  background: var(--surface); color: var(--color-primary);
}
#hud .hud-map-root.active #hud-predict-toggle { display: block; }
#hud-predict .predict-row1, #hud-predict .predict-row2 { display: flex; align-items: center; gap: var(--space-3); }
#hud-predict .predict-row1 { flex-wrap: wrap; margin-bottom: var(--space-2); }
#hud-predict .predict-pills { display: inline-flex; gap: var(--space-3); flex-wrap: wrap; align-items: center; }
/* span. まで指定して .w-btn 側の display/padding より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#hud-predict span.predict-reset {
  flex: 0 0 auto; padding: 0;
  display: flex; align-items: center; justify-content: center; border-radius: 50%;
  font-size: var(--font-m);
}
#hud-predict span.predict-reset:hover { color: var(--color-primary); }
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
#hud-predict .predict-value-input input[type="number"] { width: 112px; }
#hud-predict .slider-ticks { position: relative; height: 11px; margin-top: var(--space-1); }
#hud-predict .slider-ticks span {
  position: absolute;
  font-size: var(--font-xxs); color: var(--text-dim); white-space: nowrap;
}
@media ${MQ_MEDIUM_DOWN} {
  #hud-predict-wrap { bottom: 8px; }
}
@media ${MQ_COMPACT} {
  /* compactは左右railの合計幅が中央領域をほぼ使い切るため、PREDICTは横の隙間ではなく
     下部sheetとして配置し、その実占有量ぶんrailを上へ切る。 */
  #hud .hud-map-root.active .hud-rail {
    bottom: max(
      var(--hud-rail-bottom),
      calc(var(--hud-predict-bottom-occupied, 0px) + var(--space-2))
    );
  }
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

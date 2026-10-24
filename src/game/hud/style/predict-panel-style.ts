// 時間軸パネル(#hud-predict)と、それを収める下部シート(#hud-predict-wrap / #hud-predict-toggle)、
// 表示範囲・設定の小窓(.tml-pop)の CSS。
import {
  MQ_COARSE, MQ_COARSE_SHORT, MQ_COMPACT, MQ_MEDIUM_DOWN,
} from '../../../hud/breakpoints';

export const PREDICT_PANEL_STYLE = `
#hud #hud-predict { padding: var(--space-4) var(--space-5); }

/* 上段: 現在に戻す・読み値・(空き)・次の事象・予測率・設定。 */
#hud-predict .tml-top { display: flex; align-items: center; gap: var(--space-5); min-height: var(--row-min-h-s); }
/* 上段は折り返さない。幅が足りない中幅では、絶対日時と次の事象の名前を省略記号で縮め、隣へ重ねない。 */
#hud-predict .tml-read { display: flex; align-items: baseline; gap: var(--space-4); min-width: 0; white-space: nowrap; }
#hud-predict .tml-elapsed {
  flex: none; cursor: pointer; pointer-events: auto; color: var(--role-data); font-size: var(--font-xl);
  font-variant-numeric: tabular-nums;
}
#hud-predict .tml-elapsed:hover { color: var(--color-primary-hover); }
#hud-predict .tml-date {
  min-width: 0; overflow: hidden; text-overflow: ellipsis;
  color: var(--role-label); font-size: var(--font-xs); font-variant-numeric: tabular-nums;
}
#hud-predict .tml-grow { flex: 1 1 0; min-width: 0; }
#hud-predict .tml-top .w-btn { white-space: nowrap; }
#hud-predict .tml-top .w-btn:not(.w-btn--icon) {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
}
#hud-predict .tml-top .w-btn:not(.w-btn--icon):focus-visible { outline-offset: -2px; }
#hud-predict .tml-pred {
  color: var(--role-meta); font-size: var(--font-xxs); letter-spacing: var(--tracking-label);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
/* span. まで指定して .w-btn 側の display/padding より確実に勝たせる。 */
#hud-predict span.predict-reset {
  flex: 0 0 auto; padding: 0;
  display: flex; align-items: center; justify-content: center; border-radius: 50%;
  font-size: var(--font-m);
}
#hud-predict .predict-value-input { display: inline-flex; align-items: center; gap: var(--space-2); margin: 0; }
#hud-predict .predict-value-input input[type="number"] { width: 112px; }

/* 時間軸: [過去の掴み手] [トラックと軸のラベル] [未来の掴み手]。 */
#hud-predict .tml-scrub {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start;
  column-gap: var(--space-4); margin-top: var(--space-3);
}
#hud-predict .tml-end {
  display: inline-flex; align-items: center; gap: var(--space-3); box-sizing: border-box;
  height: var(--slider-marked-h); padding: 0 var(--space-4); white-space: nowrap;
}
#hud-predict .tml-end-caption { color: var(--role-meta); font-size: var(--font-xxs); letter-spacing: var(--tracking-label); }
#hud-predict .tml-end b { color: var(--text); font-size: var(--font-s); font-weight: 400; }
#hud-predict .tml-end i { color: var(--role-label); font-size: var(--font-xxs); font-style: normal; }
#hud-predict .tml-track { min-width: 0; }
/* トラック: 左に過去の静的な帯(履歴。指して動かす対象ではない)、右にスライダー(未来側の値域)。
   帯の幅 --tml-past-w はトラック全幅に対する割合で、上限は tick-scale.ts の PAST_REGION_MAX_FRACTION。 */
#hud-predict .tml-bar { display: flex; }
#hud-predict .tml-bar > .w-slider-frame { flex: 1 1 0; min-width: 0; }
#hud-predict .tml-past {
  flex: 0 0 var(--tml-past-w, 0); box-sizing: border-box; height: var(--slider-marked-h);
  border-radius: var(--radius-control) 0 0 var(--radius-control);
  background: var(--fill-1); box-shadow: inset 0 0 0 1px var(--fill-2); pointer-events: none;
}
#hud-predict .tml-bar.has-past > .w-slider-frame { border-top-left-radius: 0; border-bottom-left-radius: 0; }
#hud-predict .slider-ticks { position: relative; height: var(--font-xxs); margin-top: var(--space-2); }
#hud-predict .slider-ticks span {
  position: absolute; color: var(--role-meta); font-size: var(--font-xxs);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}

/* 表示範囲・設定の小窓(popup 層に置かれるので #hud-predict の外)。 */
#hud .tml-pop {
  position: fixed; display: none; box-sizing: border-box; pointer-events: auto;
  max-width: calc(100vw - 2 * var(--space-5)); margin-bottom: var(--space-4);
  padding: var(--space-5) var(--space-5) var(--space-4); border-radius: var(--radius-panel);
  font-size: var(--font-s); color: var(--text);
}
#hud .tml-pop-range { width: var(--tml-pop-range-w); }
#hud .tml-pop-range .predict-row1.is-active { background: var(--fill-1); border-radius: var(--radius-micro); }
#hud .tml-pop-settings { width: var(--tml-pop-settings-w); }
#hud .tml-pop-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-3); }
#hud .tml-pop .predict-row1 { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); }
#hud .tml-pop .predict-pills { display: inline-flex; flex-wrap: wrap; gap: var(--space-2); }
#hud .tml-pop-note { margin-top: var(--space-3); color: var(--role-meta); font-size: var(--font-xxs); }
#hud .tml-pop-toggles { display: grid; gap: var(--space-3); }
#hud .tml-pop-toggles .w-toggle { justify-content: space-between; margin-bottom: 0; }
#hud .tml-pop-toggles .w-toggle-title { color: var(--text); font-size: var(--font-s); letter-spacing: 0; }
#hud .tml-legend {
  display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2) var(--space-4);
  margin-top: var(--space-4); color: var(--role-label); font-size: var(--font-xxs);
}
#hud .tml-legend b { display: inline-block; width: 1.4em; margin-right: var(--space-2); font-weight: 400; text-align: center; }
#hud .tml-legend-item.is-own { color: var(--role-own); }
#hud .tml-legend-item.is-target { color: var(--role-target); }

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
@media ${MQ_MEDIUM_DOWN} {
  #hud-predict-wrap { bottom: 8px; }
}
@media ${MQ_COMPACT} {
  /* compactは左右railの合計幅が中央領域をほぼ使い切るため、時間軸は横の隙間ではなく
     下部sheetとして配置し、その実占有量ぶんrailを上へ切る。 */
  #hud .hud-map-root.active .hud-rail {
    bottom: max(
      var(--hud-rail-bottom),
      calc(var(--hud-predict-bottom-occupied, 0px) + var(--space-2))
    );
  }
  /* 幅が足りないので、上段は T+ 読み値と次の事象・設定だけ残し、軸のラベルは畳む。 */
  #hud-predict .slider-ticks, #hud-predict .tml-date, #hud-predict .tml-pred { display: none; }
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

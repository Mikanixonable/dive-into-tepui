// 予測軌道パネル(#hud-predict)と、それを収める下部シート(#hud-predict-wrap /
// #hud-predict-toggle)の CSS。
import {
  MQ_COARSE, MQ_COARSE_SHORT, MQ_COMPACT, MQ_MEDIUM_DOWN,
} from '../../../hud/breakpoints';

export const PREDICT_PANEL_STYLE = `
/* 下部の固定バーとその開閉トグル。両者を縦積みの flex にして画面下端に揃え、パネルを畳んでも
   トグルだけがその場(バーがあった位置の上端)に残るようにする。マップビューでは
   #hud-stagestatus は常に非表示なので、他の下端揃えパネル(.hud-rail 等)と同じ bottom まで詰める。
   左右レール(.hud-rail-left/.hud-rail-right)とその収納グリップの内側に収まる幅だけを使い、どちらにも重ねない。 */
#hud-predict-wrap {
  position: absolute; bottom: var(--space-5);
  left: calc(var(--hud-left-rail-occupied) + var(--hud-rail-grip-reach));
  right: calc(var(--hud-right-rail-occupied) + var(--hud-rail-grip-reach));
  display: flex; flex-direction: column; gap: var(--space-2); pointer-events: none;
}
/* #hud を重ねた ID セレクタで、.panel 共通規則(position:absolute)より詳細度を上げて打ち消す。
   表示/非表示は .hidden(ゲーム状態)/.collapsed(利用者の折りたたみ)の2軸だけに委ねる —
   ここで display を確定させると、どちらの軸がクラスを外しても表示に戻れなくなる。 */
#hud #hud-predict {
  position: relative; inset: auto; order: 2; box-sizing: border-box;
  padding: var(--space-2) var(--space-3);
  max-height: 40vh; max-height: 40dvh; overflow-y: auto; pointer-events: auto;
}
#hud-predict.collapsed { display: none !important; }
#hud-predict-toggle { display: none; order: 1; align-self: center; }
#hud .hud-map-root.active #hud-predict-toggle { display: inline-flex; }

/* 1行の帯本体。期間操作・時間軸・読み出しを横に並べ、狭くなったら読み出しから畳む。 */
#hud-predict .predict-strip {
  display: flex; align-items: center; gap: var(--space-3); min-height: 32px;
}
#hud-predict .predict-head { margin-bottom: 0; flex: 0 0 auto; }
#hud-predict .predict-expando { flex: 0 0 auto; white-space: nowrap; }
#hud-predict .predict-axis { flex: 1 1 auto; min-width: 0; }
#hud-predict .slider-ticks { position: relative; height: 11px; }
#hud-predict .slider-ticks span {
  position: absolute;
  font-size: var(--font-xxs); color: var(--text-dim); white-space: nowrap;
}
#hud-predict .predict-slider-wrap { display: flex; align-items: center; height: 22px; }
#hud-predict input[type="range"] { width: 100%; height: 22px; margin: 0; pointer-events: auto; accent-color: var(--color-primary); }
/* span. まで指定して .w-btn 側の display/padding より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#hud-predict span.predict-reset {
  flex: 0 0 auto; padding: 0;
  display: flex; align-items: center; justify-content: center; border-radius: 50%;
  font-size: var(--font-m);
}
#hud-predict span.predict-reset:hover { color: var(--color-primary); }
#hud-predict .predict-readout {
  flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end;
  line-height: 1.15;
}
#hud-predict .predict-elapsed {
  pointer-events: auto; cursor: pointer;
  font-size: var(--font-s); color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap;
}
#hud-predict .predict-elapsed:hover { color: var(--color-primary); }
#hud-predict .predict-absolute {
  font-size: var(--font-xxs); color: var(--text-dim);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
#hud-predict .w-duration-input { display: inline-flex; align-items: center; gap: var(--space-2); margin: 0; }
#hud-predict .w-duration-input input[type="number"] { width: 112px; }
#hud-predict .predict-pct {
  flex: 0 0 auto; font-size: var(--font-s); font-weight: 650; color: var(--color-primary);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}

/* 帯を広げる行。帯の下にぶら下がり、押した操作の内容だけを持つ。 */
#hud-predict .predict-expand {
  margin-top: var(--space-2); padding-top: var(--space-2);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-dim) 14%, transparent);
}
#hud-predict .predict-expand .w-pill-row { margin-bottom: 0; }
#hud-predict .w-pill-row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
#hud-predict .w-pills { display: inline-flex; gap: var(--space-3); flex-wrap: wrap; align-items: center; }

@media ${MQ_MEDIUM_DOWN} {
  #hud-predict-wrap { bottom: var(--space-4); }
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
  /* 幅が足りないので、帯は見出し・目盛り・絶対日時を畳み、時間軸と T± 読み値だけ残す。 */
  #hud-predict .predict-head { display: none; }
  #hud-predict .slider-ticks { display: none; }
  #hud-predict .predict-absolute { display: none; }
  #hud-predict .predict-pct { display: none; }
  #hud-predict-wrap { left: var(--space-4); right: var(--space-4); bottom: var(--space-4); }
  #hud-predict { max-height: 28vh; max-height: 28dvh; }
}
@media ${MQ_COARSE} {
  #hud-predict-wrap { bottom: 62px; }
}
@media ${MQ_COARSE_SHORT} {
  #hud-predict-wrap { bottom: 52px; }
}
`;

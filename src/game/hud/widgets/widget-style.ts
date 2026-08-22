// hud/widgets/ の共通スタイル。状態遷移の基準(hover=Near、pressed=中立面、on=Accent、
// disabled=単一 opacity+cursor:not-allowed)をここ1箇所で定義する。ビュー固有スタイルは、
// 同期や完了など別の意味ロールがある場合だけ Secondary 等へ上書きする。
// #hud の外(タイトル画面・起動時のオーバーレイ)でもウィジェットを組めるよう、
// セレクタは #hud に閉じない(hud-root.ts の STYLE へ連結して注入する)。
import { MQ_COARSE } from '../breakpoints';

export const WIDGET_STYLE = `
/* #hud 自体が pointer-events:none のため、対話要素はここで明示的に有効化する
   (#hud の外では既定で auto だが、明示しても害はない)。 */
.w-btn, .w-toggle-track, .w-close, .w-input, .w-select { pointer-events: auto; cursor: pointer; }
.w-btn, .w-toggle, .w-close, .w-tabs, .w-group { user-select: none; }
.w-input { cursor: text; }

/* 幅・高さと border/padding を併せ持つ要素は、置き場所の box-sizing リセットに
   依存せず自前で border-box を持つ。 */
.w-close, .w-toggle-track { box-sizing: border-box; }

.w-btn, .w-close {
  display: inline-block; padding: 7px var(--space-5); font: inherit; font-size: var(--font-s);
  line-height: 1.2; border: 1px solid transparent; border-radius: var(--radius-control);
  background: var(--surface-2); color: var(--body);
  transition: border-color var(--transition-fast), color var(--transition-fast), background var(--transition-fast), transform var(--transition-fast);
}
.w-btn:hover, .w-close:hover { color: var(--accent-near); background: var(--surface-3); }
.w-btn.pressed, .w-close.pressed { background: var(--fill-3); transform: translateY(1px); }
.w-btn.on { background: var(--accent-fill); border-color: transparent; color: var(--accent); }
.w-btn.disabled, .w-close.disabled { opacity: 0.35; cursor: not-allowed; pointer-events: none; }
.w-btn:focus-visible, .w-close:focus-visible, .w-toggle-track:focus-visible, .w-input:focus-visible {
  outline: 2px solid var(--accent-near); outline-offset: 2px;
}

/* w-group: 見出し + 排他選択ボタン列(3択以上専用)。 */
.w-group { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.w-group-title { font-size: var(--font-xs); letter-spacing: 1px; color: var(--text-dim); min-width: 28px; }

/* w-tabs: パネルの表示面を切り替えるタブ列。 */
.w-tabs { display: flex; gap: var(--space-2); }

/* w-toggle: 見出し + ON/OFF スイッチ。 */
.w-toggle { display: flex; align-items: center; gap: var(--space-4); }
.w-toggle-title { font-size: var(--font-xs); letter-spacing: 1px; color: var(--text-dim); }
.w-toggle-track {
  position: relative; display: inline-block; width: 34px; height: 18px;
  border-radius: var(--radius-pill); border: 1px solid transparent; background: var(--surface-3);
  transition: border-color var(--transition-fast), background var(--transition-fast);
}
.w-toggle-track:hover { background: color-mix(in srgb, var(--accent-near) 18%, var(--surface-3)); }
.w-toggle-track.on { border-color: transparent; background: var(--accent); }
.w-toggle-knob {
  position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
  background: var(--text-dim); transition: left var(--transition-fast), background var(--transition-fast);
}
/* トラック幅に対する相対位置(右端から 2px 余白+ノブ幅ぶんを引く、左詰めの 2px と対称)。
   固定 px でなく % 基準にすることで、coarse で幅が広がっても右端に張り付いたままになる。 */
.w-toggle-track.on .w-toggle-knob { left: calc(100% - 14px); background: var(--title); }

/* w-close: ✕ の閉じるボタン。 */
.w-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0; font-size: var(--font-m);
}

/* w-input: 数値/文字/検索入力。 */
.w-input {
  box-sizing: border-box; padding: var(--space-2) var(--space-3); font: inherit; font-size: var(--font-s);
  color: var(--text); background: var(--surface-2); border: 1px solid transparent; border-radius: var(--radius-control);
  transition: border-color var(--transition-fast), background var(--transition-fast);
}
.w-input:hover { background: var(--surface-3); }
.w-input:focus { background: var(--surface-3); border-color: var(--accent); }

/* w-select: プルダウンのドロップダウン選択(見出し・反映ボタンは .w-group/.w-btn 側)。 */
.w-select {
  box-sizing: border-box; padding: var(--space-2) var(--space-3); font: inherit; font-size: var(--font-s);
  color: var(--text); background: var(--surface-2); border: 1px solid transparent; border-radius: var(--radius-control);
  transition: border-color var(--transition-fast), background var(--transition-fast);
}
.w-select:hover { background: var(--surface-3); }
.w-select:focus { background: var(--surface-3); border-color: var(--accent); }

/* w-slider: つまみ型の連続値スライダー。トラックの寸法はパネル側の CSS が決める。 */
.w-slider { pointer-events: auto; accent-color: var(--accent); }

/* w-meter: HP/温度/電力バー。常に左から右へ満ちる。 */
.w-meter { display: flex; align-items: center; }
.w-meter-track { position: relative; flex: 1 1 auto; height: 12px; overflow: hidden; border-radius: var(--radius-micro); background: var(--bar-bg); }
.w-meter-fill { width: 0; height: 100%; background: var(--accent); transition: width var(--transition-fast); }
.w-meter-fill.danger { background: var(--danger); }
.w-meter-value {
  position: absolute; inset: 0; right: var(--space-2); display: flex; align-items: center; justify-content: flex-end;
  font-size: var(--font-xs); color: var(--text-strong); text-shadow: 0 0 2px var(--bg), 0 0 2px var(--bg);
}

/* タップ最小寸法は pointer:coarse でだけ効かせる — マウス操作では詰めて並べたウィジェットの
   間隔を保つ。要素自身の寸法(min-width/min-height)で確保する: 重ね合わせの疑似要素で広げると、
   視覚サイズを変えないぶん間隔の詰まった隣接要素のヒット領域まで侵してしまうため。 */
@media ${MQ_COARSE} {
  .w-hit {
    box-sizing: border-box; min-width: var(--hit-target-min); min-height: var(--hit-target-min);
    display: inline-flex; align-items: center; justify-content: center;
  }
}
`;

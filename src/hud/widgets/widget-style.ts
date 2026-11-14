// HUD ウィジェットの状態遷移(hover・pressed・on・disabled)と部品の密度・形状を定める。
// 操作状態を共有し、同期や完了などの意味はそれぞれのロールで表す。
import { MQ_COARSE } from '../breakpoints';

export const WIDGET_STYLE = `
/* HUD の全面オーバーレイ内でも操作要素をクリック可能にする。 */
.w-btn, .w-toggle-track, .w-close, .w-input, .w-select { pointer-events: auto; cursor: pointer; }
.w-btn, .w-toggle, .w-close, .w-tabs, .w-group { user-select: none; }
.w-input { cursor: text; }

/* 閉じるボタンとトグルの寸法は、枠線を含む大きさとして扱う。 */
.w-close, .w-toggle-track { box-sizing: border-box; }

.w-btn, .w-close {
  display: inline-block; padding: 7px var(--space-5); font: inherit; font-size: var(--font-s);
  line-height: 1.2; border: 0; border-radius: var(--radius-control);
  background: var(--glass-control); color: var(--body);
  transition: color var(--transition-fast), background var(--transition-fast), transform var(--transition-fast);
}
.w-btn:hover, .w-close:hover { color: var(--color-primary-hover); background: var(--glass-control-hover); }

/* w-btn の役割と密度。状態(on/pressed/disabled)は下の共通状態規則で一括して上書きする。 */
.w-btn--primary {
  background: var(--color-primary-fill-weak); color: var(--color-primary);
}
.w-btn--primary:hover {
  background: var(--color-primary-fill); color: var(--color-primary-hover);
}
.w-btn--secondary { background: var(--fill-1); color: var(--text-dim); }
.w-btn--secondary:hover { background: var(--fill-2); color: var(--text); }
.w-btn--dense { padding: var(--space-2) var(--space-3); font-size: var(--font-xxs); }
.ui-icon-control, .w-btn--icon {
  width: 24px; height: 24px; padding: 0; display: inline-flex;
  align-items: center; justify-content: center; border-radius: 50%; text-align: center;
}
.w-btn--icon { flex: 0 0 24px; }
.w-btn.pressed { background: var(--fill-3); transform: translateY(1px); }
.w-btn.on { background: var(--color-primary-fill); color: var(--color-primary); }
.w-btn.disabled { opacity: 0.35; cursor: not-allowed; pointer-events: none; }
.w-btn:focus-visible, .w-close:focus-visible, .w-toggle-track:focus-visible, .w-input:focus-visible {
  outline: 2px solid var(--color-focus); outline-offset: 2px;
}
.w-btn-icon {
  display: inline-block; width: 1em; height: 1em; vertical-align: middle; margin-right: var(--space-2);
}
.w-btn-icon svg { display: block; width: 100%; height: 100%; }

/* w-group: 見出し + 排他選択ボタン列(3択以上専用)。 */
.w-group { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.w-group-title { font-size: var(--font-xs); letter-spacing: var(--tracking-label); color: var(--text-dim); min-width: 28px; }

/* w-tabs: パネルの表示面を切り替えるタブ列。 */
.w-tabs { display: flex; gap: var(--space-2); }

/* w-toggle: 見出し + ON/OFF スイッチ。 */
.w-toggle { display: flex; align-items: center; gap: var(--space-4); }
.w-toggle-title { font-size: var(--font-xs); letter-spacing: var(--tracking-label); color: var(--text-dim); }
.w-toggle-track {
  position: relative; display: inline-block; width: 34px; height: 18px;
  border-radius: var(--radius-pill); border: 0; background: var(--glass-control);
  transition: background var(--transition-fast);
}
.w-toggle-track:hover { background: var(--glass-control-hover); }
.w-toggle-track.on { background: var(--color-primary); }
.w-toggle-knob {
  position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
  background: var(--text-dim); transition: left var(--transition-fast), background var(--transition-fast);
}
/* トラック幅に対する相対位置(右端から 2px 余白+ノブ幅ぶんを引く、左詰めの 2px と対称)。
   固定 px でなく % 基準にすることで、coarse で幅が広がっても右端に張り付いたままになる。 */
.w-toggle-track.on .w-toggle-knob { left: calc(100% - 14px); background: var(--text); }

/* w-close: ✕ の閉じるボタン。 */
.w-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; border-radius: 50%; font-size: var(--font-m);
}

/* w-input: 数値/文字/検索入力。w-select: プルダウンのドロップダウン選択
   (見出し・反映ボタンは .w-group/.w-btn 側)。見た目は共通。 */
.w-input, .w-select {
  box-sizing: border-box; padding: var(--space-2) var(--space-3); font: inherit; font-size: var(--font-s);
  color: var(--text); background: var(--glass-control); border: 0; border-radius: var(--radius-control);
  transition: background var(--transition-fast);
}
.w-input:hover, .w-select:hover { background: var(--glass-control-hover); }
.w-input:focus, .w-select:focus { background: var(--glass-control-hover); }

/* w-slider: つまみ型の連続値スライダー。トラックの寸法はパネル側の CSS が決める。 */
.w-slider { pointer-events: auto; accent-color: var(--color-primary); }

/* w-meter: HP/温度/電力の細い線。常に左から右へ満ちる。量は中立の線で示し、色が付くのは
   呼び出し側が注意・警告の段を渡したときだけ。閾値は目盛り(--at: 位置)で示す。 */
.w-meter { display: flex; align-items: center; gap: var(--space-3); }
.w-meter-track {
  position: relative; flex: 1 1 auto; height: var(--space-2); overflow: hidden;
  border-radius: var(--radius-pill); background: var(--role-hairline);
}
.w-meter-fill {
  width: 0; height: 100%; border-radius: inherit; background: var(--role-label);
  transition: width var(--transition-slow);
}
.w-meter-fill.caution { background: var(--role-caution); }
.w-meter-fill.warning { background: var(--role-warning); }
.w-meter-mark { position: absolute; top: 0; bottom: 0; left: var(--at); width: 1px; background: var(--fill-4); }
.w-meter-value {
  flex: 0 0 auto; font-size: var(--font-xs); color: var(--role-data);
  font-variant-numeric: tabular-nums; white-space: nowrap;
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

// hud/widgets/ の共通スタイル。状態遷移の視覚規約(hover=文字/縁がアクセント化・
// pressed=背景 --fill-3・on=背景アクセント薄膜+縁アクセント・disabled=単一 opacity+
// cursor:not-allowed)をここ1箇所で定義する — 個別ウィジェットや呼び出し側での上書きを禁止する。
// hud-root.ts の STYLE へ連結して注入する。
export const WIDGET_STYLE = `
/* #hud 自体が pointer-events:none のため、対話要素はここで明示的に有効化する。 */
#hud .w-btn, #hud .w-toggle-track, #hud .w-close, #hud .w-input { pointer-events: auto; cursor: pointer; }
#hud .w-btn, #hud .w-toggle, #hud .w-close, #hud .w-tabs, #hud .w-group { user-select: none; }
#hud .w-input { cursor: text; }

#hud .w-btn, #hud .w-close {
  display: inline-block; padding: var(--space-2) var(--space-5); font: inherit; font-size: var(--font-s);
  line-height: 1.2; border: 1px solid var(--edge); border-radius: var(--radius-m);
  background: var(--surface); color: var(--text-dim);
  transition: border-color var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
}
#hud .w-btn:hover, #hud .w-close:hover { border-color: var(--accent-soft); color: var(--accent-soft); }
#hud .w-btn.pressed, #hud .w-close.pressed { background: var(--fill-3); }
#hud .w-btn.on { background: var(--accent-fill-weak); border-color: var(--accent); color: var(--accent); }
#hud .w-btn.disabled, #hud .w-close.disabled { opacity: 0.35; cursor: not-allowed; pointer-events: none; }

/* w-group: 見出し + 排他選択ボタン列(3択以上専用)。 */
#hud .w-group { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
#hud .w-group-title { font-size: var(--font-xs); letter-spacing: 1px; color: var(--text-dim); min-width: 28px; }

/* w-tabs: パネルの表示面を切り替えるタブ列。 */
#hud .w-tabs { display: flex; gap: var(--space-2); }

/* w-toggle: 見出し + ON/OFF スイッチ。 */
#hud .w-toggle { display: flex; align-items: center; gap: var(--space-4); }
#hud .w-toggle-title { font-size: var(--font-xs); letter-spacing: 1px; color: var(--text-dim); }
#hud .w-toggle-track {
  position: relative; display: inline-block; width: 34px; height: 18px;
  border-radius: var(--radius-l); border: 1px solid var(--edge); background: var(--surface);
  transition: border-color var(--transition-fast), background var(--transition-fast);
}
#hud .w-toggle-track:hover { border-color: var(--accent-soft); }
#hud .w-toggle-track.on { border-color: var(--accent); background: var(--accent-fill-strong); }
#hud .w-toggle-knob {
  position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
  background: var(--text-dim); transition: left var(--transition-fast), background var(--transition-fast);
}
#hud .w-toggle-track.on .w-toggle-knob { left: 18px; background: var(--accent); }

/* w-close: ✕ の閉じるボタン。 */
#hud .w-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0; font-size: var(--font-m);
}

/* w-input: 数値/文字/検索入力。 */
#hud .w-input {
  box-sizing: border-box; padding: var(--space-2) var(--space-3); font: inherit; font-size: var(--font-s);
  color: var(--text); background: var(--surface); border: 1px solid var(--edge); border-radius: var(--radius-m);
  transition: border-color var(--transition-fast);
}
#hud .w-input:hover { border-color: var(--accent-soft); }
#hud .w-input:focus { outline: none; border-color: var(--accent); }

/* w-slider: つまみ型の連続値スライダー。トラックの寸法はパネル側の CSS が決める。 */
#hud .w-slider { pointer-events: auto; accent-color: var(--accent); }

/* w-meter: HP/温度/電力バー。常に左から右へ満ちる。 */
#hud .w-meter { display: flex; align-items: center; }
#hud .w-meter-track { position: relative; flex: 1 1 auto; height: 12px; background: var(--bar-bg); }
#hud .w-meter-fill { width: 0; height: 100%; background: var(--accent); transition: width var(--transition-fast); }
#hud .w-meter-fill.danger { background: var(--danger); }
#hud .w-meter-value {
  position: absolute; inset: 0; right: var(--space-2); display: flex; align-items: center; justify-content: flex-end;
  font-size: var(--font-xs); color: var(--text-strong); text-shadow: 0 0 2px var(--bg), 0 0 2px var(--bg);
}

/* 視覚サイズは変えず、疑似要素で --hit-target-min までヒット領域だけ広げる。 */
#hud .w-hit { position: relative; }
#hud .w-hit::before {
  content: ''; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: max(100%, var(--hit-target-min)); height: max(100%, var(--hit-target-min));
}
`;

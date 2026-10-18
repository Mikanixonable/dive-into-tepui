// 警報と通知の表示部品の共通スタイル: 警報灯・警報帯・通知の1行・件数・案内チップ。
// 色は意味(--role-*)でだけ引く。置き場(位置)は各画面が持ち、ここは見た目と状態だけを持つ。

export const ALARM_STYLE = `
:root {
  /* 未確認の警告灯が点滅する周期。 */
  --alarm-blink-period: 1s;
}

/* --- 警報灯: 注意と警告を1箇所に集める。件数を添える。 ------------------------------------ */
.ui-annun { display: inline-flex; gap: var(--space-2); }
.ui-lamp {
  display: inline-flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-4); border-radius: var(--radius-pill);
  font-size: var(--font-xxs); letter-spacing: var(--tracking-label);
  color: var(--role-meta); background: var(--fill-1);
}
.ui-lamp.is-caution {
  color: var(--role-caution); background: var(--role-caution-fill); box-shadow: inset 0 0 0 1px var(--role-caution-edge);
}
.ui-lamp.is-warning {
  color: var(--text-strong); background: var(--role-warning);
  animation: ui-alarm-blink var(--alarm-blink-period) steps(1) infinite;
}
@keyframes ui-alarm-blink { 50% { background: var(--role-warning-fill); color: var(--role-warning); } }
.ui-lamp.is-caution::before { content: '△'; }
.ui-lamp.is-warning::before { content: '▲'; }
.ui-lamp-n { font-weight: 600; font-variant-numeric: tabular-nums; }
/* 確認済みの警告灯は点滅せず、淡い面と縁へ移る — 動きに頼らず未確認と区別する。 */
.ui-lamp.is-warning.is-acked {
  animation: none; background: var(--role-warning-fill); color: var(--role-warning);
  box-shadow: inset 0 0 0 1px var(--role-warning-edge);
}

/* --- 警報帯: [段][何が起きたか + 取るべき行動のキー][確認]。縁と段の語だけが色を帯びる。 ----
   面は .ui-surface-focus が持ち、ここは並びと縁と段の語だけを持つ。 */
.ui-alert {
  display: inline-grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start;
  column-gap: var(--space-4);
  padding: var(--space-3) var(--space-3) var(--space-3) var(--space-5); font-size: var(--font-s);
}
#hud .ui-alert { border-radius: var(--radius-control); }
.ui-alert-level {
  min-width: 7.2em; line-height: 1.9; white-space: nowrap;
  font-size: var(--font-xxs); letter-spacing: var(--tracking-code);
}
#hud .ui-alert.is-caution { box-shadow: inset 0 0 0 1px var(--role-caution-edge), var(--glass-shadow); }
.ui-alert.is-caution .ui-alert-level { color: var(--role-caution); }
.ui-alert.is-caution .ui-alert-level::before { content: '△ '; }
#hud .ui-alert.is-warning { box-shadow: inset 0 0 0 1px var(--role-warning-edge), var(--glass-shadow); }
.ui-alert.is-warning .ui-alert-level { color: var(--role-warning); }
.ui-alert.is-warning .ui-alert-level::before { content: '▲ '; }
.ui-alert-body { display: grid; gap: var(--space-1); min-width: 0; }
.ui-alert-msg { color: var(--text-strong); line-height: 1.6; }
.ui-alert-msg b { font-weight: 600; letter-spacing: var(--tracking-label); margin-right: var(--space-2); }
.ui-alert-act {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4);
  color: var(--text-muted); font-size: var(--font-xs);
}
.ui-alert-state {
  font-size: var(--font-xxs); letter-spacing: var(--tracking-label); color: var(--role-meta);
  line-height: 2.2; white-space: nowrap;
}
/* 確認済みは面を静かにし、確認の操作を外す。行動の列は条件が戻るまで残す。 */
#hud .ui-alert.is-acked { background: var(--glass-quiet); }
.ui-alert.is-acked .ui-alert-msg { color: var(--text-muted); }
.ui-alert.is-acked .ui-alert-level { opacity: 0.75; }

/* --- 通知(出来事): 警報帯と同じ部品の1行版。確認の操作を持たず、時間で消える。色は持たない。 --- */
.ui-alert.is-info { grid-template-columns: auto minmax(0, 1fr); align-items: center; padding-right: var(--space-5); }
.ui-alert.is-info .ui-alert-level { min-width: 0; line-height: inherit; color: var(--role-label); }
.ui-alert.is-info.is-denied .ui-alert-level::before { content: '⊘ '; }
.ui-alert.is-info.is-cleared .ui-alert-level { color: var(--text); }
.ui-alert.is-info.is-cleared .ui-alert-level::before { content: '✓ '; }

/* --- 表示しきれない警報の件数。 -------------------------------------------------------------- */
.ui-more {
  justify-self: center; padding: var(--space-1) var(--space-4); border-radius: var(--radius-pill);
  background: var(--glass-quiet); color: var(--role-caution); font-size: var(--font-xxs);
  letter-spacing: var(--tracking-label);
}
.ui-more.is-warning { color: var(--role-warning); }
.ui-more::before { margin-right: var(--space-2); }
.ui-more.is-caution::before { content: '△'; }
.ui-more.is-warning::before { content: '▲'; }

/* --- 案内チップ: 文章の帯ではなく、キーと語の段階。 ------------------------------------------ */
.ui-hint {
  display: inline-flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; justify-content: center;
  padding: var(--space-2) var(--space-4); border-radius: var(--radius-pill);
  background: var(--surface-weak); color: var(--text-muted); font-size: var(--font-xs);
}
.ui-hint-step { display: inline-flex; align-items: center; gap: var(--space-2); }
.ui-hint-step + .ui-hint-step::before { content: '›'; color: var(--role-meta); margin-right: var(--space-2); }

@media (prefers-reduced-motion: reduce) {
  .ui-lamp.is-warning { animation: none; }
}
`;

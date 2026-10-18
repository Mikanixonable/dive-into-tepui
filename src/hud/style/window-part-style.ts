// ウィンドウ・モーダルが共有する部品の共通スタイル: ボタンの役割(ターゲット・警告・注意)、
// 折り畳みの見出し行、操作の列、ジェスチャの札、中立の面で選ぶタブ。色は意味(--role-*)でだけ引く。
// 画面固有の CSS は置き場と並びだけを持ち、これらの見た目はここへ集約する。

export const WINDOW_PART_STYLE = `
/* --- ボタンの役割: ターゲットへの操作は第二色の面、取り消せない操作は警告面、進行を失う操作は注意色の文字 --- */
.w-btn--target { background: var(--role-target-fill); color: var(--role-target); }
.w-btn--target:hover {
  background: linear-gradient(var(--fill-1), var(--fill-1)), var(--role-target-fill);
  color: var(--role-target);
}
.w-btn--danger { background: var(--role-warning-fill); color: var(--role-warning); }
.w-btn--danger:hover {
  background: linear-gradient(var(--fill-1), var(--fill-1)), var(--role-warning-fill);
  color: var(--role-warning);
}
.w-btn--caution { background: transparent; color: var(--role-caution); }
.w-btn--caution:hover { background: var(--role-caution-fill); color: var(--role-caution); }
.w-btn--icon .w-btn-icon { margin-right: 0; }

/* --- 折り畳みの見出し行: [▸/▾] [名前] [行数]。線ではなく余白で分ける。 --- */
.ui-fold {
  display: flex; align-items: center; gap: var(--space-3); min-height: var(--row-min-h-s);
  color: var(--role-label); font-size: var(--font-xs); letter-spacing: var(--tracking-label); cursor: pointer;
  border-radius: var(--radius-micro);
}
.ui-fold:hover { color: var(--color-primary-hover); }
.ui-fold:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.ui-fold-n { margin-left: auto; color: var(--role-meta); font-variant-numeric: tabular-nums; }

/* --- 操作の列: キー付きのボタンが折り返して並ぶ。警告のボタンは右端へ離す。 --- */
.ui-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.ui-actions .w-btn { display: inline-flex; align-items: center; }
.ui-actions .w-btn--danger { margin-left: auto; }

/* --- ジェスチャの札: キーキャップ(四角)と区別する丸い札 --- */
.ui-chip {
  display: inline-flex; align-items: center; height: var(--key-cap-min); padding: 0 var(--space-4);
  border-radius: var(--radius-pill); background: var(--fill-1); color: var(--text-muted);
  font-size: var(--font-xxs); white-space: nowrap;
}

/* --- 中立の面で選ぶタブ: 選択は主役色ではなく中立の面。いま居る章には小さな点 --- */
.w-tabs--neutral {
  display: flex; gap: var(--space-1); padding: var(--space-1);
  border-radius: var(--radius-control); background: var(--glass-inset);
}
.w-tabs--neutral .w-btn {
  display: inline-flex; flex: 1 1 0; min-width: 0; align-items: center; justify-content: center;
  gap: var(--space-3); text-align: center; background: transparent; color: var(--role-label);
}
.w-tabs--neutral .w-btn:hover { background: var(--glass-control-hover); color: var(--text); }
.w-tabs--neutral .w-btn.on { background: var(--fill-3); color: var(--text-strong); }
.w-tabs--neutral .w-btn.is-here::after {
  content: ''; width: var(--pip-dot); height: var(--pip-dot); border-radius: 50%; background: var(--role-label);
}
.w-tabs--neutral.is-dense .w-btn { padding: var(--space-3) var(--space-4); font-size: var(--font-xs); }
`;

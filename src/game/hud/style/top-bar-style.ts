// 全体ステータスバー(#hud-topbar)の中身の CSS: 1行のストリップの並び・区切り・時間加速の段の列・
// 見せ方トグル。ストリップ自身の位置は skeleton-style.ts のクローム grid が持つ。
import { MQ_COARSE, MQ_COARSE_SHORT, MQ_COMPACT, MQ_MEDIUM_DOWN } from '../../../hud/breakpoints';

export const TOP_BAR_STYLE = `
:root { --strip-h: 40px; }
@media ${MQ_COARSE} {
  :root { --strip-h: var(--hit-target-min); }
}

#hud-topbar {
  display: flex; align-items: center; gap: var(--space-4);
  height: var(--strip-h); margin-top: var(--space-3); padding: 0 var(--space-3) 0 var(--space-5);
  border-radius: var(--radius-pill);
  font-size: var(--font-xs); letter-spacing: var(--tracking-label); font-variant-numeric: tabular-nums;
  color: var(--role-label); white-space: nowrap;
}
#hud-topbar .ui-strip-sep { flex: none; width: 1px; height: var(--space-6); background: var(--role-hairline); }
#hud-topbar .gs-row { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
#hud-topbar .vb-mode, #hud-topbar .ui-strip-label {
  font-size: var(--font-xxs); letter-spacing: var(--tracking-label); color: var(--role-meta);
}
#hud-topbar .vb-view-btn { color: var(--role-data); }
#hud-topbar .vb-focus {
  max-width: 12em; overflow: hidden; text-overflow: ellipsis; color: var(--role-data);
}
#hud-topbar .ui-strip-time { color: var(--role-data); }
#hud-topbar .ui-strip-chip { display: inline-flex; align-items: baseline; gap: var(--space-3); color: var(--role-data); }
#hud-topbar .ui-strip-chip.ui-accent { color: var(--role-own); }

/* 時間加速: 段の列。いまの段は自分の色ではなく面で示す。 */
#hud-topbar .ui-warp {
  display: inline-flex; align-items: center; gap: var(--space-1); padding: var(--space-1);
  border-radius: var(--radius-pill); background: var(--glass-inset);
}
#hud-topbar .ui-warp .w-btn {
  min-width: 2.6em; justify-content: center; border-radius: var(--radius-pill);
  background: transparent; color: var(--role-label); font-variant-numeric: tabular-nums;
}
#hud-topbar .ui-warp .w-btn:hover { color: var(--text-strong); background: var(--fill-2); }
#hud-topbar .ui-warp .w-btn.on { background: var(--fill-3); color: var(--text-strong); }
#hud-topbar .ui-warp.is-paused .w-btn.on { color: var(--role-label); }
#hud-topbar .ui-strip-style .w-btn { background: var(--fill-1); color: var(--role-label); }
#hud-topbar .ui-strip-style .w-btn.on { background: var(--fill-3); color: var(--text-strong); }

/* 狭い画面: 日時を T+ だけにし、ステージ名と NODE WARP の語を畳んで1行に収める。 */
@media ${MQ_MEDIUM_DOWN} {
  #hud-topbar { gap: var(--space-3); padding-left: var(--space-4); }
  #hud-topbar .vb-mode, #hud-topbar .ui-strip-label, #hud-topbar .ui-strip-date { display: none; }
}
/* タッチ寸法の段は、時間加速の列の余白を詰めてストリップの高さに収める。 */
@media ${MQ_COARSE} {
  #hud-topbar .ui-warp { padding: 0; gap: 0; }
}
/* 幅が足りないとき、警報灯は語を畳んで記号と件数だけにし、見せ方トグルと注視対象を畳む。 */
@media ${MQ_COMPACT}, ${MQ_COARSE_SHORT} {
  #hud-topbar .ui-lamp-name { display: none; }
  #hud-topbar .ui-lamp[data-lamp="caution"]::before { content: '△'; }
  #hud-topbar .ui-lamp[data-lamp="warning"]::before { content: '▲'; }
}
@media ${MQ_COMPACT} {
  #hud-topbar .vb-focus, #hud-topbar .ui-strip-style { display: none; }
}
`;

// ステージの進行(状態表示)・中断(ポーズメニュー)・終了(結果画面)を示す
// 画面いっぱい/画面固定の表示の CSS。
import { MQ_COARSE_SHORT, MQ_MEDIUM_DOWN, MQ_SHORT } from '../breakpoints';

export const SCREEN_STYLE = `
/* 勝敗結果画面(#hud-result)。 */
#hud-result {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  background: var(--scrim); backdrop-filter: blur(3px);
  flex-direction: column; text-align: center;
}
#hud-result h1 { font-size: var(--font-3xl); letter-spacing: 6px; margin-bottom: var(--space-6); }
#hud-result.win h1 { color: var(--text); }
#hud-result.lose h1 { color: var(--color-primary); }
#hud-result .detail {
  font-size: var(--font-xl); line-height: 2; color: var(--text);
  background: var(--surface); border: 1px solid var(--edge); border-radius: var(--radius-m); padding: var(--space-6) var(--space-6);
}
#hud-result .restart { margin-top: var(--space-6); color: var(--color-primary-hover); font-size: var(--font-l); }
@media ${MQ_MEDIUM_DOWN} {
  #hud-result h1 { font-size: var(--font-2xl); letter-spacing: 3px; }
  #hud-result .detail { font-size: var(--font-l); padding: var(--space-5) var(--space-6); max-width: 92vw; }
}

/* ステージ状態表示(#hud-stagestatus)。 */
#hud-stagestatus {
  bottom: calc(12px + var(--safe-b)); left: 50%; transform: translateX(-50%);
  display: flex; align-items: flex-start; gap: var(--space-6);
  text-align: left; min-width: 720px; padding: var(--space-4) var(--space-6);
}
#hud-stagestatus .t {
  font-size: var(--font-s); letter-spacing: 2px; color: var(--text); font-variant-numeric: tabular-nums;
  display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-4); align-items: center;
}
#hud-stagestatus .t.warn { color: var(--color-warning); }
#hud-stagestatus .t .w-meter { width: 240px; }
#hud-stagestatus .k { font-size: var(--font-s); color: var(--text-dim); line-height: 1.8; white-space: nowrap; }
#hud-stagestatus .k-widgets:not(:empty) { margin-top: var(--space-3); }
@media ${MQ_MEDIUM_DOWN} {
  #hud-stagestatus { bottom: 8px; width: min(62vw, 440px); min-width: 0; max-height: 62px; overflow-y: auto; padding: var(--space-3) var(--space-5); gap: var(--space-4); }
  #hud-stagestatus .t { font-size: var(--font-s); }
  #hud-stagestatus .k { font-size: var(--font-xxs); line-height: 1.35; white-space: normal; }
}
@media ${MQ_COARSE_SHORT} {
  #hud-stagestatus { max-height: 46px; }
}
@media ${MQ_SHORT} {
  #hud-stagestatus { max-height: 46px; }
}

/* ポーズメニュー(#hud-pause-menu)。 */
#hud-pause-menu {
  position: fixed; display: none; width: 320px; pointer-events: auto;
}
#hud-pause-menu .pm-header {
  display: flex; align-items: center; gap: var(--space-6); cursor: move;
}
#hud-pause-menu .pm-header h3 { flex: 1 1 auto; min-width: 0; margin: 0; }
#hud-pause-menu .pm-header-actions {
  display: flex; align-items: center; gap: var(--space-2); flex: 0 0 auto;
}
#hud-pause-menu .pm-header .w-close, #hud-pause-menu .pm-minimize {
  flex: 0 0 auto; width: 20px; height: 20px; border-radius: 50%;
}
#hud-pause-menu .pm-minimize {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0; font: inherit; font-size: var(--font-m); border: 1px solid transparent;
  background: var(--surface-2); color: var(--body); cursor: pointer;
}
#hud-pause-menu .pm-minimize:hover { color: var(--color-primary-hover); background: var(--surface-3); }
#hud-pause-menu .pm-body.hidden { display: none; }
#hud-pause-menu .pm-row {
  display: flex; justify-content: space-between; align-items: center; gap: var(--space-6); padding: var(--space-3) 0;
}
/* span. まで指定して .w-btn 側の padding/font-size より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#hud-pause-menu span.pm-menu-btn {
  width: 100%; box-sizing: border-box; text-align: center;
  padding: var(--space-4) var(--space-5); font-size: var(--font-m);
}
#hud-pause-menu span.pm-quit { margin-top: var(--space-2); }
@media ${MQ_MEDIUM_DOWN} {
  #hud-pause-menu { min-width: 0; width: 78vw; }
}
`;

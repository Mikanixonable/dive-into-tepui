// 一時停止 / 設定パネル(#hud-pause-menu)の CSS。
import { MQ_MEDIUM_DOWN } from '../breakpoints';

export const PAUSE_MENU_STYLE = `
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
}`;

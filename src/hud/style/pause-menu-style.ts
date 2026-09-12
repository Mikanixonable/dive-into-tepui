// 一時停止 / 設定パネル(#hud-pause-menu)の CSS。
import { MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT } from '../breakpoints';

export const PAUSE_MENU_STYLE = `
/* ポーズメニュー(#hud-pause-menu)。 */
#hud-pause-menu {
  position: fixed; display: none; flex-direction: column;
  --pm-expanded-width: 800px;
  width: min(var(--pm-expanded-width), calc(100vw - var(--space-6) - var(--space-6)));
  max-height: calc(100dvh - var(--space-6) - var(--space-6));
  overflow: hidden; pointer-events: auto;
}
#hud #hud-pause-menu { padding: var(--space-4); }
#hud-pause-menu .pm-brand {
  display: flex; align-items: center; justify-content: center; gap: var(--space-4);
  padding-bottom: var(--space-2);
}
#hud-pause-menu .pm-brand-logo {
  width: 2.5rem; height: 2.5rem; border-radius: var(--radius-control);
}
#hud-pause-menu .pm-brand-text {
  display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-1);
}
#hud-pause-menu .pm-brand-title {
  color: var(--title); font-size: var(--font-m); letter-spacing: 0.08em;
}
#hud-pause-menu .pm-brand-version {
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: 0.06em;
}
#hud-pause-menu .pm-header {
  display: flex; align-items: center; gap: var(--space-6); margin-top: var(--space-2); cursor: move;
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
  padding: 0; font: inherit; font-size: var(--font-m); border: 0;
  background: var(--glass-control); color: var(--body); cursor: pointer;
}
#hud-pause-menu .pm-minimize:hover { color: var(--color-primary-hover); background: var(--glass-control-hover); }
#hud-pause-menu .pm-body.hidden { display: none; }
#hud-pause-menu .pm-body { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
#hud-pause-menu .pm-tabs {
  display: flex; flex: 0 0 auto; gap: var(--space-1); margin-top: var(--space-2);
  padding: var(--space-1); border: 0; border-radius: var(--radius-panel);
}
#hud-pause-menu .pm-tabs .w-btn {
  display: flex; flex: 1 1 0; min-width: 0; min-height: var(--hit-target-min);
  align-items: center; justify-content: center; padding: var(--space-2);
  border: 0; border-radius: var(--radius-control); text-align: center;
  font-size: var(--font-s); font-weight: 600; letter-spacing: 0.06em;
  background: transparent; color: var(--text-dim); box-shadow: none;
}
#hud-pause-menu .pm-tabs .w-btn:hover {
  background: var(--glass-control); color: var(--color-primary-hover); transform: none;
}
#hud-pause-menu .pm-tabs .w-btn.on {
  background: var(--color-primary-fill); color: var(--color-primary);
}
#hud-pause-menu .pm-tab-content {
  flex: 1 1 auto; min-height: 0; margin-top: var(--space-2); overflow-y: auto; overscroll-behavior: contain;
}
#hud-pause-menu .pm-tab-panel[hidden],
#hud-pause-menu .pm-settings-view[hidden] { display: none; }
#hud-pause-menu .pm-tab-panel { display: flex; flex-direction: column; }
#hud-pause-menu .pm-row {
  display: flex; justify-content: space-between; align-items: center; gap: var(--space-6); padding: var(--space-2) 0;
}
#hud-pause-menu .pm-actions {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2);
  margin-top: var(--space-2);
}
#hud-pause-menu .pm-actions .pm-row { padding: 0; }
#hud-pause-menu .pm-actions span.pm-quit { margin-top: 0; }
#hud-pause-menu .pm-actions .pm-menu-btn { min-width: 0; }
/* span. まで指定して .w-btn 側の padding/font-size より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#hud-pause-menu span.pm-menu-btn {
  width: 100%; box-sizing: border-box; text-align: center;
  padding: var(--space-4) var(--space-5); font-size: var(--font-m);
}
@media ${MQ_MEDIUM_DOWN} {
  #hud-pause-menu {
    min-width: 0; width: calc(100vw - var(--space-6) - var(--space-6));
  }
}
@media ${MQ_COMPACT} {
  #hud-pause-menu .pm-actions { grid-template-columns: 1fr; }
}
@media ${MQ_SHORT} {
  #hud-pause-menu .pm-brand { padding-bottom: var(--space-1); }
  #hud-pause-menu .pm-header,
  #hud-pause-menu .pm-tabs,
  #hud-pause-menu .pm-tab-content { margin-top: var(--space-1); }
}`;

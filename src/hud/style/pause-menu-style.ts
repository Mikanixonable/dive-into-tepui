// 一時停止 / 設定パネル(#hud-pause-menu)の CSS。
import { MQ_MEDIUM_DOWN } from '../breakpoints';

export const PAUSE_MENU_STYLE = `
/* ポーズメニュー(#hud-pause-menu)。 */
#hud-pause-menu {
  position: fixed; display: none; flex-direction: column;
  --pm-expanded-width: 512px;
  width: min(var(--pm-expanded-width), calc(100vw - var(--space-6) - var(--space-6)));
  max-height: calc(100dvh - var(--space-6) - var(--space-6));
  overflow: hidden; pointer-events: auto;
}
#hud-pause-menu .pm-brand {
  display: flex; flex-direction: column; align-items: center; gap: var(--space-2);
  padding-bottom: var(--space-4); border-bottom: 1px solid var(--edge);
}
#hud-pause-menu .pm-brand-logo {
  width: 2.5rem; height: 2.5rem; border-radius: var(--radius-control);
}
#hud-pause-menu .pm-brand-text {
  display: flex; flex-direction: column; align-items: center; gap: var(--space-1);
}
#hud-pause-menu .pm-brand-title {
  color: var(--title); font-size: var(--font-m); letter-spacing: 0.08em;
}
#hud-pause-menu .pm-brand-version {
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: 0.06em;
}
#hud-pause-menu .pm-header {
  display: flex; align-items: center; gap: var(--space-6); margin-top: var(--space-4); cursor: move;
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
  background: var(--surface-2); color: var(--text-muted); cursor: pointer;
}
#hud-pause-menu .pm-minimize:hover { color: var(--color-primary-hover); background: var(--surface-3); }
#hud-pause-menu .pm-body.hidden { display: none; }
#hud-pause-menu .pm-body { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
#hud-pause-menu .pm-tabs {
  display: flex; flex: 0 0 auto; gap: var(--space-4); margin-top: var(--space-4);
  border: 0; border-bottom: 1px solid var(--edge); border-radius: 0; background: transparent;
}
#hud-pause-menu .pm-tabs .w-btn {
  position: relative; display: flex; flex: 1 1 0; min-width: 0; min-height: 50px;
  align-items: center; justify-content: center; padding: var(--space-3);
  border: 0; border-radius: 0; text-align: center;
  font-size: var(--font-s); font-weight: 600; letter-spacing: 0.06em;
  background: transparent; color: var(--text-dim); box-shadow: none;
}
#hud-pause-menu .pm-tabs .w-btn::before { display: none; }
#hud-pause-menu .pm-tabs .w-btn::after {
  position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; border-radius: 0;
  background: var(--color-primary); content: '';
  opacity: 0; transform: scaleX(0.35); transition: opacity var(--transition-fast), transform var(--transition-fast);
}
#hud-pause-menu .pm-tabs .w-btn:hover {
  background: transparent; color: var(--color-primary-hover); transform: none;
}
#hud-pause-menu .pm-tabs .w-btn.on { border: 0; background: transparent; color: var(--color-primary); }
#hud-pause-menu .pm-tabs .w-btn.on::after { opacity: 1; transform: scaleX(1); }
#hud-pause-menu .pm-tab-content {
  flex: 1 1 auto; min-height: 0; margin-top: var(--space-4); overflow-y: auto; overscroll-behavior: contain;
}
#hud-pause-menu .pm-tab-panel[hidden],
#hud-pause-menu .pm-settings-view[hidden] { display: none; }
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
  #hud-pause-menu {
    min-width: 0; width: calc(100vw - var(--space-6) - var(--space-6));
  }
}`;

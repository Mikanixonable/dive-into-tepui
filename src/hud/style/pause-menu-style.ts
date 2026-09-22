// 一時停止 / 設定パネル(#hud-pause-menu)の CSS。
import { MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT } from '../breakpoints';

export const PAUSE_MENU_STYLE = `
/* ポーズメニュー(#hud-pause-menu)。 */
#hud-pause-menu {
  position: fixed; display: none;
  --pm-expanded-width: 920px;
  grid-template-columns: minmax(250px, .78fr) minmax(0, 1.22fr);
  gap: var(--space-6);
  width: min(var(--pm-expanded-width), calc(100vw - var(--space-6) - var(--space-6)));
  max-height: calc(100dvh - var(--space-6) - var(--space-6));
  overflow: hidden; pointer-events: auto;
}
#hud #hud-pause-menu { padding: var(--space-6); }
#hud-pause-menu.minimized {
  grid-template-columns: minmax(260px, 360px);
  width: min(360px, calc(100vw - var(--space-6) - var(--space-6)));
}
#hud-pause-menu.minimized .pm-header { padding-right: 0; box-shadow: none; }
#hud-pause-menu .pm-header {
  display: flex; min-width: 0; flex-direction: column; gap: var(--space-3);
  padding-right: var(--space-5);
  box-shadow: inset -1px 0 0 color-mix(in srgb, var(--text-dim) 22%, transparent);
  cursor: move;
}
#hud-pause-menu .pm-header-top {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start;
}
#hud-pause-menu .pm-brand {
  position: relative; display: grid; grid-column: 1; gap: var(--space-4);
  min-height: 220px; align-content: end;
}
#hud-pause-menu .pm-brand-logotype {
  display: grid; width: fit-content; color: var(--text-strong);
  font-size: clamp(2.6rem, 6vw, 4.7rem); font-weight: 650; letter-spacing: -.075em; line-height: .78;
}
#hud-pause-menu .pm-brand-logotype span:nth-child(2) { margin-left: .36em; }
#hud-pause-menu .pm-brand-logotype span:nth-child(3) { margin-left: .72em; color: var(--color-primary-hover); }
#hud-pause-menu .pm-brand-meta { display: flex; align-items: baseline; gap: var(--space-3); }
#hud-pause-menu .pm-brand-logo {
  position: absolute; top: 0; left: 0; width: 2rem; height: 2rem; border-radius: var(--radius-control); opacity: .72;
}
#hud-pause-menu .pm-brand-version {
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: 0.06em;
}
#hud-pause-menu .pm-header h3 { min-width: 0; margin: auto 0 0; }
#hud-pause-menu .pm-system-heading { display: flex; align-items: baseline; gap: var(--space-2); color: var(--text); }
#hud-pause-menu .pm-system-sub { padding-bottom: var(--space-3); }
#hud-pause-menu .pm-header-actions {
  display: flex; grid-column: 2; align-items: center; justify-self: end; gap: var(--space-2); flex: 0 0 auto;
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
#hud-pause-menu .pm-body { display: flex; min-width: 0; flex-direction: column; min-height: 0; }
#hud-pause-menu .pm-tabs,
#hud-pause-menu .pm-settings-view .sv-tabs {
  display: flex; flex: 0 0 auto; gap: var(--space-1); margin-top: var(--space-2);
  padding: var(--space-1); border: 0; border-radius: var(--radius-panel);
}
#hud-pause-menu .pm-settings-view .sv-tabs {
  width: 100%; margin-top: var(--space-4);
}
#hud-pause-menu .pm-tabs .w-btn,
#hud-pause-menu .pm-settings-view .sv-tabs .w-btn {
  display: flex; flex: 1 1 0; min-width: 0; min-height: var(--hit-target-min);
  align-items: center; justify-content: center; padding: var(--space-2) var(--space-3);
  border: 0; border-radius: var(--radius-control); text-align: center;
  font-size: var(--font-m); font-weight: 600; letter-spacing: 0.06em;
  background: transparent; color: var(--text-dim); box-shadow: none;
}
#hud-pause-menu .pm-tabs .w-btn:hover,
#hud-pause-menu .pm-settings-view .sv-tabs .w-btn:hover {
  background: var(--glass-control); color: var(--color-primary-hover); transform: none;
}
#hud-pause-menu .pm-tabs .w-btn.on,
#hud-pause-menu .pm-settings-view .sv-tabs .w-btn.on {
  background: var(--color-primary-fill); color: var(--color-primary);
}
#hud-pause-menu .pm-tab-content {
  flex: 1 1 auto; min-width: 0; min-height: 0; margin-top: var(--space-2);
  overflow-y: auto; overscroll-behavior: contain;
}
#hud-pause-menu .pm-tab-panel[hidden],
#hud-pause-menu .pm-settings-view[hidden] { display: none; }
#hud-pause-menu .pm-tab-panel { display: flex; flex-direction: column; }
#hud-pause-menu .pm-row {
  display: flex; justify-content: space-between; align-items: center; gap: var(--space-6); padding: var(--space-2) 0;
}
#hud-pause-menu .pm-actions {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 1px;
  margin-top: var(--space-4);
}
#hud-pause-menu .pm-actions .pm-row { padding: 0; }
#hud-pause-menu .pm-actions span.pm-quit { margin-top: 0; }
#hud-pause-menu .pm-actions .pm-menu-btn { min-width: 0; }
/* span. まで指定して .w-btn 側の padding/font-size より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#hud-pause-menu span.pm-menu-btn {
  width: 100%; box-sizing: border-box; text-align: left;
  padding: var(--space-4) var(--space-3); border-radius: 0;
  background: transparent; box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 14%, transparent);
  font-size: var(--font-m); letter-spacing: .03em;
}
#hud-pause-menu span.pm-menu-btn:hover { box-shadow: inset 2px 0 0 var(--color-primary), inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 14%, transparent); }
#hud-pause-menu span.pm-quit { color: var(--color-warning); }
@media ${MQ_MEDIUM_DOWN} {
  #hud-pause-menu {
    min-width: 0; width: calc(100vw - var(--space-6) - var(--space-6));
  }
}
@media ${MQ_COMPACT} {
  #hud-pause-menu { grid-template-columns: minmax(0, 1fr); gap: var(--space-3); }
  #hud #hud-pause-menu { padding: var(--space-4); }
  #hud-pause-menu .pm-header {
    padding-right: 0; padding-bottom: var(--space-3);
    box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 22%, transparent);
  }
  #hud-pause-menu .pm-header-top { grid-template-columns: minmax(0, 1fr) auto; }
  #hud-pause-menu .pm-brand { grid-column: 1; min-height: 112px; justify-self: start; }
  #hud-pause-menu .pm-brand-logotype { font-size: clamp(2rem, 12vw, 3.3rem); }
  #hud-pause-menu .pm-brand-meta { display: none; }
  #hud-pause-menu .pm-header-actions { grid-column: 2; }
  #hud-pause-menu .pm-actions { grid-template-columns: 1fr; }
}
@media ${MQ_SHORT} {
  #hud-pause-menu .pm-header { gap: var(--space-1); }
  #hud-pause-menu .pm-tabs,
  #hud-pause-menu .pm-tab-content { margin-top: var(--space-1); }
}`;

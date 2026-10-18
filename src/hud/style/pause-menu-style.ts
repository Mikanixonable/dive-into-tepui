// 一時停止 / 設定パネル(#hud-pause-menu)の CSS。
import { MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT } from '../breakpoints';

export const PAUSE_MENU_STYLE = `
/* ポーズメニュー(#hud-pause-menu)。左にブランド、右にタブ・本文。 */
#hud-pause-menu {
  position: fixed; display: none;
  --pm-expanded-width: 920px;
  grid-template-columns: minmax(150px, .4fr) minmax(0, 1.6fr);
  /* 行をコンテナ高へキャップしないと本文が内容高に張られ、max-height を超えた分が
     overflow:hidden で切れて .pm-tab-content のスクロールが発動しない。 */
  grid-template-rows: minmax(0, 1fr);
  gap: var(--space-6);
  width: min(var(--pm-expanded-width), calc(100vw - var(--space-6) - var(--space-6)));
  max-height: var(--overlay-max-h-l);
  overflow: hidden; pointer-events: auto;
}
#hud #hud-pause-menu { padding: var(--space-6); }
#hud-pause-menu.minimized {
  grid-template-columns: minmax(0, 1fr) auto;
  width: min(360px, calc(100vw - var(--space-6) - var(--space-6)));
}
#hud-pause-menu.minimized .pm-tabs { display: none; }
#hud-pause-menu.minimized .pm-top { justify-content: flex-end; }
#hud-pause-menu .pm-brand {
  display: grid; min-width: 0; align-content: space-between; gap: var(--space-5); cursor: move;
}
#hud-pause-menu .pm-brand .title-logotype { font-size: clamp(1.3rem, 3vw, 2.35rem); }
#hud-pause-menu .pm-brand .title-logotype sup,
#hud-pause-menu .pm-brand .title-logotype sub {
  left: calc(100% + var(--space-2));
  font-size: clamp(0.5rem, 1vw, 0.75rem);
}
#hud-pause-menu .pm-brand-meta { display: grid; gap: var(--space-2); justify-items: start; }
#hud-pause-menu .pm-brand-version {
  color: var(--role-meta); font-size: var(--font-xxs); letter-spacing: var(--tracking-label);
}
#hud-pause-menu .pm-brand-pip { margin-top: var(--space-3); }
#hud-pause-menu .pm-main { display: flex; min-width: 0; min-height: 0; flex-direction: column; gap: var(--space-5); }
#hud-pause-menu .pm-top { display: flex; flex: 0 0 auto; align-items: center; gap: var(--space-4); cursor: move; }
#hud-pause-menu .pm-tabs { flex: 1 1 auto; }
#hud-pause-menu .pm-tabs .w-btn { min-height: var(--hit-target-min); font-size: var(--font-m); }
#hud-pause-menu .pm-body.hidden { display: none; }
#hud-pause-menu .pm-body { display: flex; min-width: 0; flex-direction: column; min-height: 0; }
#hud-pause-menu .pm-tab-content {
  flex: 1 1 auto; min-width: 0; min-height: 0;
  overflow-y: auto; overscroll-behavior: contain;
}
#hud-pause-menu .pm-tab-panel[hidden],
#hud-pause-menu .pm-settings-view[hidden] { display: none; }
#hud-pause-menu .pm-tab-panel { display: flex; flex-direction: column; gap: var(--space-5); }
#hud-pause-menu .pm-bgm {
  display: grid; grid-template-columns: auto minmax(0, 1fr) 4em auto; align-items: center;
  column-gap: var(--space-5); min-height: var(--hit-target-min);
}
#hud-pause-menu .pm-bgm .w-slider { width: 100%; accent-color: var(--text-muted); }
#hud-pause-menu .pm-bgm-value { justify-self: end; color: var(--role-label); }
#hud-pause-menu .pm-bgm .w-btn--icon.on .pm-speaker-waves,
#hud-pause-menu .pm-bgm .w-btn--icon:not(.on) .pm-speaker-slash { display: none; }
#hud-pause-menu .pm-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
#hud-pause-menu .pm-menu-btn {
  display: inline-flex; align-items: center; justify-content: space-between; box-sizing: border-box;
  min-height: var(--hit-target-min); padding-inline: var(--space-5); text-align: left; font-size: var(--font-m);
}
#hud-pause-menu .pm-quit { grid-column: 1 / -1; margin-top: var(--space-4); }
#hud-pause-menu .pm-quit::after { content: '→'; margin-left: auto; color: var(--role-label); }
@media ${MQ_MEDIUM_DOWN} {
  #hud-pause-menu {
    min-width: 0; width: calc(100vw - var(--space-6) - var(--space-6));
  }
}
@media ${MQ_COMPACT} {
  /* 1列化でブランドと本文が2行に分かれるので、本文行を残り高さへキャップする。 */
  #hud-pause-menu { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); gap: var(--space-3); }
  #hud #hud-pause-menu { padding: var(--space-4); }
  #hud-pause-menu.minimized { grid-template-columns: minmax(0, 1fr); }
  #hud-pause-menu .pm-brand .title-logotype { font-size: clamp(2rem, 12vw, 3.3rem); }
  #hud-pause-menu .pm-brand-meta { display: none; }
  #hud-pause-menu .pm-actions { grid-template-columns: minmax(0, 1fr); }
}
@media ${MQ_SHORT} {
  #hud-pause-menu .pm-main { gap: var(--space-2); }
}`;

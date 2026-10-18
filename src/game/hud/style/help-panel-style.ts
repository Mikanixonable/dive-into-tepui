// ヘルプ画面(#hud-help)の CSS。
import { MQ_COMPACT, MQ_MEDIUM_DOWN } from '../../../hud/breakpoints';

export const HELP_PANEL_STYLE = `
#hud-help {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  display: none; flex-direction: column; width: min(920px, calc(100vw - 24px)); min-width: 0;
  max-height: var(--overlay-max-h-l); overflow: hidden; pointer-events: auto;
}
#hud-help .help-header {
  display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; column-gap: var(--space-5);
  padding-bottom: var(--space-4);
}
#hud-help .help-header h3 {
  margin: 0; color: var(--text-strong); font-size: var(--font-2xl);
  font-weight: 650; letter-spacing: var(--tracking-title);
}
#hud-help .help-tabs { flex: 0 0 auto; margin-bottom: var(--space-4); overflow-x: auto; scrollbar-width: none; }
#hud-help .help-body { min-height: 0; overflow-y: auto; padding-right: var(--space-2); }
#hud-help .help-section[hidden] { display: none !important; }
#hud-help .help-reference-list { display: grid; }
#hud-help .help-reference-row {
  display: grid; grid-template-columns: minmax(0, .42fr) minmax(0, 1fr);
  align-items: start; column-gap: var(--space-6); padding-block: var(--space-3);
}
#hud-help .help-reference-input {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); min-width: 0;
  min-height: var(--key-cap-min);
}
#hud-help .help-or { color: var(--role-meta); font-size: var(--font-xxs); }
#hud-help .help-reference-command { min-width: 0; }
#hud-help .help-reference-command > strong { color: var(--text); font-size: var(--font-s); }
#hud-help .help-reference-command > p {
  margin: var(--space-1) 0 0; color: var(--role-label);
  font-size: var(--font-xs); line-height: 1.55;
}
@media ${MQ_MEDIUM_DOWN} {
  #hud-help { width: 94vw; max-height: var(--overlay-max-h-l); }
}
@media ${MQ_COMPACT} {
  #hud-help { width: calc(100vw - 16px); }
  #hud-help .help-header h3 { font-size: var(--font-xl); }
  #hud-help .help-tabs { flex-wrap: wrap; margin-bottom: var(--space-2); overflow: visible; }
  #hud-help .help-reference-row {
    grid-template-columns: minmax(0, 1fr); gap: var(--space-1);
    padding-inline: var(--space-3);
  }
}
`;

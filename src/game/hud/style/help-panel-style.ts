// ヘルプ画面(#hud-help)の CSS。
import { MQ_COMPACT, MQ_MEDIUM_DOWN } from '../../../hud/breakpoints';

export const HELP_PANEL_STYLE = `
#hud-help {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  display: none; flex-direction: column; width: min(920px, calc(100vw - 24px)); min-width: 0;
  max-height: min(90vh, 900px); max-height: min(90dvh, 900px); overflow: hidden; pointer-events: auto;
}
#hud-help .help-header {
  display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-5);
  padding-bottom: var(--space-4);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 22%, transparent);
}
#hud-help .help-heading { display: grid; gap: var(--space-1); min-width: 0; }
#hud-help .help-heading > div:first-child { display: flex; align-items: baseline; gap: var(--space-2); }
#hud-help .help-kicker {
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: .12em;
}
#hud-help .help-header h3 {
  margin: 0; color: var(--text-strong); font-size: var(--font-2xl);
  font-weight: 650; letter-spacing: -.03em;
}
#hud-help .help-context { margin-top: var(--space-1); }
#hud-help .help-tabs {
  flex: 0 0 auto; display: flex; gap: var(--space-1);
  margin: var(--space-3) 0; overflow-x: auto; scrollbar-width: none;
}
#hud-help .help-body { min-height: 0; overflow-y: auto; padding-right: var(--space-2); }
#hud-help .help-section[hidden] { display: none !important; }
#hud-help .help-reference-list { display: grid; }
#hud-help .help-reference-row {
  display: grid; grid-template-columns: clamp(150px, 24%, 210px) minmax(0, 1fr);
  align-items: start; gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 10%, transparent);
}
#hud-help .help-reference-input {
  min-width: 0; color: var(--color-primary-hover);
  font-size: var(--font-xxs); font-weight: 700;
  font-variant-numeric: tabular-nums; letter-spacing: .04em;
}
#hud-help .help-input-code { display: block; max-width: 100%; overflow-wrap: anywhere; }
#hud-help .help-reference-command { min-width: 0; }
#hud-help .help-reference-command > strong { color: var(--text); font-size: var(--font-xs); }
#hud-help .help-reference-command > p {
  margin: var(--space-1) 0 0; color: var(--text-dim);
  font-size: var(--font-xxs); line-height: 1.55;
}
@media ${MQ_MEDIUM_DOWN} {
  #hud-help { width: 94vw; max-height: 88vh; max-height: 88dvh; }
}
@media ${MQ_COMPACT} {
  #hud-help { width: calc(100vw - 16px); }
  #hud-help .help-header h3 { font-size: var(--font-xl); }
  #hud-help .help-tabs { margin-block: var(--space-2); }
  #hud-help .help-reference-row {
    grid-template-columns: minmax(0, 1fr); gap: var(--space-1);
    padding-inline: var(--space-3);
  }
}
`;

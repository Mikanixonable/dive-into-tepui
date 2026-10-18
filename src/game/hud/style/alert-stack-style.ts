// 画面中央上部に積む警報帯・ブリーフィングのカード・案内チップの置き場の CSS。
// 部品そのもの(.ui-alert .ui-more .ui-hint)の見た目は共通層(alarm-style.ts)が持つ。
export const ALERT_STACK_STYLE = `
#hud-alert-stack {
  position: absolute; top: calc(var(--hud-chrome-h) + var(--space-2)); left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
  width: max-content; max-width: min(720px, calc(100vw - var(--space-6) * 2));
}
#hud-alarm-band { display: flex; flex-direction: column; align-items: stretch; gap: var(--space-3); max-width: 100%; }
#hud-alarm-band .ui-alert { pointer-events: auto; }
#hud-briefing {
  display: grid; gap: var(--space-2); padding: var(--space-4) var(--space-5); font-size: var(--font-s); line-height: 1.6;
  color: var(--role-data);
}
#hud-briefing .ui-alert-level { color: var(--role-meta); line-height: inherit; }
#hud-hint { pointer-events: none; }
`;

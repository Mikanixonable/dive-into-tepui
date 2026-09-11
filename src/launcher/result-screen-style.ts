// 勝敗結果画面(#hud-result)の CSS。
import { MQ_MEDIUM_DOWN } from '../hud/breakpoints';

export const RESULT_SCREEN_STYLE = `

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
  border-radius: var(--radius-panel); padding: var(--space-6) var(--space-6);
}
#hud-result .result-actions {
  display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
  margin-top: var(--space-6);
}
@media ${MQ_MEDIUM_DOWN} {
  #hud-result h1 { font-size: var(--font-2xl); letter-spacing: 3px; }
  #hud-result .detail { font-size: var(--font-l); padding: var(--space-5) var(--space-6); max-width: 92vw; }
}
`;

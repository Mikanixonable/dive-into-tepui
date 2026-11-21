// 武装の帯(#hud-armament-band)の CSS。
import { MQ_MEDIUM_DOWN } from '../../../hud-kit/breakpoints';

export const ARMAMENT_BAND_STYLE = `
/* 武装の帯が見えている間だけ、帯の上端まで combat rail の下端を予約する。
   ステージ状態の帯の上に積むので、ステージ状態の帯とタッチパッドのうち高い方へ
   間隔と帯の高さぶんを足す。 */
#hud:has(#hud-armament-band:not(.hidden)) {
  --hud-armament-bottom-occupied: calc(max(var(--hud-stage-bottom-occupied, 0px), var(--hud-rail-bottom)) + var(--space-4) + 52px);
}
#hud-armament-band {
  bottom: calc(max(var(--hud-stage-bottom-occupied, 0px), var(--hud-rail-bottom)) + var(--space-4) + var(--safe-b));
  left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: var(--space-4);
  padding: var(--space-3) var(--space-5); pointer-events: auto; white-space: nowrap;
  font-size: var(--font-s); font-variant-numeric: tabular-nums;
}
#hud-armament-band .armament-code {
  color: var(--role-meta); font-size: var(--font-xxs); font-weight: 700; letter-spacing: var(--tracking-code);
}
#hud-armament-band .armament-status { color: var(--text); }
#hud-armament-band .armament-velocity { color: var(--text-dim); }
@media ${MQ_MEDIUM_DOWN} {
  #hud-armament-band { padding: var(--space-2) var(--space-4); gap: var(--space-3); }
}`;

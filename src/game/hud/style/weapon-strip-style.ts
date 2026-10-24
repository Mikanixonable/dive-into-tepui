// 武装の帯(#hud-weapon-strip)の意匠: 戦闘ビューの画面下中央に固定する Quiet Glass の帯。
// 弾帯は残弾のセルを中立で、使用済みを薄く示し、段(注意・警告)が付いたときだけ色と記号を帯びる。
import { MQ_COARSE, MQ_COARSE_SHORT } from '../../../hud/breakpoints';

export const WEAPON_STRIP_STYLE = `
#hud-weapon-strip {
  position: absolute; left: 50%; bottom: var(--hud-rail-bottom); transform: translateX(-50%);
  display: flex; align-items: center; gap: var(--space-5); max-width: calc(100% - 2 * max(var(--hud-left-rail-occupied), var(--hud-right-rail-occupied)));
  padding: var(--space-3) var(--space-5); border-radius: var(--radius-pill);
  font-size: var(--font-xs); font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: auto;
}
#hud.construction-mode #hud-weapon-strip { display: none !important; }
#hud-weapon-strip .weapon-label { font-size: var(--font-xxs); letter-spacing: var(--tracking-label); color: var(--role-meta); }
#hud-weapon-strip .weapon-belt { display: flex; gap: var(--space-1); min-width: 0; }
#hud-weapon-strip .weapon-belt > i {
  flex: 0 0 auto; width: var(--space-2); height: 1.2em; border-radius: var(--space-1);
  background: var(--text-muted);
}
#hud-weapon-strip .weapon-belt > i.spent { background: var(--fill-2); }
#hud-weapon-strip .weapon-count, #hud-weapon-strip .weapon-mags { font-size: var(--font-m); color: var(--role-data); }
#hud-weapon-strip.ui-caution .weapon-belt > i:not(.spent) { background: var(--role-caution); }
#hud-weapon-strip.ui-caution::before, #hud-weapon-strip.ui-warning::before { margin-right: 0; }
#hud-weapon-strip.ui-warning .weapon-count { color: var(--role-warning); }
#hud-weapon-strip .weapon-reload .w-btn { display: inline-flex; align-items: center; }

@media ${MQ_COARSE} {
  #hud-weapon-strip { gap: var(--space-4); padding: var(--space-2) var(--space-4); }
}
/* スマホ横持ちは左右のレールの間に収める: 弾帯のセルを詰め、「弾」の語を省く。 */
@media ${MQ_COARSE_SHORT} {
  #hud-weapon-strip { max-width: calc(100% - 2 * (var(--hud-pad-side) + var(--space-4))); }
  #hud-weapon-strip .weapon-belt { overflow: hidden; }
  #hud-weapon-strip > .weapon-label:first-child { display: none; }
  #hud-weapon-strip .weapon-belt { gap: 0; }
  #hud-weapon-strip .weapon-belt > i { width: var(--space-1); border-radius: 0; }
}
`;

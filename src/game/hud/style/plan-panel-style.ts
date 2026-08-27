// MANEUVER PLAN パネルと、表示設定パネル群が共有する行部品(.w-group/.w-toggle/.body-class-row)
// の CSS。
import { MQ_COARSE, MQ_COMPACT, MQ_MEDIUM_DOWN } from '../breakpoints';

export const PLAN_PANEL_STYLE = `
#hud .hud-rail > #hud-object-placer { max-height: none; overflow: visible; }
#hud .hud-rail > #hud-plan { width: 100%; min-width: 0; max-width: none; max-height: none; overflow: visible; }
/* MANEUVER PLAN はマップ操作の主パネルとして右レールの最上段に固定する。 */
#hud .hud-rail-right > #hud-plan {
  order: -1;
  align-self: flex-end;
  margin-left: auto;
}

#hud-plan { min-width: 0; width: 100%; max-width: 300px; overflow-wrap: anywhere; }
#hud .w-group { margin-bottom: var(--space-3); }
#hud .w-toggle { margin-bottom: var(--space-3); }
/* body-class-row: カテゴリー見出し + 名前/軌道線トグルの1行(太陽系・表示パネル)。
   見出しは幅を固定して縦に揃え、長い名前(ラグランジュ点など)は省略する。 */
#hud .body-class-row { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-2); }
#hud .body-class-row .body-class-title {
  width: 96px; min-width: 96px; text-align: left; font-size: var(--font-xs); letter-spacing: 1px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#hud .body-class-row .body-class-btns { display: flex; gap: var(--space-2); }
/* span. まで指定して .w-btn 側の padding/font-size より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#hud span.body-class-icon-btn { min-width: 20px; padding: var(--space-2) var(--space-3); text-align: center; font-size: var(--font-m); }
@media ${MQ_COARSE} {
  #hud span.body-class-icon-btn { min-width: var(--hit-target-min); min-height: var(--hit-target-min); }
}
#hud .body-class-row.category-off .body-class-icon-btn.on { border-color: var(--edge); color: var(--text-dim); font-weight: 700; opacity: .65; }
@media ${MQ_MEDIUM_DOWN} {
  #hud-plan { min-width: 0; max-width: none; }
}
@media ${MQ_COMPACT} {
  #hud .w-group { gap: var(--space-2); }
  #hud .w-btn { padding: var(--space-2) var(--space-3); font-size: var(--font-xxs); }
}
`;

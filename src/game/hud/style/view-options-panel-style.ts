// 表示設定パネル(#hud-view-options)の CSS。カテゴリー見出し + 名前/軌道線トグルの行部品
// (.body-class-row 系)はこのパネルだけが使う。
import { MQ_COARSE, MQ_MEDIUM_DOWN } from '../../../hud-kit/breakpoints';

export const VIEW_OPTIONS_PANEL_STYLE = `
/* body-class-row: カテゴリー見出し + 名前/軌道線トグルの1行(太陽系・表示パネル)。
   見出しは幅を固定して縦に揃え、長い名前(ラグランジュ点など)は省略する。 */
#hud .body-class-row { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-2); }
#hud .body-class-row .body-class-title {
  width: 96px; min-width: 96px; text-align: left; font-size: var(--font-xs); letter-spacing: var(--tracking-label);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#hud .body-class-row .body-class-btns { display: flex; gap: var(--space-2); }
/* このパネル固有の密度として操作ボタン寸法を定義する。 */
#hud span.body-class-icon-btn { min-width: 20px; padding: var(--space-2) var(--space-3); text-align: center; font-size: var(--font-m); }
@media ${MQ_COARSE} {
  #hud span.body-class-icon-btn { min-width: var(--hit-target-min); min-height: var(--hit-target-min); }
}

/* コンテナ・タイトル・本体と、タブ本体。 */
#hud-view-options { width: 100%; pointer-events: auto; }
#hud-view-options .view-options-title { flex: 0 0 auto; display: flex; align-items: center; gap: var(--space-2); cursor: pointer; }
#hud-view-options .view-options-collapse { margin-left: auto; background: none; border: none; color: var(--text-dim); font: inherit; cursor: pointer; pointer-events: auto; }
/* タブ切替(.w-tabs)は常に見えたまま、選択中のタブ本文だけをスクロールさせる——
   タイトル行・タブ切替をスクロールへ巻き込むと、下までスクロールした状態でタブへ
   手が届かなくなる。 */
#hud-view-options .view-options-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
#hud-view-options .view-options-body.collapsed { display: none !important; }
/* 表示パネルのタブ列と、選択中以外のタブ本体を隠す。選択中のタブ本体だけが
   view-options-body の残り高さを占めてスクロールする。 */
#hud-view-options .w-tabs { flex: 0 0 auto; margin-bottom: var(--space-3); }
#hud-view-options .view-options-tab-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-width: thin;
}
#hud-view-options .view-options-tab-body.hidden { display: none !important; }

/* DISPLAY INDEX — タイトル画面の stage list と同じ「名称 + 右端状態」の索引型。 */
#hud-view-options .view-options-render-row {
  grid-template-columns: 2.4em minmax(0, 1fr) auto;
  margin: var(--space-3) 0 var(--space-2);
  padding-inline: var(--space-2);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 16%, transparent);
}
#hud-view-options .view-options-render-label { display: grid; gap: var(--space-1); min-width: 0; }
#hud-view-options .view-options-render-label > span {
  color: var(--text); font-size: var(--font-xs); letter-spacing: 0;
}
#hud-view-options .view-options-render-label > small {
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: var(--tracking-label);
}
#hud-view-options .view-options-render-choices {
  display: inline-flex; justify-self: end; align-items: stretch; gap: 1px;
  min-width: 0;
}
#hud-view-options .view-options-render-choice {
  min-width: 0; padding-inline: var(--space-3); border-radius: 0;
  background: transparent; color: var(--text-dim);
}
#hud-view-options .view-options-render-choice.on {
  background: var(--color-primary-fill-weak); color: var(--color-primary);
}
#hud-view-options .view-options-render-choice:first-child {
  border-radius: var(--radius-control) 0 0 var(--radius-control);
}
#hud-view-options .view-options-render-choice:last-child {
  border-radius: 0 var(--radius-control) var(--radius-control) 0;
}
@media ${MQ_MEDIUM_DOWN} {
  #hud-view-options .view-options-render-row {
    grid-template-columns: 2.4em minmax(0, 1fr);
  }
  #hud-view-options .view-options-render-choices {
    grid-column: 2; justify-self: stretch; width: 100%;
  }
  #hud-view-options .view-options-render-choice { flex: 1 1 0; text-align: center; }
}

#hud-view-options .view-options-title {
  align-items: baseline; padding-bottom: var(--space-3);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 24%, transparent);
}
#hud-view-options .view-options-context {
  min-width: 0; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#hud-view-options .view-options-title .view-options-collapse { margin-left: var(--space-2); }
#hud-view-options .view-options-body > .w-tabs { margin-top: var(--space-3); }
#hud-view-options .view-options-section-divider {
  margin-top: var(--space-4); margin-bottom: var(--space-1);
}
/* 対象タブ: 1クラス1チップ。名前の部分がラベル、右端の軌道の図が軌道線のトグル。チップは内容の
   幅で折り返す。ラベルが点灯しているチップは地ごと自分の色を帯びる。 */
#hud-view-options .target-chip-group { display: flex; flex-wrap: wrap; gap: var(--space-2); }
#hud-view-options .target-chip {
  display: inline-flex; align-items: stretch; overflow: hidden;
  border-radius: var(--radius-pill); background: var(--glass-control);
  transition: background var(--transition-fast);
}
#hud-view-options .target-chip:has(> .target-chip-name.on) { background: var(--color-primary-fill-weak); }
#hud-view-options .target-chip > .w-btn {
  display: inline-flex; align-items: center; border: 0; border-radius: 0;
  background: transparent; touch-action: none;
}
#hud-view-options .target-chip-name {
  gap: var(--space-2); padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  color: var(--text-dim); font-size: var(--font-xs); white-space: nowrap;
}
#hud-view-options .target-chip-name .w-btn-icon { margin-right: 0; color: var(--text-faint); }
#hud-view-options .target-chip-name.on { color: var(--title); }
#hud-view-options .target-chip-name.on .w-btn-icon { color: var(--color-primary-hover); }
#hud-view-options .target-chip-orbit {
  justify-content: center; padding: var(--space-2) var(--space-3);
  box-shadow: inset 1px 0 0 color-mix(in srgb, var(--text-dim) 18%, transparent);
  color: var(--text-faint);
}
#hud-view-options .target-chip-orbit .w-btn-icon { width: 1.3em; height: 1em; margin: 0; }
#hud-view-options .target-chip-orbit.on { color: var(--color-primary); }
#hud-view-options .target-chip > .w-btn:hover { background: var(--glass-control-hover); }
@media ${MQ_COARSE} {
  #hud-view-options .target-chip > .w-btn { min-height: var(--hit-target-min); }
  #hud-view-options .target-chip-orbit { min-width: var(--hit-target-min); }
}
#hud-view-options .view-options-section-heading {
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: var(--tracking-label);
}
#hud-view-options .grid-class-row {
  padding-block: var(--space-1); box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text-dim) 12%, transparent);
}
`;

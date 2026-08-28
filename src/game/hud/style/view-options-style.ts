// 表示設定パネル(#hud-view-options)のコンテナ・タイトル・本体と、タブ本体の CSS。
export const VIEW_OPTIONS_STYLE = `
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
`;

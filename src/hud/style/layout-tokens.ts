// hud/ のウィジェット・オーバーレイが共有する寸法・字間の CSS 変数。#hud の外の画面でも
// 同じ名前で読めるよう :root に定義し、共通注入(injectCommonUiStyle)で運ぶ。
export const HUD_LAYOUT_TOKENS_STYLE = `
:root {
  /* overlay の高さを役割別の3段階に揃える。 */
  --overlay-max-h-s: min(56dvh, 520px);
  --overlay-max-h-m: min(72dvh, 720px);
  --overlay-max-h-l: min(88dvh, 900px);
  /* Editorial UI の字間。局所的な .06/.11/.16em の増殖を避ける。 */
  --tracking-label: .08em;
  --tracking-code: .14em;
  --tracking-title: -.025em;
  /* 表示トグルが OFF の行・区画を淡色化するときの不透明度。 */
  --toggle-off-opacity: .52;
}
`;

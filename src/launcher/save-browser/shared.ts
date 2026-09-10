// セーブブラウザの左右ペイン(スロット一覧・スナップショット一覧)が共通で使う表示部品。
// 汎用ボタンの組み立てと、ステージ id から表示名への解決を持つ。
import { Button } from '../../hud/widgets';
import { injectOnce } from '../../hud/inject-style';
import { findStageClass } from '../../game/stages/stage-dictionary';

const STYLE = `
/* sb-btn はセーブブラウザ内の配置・密度フック。面と状態は w-btn の variant に委ねる。 */
#save-browser span.sb-btn:not(.w-btn--dense) {
  padding: var(--space-2) var(--space-4); font-size: var(--font-xs);
  white-space: nowrap;
}
#save-browser span.sb-btn { white-space: nowrap; }
#save-browser span.sb-btn.sb-btn-sm { padding: var(--space-2) var(--space-3); }
`;

// ステージ id を選択画面と同じ表示名にする。登録の無い id はそのまま出す。
export function stageLabel(stageId: string): string {
  return findStageClass(stageId)?.selectLabel ?? stageId;
}

// .sb-btn の主要ボタン(横幅いっぱい・文言そのまま)を組む。
export function mainBtn(label: string, onClick: () => void): HTMLElement {
  injectOnce('save-browser-shared', STYLE);
  const btn = new Button(label, onClick, undefined, 'secondary');
  btn.element.classList.add('sb-btn');
  return btn.element;
}

// .w-btn--dense/.w-btn--icon の小型アイコンボタンを組む。title はホバー説明とタッチ向け aria-label の両方に使う。
export function smallBtn(glyph: string, title: string, onClick: () => void): HTMLElement {
  injectOnce('save-browser-shared', STYLE);
  const btn = new Button(glyph, onClick, undefined, ['secondary', 'dense', 'icon']);
  btn.element.classList.add('sb-btn');
  btn.element.title = title;
  btn.element.setAttribute('aria-label', title);
  return btn.element;
}

// セーブブラウザの左右ペイン(スロット一覧・スナップショット一覧)が共通で使う表示部品。
// 汎用ボタンの組み立てと、ステージ id から表示名への解決を持つ。
// ペイン自身の状態・一覧の並び順には触れない。
import { Button } from '../../hud/widgets';
import { injectOnce } from '../../hud/widgets/inject-style';
import { findStageClass } from '../../game/stages/stage-dictionary';

const STYLE = `
/* span. まで指定して .w-btn 側の見た目より確実に勝たせる
   (.w-btn は #hud 修飾を持たないため詳細度では確実に負けるが、意図を明示しておく)。 */
#save-browser span.sb-btn {
  padding: var(--space-2) var(--space-4); background: var(--fill-1); color: var(--text-dim); font-size: var(--font-xs);
  white-space: nowrap;
}
#save-browser span.sb-btn:hover { background: var(--fill-2); color: var(--text); }
#save-browser span.sb-btn.sb-btn-sm { padding: var(--space-2) var(--space-3); }
`;

// ステージ id を選択画面と同じ表示名にする。登録の無い id はそのまま出す。
export function stageLabel(stageId: string): string {
  return findStageClass(stageId)?.selectLabel ?? stageId;
}

// .sb-btn の主要ボタン(横幅いっぱい・文言そのまま)を組む。
export function mainBtn(label: string, onClick: () => void): HTMLElement {
  injectOnce('save-browser-shared', STYLE);
  const btn = new Button(label, onClick);
  btn.element.classList.add('sb-btn');
  return btn.element;
}

// .sb-btn.sb-btn-sm の小型アイコンボタンを組む。title はホバー説明とタッチ向け aria-label の両方に使う。
export function smallBtn(glyph: string, title: string, onClick: () => void): HTMLElement {
  injectOnce('save-browser-shared', STYLE);
  const btn = new Button(glyph, onClick);
  btn.element.classList.add('sb-btn', 'sb-btn-sm');
  btn.element.title = title;
  btn.element.setAttribute('aria-label', title);
  return btn.element;
}

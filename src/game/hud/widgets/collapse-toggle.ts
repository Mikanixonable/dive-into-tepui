// 縦方向の開閉トグル。target の表示/非表示を collapsed クラスで切り替えるボタンを組み立てる。

// マップのマーカーとは字形の族を分け、開いている状態と閉じている状態でどちらを向くかを
// 画面内で一貫させる。
export const COLLAPSE_EXPANDED_GLYPH = '▾';
export const COLLAPSE_COLLAPSED_GLYPH = '▸';

export interface CollapseToggleLabels {
  readonly expandedGlyph: string;
  readonly collapsedGlyph: string;
  readonly expandedTitle: string;
  readonly collapsedTitle: string;
}

// マップビュー下部の PREDICT バー用トグルの見た目。
export const PREDICT_TOGGLE_LABELS: CollapseToggleLabels = {
  expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
  collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
  expandedTitle: '下部パネルを閉じる',
  collapsedTitle: '下部パネルを開く',
};

// button の見た目(グリフ・aria-expanded・title)を target の collapsed クラスに合わせる。
function syncCollapseToggle(button: HTMLElement, target: HTMLElement, labels: CollapseToggleLabels): void {
  const collapsed = target.classList.contains('collapsed');
  button.textContent = collapsed ? labels.collapsedGlyph : labels.expandedGlyph;
  button.setAttribute('aria-expanded', String(!collapsed));
  button.title = collapsed ? labels.collapsedTitle : labels.expandedTitle;
}

// target の表示/非表示を collapsed クラスで切り替えるボタンを1つ組み、root へ追加して返す。
export function buildCollapseToggle(
  root: HTMLElement, id: string, className: string, target: HTMLElement, labels: CollapseToggleLabels,
): HTMLElement {
  const button = document.createElement('button');
  button.id = id;
  if (className) button.className = className;
  root.appendChild(button);
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  // クリックのたびに collapsed を反転し、その結果へ見た目を合わせ直す。
  button.addEventListener('click', () => {
    target.classList.toggle('collapsed');
    syncCollapseToggle(button, target, labels);
  });
  syncCollapseToggle(button, target, labels);
  return button;
}

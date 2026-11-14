// ショートカットキーの表記(キーキャップ)。表記はこの1種に統一し、項目の名前にはキーを埋め込まず
// 名前の隣へ添える。label は KEY_MAPPING の label を渡す。

const KEY_CAP_CLASS = 'ui-key';

// label を表示するキーキャップ(kbd 要素)を作る。
export function createKeyCap(label: string): HTMLElement {
  const cap = document.createElement('kbd');
  cap.className = KEY_CAP_CLASS;
  cap.textContent = label;
  return cap;
}

// innerHTML へ差し込むための、label のキーキャップのマークアップ。
export function keyCapHtml(label: string): string {
  const text = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<kbd class="${KEY_CAP_CLASS}">${text}</kbd>`;
}

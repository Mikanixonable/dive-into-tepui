// 指定タグ・id・class の要素を作り、parent に追加して返す。
export function createHudElement(
  tag: string, id: string, parent: HTMLElement, className = '',
): HTMLElement {
  const element = document.createElement(tag);
  element.id = id;
  if (className) element.className = className;
  parent.appendChild(element);
  return element;
}

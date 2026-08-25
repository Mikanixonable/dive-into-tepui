const injectedIds = new Set<string>();

export function injectOnce(id: string, css: string): void {
  if (injectedIds.has(id)) return;
  injectedIds.add(id);
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

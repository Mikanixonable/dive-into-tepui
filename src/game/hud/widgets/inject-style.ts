// CSS 文字列を <style> 要素として document.head へ注入する仕組み。
// 同じ id への呼び出しは初回だけ反映される。

const injectedIds = new Set<string>();

// id ごとに初回の呼び出しだけ css を <style> 要素として注入する。
export function injectOnce(id: string, css: string): void {
  if (injectedIds.has(id)) return;
  injectedIds.add(id);
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

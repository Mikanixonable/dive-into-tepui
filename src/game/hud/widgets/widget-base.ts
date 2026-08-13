// hud/widgets/ 全体で共有する土台。個々のウィジェットはここを経由し、
// pointerdown の伝播抑止とタップ領域の拡張を自前で書かない。

// クリックがカメラドラッグ側へ伝播しないよう止める。全ウィジェットの対話要素がこれを呼ぶ。
export function stopDragPropagation(el: HTMLElement): void {
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
}

// 視覚サイズは変えずに --hit-target-min までヒット領域を広げるクラスを付ける。
// 実際の拡張(疑似要素)は widget-style.ts の CSS が担う。
export function expandHitTarget(el: HTMLElement): void {
  el.classList.add('w-hit');
}

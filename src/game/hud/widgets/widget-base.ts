// hud/widgets/ 全体で共有する土台。個々のウィジェットはここを経由して
// pointerdown の伝播抑止とタップ領域の拡張を行い、見出し付きの行もここが組む。

// 行の見出し(.w-group-title)。
export function buildGroupTitle(text: string): HTMLSpanElement {
  const heading = document.createElement('span');
  heading.className = 'w-group-title';
  heading.textContent = text;
  return heading;
}

// 見出し付きの行を組む。className は行そのもののクラスで、既定は横並びの行 .w-group。
// title が空文字なら見出しを持たない行になる。中身は呼び出し側が append する。
export function buildLabeledRow(title: string, className = 'w-group'): HTMLElement {
  const row = document.createElement('div');
  row.className = className;
  if (title !== '') row.appendChild(buildGroupTitle(title));
  return row;
}

// クリックがカメラドラッグ側へ伝播しないよう止める。全ウィジェットの対話要素がこれを呼ぶ。
export function stopDragPropagation(el: HTMLElement): void {
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
}

// pointer:coarse のときだけ --hit-target-min まで寸法を広げるクラスを付ける。
export function expandHitTarget(el: HTMLElement): void {
  el.classList.add('w-hit');
}

// role="button"/role="switch" 相当の要素の活性化を一箇所にまとめる。click は伝播を止めて
// handler を呼び、ポインタ操作由来(isTrusted)ならフォーカスを外す — 保持したままだと
// 押しっぱなしの物理キー(Space 連射など)で再発火してしまう。Enter/Space は role だけでは
// click を発火しないため明示的に合成し、伝播も止める。
export function bindActivation(el: HTMLElement, handler: () => void): void {
  // ポインタ由来(isTrusted)のクリックだけフォーカスを外す。
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.isTrusted) el.blur();
    handler();
  });
  // Enter/Space を click として合成する(role="button" だけでは発火しないため)。
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      el.click();
    }
  });
}

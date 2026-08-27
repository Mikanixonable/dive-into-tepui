// hud/widgets/ 全体で共有する土台。個々のウィジェットはここを経由して
// pointerdown の伝播抑止とタップ領域の拡張を行う。

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

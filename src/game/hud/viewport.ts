// visualViewport のサイズ変化を監視し、--vvh(実効ビューポート高さ)と --safe-*
// を更新する唯一の購読者。PropertyWindow/ContextMenu 等、画面サイズ変化で
// 再配置が要る側は window の resize を個別に張らず onViewportChange を購読する。
import { SAFE_AREA_BOTTOM, SAFE_AREA_LEFT, SAFE_AREA_RIGHT, SAFE_AREA_TOP } from '../../theme';

const listeners = new Set<() => void>();

// --vvh を visualViewport の実測高さへ更新する。無い環境では window.innerHeight で代える。
function updateVvh(): void {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--vvh', `${height}px`);
}

// --safe-* を env() の値と、visualViewport がレイアウトビューポートより狭まった分
// (ピンチズームや仮想キーボードで実際に見える範囲が変わったとき)の大きい方へ更新する。
function updateSafeArea(): void {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  if (!vv) {
    root.setProperty('--safe-t', SAFE_AREA_TOP);
    root.setProperty('--safe-r', SAFE_AREA_RIGHT);
    root.setProperty('--safe-b', SAFE_AREA_BOTTOM);
    root.setProperty('--safe-l', SAFE_AREA_LEFT);
    return;
  }
  // レイアウトビューポート(window.inner*)と visualViewport の差が、その辺での実際の欠け量。
  const rightGap = window.innerWidth - vv.width - vv.offsetLeft;
  const bottomGap = window.innerHeight - vv.height - vv.offsetTop;
  root.setProperty('--safe-t', `max(${SAFE_AREA_TOP}, ${vv.offsetTop}px)`);
  root.setProperty('--safe-r', `max(${SAFE_AREA_RIGHT}, ${rightGap}px)`);
  root.setProperty('--safe-b', `max(${SAFE_AREA_BOTTOM}, ${bottomGap}px)`);
  root.setProperty('--safe-l', `max(${SAFE_AREA_LEFT}, ${vv.offsetLeft}px)`);
}

// --vvh/--safe-* を更新し、購読者全員へ通知する。
function handleViewportChange(): void {
  updateVvh();
  updateSafeArea();
  for (const listener of listeners) listener();
}

let started = false;

// visualViewport(無ければ window)の resize/scroll と orientationchange を購読し、
// 初回の更新も行う。呼び出しは冪等 — 2回目以降は購読を積み増さない。
export function startViewportTracking(): void {
  if (started) return;
  started = true;
  const target: EventTarget = window.visualViewport ?? window;
  target.addEventListener('resize', handleViewportChange);
  target.addEventListener('scroll', handleViewportChange);
  window.addEventListener('orientationchange', handleViewportChange);
  handleViewportChange();
}

// ビューポート変化の通知を購読する。返り値を呼ぶと購読解除する。
export function onViewportChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

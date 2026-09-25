// ウィンドウのヘッダーを掴んで動かすための、ポインタキャプチャとクリック/ドラッグ境界の
// 判定(CLICK_MOVE_THRESHOLD)。ヘッダーを持つオーバーレイが共有する。
import { CLICK_MOVE_THRESHOLD } from '../input/input';
import type { Point2 } from './layout';

export interface WindowDragSession {
  // ドラッグ開始時点のウィンドウ位置(offsetLeft/offsetTop と同じ基準)。
  position(): Point2;
  // クランプ済みの配置へウィンドウを動かす。
  moveTo(x: number, y: number): void;
  // ドラッグを受け付けるか(compact のボトムシート化中などで false)。省略時は常に受け付ける。
  enabled?(): boolean;
  // しきい値を超えて最初に動いた時に1度だけ呼ぶ(持ち出し位置の確定など)。
  onDragStart?(): void;
}

// header 上で掴んで session.moveTo へ流すポインタ配線を張る。
// ヘッダー内のボタンを掴んだときはドラッグを始めない。
export function wireHeaderDrag(header: HTMLElement, session: WindowDragSession): void {
  let dragPointerId: number | null = null;
  let dragStartClient: Point2 | null = null;
  let dragStartWindowPos: Point2 = { x: 0, y: 0 };
  let dragging = false;

  header.addEventListener('pointerdown', (e) => {
    if (session.enabled !== undefined && !session.enabled()) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    dragPointerId = e.pointerId;
    dragStartClient = { x: e.clientX, y: e.clientY };
    dragStartWindowPos = session.position();
    dragging = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  });

  header.addEventListener('pointermove', (e) => {
    if (dragPointerId !== e.pointerId || dragStartClient === null) return;
    const dx = e.clientX - dragStartClient.x;
    const dy = e.clientY - dragStartClient.y;
    if (!dragging && Math.hypot(dx, dy) < CLICK_MOVE_THRESHOLD) return;
    if (!dragging) session.onDragStart?.();
    dragging = true;
    session.moveTo(dragStartWindowPos.x + dx, dragStartWindowPos.y + dy);
  });

  const end = (e: PointerEvent): void => {
    if (dragPointerId !== e.pointerId) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragPointerId = null;
    dragStartClient = null;
    dragging = false;
  };
  header.addEventListener('pointerup', end);
  header.addEventListener('pointercancel', end);
}

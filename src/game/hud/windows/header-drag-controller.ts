import { CLICK_MOVE_THRESHOLD } from '../../const';
import { Point2 } from '../layout';

// ウィンドウのヘッダーへポインタドラッグでの移動を配線する。しきい値を超えて動いた分だけ
// ドラッグ開始時のウィンドウ位置へ加算して onDrag を呼ぶ。
export class HeaderDragController {
  private readonly canStart: () => boolean;
  private readonly getWindowPos: () => Point2;
  private readonly onDrag: (x: number, y: number) => void;

  private dragPointerId: number | null = null;
  private dragStartClient: Point2 | null = null;
  private dragStartWindowPos: Point2 = { x: 0, y: 0 };
  private dragging = false;

  // header へポインタイベントを4つ登録してドラッグを有効にする。
  public constructor(header: HTMLElement, options: {
    canStart?: () => boolean;
    getWindowPos: () => Point2;
    onDrag: (x: number, y: number) => void;
  }) {
    this.canStart = options.canStart ?? (() => true);
    this.getWindowPos = options.getWindowPos;
    this.onDrag = options.onDrag;
    header.addEventListener('pointerdown', this.handlePointerDown);
    header.addEventListener('pointermove', this.handlePointerMove);
    header.addEventListener('pointerup', this.handlePointerUp);
    header.addEventListener('pointercancel', this.handlePointerUp);
  }

  // ヘッダー上のボタン以外を掴んだときに、ドラッグ開始点とポインタキャプチャを確保する。
  private handlePointerDown = (e: PointerEvent): void => {
    if (e.target instanceof Element && e.target.closest('button')) return;
    if (!this.canStart()) return;
    this.dragPointerId = e.pointerId;
    this.dragStartClient = { x: e.clientX, y: e.clientY };
    this.dragStartWindowPos = this.getWindowPos();
    this.dragging = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  // しきい値(CLICK_MOVE_THRESHOLD)を超えて動くまではドラッグ開始とみなさない。
  private handlePointerMove = (e: PointerEvent): void => {
    if (this.dragPointerId !== e.pointerId || this.dragStartClient === null) return;
    const dx = e.clientX - this.dragStartClient.x;
    const dy = e.clientY - this.dragStartClient.y;
    if (!this.dragging && Math.hypot(dx, dy) < CLICK_MOVE_THRESHOLD) return;
    this.dragging = true;
    this.onDrag(this.dragStartWindowPos.x + dx, this.dragStartWindowPos.y + dy);
  };

  // ポインタキャプチャを解放してドラッグ状態を終える。
  private handlePointerUp = (e: PointerEvent): void => {
    if (this.dragPointerId !== e.pointerId) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    this.dragPointerId = null;
    this.dragStartClient = null;
    this.dragging = false;
  };
}

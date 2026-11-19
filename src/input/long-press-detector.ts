// タッチの長押しを検出する追跡器。指を置いてからフィードバック時間が経つと判定中の
// 位置を point へ立て、長押し時間まで判定が続いたら右クリックとして通知する。
// 1本指のジェスチャにだけ存在するので、追跡状態は単一で持つ。
import type { PointerPoint } from './pointer-point';

const TOUCH_LONG_PRESS_MS = 500; // タッチの長押しを右クリックとみなすまでの静止時間 [ms]
const TOUCH_LONG_PRESS_FEEDBACK_MS = 300; // 長押し成立前に視覚フィードバックを出すまでの時間 [ms]

export class LongPressDetector {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerId: number | null = null;
  private fired = false;
  private _point: PointerPoint | null = null;

  // fire: 長押しが成立したとき、右クリック相当として処理する位置とポインタを通知する。
  public constructor(private readonly fire: (point: PointerPoint, pointerId: number) => void) {}

  // 長押しの判定中であることを示す画面上の位置。押し始めからフィードバック時間が
  // 経つまでと、発火した後は null。
  public get point(): PointerPoint | null { return this._point; }

  // pointerId が長押しで既に発火済み(右クリックへ結実済み)か。
  public hasFired(pointerId: number): boolean {
    return this.pointerId === pointerId && this.fired;
  }

  // pointerId の長押し判定を開始する。判定中の位置が先に立ち、
  // 長押し時間が経った時点で発火を通知する。
  public start(pointerId: number, point: PointerPoint): void {
    this.cancel();
    this.pointerId = pointerId;
    this.fired = false;
    this.feedbackTimer = setTimeout(() => { this._point = point; }, TOUCH_LONG_PRESS_FEEDBACK_MS);
    this.timer = setTimeout(() => {
      this.fired = true;
      this._point = null;
      this.fire(point, pointerId);
    }, TOUCH_LONG_PRESS_MS);
  }

  // 進行中の長押し判定を打ち切る。pointerId を渡したときは、そのポインタの
  // 判定中に限って打ち切る。
  public cancel(pointerId?: number): void {
    if (pointerId !== undefined && pointerId !== this.pointerId) return;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.feedbackTimer !== null) clearTimeout(this.feedbackTimer);
    this.timer = null;
    this.feedbackTimer = null;
    this._point = null;
    this.pointerId = null;
  }
}

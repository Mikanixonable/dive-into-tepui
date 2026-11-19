// タッチ由来のタップ(クリック)を記録し、時間差・距離が閾値内の2連続を
// ダブルタップとして合成する。マウスのダブルクリックの判定はブラウザの
// dblclick イベントに任せるので、ここではタッチ由来だけを扱う。
import type { PointerPointRecord } from './pointer-point';

const TOUCH_DOUBLE_TAP_MS = 400; // タッチの連続タップをダブルタップとみなす時間差の上限 [ms]
const TOUCH_DOUBLE_TAP_PX = 24; // 同上、タップ間の許容移動距離 [px]

export class DoubleTapSynthesizer {
  // 直近に成立したタップ(ダブルタップ合成用)。タッチ由来でなければ null のまま。
  private lastTap: { x: number; y: number; time: number; pointerId: number } | null = null;
  // 直近に成立したクリックがタッチ由来だったか。
  private lastUpWasTouch = false;

  // 直近に成立したクリックがタッチ由来だったか。
  public get lastPointerUpWasTouch(): boolean { return this.lastUpWasTouch; }

  // 成立したクリックを記録する。タッチ由来で、直近のタップとの時間差・距離が
  // 閾値内ならダブルタップを返す。そうでなければ null。
  public registerTap(e: PointerEvent): PointerPointRecord | null {
    this.lastUpWasTouch = e.pointerType === 'touch';
    if (!this.lastUpWasTouch) {
      this.lastTap = null;
      return null;
    }
    const x = e.clientX;
    const y = e.clientY;
    const now = performance.now();
    // 2連続で成立すればダブルタップとして消費し、3連続目が単独の新しいタップ列の
    // 起点にならないよう lastTap を毎回リセットする。
    if (
      this.lastTap &&
      now - this.lastTap.time <= TOUCH_DOUBLE_TAP_MS &&
      Math.hypot(x - this.lastTap.x, y - this.lastTap.y) <= TOUCH_DOUBLE_TAP_PX
    ) {
      this.lastTap = null;
      return { x, y, pointerId: e.pointerId };
    }
    this.lastTap = { x, y, time: now, pointerId: e.pointerId };
    return null;
  }

  // pointerId が起こした記録中のタップを捨てる。
  public forgetTap(pointerId: number): void {
    if (this.lastTap?.pointerId === pointerId) this.lastTap = null;
  }
}

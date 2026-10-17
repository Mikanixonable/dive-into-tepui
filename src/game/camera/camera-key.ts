// カメラの同一性の鍵。同じカメラが速く動いたのか別のカメラへ替わったのかはカメラの差からは区別できないので、ビュー・
// 照準・注視の対象の組から作る。
import type { ViewMode } from '../view/view-mode';

// ビュー view・照準を覗いているか gunsight・注視の対象の id(固定点の注視では null)から鍵の文字列を作る。どれか 1 つが
// 替われば違う鍵になる。
export function cameraKeyOf(view: ViewMode, gunsight: boolean, focusTargetId: string | null): string {
  return JSON.stringify([view, gunsight, focusTargetId]);
}

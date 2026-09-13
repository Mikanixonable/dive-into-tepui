// 未来の軌道・マーカーをどの座標系で描くかの選択と、カメラの基準への追随。
import type { ReferenceFrame } from '../physics/frame';

export interface DisplayFrameSelection {
  get frame(): ReferenceFrame;
  set frame(value: ReferenceFrame);
  // カメラの基準が移ったとき、描画基準も同じ天体へ合わせるか。
  readonly followCamera: boolean;
  setFollowCamera(on: boolean): void;
  // カメラの基準が id へ移ったことを伝える。id が無い(固定点)ときは undefined。
  followCameraFocus(id: string | undefined): void;
}

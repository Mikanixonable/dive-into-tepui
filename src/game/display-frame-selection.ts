// 未来の軌道・マーカーをどの座標系で描くかの選択。
import type { ReferenceFrame } from '../physics/frame';

export interface DisplayFrameSelection {
  get frame(): ReferenceFrame;
  set frame(value: ReferenceFrame);
}

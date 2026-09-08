// 未来の軌道・マーカーをどの座標系で描くかの選択。選択を持つ側と、それを選ばせる HUD の
// パネルの間に立つ口で、読み書きの両方向がプレイヤーの操作で起きる。
import type { ReferenceFrame } from '../physics/frame';

export interface DisplayFrameSelection {
  get frame(): ReferenceFrame;
  set frame(value: ReferenceFrame);
}

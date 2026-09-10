// 指定した物体のプロパティウィンドウを開く口。マップで掴まれた物体が、窓の組み立て一式を
// 引かずに窓を開けるようにする。
import type { InspectedObject } from './inspected-object';

export interface PropertyWindowOpener {
  // client 座標を開く位置の基準にして、target のプロパティウィンドウを開く。
  openProperties(target: InspectedObject, clientX: number, clientY: number): void;
}

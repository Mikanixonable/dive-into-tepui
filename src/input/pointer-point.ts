// ポインタイベントの位置と、そのイベントを起こしたポインタの対応付け。
// 入力装置のどの経路(pointerdown/up・dblclick・ジェスチャ合成)でも使える語彙。

// ポインタイベント1件の位置(クリック・押下など)。
export interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

// PointerPoint に、それを起こしたポインタを併記したもの。
// 特定のポインタと対応付けられない経路で起きたイベントは pointerId を null とする。
export interface PointerPointRecord extends PointerPoint {
  readonly pointerId: number | null;
}

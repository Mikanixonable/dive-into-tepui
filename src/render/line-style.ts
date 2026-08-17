// 折れ線の見た目を決める値。描画機構(render/curve.ts)とは別ファイルに置いてあり、
// スタイル値を持つだけの側は THREE ごと引き込まずにこの型を読める。

// 破線パターン。dashSize/gapSize は線が描かれる座標系での実距離 [m]。
export type LineDash = { readonly dashSize: number; readonly gapSize: number };

// 線の見た目を決める値。
export type LineStyle = {
  readonly color: string | number;
  readonly opacity: number;
  readonly renderOrder: number;
  readonly dash?: LineDash;
};

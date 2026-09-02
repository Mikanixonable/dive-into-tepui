// 折れ線の見た目を決める値。描画機構(render/curve.ts)とは別ファイルに置いてあり、
// スタイル値を持つだけの側は THREE ごと引き込まずにこの型を読める。

// 3D UI パス(render/pipeline/overlay-pass.ts)の中での線どうしの重なり順。描画順は他の線との
// 相対関係でしか意味を持たない(同じ値の透明な線どうしは重なりが不定になる)ので、線ごとに
// 決めさせず、ここに1つの表として置く。並びは「同一軌道が重なったときに手前に来てほしい
// 度合いが低い順」— ランデブー相手の軌道は自機のそれとほぼ一致しがちで、計画軌道は編集中の
// ものが優先され、積分予測線はそれが代わりを務める解析楕円より必ず手前に来る必要がある。
export const LINE_RENDER_ORDER = {
  reference: 0,  // 天体の参照軌道線
  shipOrbit: 1,  // 自機・敵・拠点の解析楕円
  target: 2,     // ターゲットの軌道線
  plan: 3,       // 計画軌道(破線)
  predicted: 4,  // 積分予測線。解析楕円の代替なので、両方出る境界フレームでは必ずこちらを手前に置く
} as const;

// 破線パターン。dashSize/gapSize は線が描かれる座標系での実距離 [m]。
type LineDash = { readonly dashSize: number; readonly gapSize: number };

// 線の見た目を決める値。
export type LineStyle = {
  readonly color: string | number;
  readonly opacity: number;
  readonly renderOrder: number;
  readonly dash?: LineDash;
};

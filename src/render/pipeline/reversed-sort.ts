// 反転深度バッファを使うとき three `0.185.1` の `RenderList.sort` は、比較関数を適用した
// あとで opaque / transparent / transparentDoublePass を無条件に `.reverse()` する
// (Issue #33944、修正 PR #33945、マイルストーン r186)。ここで渡すのは three の既定比較関数の
// 符号を反転した比較で、既定は最後に id でタイを割る全順序なので「反転比較でソート →
// reverse」は「既定比較でソート」と厳密に一致する。
//
// **これがこのアプリ唯一の custom sort である。** 他所から `setOpaqueSort` /
// `setTransparentSort` を呼ぶと反転が二重になるか消える。修正の入った three へ上げたら
// このモジュールごと削除する — その版へ上がったことは `tools/check-three-pin.mjs` が検知する。

// 比較関数が受け取る描画項目のうち、既定の比較が読む欄だけ。RenderItem 型は
// `three/webgpu` から公開されていない。
type SortItem = {
  readonly groupOrder: number | null;
  readonly renderOrder: number | null;
  readonly z: number | null;
  readonly id: number | null;
};

// 既定比較を符号反転した比較関数。zOrder は既定が z を並べる向き(不透明は手前から +1、
// 半透明は奥から -1)。
function reversedSort(zOrder: number): (a: SortItem, b: SortItem) => number {
  return (a, b) => {
    if (a.groupOrder !== b.groupOrder) return b.groupOrder! - a.groupOrder!;
    if (a.renderOrder !== b.renderOrder) return b.renderOrder! - a.renderOrder!;
    if (a.z !== b.z) return zOrder * (b.z! - a.z!);
    return b.id! - a.id!;
  };
}

export const reversedOpaqueSort = reversedSort(1);
export const reversedTransparentSort = reversedSort(-1);

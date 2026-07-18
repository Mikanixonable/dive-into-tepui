// webpack の asset/resource ローダーが PNG インポートを最終出力 URL の文字列に
// 変換する。tsc にはこの変換を伝える型情報がないため手動で宣言する
// (src/types/three-shims.d.ts と同様の位置づけ)。
declare module '*.png' {
  const url: string;
  export default url;
}

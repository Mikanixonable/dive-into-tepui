// webpack の asset/resource ローダーが GLB/GLTF インポートを最終出力 URL の文字列に
// 変換する。tsc にはこの変換を伝える型情報がないため手動で宣言する。
declare module '*.glb' {
  const url: string;
  export default url;
}

declare module '*.gltf' {
  const url: string;
  export default url;
}

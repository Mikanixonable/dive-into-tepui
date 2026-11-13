// 船体モジュールの modelId から、建造カタログのタイルへ載せるサムネイル画像の URL を
// 引く表。画像は src/assets/module-thumbnails/<modelId>.png に対応させる。表に無い
// modelId は undefined を返し、呼び出し側は画像なしのタイル(名前だけ)を描く。
const context = require.context('../../../assets/module-thumbnails', false, /\.png$/);

const THUMBNAILS: Readonly<Record<string, string>> = Object.fromEntries(
  context.keys().map(key => [key.replace(/^\.\//, '').replace(/\.png$/, ''), context(key)]),
);

// modelId のサムネイル URL。表に無い modelId では undefined。
export function moduleThumbnailUrl(modelId: string): string | undefined {
  return THUMBNAILS[modelId];
}

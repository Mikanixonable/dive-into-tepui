// 船体モジュールの modelId から、建造カタログのタイルへ載せるサムネイル画像の URL を
// 引く表。画像は src/assets/module-thumbnails/<modelId>.png に対応させる。
const context = require.context('../../../assets/module-thumbnails', false, /\.png$/);

const THUMBNAILS: Readonly<Record<string, string>> = Object.fromEntries(
  context.keys().map(key => [key.replace(/^\.\//, '').replace(/\.png$/, ''), context(key)]),
);

// modelId のサムネイル URL。表に無い modelId では null。
export function moduleThumbnailUrl(modelId: string): string | null {
  return THUMBNAILS[modelId] ?? null;
}

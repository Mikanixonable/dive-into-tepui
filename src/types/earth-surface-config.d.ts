// webpack.config.js の DefinePlugin が本番地表配信先をビルド時に埋め込む。
// 開発ビルドでは空文字になり、runtime 境界がフォールバックを選べる。
declare const __EARTH_SURFACE_BASE_URL__: string;
declare const __EARTH_SURFACE_MANIFEST_URL__: string;

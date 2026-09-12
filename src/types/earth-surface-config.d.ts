// webpack.config.js の DefinePlugin が地表配信先をビルド時に埋め込む。
// 開発ビルドでもローカルbundleまたは公開済みR2のmanifestを埋め込む。
declare const __EARTH_SURFACE_BASE_URL__: string;
declare const __EARTH_SURFACE_MANIFEST_URL__: string;

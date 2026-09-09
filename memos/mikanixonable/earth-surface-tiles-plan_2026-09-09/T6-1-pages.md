# T6-1: Pages同居モード

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

このファイルは、T6のうちこの配信境界だけを実装するときに読む作業単位である。
共通の固定前提は親計画の§2、依存関係は§3を参照する。


**変更対象**: `.github/workflows/build.yml`、`webpack.config.js`、`tools/earth-surface/stage-pages.mjs`（新規）、
`test-pages-layout.mjs`（新規）、`tools/verify-release.mjs`、`package.json`。

1. `docs/`のファイル数・合計サイズ・最大ファイルサイズ・release push時間をbaselineへ保存する。
2. fixture bundleを`docs/earth-surface/<datasetId>/`へコピーし、manifest、tile-index、JPEG、raw gzip、12枚の気候mapを検査する。
3. Pages URLが`https://owner.github.io/repository/`のようなサブパスでも、base URLから相対asset URLを作る。URLをハードコードしない。
4. `EARTH_SURFACE_PAGES_MAX_BYTES`を設け、サイズ予算を超えたbundleはrelease前に失敗させる。

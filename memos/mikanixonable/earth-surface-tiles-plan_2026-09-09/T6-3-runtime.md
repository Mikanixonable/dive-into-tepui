# T6-3: アプリとの接続

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

このファイルは、T6のうちこの配信境界だけを実装するときに読む作業単位である。
共通の固定前提は親計画の§2、依存関係は§3を参照する。


`EARTH_SURFACE_DEPLOY_MODE`、`EARTH_SURFACE_BASE_URL`、`EARTH_SURFACE_DATASET_ID`をwebpackとruntimeへ渡す。
Pagesはゲームと同一origin、外部静的はCORS付きoriginとして検査する。release branchへpushする前に、docsのentry script、
release URL、manifest到達性、datasetId整合を検査する。

**検証**: `npm run earth-surface:package`、`npm run earth-surface:check`、Pages layout test、remote-check、
`npm run build`、`npm run verify:release`、静的HTTPテスト。異なるdatasetId、manifest改変、hash不一致、URL未設定を拒否する。

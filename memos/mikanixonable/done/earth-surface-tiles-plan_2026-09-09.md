# 地球地表タイル計画 — 実装済みの記録

作成日: 2026-09-10

未完了タスクを実行するときは、親計画の
[earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)だけを読む。
このファイルは、すでに実装してworkspace3へ統合した境界と、その判断の根拠を残すための記録である。
ここに書かれている内容を再実装しない。

## 実装済みの範囲

| 区分 | 実装した内容 | 主なファイル | commit |
| --- | --- | --- | --- |
| SPEC | 地表色・標高由来法線・全球fallback・地理位置固定・LOD連続性・水域と陸/氷の陰影差を仕様へ追加 | `DEVELOP/SPEC/RENDERING.md` | `92dcc8ac` |
| 座標とLODの解析契約 | 楕円体UV、法線、地平線/視錐台判定、`errorPx`、2:1 frontier、ページ表、親子fadeの解析実装 | `src/render/earth-surface-coordinate.ts`, `src/render/earth-surface-tiles.ts` | `ae362757` |
| GPU寿命のfake契約 | 128層予約、色/地形の同時upload、フレーム境界のページ表公開、世代付き解放、dispose | `src/render/earth-surface-gpu.ts` | `ae362757` と後続修正 |
| データ取得の入口 | ソースmanifest、再開可能な取得、サイズ/形式/hash検査、fixture bake、Pythonテスト | `assets-src/earth-surface/sources.json`, `tools/earth-surface/fetch-source.py`, `tools/earth-surface/bake.py` | `65dbf4ff`, `df2d52b7` |
| 地形デコード | ESTN 32 bytesヘッダー、z/x/y、Float16本文、gzip、SHA-256、AbortSignal、生成番号、本文上限 | `src/render/earth-surface-decode.ts` | `f7274288`, `12255012` |
| 配信契約のfixture | `earth-surface.json`、`tile-index.json`、12枚の気候map、base、タイルの存在/hash検査とstaging package | `tools/earth-surface/contract.mjs`, `check.mjs`, `package.mjs` | `f7274288`, `246eca7b`, `2c7c3b9a`, `17e9119b` |
| ローカル静的配信 | パストラバーサル拒否、MIME、CORS、fixture配信入口 | `tools/earth-surface/serve.mjs` | `f7274288` |
| 要求キュー | HTTP同時数、decode同時数、待機数、retry/404/timeout、generation、dataset境界 | `src/render/earth-surface-request.ts` | `425ba7ba`, `14a143bc`, `413529ea` |
| resident coordinator | frontierからの要求、GPU層予約、親子を同一層へ公開する順序、LRU、遅着破棄 | `src/render/earth-surface-resident.ts` | `2c844ed5` と後続修正 |
| 表面ライフサイクル | `CelestialSurfaceLike`、EarthSurface facade、frame同期、非表示/破棄時のlease abort | `src/render/celestial-surface.ts`, `src/render/earth-surface.ts` | `926e1c69`, `7dec9df9`, `98e884a7`, `ba883db8`, `f5de43dd` |
| materialの解析契約 | 地球法線/UV、roughness、水域/陸/氷クラス、テクスチャのfilter・色空間・mipmap設定 | `src/render/earth-surface-material.ts`, `src/render/earth-surface-material-node.ts` | `0e5ab825`, `41859d98` |
| 月別気候の境界 | 12枚のDeferredTexture、当月/翌月だけの要求、RGBA復号、月境界補間、generation | `src/render/cloud/monthly-climate-map.ts`, `climate-map.ts`, `generated-cloud-field.ts` | `d472e694` |
| 地表captureの基礎 | Earth 5ケースの撮影、PNG hash/bytes/viewport/case metrics | `tools/render-lab-earth-surface.mjs`, `src/render/earth-surface-metrics.ts` | `5d735ecb`, `9f5f534e` |
| release検査 | `.bin/.bin.gz` asset、`EARTH_SURFACE_BASE_URL`、HTTPS/localhost/datasetId検査、release source検査 | `webpack.config.js`, `tools/earth-surface/release-config.mjs`, `tools/verify-release.mjs` | `51454406`, `08ddf000` |

## 実装済みのテスト境界

次のテストは、上表の契約を確認するために追加・更新済みである。

- `npm run typecheck`
- `npm run test:render`
- `npm run test:game`
- `npm run earth-surface:test`
- `python3 -m unittest discover -s tools/earth-surface -p 'test_*.py'`
- `npm run build`
- `npm run verify:release`
- release-configの境界テスト
- fixture bundleのpackage/checkテスト

これらはfixtureと契約のテストであり、実データ全量、実WebGPUのDataArrayTexture、実ゲーム表示、実ブラウザp95を完了させたことを意味しない。
それらは親計画の未完了タスクである。

## 実装へ適用済みの固定判断

- BMNG July 2004 Base Mapを色の基準にする。
- ETOPO 2022 v1のice-surfaceとgeoidを使い、`bed_elev`やGEBCOを気候入力へ使わない。
- GSHHG full resolutionを水域/陸地被覆率へ使い、海抜の正負から水域を推定しない。
- ERA5 1991–2020月平均の2m気温・総雲量を12枚の気候mapへ焼く。
- 地形LODとテクスチャLODを分離する。地域patch meshは作らない。
- 水=roughness 0.05、陸=0.80、明示できる氷=0.35の固定クラスを初期値にする。色の青さから粗さを推定しない。
- 色と地形は同じGPU層へ書き込み、ページ表をフレーム境界で公開する。
- WebGPU機能不足時は詳細タイルを使わず、全球baseへfallbackする。
- 地表は楕円体UV・天体固定法線を使う。雲・雲影・大気も同じ地理投影へ揃える。
- 地表データはraw gzip本文の`.bin.gz`として扱い、クライアント側で一度だけ展開する。
- GitHub Pagesの`docs/`へ置くのはfixture/縮小版までとし、全球bundleは外部静的配信を標準候補にする。

未完了の項目は、この記録へ複製せず、親計画のT0〜T7タスクファイルで管理する。

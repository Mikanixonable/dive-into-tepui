# 地表タイル基盤 削減・簡素化・DRY化提案

調査時点: `175a678c7` 以降の作業ツリー。対象は `src/render/earth-surface*.ts`（33ファイル・約4,107行）と
`tools/earth-surface/`（Python + Node 約8,500行）の両面。前回の監査メモでは「維持するが重いもの」として
挙げた基盤の、削減可能な部分を行数の大きさで整理する。

結論を先に言うと、**削れるのは主に3つの層**で、タイルストリーミングの中核（LOD選択・ページ表・
GPU層の貸し借り）は比較的健全である。

1. **本番レイヤーに住むテスト/ツール専用コード**（src 側で約530行）
2. **schema 1 / 八面体地形の旧wire形式**（src 側で約200行、tools 側にも波及）
3. **tools のデッドコードと休眠経路**（tools 側で純削減約600-800行 + 方針決定次第で約1,800行）

## 1. src/render 側

### 大（100行超）

#### 1-A. `earth-surface-metrics.ts` をツール側へ移動（-247行）

`checkRgbaRange` / `measureAdjacent8BitDifference` / `normalizeEarthSurfaceMetrics` /
`createUnavailableEarthSurfaceCapture` / `EARTH_SURFACE_CAPTURE_CASES` の消費者は
`tools/render-lab/` と `tests/render/` だけで、本番ランタイムは一切参照しない
（`src/render/earth-surface-tile-queue.ts` 内の `metrics` とは無関係の別物）。
render-lab 支援のための型と検査が `src/render` に同居しているだけなので、
`tools/render-lab/` 配下かテスト支援ディレクトリへ移す。挙動リスクなし。

#### 1-B. `earth-surface-material.ts` の参照実装を tests へ移動（約-240行）

ページ表参照 `sampleEarthSurfacePage` / `earthSurfacePageCell`、UV変換
`earthSurfaceTileLocalUv` / `earthSurfaceEllipsoidUv`、材質合成 `mixEarthSurfaceMaterial`、
粗さ `roughnessFromGshhgCoverage`、法線 `earthSurfaceNormalForView` 等の純粋関数は
すべて `tests/render/earth-surface-material.test.ts` からしか呼ばれない。
本番シェーダは `earth-surface-material-node.ts` の TSL グラフで、残っている依存は
`EARTH_WATER_ROUGHNESS` 等の定数 3個だけ。

- 参照実装（約240行）を `tests/render/` 側へ移し、本番側は粗さ定数のみ残す
- あるいは「TSL と TS の二重実装が一致することを保証するテスト資産」として位置づけを
  明示したうえで残す — どちらにしても、現状の「本番ファイルに見えるが本番では
  動かない」という曖昧さは解消すべき

#### 1-C. schema 1 manifest / 八面体地形経路の撤去（約-200行、条件付き）

`tools/earth-surface/release-config.mjs` がリリース物に schema 3 を要求しており、
現行の配信物は v3 のみ。src 側の v1 受理は古いキャッシュ配信向けの互換経路。

| 対象 | 行数 |
| --- | --- |
| `earth-surface-terrain-codec.ts` の `decodeEarthTerrainPayloadOctahedral`（62-105）と `decodeEarthBaseTerrainPayloadOctahedral`（150-188） | 約83行 |
| `decodeEarthTerrainBytesForFormat` / `loadEarthBaseTerrainForFormat` の format 分岐と、queue・worker-client・worker・binding を貫く `terrainFormat` 引数回り | 約40行 |
| `earth-surface-source.ts` の `EarthSurfaceAssetManifestV1`・`EarthSurfaceLegacyTerrainEncoding` 型・v1 分岐（80-138, 224-248） | 約60行 |
| `earth-surface-format.ts` の `EARTH_TERRAIN_OCTAHEDRAL_LAYOUT` と `EarthSurfaceTerrainFormat` 共用体 | 数行 |

注意点が2つ:

- `EARTH_SURFACE_LEGACY_COLOR_CALIBRATION` は `earth-surface-defaults.ts` の
  開発用フォールバック `EARTH_TEXTURE` が使うので**残す**。名前の legacy は
  「fixture 用校正値」と読み替える
- `tools/earth-surface/stage-pages.mjs` は fixture bundle に schemaVersion 1 を
  書いているので、src 側で v1 を落とすなら fixture 生成も v3 へ揃える必要がある。
  配信 manifest の実態（R2 に残る v1 が無いか）を確認してから実施する条件付き案

### 中（30-100行）

#### 1-D. テスト専用の export を整理（約-50行）

呼び出し元を全数調べた結果、本番では誰も呼ばないが `src/render` に残っているもの:

| 対象 | 所在 | 行数 |
| --- | --- | --- |
| `earthTileRoots` | earth-surface-tile-key.ts | 約6行 |
| `earthTileSampleUv` | earth-surface-page-table.ts | 約12行 |
| `EarthSurfaceTileSource.urlFor` / `idFor` | earth-surface-tile-source.ts | 約10行 |
| `earthPageAt` | earth-surface-page-table.ts | 約10行 |
| `decodeEarthSurfaceTile` 簡易入口 | earth-surface-tile-decode.ts | 約3行 |
| `decodeEarthTerrainBytes` / `loadEarthBaseTerrain` | earth-surface-terrain-codec.ts | 約12行 |

`decodeEarthTerrainBytes`・`loadEarthBaseTerrain` はテストからも呼ばれていない完全な
dead code。テストが使うものはテスト側ヘルパへ寄せるか、テストが構造を直接組み立てる形へ。
`earthTileRoots` は `earth-surface-tiles.ts` の `selectionRoots()` と混同しやすい
（z5 の根 vs z4 の表示根 — 段が違う）ので、消す側に倒す価値が大きい。

#### 1-E. generation と AbortSignal の二重有効性管理を AbortSignal 一本へ（60-100行、設計判断要）

現状は context が generation を払い出し、かつ `invalidateRequests` で保有中の全
AbortSignal を abort している。つまり古い要求は必ず signal でも殺されるのに、
queue item・resident の pending・coordinator・metrics 各所で generation 番号の比較が
二重に走っている。AbortSignal だけを正にすれば比較ロジックと範囲検査が消える。

ただし queue の `requestLoaded` が「同タイルの旧世代要求を置き換える」判定に世代番号を
使っているため、abort→remove の到達順序を先に設計し直す必要がある。
効果は読みやすさが主で、純減は 60-100行程度に留まる見込み — 中コスト中効果。

#### 1-F. `stagePageTable` の全セル地理整合性検証を開発時検査へ（約-35行）

`earth-surface-gpu.ts` の `stagePageTable` が、ページ表を publish するたびに全セルの
タイルキー整合性を走査している。producer は同じプロセス内の `earth-surface-tiles.ts`
なので、これは内部出力に対する防御的再検証。`import.meta.env.DEV` 相当の条件付き検査へ
下げるか、代表セルへの縮小でよい。これは「消す」ではなく「検査コストの引き下げ」。

#### 1-G. `EarthSurfaceGpuAdapter` の `mode` 二相性を解消（20-30行）

factory で `mode === 'base'` の adapter は即座に捨てられている。能力不足は adapter
生成前に capabilities で判定し、adapter 自体は tiles 前提の構造にすると
`requireTextures` 系の分岐が消える。小さいが、GPU境界の読みやすさに効く。

### 小（修正として重要だが行数は少ない）

- **`EarthSurfaceTileRequestMetrics.eventLog` が無制限に伸びる** — `pushMetricEvent` が
  各要求イベントを蓄積するだけで上限がない。長時間プレイで線形増大する潜在リーク。
  消費者はテストの `queue.metrics.events` だけなので、リングバッファ化（数百件上限）で十分
- **`selectionRoots()` が呼ぶたびに z4 の 512 キーを生成** — 定数なのでモジュール
  スコープで1回構築に
- **小ファイル併合** — 33ファイルのうち `decode-errors`(8) / `format`(14) /
  `request-errors`(16) / `color`(20) / `layout`(22) / `page-table`(25) / `terrain-worker`(36)
  / `defaults`(39) / `tile-source`(48) / `texture`(49) / `decode-response`(55) 等、
  90行未満の型・定数・エラー型の殻が13個。エラー型3ファイル（計79行）を
  `earth-surface-errors.ts` に、wire定数（format+layout）を1つにまとめるだけで
  import 行と認知負荷が減る。ただし行数自体はほぼ変わらない — **整理効果のみ**

### src 側小計

| 案 | 純削減 |
| --- | --- |
| 1-A metrics 移動 | 247行 |
| 1-B material 参照実装移動 | 約240行 |
| 1-C octahedral/v1 | 約200行 |
| 1-D テスト専用 export | 約50行 |
| 1-E generation 一本化 | 60-100行 |
| 1-F stagePageTable 検査 | 約35行（実行時コスト削減が主） |
| 1-G adapter mode | 20-30行 |
| **合計** | **約850-970行（src の 21-24%）** |

## 2. tools/earth-surface 側

サブエージェントによる全数調査の結果。こちらは「使われていない経路」が本体。

### 2-A. 休眠経路の方針決定が最大の案件（最大約1,800行 + Pythonテスト約950行）

npm scripts にも CI にも繋がっていないスクリプト群:

- `bake_parallel.py`（135行、writer が `bake.py::write_global_bundle` の約70%複写）
- `fetch-era5-gdex.py`（約230行、現行の ERA5 取得経路だが npm script がない）
- `preflight.py`、`validate-source.py`、`export-manifest.py`
- `request-era5.py`（旧 CDS 経路。manifest は `public_mirror` へ切替済みで npm script は旧経路に残る逆転状態）
- それらを唯一実行する Python テスト群 約950行は **CI 未実行**（`.mjs` テスト3本のみが CI ゲート）

さらに `fetch-source.py` は manifest 上 `acquisition: "public_mirror"` の ERA5 を
`source["urlTemplate"]` の KeyError で取れず、しかも main の except が KeyError を
捕捉しない（`fetch-source.py:129,420`）。**取得パイプラインは壊れたまま放置されている**
可能性が高い。

対応は2択:
- (a) 使う経路だけ残して他を消す — 旧 CDS 経路 `request-era5.py` と
  `explicit_local_export` 分岐を廃止して GDEX 経路へ一本化、npm scripts を現行経路へ
  張り直す（約90行 + 経路の確実性）
- (b) 焼き込み自体を外部プロセス化して tools ごと削る — ただし今後の再焼き込み
  （例: 解像度変更）が不可能になるので非推奨

### 2-B. bake.py のデッドコード（約-200行、安全性高い）

呼び出し元ゼロまたは到達不能:

- `read_geotiff_window`（87-109）、`read_gshhg_polygons`（112-143）、`read_era5_month`（146-166）
- `regrid_mean` / `regrid_color`（302-335）— テストのみ。本番再格子化は `real_source.py` が担当
- `era5_month_mean` と `bake_region` の era5 分岐（339-354, 472-478）— manifest の product 名と
  不一致で**必ず例外になる到達不能経路**
- `decode_terrain_tile`（531-539）— テスト補助のみ
- `--input`/`--tile` fixture→PPM 経路（799-801, 837-867）約55行
- `--climate-dir` オプション — 定義のみで読まれていない
- `TERRAIN_HEADER`/`BASE_HEADER` 同一 struct の二重定義、`encode_base_terrain` の
  意味のない `root_columns/root_rows` 引数

### 2-C. bake_parallel.py を write_global_bundle へ統合（-135行）

`_write_parallel` が global writer を複写しているうえ、デフォルトパスが
`raw-v3`/`bundle`（tools 内 cwd 前提）で `bake.py` の `raw`/`intermediate`（repo root 前提）
と世代も cwd も食い違う。`write_global_bundle` にタイル描画の iterable/並列化フックを
差し込めばファイルごと不要になる。パス名 `raw`/`raw-v3`/`bundle`/`bundle-v3`/`distribution`
の混在も同時に一本化すべき。

### 2-D. Python ヘルパの共通化（純減80-120行 + 保守性）

同じ実装が複写されている主要なもの:

- `contract_hash`（canonical JSON sha256）× 3箇所 + JS 側にも
- `file_hash`（1MB チャンク）× 3、`write_json` 原子的書き込み × 3
- format→拡張子マップ × 4、`regionGridDegrees` 領域列挙 × 4、`normalized_unit` × 2
- `load_manifest` が厳格版・弱化版の**2つの validator** として存在しドリフト可能
- ERA5 定数（変数エイリアス・721×1440 格子・1991-2020 期間・雲量単位）× 3-5箇所

ハイフン付きファイル名（`fetch-source.py` 等）のせいで importlib による動的ロードが
4箇所に強制されている。**アンダースコア名へ改名して `common.py` 相当へ集約すれば、
動的ロードと重複の大半が同時に解消する。**

### 2-E. JS 側の fixture 手組み3重化（80-100行）

- `jpegFixture`（最小 JPEG 組立）が `stage-pages.mjs` / `test_contract.mjs` /
  `test_release_config.mjs` に3コピー
- ESTN/ESTB ペイロード手組みと fixture manifest ビルダも3コピー
- cache-control 規則が `stage-pages.mjs` と `serve.mjs` に重複
- パストラバーサル防止が `contract.mjs` / `serve.mjs` / `release-config.mjs` に3バリアント
- `contract.mjs` の未使用 export（`destinationPath`/`manifestDirectory`）と
  schema 1 受理分岐（約40行）も撤去候補

共有の `fixture-builders.mjs` 的なファイルへ集約する。

### tools 側小計

| 案 | 純削減 |
| --- | --- |
| 2-A 休眠経路整理（方針次第） | 最大約1,800行 |
| 2-B bake.py デッドコード | 約200行 |
| 2-C bake_parallel 統合 | 135行 |
| 2-D Python ヘルパ共通化 | 80-120行 |
| 2-E JS fixture 共通化 + contract 整理 | 120-140行 |
| **合計（2-A除く確実分）** | **約535-595行** |

## 3. 削らないほうがいい部分（判断と理由）

- **タイルストリーミング中核**（`earth-surface-tiles.ts` 194行・`earth-surface-resident.ts`
  375行・`earth-surface-tile-queue.ts` 351行・`earth-surface-gpu.ts` 237行）は
  防御的だが非同期失敗・GPU寿命・stale 要求という実際の問題に対応している。
  世代一本化（1-E）以上の「状態機械の併合」はリスクが効果を上回る
- **Worker 経路**（worker-client 86行 + worker 36行）— gzip 展開を描画スレッドから
  外す仕組みとして対費用効果が高い。format 引数は 1-C の一部として消える
- **`EarthSurfaceProjectionCache`（86行）** — 10フィールドのスナップショット比較は
  冗長に見えるが「100ms 間隔でだけ再構築」という意図的なレート制限。削ると
  毎フレーム Frustum 再構築になる
- **queue の3連 PermitPool**（http6/decode2/waiting8）— 既に共通化済みで、
  上限値は性能チューニングの話であり行数の話ではない

## 4. 推奨する実施順

1. **まず dead code を消す**（2-B + 1-D の uncalled 分 + 2-E の未使用 export）—
   判断コストほぼゼロ、約250行
2. **本番レイヤーからテスト/ツール資産を移す**（1-A + 1-B + 1-D の test-only 分）—
   約500行。挙動変更ゼロ、`check:boundaries` で境界の正当性も確かめられる
3. **tools の休眠経路を方針決定して整理**（2-A + 2-C + 2-D + 2-E）— Python/JS の
   責務を「現行経路のみ」へ絞る。`fetch-source.py` の KeyError など実害もある
4. **octahedral/v1 撤去**（1-C）— 配信 manifest の実態確認と fixture の v3 移行が前提
5. **設計判断が要るもの**（1-E generation 一本化・1-F 検査縮小・1-G adapter mode）—
   効果よりリスクが上回りうるので、単独の計画で扱う

実施する場合は描画系なので `/rendering-workflow` と `/modify-feature` を先に通し、
`npm run typecheck`・`npm run test:render`・`npm run check:boundaries`、
加えて render-lab の地表ケース撮影比較（`render-lab:shot`/`compare`）で回帰を見る。
tools 側は `earth-surface:test` 系と Python unittest の現行経路を通す。

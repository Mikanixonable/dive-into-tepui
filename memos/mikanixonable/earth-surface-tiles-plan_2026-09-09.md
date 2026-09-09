# 地球地表タイル計画 — 未完了タスク

作成日: 2026-09-09。未完了タスク用に再編: 2026-09-10。

このファイルは、未完了タスクの入口と共通前提だけを含む。実装済みの詳細、commit、既存契約の成立経緯は
[done/earth-surface-tiles-plan_2026-09-09.md](done/earth-surface-tiles-plan_2026-09-09.md)へ移した。
T0〜T7の実装手順は同名ディレクトリのタスクファイルへ分割している。担当タスクのファイル、ここで示す
共通前提、依存タスクの完了記録だけを読めば実装できる。現在のコードを調べるときはコードを原本とし、
done文書を実装仕様の代わりにしない。

## 1. 目的と現在地

地球へ近づいたとき、見ている地域だけが段階的に細かくなり、標高から作った斜面の明暗が太陽の向きに応じて変わる地表を作る。
遠距離では全球のbaseを表示し、近距離では必要な地域の色・法線・roughnessタイルを遅延取得する。通信失敗、GPU非対応、
非表示、disposeが起きても、地球やゲーム進行を止めない。

現在は、タイル座標・frontier・要求キュー・デコード検証・fake GPU寿命・EarthSurface facade・月別気候の境界・release検査の
fixture契約までが実装済みである。次の状態はまだ実現していない。

- 実GeoTIFF、GSHHG Shapefile、ERA5 NetCDFからの生成
- Three.js/WebGPUの実`DataArrayTexture`層更新とTSL material
- Earth entityへの実manifest/request queue/coordinator/GPU接続
- 月別気候の雲・雲影・大気への本番配線
- 実ブラウザでのGBuffer画像とp95性能計測
- GitHub Pages fixture配信と全球bundleの外部静的配信

## 2. 実装時に変えてはいけない前提

### データ

- BMNG July 2004 Base Mapを地表色の基準にする。
- ETOPO 2022 v1のice-surface elevationとgeoidを使う。`bed_elev`とGEBCOは使わない。
- GSHHG full resolutionで海・湖・陸の被覆率を作る。海抜の正負から水域を推定しない。
- ERA5 1991–2020月平均の2m気温と総雲量を12か月のRGBA気候mapへ焼く。
- 気候mapのRGBAはR=気温、G=雲量、B=水域を除いたETOPO正高、A=GSHHG陸地被覆率。水域のBは0、海抜0m未満の陸は負値を保つ。

### 描画とLOD

- 基準楕円体のメッシュを使い、標高は法線と陰影だけへ反映する。地形で輪郭・遮蔽・衝突を変えない。
- 形状LODとテクスチャLODを分ける。地域patch meshや追加draw callは作らない。
- テクスチャ四分木はz=0〜7、タイル内側256×256、2texel gutter、最高段の赤道間隔は約611m。
- `errorPx`、視錐台/地平線、2:1隣接制約、ページ表、親子fadeをCPUで管理する。
- 色はsRGB、地形/法線はNoColorSpace。ページ表はNearest、色と地形の必須標本化はLinear、mipmapは必須にしない。
- 水roughness=0.05、陸=0.80、明示できる氷=0.35。色の青さや標高閾値からroughness/氷を推定しない。
- 色と地形を同じGPU層へ書き込み、両方が揃ってからフレーム境界でページ表を公開する。
- WebGPU機能が足りない場合はDataArrayTextureを作らず、全球baseへ固定する。
- 地形バイナリはraw gzip本文の`.bin.gz`として配り、クライアントの`DecompressionStream`で一度だけ展開する。HTTPの`Content-Encoding: gzip`は併用しない。

### 配信

ゲーム本体は現在どおり`docs/`からGitHub Pagesで配る。配信モードを次の二つから選べるようにする。

- `pages`: `docs/earth-surface/<datasetId>/`へfixtureまたは小さな縮小版を配置する。同一originなのでCORS不要。
- `external-static`: 全球bundleを静的オブジェクト/CDNへ版付きで配置し、PagesのゲームからCORS付きで読む。全球版の推奨構成。

`EARTH_SURFACE_DEPLOY_MODE`、`EARTH_SURFACE_BASE_URL`、`EARTH_SURFACE_DATASET_ID`をbuildへ渡す。
同じdatasetIdのURLを上書きせず、データ更新時は新しいdatasetIdのパスを使う。

## 3. 依存関係

```text
T0 基準記録
├─ T1 実データ入力・小領域生成
└─ T2 実GPU material / base fallback
      └─ T3 Earth entity本接続
            └─ T4 月別気候を雲・雲影・大気へ接続
                  └─ T5 実行時画像・metrics
                        └─ T6 Pages/外部静的配信・CI
                              └─ T7 レビューと文書記録
```

T1とT2はfixture契約の範囲で並行できる。T3はT2のbase fallback境界、T4はT1の気候mapとT3のEarth接続、
T5はT3/T4、T6はT1/T5へ依存する。

## 4. 未完了タスク一覧

各ファイルは一つの実装単位に絞っている。実装時は対象ファイルを先に読み、必要な場合だけ依存タスクのファイルを追加で読む。

| ID | 作業ファイル | 目的 | 依存 |
| --- | --- | --- | --- |
| T0 | [T0-baseline.md](earth-surface-tiles-plan_2026-09-09/T0-baseline.md) | 基準状態と検証結果を保存 | なし |
| T1 | [T1-data-bundle.md](earth-surface-tiles-plan_2026-09-09/T1-data-bundle.md) | 実データから小領域bundleを生成 | T0 |
| T2 | [T2-gpu-material.md](earth-surface-tiles-plan_2026-09-09/T2-gpu-material.md) | 実GPU配列層とTSL materialを完成 | T0 |
| T3 | [T3-earth-connection.md](earth-surface-tiles-plan_2026-09-09/T3-earth-connection.md) | Earth entityへ本接続 | T2 |
| T4 | [T4-climate-connection.md](earth-surface-tiles-plan_2026-09-09/T4-climate-connection.md) | 月別気候を雲・雲影・大気へ接続 | T1, T3 |
| T5 | [T5-capture-metrics.md](earth-surface-tiles-plan_2026-09-09/T5-capture-metrics.md) | 実行時画像とp95 metricsを完成 | T3, T4 |
| T6-1 | [T6-1-pages.md](earth-surface-tiles-plan_2026-09-09/T6-1-pages.md) | Pages同居配信を接続 | T1, T5 |
| T6-2 | [T6-2-external-static.md](earth-surface-tiles-plan_2026-09-09/T6-2-external-static.md) | 全球bundleの外部静的配信を接続 | T1, T5 |
| T6-3 | [T6-3-runtime.md](earth-surface-tiles-plan_2026-09-09/T6-3-runtime.md) | build/runtimeと配信モードを接続 | T6-1またはT6-2 |
| T7 | [T7-review.md](earth-surface-tiles-plan_2026-09-09/T7-review.md) | レビュー、整理、記録 | T0〜T6 |

## 5. 静的配信と独自サーバーの扱い

静的ファイルをCDNやNginxから返すだけなら、`external-static`と同じ性質であり、独自アプリサーバーとは分けて考える。
独自サーバーを作る場合も、クライアント契約はmanifest、tile-index、tile GETのままにする。

| 性質 | GitHub Pages同居 | 外部静的/CDN | 独自サーバー |
| --- | --- | --- | --- |
| 全球bundle | 容量・release push時間が制約 | 最も適する | 可能だが運用が必要 |
| 遅延読み込み | 可能 | 可能 | 可能。動的生成は初回が遅くなり得る |
| クライアント負荷 | 軽い | 軽い | 軽い |
| 配信側負荷 | 低い | 低〜中 | 高い。生成処理を入れるとさらに増える |
| CORS | 同一originなら不要 | 必須 | 必須（同一originなら不要） |
| キャッシュ | datasetId付きURLが必要 | immutable cacheを設定しやすい | 自由に制御可能 |
| 更新 | アプリ更新と結び付きやすい | データとアプリを独立更新できる | 独立更新できるがデプロイ管理が必要 |
| 動的生成・認証 | 不可 | 基本不可 | 可能 |
| 運用負担 | 低い | 低〜中 | 高い |

**推奨順**:

1. Pages同居モードでfixtureの遅延取得を検証する。
2. 同じmanifest契約で外部静的/CDNへ全球bundleを置く。
3. Pages workflowはゲーム本体だけを生成し、bundle公開を別stepまたは別workflowへ分ける。
4. 動的生成、認証、配信状況に応じた変換が必要になった場合だけ独自サーバーを検討する。

## 6. 実装前の価値判断

既定値は次のとおりで、回答が無くてもこの方針で進められる。

- 全球bundleは外部静的/CDN、Pagesはfixture/縮小版。
- WebGPU内部APIはadapter内に限定して許容し、非対応環境はbase-only。
- 気候の月とblendはゲーム時刻のUTCから一度だけ決める。
- 実データ全量・実ブラウザp95・公開originが無い場合は、fixture完了と外部受け入れ待ちを分けて記録する。

変更すると影響が大きい判断は、Pagesへ全球bundleを必ず同居させるかどうかである。同居を必須にする場合は、T0で計測したサイズ・
ファイル数・push時間が予算を超えたとき、タイル段数または解像度を下げるか、公開を止める。

## 7. 検証コマンド

変更後は最低限次を実行する。

```text
npm run typecheck
npm run test:render
npm run test:game
npm run earth-surface:test
python3 -m unittest discover -s tools/earth-surface -p 'test_*.py'
git diff --check
```

release接続を変更した段では、追加で`npm run build`、`npm run verify:release`、`npm run earth-surface:check`、
`npm run earth-surface:package`、Pages layout testまたはremote-checkを実行する。

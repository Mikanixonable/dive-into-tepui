# 地球地表タイル計画 — 全世界版

作成日: 2026-09-09。未完了タスク用に再編: 2026-09-10。実装前レビュー反映: 2026-09-10。

この文書は未実装部分の入口と受け入れ条件を持つ。実装済みの契約、コードの現在状態、過去の判断経緯は
[done/earth-surface-tiles-plan_2026-09-09.md](done/earth-surface-tiles-plan_2026-09-09.md)を参照する。
現在のコードを知るときはコードを原本とし、done文書を現状説明として使わない。

## 1. 目的と今回の決定

地球へ近づいたとき、見ている地域だけが段階的に細かくなり、標高から作った斜面の明暗が太陽の向きに応じて変わる地表を作る。
遠距離では全球のbaseを表示し、近距離では必要な地域の色・法線・roughnessタイルを遅延取得する。通信失敗、GPU非対応、
非表示、disposeが起きても、地球やゲーム進行を止めない。

今回、次を確定した。

- 初回の実データ生成対象は全世界、z=0〜7とする。
- Pagesは本リリース前のプレビュー配信先とする。実装の受け入れ条件はローカルの`npm run dev`で
  実データbundleを同一originから読み込めることであり、本リリースの配信先はこの計画の範囲外とする。
- 外部静的配信は要件から廃止する。本番の地表データはゲーム本体と同じGitHub Pagesのoriginだけから配る。
- manifest URLをデータセットの正本とする。環境変数でdatasetIdやbase URLを重複定義しない。
- 気候mapは1024×512、12か月のRGBAとする。
- Three.jsの内部APIはGPU adapter内に隔離する。
- v1ではmipmapを必須にしない。LOD、親子fade、フォールバックを受け入れ条件にする。
- GPU追加メモリ、隣接タイル差、GPU p95は診断値とし、対応環境や実測値が得られないことだけでコード完了を失敗にしない。
- 旧smoothness画像は、新しいmanifest経路が成立するまでEarth実行時の開発フォールバックとして残す。月・他天体・cloud-labの旧fixtureを一括削除しない。

## 2. 固定前提

### データ

- BMNG July 2004 Base Mapを地表色の基準にする。
- ETOPO 2022 v1のice-surface elevationとgeoidを使う。bed elevationとGEBCOは使わない。
- GSHHG full resolutionで海・湖・陸の被覆率を作る。海抜の正負から水域を推定しない。
- ERA5 1991–2020月平均の2m気温と総雲量を12か月のRGBA気候mapへ焼く。
- 気候mapは1024×512とする。R=気温、G=雲量、B=水域を除いたETOPO正高、A=GSHHG陸地被覆率。
- 水域はAで判定し、実行時には水域の標高を0mとして扱う。海抜0m未満の陸地は負値を保つ。
- 入力データの版、SHA-256、単位、CRS、鉛直基準、NoData、再格子化、帰属をsource manifestへ記録する。

### 描画とLOD

- 基準楕円体のメッシュを使い、標高は法線と陰影だけへ反映する。地形で輪郭・遮蔽・衝突を変えない。
- 形状LODとテクスチャLODを分ける。地域patch meshや追加draw callは作らない。
- テクスチャ四分木はz=0〜7、タイル内側256×256、2texel gutter、最高段の赤道間隔は約611m。
- errorPx、視錐台/地平線、2:1隣接制約、ページ表、親子fadeをCPUで管理する。
- 色はsRGB、地形/法線はNoColorSpace。ページ表はNearest、色と地形の必須標本化はLinear、mipmapは必須にしない。
- 水roughness=0.05、陸=0.80、明示できる氷=0.35。色の青さや標高閾値からroughness/氷を推定しない。
- 色と地形を同じGPU層へ書き込み、両方が揃ってからフレーム境界でページ表を公開する。
- WebGPU機能が足りない場合はDataArrayTextureを作らず、全球baseへ固定する。
- 地形バイナリはraw gzip本文の.bin.gzとして配り、クライアントのDecompressionStreamで一度だけ展開する。HTTPのContent-Encoding: gzipは併用しない。
- タイル要求、resident cache、ページ表は非表示・dispose・データセット変更で世代を無効化し、遅着データを公開しない。
- EarthSurfaceは地球のメッシュ、material、base fallback、タイル管理、GPU adapterを所有する。一般天体のCelestialSurfaceとはメッシュ生成の共通部分だけを共有する。

### 配信

開発中のゲーム本体と地表データは、`npm run dev`が配る同一originから読み込む。GitHub Pagesは同じ
bundleを確認するためのプレビューとして扱い、本リリースの配信経路には含めない。

- docs/earth-surface/<datasetId>/へmanifest、tile-index、base、全世界z0〜z7、12枚の気候mapを配置する。
- Pagesのrepository subpathを考慮し、asset URLをハードコードしない。
- manifestは短いcache、datasetId付きtile/base/climateはimmutable cacheとする。
- 同じdatasetIdのURLを上書きしない。更新時は新しいdatasetIdを使う。
- GitHub Pagesの公開上限を超えるbundleはプレビューへ配置しない。全世界z0〜z7を縮小して上限へ
  合わせることは行わず、超過時は実測値付きでプレビューだけをblockedとする。ローカルbundleの
  生成・検査・実行は継続できる。
- 動的サーバーは作らない。必要になった場合もクライアント契約はmanifest、tile-index、tile GETを維持する。

ローカルでの確認は、アプリを`npm run build`でdocsへ生成した後、bundleを
`npm run earth-surface:dev-stage`でdocs/earth/<datasetId>/へ配置し、`npm run dev`から行う。

## 3. 依存関係とフェーズ

T0完了後、T1とT2はfixture契約の範囲で並行する。T3はT1とT2、T4はT1とT3、T5はT3とT4、
T6-1はT1とT5、T7は全フェーズに依存する。T6-3のruntime bootstrapはT3へ統合する。

```text
T0 基準記録
├─ T1 実データ入力・全球bundle生成 ─┐
└─ T2 実GPU material / base fallback ─┴─ T3 Earth entity本接続 + runtime bootstrap
            └─ T4 月別気候を雲・雲影・大気へ接続
                  └─ T5 実行時画像・metrics
                        └─ T6-1 Pages本番配信・CI
                              └─ T7 全体レビューと文書記録
```

## 4. 完了ゲート

各フェーズでは、コード、データ、公開を混同せず次の証拠を残す。

- コードゲート: 型検査、対象層の回帰テスト、レビュー、不要APIと旧参照の点検。
- データゲート: 入力hash、生成manifest、tile-index、バイナリ検査、制御点画像、再現可能な生成ログ。
- 公開ゲート: Pagesプレビューへ配置する場合だけbundleのlayout、URL、cache、CORS不要の同一origin取得、
  代表tileのGETを検査する。ローカル受け入れは`npm run dev`からのmanifest・代表tile取得で判定する。
- WebGPU、実ブラウザp95、外部認証など実行環境に依存するものは、未実施を明記し、コード完了と分ける。
- 全世界bundleの生成・公開ができない場合、生成器の完了を全世界公開完了へ読み替えない。

## 5. 実装前のP0準備

1. 現在の作業ツリーをクリーンなコミットへ固定し、雲システムなど無関係な差分をEarth作業へ混ぜない。
2. T0でHEAD、作業ツリー、Node/npm、OS、ブラウザ、WebGPU、drawing buffer、検証コマンドと終了コードを記録する。
   WebGPUやdrawing bufferを起動できない場合はunavailableと記録する。
3. GDAL、NetCDF、GSHHG geometry依存と生成用ディスク容量を確認する。
4. 全世界z0〜z7のタイル数、入力・中間・出力容量、生成時間を実測する。巨大な全球配列を一度にメモリへ展開しない。
5. 16制御地域と制御点を定義する。全球生成の受け入れには、赤道、60度、両極、日付変更線、海岸、
   青い陸、氷、負標高陸、海底、ヒマラヤ、グリーンランド、南極、カスピ海、死海を含める。
6. ESTB/ESTN、manifest、tile-index、気候RGBAのversion、寸法、channel、endianness、NoData、hash範囲を固定する。
7. 気候、地表、雲、大気、雲影で共通の楕円体地理UVとUTC月時計を使う契約を固定する。

## 6. タスク一覧

| ID | 作業ファイル | 目的 | 依存 | 本番必須 |
| --- | --- | --- | --- | --- |
| T0 | [T0-baseline.md](earth-surface-tiles-plan_2026-09-09/T0-baseline.md) | 基準状態と検証結果を保存 | なし | はい |
| T1 | [T1-data-bundle.md](earth-surface-tiles-plan_2026-09-09/T1-data-bundle.md) | 実データから全球bundleを生成 | T0 | はい |
| T2 | [T2-gpu-material.md](earth-surface-tiles-plan_2026-09-09/T2-gpu-material.md) | 実GPU配列層とTSL materialを完成 | T0 | はい |
| T3 | [T3-earth-connection.md](earth-surface-tiles-plan_2026-09-09/T3-earth-connection.md) | Earth entityとruntime bootstrapを接続 | T1,T2 | はい |
| T4 | [T4-climate-connection.md](earth-surface-tiles-plan_2026-09-09/T4-climate-connection.md) | 月別気候を雲・雲影・大気へ接続 | T1,T3 | はい |
| T5 | [T5-capture-metrics.md](earth-surface-tiles-plan_2026-09-09/T5-capture-metrics.md) | 実行時画像とmetricsを完成 | T3,T4 | はい |
| T6-1 | [T6-1-pages.md](earth-surface-tiles-plan_2026-09-09/T6-1-pages.md) | Pages本番配信を接続 | T1,T5 | はい |
| T6-2 | — | 外部静的配信要件を廃止（実装・公開経路から除去） | — | いいえ |
| T6-3 | [T6-3-runtime.md](earth-surface-tiles-plan_2026-09-09/T6-3-runtime.md) | 旧runtime記述をT3へ統合して廃止 | T3へ統合 | いいえ |
| T7 | [T7-review.md](earth-surface-tiles-plan_2026-09-09/T7-review.md) | 全体レビュー、整理、記録 | T0〜T6-1 | はい |

## 6.1 実装状況（2026-09-10）

コードとして完了したフェーズは次のとおり。実データの取得・全量生成・実WebGPU表示は別ゲートであり、コード完了だけでは達成扱いにしない。

| フェーズ | 状態 | commit / 証拠 | 未達・制約 |
| --- | --- | --- | --- |
| T0 | 完了 | `492fd9af`、`.earth-surface/verification/baseline.json` | WebGPU/drawing bufferはunavailable |
| T1 | 生成入口・実データ事前検査・fixture境界・入力検証・micromamba環境・入力窓境界を実装、実データ全量はblocked | `7b88aad7`, `87b6c8b5`, `d91ab5d3`, `f3c076fc`, `5e679dd0`, `8d4f492c`, `.earth-surface/verification/earth-bundle-generation-blocked-2026-09-10.md`、Python 43 tests | ERA5 local export未配置。複数GeoTIFFの球面積再格子化、BMNG線形RGB、GSHHG空間被覆、ERA5月平均合成と全43690実生成は未完了。fixtureはsynthetic provenanceで本番と分離 |
| T2 | コード完了 | `49e01186`、render 88/88 | 実ブラウザ/WebGPU撮影は未実施 |
| T3 | ゲーム経路・実Earthメッシュの詳細材質接続完了 | `ccc3683f`, `85b63f59`, `b1f5e2e2`、render 113/113、game 205/205 | 実manifest取得・実データ通信・実WebGPU撮影は未実施。データが無いため実タイル表示は未確認 |
| T6-2 | 廃止 | 2026-09-10に外部静的配信要件を廃止 | 既存のremote-check実装を削除し、Pages同一origin検査へ集約 |
| T6-1 | fixture Pages・容量/coverageゲート完了。Pagesはpreview用途 | `9545bcdb`, `8d4f492c`、Pages layout/contract pass | 実全世界bundleはERA5と合成未完了のため未公開。ローカルはbundle生成後`npm run dev`で確認する |
| T4 | コード完了 | `e195d4df`, `ac919b93`, `ea6d47a3`, `22532275`、render 96/96、game 201/201 | 実ERA5 bundleと実ブラウザ/WebGPU撮影は未実施 |
| T5 | コード完了 | `7f8614fc`, `e90aaeca`, `95e0152b`、render 100/100、game 201/201、capture contract pass | 実データ未投入のため15ケースのcolor/normal/depthはunavailable |
| T7 | コードレビュー・記録更新完了 | `c1024c61`, `dc2e0427`, `0ced354b`, `5302be8c`、追加 `a5cacedb`, `ccc3683f`, `85b63f59`, `b1f5e2e2`, `ed53a902`、対象テスト pass | 実データ生成・Pages本番公開・実captureゲートは未達成。blocked理由をT1とpreflight JSONへ記録 |

## 7. 検証

変更後は、各タスクに書かれた検証を実行する。全体完了時は次を実行する。

npm run typecheck
npm run test:render
npm run test:game
npm run earth-surface:test
python3 -m unittest discover -s tools/earth-surface -p 'test_*.py'
npm run build
npm run verify:release
npm run earth-surface:check
npm run earth-surface:package
npm run earth-surface:capture
git diff --check

test:renderとtest:gameは同じtests/distを作り直すため並列実行しない。実ブラウザやWebGPUが無い場合は
対応するcapture/metricsへ未実施理由を記録する。全体完了時は、コードゲート、データゲート、Pages公開ゲートを
一つずつ確認し、未達成の項目を完了扱いにしない。

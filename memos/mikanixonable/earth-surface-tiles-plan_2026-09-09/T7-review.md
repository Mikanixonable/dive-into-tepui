# T7: 全体レビューと記録

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

## 手順

1. コードレビューを行い、Earth fallback、月/他天体、dispose、色空間、NoData、経度wrap、極、
   2:1 frontier、旧GEBCO参照、manifest URL、Pages subpathを確認する。
2. EarthSurfaceのpersistent lease、visibility lifecycle、GPU層解放、画面外tile pin、
   drawing buffer伝搬、楕円体UV、UTC気候時計を確認する。
3. 不要な公開API、旧Earth runtime参照、削除済みT4パス、重複したruntime設定を全文検索する。
4. /refactorの観点で重複境界、コメント、例外経路、fake/real backendの責務を整理する。
5. typecheck、render/game/data/releaseの変更に対応するテストを実行する。renderとgameは並列実行しない。
6. Pages fixtureと本番bundleのlayout、manifest、tile-index、代表tile、12 climate mapを検査する。
7. コードゲート、データゲート、Pages公開ゲートを一つずつ確認する。
8. 実ブラウザ、WebGPU、GPU p95が未実施なら、その理由と残る受け入れ作業を記録する。
9. 各フェーズのcommit、検証コマンド、fixture完了、全世界生成、Pages公開の状態を親計画へ追記する。

## 完了条件

- 本番必須T0、T1、T2、T3、T4、T5、T6-1をすべて確認できる。
- 外部静的配信は本番未実施として明示されている。
- 未達成のゲートを完了扱いにしていない。

## 実装状況（2026-09-10）

コードレビューと記録は `c1024c61` を基礎に、`a5cacedb`, `ccc3683f`, `85b63f59`, `ed53a902` を追加確認した。
EarthSurfaceのpersistent lease、非表示・dispose・
世代切替、可視frontierのpin、drawing buffer伝搬、楕円体UV、UTC気候時計、GPU層解放、Pagesの
subpath URL、datasetId整合、raw gzip契約を確認した。Earth実行経路にGEBCOや旧Earth気候画像の
参照はなく、`tools/render-lab/cases.ts` の旧画像はlegacy fixtureとして残している。

追加実装後の検証結果は typecheck、render 113/113、game 205/205、Python 24件、
Earth契約、Pages fixture layout pass、capture contract passである。既存の全体テスト826/826、build、verify-releaseも
直前のコード状態でpassしている。実captureはChrome/WebGPU/描画バッファまで
到達し、実データ未投入を理由に15ケースをunavailableとして記録した。

実データbundleが無いため `earth-surface:check` と `earth-surface:package` は
`earth-surface.json`を読めず終了コード1となる。これは失敗を隠さずデータゲート未達成として残す。
fixture Pagesだけは20ファイル・30909 bytesで検査済みである。T1の入力取得・全43690タイル生成と
T6-1の実bundle公開が完了するまで、本番完了とは扱わない。Earth用のT3/T4/T5/T6-1/T6-2 worktreeは
統合後に削除した。

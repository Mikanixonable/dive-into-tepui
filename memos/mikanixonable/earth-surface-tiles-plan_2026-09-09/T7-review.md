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

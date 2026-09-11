# T7: 全体レビューと記録

親計画: [earth-surface-tiles-plan_2026-09-09-superseded.md](../suspended/earth-surface-tiles-plan_2026-09-09-superseded.md)

## 手順

1. コードレビューを行い、Earth fallback、月/他天体、dispose、色空間、NoData、経度wrap、極、
   2:1 frontier、旧GEBCO参照、manifest URL、Pages subpathを確認する。
2. EarthSurfaceのpersistent lease、visibility lifecycle、GPU層解放、画面外tile pin、
   drawing buffer伝搬、楕円体UV、UTC気候時計を確認する。
3. 不要な公開API、旧Earth runtime参照、削除済みT4パス、重複したruntime設定を全文検索する。
4. /refactorの観点で重複境界、コメント、例外経路、fake/real backendの責務を整理する。
5. typecheck、render/game/data/releaseの変更に対応するテストを実行する。renderとgameは並列実行しない。
6. Pages fixtureとローカルdev配信のlayout、manifest、tile-index、代表tile、12 climate mapを検査する。
7. コードゲート、データゲート、Pages公開ゲートを一つずつ確認する。
8. 実ブラウザ、WebGPU、GPU p95が未実施なら、その理由と残る受け入れ作業を記録する。
9. 各フェーズのcommit、検証コマンド、fixture完了、全世界生成、Pages公開の状態を親計画へ追記する。

## 完了条件

- T0、T1、T2、T3、T4、T6-1のコード・データ契約を確認できる。
- T5の15固定ケースを確認するまで全体完了にしない。
- 外部静的配信要件は廃止し、ローカルdevは同一originの直接bundle配信を使う。

## 実装状況（2026-09-11）

実bundleは約5.5 GiB、43,690タイル、z0〜z7、12枚の気候mapで生成済みである。global baseはz0東西2枚から
512×256へ生成する。物理GPU配列は144層、論理frontierは128層、フェード予備は16層である。

`npm run dev`は`.earth-surface/bundle`を`/earth/<datasetId>/`へ直接配信し、manifest URLと配信datasetIdを共有する。
`docs/earth/<datasetId>/`が正しいPages layoutであり、5.5 GiB実bundleのPages配備は範囲外である。

今回の実ブラウザstage00レビューは3回連続で成功し、5.083〜5.339秒で最高LOD z7へ到達した。color/terrain各24・36・32件がHTTP 200となり、
「地球 ready/detailed」「地球 最高LOD z7」、fatal/errorなしを全runで確認した。

レビューで見つかった旧世代upload競合、ImageBitmap解放漏れ、base sentinelの詳細UV流入、base取得失敗の診断欠落、
2:1依存分割の飢餓、再利用層の別tile誤参照は回帰テスト付きで修正した。ただし15固定ケースの完全な視覚計測は未実施であり、
T7はその検証が終わるまで未完了とする。

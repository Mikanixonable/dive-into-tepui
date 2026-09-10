# T6-1: GitHub Pagesプレビュー配信

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

## 目的

GitHub Pages向けfixtureのlayoutとURL契約を検査する。本リリースの配信先はこのタスクの責務に含めず、5.5 GiBの実bundle配備も範囲外とする。

## 実装範囲

1. fixtureでmanifest、tile-index、JPEG、raw gzip、12枚の1024×512気候mapを検査する。
2. preview fixtureの配置先はdocs/earth/<datasetId>/とする。
3. Pages URLがrepository subpathでも、manifest URLから相対asset URLを作る。
4. manifestは短いcache、datasetId付きtile/base/climateはimmutable cacheとする。
5. EARTH_SURFACE_PAGES_MAX_BYTESを設ける。既定値はGitHub Pagesの公開上限1 GB
   ([GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits))とし、
   fixtureではテスト用の小さい値を明示して使う。全世界生成をこの予算に合わせて縮小してはならない。
   receipt.json自身を含む実測値が超過した場合は公開を止め、実測値・LOD・タイル数・不足入力を記録する。
6. docsのentry script、release URL、manifest到達性、datasetId整合、代表tile GETを検査する。
7. Pages workflowはアプリbuildとbundle stagingの順序を固定し、生成物のhashをreceiptへ記録する。

## 完了条件

- fixture Pages bundleをローカルHTTPで取得できる。
- docs/earth/<datasetId>/のlayoutがmanifest、base、代表tile、12 climate mapへ到達できる。
- CORSを必要としない同一origin取得で動作する。
- 5.5 GiBの実bundleをPagesへ配備しない判断を容量範囲として記録する。

## 実装状況（2026-09-11）

fixture Pagesのreceipt/hash、サイズ予算、subpath URL、layout検査、CI順序を完了した。実bundleは約5.5 GiBのため、
Pages previewへの配備を受け入れ条件に含めない。ローカルの実bundle確認は`.earth-surface/bundle`を`npm run dev`で
直接配信し、`/earth/<datasetId>/`から行う。外部静的配信要件は廃止済みである。

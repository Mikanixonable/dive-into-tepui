# T6-1: GitHub Pages本番配信

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

## 目的

GitHub Pagesのdocsを本番配信元として、ゲーム本体と全世界z0〜z7地表bundleを同一originから遅延取得する。

## 実装範囲

1. fixtureでmanifest、tile-index、JPEG、raw gzip、12枚の1024×512気候mapを検査する。
2. 本番生成物ではdocs/earth-surface/<datasetId>/へ全世界z0〜z7とbaseを配置する。
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
- production bundleの全世界z0〜z7がtile-indexと一致する。
- release URLのsubpathからmanifest、base、代表tile、12 climate mapへ到達できる。
- CORSを必要としない同一origin取得で動作する。

## 実装状況（2026-09-10）

fixtureまたは指定bundleのPages staging、receipt/hash、サイズ予算、subpath URL、layout検査、CI順序を実装する。
fixture Pagesは検査対象だが、BMNG等から生成した全世界bundleのdocs公開は入力未提供とサイズ上限のため未完了である。

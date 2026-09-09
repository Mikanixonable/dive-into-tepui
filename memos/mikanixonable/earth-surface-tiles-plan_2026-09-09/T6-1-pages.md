# T6-1: GitHub Pages本番配信

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

## 目的

GitHub Pagesのdocsを本番配信元として、ゲーム本体と全世界z0〜z7地表bundleを同一originから遅延取得する。

## 実装範囲

1. fixtureでmanifest、tile-index、JPEG、raw gzip、12枚の1024×512気候mapを検査する。
2. 本番生成物ではdocs/earth-surface/<datasetId>/へ全世界z0〜z7とbaseを配置する。
3. Pages URLがrepository subpathでも、manifest URLから相対asset URLを作る。
4. manifestは短いcache、datasetId付きtile/base/climateはimmutable cacheとする。
5. EARTH_SURFACE_PAGES_MAX_BYTESを設ける。これはfixtureと本番bundleの検査に使うが、
   全世界生成をこの予算に合わせて縮小してはならない。超過時は公開を止め、実測値と判断を記録する。
6. docsのentry script、release URL、manifest到達性、datasetId整合、代表tile GETを検査する。
7. Pages workflowはアプリbuildとbundle stagingの順序を固定し、生成物のhashをreceiptへ記録する。

## 完了条件

- fixture Pages bundleをローカルHTTPで取得できる。
- production bundleの全世界z0〜z7がtile-indexと一致する。
- release URLのsubpathからmanifest、base、代表tile、12 climate mapへ到達できる。
- CORSを必要としない同一origin取得で動作する。

## 実装状況（2026-09-10）

`49d840f2` でfixtureまたは指定bundleのPages staging、receipt/hash、サイズ予算、subpath URL、layout検査、CI順序を実装した。
fixture Pagesは検査済みだが、BMNG等から生成した全世界bundleのdocs公開は入力未提供のため未完了である。

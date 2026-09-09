# T5: 実行時画像とmetricsを完成する

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

このファイルは、このタスクを実装するときに読む作業単位である。共通の固定前提は親計画の§2、
依存関係は§3を参照する。実装済みの契約は`done/`ではなくコードを原本とする。


**変更対象**: `tools/render-lab-earth-surface.mjs`、`tools/render-lab/`、`src/render/earth-surface-metrics.ts`、
`package.json`、`tools/earth-surface/serve.mjs`。

1. ヒマラヤ50/200/2,000km、赤道、60度、両極、日付変更線、海岸、青い陸、氷、負標高陸、模式図を固定ケースにする。
2. 各ケースで`color.png`、`normal.png`、`depth.png`、`metrics.json`を`.earth-surface/verification/`へ保存する。
   metricsにはdatasetId、browser/backend、viewport、projection、sun方位、selectedZ、errorPx、frontier、fallback率、
   HTTP/decode待機、GPU層、page table更新、encoded/payload bytes、失敗理由を含める。
3. 撮影前にtile公開または明示的fallback/永久失敗を待つ。未到着の単色画像を成功扱いにしない。
4. 到着順、404、通信断、128層超過、mipmap有無をfake serverで再生する。
5. 実ブラウザが使える場合は1920×1080と内蔵解像度で300フレームを測る。使えない場合は未実施をmetricsへ記録する。

**検証**: `npm run earth-surface:capture`、`npm run typecheck`、`npm run test:render`、`npm run test:game`。
親子fade中に色・法線・roughnessが分離せず、LOD閾値付近で選択が往復しないことを確認する。

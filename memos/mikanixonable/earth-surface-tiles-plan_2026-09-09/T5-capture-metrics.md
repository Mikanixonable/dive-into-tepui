# T5: 実行時画像とmetricsを完成する

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

## 目的

Earthの色、法線、roughness、深度、LOD、通信、GPU常駐を再現可能な形で記録する。

## 実装範囲

1. ヒマラヤ50/200/2,000km、赤道、60度、両極、日付変更線、海岸、青い陸、氷、
   負標高陸、海底、模式図を固定ケースにする。
2. 各ケースでcolor.png、normal.png、depth.png、metrics.jsonをverificationへ保存する。
3. metricsにはdatasetId、browser/backend、viewport、projection、sun方位、selectedZ、errorPx、
   frontier、fallback率、HTTP/decode待機、GPU層、page table更新、encoded/payload bytes、失敗理由を含める。
4. 撮影前にtile公開または明示的fallback/永久失敗を待つ。未到着の単色画像を成功扱いにしない。
5. 到着順、404、通信断、物理GPU144層超過、mipmap有無をfake serverで再生する。
6. 実ブラウザが使える場合は1920×1080と内蔵解像度で300フレームを測る。
   timestamp queryが無い場合のGPU p95はunavailableと記録する。

## 完了条件

- 視覚出力とmetricsが同じdataset、browser、viewport、時刻を指す。
- 親子fade中に色・法線・roughnessが分離しない。
- LOD閾値付近で選択が往復しない。
- WebGPUやブラウザを使えない環境では未実施理由がmetricsに残る。

## 実装状況（2026-09-11）

capture APIとmetrics schema、fake transport/GPU再生を実装済み。実bundleを使ったstage00 smokeでは5.812秒で
color/terrain各z7 20件がHTTP 200となり、F3再読みでready/detailed・最高LOD z7、fatal/errorなしを確認した。

15固定ケースの完全なcolor/normal/depth/metrics取得は未実施である。したがってT5は未完了であり、stage00 smokeの成功を
15ケースの完了へ読み替えない。

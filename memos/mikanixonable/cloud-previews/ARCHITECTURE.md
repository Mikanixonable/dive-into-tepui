# 雲の生成基盤の構造とフィードバックループの現況

(2026-11-15 時点、devin/dev + 進行中 worktree gen-dynamics。最新はコードが原本)

生成は「気圧場 → 風 → 気団と上昇流 → 雲量場 → 細部乗数」の流れ。以下は各段の
担い手をコードの名前で辿る案内。

## 気圧場

`weather-model.ts` の `pressureSourceAt` が気圧偏差 [hPa] を組み立てる:
`bandPressureAt(latitude)`(大循環の緯度帯、赤道の谷・副熱帯の尾根・極側の窪み)
+ `pressureNoise`(CirculatingNoise、3 オクターブ・温帯で強い)
+ `cyclones.pressureAt` + `highs.pressureAt`。

- `cyclones.ts` — `Trough`(低気圧 1 個。uniform: center/axis/depth/楕円の芯。
  `pressureAt`=反比例の裾を引く谷、`eyeAt`=台風の眼、`anvilAt`=天蓋、
  `frontAt`=寒冷前線(長軸の赤道側端へ)と温暖前線(東へ)の帯、
  `wcbAt`=温暖湿気輸送路の広い領域)、`Cyclones`(熱帯 1 + 温帯 `LOW_COUNT`=8)。
- `cyclone-tracks.ts` — `lowPlacementAt`(亜熱帯の縁に生まれ東へ走り極側で消える、
  半球 4 枡・位相ずらし)、`tropicalPlacementAt`(暖かい海で生まれ西進→転向→温帯化)。
  深さ・半径・速さ・寿命はファイル先頭の Range 定数群。
- `anticyclones.ts` / `anticyclone-tracks.ts` — `Highs`/`highPlacementAt`
  (step 34 新設。低気圧と同じ枡を半位相ずらし、6-14 hPa・800-1200 km・遅い東進)。

## 風

`windFieldAt`/`traceFlowAt` が `pressureFieldAt`(焼いた気圧の勾配・等圧線・曲がりを
差分で測る)から釣り合い風を解く。`wind-law.ts` の `balancedWind`(地衡風+勾配風)、
`composeWind`、地表はエクマン項で等圧線横切り角。大循環の帯は
`bandPressureSlopeAt` を解析的に差し引く(尾根差し引き)。上層風は別の摩擦率・
ゲイン + `atmospheric-wind.ts` の気候プロファイル + `rossby-wave.ts` の摂動
+ `meanderUpperWind`(蛇行ノイズ)。

## 気団・上昇流・前線

`air-mass.ts` の `AirMass.at` が遡った風から `warmth`(温位)と `compression`
(気団の押し縮まり)を出す。診断的な前線は `weatherAt` 内で
compression・湿度勾配(`moistureGradientAt`)・上昇流から組み立て、実体の前線
(`cyclones.frontAt`)と大きい側を `band` に取る。上昇流 `lift` = 地形
+ `dynamicsLiftAt` + `band×BAND_LIFT` − `massReturn`(緯度帯の平均沈降)。

## 雲量場

`weather-transport.ts` の `advectedAt` が湿度 2 層(地表・上層)と対流の写しを
風で遡らせる。`weatherAt` がそこへ足し引きする項: `cloudinessBias(meanCloudiness)`
(平年雲量)、`lift` の加湿/乾燥、`warmth×WARM_HUMIDITY`、`band×BAND_HUMIDITY`、
`anvil×ANVIL_HUMIDITY`、`eye` の乾燥、`cyclones.wcbAt×WCB_UPPER_HUMIDITY`
(巻雲の盾)。結果を `BakedField` 2 枚へ焼いて表示時刻で補間。
`convective-activity.ts`・`humidity-modulation.ts` が対流の活発度と湿度の修飾。

## 細部(描画側)

`cloud-detail.ts` — `CirrusDetailEvaluator.multiplierAt` が巻雲を
筋状(streak)・鱗雲状(cell)・薄く広がる(veil)・金床(anvil)の 4 型へ
`regimeAt`(数百 km の静的領域ノイズ)とジェット(上層風速)で配分。
`CumulusDetailEvaluator` が積雲の細胞・雲列を環境で混ぜる。
`cloud-detail-clock.ts` の `DetailClock` が `evolvingNoise`(時間発展する
ノイズ)と `flowNoise`(流れ方向へ伸ばしたノイズ)を供給。広い尺度の濃さは
変えない — 帯や晴れ間は雲量場の責務(SPEC 原則)。

## 評価道具(tools/)

| 道具 | 測るもの |
| --- | --- |
| `cloud-regime-audit.mjs` | 気圧・風・上昇流・応答の実写分布距離(weather スコア) |
| `cloud-detail-compare.mjs` | 生成 vs 実写場面の特徴量封筒距離・巻雲型別距離 |
| `cloud-detail-metrics.mjs` + `cloud-components.mjs` + `cloud-detail-features.mjs` | スペクトル・間欠性・形状(maxAxis/elongShare 含む)の特徴量 |
| `cloud-lab-motion-compare.mjs` | 実写時系列との動きの距離 |
| `cloud-albedo-check.mjs` | 光学(明るさ) |

## ループの現況

- **gen-dynamics**: 34 ステップ、weather 0.215→0.0993。step 34 高気圧採用、
  step 35 低気圧従属の前線(実装・調定中)
- **motion-stage2**: 0.546→0.325、統合済み。**cloud-cells**: 基準計測のみ
- **cloud-optics**: albedo 全 PASS、未統合

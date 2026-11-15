# 雲の生成基盤の構造(2026-11-16 時点、devin/dev 7b0668511)

生成は「気圧場 → 風 → 気団と上昇流 → 雲量場 → 凝結・層化 → 細部乗数 → 光学」の流れ。
以下は各段の担い手をコードの名前で辿る案内。最新はコードが原本。

## 気圧場 `weather-model.ts`

`pressureSourceAt` が気圧偏差 [hPa] を組み立てる: `bandPressureAt(latitude)`
(大循環の緯度帯) + `pressureNoise`(CirculatingNoise) + `cyclones.pressureAt`
+ `highs.pressureAt`。

- `cyclones.ts` — `Trough`(低気圧 1 個。`pressureAt`=楕円の谷、`eyeAt`=台風の眼、
  `anvilAt`=天蓋、`wcbAt`=温暖湿気輸送路の領域)、`Cyclones`(熱帯 1 + 温帯
  `LOW_COUNT`=8)。低気圧への帯のスタンプ(旧 `frontAt`)は step 39 で廃止。
- `cyclone-tracks.ts` — `lowPlacementAt`(step 40: 枡の生まれる経度を
  `rossby-wave.ts` の谷 `waveTroughLongitude` の下流へ錨づけ、4 枡が 5 谷の
  うち 4 個を使う → 空の谷が世代ごとに巡回して波列が時々崩れる。
  一生のあいだ波の位相速度で東進。近づきすぎた浅い低気圧は深い側が吸収)。
  `tropicalPlacementAt`(西進→転向→温帯化)。
- `anticyclones.ts` / `anticyclone-tracks.ts` — `Highs`/`highPlacementAt`。
  低気圧と同型の実体を尾根(谷+半波長)の下流側へ錨づけ。低・高が
  偏西風の蛇行線上に交互配置される(step 40)。

## 風 `weather-model.ts` + `wind-law.ts`

`windFieldAt`/`traceFlowAt` が `pressureFieldAt`(焼いた気圧の勾配・曲がりを差分で
測る)から釣り合い風を解く。`balancedWind`(地衡風+勾配風)、`composeWind`、地表は
エクマン項で等圧線横切り角。大循環帯は `bandPressureSlopeAt` を解析的に差し引く。
上層風は `atmospheric-wind.ts` の気候プロファイル + `rossby-wave.ts` の摂動 +
`meanderUpperWind`(蛇行)。

## 気団・上昇流・帯 `air-mass.ts` + `weatherAt`

`AirMass.at` が遡った風から `warmth`(温位)と `compression`(押し縮まり)を出す。
**帯 `band` は診断だけで立つ**: `front` = compression・湿度勾配
(`moistureGradientAt`)・上昇流から `FRONT_ONSET/FRONT_WIDTH` で遷移、温帯限定。
`rainband` = compression の稜線(`RAINBAND_ONSET/WIDTH`)、熱帯限定。両者の和を
`min(..., 1)`。`lift` = 地形 + `dynamicsLiftAt` + `band×BAND_LIFT` −
`massReturn`(緯度帯の平均沈降)。

## 雲量場 `weather-transport.ts`

`advectedAt` が湿度 2 層(地表・上層)と対流の写しを風で遡らせる(地表 20 h、
上層 `UPPER_ADVECTION`=1.6 倍)。`weatherAt` が足し引き: `cloudinessBias`
(平年雲量)、`lift` の加湿/乾燥、`warmth×WARM_HUMIDITY`、
`band×BAND_HUMIDITY`、`anvil×ANVIL_HUMIDITY`、`eye` の乾燥、
`cyclones.wcbAt×WCB_UPPER_HUMIDITY`(巻雲の盾)、熱帯の対流クラスタの
3 項(芯の上昇 CLUSTER_LIFT・消費の環の沈降 CLUSTER_SINK と乾き
CLUSTER_DRYING・流出の盾の上層加湿 CLUSTER_OUTFLOW_HUMIDITY)。
結果を `BakedField` 2 枚へ焼いて時刻補間。
`convective-activity.ts`・`humidity-modulation.ts` が修飾。

熱帯の対流クラスタ — `cluster-tracks.ts` の `clusterPlacementAt` が
湿った発生源に世代ごとの乱数でクラスタを生む(寿命 1〜3 日・
半径 300〜700 km・貿易風で西進)、`convective-clusters.ts` の `Clusters`
が芯・消費の環・流出の盾の濃さを答える。別のクラスタの環の中では
強さを削る抑制で、資源消費による間隔の自己組織化(step 41)。

## 凝結・層化 `condensation.ts` + `cloud-kind.ts`

`condense(weather)` が雲量→被覆率(`COVERAGE_ONSET/WIDTH` の伝達関数)→
層別雲頂を出す。被覆 0.7 未満は「まばらな低い雲」、以上は深い層(雲頂は
lift・warmth・band・対流で伸びる)。**`BAND_DECK`=0.2 が帯へ乱層雲の被覆を
足す項** — 前線帯が深い雲転移へ届かず中層が生まれなかった対策(step 37)。
`cloud-kind.ts` が積雲・巻雲の高度レンジと雲量→光学深度の写像
(`cumulusCoveringDepth`、`cumulusInCloudOpticalDepth`=雲中 τ_in、
`CIRRUS_MAX_OPTICAL_DEPTH`)を持つ。

## 細部 `cloud-detail.ts` + `cloud-detail-clock.ts`

`CirrusDetailEvaluator.multiplierAt` が巻雲を筋状・鱗雲・幕・金床の 4 型へ
`regimeAt`(領域ノイズ)とジェット(上層風速)で配分。`CumulusDetailEvaluator`
が細胞・雲列。`DetailClock` の `evolvingNoise`/`flowNoise` が時間発展と
流れ方向の伸長を供給。**帯や晴れ間の大規模構造は雲量場の責務で、細部は
濃さを配り直すだけ**(SPEC 原則・step 36 の教訓)。

## 光学 `cloud-optics.ts` + `cloud-optics-node.ts`

`cloudReflectance(τ, g)` — 二流近似の反射率。透過は `1−R` で釣り合い、
雲の明るさ・背景の見え方・影へ同じ光学厚が効く。`LIQUID_CLOUD_ASYMMETRY`/
`ICE_CLOUD_ASYMMETRY`。検査は `tools/cloud-albedo-check.mjs`。

## フィールド束 `cloud-field-sampler.ts` + `cloud-presentation.ts`

`CloudFieldSampler` が weather → CloudSample を束ね、`CloudPresentation` が
`GeneratedCloudField`(本モデル)と `ObservedCloudField`(実写データ駆動)を
`CLOUD_FIELD_SOURCE_KIND` で切り替える。

## 評価道具 `tools/`

- `cloud-regime-weather.mjs` — 気象状態の焼き出し(チャンネルの生 Float32)。
- `cloud-regime-audit.mjs` — 気圧・風・lift・ISCCP 級の実写分布距離。
- `cloud-detail-compare.mjs` — 生成 vs 実写場面の特徴量封筒距離・巻雲型別。
- `cloud-detail-metrics.mjs` + `cloud-components.mjs` +
  `cloud-detail-features.mjs` — スペクトル・間欠性・形状(maxAxis/elongShare)。
- `cloud-lab-motion-compare.mjs` — 実写時系列との動きの距離。
- `cloud-translucent-*.mjs` — 薄い雲の透過教師・特徴量・比較。

## ループの現況

- 気象力学(LOOP-LOG-dynamics): weather 0.215→0.0986。step 34 高気圧・
  step 35 前線+WCB・step 37 BAND_DECK・step 38 上層湿度再調定・
  step 39 帯の診断一本化・step 40 ロスビー波への錨づけ+吸収則・
  step 41 熱帯対流クラスタ、すべて採用・統合済み。
- 巻雲 detail(LOOP-LOG-cirrus): index 0.348→0.182(5 ステップ、統合済み)。
  step 6 — UPPER_LIFT_HUMIDITY 増量は不採用(欠損は空間配分、
  熱帯クラスタの流出加湿が担う)。統合後の再計測が待ち。
- 光学: 統合済み・albedo 全 PASS。動き: motion-stage2 統合済み(0.546→0.325)。

# 気象・雲システムのシンプル化計画(2026-11-16)

ユーザーの要求:「気候のシステムが複雑になりすぎている。見た目と動きが自然な雲を作る
という点でバランスが悪い箇所をシンプル化・廃止したい」に基づく調査と実施計画。

## 背景

- 現行モデルは閉形式(表示時刻の関数)の GPU 気象モデル。一度大きなモデルへ進み
  `21dc2a7f1` で origin/main へ戻した経緯がある。現行は戻した側に cloud-lab 計測
  ループの調整が積み増された状態。
- 複雑さの正体は「小さな補助項の蓄積」で、単一の巨大な仕組みではない。湿度合成は
  8 項の足し引き、コメントに「X を弱めた分を Y で埋める」式の打ち消しが多い。

## コストの地図(ベイク 1 回・cap 512²あたり)

中間場 5 パス + 出力場 3 パス。出力場の気象評価回数:

- `cloud` 場 — `condense(weatherAt)` 全評価 ×1
- `environment` 場 — **同じ `condense(weatherAt)` をもう一度全評価**(要るのは
  陸・活発度・平年雲量・金床の 4 値で、うち 2 つは気候テクスチャの素通し)
- `motion` 場 — `windsAt` ×5 点平滑(各 = 気圧 7 tap + 釣り合い風 + ロスビー波)

消費者を追うと、絵に直接効くのは `cloud` 場だけ。`motion` は細部のドリフト 3 箇所、
`environment` は `grainOf` と `cirrusColumnInputOf` のみ(両方とも細部系)。

## 実施する一級(今回の範囲)

1. **environment 場の二重気象評価を解消** — `BakedField` を複数出力(MRT)へ拡張し、
   cloud 場のパスを `[cloud, env]` の 2 出力にする。`weatherAt` は texel あたり 1 回
   評価(現状 2 回)。見た目不変。
2. **motion 場の評価を軽くする** — `windFieldAt` で `surfaceLocal` と `upperLocal`
   が同じ引数の `balancedWind` を重複評価しているのを 1 回へ統一し、`windsAt`
   では対流用の釣り合い風を計算しない。5 点平滑は気圧写しの texel 揺れが細部に
   偽の渦を作るという実害の対策で(cloud-field.ts のコメント)、維持する。
3. **upperMeander 廃止** — 上層の移流遡り方向だけを ±14° 回す単一オクターブ
   `CirculatingNoise` 1 系統。除去で上層の移流風 = 地表の移流風になるので、
   `advectedAt` は湿度風・対流風の 2 系統へ整理する。
4. **moistureFront 廃止** — 移流前湿度の 4 tap 勾配で重み 0.2 の補助項。前線の
   本体は `airMass.compression` が担う。`moistureGradientAt`・調整値 2 つを除去。

## 採否を保留した候補(二級以降)

- 対流専用の第 2 釣り合い風 `convectionLocal`(摩擦 3 倍・横断 50°)の簡略化
- 巻雲細部の型システム(cloud-detail.ts の ~260 行、4 型 + Voronoi)の簡素化
- DetailClock の継ぎ目ブレンド・flowNoise の簡素化
- `warmth` 項(湿度・雲頂・活発度への小さな寄与 3 箇所)の整理
- 「その場で入れ替わる」機構 3 系統(エポック 18 h / 循環の呼吸 7 日 / DetailClock)
  の整理 — 尺度違いで同居は正当化できる
- `CLOUD_TUNING` 70 パラメータの定数化(lab スライダー運用の継続可否に依存)
- `ObservedCloudField`(実写雲)— low プリセット既定・設定項目。product 判断
- tools 専用の読み出し面(`GeneratedCloudField.at()`、`WeatherModel` の
  `traceWindAt/meanWindAt/humiditySourceAt/convectionSourceAt`)
- `WeatherSample` の `pressure/surfaceWind/compression` は出力フィールドとしては
  lab 専用 — 内部で計算済みなので削減効果は見通しだけ

## 残すべき基幹(削ると目に見えて退化)

`wind-law`(渦の巻き・遡り)、`cyclones`+`cyclone-tracks`(一生・眼・金床・雨帯)、
`air-mass` の compression(前線・雨帯の唯一の源)、`weather-transport` 2 位相移流 +
`circulation` 位相輸送(動きの基幹)、`condense`・`convective-activity`、
2 スロット 6s 補間・cap スナップ、`cloud-kind`・`cloud-optics`・`CloudShadowRenderer`。

## 仕様との関係

今回の 4 項目はいずれも「作り方」の簡素化で、`DEVELOP/SPEC/RENDERING.md`「雲の描画」
が要求する振舞い(前線は気団の境目、筋は上層の流れに従う、細部は流れに乗る)を
変えない。**SPEC 更新は行わない。**

## 検証

- `npm run typecheck`、`npm run test:render`、`npm run check:boundaries`
- 見た目の変化: (1)(2) は不変のはず、(3)(4) は気象場がわずかに変わる
  (上層の筋の向きの揺れ・前線帯の細さ)。cloud-lab の天気図で確認する価値あり。

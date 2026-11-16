# 気象・雲システムのシンプル化計画(2026-11-16)

ユーザーの要求:「気候のシステムが複雑になりすぎている。見た目と動きが自然な雲を作る
という点でバランスが悪い箇所をシンプル化・廃止したい」に基づく調査と実施計画。
二級候補は同日に再検証し、採否を更新済み。

## 背景

- 現行モデルは閉形式(表示時刻の関数)の GPU 気象モデル。一度大きなモデルへ進み
  `21dc2a7f1` で origin/main へ戻した経緯がある。現行は戻した側に cloud-lab 計測
  ループの調整が積み増された状態。
- 複雑さの正体は「小さな補助項の蓄積」で、単一の巨大な仕組みではない。

## ベイクのパス構成(現状)

syncTime ごとの描画パス:

- 中間場: `pressure` → `airMassTrace`(気圧を読むので後) → `humiditySource` /
  `convectionSource` → `instability` (計 5)
- 出力場: `cloud+environment`(1 パス 2 出力 MRT) / `motion`(計 2)

## 実施済み(一級、2026-11-16)

| 項目 | 内容 | コミット |
| --- | --- | --- |
| environment の二重評価 | BakedField を MRT 対応へ拡張し、cloud+env を 1 パス 2 出力へ。weatherAt 評価 2→1 回 | `f163d042b` |
| motion の風評価 | 地表・上層で同一引数だった balancedWind の重複を解消、windsAt から対流風を除外(5 点平滑は texel 揺れの偽渦対策として維持) | `e5aafe65a` |
| upperMeander | 上層遡り方向 ±14° の蛇行ノイズを廃止。advectedAt は 2 風系統へ整理 | `e5aafe65a` |
| moistureFront | 湿度勾配の補助前線項(重み 0.2)を廃止。moistureGradientAt・WeatherTransport.surfaceHumidityAt も除去 | `e5aafe65a` |

## 二級の再検証(2026-11-16) — 結論: 大半は正当な複雑さで不採用

「リアルな雲を作るうえで過剰か」を各項が担う見た目と照合した結果、SPEC 要求の
直接の担い手か、ほぼゼロコストの副産物が大半だった。

### 不採用(見た目の担い手・ゼロコスト)

- **`convectionLocal`(対流専用の第 2 釣り合い風)** — 摩擦 3 倍・横断 50° で対流を
  湿度風とは別に運ぶ。渦のまわりで粒が放射状に千切れる実写の様子の担い手。
  費用は weatherAt 内の balancedWind 1 回のみ。湿度風へ統一するとその効果が消える。
- **巻雲細部の型システム(cloud-detail.ts ~260 行)** — 筋状・鱗雲状・薄く広がる・
  金床の 4 型はすべて実在の巻雲形態で、SPEC「多様な雲」の直接の担い手。型割当の
  レジームノイズ 4 tap は場所ごとの型の散らばりの源。鱗雲の Voronoi(27 セル)は
  低高度でのみ型の重みが立つ設計で、全球視点では評価されない。品質「粗」で既に
  無効化済み — 削っても見た目は「粗」と同等になるだけで削減の意味がない。
- **DetailClock・flowNoise の継ぎ目ブレンド・リサイクル機構** — SPEC「細部も流れに
  乗り、生まれて崩れる」「時間加速で人工的な明滅を出さない」の直接の担い手。
  presence の時間加速フェードも SPEC 要求。flowNoise の多点タップは流れ方向への
  有限相長の筋を作る仕組み(座標圧縮では無限相長になって不自然)。
- **`warmth` 項** — trace 場の副産物(|緯度|−|出身緯度|)で計算コストほぼゼロ。
  湿度(WARM_HUMIDITY)・雲頂(WARM_TOP)・活発度(COLD_ACTIVITY)への 3 箇所の
  寄与は、前線の暖気側の層状化・寒気側の不安定化という SPEC「前線の非対称」の
  物理そのもの。
- **「その場で入れ替わる」機構 3 系統の同居** — 尺度と対象が違う正当な分担:
  エポック混ぜ替え(18 h・総観段、雲塊の発達消滅)、循環の呼吸(7 日・熱帯の
  微細段、公転が接線になる熱帯のその場変化)、DetailClock(描画細部)。
  エポック無しでは雲が発達も消滅もせず永遠に流れるだけになる。
- **tools 専用の読み出し面** — `GeneratedCloudField.at()`・`WeatherModel` の
  traceWindAt/meanWindAt/humiditySourceAt/convectionSourceAt・WeatherSample の
  pressure/surfaceWind/compression はすべて内部で計算済みの値の露出で実行コスト
  ゼロ。消費者は views.ts・synoptic-field・weather-probe・motion-main で、これは
  「気圧の配置や動きを検証する基盤」そのもの。削ると検証力を失う。

### product 判断(SPEC 改訂・運用変更が前提、本計画の枠外)

- **ObservedCloudField(実写雲)** — SPEC が「雲の分布: 生成と実写から選ぶ」を明示
  要求(RENDERING.md:159-162, 783-786)。low プリセット既定は低負荷 GPU 向けの
  意図的選択。廃止すれば 87 行+画像アセット+cloudFieldSource 設定+dual-source
  配管(cloud-presentation.ts ~30 行)が消える最大級の削減だが、SPEC 改訂と
  low プリセットを生成へ移す判断(低負荷環境で生成ベイクの費用を負う)が前提。
  単なる複雑さの問題ではないので、ここでは判断しない。
- **CLOUD_TUNING 76 キー + lab スライダー** — 全キーが生成パイプラインの uniform
  エイリアスとして参照され、スライダー→uniform→invalidate→再ベイクの計測経路は
  現役で動く。定数化は lab 調整運用の終了と同値で、複雑さの実質(項の相互作用)
  は減らない。運用を畳む判断があれば generation-params.ts(106 行)+uniform 経路を
  除去できるが、単体での削減効果は小さい。

## 新提案(採用推奨): ベイクパスの統合で 7 → 5 パス

再検証で見つけた、所有権を崩さずにパスを減らせる 2 件。

### N1. instability 場のインライン化

- 現状: `ConvectiveActivity` が CirculatingNoise を `instability` 写し(R 形式)へ
  ベイクし、`at()` が同じ方向で 1 点だけ読む。**ベイクの amortize が成立しない**
  (多点読みでない)ので、独立パスとテクスチャが純粋な無駄。
- 変更: `at()` 内で `noise.at(direction)` を直接評価し、BakedField・bake()・
  WeatherModel.bake の呼び出し・dispose を除去(約 −40 行、パス −1)。
- 値の同一性: ベイクパスでは texel 中心で評価されるのでインライン評価と一致
  (むしろ半精度の量子化を 1 回挟まない分だけ正確)。lab が任意方向で読む場合も
  線形補間の写しではなく正確な値を返すようになる。
- 消費者: `convectiveActivity` は weatherAt・views.ts・weather-probe 経由でのみ
  読まれ、写しを直に読む箇所はない(確認済み)。

### N2. humiditySource + convectionSource を RGBA 1 写しへ統合

- 現状: WeatherTransport が RG 2 枚を別々のパスで焼く。
- 変更: 1 枚の RGBA 写しへ(xy=湿度、zw=対流)。advectedAt の読みは `.xy`/`.zw`
  へ振り替えるだけ。sourceAt の呼び出し回数・タップ数は不変。パス −1、約 −20 行。
- lab の公開メソッド humiditySourceAt/convectionSourceAt(ノイズを直接評価)は
  無関係に残る。

### 実施後の構成

- 中間場: `pressure` → `airMassTrace` → `transportSource` (3 パス)
- 出力場: `cloud+environment` MRT / `motion` (2 パス)
- 計 5 パス(一級前の 8 から −3)

### 不採用: pressure + transport 源のさらなる統合

依存のない場どうしを 1 MRT パスへ畳めば 4 パスになるが、pressure(WeatherModel
所有)と transport 源(WeatherTransport 所有)が交差し、BakedField を後から
注入する二段初期化(CODING-RULE 1.11 禁止)か所有権の移動が要る。パス 1 つに
見合わない。

## 残すべき基幹(再確認)

`wind-law`(渦の巻き・遡り)、`cyclones`+`cyclone-tracks`(一生・眼・金床・雨帯)、
`air-mass` の compression(前線・雨帯の唯一の源)、`weather-transport` 2 位相移流 +
`circulation` 位相輸送(動きの基幹)、`condense` 全域(被覆率・層状・塔・層積雲・
巻雲 τ)、`convective-activity`、エポック・呼吸・DetailClock、2 スロット補間、
`cloud-kind`・`cloud-optics`・`CloudShadowRenderer`、CLOUD_TUNING uniform 経路、
ObservedCloudField(SPEC 要求)。

## 仕様との関係

一級・N1・N2 は「作り方」の簡素化で、SPEC「雲の描画」の要求振舞いを変えない。
**SPEC 更新は行わない。** ObservedCloudField の廃止だけは SPEC 改訂が前提。

## 検証

- 実施済み分: typecheck・test:render 303 件・check:boundaries すべて通過。
- N1・N2: (1) と同様に見た目不変のはず(読む値は同一)。検証は同 3 コマンド。

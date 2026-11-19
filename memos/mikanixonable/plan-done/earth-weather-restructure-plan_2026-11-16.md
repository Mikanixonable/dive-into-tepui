# earth-weather 構成変更計画(2026-11-16)

`src/render/cloud/`(34ファイル)を `src/render/earth-weather/` へ移し、気象シミュレーションと
雲フィールド・雲描画を分ける構成変更。方針はユーザーが決定済み: **earth-weather の中に
cloud/ を入れる入れ子構成**。

## 背景

- cloud/ は34ファイルに膨れ、気象シム(大循環・サイクロン・輸送)と雲フィールド生成・
  見た目(光学・細部・形状)が混在しており、どこが入口か分かりにくい。
- 実依存を辿ると軸は「生成 vs 描画」の2項ではなく
  **気象シム → 雲フィールド(データ契約) → 見た目** の3段。共有語彙
  (cloud-kind・cloud-tuning・cloud-field-sample)が両側から引かれる。
- `src/weather/` への独立層化は ARCHITECTURE R2(装置どうしは import し合わない)に
  抵触する — cloud 側が WeatherModel を引くため。TSL・BakedField・GPU パスに深く
  依存するので physics/ にも置けない。**`render/` の中に留めるのが規則と整合する。**

## 変更後の構造

```
src/render/earth-weather/        気象シミュレーション(雲を「知らない」気象学)
  air-mass.ts                    気団・前線
  atmospheric-wind.ts            風場
  circulating-noise.ts           循環ノイズ
  circulation.ts                 大循環
  climate-map.ts                 気候帯入力
  convective-activity.ts         対流活動
  cyclone-tracks.ts              サイクロン進路
  cyclones.ts                    サイクロン一生
  rossby-wave.ts                 ロスビー波
  sphere-frame.ts                緯度・東北方向の地理語彙
  weather-model.ts               気象側ハブ
  weather-transport.ts           湿度・対流の輸送焼き込み
  wind-law.ts                    釣り合い風
  cloud/                         雲フィールド + 見た目(気象サンプルを食べる側)
    <下記21ファイル>
```

`earth-weather/cloud/`(21ファイル):

| 群 | ファイル |
| --- | --- |
| 契約・語彙 | cloud-kind.ts, cloud-kind-node.ts, cloud-tuning.ts, cloud-field-sample.ts |
| 生成(橋渡し) | condensation.ts, cloud-field.ts, generated-cloud-field.ts, observed-cloud-field.ts, cloud-field-sampler.ts |
| 見た目 | cloud-presentation.ts, cloud-render-input.ts, cloud-cap.ts, cloud-detail.ts, cloud-detail-clock.ts, cloud-optics.ts, cloud-optics-node.ts, cloud-shape-evaluator.ts, cirrus-flow.ts, cirrus-flow-node.ts, cumulus-shape.ts, gradient-noise.ts |

- ファイル名は**変えない**(移動だけ)。`cloud-*`/`weather-*`/`cirrus-*`/`cumulus-*`
  接頭辞がそのまま担当を示す。cloud/ の中で接頭辞を剥がすのは別の議論。
- `condensation` は気象サンプル→雲量の橋渡しだが、生成物が雲なので cloud/ 側に置く。
- `sphere-frame` は地理語彙として気象側に置き、cloud/ からは `../sphere-frame` で引く。
- `cloud-tuning` を気象ファイルが引くのは現状の構造(気象ノブが cloud-tuning に同居)。
  分割はこの変更では扱わない。

## import 書き換え規則

- 気象→気象、cloud→cloud: 変更不要(`./x` のまま)。
- 気象→cloud(`./cloud-tuning` 等): `./x` → `./cloud/x`。
- cloud→気象(`./weather-model` `./sphere-frame` 等): `./x` → `../x`。
- cloud/ 内ファイルから render/ 直上へ(`../baked-field` `../tsl-types` 等):
  深さが1段増えるので `../x` → `../../x`。
- 外部から: `render/cloud/x` → 気象側は `render/earth-weather/x`、
  雲側は `render/earth-weather/cloud/x`。

## 変更対象の範囲

- `src/render/cloud/` 全34ファイル(git mv)。
- `src/game/celestial/solar-system/earth-system.ts` — src/ 内の唯一の消費者(5 import)。
- `tools/cloud-lab/`、`tools/render-lab/` — 深い import を多用(15ファイル以上)。
- `tests/render/` — cloud-* テスト群の import パス。
- `tools/check-boundaries.mjs` の exempt 行 `src/render/cloud/...` 2件
  (存在しないパスだが、移動で prefix が変わるので書き換える)。

## 実行条件(ゲート)

1. 起動から **90分経過**。
2. **全 worktree**(`git worktree list`)で `src/render/cloud/`・`DEVELOP/SPEC/` に
   未コミット変更がないこと — 進行中の cloud 仕様変更が終わったことの代理。
   ダーティなら30分延長して再確認、最大2回。それでもダーティなら**実行せず報告**。

## 手順

1. `refactor/earth-weather-restructure` ブランチを現在の workspace3 HEAD から切る。
2. `mkdir src/render/earth-weather/cloud`、上記分類どおり `git mv`。
3. 書き換え規則どおり import を一括修正(機械的作業 → SWE-2 へ委譲。/delegate-devin)。
4. `npm run typecheck` → `npm run check:boundaries` → `npm run test:render`。
5. コミット: `refactor(render): cloud/ を earth-weather/ 配下へ気象と雲で再編`。

## 留意点

- 振舞いは一切変えない(移動とimport修正のみ)。
- `CloudFieldSource` 型が cloud-presentation にあり generated/observed-cloud-field が
  そこから引く逆流は**既知の課題として報告だけし、この変更では直さない**。
- `feat/cloud-leo-look`・`feat/cyclone-wave-stormtrack` の worktree が cloud ファイルを
  触っている場合、将来のマージで衝突する。実行後の報告に明記する。
- 実行はタイマーの終了通知で起きたセッションが行う。このファイルが手順の正本。

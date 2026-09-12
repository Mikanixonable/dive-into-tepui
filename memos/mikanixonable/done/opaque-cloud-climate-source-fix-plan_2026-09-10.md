# [完了] 不透明な雲の気候入力回帰 修正計画

作成日: 2026-09-10
基準スナップショット: `d2abc1e6`

この計画は、不透明な雲が表示されなくなった回帰を、雲の体積表現や描画品質の調整へ
広げず、気候入力の供給と切替の境界に限定して修正するためのもの。実装と検証はこの計画の
確認後に行う。

## 実施結果（2026-09-12）

この計画のコード上の修正は完了し、`done/`へ移動した。

- 開発用の決定的な月次RGBA気候fallbackを追加した。
- `ready`状態のmanifestだけを実データへ切り替えるようにした。
- 月変更・source変更時にcurrent/nextのTSL入力が更新されるようにした。
- Pages fixtureを非一様な気候入力へ変更し、契約検査を追加した。
- `npm run typecheck`、`npm run test:render`、`npm run test:game`、
  `npm run earth-surface:test`、`npm run earth-surface:pages-test`を通過した。

実ERA5データの取得・気象精度・全世界bundle生成は、この計画のスコープ外であり、残タスクとして
[残タスク一覧](../remaining-tasks_2026-09-12.md)に分離した。

## 1. 調査結果

### 原因

最初の回帰点は `893e6700 feat(earth): 月次気候ソースを雲に接続`。

- それ以前のEarthは、同梱 `src/assets/earth-climate.png` を `ClimateMap` で読み、雲場へ渡していた。
- このコミット以降は、`EARTH_SURFACE_FIXTURE_SOURCE.climateMapUrls` の12 URLから
  `MonthlyClimateMap`を作るようになった。
- 実データのmanifestが取得できない場合、そのURLは `https://example.test/...` のままで、
  取得可能な気候画像ではない。
- Pages用fixtureの `tools/earth-surface/stage-pages.mjs` も、現在は1024×512 RGBA8の
  全チャンネル0のPNGを12枚生成する。Gチャンネルが平年雲量なので、雲量は全球で0になる。
- `OpaqueCloudSurfaceRenderer`は雲場の被覆率が0の柱を描かないため、不透明な雲が無い画面になる。

したがって、後続の体積レイマーチ・LOD・法線サンプリングのコミットが第一原因ではない。
後続コミットも、無効な気候入力を有効な入力へ直していない。

### 同時に直すべき切替不備

`MonthlyClimateMap`の `setMonth` と `replaceUrls` は、現在の月の番号や配列を更新するが、
すでに生成済みのTSLテクスチャノードは構築時の画像を参照し続ける。実データへ切り替えても
シェーダグラフが新しい画像を読まないため、月次入力の接続自体が成立しない。

## 2. 既存方針との関係

この修正は、既存の開発方針に反しない。むしろ、現在の仕様と地表タイル計画を満たすために必要な
補正である。

- `DEVELOP/SPEC/RENDERING.md`は、雲の無い広い領域、観測された平均雲量に対応する分布、時刻に
  対して決定的な雲を要求している。雲量0の仮入力をそのまま実行時の入力にすることは、この要求を
  満たさない。
- 地表タイル計画のT4は、地表・雲・雲影・大気で月次気候map、UTC月時計、楕円体UVを共有し、
  Earth実行経路から旧 `earth-climate.png` を除く方針である。修正では旧画像を復活させず、
  RGBA月次契約の決定的な開発用入力を用いる。
- `DEVELOP/CODING-RULE.md`の責務分割に従い、気候入力の生成・寿命・切替は気候map側、
  Earth systemは入力を組み立てて接続する配線側、雲rendererは `ClimateMapLike` を読む側に保つ。
- 仕様はすでに期待する挙動を定義しているため、`DEVELOP/SPEC/`の変更は行わない。

反対に、次の修正は既存方針に反するため採用しない。

- rendererへ `example.test` の本番URLを直接埋め込む。
- Earthだけ旧 `earth-climate.png` に戻し、月次地表データとの共有契約を外す。
- URLクエリやデバッグフラグで雲を強制表示する。
- 雲rendererにmanifest取得・fallback選択・配信環境の判断を持たせる。

## 3. 修正方針

### 3.1 開発用fallbackを月次RGBA入力として用意する

`src/render/cloud/`に、実データと同じ `MonthlyClimateTexture` 契約を満たす決定的な開発用
気候mapを用意する。

- 12か月分のRGBA8データを生成する。
- Gには0だけでなく、広い晴天域と雲量のある領域を含める。Aには陸域と水域を含める。
- 生成値は契約範囲内に収め、乱数や現在時刻に依存させない。
- fallbackの `request()` は通信を開始せず、`dispose()` と `generation` は通常の
  `MonthlyClimateTexture` と同じ寿命契約にする。
- Earthはこのfallback mapを、実データと同じ楕円体UVで `GeneratedCloudField` へ渡す。

fallbackは実ERA5データの代替ではなく、実データが無い開発・検証環境でも雲の経路を空入力に
しないための入力である。実データの正確性をこのfixtureで完了扱いにしない。

### 3.2 実データへの切替を有効な状態に限定する

`src/game/celestial/solar-system/earth-system.ts`のruntime接続を次の契約へ揃える。

- 初期状態は開発用fallback mapを使う。
- `bootstrap.state === 'ready'` かつ `bootstrap.source` がある場合だけ、manifestの12 URLへ切り替える。
- `fallback` と `error` の結果に含まれる `EARTH_SURFACE_FIXTURE_SOURCE` は、地表のfallback情報として
  扱い、気候mapのURL置換には使わない。
- 切替時はfallbackの12枚を解放し、雲場の `generation` を進めて同じ表示時刻を再焼成する。
- 実データのcurrent/next画像がGPUへ公開されるまで、fallbackの見え方を維持できる境界を確認する。

### 3.3 月次mapのTSLグラフを動的入力へする

`src/render/cloud/monthly-climate-map.ts`を、構築時の配列要素へ直接固定する形から、current/next
画像を保持する安定したTSLテクスチャノードへ変更する。

- `setMonth` はcurrent/nextの画像ノードを新しい月へ更新する。
- `replaceUrls` は新しい12枚を作り、現在のcurrent/nextノードを更新してから旧画像を解放する。
- 月境界のblend、generation、request対象2枚の契約は維持する。
- `uvAt`はEarthの楕円体UVをそのまま共有し、月次map側で別の南北反転や球面補正を追加しない。

### 3.4 Pages fixtureも空入力を生成しない

`tools/earth-surface/stage-pages.mjs`のfixture PNG生成を、manifestのRGBA契約を満たす非一様な
決定的データへ変更する。`tools/earth-surface/test_contract.mjs`の契約fixtureと生成処理で、
空の気候mapを再び作らないよう共通のfixture生成責務へ揃える。

## 4. 実装手順

### 手順1. 気候mapの切替契約を修正する

対象:

- `src/render/cloud/monthly-climate-map.ts`
- `src/render/cloud/monthly-climate-fixture.ts`（新規候補）
- `tests/render/monthly-climate-map.test.ts`

内容:

- 静的DataTextureを使う開発用 `MonthlyClimateTexture` を作る。
- current/nextのTSL参照を月変更・source変更で更新する。
- 旧mapの解放、generationの単調増加、現在月と翌月だけのrequestを維持する。

完了条件:

- 開発用入力が通信なしで雲場へ供給される。
- 月変更後にcurrent/nextの入力が切り替わる。
- source変更後に新しい入力が読み取られ、旧12枚が解放される。

### 手順2. Earthのruntime source選択を修正する

対象:

- `src/game/celestial/solar-system/earth-system.ts`
- `tests/game/earth-system.test.ts`

内容:

- Earthの初期気候mapを開発用fallbackから構築する。
- `ready`以外のbootstrap結果では、placeholder URLへの置換を行わない。
- `ready`時だけmanifest sourceを渡し、同じ楕円体UV、UTC月時計、雲場generationを維持する。
- dispose前の非同期runtime完了、source切替後の雲場再焼成を回帰対象にする。

完了条件:

- manifestなし・取得失敗・GPU非対応でも不透明な雲が空入力にならない。
- 有効なmanifestでは12枚の実気候mapへ切り替わる。
- Earth systemが配信URLやPNG形式の判断を持ち込まない。

### 手順3. Pages fixtureを修正する

対象:

- `tools/earth-surface/stage-pages.mjs`
- `tools/earth-surface/test_contract.mjs`
- `tools/earth-surface/test_pages_layout.mjs`

内容:

- 12枚のfixture PNGを、温度・雲量・標高・陸地被覆率のRGBA契約に沿う決定的なデータへする。
- G/Aについて、全画素同値・全雲量0・全陸域という退行を検出する検査を追加する。
- manifestの寸法、channel、cache policy、相対URLの契約は変更しない。

完了条件:

- Pagesへ配置されるfixtureでも、雲量0のために不透明な雲が全消失しない。
- `earth-surface:check` とPages layout検査が通る。

### 手順4. 回帰検証と実機確認を行う

コード検証:

- `npm run typecheck`
- `npm run test:render`
- `npm run test:game`
- `npm run earth-surface:test`
- `npm run earth-surface:pages-test`
- `git diff --check`

表示検証:

- manifestなしのfallbackで、不透明雲・晴天域・地表が同時に見えること。
- 有効manifestでfixtureから実気候mapへ切り替わること。
- 月境界、日付変更線、極、楕円体の南北で雲の位置が跳ばないこと。
- 雲を無効にしたときは従来どおり不透明雲と雲影が消えること。
- 実ブラウザでの確認を行う場合は、既存の `cloud-lab` またはゲームの描画経路を使い、
  fallback・source切替後のスクリーンショットを比較する。

## 5. リスクと扱い

| リスク | 扱い |
| --- | --- |
| fallback生成をEarth systemへ直接書いて配線層が肥大する | 気候map側の責務へ置き、Earth systemはfactory接続だけにする |
| 月変更でTSLノードが古い画像を参照し続ける | current/nextの安定ノードを使い、月変更とsource変更で値を更新する |
| 実map切替直後に空テクスチャを焼く | current/nextの公開世代を確認し、準備中はfallbackを保持する |
| fixtureを実データと誤認する | fixture検証と実ERA5のデータゲートを分離して報告する |
| 現在の雲体積実装まで修正範囲が広がる | 入力供給、generation、source切替に限定し、rendererの形状式は変更しない |

## 6. スコープ外

- 実ERA5/BMNG/ETOPO/GSHHGデータの取得・全世界bundle生成。
- 雲の密度モデル、体積レイマーチ、LOD、法線、雲影の品質調整。
- `DEVELOP/SPEC/RENDERING.md`の仕様変更。
- 現在の作業ツリーにある `.earth-surface/verification/preflight-latest.json` と、既存のmemo差分。

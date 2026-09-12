# 雲・気候モデルと描画経路の分離リファクタリング計画

作成日: 2026-09-11
計画の基準コミット: `dc6e0c75`

## 目的

雲の気候入力、気象・雲場生成、雲場のGPU焼き込み、地表の不透明雲、大気雲、雲影を、責務ごとに分離する。
雲の形状、光学、LOD、表示設定、GPU資源の所有権、画面上の結果は変更しない。

現在の実装を単純にCPUモデルへ置き換える計画ではない。`WeatherModel`や`CloudField`がThree.js/TSLで生成する
GPUグラフは、気象・雲場生成経路として残す。分離対象は「どの気候入力を受け、どの雲場を生成し、どの描画表現が
それを読むか」という契約と所有権である。

## 現行コードでの進捗（2026-09-12）

月次気候fallback、source切替、current/next世代管理、`GeneratedCloudField`による一部のGPU資源所有は
実装済み。一方、CPU-onlyの気候契約、共通`CloudRenderInput`、表面・大気・影のSampler共有、
cloud-labとrendererの境界整理は未実装であり、この計画は継続する。

残タスクの優先順位は[残タスク一覧](./remaining-tasks_2026-09-12.md)を参照する。

## 決めたこと

- `src/render/cloud/`内のコードは、GPU/TSLへ変換された雲生成・サンプリング・光学処理と、気候入力のGPU adapterを置く場所にする。
- Three.js/TSLへ依存しない気候データ契約は`src/physics/climate/`へ置き、`src/render/cloud/`へ置かない。
- 気候の時刻、RGBA契約、月境界、気候manifestの意味は、GPUテクスチャ実装から独立したデータ契約として定義する。
- `GeneratedCloudField`だけが雲場GPUテクスチャと、それが所有する気候テクスチャを解放する。
- `CloudFieldSampler`、`CloudShapeEvaluator`、`cloud-optics.ts`の共有契約は維持し、表面・大気・影が別々の雲形状式を再実装しない。
- `CloudPresentation`は天体側の寿命・可視性・LOD・焼き込みをまとめるが、大気積分や影の光路計算を実装しない。
- `AtmosphereIntegrator`は大気積分を所有し、雲の殻交差・雲イベント・雲光学の実装を独占しない。
- `CloudAtmosphereRenderer`と`CloudShadowRenderer`は、天体側の具象クラスを読まず、共通の読み取り専用cloud inputを受ける。
- 視覚挙動、既存の雲ON/OFF、cirrus、translucent cumulus、雲影、LOD選択、雲時刻、生成世代、GPU dispose順序を変えない。
- `DEVELOP/SPEC/` は更新しない。視覚仕様や雲モデルを変える判断が必要になった場合は別作業にする。

## 達成目標

- 気候データの数値契約、月時計、RGBA復号がThree.jsのテクスチャ所有から独立してテストできる。
- `GeneratedCloudField`が気候入力と雲場生成の寿命を所有し、`CloudPresentation`、`OpaqueCloudSurfaceRenderer`、`CloudAtmosphereRenderer`、`CloudShadowRenderer`が雲場を解放しない。
- 表面、大気、影が同じ`CloudFieldSampler`と`CloudShapeEvaluator`を使用する。
- `PointCelestialView`、`CelestialView`、`CelestialSystem`が雲表現内部のTSL式を直接組み立てない。
- `AtmosphereIntegrator`に気候入力、WeatherModel、雲場焼き込みの責務が入らない。
- 雲場、気候テクスチャ、雲表現の入力時刻が同じ表示時刻から決まり、表面・大気・影で世代がずれない。
- `npm run typecheck`、`npm run test:render`、雲と天体接続を触った場合の`npm run test:game`が通る。
- `npm run cloud-lab:shot`と`npm run render-lab:shot`で、雲の主要表示ケースを比較できる。

## 手順

### 1. 気候データ契約とGPU気候入力を分離する

#### 目的

月、温度、雲量、標高、陸地被覆率、気候テクスチャの世代という意味を、Three.js/TSLのテクスチャ実装から分離する。
GPU側のサンプリング結果は変えず、CPU側の契約とGPU側のadapterを個別に検査できる状態にする。

#### 変更が必要な箇所

| ファイル | 変更内容 |
| --- | --- |
| `src/render/cloud/climate-map.ts` | GPUテクスチャから気候値を読むadapterだけを保持する。 |
| `src/render/cloud/monthly-climate-map.ts` | 月選択、current/next、generation、GPU texture nodeを管理するadapterにする。 |
| `src/render/cloud/monthly-climate-clock.ts` | 月時計の実装を`src/physics/climate/climate-data.ts`へ移し、GPU層から除去する。 |
| `src/render/cloud/monthly-climate-fixture.ts` | 開発用気候fixtureの生成をGPU気候adapterへ接続する。 |
| `src/game/celestial/solar-system/earth-surface-source.ts` | 12枚の気候URL、encoding範囲、入力manifestの意味を提供する。 |
| `src/game/celestial/solar-system/earth-system.ts` | 気候の意味とGPU texture実装を直接混ぜず、気候入力factoryまたはadapterへ渡す。 |
| `src/physics/climate/climate-data.ts`（新規） | 気候範囲、RGBA復号、月時計入力、月番号正規化をThree.jsなしで定義する。 |
| `src/render/cloud/climate-texture-source.ts`（新規） | Three.js texture、DeferredTexture、current/next textureのGPU寿命を所有する。 |
| `tests/render/monthly-climate-clock.test.ts` | `tests/physics/climate-data.test.ts`へ移し、GPUテストから外す。 |
| `tests/render/monthly-climate-map.test.ts` | RGBA復号とGPU texture generationのテストを分離する。 |
| `tests/physics/climate-data.test.ts`（新規） | 12か月の周回、月境界、範囲、非有限時刻、RGBA復号をCPUだけで検証する。 |

#### 実装方法

- `MonthlyClimateRgba`、encoding範囲、`decodeMonthlyClimateRgba`、`mixMonthlyClimateRgba`、月番号正規化を純粋な契約へ移す。
- `ClimateMapLike`を、Three.jsなしの気候データ契約と`VecNode`を返すGPUサンプラー契約へ分ける。
- `MonthlyClimateMap`はGPU側adapterとして、texture nodeとDeferredTextureを管理する。
- 気候テクスチャの`dispose`はGPUadapterの所有物とし、WeatherModelやCloudPresentationから呼び出さない。

#### 達成条件と検証

- `src/physics/climate/climate-data.ts`が`three`、`three/tsl`、`WebGPURenderer`をimportしない。
- `npm run typecheck`、`npm run test:physics`、`npm run test:render`、`npm run test:game`を通す。
- 月初、月末、12月から1月への周回、DeferredTextureのgeneration更新が既存結果と一致する。

### 2. 雲場生成、焼き込み、サンプリングの所有権を固定する

#### 目的

気象グラフから雲場を生成する経路と、GPU上の雲場を読む経路を分け、生成の再実行条件とテクスチャ寿命を一つにする。

#### 変更が必要な箇所

| ファイル | 変更内容 |
| --- | --- |
| `src/render/cloud/weather-model.ts` | 気候入力から気象グラフを作る責務だけを保持する。表面・大気・影の描画判断を入れない。 |
| `src/render/cloud/condensation.ts` | WeatherSampleからCloudSampleへ変換する共有変換として保持する。 |
| `src/render/cloud/cloud-field.ts` | WeatherModelのGPU出力をBakedFieldへ焼く責務を保持する。 |
| `src/render/cloud/generated-cloud-field.ts` | climate request、generation、時刻同期、bake、GPU資源解放を所有する。 |
| `src/render/cloud/baked-field.ts` | RenderTarget、mipmap、GPU passの寿命だけを所有する。 |
| `src/render/cloud/cloud-field-sampler.ts` | textureの借用読み取り、UV、LOD、CloudSample復号だけを所有する。 |
| `src/render/cloud/cloud-field-sample.ts` | R/G/Bの意味とGPU復号契約を保持する。 |
| `src/render/cloud/field-projection.ts` | 気候・雲場で共有する方向→UVの契約を保持する。 |
| `src/render/cloud/generated-cloud-field.ts` | climate generation、display time、bake generationのキャッシュキーを全入力込みで管理する。 |
| `tests/render/cloud-mip-contract.test.ts` | 実在mip範囲とgeneration無効化を固定する。 |
| `tests/render/cloud-field-sampler.test.ts` | samplerがtextureを解放しないこととUV/LODを固定する。 |
| `tests/render/cloud-field-generation.test.ts`（新規） | 同じ入力で再焼成しないこと、気候generation・時刻変更で再焼成することを検証する。 |

#### 実装方法

- `CloudFieldSampler`のtextureは借用扱いにし、`dispose` APIを追加しない。
- `GeneratedCloudField`が`ClimateTextureSource`と`BakedField`を所有し、`CloudFieldSampler`を公開する。
- bakeの無効化条件に、表示時刻、気候generation、投影、field設定など結果へ影響する入力を含める。
- `CloudSample`のチャンネル意味を一つの契約に固定し、表面・大気・影で別の復号を実装しない。

#### 達成条件と検証

- `GeneratedCloudField`以外の雲表現rendererが`BakedField.dispose()`または気候textureの`dispose()`を呼ばない。
- `rg -n "cloudField.*dispose|field.*dispose|texture.*dispose" src/render/cloud src/render/pipeline`で所有者以外の解放を確認する。
- `npm run typecheck`、`npm run test:render`を通す。
- 雲場の再焼成回数とGPU時間を`npm run cloud-lab:compare`または既存のcloud sampling計測で比較する。

### 3. 雲表現ごとの入力と寿命を分離する

#### 目的

地表上の不透明雲、大気雲、雲影が、同じ雲場を異なるGPU式で読む構造を保ちながら、天体側の雲寿命・可視性・LOD判断から独立する。

#### 変更が必要な箇所

| ファイル | 変更内容 |
| --- | --- |
| `src/render/cloud/cloud-presentation.ts` | CloudFieldRuntimeの寿命、表面表示、LOD、雲入力snapshotの提供を分ける。 |
| `src/render/opaque-cloud-surface-renderer.ts` | 不透明雲メッシュ、LOD、depth、normal、表面専用materialだけを所有する。 |
| `src/render/pipeline/cloud-atmosphere-renderer.ts` | 大気雲のspecies、shell、散乱とCloudFieldSampler入力だけを所有する。 |
| `src/render/pipeline/atmosphere-cloud-layers.ts` | 大気雲イベントの並べ替え、transmittance、radiance合成だけを所有する。 |
| `src/render/pipeline/atmosphere-integrator.ts` | 大気密度、Rayleigh/Mie、airglow、Blue Noiseの積分を所有する。 |
| `src/render/pipeline/shadow/cloud-shadow-renderer.ts` | 恒星光路の雲影透過率だけを所有する。 |
| `src/render/pipeline/shadow/shadow-pass.ts` | shadow casterの選定とGPU pass配線だけを所有する。 |
| `src/game/celestial/celestial-entity/point-celestial-view.ts` | CloudPresentationの内部を操作せず、cloud inputと表示設定を接続する。 |
| `src/game/celestial/celestial-entity/celestial-view.ts` | 大気雲・影へ渡す読み取り専用入力を作る。 |
| `src/game/celestial/celestial-illumination.ts` | CloudShadowRendererの内部ではなく、cloud shadow inputを渡す。 |
| `src/render/cloud/cloud-render-input.ts`（新規） | field、body transform、radius、top altitude、時刻、visibilityを読み取り専用で表す。 |
| `src/render/cloud/cloud-field-runtime.ts`（新規） | GeneratedCloudFieldの生成・時刻同期・bake・破棄を所有する。 |
| `tests/render/cloud-presentation.test.ts`（新規） | 表面・大気・影が同じcloud inputを読むこと、rendererが資源を解放しないことを検証する。 |

#### 実装方法

- `CloudPresentation`から雲場生成runtimeと表面rendererの状態を分ける。
- `CloudRenderInput`はmutableな`CloudPresentation`そのものではなく、同じフレームの値をコピーまたは読み取り専用で渡す。
- 不透明表面、大気、影は同じfield texture、same body transform、same top altitude、same CloudShapeEvaluator契約を読む。
- `CloudPresentation`はrenderer固有のTSL式を持たず、天体の表示状態とruntimeの寿命を接続する。

#### 達成条件と検証

- `CloudAtmosphereRenderer`、`CloudShadowRenderer`、`OpaqueCloudSurfaceRenderer`が`CloudPresentation`をimportしない。
- `PointCelestialView`と`CelestialView`に雲のTSL式が残らない。
- 雲場textureの解放箇所が`GeneratedCloudField`または`CloudFieldRuntime`の1系統だけになる。
- `npm run typecheck`、`npm run test:render`、`npm run test:game`を通す。

### 4. 大気積分、雲大気、雲影の共通契約を検証する

#### 目的

雲の形状、光学、UV、LOD、イベント順序が表面・大気・影でずれないことを、GPU実装の読み合わせではなくテストと検索で保証する。

#### 変更が必要な箇所

| ファイル | 変更内容 |
| --- | --- |
| `src/render/cloud/cloud-shape-evaluator.ts` | coverage、cloud top、grain、opaque fractionの共有式を所有する。 |
| `src/render/cloud/cloud-optics.ts` | CPU側の光学契約を所有する。 |
| `src/render/cloud/cloud-optics-node.ts` | CPU契約をTSLへ写すadapterに限定する。 |
| `src/render/cloud/cumulus-shape.ts` | 共有する雲定数と表示用のパラメータを概念所有者へ整理する。 |
| `src/render/pipeline/atmosphere-cloud-layers.ts` | 雲イベントの近い順、背景透過、front-to-back合成を固定する。 |
| `src/render/pipeline/atmosphere-integrator.ts` | 雲式を直接持たず、AtmosphereCloudLayersへ委譲する。 |
| `src/render/pipeline/shadow/cloud-shadow-renderer.ts` | CloudShapeEvaluatorとCloudFieldSamplerだけから雲形状を読む。 |
| `tests/render/cloud-optics.test.ts` | Beer-Lambert、入口/出口、接線、非交差、species順序を固定する。 |
| `tests/render/cloud-shape-consistency.test.ts`（新規） | 同じCloudSampleに対する表面・大気・影の共有式を検証する。 |

#### 実装方法

- CPU契約とTSL adapterを同じ入力名・単位・範囲で対応させる。
- 雲の`R=coverage`、`G=cloudTop`、`B=translucent`の意味を一つのテストfixtureから供給する。
- 雲の入口・出口、背景大気透過、雲透過、放射輝度の適用回数をテストで固定する。
- 既存のLOD、6タップ雲影、表面の詳細度、Blue Noiseの適用範囲を変更しない。

#### 達成条件と検証

- `rg -n "cloudSampleFromTexel|columnOpticalDepthFromCoverage|CLOUD_TOP_SPAN|CUMULUS_GRAIN_SIZE" src/render`で、雲形状の独自重複実装がないことを確認する。
- `npm run typecheck`、`npm run test:render`を通す。
- `npm run cloud-lab:shot`で雲ON/OFF、cirrus、translucent cumulus、cloud shadowの組み合わせを撮影する。
- `npm run render-lab:shot`でEarth正面、斜視、リム、昼夜境界、雲層内視点を比較する。

### 5. 天体システムとrender-labの接続を整理する

#### 目的

天体システムが雲表現の内部クラスを組み立てず、雲runtimeとcloud inputを明示的に渡す接続へ変更する。render-labが本番経路と異なる雲場・光学契約を持たないようにする。

#### 変更が必要な箇所

| ファイル | 変更内容 |
| --- | --- |
| `src/game/celestial/solar-system/earth-system.ts` | 雲生成factory、気候入力、表示時刻の接続だけを担当する。WeatherModelの内部を直接操作しない。 |
| `src/game/celestial/celestial-entity/point-celestial-view.ts` | cloud runtimeとcloud inputの接続を担当する。 |
| `src/game/celestial/celestial-entity/celestial-entity.ts` | 雲表現の内部型ではなく、天体表示の公開契約を保持する。 |
| `src/game/celestial/celestial-system.ts` | 雲の焼き込み、影候補、大気候補を同じ表示時刻で同期する。 |
| `src/game/celestial/celestial-illumination.ts` | 雲影候補をcloud inputから組み立てる。 |
| `tools/cloud-lab/main.ts` | 本番と同じClimateData、CloudFieldRuntime、CloudRenderInputを使う。 |
| `tools/render-lab/main.ts` | 本番と同じCloudShapeEvaluator、AtmosphereCloudLayers、CloudShadowRendererを使う。 |
| `tests/game/earth-system.test.ts` | 雲なし天体、気候未ロード、表示時刻変更、破棄を検証する。 |
| `tests/render/cloud-lab-contract.test.ts`（新規） | labが本番のcloud input契約を使うことを検証する。 |

#### 実装方法

- 雲なし天体は`null`で表し、空のGPUテクスチャをゲーム層で代用しない。
- 気候未ロード時は既存のfallbackとgeneration契約を維持する。
- `displayTime`、climate epoch、monthly climate generation、bake generationの対応を1つの接続関数で管理する。
- render-labの調整値は本番の表示設定に変換し、lab固有の雲形状式を追加しない。

#### 達成条件と検証

- `src/game/celestial`から`WeatherModel`、`CloudShapeEvaluator`、`CloudFieldSampler`の内部実装を直接importしない。
- `tools/cloud-lab`と`tools/render-lab`が本番と同じcloud input契約を使う。
- `npm run typecheck`、`npm run test:game`、`npm run test:render`を通す。
- `npm run cloud-lab:shot`と`npm run render-lab:shot`の主要ケースが同じ雲場・時刻・LODを使用する。

### 6. 旧責務、旧API、重複式を削除する

#### 目的

分離後も残りうる旧adapter、別名だけのwrapper、重複したUV・coverage・cloud top・optics式を削除し、雲の所有権を一意にする。

#### 変更が必要な箇所

| ファイルまたは検索対象 | 変更内容 |
| --- | --- |
| `src/render/cloud/` | 旧ClimateMapLike、旧runtime、重複sampler、旧cloud inputを削除または責務に合う名前へ統合する。 |
| `src/render/pipeline/` | AtmosphereIntegrator、CloudAtmosphereRenderer、CloudShadowRendererに旧雲式が残っていないことを確認する。 |
| `src/render/opaque-cloud-surface-renderer.ts` | 旧CloudPresentation直接参照、重複field decode、旧dispose経路を削除する。 |
| `src/game/celestial/` | 雲表現内部のlegacy APIと旧命名を削除する。 |
| `tests/render/`、`tests/game/` | 旧APIを呼ぶテストを新契約へ移す。 |
| `tools/cloud-lab/`、`tools/render-lab/` | 旧調整項目、旧ケース名、旧経路を削除する。 |

#### 達成条件と検証

- 旧クラス名・旧API名・旧importが`src`、`tests`、`tools`に残らない。
- `GeneratedCloudField`または`CloudFieldRuntime`以外が雲場GPU資源を解放しない。
- `npm run typecheck`、`npm run test:render`、`npm run test:game`を通す。
- `git diff --check`が成功する。

## 見積り

見積りは、契約、GPU寿命、renderer接続、GPU回帰の作業単位から算出した概算であり、実装後に実測へ置き換える。

| 作業 | 導出式 | 概算 |
| --- | --- | ---: |
| 気候データ契約 | 4入力契約 × 1時間 + CPUテスト3時間 | 7時間 |
| 雲場生成・寿命 | 6生成モジュール × 1時間 + GPU世代検証4時間 | 10時間 |
| 表面・大気・影の入力分離 | 3renderer × 2時間 + 天体接続4時間 | 10時間 |
| 光学・shape契約 | 4共有式 × 1時間 + GPU/CPU回帰4時間 | 8時間 |
| 天体・lab接続 | 3接続経路 × 1.5時間 + 画像撮影3時間 | 7.5時間 |
| 旧API削除・最終検証 | 3検索領域 × 1時間 + type/render/game検証4時間 | 7時間 |
| 合計 | 7 + 10 + 10 + 8 + 7.5 + 7 | 49.5時間 |

## リスクと落とし穴

| リスク | 影響 | 露見する場所 | 対策 |
| --- | --- | --- | --- |
| ClimateDataを純粋化する過程でGPUの線形補間結果が変わる | 雲量、標高、陸地境界が変わる | climate test、雲画像 | RGBAを先に補間して復号する既存契約を固定する |
| 気候generationをcache keyから落とす | 新しい気候テクスチャが古い雲場を使う | GeneratedCloudFieldの世代テスト | 時刻、気候generation、field設定を全てkeyへ含める |
| rendererが雲場を解放する | 大気または影の後続フレームでGPUエラーになる | dispose順序、再出撃、cloud-lab | GeneratedCloudFieldだけにdisposeを許す |
| 表面・大気・影でbody transformが異なる | 雲のシルエットと影がずれる | Earth斜視、リム、昼夜境界 | `CloudRenderInput`を同じフレームに生成し、mutable objectを共有しない |
| 大気積分の合成順が変わる | 雲が二重に暗くなる、背景が黒くなる | `cloud-optics.test.ts`、画像比較 | 入口/出口、背景透過、cloud transmittanceの適用回数を固定する |
| TSL生成をCPUモデルへ置き換える | GPU負荷、画質、時刻応答が変わる | render-lab | 本計画ではGPUグラフを維持し、契約と所有権だけを分ける |
| render-labだけ別の雲式を持つ | 本番と検証画像が一致しない | lab contract test | 本番のcloud inputとshape/opticsを直接使用する |
| 既存の地球表面作業と接続が競合する | 雲と地表の差分が混ざり、原因追跡できない | `git diff`、Earth screenshot | 雲の変更ファイルと地表変更ファイルをコミットで分離する |

## レビューで追加したタスク

計画の自己レビューで、気候モデルをCPUへ移すだけの計画になると、物理・画質・GPU負荷の仕様変更を引き起こすことが分かった。そのため、次の制約を追加する。

- `WeatherModel`、`CloudField`、`GeneratedCloudField`はGPU/TSLの生成経路として維持する。
- CPUへ移す対象は月時計、RGBA復号、範囲検証、generation判定など副作用のないデータ契約に限定する。
- `CloudRenderInput`をmutableな状態バッグにせず、表面・大気・影が必要とする読み取り専用入力だけにする。
- 雲場のtexture所有権をテストで検証し、rendererの`dispose`追加を禁止する。
- 雲なし天体、気候未ロード、月境界、天体切替、LOD切替、Game.disposeの6ケースを最終スモークに追加する。

この追加により、責務分離を目的としたリファクタリングが、気象モデルや画質を意図せず変更することを防ぐ。

# 雲の時間LOD・ベイク制限廃止 実装計画

- 状態: 着手前
- 作成日: 2026-09-21
- 対象: 生成雲の時間評価、雲場ベイク、ゲーム本体・render-lab・cloud-lab

## 目的

生成雲が時間加速の大きさによって別の時間LODへ切り替わったり、表示時刻から外れた target 時刻へ丸められたり、実時間あたりのベイク回数によって古い雲場を保持したりする経路を廃止する。生成雲は表示時刻そのものから評価し、雲場が描画に寄与する要求では、入力が変わった時点でその時刻の場を準備する。

## 決めたこと

- 「時間LOD」は `temporal-lod.ts` の normal / intermediate / extreme、target 時刻の丸め、時間幅に応じた lifecycle / 日周期の重み、時間帯域制限用の補助関数を指す。これらを削除する。
- 「ベイク制限」は極端な時間加速の `maxBakesPerRealSecond` と、品質段階の `maxFieldUpdatesPerSecond` の両方を指す。どちらも削除する。
- `displayTime`・気候世代・投影版が前回と同じ場合の再利用は残す。これはベイク回数を実時間で制限するものではなく、同一入力を同一フレーム内で再計算しないための入力キャッシュである。
- 雲の空間的な詳細度（雲殻の見かけサイズ、積雲の立体詳細、場の投影解像度）と、雲の GPU 計測・性能 qualification は変更対象にしない。
- `nowMs` は雲場の準備契約から外す。雲場の時間入力は `displayTime` だけとし、HUD やカメラなど他の実時間処理の契約は変更しない。

## 変えない挙動

仕様にある次の挙動は保存する。

- 同じ表示時刻を再評価した生成雲は決定的である。
- 雲面、大気内雲、雲影は同じ表示時刻の同じ雲場を参照する。
- 雲は時刻とともに流れ、生まれ、消え、気候・気圧・風・地形・低気圧などの連続した雲モデルから決まる。
- 生成／実写の雲分布、巻雲・半透明積雲・積雲の影の表示設定、積雲の空間的な精細さは維持する。
- 雲の GPU ベイク計測行と、no-cloud baseline から cloud budget を算出する性能 qualification の意味は維持する。

仕様から削除する挙動は次のとおり。

- 時間加速の時間幅によって雲セル・メソスケール・weather object の詳細度を下げること。
- 中間・極端な時間加速で日周期を平均化すること、また時間幅で cloud field を low-pass すること。
- 時間加速中に表示時刻を anchor へ丸めること。
- 実時間 1 秒あたりの雲場ベイク回数を上限で抑えること。

## 達成目標

- `src/render/`、`src/game/`、`tools/`、`tests/` から `TemporalLodProfile`、`TemporalLodMode`、`temporalLodFor`、`targetSimulationTime`、`canBakeInWindow`、`maxBakesPerRealSecond`、`maxFieldUpdatesPerSecond`、`averagingWindowSeconds` が 0 件になる。
- 生成雲の `prepare` は `displayTime` をそのまま `WeatherModel.syncTime` と雲状態へ渡し、時間加速倍率・フレーム間隔・壁時計による別経路を持たない。
- 雲場の準備 API とゲーム本体／両ラボの呼び出し元から `nowMs` が外れ、型検査が通る。
- 雲の共通状態から `temporalMode` がなくなり、雲面・大気・雲影の共有入力が絶対時刻・seed・field だけで一致する。
- 時間の小刻みな変更と日単位以上の時刻ジャンプの両方で、要求した表示時刻の場が描画され、古い場の保持がベイク制限によって起きない。
- `npm run typecheck` と `npm run test:render` が通り、cloud-lab の時間サンプルと render-lab の雲ケースを再生成できる。

## 手順

### 手順 1. 描画仕様から時間LODとベイク上限を削除する

#### 目的

コード変更に先行して、生成雲が表示時刻を直接評価し、時間加速に依存する詳細度変更・時間平均・更新上限を持たないことを仕様として確定する。既存の時間LOD要求と新しい要求を同時に残さない。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `DEVELOP/SPEC/RENDERING.md` | 「雲の描画」の時間加速に関する2項目を、時間加速による時間LOD・平均化・low-pass・更新上限を要求しない文面へ置き換える。同じ表示時刻の決定性と、雲面・大気内雲・雲影が同一の雲場を読む条件は残す。 |

仕様へ入れる確定内容は、次の意味を満たすものとする。

- 生成雲の時間的な詳細度はシミュレーション時間幅で変わらない。
- 生成雲は表示時刻に対応する雲場を表示し、時間加速でも時刻を別の anchor へ丸めない。
- 同じ表示時刻の再評価は決定的で、雲面・大気内雲・雲影は同じ雲場を共有する。

#### 達成条件と検証

- `DEVELOP/SPEC/RENDERING.md` に旧仕様の「時間加速の表示はシミュレーション時間幅に応じて詳細度を変える」「時間平均された衛星 timelapse」を要求する文が残っていない。
- 新しい仕様文が、表示時刻の直接評価・決定性・3経路の共有を明記している。
- この手順では `src/` と `tools/` を変更しない。

### 手順 2. 雲モデルから時間LODと時間帯域制限を取り除く

#### 目的

雲の時間入力を単一の `displayTime` に戻し、時間LODのためだけに存在する mode・重み・平均化経路を消す。空間的な雲モデルと絶対時刻による自然な雲の lifecycle は残す。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/generated-cloud-field.ts` | `simulationSecondsPerFrame`、temporal profile、target 時刻、壁時計、rate-limit 用状態を削除する。`prepare` は要求された `displayTime` をそのまま使い、気候世代と投影版を含む入力キャッシュだけで再利用を判定する。雲状態の `temporalMode` を削除し、絶対時刻と日単位 seed を表示時刻から作る。 |
| `src/render/cloud/weather-model.ts` | `TemporalLodProfile` の import と `syncTime` の profile 引数を削除する。時間LOD用の cell / weather object / daily / anvil 重みを廃止し、常時評価される雲モデルの式へ戻す。日周期は表示時刻からそのまま評価する。 |
| `src/render/cloud/condensation.ts` | 時間LOD重みを通すためだけの `WeatherSample` の lifecycle weight 参照を削除し、常時評価の basis を直接作る。 |
| `src/render/cloud/cloud-field.ts` | `TemporalLodMode` と時間LOD引数を `stateAt` から外す。 |
| `src/render/cloud/cloud-state.ts` | `CloudState` と `CloudStateBinding` から `temporalMode` を外し、状態構築関数の引数も整理する。 |
| `src/render/cloud/cloud-field-sampler.ts` | 初期 `CloudStateBinding` から `temporalMode` を外す。 |
| `src/render/cloud/observed-cloud-field.ts` | 実写場の固定 state から `temporalMode` を外す。実写場が表示時刻によらず静止する挙動は残す。 |
| `src/render/cloud/cloud-lifecycle.ts` | 時間平均のためだけの `bandLimitLifecycle` を削除する。絶対時刻から lifecycle を決める関数は残す。 |
| `src/render/cloud/cloud-subgrid.ts` | `averagingWindowSeconds` と時間係数を削除し、空間 footprint だけから sub-grid 振幅を求める契約へ整理する。 |
| `src/render/cloud/weather-time.ts` | `simulationSecondsPerFrame` を削除する。日番号・日内秒への分解は日周期と lifecycle が使うため残す。 |
| `src/render/cloud/temporal-lod.ts`（削除） | 時間LOD profile、target 時刻、実時間 bake 判定を担うため、参照をすべて外した後にファイルを削除する。 |

#### 達成条件と検証

- `rg -n --glob '*.ts' '(TemporalLod|temporalLod|temporalMode|targetSimulationTime|canBakeInWindow|averagingWindowSeconds|simulationSecondsPerFrame)' src/render/cloud` が 0 件になる。
- `GeneratedCloudField.prepare` の本体で、`displayTime` 以外のシミュレーション時刻を作る式、壁時計を読む式、更新回数を数える状態が存在しない。
- `WeatherModel.syncTime` に profile 引数がなく、同じ `displayTime` を与えたときに時間LOD用の重みで式が変わらない。
- `CloudStateBinding` の全生成箇所が `absoluteTimeSeconds` と `seed` だけを時刻状態として持つ。
- `npm run typecheck`、`npm run test:render` を実行する。

### 手順 3. ベイク上限と雲準備 API を呼び出し側まで撤去する

#### 目的

極端ワープ上限と品質段階由来の field update 上限を完全に消し、雲場を準備する API から実時間入力を切り離す。キャッシュによる同一入力の再利用と、画面に寄与する雲だけを準備する判定は維持する。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/cloud-quality.ts` | `CloudQualityProfile.maxFieldUpdatesPerSecond` と各品質値の上限を削除する。`CLOUD_QUALITY` に残す spatial quality の語彙と `cloudPerformanceBudget` は、ベイク実行を抑制する機能ではないため維持する。 |
| `src/render/cloud/cloud-presentation.ts` | `CloudFieldSource.prepare`、`CloudPresentation.bake` から `nowMs` を外す。生成雲へ品質由来の `setQuality` を渡す口と関連 import を削除する。 |
| `src/render/cloud/generated-cloud-field.ts` | `CLOUD_QUALITY` の更新上限、`quality`、`setQuality`、実時間窓・ベイク回数の状態を削除する。 |
| `src/render/cloud/observed-cloud-field.ts` | `prepare` の未使用 `_nowMs` を削除する。実写場の世代・投影版キャッシュは維持する。 |
| `src/render/celestial/celestial-entity/celestial-view.ts` | 抽象 `bakeClouds` から `nowMs` を外す。 |
| `src/render/celestial/celestial-entity/point-celestial-view.ts` | 積雲の `bake` 呼び出しから `nowMs` を外す。通常の表示同期で使う `nowMs` は変更しない。 |
| `src/game/celestial/celestial-system.ts` | 雲専用 `bakeClouds` の引数と各天体ビューへの転送から `nowMs` を外す。 |
| `src/game/game-presentation.ts` | 雲ベイクの呼び出しから `nowMs` を外す。その他の HUD・マーカー・カメラ同期へ渡す `nowMs` は残す。 |
| `tools/render-lab/cases.ts` | `LabCase.bakeClouds` と地球ケースの bake wrapper から `nowMs` を外す。 |
| `tools/render-lab/lab.ts` | 雲ベイク専用の仮想 `renderClockMs` と加算処理を削除し、表示時刻だけをケースへ渡す。 |
| `tools/cloud-lab/pane.ts` | `CloudLabPane.bake` から `nowMs` を外す。 |
| `tools/cloud-lab/lab.ts` | 雲ベイク専用の `renderClockMs` と加算処理を削除する。 |

#### 達成条件と検証

- `rg -n --glob '*.ts' --glob '*.mjs' '(maxBakesPerRealSecond|maxFieldUpdatesPerSecond|bakeWindowStartMs|bakeCountInWindow|lastRequestedWallTimeMs|renderClockMs)' src tools tests` が 0 件になる。
- `rg -n --glob '*.ts' '(prepare\([^)]*nowMs|bakeClouds\([^)]*nowMs|bake\([^)]*nowMs)' src tools` で雲専用 API に `nowMs` が残っていない。一般の HUD・カメラ・マーカーの `nowMs` は対象外とする。
- 品質設定を low / standard / high または積雲の粗 / 標準 / 精細へ切り替えても、雲場のベイク頻度を実時間で制限する分岐がない。
- `npm run typecheck`、`npm run test:render` を実行する。

### 手順 4. 回帰テストと補助ツールの時間ケースを新しい契約へ更新する

#### 目的

削除した時間LODを期待するテスト・manifest・視覚レビューを、新しい「表示時刻を直接評価する」契約へ置き換える。古い normal / intermediate / extreme の判定を検証対象に残さない。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `tests/render/temporal-lod.test.ts`（削除） | 廃止した profile・target・rate-limit の回帰テストなので削除する。 |
| `tests/render/weather-time.test.ts` | 削除した `simulationSecondsPerFrame` の import とテストを削除し、日境界・負の時刻・大きな時刻の分解テストを残す。 |
| `tests/render/cloud-model-contracts.test.ts` | `bandLimitLifecycle` の時間平均テストを削除し、`subGridAmplitude` の新しい空間引数へ合わせる。絶対時刻からの lifecycle 決定性テストは残す。 |
| `tests/render/cloud-quality.test.ts` | `maxFieldUpdatesPerSecond` の期待を削除する。空間品質プロファイルの関係と、性能 budget 計算のテストは残す。 |
| `tools/cloud-lab/baseline-manifest.mjs` | `temporalLod: ['normal', 'intermediate', 'extreme']` を削除し、時間LODを qualification 条件にしない manifest へ変更する。必要なら短時間・日単位・最大ワープ相当の表示時刻サンプルを、LOD名ではなく時刻入力として記録する。 |
| `tools/cloud-lab-visual-review.mjs` | normal / intermediate / extreme / max warp の意味づけと、極端速度で low-pass される期待を削除する。短い刻み、数時間ジャンプ、日単位ジャンプ、長い時刻ジャンプを表示時刻サンプルとして撮影し、指定時刻への追従、明滅・古い場の残留・日周期の不連続を人が確認できる manifest/checklist へ改める。 |
| `tools/cloud-lab/cloud-rendering-explainer.html` | `CloudStateBinding` の説明から `temporal mode` を削除し、絶対時刻・seed・field が共有される説明へ更新する。時間LODや low-pass を現在の契約として説明する文を残さない。 |

#### 達成条件と検証

- `rg -n -i --glob '*.ts' --glob '*.mjs' --glob '*.html' '(temporal.?lod|temporal mode|intermediate|extreme|low.?pass|time.?averag)' src tools tests` の結果に、今回廃止する時間LODの説明・検証が残っていない（気象モデルの一般的な時間発展を表す語は個別に判定する）。
- render テストが、時間LODの mode 判定ではなく、絶対時刻の決定性・日境界の安定性・空間 sub-grid 契約を検証している。
- `npm run typecheck`、`npm run test:render` を実行する。

### 手順 5. 実行時の雲場更新を視覚・計測で検証する

#### 目的

大きな表示時刻ジャンプでも、時間LODの平均場やベイク上限による古いテクスチャ保持がなく、雲面・大気内雲・雲影が同じ新しい場を読むことを確認する。計測の仕組み自体は維持し、負荷増加を観測可能にする。

#### 変更が必要な箇所

| ファイル / 出力 | 変更・確認 |
| --- | --- |
| `tools/cloud-lab/visual-review/` | 更新後の visual review 出力を生成する。短時間・数時間・日単位・長時間ジャンプの各 contact sheet で、場の急な全体フラッシュ、古い場の残留、日周期の不連続、雲面と雲影の不一致がないことを確認する。 |
| `tools/render-lab` の雲ケース | 雲を表示する地球、斜視、極、ターミネーターのケースで、時刻を進めた直後の雲面・大気・影の一致を確認する。 |
| デバッグ計測 | 「雲の生成」の GPU 時間が雲場更新の実行時に計測され、低頻度へ抑えるための別 rate limit が存在しないことを確認する。性能 qualification の合否は実測値で判定し、時間LOD廃止の合否と混同しない。 |

#### 達成条件と検証

- `npm run cloud-lab:visual-review` が完走し、manifest の browser fatal event が空で、全時間サンプルの PNG と contact sheet が生成される。
- contact sheet の確認対象は、(1) 1/60 h 刻み、(2) 6 h 前後のジャンプ、(3) 24 h 前後のジャンプ、(4) 6 日超相当のジャンプで、いずれも時間幅に応じて詳細度が落ちたり、古い場が一定時間残ったりしないこと。
- `npm run render-lab:shot` を実行し、地球の雲面、大気内雲、雲影が同じ表示時刻の場から連続して変化することを目視確認する。
- `npm run typecheck`、`npm run test:render` を再実行する。

## 見積り

実測前の作業量見積り。時間は、コード探索・編集・テスト実行を含む 1 人作業の目安である。

| 手順 | 導出 | 見積り |
| --- | --- | ---: |
| 1 | `RENDERING.md` 2項目の仕様更新 + 単独確認 20分 | 20分 |
| 2 | 雲モデル契約 9ファイルの整理 × 10分 + typecheck / render test 20分 | 110分 |
| 3 | runtime 呼び出し側・ラボ契約 10ファイルの整理 × 8分 + typecheck / render test 20分 | 100分 |
| 4 | 回帰テスト 4箇所 + 補助ツール 3箇所 × 10分 + grep確認 20分 | 90分 |
| 5 | cloud-lab visual review 1実行 + render-lab shot 1実行 + contact sheet確認 30分 | 60分 |
| 合計 | 20 + 110 + 100 + 90 + 60 | 約380分（約6時間20分） |

GPU 実行時間は機器・ブラウザ・WebGPU timestamp の有無で変わるため、上記の作業時間には固定値として含めない。視覚検証で不自然な遷移が見つかった場合は、原因調査 30分単位で見積りを更新する。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `displayTime` ではなく旧 target 時刻を一部の state や uniform が使い続ける | 雲面・大気・影のうち一部だけが古い時刻になり、表示時刻ジャンプでずれる | 手順 2、手順 5。`temporalMode` と `targetSimulationTime` の検索、render-lab の雲面／大気／影 |
| `maxFieldUpdatesPerSecond` だけを消し、極端ワープ側の上限を残す | 品質段階やワープ段階によって古い field が保持され、ベイク制限廃止が未達になる | 手順 3。`maxBakesPerRealSecond`、`maxFieldUpdatesPerSecond`、`bakeWindow` の検索 |
| `nowMs` を雲 APIから外す際に、HUD・カメラ・マーカー用の実時間まで外す | 雲と無関係な UI 更新・カメラ遷移が壊れる | 手順 3。雲専用呼び出しの型検査と `npm run test:render` |
| WeatherModel の時間LOD重みを常時1へ置き換える途中で、一部の重みだけ残る | 時刻によって雲量・対流・上層雲が変わり、時間LODを削除したつもりでも別の低域化が残る | 手順 2。`cellWeight`、`weatherObjectWeight`、`dailyCycleWeight`、`anvilLifecycleWeight` の検索と雲テスト |
| `CloudStateBinding` の `temporalMode` だけを消し、説明・manifest・視覚レビューの mode 分岐を残す | 実装と検証の前提が食い違い、廃止した時間LODを再導入する入口が残る | 手順 4。`temporal.?lod`、`intermediate`、`extreme`、`low.?pass` の検索 |
| ベイク頻度が増えて GPU 負荷が急増する | 60fps を満たさなくなる可能性があるが、古い場を表示する隠れた制限で回避してはいけない | 手順 5。GPU の「雲の生成」計測、cloud budget の qualification 結果 |
| 同一入力キャッシュまで削除する | camera / UI の同一フレーム再同期で同じ場を何度も焼き、不要な GPU 負荷が発生する | 手順 2、手順 5。`displayTime`・気候世代・投影版が同じ場合の generation と GPU 計測 |
| 時刻ジャンプ後に field は更新されるが、CloudFieldSampler の binding が更新されない | 雲面・大気・影が新旧テクスチャを混在して読む | 手順 2、手順 5。render-lab の地球・ターミネーター・雲影 |

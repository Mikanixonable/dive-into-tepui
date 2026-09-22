# 気象学的な雲モデルへの改修計画（第一版）

- 状態: 実装レビュー済み（基盤実装・残工程あり）
- 作成日: 2026-09-20
- 改訂日: 2026-09-20（基盤実装・レビュー反映）
- 調査基準: `0114373a7`
- 対象: 地球の生成雲、雲面・大気内雲・雲影、cloud-lab

## 実装状況（2026-09-20）

計画全体を完了扱いにせず、今回の実装で検証できた基盤だけを完了として記録する。残る視覚調整・
weather producer の分離・大気 / 雲面 / 雲影の共通 state 化は、下記の既存 Step を継続する。

- **実装済み:** Step 2 の時間境界。`weather-time` と `temporal-lod` を追加し、normal / intermediate /
  extreme を simulation 時間幅から分類する。`GeneratedCloudField` は target anchor へ直接到達し、
  extreme の bake を実時間 1 秒あたり4回以下へ制限する。ゲーム本体と render-lab / cloud-lab は同じ
  `nowMs` 契約を渡し、導出層が壁時計を直接読まない。
- **実装済み:** Step 3 の低次元 forcing。`WeatherForcingField` は `moisture`、`lift`、
  `organization`、`windPerturbation` の論理 field として `WeatherSample` から凝結へ渡る。追加の
  persistent 512² texture は作らない。平均雲量は最終 coverage へ直接加算せず、stratocumulus などの
  parameterization weight として一度だけ参照する。
- **実装済み:** 性能条件の計算境界。`cloudPerformanceBudget` は `headroom=max(0,F-B0)` と
  `Bcloud=min(0.20F,0.50headroom)` を実装し、headroom 0 または未計測値を `unqualified` とする。
  `cloud-lab:baseline` は代表環境を Apple M4 Pro / Mac16,8 / arm64 + Google Chrome stable / WebGPU
  に固定し、70 / 100 / 400 km と遠景、3 temporal LOD の manifest を出力する。実測B0未取得のmanifestは
  合格扱いにしない。
- **レビュー済み:** forcing を使う凝結と cloud-lab の診断表示を確認し、前線 / 雨帯 / stratocumulus は
  既存の連続関数を維持した。0h / 25h の cloud-lab 画像を生成し、`npm run typecheck`、
  `npm run test:render`、`npm run test:game`、`npm run check:boundaries`、build を通過した。
- **残工程:** Step 1 の実測baseline / GPU timestamp、Step 4〜Step 11 の明示的な Front / Cyclone /
  ITCZ producer、geography / orography、lifecycle / basis / vertical profile / optics、atmosphere /
  surface / shadow の共通 state 接続と6 regimeの視覚調整。Step 12 / 13 は引き続き任意 / Phase 2 とする。

## 目的と優先順位

衛星視点（satellite-view visual fidelity）で見た雲の配置・組織・時間変化を自然にし、通常のノート PC、Apple Silicon、内蔵 GPU
で安定して動く生成雲を作る。科学的に完全な大気モデルを目指すのではなく、見た目を構成する環境
forcing、雲の基底、鉛直 profile、光学量を、実装可能な小さな共通契約へ整理する。

優先順位は次のとおりとする。

1. 70 km 以上の衛星視点で、雲模様・薄い上層雲・層積雲・深い対流・地形効果が自然に見えること。
2. 通常速度から最大 `33,554,432×` の時間倍率まで、停止・急消失・不自然な飛びを避けること。
3. 標準的なノート PC / Apple Silicon / iGPU で、ゲームの描画予算を守ること。
4. 6 つの代表 regime を人間が参照画像と見比べ、安価なデバッグ指標で調整できること。

これは予報用の数値気象モデルではない。観測値や衛星プロダクトは見た目の調整と forward-validation
の参考に使うが、コア完成の条件にはしない。降水量、雷、地表の天候を公開する将来 API はこの計画
には含めない。

## 維持する設計原則

- runtime の雲 field は 512×512 RGBA16F 一枚を上限とし、3D 雲テクスチャは導入しない。
- 512×512 RGBA16F 一枚の容量は約 2 MiB とし、追加の実行時雲 texture をこの上限へ積み増さない。
- 512² field は総観〜メソスケールの envelope、shader の world-space sub-grid はそれより細かい
  形状とエッジを担当する。sub-grid は画面座標の沸騰ノイズにしない。
- sub-grid は高度別風の back-advection と world-space の座標で評価し、カメラ移動で泳がないようにする。
- 低層・中層・上層の風とシアを維持し、雲相・高度帯ごとの水平ずれを共通状態から求める。
- RGBA は雲種 ID や絶対高度ではなく、低次元の連続 basis 係数とする。R→G→B の発達遅延、B の
  anvil 残留、A の in-situ 上層雲を共通 lifecycle へ接続する。
- 温度から液相・混相・氷相の傾向を連続的に求め、相ごとに optical thickness と散乱の傾向を持つ。
- 鉛直 profile と optics を分離し、profile は compact support の安価な piecewise / smoothstep
  で評価する。hot path で高価な `exp`、`pow`、三角関数を増やさない。
- 雲面・大気内雲・雲影は同じ雲の基本状態、basis、profile、optics を参照する。ただし各 render path
  の積分器、サンプル密度、早期終了は目的に応じて異なってよい。
- 大気内雲はまず atmosphere の鉛直 slice として作り、surface は累積 optical depth、shadow は
  effective layer で同じ状態を使う。
- runtime の採用値と、観測・調整用の calibration metadata を分離する。
- 球面 transport は一回の近似的な球面変位を基本とし、render path へ反復流体 solver を持ち込まない。

## 決めたこと

### 時間と最大時間倍率

厳密なフレーム列一致や評価経路に依存しない完全一致を hard requirement にしない。絶対時刻は、
時間倍率・フレーム刻み・日境界で数値が破綻しないための正規化と、安価な procedural seed の入力に
使う。合否は同じ時刻の bit 単位比較ではなく、時間 LOD ごとに定義した見た目の連続性と時間平均の自然さで判定する。

最大倍率は `33,554,432×` とする。60 fps では約 6.47 日 / frame になるため、30 分単位の雲セルを
忠実に replay することは目標にしない。現在時刻へ直接到達し、未解像の高周波は帯域制限または平均化
して、衛星 timelapse として自然な粗い変化を出す。

| 時間 LOD | 1 frame あたりの simulation 時間 | 生成方針 | bake 更新上限 |
| --- | ---: | --- | ---: |
| normal | `≤ 10 min` | cell / meso / weather object を通常評価し、位置と identity の連続性を維持 | 採用 anchor は最大 1 回 / frame |
| intermediate | `>10 min〜6 h` | mesoscale / synoptic structure を中心に表示し、高周波 cell と object 更新を集約 | 最大 1 回 / frame |
| extreme | `>6 h` | 短寿命現象と個々の weather object identity を捨て、simulation 時間幅で平均・low-pass した cloud field を表示 | 最大 4 field updates / 実時間 1 秒 |

- 時間 LOD は simulation 秒 / 実時間 frame から選ぶ。表示時刻や表示速度を大きくずらして帳尻を
  合わせない。
- `CloudBakeAnchor` は必要なら 10 simulation 分の量子化に使うが、anchor を毎 frame 追い掛ける
  catch-up bake はしない。現在の target anchor を直接要求し、間にある anchor は捨てる。
- anchor 間は保持中の field、world-space transport、lifecycle の集約係数を再利用する。時刻ジャンプ
  後に大量の bake を連続実行しない。
- normal では cell、mesoscale、weather object の位置と identity の連続性を維持する。intermediate では
  mesoscale / synoptic structure を優先し、短寿命 cell や object identity の保持を hard gate にしない。
- intermediate / extreme では日周期を simulation 時間幅に応じて平均・low-pass し、日周境界を aliasing させない。
  extreme / max warp では個々の前線・低気圧・雲セルの位置連続性を要求せず、全体が flash、急消失、周期的な
  点滅をせず、時間平均された衛星 timelapse として自然になることを目標とする。
- 正常系の bake 回数、極端な倍率での bake 回数・spike・帯域を測る。表示時刻と simulation 時刻を大きくずらして
  帳尻を合わせず、target 時間幅に対応する平均 field を直接評価する。
- procedural seed は絶対時刻から安価に導出する。numeric bug の回帰として日境界、浮動小数点の
  大きな値、日付変更線、極付近を検査するが、異なる再生経路の完全一致は検査しない。

### カレンダーと固定気候

- カレンダーの月・年・周期を雲の気象 forcing に直接使わない。
- runtime は、代表的な基準気候、緯度、陸海、地形、静的 climate zone から分布を作る。
- 絶対時刻は seed、lifecycle、日周期の入力には使えるが、月単位の環境遷移や年境界で cloud field を
  切り替えない。日周期は normal でのみ通常評価し、intermediate / extreme では時間幅に応じて平均する。
- 既存の `AnnualClimateMap` が持つ温度、平均雲量、標高、陸地率、斜度を低解像度の入力として再利用し、
  必要な geographic forcing は bake する。ray ごとに地理データを再構築しない。

### 共通 forcing と weather object

Front、Cyclone、ITCZ は残す。ただし白い雲や最終 alpha を直接描かず、低次元の
`WeatherForcingField` を供給する dynamic anomaly producer とする。初期 MVP の driver は
`moisture`、`lift`、`organization`、`windPerturbation` の 3〜4 個へまとめる。

convergence / divergence と orographic effect はまず `lift`、vorticity・stability・convective activity は
まず `organization` へ寄与させる。画面上の必要性が確認できた場合だけ専用 driver へ分離する。
`WeatherForcingField` は論理的な field であり、追加の persistent 512² texture を必須にしない。

各 producer の forcing を合成した後、共通の lifecycle、RGBA basis、sub-grid、鉛直 profile、optics
を通して最終の雲を作る。regime ごとの parameterization は許すが、描画経路を分断する別モデルや
統一流体 solver は作らない。

### regime-specific parameterization の連続 blend

trade cumulus、marine stratocumulus、temperate frontal cloud、deep convection / MCS、upper cirrus は
排他的な雲種分類ではなく、environment と forcing から得る連続 weight で parameterization を blend する。
`if regime === front` のような切替を基本経路にせず、前線の端を通常雲へ滑らかにつなぐ。MCS の周辺に
通常の巻雲や別の basis が共存できるよう、producer、lifecycle、basis、profile、optics を共有する。

### 視覚調整用の初期 fixture

次の値は物理的な真値や全域共通の寿命ではなく、最初の screen tuning と回帰 fixture を作るための
出発点とする。採用済み runtime 値、調整範囲、reference 画像の根拠は `CloudModelParameters` と
`tools/cloud-lab/` 側の metadata へ分離し、これらを weather object の型へ直接埋め込まない。

| 対象 | 初期 fixture | 調整時の扱い |
| --- | --- | --- |
| meso organization | 12 h | 4〜24 h の範囲を regime 別に調整 |
| cloud cell | 60 min | 30〜180 min。marine stratocumulus は長め、deep convection は短め |
| sub-grid detail | 30 min | 15〜45 min。高倍率では時間方向に band-limit |
| anvil residual | 6 h | 4〜10 h。convective core と同じ寿命にはしない |
| basis delay | R→G 10 min、G→B 20 min | それぞれ 5〜20 min、10〜30 min |
| tropopause | 極域 8 km / 中緯度 12 km / 熱帯 17 km | 緯度で連続補間、上端は 20 km |
| wind height anchor | 1.4 / 5.5 / 10.5 km | 850 / 500 / 250 hPa は reference label のみ |
| wind speed | low 5 / mid 10 / upper 25 m/s | low 3〜10、mid 5〜15、upper 10〜30 m/s。jet は必要時のみ診断 |
| phase tendency | 0 / -10 / -30 / -40 °C | hard branch にせず smoothstep で接続 |
| lapse rate | 環境 6.5 K/km | deep convection の内部だけ 4〜5 K/km の補正を許す |
| optics | `tauScaleLiquid=15`、`tauScaleIce=1` の neutral fixture | `tauScale`、phase scattering / asymmetry、opaque threshold を見た目で調整 |

これらの fixture は Step 6〜Step 11 の比較入力にするが、scientific calibration の合否条件や公開 API の
状態にはしない。疑似 LWP、実効粒径、詳細な粒径分布は debug / sanity 出力に限定する。

### climatology と dynamic weather

geographic / climate field は「現象が起きやすい場所」を表す static / slowly varying prior とし、
Front、Cyclone、ITCZ などは「現在そこに存在する現象」の dynamic anomaly として扱う。

- storm track は Cyclone 発生 prior、marine stratocumulus zone は stratocumulus parameterization の重み、
  ITCZ climatology は ITCZ producer の位置・強度 prior とする。
- terrain は現在の wind と組み合わせて orographic forcing を作る。地形だけで常時同じ雲を加えない。
- `AnnualClimateMap.meanCloudiness` を最終 cloud coverage へ直接加算せず、prior / parameterization weight として
  一度だけ使う。dynamic weather と平均雲量を二重計上しない。

### 地理・地形

- 緯度循環、ITCZ、亜熱帯高圧帯、中緯度低気圧・storm track、陸海分布、海洋層積雲域を静的または
  ゆっくり変化する forcing として持つ。
- 山岳では風上側の上昇、風下側の乾燥・抑制をコア要件にする。地形高度、地形勾配、陸海、緯度帯を
  低解像度 bake field にまとめ、毎 ray の高価な地形処理を避ける。
- 島の wake、山岳波、Kármán 型の細長い street は、上記のコアが自然に動いた後で、予算内なら任意
  の追加とする。初期計画の成立条件にはしない。

### 光学と状態

- optical column basis から `CloudOptics` を作り、`tauScale`、相ごとの散乱・非対称因子、opaque-like
  threshold を低次元 parameter として調整する。
- 疑似 LWP、実効粒径、追加の科学的な高度換算は debug / sanity 用の補助値に留め、runtime の状態契約に
  しない。雲の高さは幾何高度 km で扱い、科学的な表示ラベルが必要な場合だけ別に記録する。
- 薄い巻雲、厚い積雲、層積雲、深い対流の optical thickness が見た目として連続し、氷相の上層雲が
  liquid cloud と同じ不透明さにならないことを優先する。

### カメラ、評価、観測入力

- コアの camera domain は高度 70 km 以上。視覚検証は 70 km、100 km、400 km、さらに遠い地球全体
  の衛星視点を使う。
- 地表すれすれ、雲内部、航空機視点、3D texture、多数の高サンプル inner view は今回の対象外とする。
- 6 regime の実写 / reference screenshot と contact sheet を人間が side-by-side で見る。自動判定に
  使う安価な指標は cloud fraction、spatial spectrum / characteristic scale、advection / motion
  speed、temporal correlation とする。
- 科学的な分位包絡、全 regime×metric の hard gate、物体の詳細追跡、閾値感度の総当たり、追加の科学的な高度換算に依存する
  鉛直統計は要求しない。
- observed cloud input は Phase 2 の任意 adapter とし、コアの完成を待たせない。画像から basis / preset
  を作る最小接続だけを想定し、画像だけから高度・相・不確実性を確定しない。

## データ・責務契約

実装時の型名は変更してよいが、責務の境界は次のとおりにする。

| 契約 | 内容 | 持たないもの |
| --- | --- | --- |
| `CloudFieldSample` | RGBA basis、空間 seed、必要な lifecycle 入力 | 雲種 ID、絶対高度、観測由来の科学量 |
| `CloudEnvironment` | 緯度、固定気候 prior、陸海・地形、日周期、温度 anchor、連続 parameterization weight | 月単位の気象切替、最終 alpha |
| `WeatherForcingField` | `moisture`、`lift`、`organization`、`windPerturbation` の論理的な合成値 | 最終の白い雲、renderer 固有の積分結果、必須の persistent texture |
| `CloudState` | field、environment、forcing、絶対時刻、seed、lifecycle | calibration metadata、debug histogram |
| `CloudVerticalProfile` | basis の高度支持、liquid / ice tendency、phase、雲底・雲頂、区間係数 | optics の実装、追加の科学的高度変換 |
| `CloudOptics` | basis / phase からの optical column、散乱、非対称因子、不透明境界 | 雲の lifecycle、地理 forcing |

雲面・大気内雲・雲影は同じ `CloudState` から `CloudVerticalProfile` と `CloudOptics` を得る。
surface、atmosphere、shadow の各 renderer は、それぞれの積分器でこの状態を評価する。

## 実装手順

### Step 1 — 現行ベースラインを固定する

**目的**

視覚と性能を優先するため、改修前後を同じカメラ、画質、機器で比較できる最小 baseline を作る。
科学的な評価基盤を先に拡張せず、ゲーム性能と画面の比較に必要な出力だけを固定する。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `tools/render-lab/cases.ts` | 70 / 100 / 400 km / 遠景の衛星視点ケースを追加し、既存の 960×540 ケースを再利用する。 |
| `tools/render-lab-measure.mjs`、`src/render/gpu-timings.ts` | no-cloud baseline と cloud-enabled composite を同じケースで記録する。 timestamp 非対応は `unqualified` とする。 |
| `tools/cloud-lab/lab.ts`、`tools/cloud-lab/views.ts` | 6 regime の静止画・contact sheet 出力と、512 cap / 1024×512 reference buffer を区別する。 |
| `tools/cloud-lab/baseline-manifest.mjs`（新規） | カメラ、機器、画質、実時間、simulation 時間、bake 回数、画像 hash を再現可能な manifest にする。最初の性能 gate は `Apple M4 Pro (Mac16,8, arm64)` + `Google Chrome stable / WebGPU`（既存の headless Chrome 起動経路）へ固定し、Chrome / OS / driver の version も保存する。 |
| `package.json` | baseline 出力と比較の script を追加する。 |

**達成条件と検証**

- 70 / 100 / 400 km / 遠景で同じ入力から reference contact sheet と baseline manifest を生成できる。
- cloud-enabled composite、no-cloud baseline、bake 回数を同じケースで保存できる。
- 代表性能環境が上記の 1 環境へ固定され、同じ browser / WebGPU 条件で no-cloud p95 と cloud budget を比較できる。
- `npm run typecheck`、`npm run test:render`

### Step 2 — 時間 LOD と最大時間ワープを先に実装する

**目的**

現在の `GeneratedCloudField` が表示時刻の変化ごとに bake し得る境界を、時間 LOD と target anchor の
直接要求へ改める。最大倍率でも大量 catch-up bake を起こさず、未解像の高周波を帯域制限する。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/generated-cloud-field.ts` | display cursor と simulation target を分離し、anchor 間の field 再利用、target anchor への直接更新、bake 更新上限を実装する。 |
| `src/render/cloud/weather-transport.ts`、`src/render/cloud/circulation.ts` | 既存の長周期 transport / pattern breath を時間 LOD から制御し、高倍率で高周波を無制限に追従させない。 |
| `src/game/dynamic/sim-speed-manager.ts`、`tools/perf-probe.mjs` | 最大 `33,554,432×` を同じ定義から参照し、古い速度一覧の写しを残さない。 |
| `src/render/cloud/weather-time.ts`（新規） | `epochUnixMs` を day index / seconds-of-day と simulation 秒 / frame へ正規化する。 |
| `src/render/cloud/temporal-lod.ts`（新規） | normal / intermediate / extreme の閾値、band-limit、field 更新上限を保持する。 |
| `tests/render/weather-time.test.ts`、`tests/render/temporal-lod.test.ts`（新規） | 日境界、巨大 float、最大倍率、target anchor、bake 回数、時間 LOD を検査する。 |

**達成条件と検証**

- 最大倍率で simulation 約 6.47 日 / frame でも、frame ごとの catch-up bake が発生しない。
- extreme で field 更新が実時間 1 秒あたり 4 回以下になり、同じ時刻の直接要求が表示時刻を大きく変更しない。
- normal では cell、mesoscale、weather object の位置・identity が連続する。
- intermediate では mesoscale / synoptic structure を中心に表示し、短寿命 cell や個々の object identity を保持しなくてよい。
- extreme / max warp では simulation 時間幅で平均・low-pass した field を表示し、全体の flash、急消失、周期的な点滅、日周期の aliasing がない。個々の Front / Cyclone / cell の位置連続性は要求しない。
- 異なる評価経路の一致を hard gate にせず、日境界・浮動小数点・seed の numeric 回帰だけを固定する。
- `npm run typecheck`、`npm run test:render`

### Step 3 — 共通 `WeatherForcingField` を作る

**目的**

weather object の結果を最終の雲へ直結させず、共通の低次元 forcing として合成する。以後の regime 別
調整を、共通 lifecycle / basis / profile / optics へ接続できるようにする。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/weather-forcing-field.ts`（新規） | `moisture`、`lift`、`organization`、`windPerturbation` の 3〜4 driver と、論理 field としての合成・連続 blend を定義する。初期段階で専用 texture を確保しない。 |
| `src/render/cloud/weather-model.ts` | object、地理、気候から forcing を合成し、最終 alpha や白い雲を直接返さない構造へ整理する。 |
| `src/render/cloud/condensation.ts` | forcing から RGBA basis と lifecycle 入力を作る共通入口へ改める。 |
| `src/render/cloud/cloud-state.ts`（新規） | forcing、field、environment、time、seed を所有する共有状態を定義する。 |
| `tests/render/weather-forcing-field.test.ts`（新規） | producer の重ね合わせ、ゼロ forcing、境界、共通 basis への入力を検査する。 |

**達成条件と検証**

- `WeatherForcingField` の型と合成処理が最終 cloud color / alpha を持たない。
- 初期 `WeatherForcingField` が上記 3〜4 driver で評価でき、convergence / orography は `lift`、vorticity などは `organization` に寄せられている。
- field は論理的な入力として渡せ、追加の persistent 512² texture がなくても core path が成立する。
- 雲面・大気内雲・雲影が同じ `CloudState` を参照できる配線ができる。
- `npm run typecheck`、`npm run test:render`

### Step 4 — Cyclone / Front / ITCZ の forcing producer を分離する

**目的**

前線や低気圧が浮いた白帯に見える問題を、物体そのものの描画ではなく湿度・上昇・収束・安定度・
風の摂動で解消する。ITCZ は熱帯の帯状 forcing として同じ合成経路へ入れる。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/cyclones.ts` | cyclone の位置・強度・回転を forcing producer として出力する。 |
| `src/render/cloud/weather-model.ts`、`src/render/cloud/rossby-wave.ts` | storm track / wave を synoptic forcing へ変換し、雲の最終形状を直接生成しない。 |
| `src/render/cloud/front-forcing.ts`（新規） | 温度・水分・収束の勾配から front forcing を作る。 |
| `src/render/cloud/itcz-forcing.ts`（新規） | 緯度帯と地理 field から ITCZ forcing を作る。 |
| `tests/render/cyclones.test.ts`、`tests/render/weather-producers.test.ts`（新規） | normal の producer 連続性、LOD 別の force 合成、object 単独で白い雲を出さないことを検査する。 |

**達成条件と検証**

- Front / Cyclone / ITCZ は共通 forcing の入力になり、basis / lifecycle / profile / optics は一つの経路を通る。
- normal では producer の位置と forcing が連続する。intermediate / extreme では producer の identity や位置連続性を hard gate にせず、時間幅に応じた forcing の平均・low-pass とする。
- 前線の端が通常雲へ滑らかにつながり、MCS の周辺に通常の巻雲などが共存する。
- `npm run typecheck`、`npm run test:render`

### Step 5 — 地理・気候・風上 / 風下の forcing を追加する

**目的**

全球の見た目を緯度だけの帯から脱し、陸海・山岳・海洋層積雲・storm track を低解像度 field で
与える。風上の上昇と風下の乾燥 / 抑制をコア要件にする。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/climate-map.ts`、`tools/export-climate.mjs` | 既存の温度・平均雲量・標高・陸地率・斜度を、現象発生 prior と parameterization weight として低解像度で出力する。平均雲量を最終 coverage へ直接加算しない。 |
| `src/render/cloud/geographic-forcing-field.ts`（新規） | 緯度循環、ITCZ、亜熱帯高圧帯、storm track、marine stratocumulus、land/ocean の prior をまとめる。 |
| `src/render/cloud/orographic-forcing.ts`（新規） | 現在の代表風と地形勾配から風上 ascent、風下 drying / suppression を `lift` へ寄せる。 |
| `src/render/cloud/weather-model.ts` | geographic prior と Front / Cyclone / ITCZ の dynamic anomaly を二重計上せず `WeatherForcingField` へ合成する。 |
| `tests/render/geographic-forcing.test.ts`（新規） | 赤道帯、亜熱帯海洋、storm track、風上 / 風下の符号と連続性を検査する。 |

**達成条件と検証**

- 陸海、地形高度、地形勾配、緯度 / climate zone が低解像度の入力として bake され、ray ごとの地理再計算がない。
- 山岳の風上で cloud forcing が増え、風下で乾燥 / cloud suppression が出る。人工的な明るい帯や格子が出ない。
- `AnnualClimateMap.meanCloudiness` は prior / weight として一度だけ寄与し、dynamic weather の coverage と二重計上されない。
- `npm run typecheck`、`npm run test:render`、70 / 400 km の衛星視点 screenshot

### Step 6 — lifecycle、風、world-space sub-grid を整える

**目的**

総観場の持続と個々の雲の短い lifecycle を分離し、低・中・上層風とシアで同じ対流起源の各層を
連続的にずらす。現在の長周期 pattern に雲の寿命を持たせない。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/cloud-lifecycle.ts`（新規） | absolute time、seed、forcing から発生・成長・減衰の係数を作る。 |
| `src/render/cloud/atmospheric-wind.ts`、`src/render/cloud/wind-law.ts` | 低 / 中 / 上層の高度 anchor と shear を共通 state へ接続する。 |
| `src/render/cloud/weather-transport.ts`、`src/render/cloud/circulation.ts` | world-space back-advection、one-step spherical transport、field と cohort の分離を実装する。 |
| `src/render/cloud/cloud-subgrid.ts`（新規） | 同じ state / seed から帯域制限された sub-grid detail を評価する。 |
| `tests/render/cloud-lifecycle.test.ts`、`tests/render/weather-transport.test.ts`、`tests/render/atmospheric-wind.test.ts` | camera-motion invariance、高度別移流、dateline / pole、normal lifecycle の連続性と extreme の時間平均を検査する。 |

**達成条件と検証**

- sub-grid が画面に貼り付かず、低 / 中 / 上層の風に沿って back-advect される。
- R→G→B の発達遅延と B / anvil の残留が共通 lifecycle から得られ、A は独立した上層雲として残る。
- `npm run typecheck`、`npm run test:render`、normal / intermediate / extreme の temporal LOD screenshot

### Step 7 — RGBA basis、温度、鉛直 profile、optics を実装する

**目的**

RGBA を basis 係数として共通 profile へ通し、相と光学量を見た目に必要な最小モデルへ整理する。
実行時に高度換算の科学モデルや大きな parameter table を要求しない。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/cloud-field-sample.ts`、`src/render/cloud/cloud-field.ts`、`src/render/cloud/baked-field.ts` | 低層 / 中層 / 対流上層 / in-situ 上層の 4 basis を encode/decode する。 |
| `src/render/cloud/cloud-model-parameters.ts`（新規） | 視覚調整用 fixture のうち採用済み runtime 値だけを immutable に保持し、描画経路から calibration 範囲を読まないようにする。 |
| `src/render/cloud/cloud-environment.ts`（新規） | latitude、固定気候、地理 forcing、temperature anchor をまとめる。 |
| `src/render/cloud/cloud-temperature-profile.ts`（新規） | 温度 anchor と tropopause を幾何高度へ変換し、相を連続補間する。 |
| `src/render/cloud/cloud-vertical-profile.ts`（新規） | compact support の piecewise / smoothstep basis、雲底・雲頂、区間係数を返す。高さは 0〜20 km。 |
| `src/render/cloud/cloud-optics.ts`、`src/render/cloud/cloud-optics-node.ts` | basis / phase から `tauScale`、散乱、非対称因子、opaque-like threshold を作る。既存の optics 経路を共通 state へ整理する。 |
| `tools/cloud-lab/calibration-spec.ts`（新規） | regime ごとの調整範囲、単位、reference screenshot、採用理由を debug metadata として保持する。runtime bundle へ import しない。 |
| `src/render/cloud/cloud-shape-evaluator.ts`、`src/render/cloud/cumulus-shape.ts` | shape と vertical profile の入力を共通 state へ移す。 |
| `tests/render/cloud-vertical-profile.test.ts`、`tests/render/cloud-optics.test.ts` | phase の連続性、thin / thick の単調性、CPU / TSL parity、上端 20 km を検査する。 |

**達成条件と検証**

- G 単独の中層雲、A 単独の巻雲、R 単独の低い雲、R+G+B の深い対流が同じ pipeline で表現できる。
- 薄い cirrus と opaque-like な liquid cloud の光学的な差が、basis と phase から連続的に現れる。
- pseudo LWP / effective radius は debug fixture に限定し、runtime の状態や描画入口へ漏れない。
- `npm run typecheck`、`npm run test:render`

### Step 8 — atmosphere の鉛直 slice を最初の描画経路として接続する

**目的**

衛星視点で最も重要な大気内雲を、共通 state / profile / optics から読めるようにする。surface と shadow
を先に独自実装せず、鉛直評価の連続性を画面で確認する。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/atmosphere.ts`、`src/render/pipeline/cloud-atmosphere-renderer.ts`、`src/render/pipeline/atmosphere-cloud-layers.ts`、`src/render/pipeline/atmosphere-integrator.ts` | `CloudState`、`CloudVerticalProfile`、`CloudOptics` の slice 評価を接続する。 |
| `src/render/cloud/cloud-presentation.ts`、`src/render/cloud/generated-cloud-field.ts` | atmosphere が受け取る binding を一箇所で組み立てる。 |
| `src/render/gpu-timings.ts`、`tools/render-lab-measure.mjs` | atmosphere on/off と cloud pass の計測境界を baseline と一致させる。 |
| `tests/render/atmosphere-cloud.test.ts`（新規） | 高度 slice、相の連続性、horizon / daylight の境界を検査する。 |

**達成条件と検証**

- 70 / 100 / 400 km で雲の層割れ、上端の切断、薄い上層雲の消失がない。
- atmosphere が最終白色を直接 weather object から読まず、共通 state を使う。
- `npm run typecheck`、`npm run test:render`、render-lab screenshot

### Step 9 — 視覚と GPU 予算を 70 km 以上で調整する

**目的**

ゲーム性能に直接効く品質段階と測定条件を決める。GPU budget は固定の絶対値でなく、同じ機器の
no-cloud baseline から導出する。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `tools/render-lab/cases.ts`、`tools/cloud-lab/lab.ts` | 70 / 100 / 400 km / 遠景、6 regime、normal / intermediate / extreme の撮影ケースを揃える。 |
| `src/render/gpu-timings.ts`、`tools/render-lab-measure.mjs` | cloud の追加 GPU 時間、bake spike、bandwidth、更新回数を品質段階別に記録する。 |
| `src/render/cloud/cloud-quality.ts`（新規） | low / standard / high の sample、sub-grid、更新頻度を定義する。standard を性能 gate とする。 |
| `tools/cloud-lab/compare-report.mjs`（新規） | screenshot contact sheet、cheap metrics、GPU baseline 比較をまとめる。 |

追加 cloud budget は、Step 1 で固定した代表機器 / browser で測った no-cloud frame の p95 を `B0`、
1 frame の予算を `F=16.67 ms` とする。まず

`headroom = max(0, F - B0)`

を求め、`headroom > 0` の場合だけ

`Bcloud = min(0.20 × F, 0.50 × headroom)`

とする。`headroom = 0` の場合は 60 fps の性能 qualification が不能であり、standard / low / high の
いずれも qualified と判定しない。standard はこの budget 内、low はそれ以下、high は診断用として記録する。
別の機器 / browser では同じ式を再計算するが、代表 gate の判定は固定環境の値だけで行う。

**達成条件と検証**

- Step 1 の固定環境で `headroom > 0` が確認でき、standard の追加 cloud cost が `Bcloud` を超えない。`headroom = 0` なら 60 fps qualification は `unqualified` と記録する。
- max warp で field update が上限内、bake spike と帯域が baseline manifest に保存される。
- 70 / 100 / 400 km と遠景で、normal / intermediate / max warp、薄雲・最大雲量・深い対流を screenshot で比較できる。
- `npm run typecheck`、`npm run test:render`、`npm run cloud-lab:shot`、性能計測 script

### Step 10 — surface と cloud shadow を共通 state へ接続する

**目的**

地表合成と雲影を atmosphere と同じ basic state へ揃える。surface は optical column の累積、shadow は
effective layer として、各経路に必要な安価な積分器を使う。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/opaque-cloud-surface-renderer.ts`、`src/render/pipeline/shadow/cloud-shadow-renderer.ts` | 共通 `CloudState` / profile / optics を参照し、独自の雲形状・相判定を除く。 |
| `src/render/cloud/cloud-field-sampler.ts`、`src/render/cloud/cloud-shape-evaluator.ts` | surface / atmosphere / shadow で同じ support をサンプルできる binding を整理する。 |
| `tests/render/cloud-surface.test.ts`（新規）、`tests/render/cloud-shadow.test.ts`（新規） | 同一状態の層境界、累積 optical depth、effective shadow、低太陽高度を検査する。 |

**達成条件と検証**

- 斜光、地平線、雲量の多い場面で、雲面・大気内雲・雲影の基本 support が分裂しない。
- `npm run typecheck`、`npm run test:render`、低太陽高度を含む 70 / 400 km screenshot

### Step 11 — 6 regime を人間の side-by-side で調整する

**目的**

画面の自然さを最終調整する。自動の科学合否にせず、reference screenshot / contact sheet と cheap
metrics を組み合わせ、過剰に細かい物体分類へ進まない。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `tools/cloud-lab/views.ts`、`tools/cloud-lab/compare-report.mjs` | 貿易風積雲、海洋層積雲、温帯 front、熱帯 deep convection / MCS、上層 cirrus、高緯度 mixed phase を side-by-side 出力する。 |
| `tools/cloud-lab/metrics.mjs`（新規） | cloud fraction、spatial spectrum / characteristic scale、advection / motion speed、temporal correlation を計算する。 |
| `memos/mikanixonable/` の calibration manifest | 採用した見た目の preset、入力、機器、スクリーンショットの provenance を記録する。 |

**達成条件と検証**

- 6 regime で reference と生成画像を同じ camera / exposure で比較できる。
- thin cirrus、marine stratocumulus、deep convection、anvil、地形の風上 / 風下が見た目として識別できる。
- 前線端が通常雲へ連続し、MCS 周辺に通常の巻雲などが共存する。regime 固有の weight による変化に seam や排他的な雲種切替がない。
- cheap metrics は調整の手掛かりとして出力されるが、科学的な hard pass / fail にはしない。
- `npm run typecheck`、`npm run test:render`、contact sheet の人間レビュー

### Step 12 — wake / Kármán / mountain wave は予算内で任意追加する

**目的**

コアの地理・地形 forcing が安定した後、衛星視点で効果の大きい細長い模様だけを追加する。新しい
solver や高解像度 texture を導入しない。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/orographic-pattern.ts`（新規） | 低解像度の wake / wave pattern を forcing の補助として追加する。 |
| `tests/render/orographic-pattern.test.ts`（新規） | 風向反転、解像度境界、performance を検査する。 |

**達成条件と検証**

- standard の budget を超えず、既存の風上 / 風下 forcing を壊さない。満たせなければこの step は延期できる。
- `npm run typecheck`、`npm run test:render`

### Step 13 — observed cloud input は Phase 2 として接続する

**目的**

実写や既存の観測分離結果を、見た目の初期 basis / preset として任意に取り込めるようにする。ただし
観測入力は core renderer、lifecycle、性能 gate の前提にしない。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/observed-cloud-field.ts`、`src/render/cloud/cloud-presentation.ts` | observed input を basis / preset adapter として `CloudState` へ接続する。 |
| `tools/cloud-lab-separate.mjs`、`tools/cloud-lab-compare.mjs` | 既存の分離画像を adapter fixture として利用し、観測 provenance を残す。 |
| `tests/render/observed-cloud-adapter.test.ts`（新規） | 欠測、画像サイズ、basis 範囲、core なしでも生成できることを検査する。 |

**達成条件と検証**

- observed input がなくても Step 11 までの core が成立する。
- adapter は画像→basis / preset の最小変換に留まり、高度・相・不確実性を確定しない。
- `npm run typecheck`、`npm run test:render`

## 達成目標

### 視覚

- 6 regime を reference と side-by-side で見比べられ、雲が白い object の集合ではなく、共通 basis / profile / optics
  の結果として見える。
- 薄い cirrus、marine stratocumulus、deep convection、anvil、低 / 中 / 上層の雲、山岳の風上 / 風下を 70 km 以上
  で識別できる。
- Front / Cyclone / ITCZ は周囲の cloud field に混ざり、浮いた最終白帯にならない。

### 時間

- normal で自然な移流・発生・減衰が続く。
- intermediate で模様の高周波だけが整理され、雲の性質が崩れない。
- extreme / 最大倍率で粗い衛星 timelapse として自然に変化し、時間平均 field 全体の flash、急消失、周期的な点滅がない。個々の前線・低気圧・雲セルの移動連続性は要求しない。
- 未解像の高周波を band-limit / average し、最大倍率で細胞を忠実に再生しようとしない。

### 構造

- weather object は forcing producer、最終の雲は共通 lifecycle / basis / profile / optics という責務分離になっている。
- regime-specific parameterization は連続 weight の blend として共通 pipeline の上でだけ許され、排他的な雲種切替を基本経路にしない。
- climatology / geography は発生 prior、Front / Cyclone / ITCZ は dynamic anomaly として分離され、平均雲量を dynamic coverage と二重計上しない。
- 雲面・大気内雲・雲影の三経路が、同じ basic state を参照する。
- runtime cap は 512×512 RGBA16F 一枚で、追加 3D texture がない。

### 性能

- standard が no-cloud baseline から導いた追加 budget 内に収まる。
- normal / max warp の bake 更新数、spike、帯域を保存し、max warp で bake storm が起きない。
- high quality は診断用に残せるが、standard が代表ノート PC / Apple Silicon / iGPU の gate である。

### 科学的な利用

- cheap metrics は tuning reference として再生成できる。
- 観測入力、疑似 LWP、effective radius、幾何高度以外の表示ラベルは core completion を妨げない。

## 見積り

工数は新しい目的に合わせて各 step の作業単位から積み上げる。1 日を 8 時間として、実装、テスト、
画像確認を同じ step 内で行う。GPU / browser 差、地理 asset の調整、既存 renderer の境界が不確実なため、
個々の時間は確約値ではなく着手順を決めるためのレンジである。

| step | 内訳 | 見積り |
| --- | --- | ---: |
| 1 | baseline capture 4h + manifest / script 3h + GPU 対応確認 3h | 10h |
| 2 | 時刻境界 5h + temporal LOD 10h + 最大倍率 / 回帰 5h | 20h |
| 3 | forcing 型 6h + state / condensation 接続 5h + test 3h | 14h |
| 4 | producer 7h + forcing 連続性 / test 5h | 12h |
| 5 | 地理 field 8h + orographic forcing 6h + bake / visual 4h | 18h |
| 6 | lifecycle / transport 10h + sub-grid 5h + test 3h | 18h |
| 7 | basis / profile 10h + optics 5h + CPU / TSL parity 5h | 20h |
| 8 | atmosphere slice 7h + test / measurement 3h | 10h |
| 9 | camera cases 3h + quality / budget 5h | 8h |
| 10 | surface 6h + shadow 5h + shared-state test 3h | 14h |
| 11 | 6 regime contact sheet 6h + human tuning / metrics 6h | 12h |
| **Core 合計** | `10+20+14+12+18+18+20+10+8+14+12` | **156h** |
| 12（任意） | wake / Kármán / mountain wave の補助 pattern | 8h |
| 13（Phase 2） | observed adapter と fixture | 8h |

Step 12 と Step 13 を含める場合の計画上の合計は 172h だが、どちらも core の完了条件ではない。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 / 対応 |
| --- | --- | --- |
| extreme で temporal LOD または日周期の aliasing が見える | 時間平均 field が階段状に変化、flash、周期的な点滅をする | Step 2 の最大倍率 contact sheet。simulation 時間幅に応じた low-pass と日周期の平均化を調整する。 |
| target anchor へ直接飛ぶ処理が bake storm を起こす | 高倍率でゲームが停止する | Step 2 / Step 9 の bake 回数・spike・帯域。実時間更新上限と field 再利用を測る。 |
| front / cyclone の forcing が局所的な明るい帯になる | 物体が浮いて見える | Step 4 / Step 11 の side-by-side。最終 alpha を producer から除く。 |
| 低解像度の地理 field が格子や明るい帯を作る | 地形・海洋の分布が不自然になる | Step 5 の 70 / 400 km screenshot。filter と bake 解像度を調整する。 |
| 風下抑制が強すぎる | 山脈の片側が不自然に消える | Step 5 / Step 11 の地形ケース。forcing の上限を調整する。 |
| regime-specific parameter が増え続ける | 共通 pipeline の利点を失う | Step 3 / Step 7 の型レビュー。追加 parameter は basis / forcing の低次元項に限定する。 |
| 離散 regime 分岐が前線端や MCS 周辺に seam を作る | 通常雲との接続や cirrus の共存が壊れる | Step 4 / Step 7 / Step 11 の screenshot。environment / forcing weight の連続 blend に戻す。 |
| no-cloud baseline が frame budget を使い切る | 60 fps の性能 qualification ができない | Step 1 / Step 9 の `headroom=0`。`unqualified` と記録し、cloud budget を合格扱いにしない。 |
| 70 km で horizon / sampling artefact が強い | 衛星視点の見た目が壊れる | Step 8 / Step 9 の 70 km ケース。inner view 対応を追加しない。 |
| 共通 state が renderer 境界を越えて mutable になる | 雲面・大気・影が別状態になる | Step 3 / Step 8 / Step 10 の state ownership review。render 層の GPU resource とモデル state を分ける。 |
| timestamp 非対応 GPU で性能値が比較不能 | 誤った性能判定をする | Step 1 / Step 9。`unqualified` として画面比較だけを有効にする。 |
| observed input が core pipeline を複雑化する | 実写由来の例外が増える | Step 13。basis / preset adapter に閉じ込め、core gate から外す。 |

## 変更要約

| 変更項目 | 旧計画 | 新計画 | 理由 | 工数への影響 |
| --- | --- | --- | --- | --- |
| 科学的評価 | 詳細な観測統計と自動判定を中心にする | screenshot / contact sheet と 4 種の cheap metrics を tuning reference にする | 衛星視点の見た目と実装可能性を優先 | 減少 |
| season / カレンダー依存 | カレンダー周期を環境変化へ結び付ける | 固定基準気候、緯度、陸海、地形、climate zone を使う | 月単位の切替を画面要件にしない | 減少 |
| 決定性・時間 | 再生経路の厳密一致を要件にする | 絶対時刻の正規化、normal の object 連続、intermediate の mesoscale/synoptic、extreme の時間平均 / low-pass | 最大時間倍率では未解像時間を再生しない | 増減（テストは減り、LOD 実装が増える） |
| 地理・地形 | 気候・地形の影響を weather model の個別項に留める | 発生 prior と dynamic anomaly を分離し、低解像度 geographic forcing と風上上昇 / 風下抑制を core 化 | 全球の衛星視点で地理的な説得力が必要 | 増加 |
| weather object / front | object が最終 cloud pattern を直接作る | Front / Cyclone / ITCZ は 3〜4 driver の `WeatherForcingField` producer。identity は extreme で捨てる | 浮いた白帯を防ぎ、共通 lifecycle を使う | 増加 |
| observed cloud | 観測入力を core の評価経路に含める | 最小 basis / preset adapter を Phase 2 化 | 実写入力なしでも core を完成させる | 減少 |
| 鉛直描画 | 科学的な高度変換・詳細な科学量を共有契約に含める | atmosphere slice を先行し、幾何高度、phase、optics を軽量に共有 | 見た目に必要な契約へ縮小 | 減少 |
| 性能 | 固定の絶対 GPU budget を置く | no-cloud baseline から導く low / standard / high と最大倍率の更新上限 | 機器差を吸収し、ゲーム性能を gate にする | 増加 |

## なお残る過剰設計かもしれない部分

- 6 regime の contact sheet と 4 metrics でも、最初の画面調整には多い可能性がある。Step 1 は 3 regime で開始してよい。
- `WeatherForcingField` の専用 driver 分離が初期の見た目に不要なら、3〜4 driver のまま後続へ遅らせられる。
- 温度 anchor と phase の二重管理は profile が安定した後に一つへ縮約できる。
- Step 12 の wake / Kármán / mountain wave は、通常の地形 forcing だけで十分なら実装しない。
- Phase 2 の observed adapter は、基準画像を preset として手動登録できる間は延期できる。

## 今回の範囲外

- 数値予報、完全な流体 solver、実時間の降水量・雷・地表天候 API
- 70 km 未満の inner-cloud / ground / aircraft view
- 3D 雲 texture、高サンプルの内部 view、全時刻の忠実な再生
- 観測画像だけから高度・相・粒径・不確実性を確定する逆推定
- Kármán wake、mountain wave、observed cloud input の core 必須化

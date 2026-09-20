# 気象学的な雲モデルへの改修計画

- 状態: 検査待ち（この文書の承認までは実装しない）
- 作成日: 2026-09-20
- 改訂日: 2026-09-20（指摘反映版）
- 調査基準: `0114373a7`
- 対象: 地球の生成雲、観測雲入力、雲面・大気内雲・雲影、cloud-lab

## 目的

約 2,000 km の検証窓で、総観場の配置は数日保ちながら、メソスケールの雲組織と個々の雲塊は時間単位から 1〜2 日の範囲で発生・発達・消滅する空を作る。雲塊の寿命を総観場の寿命から分離し、同じ絶対時刻から毎回決定的に再計算する。

深い対流では、低層の液相雲が中層の混相域を経て上層の氷雲・かなとこ・流出巻雲へ連続的に変わる。高度ごとの風によるずれ、雲相ごとの光学量、雲底・雲頂は、雲面・大気内雲・雲影が同じ物理的な支持範囲・鉛直 profile・絶対時刻を参照して表現する。ただし、三つの描画経路は同じ状態をそれぞれの積分器で評価してよい。描画上の境界は、鉛直 300 m、水平 2 field texel、影の重心は別途定める許容幅以内を一致とする。

これは予報用の数値気象モデルではない。観測で見える時空間統計、雲相、高度別移流、光学的な見た目の関係を、絶対時刻から再現可能な軽量モデルで近似する。観測画像から作る入力は見た目の初期化用であり、科学的な鉛直量を画像だけから逆算したものとは扱わない。

完了時の `DEVELOP/SPEC/RENDERING.md` には、少なくとも次の振る舞いを内部名やチャンネル配置に依存しない形で正本として記す。

> 約 2,000 km の範囲では、気圧配置や曇りやすい領域が数日保たれる間にも、メソスケールの雲組織と個々の雲塊は時間単位から 1〜2 日の間隔で再編成され、同じ輪郭がそのまま 7 日残らない。

> 薄い雲と厚い雲、低い雲と中層から始まる雲は別々に存在できる。発達した対流雲では、低い雲底を持つ液相の塔が上へ成長し、中層で混相となり、上層で氷化してかなとこ・巻雲状の流出へ連続的に広がる。対流起源の上層氷雲と、上層で独立に生じる巻雲の両方がある。

> 一つの深い対流雲の中でも、低層の液相の塔、中層の混相部分、上層のかなとこはそれぞれの高度の風に乗り、鉛直シアに応じて連続的にずれる。対流が弱まると低層の塔が先に消え、上層氷雲は上層風へ流されながら薄くなる。

> 小さく薄い雲は低いとは限らず、中層に雲底を持つ雲塊が独立して存在できる。雲の濃さだけから雲底・雲頂を決めない。

> 深い対流雲の大半は局地的な対流圏界面付近で横へ広がり、強い芯だけが一時的にその上へ突き抜ける。上端には 20 km の安全上限を設ける。

## 決めたこと

### 時間階層と時刻契約

- シミュレーション上の時間を空間周波数の異なる四層に分ける。初期パラメータの探索範囲は、総観 forcing が 2〜5 日（長い tail は 5〜7 日）、メソ組織が 4〜24 時間、雲セルが 0.5〜3 時間、sub-grid detail が 0.25〜1 時間とする。かなとこは独立した周波数帯ではなく、対流セルから遅れて 4〜10 時間残る lifecycle tail として扱う。これらは物体一個の見かけの寿命を一律に決める値ではなく、Step 2 の観測分布で regime 別に較正する。
- 2,000 km は固定カメラの画角ではなく、緯度経度を大円距離へ変換した検証窓の幅として固定する。runtime の cap 面積・投影はカメラから決まるため、検証窓と 512×512 cap の面積を同一視しない。
- 生成関数は `displayTime` や前フレームの状態を入力にしない。CPU の入口は整数ミリ秒の `epochUnixMs` とし、GPU へは精度を保てる `dayIndex` と `secondsOfDay` へ正規化して渡す。`displayTime` は絶対時刻を選ぶ再生カーソルに限定する。
- seed、forcing、cohort の年齢、日周期・季節周期は絶対時刻から算出する。時間倍率、フレーム刻み、任意時刻へのランダムアクセス、評価順が結果を変えないことを契約にする。
- 長寿命の総観場と短寿命の雲模様は別の状態として生成する。同じ field を 7 日周期で cross-fade して雲の寿命を作る方式は採らない。
- 低周波の `cloudBake` は `CloudBakeAnchor = floor(epochUnixMs / (10 simulation minutes))` で決まる離散 anchor 時刻にだけ、単一の 512² cap へ更新する。anchor 間は保持中の field を world-space で deterministic に移流し、lifecycle の係数を補間する。30 分以下の高周波 detail だけを shader で連続変化させる。これは雲の寿命を cross-fade で表すこととは別の cache 契約である。
- 時刻ジャンプで複数 anchor を飛び越えても中間 anchor を catch-up bake しない。要求時刻の anchor を一度だけ bake し、bake cache key は `anchorIndex`（および climate/projection revision）で決める。補間位相は毎フレームの binding uniform であり、bake を無効化する key にはしない。各描画経路は同じ anchor/state を読む。
- 性能計測では、steady p95 = anchor crossing のない frame、bake-spike p95 = anchor crossing を含む frame、amortized cost = 固定した simulation window 内の bake 実時間をその window の frame 数へ按分した値と定義する。通常速度は 1×、最大 time warp は既存 `SIM_SPEED_LEVELS` の最大値 `33,554,432×` を使い、どちらも同じ camera/quality で記録する。

初期値は仕様上の固定値ではなく、最初の較正走査を再現するための採用済み runtime の既定値とする。下表の「探索範囲」は calibration 用、「安全上限」は暴走を防ぐ runtime 境界である。runtime の採用値と探索範囲は同じ object に混在させない。`CloudModelParameters` は採用済み runtime 値だけを immutable に持ち、`CloudCalibrationSpec` は `tools/cloud-lab/` 側で範囲・単位・観測根拠・適用 regime を持つ。

| parameter | 初期値 | 探索範囲 / 安全上限 | 用途 |
| --- | ---: | ---: | --- |
| `tauSubgridDetail` | 30 min | 15〜45 min | 浅い積雲の shader detail decorrelation |
| `tauConvectiveCore` | 60 min | 30〜90 min | 雷雨の単一 core |
| `tauStratocumulusCell` | 2 h | 1.5〜3 h | 海洋層積雲の個別 cell |
| `tauMesoOrganization` | 12 h | 6〜24 h | 雲群・前線帯の組織 |
| `tauMcsEnvelope` | 7 h | 4〜12 h、強い組織は 24 h まで | MCS envelope |
| `tauAnvil` | 6 h | 4〜10 h | B の上層残留 |
| `tauSynopticForcing` | 3 d | 2〜5 d、長い tail は 5〜7 d | 低気圧・前線・総観背景 |
| `rToGDelay` | 10 min | 5〜20 min | 液相塔から中層遷移 |
| `gToBDelay` | 20 min | 10〜30 min | 中層から強い上層 B への遅れ |
| `coreDecay` | 60 min | 30〜90 min | R/G の先行減衰 |

`tau*` は同じ値を全域へ掛ける寿命ではなく、空間周波数・regime・seed ごとの decorrelation scale である。実装値と観測値を混同しないよう、manifest には初期値、探索範囲、採用値、採用根拠を別フィールドで保存する。`CloudCalibrationSpec` は runtime bundle から import しない。

### 雲場データ契約

RGBA は雲種 ID や絶対高度ではなく、鉛直プロファイルを再構成する無次元の連続基底とする。固定の「R=液相、G=混相」のように単一チャンネルを相の断定へ使わず、相は温度・高度・環境から導出する。

| チャンネル | 契約上の意味 | 主な寄与 |
| --- | --- | --- |
| R | 低層凝結基底 | 低い雲底、輪郭の明瞭な積雲、層積雲、対流の根元 |
| G | 中層凝結基底 | 雲底の高い小雲、発達中の塔、混相域へ入る成分 |
| B | 対流起源の上層凝結基底 | かなとこ、対流から流出する上層雲 |
| A | 上層で独立に生じる凝結基底 | in-situ の薄い巻雲・巻層雲 |

- 値は 0..1 に正規化した光学 column basis 係数で、値を高度や雲種 ID、物理的な LWP/IWP そのものとして読み替えない。G 単独の中層雲、R 単独の低層雲、B 単独の対流残留雲、A 単独の巻雲を許す。
- R/G/B は一つの対流起源に属する場合、同じ seed と履歴からピーク時刻をずらして生成する。A は上層湿度・上昇・温度から独立に生成し、B と合成しても因果を失わない。
- 実行時の生成 cap は 512×512 の RGBA16F 一枚、約 2 MiB を上限とする。既存の 4096×2048 RGB/グレースケール画像は観測・見た目の初期化元であり、実行時 cap のメモリ契約ではない。追加の 3D 雲テクスチャは導入しない。
- Earth の通常描画は `OrthographicCap(CLOUD_CAP_SIZE=512)` を runtime cap とする。一方 cloud-lab の全全球比較は `EquirectProjection(1024×512)` を使うため、lab の global projection は 2 MiB cap とは別の reference buffer として manifest・性能表へ記録する。
- 512×512 の `cloud-field` は総観・メソスケールの envelope を担当する。典型的な浅い積雲より細かい形状・エッジは、同じ絶対時刻と seed から shader の deterministic sub-grid detail として補う。したがって、この cap の texel を個々の浅い雲セルそのものと解釈せず、object-series の物体統計は field の解像度と sub-grid の担当範囲を manifest に明記する。
- `CloudFieldSample` は RGBA basis と deterministic seed、`CloudEnvironment` は緯度・季節・anomaly・tropopause・phase anchor、`CloudState` はそれらと lifecycle/時刻を組み合わせた共有入力、`CloudProfile` はそこから導出される profile とする。`CloudModelParameters` は採用済み runtime 定数、`CloudCalibrationSpec` は探索範囲・観測根拠・適用条件を持つ。calibration metadata や derived optics を `CloudState` に集約しない。
- 雲面・大気内雲・雲影には同じ state/profile binding を渡す。path ごとのサンプル密度・積分順・早期終了は共有しない。境界の一致は物理的な支持範囲を共有することを必須とし、見かけの交点は renderer の許容幅で検証する。

### 鉛直プロファイル、相、風

- `CloudVerticalProfile` は basis、environment、温度 anchor から、任意の高度で liquid/ice の column basis、phase fraction、雲底、雲頂、区間積分係数を返す。光学的な extinction、scattering、実効粒径は返さない。`CloudOptics` が profile の basis/phase と `CloudOpticsParameters` から光学量へ変換する。大気積分・雲面・雲影はこの profile と optics の契約を再実装しない。
- profile basis は compact support を持つ C1 piecewise polynomial / smoothstep 系へ固定し、1 回の profile evaluation は最大 4 basis、`exp`/`pow`/`sin`/`cos` などの transcendental 関数を使わない。区間積分は解析式または同等に安価な係数和で求め、Step 4A の ALU budget と CPU/TSL parity で固定する。
- 高度帯は全球固定の low/mid/high ではなく、初期 profile の支持範囲を緯度帯で変える。low は全緯度で地表〜2 km、middle は極域 2〜4 km・温帯 2〜7 km・熱帯 2〜8 km、high は極域 3〜8 km・温帯 5〜13 km・熱帯 6〜18 km とする。これは基底の支持範囲であり、相の判定高度ではない。
- CPU/bake 段階では緯度・季節・総観 anomaly から `z0C`、`z-10C`、`z-30C`、`z-40C`、tropopause の温度 anchor を求める。shader の hot path は anchor 間の smoothstep 補間だけを行い、毎サンプルに完全な `T(z)` を評価しない。0〜11 km の環境 lapse rate 初期値は 6.5 K/km、強い対流内部だけ 4〜5 K/km の補正を許す。融解・凍結高度を別の固定定数にせず、液相と氷相の切替を連続化する。
- phase の初期 parameterization は、`T >= 0°C` を液相主体、`0..−10°C` を液相主体で氷を許可、`−10..−30°C` を混相、`−30..−40°C` を氷相主体、`T <= −40°C` をほぼ完全な氷相とする。境界は hard branch ではなく smoothstep で補間し、数値は観測の phase envelope で較正する。
- 対流圏界面は緯度・季節・総観場から変える。初期値は極域 8 km、全球中緯度 12 km、赤道・熱帯 15〜18 km の間を補間し、通常の B はその近傍で横へ広げる。強い芯の overshoot は通常 0〜2 km、上端は `min(20 km, tropopause + overshootDepth)` とする。
- runtime の風 anchor は固定した幾何高度 `windHeightAnchors = [1.4, 5.5, 10.5] km` として扱う。850/500/250 hPa は calibration label であり、wind path で pressure→height を暗黙に再計算しない。初期速度はそれぞれ low 3〜10 m/s、mid 5〜15 m/s、upper 10〜30 m/s、強風 tail は 15〜25 / 20〜35 / 40〜60 m/s とする。9〜16 km の jet regime では 60〜90 m/s まで許す。対流の outflow/divergence を別の補正として持ち、一つの対流起源を共有したまま各高度の風で水平位置をずらす。
- 光学量は coverage をそのまま `-log(1-coverage)` へ変換しない。RGBA は optical column basis とし、初期 fixture は liquid basis 1.0 → 疑似 LWP 100 g/m² → `τ=15`、したがって `tauScaleLiquid=15` とする。`tauScaleIce=1` は物理 IWP を主張しない中立 fixture で、optics phase で較正して freeze する。液相の sanity check は `τ ≈ 3 LWP / (2 ρw reLiquid)`、`reLiquid=10 µm`、`gLiquid=0.85`、`gIce=0.75`、可視 `τ=0..50` を使い、`τ=3.6` と `τ=23` を thin/intermediate/thick の判定境界、`τ=20..30` を opaque-like の初期境界とする。氷相の実効粒径と scale は phase/光学観測から較正するパラメータとして残す。
- A は B と同じ上層基底でも同じ厚さにしない。中緯度の in-situ cirrus は中心 8〜11 km・厚さ 0.5〜2 km、熱帯は中心/頂部 12〜16 km・厚さ 0.5〜2 km、対流起源 B は ice-only anvil 厚さ 2〜4 km を初期値とし、観測で 10〜17 km の top envelope を確認する。

液相の光学 fixture は `reLiquid=10 µm` で下表を基準にする。これは観測の ground truth ではなく、basis amplitude→疑似 LWP→τ の単位・単調性を検査するための初期 fixture である。runtime の basis を質量へ一意に解釈する契約ではなく、`tauScaleLiquid` を通した sanity check とする。

| LWP | 期待する可視 optical depth τ | 判定 |
| ---: | ---: | --- |
| 10 g/m² | 1.5 | thin |
| 20 g/m² | 3.0 | thin の上端付近 |
| 50 g/m² | 7.5 | intermediate |
| 100 g/m² | 15 | intermediate |
| 200 g/m² | 30 | thick / opaque-like |
| 300 g/m² | 45 | thick |

時間表以外の採用済み runtime 値は次のキーとして `CloudModelParameters` に持たせる。`fixture` は単体テストで必ず再現する値、`range` は `CloudCalibrationSpec` で Step 2/5 の包絡へ合わせて走査する値であり、すべての値を単位付きで manifest に保存する。

| key | 初期値 / fixture | 探索範囲・安全上限 |
| --- | --- | --- |
| `tropopauseByLatitude` | 極域 8 km / 中緯度 12 km / 熱帯 17 km | 熱帯は 15〜18 km、上端は 20 km |
| `overshootDepth` | 1 km | 通常 0〜2 km、`tropopause + depth <= 20 km` |
| `environmentLapseRate` | 6.5 K/km（0〜11 km） | profile fixture は 6.5 K/km |
| `convectiveLapseRate` | 4.5 K/km | 4〜5 K/km |
| `windHeightAnchors` | 1.4/5.5/10.5 km（850/500/250 hPa label） | 3 anchor を連続 `U(z)` へ補間 |
| `windSpeedFixture` | low 5 / mid 10 / upper 25 m/s | low 3〜10、mid 5〜15、upper 10〜30 m/s |
| `reLiquid` | 10 µm | 9.6〜11 µm |
| `gLiquid` / `gIce` | 0.85 / 0.75 | liquid 0.84〜0.86、ice 0.73〜0.78 |
| `visibleOpticalDepth` | 0〜50 | thin/intermediate 境界 3.6、intermediate/thick 境界 23 |
| `tauScaleLiquid` / `tauScaleIce` | 15 / 1（neutral fixture） | liquid 12〜18、ice 0.5〜3。optics phase で freeze |

### 鉛直 pressure、移流、sub-grid の共通契約

- `CloudPressureProfile`（`src/render/cloud/cloud-pressure-profile.ts`）を validation と render profile の共通 adapter とする。初期 fixture は幾何高度 1.4 / 5.5 / 10.5 / 16 km に 850 / 500 / 250 / 100 hPa を対応させ、log-linear 補間で CTP を求める。これは簡易 pressure mapping であり、独立した二つ目の大気モデルを作らない。既存の大気密度・scale-height 実装に pressure が存在しない場合は、変換をこの adapter に閉じ込め、後から別式を各 renderer に持ち込まない。
- sub-grid detail は screen-space noise ではなく world-space で評価する。各高さの `U(z)` による back-advection、band-limit/mip、同じ `epochUnixMs` と seed を入力とし、カメラ移動で模様が shimmer しないことを契約にする。30 分程度の decorrelation は時間 noise の掛け合わせで表すが、風で運ばれない沸騰ノイズにはしない。
- 球面上の cohort transport は、cohort の発生地点で局所風を frozen とし、寿命中の変位を一回の spherical exponential map / great-circle displacement で求める近似へ固定する。位置依存風を厳密に RK 積分したり、render path で反復積分したりしない。dateline/pole では球面座標を正規化し、one-step 変位と連続性を test する。

### 観測検証

- 6 regime を用意する: 貿易風積雲、海洋層積雲、温帯低気圧・前線、熱帯の深い対流/MCS、上層巻雲、高緯度の混相雲。最後の regime は低い太陽高度や氷・液相の共存を含める。
- 観測は三つの時系列に分ける。`object-series` は 1〜5 分間隔で 1〜3 時間を追い、セル・塔の発生・成長・分裂・消滅を測る。`mesoscale-series` は 10〜30 分間隔で 6〜24 時間を追い、object area、spacing、組織の相関を測る。`synoptic-series` は 3〜6 時間間隔で 72 時間〜5 日を追い、総観配置、風で移流した相関、cloud fraction、large-scale structure を測る。従来の 0 / 6 / 12 / 24 / 48 / 72 時間 contact sheet は synoptic-series の表示セットとして残す。
- 観測 manifest には source pixel size、cadence、projection、downsample/filter を必ず残す。GOES ABI の初期条件は visible red 0.5 km、visible/NIR 1 km、IR 2 km、cadence は全球 10 分、CONUS/PACUS 5 分、mesoscale 1 分までとする。9° radius の検証窓は大円距離 `2Rθ ≈ 2,002 km` で定義し、orthographic cap の `2R sin(θ) / 512 ≈ 3.9 km/texel` は中心付近の nominal scale と明記する。端部の scale は投影から別途記録する。0.3〜3 km の浅い積雲は source で検出しても runtime field の個別 texel とは比較せず、analysis buffer と同じ観測窓へ集約する。
- 生成と観測だけでなく、観測を時系列の前半/後半や近接軌道へ分割した observation-to-observation envelope を算出する。モデルの calibration target は観測同士のばらつき、測器・投影誤差、前処理誤差を含む regime×metric 別の q2.5〜q97.5 包絡と、manifest に固定した測定許容幅で判定する。全 regime・全 metric を同時に満たす単一の hard gate にはしない。
- forward-validation の観測量は cloud mask/fraction、cloud-top pressure/height、cloud-top temperature、cloud-top phase、visible optical depth、object size、移動速度、lagged spatial correlation とする。鉛直 layer structure を直接観測したとは扱わず、内部 RGBA へ逆変換しない。
- 雲頂圧の集計 bin は ISCCP と揃えて low `CTP >= 680 hPa`、middle `440 <= CTP < 680 hPa`、high `CTP < 440 hPa` とする。光学厚は `τ < 3.6`、`3.6 <= τ <= 23`、`τ > 23` とし、雲頂 bin × optical-depth bin の 9-cell histogram を生成・観測で共通に出力する。
- 最初の gate は cloud fraction、spatial spectrum、風で位置合わせした advected lag correlation、motion speed、CTP×τ 9-cell histogram の 5 指標に絞る。寿命は浅いセルの 30/60/120 分、深い cell の 1/3 時間、MCS の 3/6/12/24 時間などクラス別の lag で評価するが、object split/merge、threshold sensitivity、完全な observation envelope はモデルが動いた後の較正段階へ回す。相関だけでなく分布・スケールを必ず併記する。
- 静止衛星画像から相・高度を一意に復元したとは扱わない。画像分離は art-initialization、衛星の雲頂・光学プロダクトは forward-validation と明示的に分ける。

初期 gate の適用可能性は次の matrix を manifest に持つ。`必須` は適用データがあるときの calibration target、`対象外` は欠測を失敗にしないことを表す。決定性・seam・メモリ・qualified GPU は全 regime に共通する hard invariant とする。

| regime / 指標 | cloud fraction / spectrum / advected lag / motion | CTP・height・temperature・phase | visible τ / CTP×τ | object survival / split / merge |
| --- | --- | --- | --- | --- |
| trade cumulus | 必須 | product がある場合 | daylight/product がある場合 | 高解像度 object-series で必須 |
| marine stratocumulus | 必須 | product がある場合 | daylight/product がある場合 | 高解像度 object-series で必須 |
| temperate front | 必須 | 必須 | product がある場合 | mesoscale 中心、object は補助 |
| deep convection / MCS | 必須 | 必須 | 必須 | object と split/merge を必須 |
| upper cirrus | 必須 | IR/product がある場合 | visible は daylight のみ | 対象外または補助 |
| high-latitude mixed phase | 必須 | product がある場合 | low-sun/daylight のみ | 対象外または補助 |

`tools/cloud-analysis-buffer.mjs`（新規）は、512² mesoscale bake だけでは表現できない浅い cell のために、field と world-space sub-grid を同じ state/epoch から評価する高解像度 deterministic analysis buffer を出力する。`cloud-temporal-metrics` の object-series はこの buffer を入力にし、512² field だけから浅い cell の survival を主張しない。

## 達成目標

1. 同じ天体・同じ絶対時刻・同じ座標を、異なる時間倍率・フレーム刻み・評価順で再計算しても同じ field/state になる。
2. 6 regime の適用可能な指標について、モデルが観測同士の q2.5〜q97.5 包絡と manifest 固定の測定許容幅へ近づく。欠測・昼夜・解像度で適用外の指標を失敗扱いにせず、適用 matrix と未評価理由を出力する。決定性、seam、cap/memory、qualified GPU は別の hard invariant とする。
3. 2,000 km の検証窓で、総観 forcing の初期 3 日（探索 2〜5 日、long tail 5〜7 日）、メソ組織の初期 12 時間（探索 4〜24 時間）、雲セルの初期 60 分（種類別 30〜180 分）、sub-grid detail の初期 30 分（探索 15〜45 分）が別々の統計として確認できる。物体クラス別 survival lag は浅いセル 30/60/120 分、深い cell 1/3 時間、MCS 3/6/12/24 時間で評価する。
4. R→G の遅延 5〜20 分、G→B の追加遅延 10〜30 分、core decay 30〜90 分、B/anvil の残留 4〜10 時間が、同じ対流起源の追跡表示と時系列 metrics で確認できる。高緯度の混相遷移も含める。
5. G 単独の中層雲、A 単独の巻雲、R 単独の低い厚い雲、R+G+B の深い対流が同じ基底契約で表現できる。密度の大小だけで雲底・雲頂が決まらず、雲頂圧 bin × τ bin の 9-cell histogram も生成できる。
6. 雲面・大気内雲・雲影が同じ `CloudState`、`CloudVerticalProfile`、`CloudOptics` を参照し、物理的な雲底・雲頂・相別光学量・水平位置を共有する。描画上の境界差は鉛直 300 m、水平 2 field texel 以内、影の重心は別の shadow tolerance 以内とする。斜光、地平線、明暗境界で層の割れや許容幅を超える影のずれがない。
7. 高度 profile は 0〜20 km の安全範囲で積分可能であり、対流圏界面付近の水平拡散と overshoot の境界が連続する。
8. 実行時雲 cap は 512×512 RGBA16F 一枚、約 2 MiB のまま。雲追加コストは cloud-lab の 1024×512 bake profile、既存 render-lab の 960×540 profile、代表ゲーム画面の 1920×1080 profile で測る。`cloudBake + cloudSurface + cloudShadow + (atmosphere on − atmosphere off)` の steady-frame p95、bake-spike p95、anchor 間の amortized cost を通常速度と最大 time warp について別々に保存し、最終の GPU p95 は 4.0 ms 以下かつ Step 2 baseline の 1.25 倍以下とする。`atmosphere` は現状 cloud-enabled composite なので on/off の対応測定を保存し、合成パス全体の値も併記する。通常・地平線・solar elevation 5°以上の低太陽・最大雲量・深い対流多数を hard qualification とし、5°未満は診断値として別記録する。GPU timestamp 非対応は機能テストを失敗させず、性能 qualification を `unqualified` とする。
9. `npm run typecheck`、`npm run test:render`、6 regime × 3 cadence の時系列比較、観測可能量の forward metrics、再現可能なスクリーンショットを同じ入力 manifest から生成できる。

## 手順

### Step 1 — 観測可能な振る舞いを SPEC に固定する

**目的**

実装方式より先に、四つの時間・空間階層、絶対時刻からの決定性、液相から氷相への連続発達、二種類の上層氷雲、鉛直シア、中層雲底、対流圏界面と 20 km 上限を仕様として確定する。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `DEVELOP/SPEC/RENDERING.md:435` 付近 | 目的欄の 5 つの振る舞いを、内部クラス名・RGBA 配置・固定寿命に依存しない画面上の契約として追加する。既存の動的生成、高度別風、決定性の記述と統合する。 |

**達成条件と検証**

- 仕様が「総観場」「組織化成分」「中間スケールの雲群」「雲セル」を区別し、単一の 24 時間寿命や 7 日周期を要求していない。
- 同一時刻の決定性、時間加速、高度別風、既存の雲種多様性と矛盾しない。
- `npm run typecheck`
- SPEC だけの独立 commit にする。

### Step 2 — 最小観測 baseline、適用 matrix、性能基準を作る

**目的**

雲の寿命と模様の持続を主観だけで調整せず、観測と生成を同じ窓・同じ統計で測れるようにする。実装前は最小 baseline と hard invariant を作り、詳細な物体追跡・threshold sensitivity・完全な observation envelope はモデルが動いた後の較正へ残す。6 regime × 3 cadence の manifest schema はここで確定するが、初期走査は代表 3 regime × 2 cadence として時間を抑える。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `tools/cloud-lab-reference.mjs` | 6 regime、object/mesoscale/synoptic の三時系列、約 2,000 km の大円窓、source pixel size、cadence、衛星・チャンネル・時刻・投影・出典、metric applicability matrix を manifest 化する。GOES ABI の 0.5/1/2 km と 10/5/1 分の条件を manifest の選択肢にする。初期 baseline は代表 3 regime × 2 cadence、後から全 matrix へ拡張する。 |
| `tools/cloud-lab-compare.mjs`、`tools/cloud-lab/lab.ts` | object の 1〜5 分、mesoscale の 10〜30 分、synoptic の 3〜6 時間を別 capture set として比較する。検証 cap は現行の `CAP_RADIUS=20°`（直径約 4,450 km）から、地球半径に対して `radius≈9°`（大円直径 `2Rθ≈2,002 km`、中心付近の nominal scale `2R sin(θ)/512≈3.9 km/texel`）へ変更し、端部の scale と実際の投影値を manifest へ保存する。0 / 6 / 12 / 24 / 48 / 72 時間 contact sheet は synoptic の補助出力とし、時刻 0 固定の比較を合否根拠にしない。 |
| `tools/cloud-temporal-metrics.mjs`（新規） | 最初は cloud fraction、spatial spectrum、風で位置合わせした advected lag correlation、motion speed、CTP/τ 9-cell histogram の 5 指標を計算する。object survival、split/merge、threshold sensitivity は後段の較正で追加する。 |
| `tools/cloud-analysis-buffer.mjs`（新規） | field と world-space sub-grid を同じ state/epoch から評価する高解像度 deterministic buffer を出力し、object-series の入力とする。512² bake だけから浅い cell の物体寿命を測らない。 |
| `tools/cloud-observation-envelope.mjs`（新規） | 初期は observation-to-observation の分割方法、欠測、前処理、metric applicability を manifest/JSON に保存する。q2.5〜q97.5 envelope と threshold sensitivity の詳細計算は Step 5 の較正段階で有効化する。 |
| `tools/cloud-lab/lab.ts`、`tools/cloud-lab/views.ts` | 絶対時刻の複数時点を同じ投影・露出・検証窓で出力する。`EquirectProjection(1024×512)` と `OrthographicCap(512×512)` を manifest 上で区別し、三つの capture set を別々に扱う。 |
| `tools/render-lab-measure.mjs`、`tools/perf-probe.mjs`、`src/render/gpu-timings.ts` | 1024×512 bake profile、既存 render-lab の 960×540 profile、代表ゲーム画面の 1920×1080 profile で cloudBake/cloudSurface/cloudShadow と atmosphere の on/off 対応を保存する。通常速度・最大 time warp の steady p95、bake-spike p95、amortized cost を分ける。最大 time warp は `src/game/dynamic/sim-speed-manager.ts` の `SIM_SPEED_LEVELS` から取得し、helper に古い写しを残さない。timestamp 非対応は `unqualified` と記録する。 |
| `package.json` | 観測取得、包絡計算、時系列比較、性能基準生成を再実行する script を追加する。 |
| `tests/render/cloud-temporal-metrics.test.ts`（新規） | 静止、平行移動、短寿命、3 cadence の aliasing、CTP/τ 9-cell bin の小配列で初期 5 指標を固定する。分裂・併合・しきい値変動は後段 fixture として追加する。 |

**達成条件と検証**

- 6 regime × 3 cadence を同じ manifest schema から再取得・再計測でき、初期 baseline は代表 3 regime × 2 cadence で再現できる。source 解像度と model の中心付近 3.9 km/texel nominal scale を混同しない。
- 静止模様、平行移動だけの模様、短寿命模様を初期 5 指標が区別する。object-series は analysis buffer の provenance を必ず持つ。
- 初期 5 指標、適用 matrix、CTP/τ 9-cell histogram、対応測定から求めた 4.0 ms の絶対 GPU p95 予算、通常/max warp の bake cost、2 MiB cap の基準値が JSON に保存される。詳細な観測包絡・threshold sensitivity・object split/merge は Step 5 で追加できる。
- 既存モデルの基準値を保存し、改修後は同じ入力・同じ機器・同じ画質で比較する。
- `npm run typecheck`
- `npm run test:render`
- 新しい観測包絡・時系列比較・性能基準コマンド
- 計測基盤を独立 commit にする。

### Step 3 — 絶対時刻の境界と、総観場から分離したライフサイクルを入れる

**目的**

現在の表示用相対時刻が生成関数へ漏れないよう境界を作り、数日続く総観 forcing の上へ、4〜24 時間のメソ組織、0.5〜3 時間の雲セル、0.25〜1 時間の sub-grid detail、対流から遅れて 4〜10 時間残る anvil を決定的に重ねる。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/game/display-window-manager.ts`、`src/game/celestial/solar-system/earth-system.ts` | `epochUnixMs` と表示カーソルを分離し、雲モデルへ渡す絶対時刻を一箇所で組み立てる。既存の UTC 表示用秒は表示専用として残す。 |
| `src/game/game-presentation.ts`、`src/game/celestial/celestial-system.ts`、`src/render/celestial/celestial-entity/point-celestial-view.ts`、`src/render/cloud/cloud-presentation.ts`、`src/render/cloud/generated-cloud-field.ts`、`src/render/cloud/observed-cloud-field.ts` | 現在の `displayTime` 配線を絶対時刻の受け渡しへ更新する。生成 field の cache key と `WeatherModel.syncTime()` を `dayIndex/secondsOfDay` を含む weather time へ移し、観測 field は絶対時刻に依存しない静的 source として同じ interface で受ける。`generated-cloud-field` の bake cache は毎フレームの秒を key にせず、10 simulation 分の `CloudBakeAnchor` を bake key、anchor 間の deterministic transport/interpolation を frame state にする。 |
| `src/render/cloud/weather-time.ts`（新規） | `epochUnixMs` を `dayIndex`、`secondsOfDay`、季節位相へ正規化する。GPU へは分解した値だけを渡し、整数精度を失う巨大 float を使わない。 |
| `src/render/cloud/cloud-model-parameters.ts`（新規） | 上表の採用済み時間定数、R→G→B の遅延、core/anvil の減衰、profile/phase、tropopause、wind height、optics、sub-grid の runtime 値だけを immutable に持つ。探索範囲・観測根拠・regime applicability は `tools/cloud-lab/calibration-spec.ts`（新規）に置き、runtime bundle は import しない。 |
| `src/render/cloud/cloud-lifecycle.ts`（新規） | 絶対時刻と空間 seed から cohort の年齢、連続な発生・成長・衰弱の重み、メソ組織の envelope を返す純粋計算を置く。単一の固定刻み・24 時間寿命に固定しない。 |
| `src/render/cloud/cloud-lifecycle-node.ts`（新規） | lifecycle と同じパラメータ化を TSL ノードへ写し、CPU/TSL の意味を共有する。 |
| `src/render/cloud/circulating-noise.ts`、`src/render/cloud/circulation.ts` | 長寿命の循環・総観 forcing と、短寿命 cohort の seed を分離する。雲模様へ直接 7 日周期を掛ける項を除く。 |
| `src/render/cloud/weather-transport.ts` | 上記の絶対時刻から各高度の発生源を後方移流する。単一 cap の anchor field を anchor 間で world-space transport し、lifecycle 係数を補間する。高周波は height-specific `U(z)` で back-advect する。単一模様の cross-fade で寿命を代用しない。 |
| `src/render/cloud/atmospheric-wind.ts`、`src/render/cloud/weather-model.ts`、`src/render/cloud/wind-law.ts`、`src/render/cloud/convective-activity.ts` | 固定幾何高度 1.4/5.5/10.5 km の 3 anchor を通る連続 `U(z)` へ拡張する。850/500/250 hPa は label として manifest に残す。強風 tail と B の outflow/divergence を weather model の対流 activity から分離して適用する。cohort transport は frozen local wind の一回の球面変位で実装し、反復 RK を導入しない。 |
| `src/render/cloud/weather-model.ts`、`src/render/cloud/condensation.ts`、`src/render/cloud/cyclones.ts` | 総観 forcing、湿度、対流活動、cohort 年齢から基底係数を生成する。R/G/B の初期値表にある遅延・減衰順と A の独立発生をここで確定する。 |
| `tests/render/cloud-lifecycle.test.ts`（新規）、`tests/render/weather-time.test.ts`（新規）、`tests/render/weather-transport.test.ts`（新規）、`tests/render/atmospheric-wind.test.ts`、`tests/render/cyclones.test.ts` | ランダムアクセス、評価順、日境界、年境界、日付変更線・極付近、CloudBakeAnchor の cache/replay/skip、三高度の風、相ごとのピーク順、総観 forcing と雲寿命の独立性を固定する。上表の初期値・範囲、1.4/5.5/10.5 km anchor、低層 5 m/s・上層 25 m/s で 3 時間に約 216 km 相対移動する fixture、cohort phase を走査した平均 cloud fraction、分散、空間スペクトルが許容範囲で定常になること、world-space sub-grid の camera-motion invariance と 30 分 decorrelation も固定する。 |

**達成条件と検証**

- 同じ `epochUnixMs` を異なるフレーム刻み・時間倍率・評価順で求めても同じ値になる。`displayTime` 単独で生成結果が決まる入口がない。
- dayIndex/secondsOfDay の日境界・季節境界、球面の dateline/pole で位置が跳ばない。
- 同じ時刻をフレーム刻みを変えて評価しても bake 回数が anchor crossing のみに依存し、通常速度・最大 time warp で steady、spike、amortized の計測値を再現できる。複数 anchor を飛び越えた時は target anchor 一回だけを要求する。
- sub-grid は camera movement で泳がず、各高さの風に沿って back-advect される。30 分前後の decorrelation は world-space detail の相関で確認する。
- R の発達後に G/B が増え、衰弱時は R/G が B より先に消える。A は R/G がなくても発生する。
- 6 regime の観測包絡へ近づく前提となる四つの時間・空間階層が、各指標で分離して出力される。初期値は上表どおりに再現でき、物体クラス別 survival lag で 24 時間後の残存率を代用しない。
- `npm run typecheck`
- `npm run test:render`
- `weather-time boundary`、`lifecycle`、`transport/wind`、`basis generation` を 2〜8 時間程度の意味単位で独立 commit にする。

### Step 4A — RGBA 基底、温度・相、積分可能な共通 profile を確定する

**目的**

RGBA を高度や雲種 ID として直接読む方式をやめ、温度・対流圏界面・基底係数から連続した雲体を復元する。三つの描画経路が参照する state/profile と、CPU/TSL の数値契約を先に固定する。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/cloud-field-sample.ts`、`src/render/cloud/cloud-field.ts`、`src/render/cloud/cloud-field-sampler.ts`、`src/render/cloud/baked-field.ts`、`src/render/cloud/field-projection.ts` | `lowBasis / midBasis / convectiveAnvilBasis / inSituCirrusBasis` の 4 基底契約へ移行する。encode/decode を一箇所で対にし、空の既定値は RGBA 全て 0 とする。HalfFloat の runtime cap、投影ごとの解像度、512 cap を mesoscale envelope、shader detail を sub-grid とする境界をここで確定する。 |
| `src/render/cloud/cloud-state.ts`（新規）、`src/render/cloud/cloud-field-sample.ts`、`src/render/cloud/cloud-environment.ts`（新規） | `CloudFieldSample`（RGBA basis + seed）、`CloudEnvironment`（緯度・季節・anomaly・tropopause・phase anchor）、lifecycle/時刻を合成した共有 state を定義する。runtime 採用値は `CloudModelParameters`、探索範囲は calibration tool 側へ分離する。 |
| `src/render/cloud/cloud-temperature-profile.ts`（新規） | 緯度・季節・総観 anomaly から `z0C/z-10C/z-30C/z-40C/tropopause` の温度 anchor を CPU/bake で求める。shader へ full `T(z)` を渡さず、phase 用の補間係数を作る。 |
| `src/render/cloud/cloud-pressure-profile.ts`（新規） | 1.4/5.5/10.5/16 km と 850/500/250/100 hPa の共通 log-linear mapping を作り、render profile と forward-validation の CTP 変換を一箇所に閉じ込める。 |
| `src/render/cloud/cloud-vertical-profile.ts`（新規） | compact-support C1 piecewise polynomial / smoothstep basis を最大 4 個評価し、任意高度の liquid/ice column basis、phase fraction、雲底・雲頂、区間積分係数を返す。optics は返さず、0〜20 km で安価に積分可能にする。 |
| `src/render/cloud/cloud-vertical-profile-node.ts`（新規） | `CloudState` の共通 parameter object を TSL へ渡す adapter を作る。式の二重実装は避けられない箇所を明記し、意味の source of truth は state/parameter に置く。 |
| `src/render/cloud/cloud-shape-evaluator.ts`、`src/render/cloud/cumulus-shape.ts`、`src/render/cloud/cloud-cap.ts` | 単一の固定雲頂面から profile の占有率・密度・勾配へ移行する。cap は必要範囲を確保しつつ 20 km を超えない。 |
| `src/render/cloud/cloud-optics-parameters.ts`（新規）、`src/render/cloud/cloud-render-input.ts`、`src/render/cloud/cloud-presentation.ts` | `CloudState`/profile binding と `CloudOpticsParameters` を雲面・大気・影へ同一参照で渡す。path 固有に state/profile/optics を再生成しない。 |
| `tests/render/cloud-field-sample.test.ts`（新規）、`tests/render/cloud-state.test.ts`（新規）、`tests/render/cloud-temperature-profile.test.ts`（新規）、`tests/render/cloud-vertical-profile.test.ts`（新規）、`tests/render/cloud-parity.test.ts`（新規） | RGBA 往復、単独/複合成分、極域/温帯/熱帯の高度支持範囲、対流圏界面 8/12/17 km、6.5 K/km と対流 4〜5 K/km、`+0/-5/-20/-35/-45°C` の phase fixture、積分可能性、20 km cap、共通 parameter object、1000 件以上の random input による CPU/TSL parity、経路間 state identity を固定する。 |

**達成条件と検証**

- R/G/B/A の単独・複合入力が達成目標 5 の形になり、全 0 は完全な晴天になる。雲物体の細部は sub-grid detail と field envelope の担当境界が manifest に残る。
- 高度方向の basis、phase は基底境界と温度 anchor で連続し、G 単独の中層雲が地表へ伸びない。1 profile evaluation あたり最大 4 basis、transcendental なし、区間積分係数が CPU/TSL で一致する。
- CPU と TSL で同じ 1000 件以上の入力から得る profile パラメータの差が宣言した許容誤差内にある。
- `npm run typecheck`
- `npm run test:render`
- 基底・profile・state を独立 commit にする。

### Step 4B — profile basis から光学量への契約を固定する

**目的**

Step 4A の geometry / condensate basis / phase を、renderer が使う extinction、scattering、asymmetry、optical depth へ一方向に変換する。profile が optics を返す循環を作らず、surface の「不透明」は相ではなく ray 上の累積 optical depth で決める。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/cloud-optics.ts`、`src/render/cloud/cloud-optics-node.ts`、`src/render/cloud/cloud-optics-parameters.ts` | liquid/ice column basis、phase fraction、`tauScaleLiquid=15`、`tauScaleIce=1` の初期 fixture、`reLiquid=10 µm`、`gLiquid=0.85`、`gIce=0.75`、氷晶実効粒径から extinction/scattering/τ を求める。coverage の直変換を除く。 |
| `tests/render/cloud-optics.test.ts` | basis 1 → 疑似 LWP 100 g/m² → τ 15、LWP sanity fixture、相・粒径感度、CPU/TSL parity、τ 3.6/23 の bin 境界、単独/複合 basis を固定する。`tauScaleIce` は neutral fixture であり、観測較正前に物理 IWP と解釈しない。 |

**達成条件と検証**

- profile は geometry/basis/phase だけを返し、optics は profile + `CloudOpticsParameters` だけから導出される。依存方向が profile → optics の一方向になる。
- `tauSurfaceOpaque=23` を初期値、探索範囲 20〜30 とし、surface は液相主体という条件を持たず、ray の累積 τ が閾値を初めて越えた交点を使う。G 単独の厚い中層雲、B 単独の厚い上層雲も対象になる。
- `npm run typecheck`
- `npm run test:render`
- optics 契約を独立 commit にする。

### Step 4C — 大気内雲の vertical slice を共通 profile の近似積分へ移行する

**目的**

大気内雲だけが固定高度殻を読む状態をなくし、同じ profile をレイ順に積分する。ここで新 profile を大気内雲だけに接続して GPU 計測する vertical slice を完成させ、surface/shadow 展開前に ALU、steady cost、bake spike、horizon cost が予算内か判定する。ただし surface や shadow と同じサンプル数・積分アルゴリズムは強制せず、大気の品質段階に応じた近似を許す。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/cloud-atmosphere-renderer.ts`、`src/render/pipeline/atmosphere-cloud-layers.ts` | 固定高度の積雲殻・巻雲殻を廃止し、同じ profile の区間をレイ順に積分する。高度交差を固定配列順で処理しない。 |
| `tests/render/cloud-atmosphere.test.ts`（新規） | profile の区間順、地平線、明暗境界、高度交差、CPU/TSL の大気入力を固定する。 |
| `tools/render-lab-measure.mjs`、`src/render/gpu-timings.ts` | atmosphere-only vertical slice を 960×540 と 1920×1080 で測り、通常速度/max warp の steady p95、anchor crossing の bake spike p95、amortized cost を保存する。予算超過なら Step 4A の basis/profile へ戻って調整してから次へ進む。 |

**達成条件と検証**

- 大気内雲の雲底・雲頂・相・水平位置が Step 4A の state/profile と一致する。
- 斜め視点、地平線、solar elevation 5°以上で層の割れ・順序反転がない。5°未満は診断用の grazing/fade 域であり、境界一致の hard gate にしない。
- 低周波 bake は 10 simulation 分 anchor、30 分以下の detail は world-space back-advection という契約を守り、profile の 1 評価あたり ALU/サンプル予算を越えない。
- `npm run typecheck`
- `npm run test:render`
- atmosphere vertical slice と初回 GPU qualification を独立 commit にする。予算超過時は surface/shadow へ進まず、profile/optics を調整する。

### Step 4D — 雲面を共通 profile の交点へ移行する

**目的**

地表から詰まった柱という仮定を外し、同じ profile の累積 optical depth が `tauSurfaceOpaque` を初めて越える交点を描く。細部は 2〜4 iteration などの surface 用近似で求め、大気積分の sample 数を共有しない。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/opaque-cloud-surface-renderer.ts` | 固定 shell/柱の仮定を外し、profile の交点と勾配から雲面を描く。 |
| `tests/render/cloud-surface.test.ts`（新規） | 高い雲底、中層雲、深い対流、最初の交点、地平線を固定する。 |

**達成条件と検証**

- G 単独の中層雲が地面から生えず、R/G/B/A のどの厚い成分でも累積 τ が閾値を越えれば雲面の交点を持つ。深い対流の連続した塔・かなとこは複合 basis で表現する。
- 雲面の水平位置・雲頂は大気内雲と同じ state/profile を参照し、鉛直 300 m、水平 2 field texel の rendering tolerance 内で一致する。
- `npm run typecheck`
- `npm run test:render`
- 雲面経路を独立 commit にする。

### Step 4E — 雲影を共通 profile の低コスト光路近似へ移行する

**目的**

太陽光路で同じ state/profile を参照し、影用の少数 sample または effective layer へ近似する。完全な surface/atmosphere ray march を影へ複製しない。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/shadow/cloud-shadow-renderer.ts` | 太陽光路を同じ profile で積分し、相別の消散、2〜4 個の effective layer、早期終了を影用に選ぶ。 |
| `tests/render/cloud-shadow.test.ts`（新規） | 雲面との水平位置、相別光学、solar elevation 5°以上の精度域、5°未満の grazing/fade 域、影の seam/地平線を固定する。 |

**達成条件と検証**

- 雲影の濃さは同じ profile の消散量から生じ、別の雲底・雲頂定数を持たない。solar elevation 5°以上を精度保証域とし、影の重心差は manifest の shadow tolerance 内に収める。
- surface/atmosphere と同じアルゴリズムでなくても、同じ state/profile から同じ雲の影になる。
- `npm run typecheck`
- `npm run test:render`
- 雲影経路を独立 commit にする。

### Step 4F — 画質段階、vertical slice 後の最終性能を確定する

**目的**

画質段階を profile 積分サンプル数・早期終了へ対応させ、Step 2 と Step 4C の vertical slice で定めた絶対性能予算と baseline 比の両方を、全描画経路で満たす。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/graphics-settings.ts` | 既存の雲画質段階を profile 積分サンプル数・早期終了へ対応させ、データ契約は増やさない。 |
| `tools/render-lab-measure.mjs`、`src/render/gpu-timings.ts` | 1024×512 bake、960×540 render-lab、1920×1080 game profile の通常・地平線・solar elevation 5°以上の低太陽・5°未満の診断域・最大雲量・深い対流多数を測り、cloudBake/cloudSurface/cloudShadow と atmosphere on/off の p50/p95 を保存する。通常速度/max warp の steady、spike、amortized を分け、雲追加コストは `cloudBake + cloudSurface + cloudShadow + (on − off)` として計算し、合成パス全体も別に記録する。5°未満の診断域は性能・artifact の報告対象だが、境界一致の hard gate にはしない。 |

**達成条件と検証**

- 画質段階が profile sample 数・早期終了へ対応し、optics の parity は Step 4B の契約を再利用する。
- 雲追加コストの steady p95、bake-spike p95、amortized cost が各 profile で保存され、最終 GPU p95 が 4.0 ms 以下かつ Step 2 baseline の 1.25 倍以下になる。通常・地平線・solar elevation 5°以上の低太陽・最大雲量・深い対流多数、通常/max warp の全 qualified case で判定する。5°未満は診断値として保存する。timestamp 非対応は `unqualified` として機能テストを通し、qualification gate の対象外にする。
- 実行時 cap は 512×512 RGBA16F 一枚、約 2 MiB のまま。
- `npm run typecheck`
- `npm run test:render`
- `npm run cloud-lab:shot`
- optics/画質/性能を独立 commit にする。

### Step 5 — 観測雲入力を初期化と forward-validation に分離する

**目的**

観測画像から作る見た目用 field と、衛星プロダクトで行う forward-validation を分離する。観測入力も生成入力も同じ runtime state/profile 契約へ変換するが、画像だけで相・高度を確定したとは主張しない。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `tools/cloud-lab/separation-pipeline.ts`、`tools/cloud-lab/separate-main.ts`、`tools/cloud-lab/separate.html` | 単一画像から既定の R/G/B/A optical-column preset へ変換する最小 adapter を先に作る。推定不確実性、未観測の高度、入力画像のチャンネルを metadata に残す。4-way の自動 separation、不確実性付き高度推定 UI は後段または別計画とする。 |
| `src/assets/cloud-field.png` | 見た目初期化用のフォーマットとチャンネル metadata を更新する。旧 RGB asset の alpha=1 を A として再利用しない。runtime の RGBA16F cap と混同しない。 |
| `src/render/cloud/observed-cloud-field.ts` | 既存の観測 field を art-initialization の RGBA から `CloudState` へ変換する入口へ拡張し、生成雲と同じ全 0 の外側、線形フィルタ、profile 入力を使う。 |
| `tools/cloud-lab/views.ts`、`tools/cloud-lab/pane.ts`、`tools/cloud-lab/lab.ts`、`tools/cloud-lab/index.html` | R/G/B/A、液相/氷相、雲底/雲頂、合成光学量、cohort 追跡、object/mesoscale/synoptic の三時系列、CTP/τ 9-cell histogram を別表示する。CTP は `CloudPressureProfile` から forward に変換し、art adapter の推定値と混ぜない。 |
| `tools/cloud-lab/cloud-rendering-explainer.html` | 新しい基底契約、共有 state、三つの別積分器、art/validation の境界を説明する。 |
| `tools/cloud-lab-compare.mjs`、`tools/cloud-lab-shot.mjs` | 6 regime、時系列 contact sheet、適用 matrix、差分画像、GPU 基準を同じ manifest から出力する。詳細な観測包絡と object split/merge は初期 adapter の完了後に有効化する。 |

**達成条件と検証**

- 観測画像の初期推定と衛星の forward-validation が出力・説明・コマンド上で分離される。
- 6 regime の object (1〜5 分、1〜3 h)、mesoscale (10〜30 分、6〜24 h)、synoptic (3〜6 h、72 h〜5 d) の contact sheet が生成され、0 / 6 / 12 / 24 / 48 / 72 時間表示も再現できる。object の画像は analysis buffer の provenance を持つ。
- 適用可能な指標、cloud-top pressure/height/temperature/phase、visible optical depth、CTP/τ 9-cell histogram を regime 別に表示し、対象外・欠測・未較正を失敗と混同しない。適用可能な calibration target を外れた regime は平均化せず、理由付きで失敗として出す。
- 発達中の対流を追跡するビューで R→G→B、鉛直シア、B の残留、A の独立発生が連続して見える。
- `npm run typecheck`
- `npm run test:render`
- `npm run cloud-lab:separate`（初期段階は既定 preset adapter と metadata の出力に限定し、高度 separation の自動推定は有効化しない）
- `npm run cloud-lab:compare`
- `npm run cloud-lab:shot`
- `windHeightAnchors`/速度/outflow → 移流補正済み lifecycle (`tau*`, delay, decay) → vertical profile（温度 anchor、support、tropopause）→ optics（`tauScale*`, 粒径、phase）→ cloud fraction/appearance の順に calibration し、各段階の採用 parameter を manifest に freeze する。観測 adapter、forward-validation、較正を独立 commit にする。

### Step 6 — 規約、コメント、性能、達成目標を最終監査する

**目的**

互換処理、旧チャンネル名、固定高度、重複した profile/optics 式、表示時刻依存を残さず、計画の達成目標とコードの境界を一致させる。

**変更箇所**

| 対象 | 変更 |
| --- | --- |
| Step 2〜5 で触れたファイル | `/refactor` の規則に従い層、依存方向、状態所有者、CPU/TSL adapter、重複、例外を点検する。 |
| 雲関連の定数・識別子 | `coverage / cloudTop / translucent`、固定 15〜16 km の殻、雲模様へ直接かかる 7 日周期、表示用 `displayTime` を生成へ渡す入口が旧意味で残っていないことを検索する。 |
| テストと fixture | 日境界、年境界、dateline、極、高緯度混相、R/G/B/A 単独、CPU/TSL、三経路 state identity、applicability matrix、観測 envelope、threshold sensitivity を一通り確認する。 |
| 性能計測 | Step 2 と同じ機器・カメラ・1024×512 bake、960×540 render-lab、1920×1080 game profile・画質で steady/spike/amortized の p50/p95、GPU 非対応状態、約 2 MiB cap を再測定する。 |

**達成条件と検証**

- `DEVELOP/CODING-RULE.md` と必要な境界について `DEVELOP/ARCHITECTURE.md` に適合する。例外は規則を書き換えず実施報告へ理由を残す。
- 旧契約、固定殻、固定高度の独自値、相関だけの合否判定、観測画像だけからの高度断定がない。
- 達成目標 1〜9 の証跡が同じ manifest、applicability matrix、JSON、画像、テスト出力から再生成できる。timestamp 非対応環境は `unqualified` として記録され、機能テストの合否と混ざらない。
- `npm run typecheck`
- `npm run test:render`
- 時系列比較、`npm run cloud-lab:compare`、`npm run cloud-lab:shot`
- 監査修正を独立 commit にする。

## 見積り

見積りは実装者 1 名、既存の cloud-lab と GPU 計測を再利用し、観測データ取得の待ち時間を除く作業時間である。Step 2 の代表 baseline と Step 4C の vertical slice で得られた実測値を、surface/shadow の展開前に更新する。Step 5 の高度 separation UI は含めない。

| Step | 導出 | 見積り |
| --- | --- | ---: |
| 1 | 仕様 5 項目 × 0.5 h + 整合確認 2 h | 4.5 h |
| 2 | 6 regime × 3 cadence の manifest schema 9 h + 初期 5 指標 5 h + representative baseline/perf 4 h + fixture 4 h | 22 h |
| 3 | absolute time/cache 10 h + lifecycle 12 h + wind/transport 10 h + tests 8 h | 40 h |
| 4A | state/environment/profile 16 h + basis/temperature/pressure/parity test 8 h | 24 h |
| 4B | optics contract 6 h + optics tests 4 h | 10 h |
| 4C | atmosphere profile 8 h + vertical-slice GPU measurement 6 h | 14 h |
| 4D | 雲面交点 5 h + surface テスト 3 h | 8 h |
| 4E | 影の effective layer 4 h + 影テスト 3 h | 7 h |
| 4F | 画質/全経路性能 5 h + 再測定 3 h | 8 h |
| 5 | preset adapter 6 h + lab UI/capture 8 h + applicability/calibration 8 h | 22 h |
| 6 | 規約/コメント/検索 4 h + 全目標の証跡確認 5 h + 性能再測定 4 h | 13 h |
| **合計** | 4.5 + 22 + 40 + 24 + 10 + 14 + 8 + 7 + 8 + 22 + 13 | **172.5 h** |

観測データの再取得、GPU 実機差、profile 積分の設計変更に 0〜25% の不確実性を見込む。Step 2 の実測後にだけ総額を更新し、値のない段階で縮めない。

## リスクと落とし穴

| リスク | 影響 | 表面化する Step / 対処 |
| --- | --- | --- |
| 総観場・組織化成分・雲群・雲セルを一つの寿命で扱う | 前線や低気圧まで消えるか、個々の雲が 7 日残る | Step 2/3。三時系列と四時間帯を別指標で測り、共通の寿命定数を置かない。 |
| `displayTime` や巨大な absolute float が seed へ入る | 再生速度・日境界・遠い日付で非決定、GPU 精度差が出る | Step 3。CPU の整数ミリ秒、GPU の dayIndex/secondsOfDay、ランダムアクセス試験で検出する。 |
| 秒ごとの weather time を bake cache key にする | 毎フレーム 512² bake、最大 warp で spike とメモリ帯域が破綻する | Step 3/4C。10 simulation 分の `CloudBakeAnchor`、anchor 間 transport、target-only bake、steady/spike/amortized の別計測を契約にする。 |
| 性能 helper の time-warp 定数が本体とずれる | 最大 warp の負荷測定が 33,554,432×ではなく 131,072×になり、bake spike を過小評価する | Step 2/3。`tools/perf-probe.mjs` を `src/game/dynamic/sim-speed-manager.ts` の `SIM_SPEED_LEVELS` から生成・参照するか、少なくとも最大値一致を test する。 |
| 固定間隔の cohort 境界が全球の脈動になる | 格子模様、発生日の帯、時刻境界の pop が見える | Step 3。空間 seed と連続窓、値と一階差分のテストを使う。 |
| cohort の cross-fade で平均・分散・スペクトルが脈動する | 固定周期で雲量やコントラストが上下し、寿命統計だけでは見逃す | Step 2/3。cohort phase を走査し、cloud fraction、分散、空間スペクトルの定常性を invariant test にする。 |
| RGBA を相・高度・質量へ直結する | 低い厚い雲、中層雲、高い薄い氷雲を誤る、任意 scale が隠れる | Step 4A/4B。基底は optical-column 係数に限定し、温度/profile から phase、`CloudOptics` の scale と粒径から光学量を導く。 |
| profile が点評価だけで積分不能 | 大気と影が別の近似を持ち、同じ雲でも明暗がずれる | Step 4A〜4E。区間積分係数と profile fixture を先に固定し、経路ごとの state identity をテストする。 |
| profile が Gaussian/β のまま実装者任せになる | `exp`/`pow` の ALU が地平線・複数 pass で膨らみ、後から契約変更になる | Step 4A/4C。compact-support piecewise polynomial、最大 4 basis、transcendental なしを hard contract にする。 |
| CPU と TSL が別の式になる | lab と本番 GPU だけ相境界・optics が変わる | Step 4A/4B/4F。共通 parameter object、1000 件以上の random parity test、TSL evaluator の限界を越える GPU fixture を置く。 |
| 温度・相を固定高度で近似する | 季節・緯度・高緯度混相で不自然な相転移が出る | Step 2/4A/6。温度 anchor と高緯度混相 regime、融解/凍結高度、季節別 envelope を含める。 |
| 圧力面 label と固定高度を同じ意味で扱う | CTP だけ別の大気モデルになり、render と validation が不一致になる | Step 2/4A/5。runtime wind は幾何高度、CTP は共有 `CloudPressureProfile` の log-linear mapping に限定する。 |
| screen-space または非移流の sub-grid noise | カメラ移動で shimmer し、30 分ごとに沸騰する | Step 3/4A。world-space、height-specific back-advection、band-limit/mip、camera-motion invariance を固定する。 |
| sphere transport を厳密積分しようとする | GPU 反復積分で性能・決定性を失う | Step 3。cohort 発生地点の frozen local wind と一回の球面 exponential-map displacement に近似を固定する。 |
| 高度変化で光学イベントの順序が反転する | 地平線付近で雲が消える、手前奥や影が逆転する | Step 4B〜4E。固定列挙順を使わず、レイとの交差距離・光路距離で積分する。 |
| 20 km cap を無制限に広げる | 大気積分、cap、影のコストと horizon artifact が増える | Step 4A〜4E/6。`min(20 km, tropopause + overshootDepth)` を共通契約にする。 |
| 画像分離結果を科学的な観測量と扱う | 擬似的な高度・相でモデルを誤較正する | Step 2/5。art-initialization と forward-validation の出力・コマンド・説明を分ける。 |
| 観測誤差をモデル誤差と数える | 単一画像への過学習、regime 間の失敗の隠蔽 | Step 2/5。observation-to-observation envelope と適用 matrix を使い、初期 gate と後段較正を分ける。 |
| 既存 GPU 基準が大気全体しか測れない | 雲の追加コストを見誤り 4.0 ms を超える | Step 2/4C/4F/6。cloudBake、surface、atmosphere、shadow を 1024×512、960×540、1920×1080 で分解し、timestamp 非対応は `unqualified` とする。 |
| effective layer を低太陽高度まで無制限に保証する | 水平投影誤差が増え、影の位置が破綻する | Step 4E/4F。solar elevation 5°以上を精度保証域、5°未満を grazing approximation/fade 域とする。 |
| 512 cap を個別雲の解像度と誤認する | object-series の寿命・面積を field texel の統計と誤比較する | Step 2/4A/5。mesoscale envelope と sub-grid detail の担当範囲、物体抽出の解像度を manifest に残す。 |
| 512 cap と 4096×2048 source asset を混同する | メモリ見積り、線形フィルタ、asset loader が不整合になる | Step 4A/6。runtime cap の 2 MiB と初期化元のファイル形式を manifest とテストで別管理する。 |
| 球面の極・日付変更線で後方移流が不連続になる | 雲が極や seam で跳ぶ、相ごとの位置がずれる | Step 3。球面 position/transport を dateline/pole の property test と screenshot で検証する。 |

## 今回の範囲外

- 全球格子の流体方程式、データ同化、予報精度を目的とした NWP の導入。
- 降水量、雷、冷気外出流をゲーム規則へ接続すること。ライフサイクル内部の近似量として必要なら使うが、公開 gameplay state にはしない。
- 観測画像から一意な 3D 雲相・高度を復元すること。画像分離は見た目の初期化に限る。
- 地球以外の天体へ同じ雲相・対流圏界面を一般化すること。別天体の仕様変更は別計画にする。

# 気象学的な雲モデルへの改修計画

- 状態: 検査待ち（この文書の承認までは実装しない）
- 作成日: 2026-09-20
- 改訂日: 2026-09-20
- 調査基準: `0114373a7`
- 対象: 地球の生成雲、観測雲入力、雲面・大気内雲・雲影、cloud-lab

## 目的

約 2,000 km の検証窓で、総観場の配置は数日保ちながら、メソスケールの雲組織と個々の雲塊は時間単位から 1〜2 日の範囲で発生・発達・消滅する空を作る。雲塊の寿命を総観場の寿命から分離し、同じ絶対時刻から毎回決定的に再計算する。

深い対流では、低層の液相雲が中層の混相域を経て上層の氷雲・かなとこ・流出巻雲へ連続的に変わる。高度ごとの風によるずれ、雲相ごとの光学量、雲底・雲頂は、雲面・大気内雲・雲影が同じ `CloudState` と鉛直プロファイルを参照して表現する。ただし、三つの描画経路は同じ状態をそれぞれの積分器で評価してよい。

これは予報用の数値気象モデルではない。観測で見える時空間統計、雲相、高度別移流、光学的な見た目の関係を、絶対時刻から再現可能な軽量モデルで近似する。観測画像から作る入力は見た目の初期化用であり、科学的な鉛直量を画像だけから逆算したものとは扱わない。

完了時の `DEVELOP/SPEC/RENDERING.md` には、少なくとも次の振る舞いを内部名やチャンネル配置に依存しない形で正本として記す。

> 約 2,000 km の範囲では、気圧配置や曇りやすい領域が数日保たれる間にも、メソスケールの雲組織と個々の雲塊は時間単位から 1〜2 日の間隔で再編成され、同じ輪郭がそのまま 7 日残らない。

> 薄い雲と厚い雲、低い雲と中層から始まる雲は別々に存在できる。発達した対流雲では、低い雲底を持つ液相の塔が上へ成長し、中層で混相となり、上層で氷化してかなとこ・巻雲状の流出へ連続的に広がる。対流起源の上層氷雲と、上層で独立に生じる巻雲の両方がある。

> 一つの深い対流雲の中でも、低層の液相の塔、中層の混相部分、上層のかなとこはそれぞれの高度の風に乗り、鉛直シアに応じて連続的にずれる。対流が弱まると低層の塔が先に消え、上層氷雲は上層風へ流されながら薄くなる。

> 小さく薄い雲は低いとは限らず、中層に雲底を持つ雲塊が独立して存在できる。雲の濃さだけから雲底・雲頂を決めない。

> 深い対流雲の大半は局地的な対流圏界面付近で横へ広がり、強い芯だけが一時的にその上へ突き抜ける。上端には 20 km の安全上限を設ける。

## 決めたこと

### 時間階層と時刻契約

- シミュレーション上の時間を空間周波数の異なる四層に分ける。初期パラメータの探索範囲は、総観 forcing が 2〜7 日、組織化成分が 12〜36 時間、中間スケールの雲群が 2〜12 時間、解像する雲セル・雲塊が 0.25〜2 時間とする。これらは物体一個の見かけの寿命を一律に決める値ではなく、Step 2 の観測分布で regime 別に較正する。
- 2,000 km は固定カメラの画角ではなく、緯度経度を大円距離へ変換した検証窓の幅として固定する。runtime の cap 面積・投影はカメラから決まるため、検証窓と 512×512 cap の面積を同一視しない。
- 生成関数は `displayTime` や前フレームの状態を入力にしない。CPU の入口は整数ミリ秒の `epochUnixMs` とし、GPU へは精度を保てる `dayIndex` と `secondsOfDay` へ正規化して渡す。`displayTime` は絶対時刻を選ぶ再生カーソルに限定する。
- seed、forcing、cohort の年齢、日周期・季節周期は絶対時刻から算出する。時間倍率、フレーム刻み、任意時刻へのランダムアクセス、評価順が結果を変えないことを契約にする。
- 長寿命の総観場と短寿命の雲模様は別の状態として生成する。同じ field を 7 日周期で cross-fade して雲の寿命を作る方式は採らない。

### 雲場データ契約

RGBA は雲種 ID や絶対高度ではなく、鉛直プロファイルを再構成する無次元の連続基底とする。固定の「R=液相、G=混相」のように単一チャンネルを相の断定へ使わず、相は温度・高度・環境から導出する。

| チャンネル | 契約上の意味 | 主な寄与 |
| --- | --- | --- |
| R | 低層凝結基底 | 低い雲底、輪郭の明瞭な積雲、層積雲、対流の根元 |
| G | 中層凝結基底 | 雲底の高い小雲、発達中の塔、混相域へ入る成分 |
| B | 対流起源の上層凝結基底 | かなとこ、対流から流出する上層雲 |
| A | 上層で独立に生じる凝結基底 | in-situ の薄い巻雲・巻層雲 |

- 値は 0..1 に正規化した基底係数で、値を高度や雲種 ID として読み替えない。G 単独の中層雲、R 単独の低層雲、B 単独の対流残留雲、A 単独の巻雲を許す。
- R/G/B は一つの対流起源に属する場合、同じ seed と履歴からピーク時刻をずらして生成する。A は上層湿度・上昇・温度から独立に生成し、B と合成しても因果を失わない。
- 実行時の生成 cap は 512×512 の RGBA16F 一枚、約 2 MiB を上限とする。既存の 4096×2048 RGB/グレースケール画像は観測・見た目の初期化元であり、実行時 cap のメモリ契約ではない。追加の 3D 雲テクスチャは導入しない。
- 512×512 の `cloud-field` は総観・メソスケールの envelope を担当する。典型的な浅い積雲より細かい形状・エッジは、同じ絶対時刻と seed から shader の deterministic sub-grid detail として補う。したがって、この cap の texel を個々の浅い雲セルそのものと解釈せず、cell-series の物体統計は field の解像度と sub-grid の担当範囲を manifest に明記する。
- `CloudState` は基底係数、絶対時刻に基づく seed、局所緯度・季節、対流圏界面、雲相別の光学パラメータを保持する。雲面・大気内雲・雲影には同じ state/binding を渡す。path ごとのサンプル密度・積分順・早期終了は共有しない。

### 鉛直プロファイル、相、風

- `CloudVerticalProfile` は基底係数、緯度、季節、局地的な対流圏界面、温度プロファイルから、任意の高度で液相凝結量、氷相凝結量、雲底、雲頂、実効粒径を返す。点評価だけでなく区間積分または積分可能な係数を提供し、大気積分・雲影が profile を再実装しない。
- 温度は少なくとも地表・融解層・上層・対流圏界面の連続 profile とし、緯度・季節・総観 anomaly を入力にする。融解・凍結高度を別の固定定数にせず、液相と氷相の切替を連続化する。
- 対流圏界面は緯度・季節・総観場から変え、通常の B はその近傍で横へ広げる。強い芯の overshoot だけ `min(20 km, tropopause + overshootDepth)` で許す。
- 風は少なくとも地表近く・中層・上層の 3 anchor を連続補間し、対流の outflow/divergence を別の補正として持つ。一つの対流起源を共有したまま、各高度の風で水平位置をずらす。
- 光学量は coverage をそのまま `-log(1-coverage)` へ変換しない。液相・氷相の凝結量、実効粒径、密度、消散・散乱係数から光学的厚さを求め、低い厚い雲と高い薄い氷雲を同じ値域で表せる契約にする。

### 観測検証

- 6 regime を用意する: 貿易風積雲、海洋層積雲、温帯低気圧・前線、熱帯の深い対流/MCS、上層巻雲、高緯度の混相雲。最後の regime は低い太陽高度や氷・液相の共存を含める。
- 観測は二つの時系列に分ける。`cell-series` は 5〜15 分間隔で 1〜6 時間を追い、セル・塔の発生・衰弱・分裂を測る。`pattern-series` は 1〜3 時間間隔で 0〜72 時間を追い、総観配置・メソスケール組織・雲模様相関を測る。
- 生成と観測だけでなく、観測を時系列の前半/後半や近接軌道へ分割した observation-to-observation envelope を算出する。モデルの合否は単一画像への一致ではなく、観測同士のばらつき、測器・投影誤差、前処理誤差を含む regime 別 95% 包絡と比較する。
- 指標は時差相関、平均風で位置合わせした相関、相関 e-folding、クラス別の物体寿命・面積・移動速度、雲頂階級、光学量分布、空間スペクトル、cohort phase ごとの平均 cloud fraction/分散/スペクトルとする。寿命は浅いセルの 30/60/120 分、深い cell の 1/3 時間、MCS の 3/6/12/24 時間などクラス別の lag で評価し、相関だけでなく分布・スケールを必ず併記する。
- 静止衛星画像から相・高度を一意に復元したとは扱わない。画像分離は art-initialization、衛星の雲頂・光学プロダクトは forward-validation と明示的に分ける。

## 達成目標

1. 同じ天体・同じ絶対時刻・同じ座標を、異なる時間倍率・フレーム刻み・評価順で再計算しても同じ field/state になる。
2. 6 regime の `cell-series` と `pattern-series` について、モデルの各指標が観測同士の 95% 包絡に、宣言した測定許容幅を加えた範囲へ入る。単一 regime の改善で全体合格にしない。
3. 2,000 km の検証窓で、総観 forcing の 2〜7 日、組織化成分の 12〜36 時間、中間スケールの雲群の 2〜12 時間、雲セル cohort の 0.25〜2 時間が別々の統計として確認できる。物体クラス別 survival lag は浅いセル 30/60/120 分、深い cell 1/3 時間、MCS 3/6/12/24 時間で評価する。
4. R/G/B の発達・衰弱順、B の上層風による残留、A の独立発生、高緯度の混相遷移を、同じ対流起源の追跡表示で確認できる。
5. G 単独の中層雲、A 単独の巻雲、R 単独の低い厚い雲、R+G+B の深い対流が同じ基底契約で表現できる。密度の大小だけで雲底・雲頂が決まらない。
6. 雲面・大気内雲・雲影が同じ `CloudState` と `CloudVerticalProfile` を参照し、雲底、雲頂、相別光学量、水平位置が一致する。斜光、地平線、明暗境界で層の割れや影のずれがない。
7. 高度 profile は 0〜20 km の安全範囲で積分可能であり、対流圏界面付近の水平拡散と overshoot の境界が連続する。
8. 実行時雲 cap は 512×512 RGBA16F 一枚、約 2 MiB のまま。cloud-lab の 1024×512 標準設定・60 fps の 16.67 ms frame budget に対して、雲関連 `cloudBake + cloudSurface + cloudAtmosphere + cloudShadow` の GPU p95 は 4.0 ms 以下かつ Step 2 baseline の 1.25 倍以下とする。通常・地平線・低太陽・最大雲量・深い対流多数の全ケースで判定し、GPU timestamp 非対応時は未計測として不合格にする。
9. `npm run typecheck`、`npm run test:render`、6 regime の時系列比較、再現可能なスクリーンショットを同じ入力 manifest から生成できる。

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

### Step 2 — 6 regime の観測基準・計測器・性能基準を作る

**目的**

雲の寿命と模様の持続を主観だけで調整せず、観測と生成を同じ窓・同じ統計で測れるようにする。実装前に観測同士の許容包絡、固定検証窓、GPU の絶対予算を確定する。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `tools/cloud-lab-reference.mjs` | 6 regime、cell/pattern の二時系列、約 2,000 km の大円窓、衛星・チャンネル・時刻・投影・出典を manifest 化し、参照画像と雲頂/光学プロダクトを再取得できるようにする。 |
| `tools/cloud-lab-compare.mjs` | 0〜72 時間の同一投影比較と、平均風で位置合わせした比較を追加する。時刻 0 固定の比較を合否根拠にしない。 |
| `tools/cloud-temporal-metrics.mjs`（新規） | 相関、e-folding、物体寿命・面積・速度、雲頂階級、光学量、空間スペクトル、しきい値感度を計算する。 |
| `tools/cloud-observation-envelope.mjs`（新規） | 観測時系列の分割から observation-to-observation 95% 包絡と前処理誤差を計算する。 |
| `tools/cloud-lab/lab.ts`、`tools/cloud-lab/views.ts` | 絶対時刻の複数時点を同じ投影・露出・検証窓で出力する。cell-series と pattern-series を別の capture set とする。 |
| `tools/render-lab-measure.mjs`、`src/render/gpu-timings.ts` | cloudBake/cloudSurface/cloudAtmosphere/cloudShadow の p50/p95 を同じ機器・構図・画質で保存する。timestamp 非対応を明示的に失敗扱いにする。 |
| `package.json` | 観測取得、包絡計算、時系列比較、性能基準生成を再実行する script を追加する。 |
| `tests/render/cloud-temporal-metrics.test.ts`（新規） | 静止、平行移動、短寿命、分裂・併合、しきい値変動の小配列で指標と包絡判定を固定する。 |

**達成条件と検証**

- 6 regime × 2 時系列を manifest だけから再取得・再計測できる。
- 静止模様、平行移動だけの模様、短寿命模様を指標が区別する。
- 観測同士の 95% 包絡、モデル許容幅、物体クラス別 survival lag、しきい値感度、cohort phase に対する cloud fraction/分散/スペクトルの許容範囲、4.0 ms の絶対 GPU p95 予算、2 MiB cap の基準値が JSON に保存される。
- 既存モデルの基準値を保存し、改修後は同じ入力・同じ機器・同じ画質で比較する。
- `npm run typecheck`
- `npm run test:render`
- 新しい観測包絡・時系列比較・性能基準コマンド
- 計測基盤を独立 commit にする。

### Step 3 — 絶対時刻の境界と、総観場から分離したライフサイクルを入れる

**目的**

現在の表示用相対時刻が生成関数へ漏れないよう境界を作り、数日続く総観 forcing の上へ、12〜36 時間の組織化成分、2〜12 時間の雲群、0.25〜2 時間の cohort、対流の発達・衰弱を決定的に重ねる。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/game/display-window-manager.ts`、`src/game/celestial/solar-system/earth-system.ts` | `epochUnixMs` と表示カーソルを分離し、雲モデルへ渡す絶対時刻を一箇所で組み立てる。既存の UTC 表示用秒は表示専用として残す。 |
| `src/render/cloud/weather-time.ts`（新規） | `epochUnixMs` を `dayIndex`、`secondsOfDay`、季節位相へ正規化する。GPU へは分解した値だけを渡し、整数精度を失う巨大 float を使わない。 |
| `src/render/cloud/cloud-lifecycle.ts`（新規） | 絶対時刻と空間 seed から cohort の年齢、連続な発生・成長・衰弱の重み、メソ組織の envelope を返す純粋計算を置く。単一の 6 時間刻み・24 時間寿命に固定しない。 |
| `src/render/cloud/cloud-lifecycle-node.ts`（新規） | lifecycle と同じパラメータ化を TSL ノードへ写し、CPU/TSL の意味を共有する。 |
| `src/render/cloud/circulating-noise.ts`、`src/render/cloud/circulation.ts` | 長寿命の循環・総観 forcing と、短寿命 cohort の seed を分離する。雲模様へ直接 7 日周期を掛ける項を除く。 |
| `src/render/cloud/weather-transport.ts` | 上記の絶対時刻から各高度の発生源を後方移流する。単一模様の cross-fade で寿命を代用しない。 |
| `src/render/cloud/atmospheric-wind.ts`、`src/render/cloud/wind-law.ts` | 地表近く・中層・上層の 3 anchor と outflow/divergence を持つ連続風へ拡張する。 |
| `src/render/cloud/weather-model.ts`、`src/render/cloud/condensation.ts`、`src/render/cloud/cyclones.ts` | 総観 forcing、湿度、対流活動、cohort 年齢から基底係数を生成する。R/G/B の発達順と A の独立発生をここで確定する。 |
| `tests/render/cloud-lifecycle.test.ts`（新規）、`tests/render/weather-time.test.ts`（新規）、`tests/render/weather-transport.test.ts`（新規） | ランダムアクセス、評価順、日境界、年境界、日付変更線・極付近、三高度の風、相ごとのピーク順、総観 forcing と雲寿命の独立性を固定する。cohort phase を走査した平均 cloud fraction、分散、空間スペクトルが許容範囲で定常になることも固定する。 |

**達成条件と検証**

- 同じ `epochUnixMs` を異なるフレーム刻み・時間倍率・評価順で求めても同じ値になる。`displayTime` 単独で生成結果が決まる入口がない。
- dayIndex/secondsOfDay の日境界・季節境界、球面の dateline/pole で位置が跳ばない。
- R の発達後に G/B が増え、衰弱時は R/G が B より先に消える。A は R/G がなくても発生する。
- 6 regime の観測包絡へ近づく前提となる四つの時間・空間階層が、各指標で分離して出力される。物体クラス別 survival lag で 24 時間後の残存率を代用しない。
- `npm run typecheck`
- `npm run test:render`
- lifecycle と時刻境界を独立 commit にする。

### Step 4A — RGBA 基底、温度・相、積分可能な共通 profile を確定する

**目的**

RGBA を高度や雲種 ID として直接読む方式をやめ、温度・対流圏界面・基底係数から連続した雲体を復元する。三つの描画経路が参照する state/profile と、CPU/TSL の数値契約を先に固定する。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/cloud-field-sample.ts`、`src/render/cloud/cloud-field.ts`、`src/render/cloud/cloud-field-sampler.ts` | `lowBasis / midBasis / convectiveAnvilBasis / inSituCirrusBasis` の 4 基底契約へ移行する。encode/decode を一箇所で対にし、空の既定値は RGBA 全て 0 とする。512 cap を mesoscale envelope、shader detail を sub-grid として扱う。 |
| `src/render/cloud/cloud-state.ts`（新規） | 絶対時刻、基底、seed、局所環境、対流圏界面、相別光学パラメータを所有する共有 state を定義する。 |
| `src/render/cloud/cloud-temperature-profile.ts`（新規） | 緯度・季節・総観 anomaly から連続温度、融解/凍結高度、対流圏界面を求める。 |
| `src/render/cloud/cloud-vertical-profile.ts`（新規） | Gaussian/smoothstep/beta-like など積分可能な基底を選び、任意高度の液相/氷相凝結量、消散・散乱、実効粒径、雲底・雲頂、区間積分係数を返す。0〜20 km で積分可能にする。 |
| `src/render/cloud/cloud-vertical-profile-node.ts`（新規） | `CloudState` の共通 parameter object を TSL へ渡す adapter を作る。式の二重実装は避けられない箇所を明記し、意味の source of truth は state/parameter に置く。 |
| `src/render/cloud/cloud-shape-evaluator.ts`、`src/render/cloud/cumulus-shape.ts`、`src/render/cloud/cloud-cap.ts` | 単一の固定雲頂面から profile の占有率・密度・勾配へ移行する。cap は必要範囲を確保しつつ 20 km を超えない。 |
| `src/render/cloud/cloud-render-input.ts`、`src/render/cloud/cloud-presentation.ts` | `CloudState`/profile binding を雲面・大気・影へ同一参照で渡す。path 固有に state を再生成しない。 |
| `tests/render/cloud-field-sample.test.ts`（新規）、`tests/render/cloud-state.test.ts`（新規）、`tests/render/cloud-temperature-profile.test.ts`（新規）、`tests/render/cloud-vertical-profile.test.ts`（新規）、`tests/render/cloud-parity.test.ts`（新規） | RGBA 往復、単独/複合成分、温度による相遷移、積分可能性、20 km cap、共通 parameter object、1000 件以上の random input による CPU/TSL parity、経路間 state identity を固定する。 |

**達成条件と検証**

- R/G/B/A の単独・複合入力が達成目標 5 の形になり、全 0 は完全な晴天になる。雲物体の細部は sub-grid detail と field envelope の担当境界が manifest に残る。
- 高度方向の密度、相、消散係数は基底境界と凍結高度で連続し、G 単独の中層雲が地表へ伸びない。
- CPU と TSL で同じ 1000 件以上の入力から得る profile パラメータの差が宣言した許容誤差内にある。
- `npm run typecheck`
- `npm run test:render`
- 基底・profile・state を独立 commit にする。

### Step 4B — 大気内雲を共通 profile の近似積分へ移行する

**目的**

大気内雲だけが固定高度殻を読む状態をなくし、同じ profile をレイ順に積分する。ただし surface や shadow と同じサンプル数・積分アルゴリズムを強制せず、大気の品質段階に応じた近似を許す。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/cloud-atmosphere-renderer.ts`、`src/render/pipeline/atmosphere-cloud-layers.ts` | 固定高度の積雲殻・巻雲殻を廃止し、同じ profile の区間をレイ順に積分する。高度交差を固定配列順で処理しない。 |
| `tests/render/cloud-atmosphere.test.ts`（新規） | profile の区間順、地平線、明暗境界、高度交差、CPU/TSL の大気入力を固定する。 |

**達成条件と検証**

- 大気内雲の雲底・雲頂・相・水平位置が Step 4A の state/profile と一致する。
- 斜め視点、地平線、低い太陽高度で層の割れ・順序反転がない。
- `npm run typecheck`
- `npm run test:render`
- 大気経路を独立 commit にする。

### Step 4C — 雲面を共通 profile の交点へ移行する

**目的**

地表から詰まった柱という仮定を外し、同じ profile の液相主体で十分に不透明な最初の交点を描く。細部は 2〜4 iteration などの surface 用近似で求め、大気積分の sample 数を共有しない。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/opaque-cloud-surface-renderer.ts` | 固定 shell/柱の仮定を外し、profile の交点と勾配から雲面を描く。 |
| `tests/render/cloud-surface.test.ts`（新規） | 高い雲底、中層雲、深い対流、最初の交点、地平線を固定する。 |

**達成条件と検証**

- G 単独の中層雲が地面から生えず、R+G+B の雲面だけが深い対流の交点を持つ。
- 雲面の水平位置・雲頂が大気内雲と一致し、同じ state/profile から算出される。
- `npm run typecheck`
- `npm run test:render`
- 雲面経路を独立 commit にする。

### Step 4D — 雲影を共通 profile の低コスト光路近似へ移行する

**目的**

太陽光路で同じ state/profile を参照し、影用の少数 sample または effective layer へ近似する。完全な surface/atmosphere ray march を影へ複製しない。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/shadow/cloud-shadow-renderer.ts` | 太陽光路を同じ profile で積分し、相別の消散、2〜4 個の effective layer、早期終了を影用に選ぶ。 |
| `tests/render/cloud-shadow.test.ts`（新規） | 雲面との水平位置、相別光学、低い太陽高度、影の seam/地平線を固定する。 |

**達成条件と検証**

- 雲影の濃さは同じ profile の消散量から生じ、別の雲底・雲頂定数を持たない。
- surface/atmosphere と同じアルゴリズムでなくても、同じ state/profile から同じ雲の影になる。
- `npm run typecheck`
- `npm run test:render`
- 雲影経路を独立 commit にする。

### Step 4E — 光学契約、画質段階、性能を確定する

**目的**

基底係数を相別の光学量へ変換し、CPU/TSL の式を検証する。画質段階を積分サンプル数へ対応させ、Step 2 で定めた絶対性能予算と baseline 比の両方を満たす。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/cloud-optics.ts`、`src/render/cloud/cloud-optics-node.ts` | 液相/氷相凝結量、LWP/IWP 相当、固定または regime 依存の実効粒径、消散・散乱から光学量を求める。coverage 直変換を新契約から除く。 |
| `src/render/graphics-settings.ts` | 既存の雲画質段階を profile 積分サンプル数・早期終了へ対応させ、データ契約は増やさない。 |
| `tests/render/cloud-optics.test.ts` | 相別光学量、粒径感度、CPU/TSL parity、単独/複合基底の光学量を固定する。 |
| `tools/render-lab-measure.mjs`、`src/render/gpu-timings.ts` | 1024×512 の通常・地平線・低太陽・最大雲量・深い対流多数を測り、cloudBake/cloudSurface/cloudAtmosphere/cloudShadow の p50/p95 を保存する。 |

**達成条件と検証**

- 同じ凝結量でも実効粒径の違いが光学量へ反映され、低い厚い雲と高い薄い氷雲が区別できる。
- CPU と TSL の 1000 件以上の random input parity が許容誤差内にある。
- 雲関連 GPU p95 が 4.0 ms 以下、かつ Step 2 baseline の 1.25 倍以下になる。timestamp 非対応は未計測として不合格にする。
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
| `tools/cloud-lab/separation-pipeline.ts`、`tools/cloud-lab/separate-main.ts`、`tools/cloud-lab/separate.html` | 単一画像から R/G/B/A の初期基底を推定する。推定不確実性、未観測の高度、入力画像のチャンネルを metadata に残す。 |
| `src/assets/cloud-field.png` | 見た目初期化用のフォーマットとチャンネル metadata を更新する。旧 RGB asset の alpha=1 を A として再利用しない。runtime の RGBA16F cap と混同しない。 |
| `src/render/cloud/observed-cloud-field.ts` | 既存の観測 field を art-initialization の RGBA から `CloudState` へ変換する入口へ拡張し、生成雲と同じ全 0 の外側、線形フィルタ、profile 入力を使う。 |
| `tools/cloud-lab/views.ts`、`tools/cloud-lab/pane.ts`、`tools/cloud-lab/lab.ts`、`tools/cloud-lab/index.html` | R/G/B/A、液相/氷相、雲底/雲頂、合成光学量、cohort 追跡、cell/pattern の時系列を別表示する。 |
| `tools/cloud-lab/cloud-rendering-explainer.html` | 新しい基底契約、共有 state、三つの別積分器、art/validation の境界を説明する。 |
| `tools/cloud-lab-compare.mjs`、`tools/cloud-lab-shot.mjs` | 6 regime、時系列 contact sheet、観測包絡、差分画像、GPU 基準を同じ manifest から出力する。 |

**達成条件と検証**

- 観測画像の初期推定と衛星の forward-validation が出力・説明・コマンド上で分離される。
- 6 regime の 0 / 6 / 12 / 24 / 48 / 72 時間 pattern-series と、cell-series の短い contact sheet が生成される。
- 達成目標 2〜4 の指標を regime 別に表示し、観測包絡を外れた regime は平均化せず失敗として出す。
- 発達中の対流を追跡するビューで R→G→B、鉛直シア、B の残留、A の独立発生が連続して見える。
- `npm run typecheck`
- `npm run test:render`
- `npm run cloud-lab:separate`
- `npm run cloud-lab:compare`
- `npm run cloud-lab:shot`
- 観測入力と時系列較正を独立 commit にする。

### Step 6 — 規約、コメント、性能、達成目標を最終監査する

**目的**

互換処理、旧チャンネル名、固定高度、重複した profile/optics 式、表示時刻依存を残さず、計画の達成目標とコードの境界を一致させる。

**変更箇所**

| 対象 | 変更 |
| --- | --- |
| Step 2〜5 で触れたファイル | `/refactor` の規則に従い層、依存方向、状態所有者、CPU/TSL adapter、重複、例外を点検する。 |
| 雲関連の定数・識別子 | `coverage / cloudTop / translucent`、固定 15〜16 km の殻、雲模様へ直接かかる 7 日周期、表示用 `displayTime` を生成へ渡す入口が旧意味で残っていないことを検索する。 |
| テストと fixture | 日境界、年境界、dateline、極、高緯度混相、R/G/B/A 単独、CPU/TSL、三経路 state identity、observation envelope、threshold sensitivity を一通り確認する。 |
| 性能計測 | Step 2 と同じ機器・カメラ・1024×512・画質で p50/p95、GPU 非対応状態、約 2 MiB cap を再測定する。 |

**達成条件と検証**

- `DEVELOP/CODING-RULE.md` と必要な境界について `DEVELOP/ARCHITECTURE.md` に適合する。例外は規則を書き換えず実施報告へ理由を残す。
- 旧契約、固定殻、固定高度の独自値、相関だけの合否判定、観測画像だけからの高度断定がない。
- 達成目標 1〜9 の証跡が同じ manifest、JSON、画像、テスト出力から再生成できる。
- `npm run typecheck`
- `npm run test:render`
- 時系列比較、`npm run cloud-lab:compare`、`npm run cloud-lab:shot`
- 監査修正を独立 commit にする。

## 見積り

見積りは実装者 1 名、既存の cloud-lab と GPU 計測を再利用し、観測データ取得の待ち時間を除く作業時間である。Step 2 で得られた実測値を Step 4A 開始前に更新する。

| Step | 導出 | 見積り |
| --- | --- | ---: |
| 1 | 仕様 5 項目 × 0.5 h + 整合確認 2 h | 4.5 h |
| 2 | 6 regime × 2 時系列 × 0.75 h + 8 指標 × 1 h + 包絡/性能自動化 8 h + fixture 4 h | 25 h |
| 3 | 時刻境界 6 h + 4 時間帯/ライフサイクル 12 h + 三高度風/球面境界 8 h + テスト 8 h | 34 h |
| 4A | state/温度/profile 14 h + 基底/parity test 6 h | 20 h |
| 4B | 大気 profile 積分 8 h + 順序/画面テスト 4 h | 12 h |
| 4C | 雲面交点 5 h + surface テスト 3 h | 8 h |
| 4D | 影の effective layer 4 h + 影テスト 3 h | 7 h |
| 4E | optics/parity 7 h + 画質/性能 5 h + 再測定 2 h | 14 h |
| 5 | 初期化分離 7 h + lab UI/capture 7 h + 6 regime 較正 × 1.5 h + 再測定 4 h | 27 h |
| 6 | 規約/コメント/検索 4 h + 全目標の証跡確認 5 h + 性能再測定 4 h | 13 h |
| **合計** | 4.5 + 25 + 34 + 20 + 12 + 8 + 7 + 14 + 27 + 13 | **164.5 h** |

観測データの再取得、GPU 実機差、profile 積分の設計変更に 0〜25% の不確実性を見込む。Step 2 の実測後にだけ総額を更新し、値のない段階で縮めない。

## リスクと落とし穴

| リスク | 影響 | 表面化する Step / 対処 |
| --- | --- | --- |
| 総観場・組織化成分・雲群・雲セルを一つの寿命で扱う | 前線や低気圧まで消えるか、個々の雲が 7 日残る | Step 2/3。二時系列と四時間帯を別指標で測り、共通の寿命定数を置かない。 |
| `displayTime` や巨大な absolute float が seed へ入る | 再生速度・日境界・遠い日付で非決定、GPU 精度差が出る | Step 3。CPU の整数ミリ秒、GPU の dayIndex/secondsOfDay、ランダムアクセス試験で検出する。 |
| 6 時間ごとの cohort 境界が全球の脈動になる | 格子模様、発生日の帯、時刻境界の pop が見える | Step 3。空間 seed と連続窓、値と一階差分のテストを使う。 |
| cohort の cross-fade で平均・分散・スペクトルが脈動する | 6 時間周期で雲量やコントラストが上下し、寿命統計だけでは見逃す | Step 2/3。cohort phase を走査し、cloud fraction、分散、空間スペクトルの定常性を invariant test にする。 |
| RGBA を相・高度へ直結する | 低い厚い雲、中層雲、高い薄い氷雲を誤る | Step 4A。基底は係数に限定し、温度/profile/実効粒径から相と光学量を導く。 |
| profile が点評価だけで積分不能 | 大気と影が別の近似を持ち、同じ雲でも明暗がずれる | Step 4A〜4D。区間積分係数と profile fixture を先に固定し、経路ごとの state identity をテストする。 |
| CPU と TSL が別の式になる | lab と本番 GPU だけ相境界・optics が変わる | Step 4A/4E。共通 parameter object、1000 件以上の random parity test、TSL evaluator の限界を越える GPU fixture を置く。 |
| 温度・相を固定高度で近似する | 季節・緯度・高緯度混相で不自然な相転移が出る | Step 2/4A/6。高緯度混相 regime、融解/凍結高度、季節別 envelope を含める。 |
| 高度変化で光学イベントの順序が反転する | 地平線付近で雲が消える、手前奥や影が逆転する | Step 4B〜4D。固定列挙順を使わず、レイとの交差距離・光路距離で積分する。 |
| 20 km cap を無制限に広げる | 大気積分、cap、影のコストと horizon artifact が増える | Step 4A〜4D/6。`min(20 km, tropopause + overshootDepth)` を共通契約にする。 |
| 画像分離結果を科学的な観測量と扱う | 擬似的な高度・相でモデルを誤較正する | Step 2/5。art-initialization と forward-validation の出力・コマンド・説明を分ける。 |
| 観測誤差をモデル誤差と数える | 単一画像への過学習、regime 間の失敗の隠蔽 | Step 2/5。observation-to-observation envelope と threshold sensitivity を合否へ使う。 |
| 既存 GPU 基準が大気全体しか測れない | 雲の追加コストを見誤り 4.0 ms を超える | Step 2/4E/6。cloudBake、surface、atmosphere、shadow の範囲を明示し、timestamp 非対応は未合格にする。 |
| 512 cap を個別雲の解像度と誤認する | cell-series の寿命・面積を field texel の統計と誤比較する | Step 2/4A/5。mesoscale envelope と sub-grid detail の担当範囲、物体抽出の解像度を manifest に残す。 |
| 512 cap と 4096×2048 source asset を混同する | メモリ見積り、線形フィルタ、asset loader が不整合になる | Step 4A/6。runtime cap の 2 MiB と初期化元のファイル形式を manifest とテストで別管理する。 |
| 球面の極・日付変更線で後方移流が不連続になる | 雲が極や seam で跳ぶ、相ごとの位置がずれる | Step 3。球面 position/transport を dateline/pole の property test と screenshot で検証する。 |

## 今回の範囲外

- 全球格子の流体方程式、データ同化、予報精度を目的とした NWP の導入。
- 降水量、雷、冷気外出流をゲーム規則へ接続すること。ライフサイクル内部の近似量として必要なら使うが、公開 gameplay state にはしない。
- 観測画像から一意な 3D 雲相・高度を復元すること。画像分離は見た目の初期化に限る。
- 地球以外の天体へ同じ雲相・対流圏界面を一般化すること。別天体の仕様変更は別計画にする。

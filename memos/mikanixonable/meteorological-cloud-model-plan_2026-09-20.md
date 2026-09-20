# 気象学的な雲モデルへの改修計画

- 状態: 検査待ち（この文書の承認までは実装しない）
- 作成日: 2026-09-20
- 調査基準: `500f7ea3f`
- 対象: 地球の生成雲、観測雲入力、雲面・大気内雲・雲影、cloud-lab

## 目的

約 2,000 km の画角で、気圧配置のような総観規模の傾向は数日保ちながらも、個々の雲塊、晴れ間、雲頂の起伏は 24〜48 時間で大きく入れ替わる空を作る。同時に、低層の液相雲が発達して混相化・氷化し、かなとこ雲・巻雲状の流出へ連続的に移る過程と、高度ごとの風によるずれを、同じ雲の成長履歴として描く。

この改修は予報用の数値気象モデルを作るものではない。観測で見える時空間統計、雲相、高度別移流、光学的な見た目の関係を、表示時刻から決定的に再計算できる軽量モデルで再現する。

完了時の `DEVELOP/SPEC/RENDERING.md` には、少なくとも次の振る舞いを正本として記す。文言の調整が必要なら、意味を変えず Step 1 内で行う。

> 約 2,000 km の範囲では、気圧配置や曇りやすい領域が数日保たれる間にも、個々の雲塊・晴れ間・雲頂起伏は 24〜48 時間で生まれ替わり、同じ輪郭がそのまま移動して 7 日残らない。

> 薄い雲と厚い雲は別々に存在できる。一方、発達した対流雲では、低い雲底を持つ輪郭の明瞭な液相の塔が上へ成長し、中層で混相となって輪郭を失い、上層で氷化してかなとこ・巻雲状の流出へ連続的に広がる。対流起源の上層氷雲と、上層で独立に生じる巻雲の両方がある。

> 一つの深い対流雲の中でも、低層の液相の塔、中層の混相部分、上層のかなとこはそれぞれの高度の風に乗り、鉛直シアに応じて連続的にずれる。対流が弱まると低層の塔が先に消え、上層氷雲は上層風へ流されながら薄くなる。

> 小さく薄い雲は低いとは限らず、中層に雲底を持つ雲塊が独立して存在できる。雲の濃さだけから雲底・雲頂を決めない。

> 深い対流雲の大半は局地的な対流圏界面付近で横へ広がり、強い芯だけが一時的にその上へ突き抜ける。

## 調査から決めたこと

### 時間発展

- 約 2,000 km はメソスケール上端から総観規模下端に当たり、移流だけでも風速 10 / 20 / 40 m/s なら横断時間は約 56 / 28 / 14 時間になる。雲形の 24〜48 時間での大幅な更新は妥当な目標である。[UCAR MetEd: tropical weather scales](https://www.meted.ucar.edu/tropical/textbook_2nd_edition/print_7.htm)
- 雷雨セルや個々の対流雲の寿命は総観場より短い。一方、低気圧・前線・MCS の環境はより長く続き得るため、「気象場の寿命」と「凝結した雲模様の寿命」を分離する。[NWS: thunderstorm life cycle](https://www.weather.gov/spotterguide/life)、[Houze 2004: Mesoscale Convective Systems](https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2004RG000150)
- 状態を前フレームから積分する方式にはせず、絶対時刻で識別できる短寿命の雲コホートを重ねる。任意時刻へ直接移動しても同じ結果になり、時間倍率にも依存しないことを守る。
- 初期値は 6 時間間隔で発生する最大 4 世代、1 世代 24 時間とする。隣接世代は連続な窓関数で重ね、実測に合わせて間隔と寿命を調整する。4〜7 日規模の総観 forcing は別に残す。

### 雲相・RGBA 契約

WMO の分類でも、発達する積雲は輪郭の明瞭な `congestus` から、氷化して線維状になる `cumulonimbus capillatus` とかなとこへ連続する。[WMO: Cumulus congestus](https://cloudatlas.wmo.int/en/species-cumulus-congestus-cu-con.html)、[WMO: Cumulonimbus remarks](https://cloudatlas.wmo.int/explanatory-remarks-and-special-clouds-cumulonimbus.html)。また、巻雲には深い対流から流出するものと上層で独立に生じるものがある。[ACP: liquid-origin and in-situ cirrus](https://acp.copernicus.org/articles/18/17371/2018/)

RGBA16F の 4 チャンネルは雲種 ID や絶対高度ではなく、鉛直方向の連続した光学・凝結量の基底として使う。

| チャンネル | 意味 | 主な見た目・役割 |
| --- | --- | --- |
| R | 下層の液相凝結量 | 境界の明瞭な積雲・層積雲、深い対流の根元 |
| G | 中層の液相・混相凝結量 | 雲底の高い小雲、発達中の塔、氷化前後の遷移 |
| B | 対流起源の上層氷量 | 深い対流の上部、かなとこ、対流から流出する巻雲 |
| A | 上層で独立に生じる氷量 | 薄い巻雲、巻層雲 |

- 値は 0..1 へ有界化した量であり、値そのものを高度に読み替えない。小さい G だけでも中層の小雲になれ、濃い R だけなら低い層雲のままでいられる。
- R→G→B は同じ対流種・同じ時間履歴から、時間差を持って生成する。R+G+B の共存が深い対流を表し、R/G が先に減衰した後も B が残って上層風で流れる。
- A は上層湿度・上昇・温度から独立に生成し、B と混ざっても描画上の不連続を作らない。
- 「R=積雲、G=巻雲で、濃さを高さにも使う」案は、光学的に厚い低い雲と、薄い中層雲を区別できないため採らない。雲頂圧と光学的厚さを独立軸にする衛星雲分類とも整合しない。[NASA ISCCP cloud types](https://isccp.giss.nasa.gov/cloudtypes.html)
- 1 枚の 512×512 RGBA16F を維持するため、雲場本体は 2 MiB のままにする。追加の RGBA 雲テクスチャや 3D テクスチャは導入しない。

### 鉛直形状と風

- 4 成分と緯度・季節から、共通の `CloudVerticalProfile` が高度ごとの液相密度、氷相密度、消散係数、雲底・雲頂を返す。下層・中層・上層を固定した板として別々に描かず、隣接する基底を連続補間する。
- 地表から連続していると仮定しない。R は低い雲底、G 単独なら地面から離れた雲底、B/A は上層の氷雲になる。
- 対流圏界面は緯度・季節で変え、通常の B はその近傍で横へ広げる。R+G+B が強い局所的な芯だけは、上限 20 km の範囲でオーバーシュートを許す。
- R、G、B/A はそれぞれ下層・中層・上層の風で移流する。一つの対流起源を共有したまま、鉛直シアに応じて位置が滑らかにずれる。衛星の風ベクトルも雲頂高度別に下層・中層・上層へ割り当てられる。[NOAA GOES-R Derived Motion Winds](https://goes-r.noaa.gov/products/baseline-derived-motion-winds.html)
- 雲面、大気積分、雲影はすべて同じ鉛直プロファイルを読む。経路ごとに別の固定高度や別の厚みを持たせない。

### 検証方針

- NOAA/NCEI の静止気象衛星画像から、約 2,000 km の同一領域を 0 / 6 / 12 / 24 / 48 / 72 時間で切り出す。対象は、貿易風積雲、海洋層積雲、温帯低気圧・前線、熱帯の深い対流/MCS、上層巻雲の 5 regime とする。[NOAA/NCEI ISCCP-H](https://www.ncei.noaa.gov/products/international-satellite-cloud-classification)、[NOAA STAR cloud products](https://www.star.nesdis.noaa.gov/jpss/clouds.php)
- 生の画像相関だけでなく、平均風で位置合わせした相関も測る。これにより「動いたため違う」と「同じ模様が残った」を分ける。
- 比較指標は、時差相関、相関の e-folding 時間、しきい値を跨いだ雲物体の寿命・面積・移動速度、雲頂階級、光学量分布とする。衛星ごとの絶対輝度差ではなく、同じ前処理を通した相対統計を比較する。
- 観測画像は `.cloud-lab/reference/` に都度取得して commit しない。出典、領域、時刻、チャンネル、前処理を manifest に残し、再取得可能にする。

## 達成目標

1. 同じ天体・絶対時刻・座標の生成結果は再現可能で、時間倍率やフレーム刻みに依存しない。
2. 約 2,000 km の窓で、生成雲の時差相関は観測の同一指標との差が各ラグで 0.10 以下、相関 e-folding 時間は観測の 0.67〜1.5 倍に入る。
3. 個々の対流雲物体は 24 時間後に同一物体として残る割合が 10% 未満で、7 日後の雲模様相関は、総観・気候背景を除いた 48 時間後の相関を上回らない。
4. 雲物体の寿命・面積の中央値と 90 パーセンタイルが、各 regime で観測の 0.75〜1.33 倍に入る。
5. 低層液相→中層混相→上層氷相への発達、低層の先行消滅、上層風によるかなとこの流出が、一つの対流起源を追跡した可視化で確認できる。
6. G 単独の小さな中層雲、A 単独の巻雲、R のみの低く厚い雲、R+G+B の深い対流が、同じデータ契約で表現できる。
7. 雲面・大気内雲・雲影の雲底、雲頂、水平位置が一致し、地平線・明暗境界・斜光でも殻同士の分離や影のずれが見えない。
8. 雲場は 512×512 RGBA16F 1 枚を維持する。標準画質の雲関連 GPU パス合計 p95 は改修前の 1.25 倍以内に収める。
9. `npm run typecheck` と `npm run test:render` が通り、cloud-lab の時系列比較とスクリーンショットを同じコマンドで再生成できる。

## 手順

### Step 1 — 観測可能な振る舞いを SPEC に固定する

**目的**

実装方式より先に、時間スケール、液相から氷相への連続発達、二種類の上層氷雲、鉛直シア、中層雲底、オーバーシュートを仕様として確定する。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `DEVELOP/SPEC/RENDERING.md:435` 付近 | 「雲の分布」「雲の変化」「上空から見たとき」の節へ、目的欄の 5 項目を追加する。既存の動的生成・高度別風・決定性の記述と重複する箇所は統合する。 |

**達成条件と検証**

- 目的欄の 5 つの振る舞いが、内部クラス名や RGBA 配置に依存せず、画面と時間変化で判定可能な文章になっている。
- 同一時刻の決定性、時間加速、高度別風、既存の雲種多様性と矛盾しない。
- `npm run typecheck`
- SPEC だけの独立 commit にする。

### Step 2 — 衛星時系列の基準と計測器を作る

**目的**

「何日で変わったように見えるか」を主観だけで調整せず、観測と生成結果を同じ窓・同じ統計で測れるようにする。モデル変更前の数値と GPU 時間も保存する。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `tools/cloud-lab-reference.mjs` | 時系列 manifest、約 2,000 km の領域、時刻、衛星チャンネル、出典を入力として、再現可能な参照画像を `.cloud-lab/reference/` へ取得・整形する。 |
| `tools/cloud-lab-compare.mjs` | 参照と生成の 0〜72 時間ラグ比較、風で位置合わせした比較、regime 別集計を追加する。 |
| `tools/cloud-temporal-metrics.mjs`（新規） | 相関、e-folding 時間、雲物体の寿命・面積・移動速度、雲頂階級、光学量分布を計算し、JSON と可視化画像を出す。 |
| `tools/cloud-lab/lab.ts`、`tools/cloud-lab/views.ts` | 絶対時刻を固定した複数時点を同じ投影・同じ露出で出力できるようにする。 |
| `package.json` | 時系列比較を一コマンドで再生成する script を追加する。 |
| `tests/render/cloud-temporal-metrics.test.ts`（新規） | 既知の平行移動、生成・消滅、分裂・併合を持つ小配列で各指標を固定する。 |

**達成条件と検証**

- 5 regime × 2 期間以上を、manifest だけから再取得・再計測できる。
- 静止模様、平行移動だけの模様、短寿命模様を指標が区別する。
- 生成雲の改修前基準値と `雲の生成 / 大気(雲あり) / 雲影 / 表面雲` の GPU 時間を保存する。
- `npm run typecheck`
- `npm run test:render`
- 新しい時系列比較コマンド
- この計測基盤を独立 commit にする。

### Step 3 — 総観場と雲寿命を分離した決定的ライフサイクルを入れる

**目的**

数日続く気圧配置を壊さず、個々の雲模様を時間単位〜1 日単位で発生・発達・消滅させる。深い対流では同じ種から R→G→B を時間差で作り、A は独立した上層過程から作る。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/cloud-lifecycle.ts`（新規） | 絶対時刻からコホート ID、年齢、連続な発生・成長・衰弱の重みを返す純粋計算を置く。初期値は 6 時間刻み、4 世代重畳、24 時間寿命とする。 |
| `src/render/cloud/cloud-lifecycle-node.ts`（新規） | 上記と同じ式を TSL ノードへ写し、CPU テストと GPU 生成で意味を共有する。 |
| `src/render/cloud/circulating-noise.ts`、`src/render/cloud/circulation.ts` | 長寿命の循環・総観 forcing と短寿命コホートの seed を分離する。雲模様そのものへ 7 日周期を与える項は廃止する。 |
| `src/render/cloud/weather-transport.ts` | 下層・中層・上層ごとに、各コホートの年齢だけ後方移流した発生源を読む。単一模様の cross-fade で寿命を代用しない。 |
| `src/render/cloud/atmospheric-wind.ts`、`src/render/cloud/wind-law.ts` | 代表高度を下層・中層・上層の 3 経路へ揃え、同一対流起源の位相差が風の鉛直シアから生じるようにする。 |
| `src/render/cloud/weather-model.ts`、`src/render/cloud/condensation.ts` | 総観 forcing、地表/上層湿度、対流活動から R/G/B/A の量を生成する。対流の発達と衰弱では R、G、B のピーク時刻を順にずらし、A は独立に生成する。 |
| `src/render/cloud/cyclones.ts` | 低気圧・前線の寿命は維持し、その内部の凝結模様だけをコホート化する。 |
| `tests/render/cloud-lifecycle.test.ts`（新規）、`tests/render/atmospheric-wind.test.ts`、`tests/render/cyclones.test.ts` | 時刻のランダムアクセス、周期境界の連続性、相ごとのピーク順、風の高度差、総観 forcing と雲寿命の独立性を固定する。 |

**達成条件と検証**

- 同じ絶対時刻を異なるフレーム刻み・時間倍率・評価順で求めても一致する。
- コホート境界で量と一階差分に目立つ跳びがない。
- R の発達後に G/B が増え、衰弱時は R/G が B より先に消える。A は R/G がなくても発生できる。
- 24〜48 時間の相関が Step 2 の観測包絡へ近づき、7 日周期由来の同形再出現がない。
- `npm run typecheck`
- `npm run test:render`
- このライフサイクルを独立 commit にする。

### Step 4 — RGBA と共通鉛直プロファイルを全描画経路へ通す

**目的**

4 成分を一つの連続した鉛直雲体へ復元し、雲面・大気内雲・雲影が同じ雲底、雲頂、相、光学量を使うようにする。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/cloud/cloud-field-sample.ts`、`src/render/cloud/cloud-field.ts`、`src/render/cloud/cloud-field-sampler.ts` | `lowLiquid / midMixed / convectiveIce / inSituIce` の RGBA 契約へ移行する。空の既定値は RGBA 全て 0 とし、encode/decode を一箇所で対にする。 |
| `src/render/cloud/cloud-vertical-profile.ts`（新規） | 4 成分、緯度、季節、局地的な対流圏界面から、高度ごとの液相・氷相密度、消散係数、雲底・雲頂を返す純粋式を置く。基底間は連続補間し、強い深い対流だけ 20 km までのオーバーシュートを許す。 |
| `src/render/cloud/cloud-vertical-profile-node.ts`（新規） | CPU 基準式と同じ鉛直プロファイルを TSL で評価する。 |
| `src/render/cloud/cloud-shape-evaluator.ts`、`src/render/cloud/cumulus-shape.ts` | 単一の雲頂面ではなく、共通プロファイルの占有率・密度・勾配から形と法線を得る。 |
| `src/render/cloud/cloud-render-input.ts`、`src/render/cloud/cloud-presentation.ts` | 4 成分と局地高度情報を三つの描画経路へ同じ binding で渡す。 |
| `src/render/cloud/cloud-cap.ts` | 地平線外まで必要な cap を 20 km の上限で再計算する。 |
| `src/render/opaque-cloud-surface-renderer.ts` | 地表から詰まった柱という仮定を外し、液相主体で十分に不透明な最初のプロファイル交点を描く。 |
| `src/render/pipeline/cloud-atmosphere-renderer.ts`、`src/render/pipeline/atmosphere-cloud-layers.ts` | 固定高度の積雲殻・巻雲殻を、同じプロファイルから得る順序付き光学イベントへ置き換える。高度が交差しても手前順を誤らない。 |
| `src/render/pipeline/shadow/cloud-shadow-renderer.ts` | 太陽光路に沿って同じ鉛直密度と相別消散を積分する。 |
| `src/render/cloud/cloud-optics.ts`、`src/render/cloud/cloud-optics-node.ts` | 液滴と氷晶の光学量を分けつつ、CPU と TSL の基準式を一致させる。 |
| `src/render/graphics-settings.ts` | 既存の「積雲の精細さ」を鉛直積分のサンプル数へ対応させる。データ経路は一本のままにし、新しい設定項目は増やさない。 |
| `tests/render/cloud-field-sample.test.ts`（新規）、`tests/render/cloud-vertical-profile.test.ts`（新規）、`tests/render/cloud-optics.test.ts`、`tests/render/cloud-cap.test.ts` | RGBA 往復、単独/複合成分の雲底・雲頂、相の連続性、オーバーシュート条件、光学量、20 km cap を固定する。 |

**達成条件と検証**

- R/G/B/A の単独入力と組合せが達成目標 6 の形になり、全 0 は完全な晴天になる。
- 高度方向の密度・消散係数は基底の境界で連続し、雲底の高い G 単独雲が地表へ伸びない。
- 雲面、大気内雲、雲影で雲頂と水平位置が一致する。
- 斜め視点、地平線、明暗境界、低い太陽高度のスクリーンショットで、層の割れ、順序反転、影のずれがない。
- 雲場の GPU メモリは 2 MiB のまま。標準画質の雲関連 GPU パス合計 p95 は基準の 1.25 倍以内。超える場合は共有データ契約を崩さず、既存画質段階ごとの積分サンプル数を下げて再測定する。
- `npm run typecheck`
- `npm run test:render`
- `npm run cloud-lab:shot`
- 描画契約と三経路の移行を一つの commit にする。

### Step 5 — 観測雲入力、cloud-lab、時系列較正を新契約へ移す

**目的**

生成雲と観測雲を同じ RGBA 契約で比較できるようにし、5 regime の時間変化、鉛直構造、見た目、速度を観測包絡へ調整する。

**変更箇所**

| ファイル | 変更 |
| --- | --- |
| `tools/cloud-lab/separation-pipeline.ts`、`tools/cloud-lab/separate-main.ts`、`tools/cloud-lab/separate.html` | 単一の実写画像から、テクスチャ・輝度・広域形状を手掛かりに R/G/B/A の初期推定を作る。高度は画像だけでは一意に決まらないことを UI と出力 metadata に明記する。 |
| `src/assets/cloud-field.png` | 新しい 4 チャンネルで再生成する。旧画像の常時 1 の alpha をそのまま A として読まない。 |
| `src/render/cloud/observed-cloud-field.ts` | 新契約を読み、全 0 の外側と線形フィルタ時の意味を生成雲と揃える。 |
| `tools/cloud-lab/views.ts`、`tools/cloud-lab/pane.ts`、`tools/cloud-lab/lab.ts`、`tools/cloud-lab/index.html` | R/G/B/A、液相/氷相、雲底/雲頂、合成光学量、対流起源の追跡、0〜72 時間の小分け表示を追加する。 |
| `tools/cloud-lab/cloud-rendering-explainer.html` | 実装完了後の新しい RGBA 契約と三描画経路の入力を更新する。 |
| `tools/cloud-lab-compare.mjs`、`tools/cloud-lab-shot.mjs` | 5 regime の統計表、差分画像、時系列 contact sheet を出力する。 |

**達成条件と検証**

- 観測雲と生成雲の R/G/B/A を同じビュー・同じカラースケールで比較できる。
- 達成目標 2〜4 の全指標を満たす。満たせない regime は平均化せず個別に失敗として出す。
- 0 / 6 / 12 / 24 / 48 / 72 時間の contact sheet で、総観配置を残しながら個々の雲形が更新される。
- 発達中の対流を追跡するビューで R→G→B、鉛直シアによるずれ、B の残留が連続して見える。
- `npm run typecheck`
- `npm run test:render`
- `npm run cloud-lab:separate`
- `npm run cloud-lab:compare`
- `npm run cloud-lab:shot`
- 観測入力と較正を独立 commit にする。

### Step 6 — 規約・コメント・性能を最終監査する

**目的**

一時的な互換処理、固定高度、旧チャンネル名、重複式を残さず、科学的な近似の境界とコード境界を一致させる。

**変更箇所**

| 対象 | 変更 |
| --- | --- |
| Step 2〜5 で触れたファイル | `/refactor` で層、依存方向、重複、例外を点検し、`/comment-cleanup` で「なぜ」を説明しない転記コメントや旧契約の記述を除く。 |
| 雲関連の定数・識別子 | `coverage / cloudTop / translucent`、固定 15〜16 km の巻雲殻、雲模様へ直接かかる 7 日周期が旧意味で残っていないことを検索で確認する。 |
| 性能計測 | Step 2 の同じカメラ、時刻、画質で GPU pass p50/p95 とメモリを再測定する。 |

**達成条件と検証**

- `DEVELOP/CODING-RULE.md` と、必要な境界について `DEVELOP/ARCHITECTURE.md` に適合する。例外が必要なら規則を書き換えず、この計画の実施報告へ理由を残す。
- 旧契約を読むコードや、描画経路ごとの独自な雲高度定数がない。
- 達成目標 1〜9 の証跡が `.cloud-lab/` の JSON・画像とテスト出力から再生成できる。
- `npm run typecheck`
- `npm run test:render`
- 新しい時系列比較コマンド
- `npm run cloud-lab:compare`
- `npm run cloud-lab:shot`
- 監査修正を独立 commit にする。

## 見積り

| Step | 根拠 | 見積り |
| --- | --- | ---: |
| 1 | 仕様 5 項目 × 0.3 h + 整合確認 1.5 h | 3 h |
| 2 | 5 regime × 2 期間 × 0.5 h + 6 指標 × 1 h + 自動化/テスト 4 h | 15 h |
| 3 | 4 成分のライフサイクル × 3 h + 3 高度の移流 × 2 h + テスト 6 h | 24 h |
| 4 | 共通プロファイル 8 h + 3 描画経路 × 7 h + 契約/設定 5 h + テスト 6 h | 40 h |
| 5 | 観測分離 5 h + lab/計測 5 h + 5 regime × 1.5 h + 見た目/性能 3 h | 20.5 h |
| 6 | 規約・コメント 3 h + 最終測定/修正 5 h | 8 h |
| **合計** | 実装・検証 110.5 h。衛星データ差と GPU 調整の不確実性 0〜20% | **110〜135 h** |

## リスクと落とし穴

| リスク | 影響 | 表面化する Step / 対処 |
| --- | --- | --- |
| 4 成分だけでは鉛直形状が一意に決まらない | 厚い低層雲と深い対流、薄い中層雲を誤る | Step 4。値を高度へ直結せず、成分の組合せと局地的な対流圏界面を使う。単独/複合入力をテストする。 |
| コホート境界が脈動・格子模様として見える | 6 時間ごとに全球の雲が同時に変わる | Step 3。空間 seed ごとに位相をずらし、連続窓を重ね、値と一階差分を検査する。 |
| 短寿命化で低気圧や前線まで消える | 天気の組織性を失う | Step 3。総観 forcing と凝結模様を別の寿命にし、背景を除いた相関と除かない相関を両方測る。 |
| B と A を混ぜると対流起源を追跡できない | 発達・衰弱の因果が見えない | Step 3/5。生成過程は分け、描画時だけ連続合成する。lab では別々に表示する。 |
| 高度可変化で光学イベントの順序が反転する | 地平線付近で雲が消える・手前奥が逆転する | Step 4。固定列挙順を使わず、レイとの交差距離で並べるテストを置く。 |
| 旧 PNG の alpha=1 を新 A と解釈する | 全面が巻雲になる | Step 5。asset と loader を同じ commit で移行し、全 0・既知 4 色の fixture を読む。 |
| 鉛直積分で GPU 負荷が増える | 標準画質が目標性能を超える | Step 2/4/6。先に pass 別基準を取り、1 枚の texture と既存画質段階を維持し、共通式・早期終了・サンプル数で調整する。 |
| 衛星チャンネル、投影、昼夜で相関が変わる | モデル差でないものを誤差に数える | Step 2/5。同一衛星・同一チャンネル・同一投影で期間内を揃え、前処理を manifest 化する。 |
| 単一の可視画像から雲相・高度を完全には復元できない | 観測雲入力の RGBA が擬似的になる | Step 5。静止画分離は見た目用の推定と明記し、時間統計と雲頂階級の検証には衛星プロダクトを使う。 |

## 今回の範囲外

- 全球格子の流体方程式、データ同化、予報精度を目的とした NWP の導入。
- 降水量、雷、冷気外出流をゲーム規則へ接続すること。ライフサイクル内部の近似量として必要なら使うが、公開 gameplay state にはしない。
- 地球以外の天体へ同じ雲相・対流圏界面を一般化すること。地球モデルの境界を明確に保ち、別天体の仕様変更は別計画にする。

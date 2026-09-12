# 雲セルの空間組織・形状分散の実装計画

作成日: 2026-09-11  
計画の基準コミット: `a85fee8e`

## 目的

衛星画像に見られる、疎らな熱帯海洋の積雲、陸域の大きな雲塊、風向きに沿う雲列、前線・台風の
広域構造を、同じ表示時刻から決定的に生成する。雲の被覆率だけをノイズで変えるのではなく、
広域の雲域、雲の組織化、セルの大きさと分散、雲頂・光学を別の尺度で表現する。

ユーザー要求の「低緯度海域で約4 km」「陸域で8 km以上」は、個々の浅い積雲の面積等価直径ではなく、
雲核の配置間隔または雲塊の代表スケールとして扱う。観測された個々の熱帯積雲は、15 m ASTER解析で
約0.6 kmにサイズ分布の折れ曲がりがあり、熱帯西太平洋では雲量の半分が1.6 km未満の雲で構成され、
7 km超の雲は個数の0.007%未満だったためである。

## 決めたこと

### 空間尺度を分離する

- 数百〜数千 km: 気候、気圧、湿度、上昇流、前線、台風が決める雲域の包絡線。既存の気象場を使う。
- 数十〜数百 km: 雲塊の群れ、open-cell / closed-cell / cluster / street / band の連続的な混合。
- 約0.5〜12 km: 雲セル、隣接距離、融合、雲頂の粒立ち。新しい cellular evaluator で生成する。
- 4 kmと8 kmは、上記の中間〜局所スケールを選ぶ代表値とし、衛星観測の個々の雲直径を上書きしない。

### 文献値とゲーム上の値を分ける

次の値は観測または観測論文に明記された値として扱う。

| 量 | 採用値 | 扱い |
|---|---:|---|
| 熱帯海洋のサイズ分布の折れ曲がり | 0.59〜0.60 km | 観測値 |
| 熱帯西太平洋の雲サイズ分布指数 | 2.93（線形binのfit）、2.16（直接fit） | 観測値の推定法による幅 |
| 熱帯西太平洋で雲量の半分を占める直径 | 1.6 ± 0.1 km未満 | 観測値 |
| 熱帯西太平洋の雲サイズ解析上限 | 7 km | サンプルが十分な範囲 |
| 小さい雲の割合 | 海洋は陸域の約3〜6倍 | 観測された海陸差から陸域の重みを0.167〜0.333、既定0.25へ設定 |
| 雲街の波長 / CBL深さ | 基準2.8、許容2.2〜6.5 | 観測・理論の範囲 |
| 雲街の代表的な高アスペクト比 | 約5.7 | roll状態の観測値 |
| 雲街の向き | 境界層の平均風・低層シアに近い | 観測傾向 |
| 熱帯海洋と陸域の逆転層の目安 | 海洋約2 km、内陸約4 kmまで | 観測事例の目安 |

高緯度の個々の雲のサイズ分布に対して、熱帯の指数を「高緯度の観測値」として流用しない。高緯度の
セルサイズ分散は、境界層深さ、風速、シア、対流活動から連続的に計算し、観測値が直接得られた
波長/境界層深さの関係だけを固定する。

### 空間分布を cellular noise で作る

Perlin / gradient noise は広域の雲域と雲頂の揺らぎに残し、雲セルの形は球面上の hash-grid Voronoi
（F1/F2）で作る。

- F1で最近傍雲核からの距離を得て、セルの中心・半径・雲核の密度を決める。
- F2−F1で隣接セルとの余白を得て、海洋の隙間、陸域の狭い隙間、連続した雲帯を作る。
- 雲セルの境界は `smoothstep` で連続化し、雲のない包絡線から新しい雲を発生させない。
- 風の接平面座標へ異方性を掛け、セルを風向きへ伸ばす。単純な緯線・経線の縞は生成しない。
- 大規模な domain warp と既存の雲パターン移流を重ね、列を完全な平行線にしない。

### セルサイズ分散を分布から求める

個々のセル直径 `D` は、低緯度海洋については二重べき乗分布を基準にする。

```text
p(D) ∝ D^(-λ)
λ1 = 1.95       (0.09 km 〜 0.59 km)
λ2 = 3.27       (0.59 km 〜 7 km)
```

0.09 kmは文献で扱われた最小級の弦長を参照した表示下限であり、物理的な最小雲サイズとは扱わない。
この分布から1次・2次モーメントを計算し、平均・分散・変動係数を得る。陸域では小さい雲の人口重みを
0.25へ再重み付けし、海域より大きい雲塊と大きい分散になるようにする。高緯度では、同じ固定の
log-sigmaを置かず、CBL深さと雲街波長の局所変動を分散へ加える。

初期の空間プロファイルは次の制約で実装する。数値は固定境界ではなく、緯度・陸域率・気象場から
`smoothstep` で補間する。

| プロファイル | 配置スケール | 隙間・融合 | 列の強さ |
|---|---:|---|---|
| 低緯度・海洋 | 雲核ピッチ約4 km | `connectivity` 0.10〜0.30。隣接セルを離す | 0 |
| 低緯度・陸域 | 雲塊ピッチ8 km以上 | `connectivity` 0.55〜0.85。雲核を群れへ融合 | 陸域率と風で0〜0.65 |
| 中緯度より北・海洋 | `2.2〜6.5 × z_i` km相当の列間隔 | 隙間を残した列から連続帯へ遷移 | 風速・シア・対流で0〜1 |
| 中緯度より北・陸域 | `max(8 km, 2.2〜6.5 × z_i)` | `connectivity` 0.70〜1.0 | 0.5〜1 |

`z_i` は境界層深さの表示用推定場で、海洋側の約2 km、陸域側の約4 kmを目安に、安定度・上昇流・
対流活動から連続的に変える。文献の直接値とゲームの推定場を同じ定数としてコメントしない。

### 表現間で同じ詳細場を読む

不透明表面、大気雲、雲影は同じ `CloudFieldSampler` と `CloudShapeEvaluator` を使い、同じセル核、
同じ分散、同じ風向、同じ表示時刻を読む。セル詳細は現在の粗い全球雲場の代替ではなく、粗い雲場を
包絡線とする追加層にする。

## 達成目標

- 低緯度海洋の局所表示で、雲核の代表ピッチが4 km付近になり、隣接セルの晴天隙間が連続して現れる。
- 陸域の局所表示で、8 km以上の雲塊が形成され、海洋より小さい雲の数が少なく、隙間が狭いか融合する。
- 中緯度より北、または陸域で、雲列の主軸がその場所の低層風向へ連続的に回転し、固定緯線・経線の
  縞が現れない。
- 4つのプロファイルで、セルサイズの平均・標準偏差・変動係数が同じ値にならず、陸域は海洋より
  大きい代表セルと小さい雲の少ない分布を持つ。
- 海岸、赤道、緯度35〜55°の列形成域、経度のwrap、極付近で、雲の位置・向き・密度に継ぎ目が現れない。
- 同じ表示時刻を再描画・セーブ復帰・時間ジャンプしてもセル配置が一致し、時間を進めたときだけ移流する。
- 表面、大気、雲影のセル境界・雲頂・光学的厚みが同じ位置にあり、3つの表現だけがずれることがない。
- 画面上でセルを解像できない距離では詳細層が自然に消え、雲のちらつき・モアレ・LOD境界の飛びがない。
- `npm run typecheck`、`npm run test:render`、ゲーム接続変更時の`npm run test:game`が成功する。

## 手順

### 手順1. 雲セルの仕様を確定する

#### 目的

セルの配置間隔、セル直径、サイズ分散、雲街、海陸差を、実装方法ではなくゲームが観測できる要件
として `DEVELOP/SPEC/RENDERING.md` に追加する。4 km・8 kmが個々の雲直径ではないことも明記する。

#### 変更が必要な箇所

| ファイル | 変更内容 |
|---|---|
| `DEVELOP/SPEC/RENDERING.md` | 雲セルの代表ピッチ、海陸差、分散の差、風向きに沿う列、連続遷移、決定性、LOD要件を追加する。 |

#### 達成条件と検証

仕様に、低緯度海洋・陸域・中高緯度の3つの観測状態とセル分散の差が入り、実装アルゴリズムの説明が
仕様へ混入していないことを確認する。`git diff --check`を実行する。この手順ではコードを変更しない。

### 手順2. 文献制約からセルプロフィールと分散を実装する

#### 目的

観測されたサイズ分布と海陸差を、GPUへ渡せる平均セルサイズ・分散・融合度・列強度へ変換する純粋な
契約を作る。観測値、観測傾向からの推定、ゲーム上の代表ピッチを別々に保持する。

#### 変更が必要な箇所

| ファイル | 変更内容 |
|---|---|
| `src/render/cloud/cloud-cell-profile.ts`（新規） | べき乗分布のモーメント、低緯度海洋を基準にした海陸の小雲人口重み、`z_i`からの列間隔、連続的なプロフィール補間を定義する。 |
| `src/render/cloud/cloud-cell-profile.ts` | 観測値・推定値・表示調整値を定数コメントと型で区別し、プロフィールは緯度と陸域率の急な分岐を持たない。 |
| `tests/render/cloud-cell-profile.test.ts`（新規） | 分布の正規化、平均・分散、海洋から陸域への小雲人口0.167〜0.333、列間隔2.2〜6.5×`z_i`、海岸・緯度境界の連続性を検証する。 |

#### 達成条件と検証

低緯度海洋の代表ピッチが4 km、陸域の代表ピッチが8 km以上になり、陸域の小雲人口重みが既定0.25、
プロフィール間の分散が異なることをCPUテストで数値確認する。`npm run typecheck`、`npm run test:render`を通す。

### 手順3. 気象場から雲組織の入力を焼く

#### 目的

セル詳細を描画時に再現できるよう、雲場と同じ表示時刻・投影・世代で、セルサイズ、分散、融合、列、
風向、境界層深さをGPUへ渡す。既存のcoverage・cloudTop・translucentのRGBA契約は維持する。

#### 変更が必要な箇所

| ファイル | 変更内容 |
|---|---|
| `src/render/cloud/weather-model.ts` | `WeatherSample`へ境界層深さと低層風シアの入力を追加し、既存の気圧・湿度・対流・風から連続的な推定値を作る。気象の風を描画用の別風場として複製しない。 |
| `src/render/cloud/atmospheric-wind.ts` | 境界層内の高さ差を読むための共有風サンプル入口を追加する。既存の地表・上層風の単位と挙動は変えない。 |
| `src/render/cloud/cloud-organization-sample.ts`（新規） | セル平均ピッチ、セルサイズ変動係数、connectivity、rowStrength、風の東西成分、境界層深さ、rowAspectの単位とRGBA復号を定義する。 |
| `src/render/cloud/cloud-organization-field.ts`（新規） | morphology用RGBA場とwind/dynamic用RGBA場を`BakedField`として焼き、気象場と同じprojection・時刻で更新する。 |
| `src/render/cloud/cloud-field.ts` | `CloudOrganizationField`を雲場と同じ寿命で所有し、雲場テクスチャと組織場を同じrender順で焼く。 |
| `src/render/cloud/cloud-field-sampler.ts` | 同じUV・明示LODで雲場と組織場を読む。組織場を解放せず、生成側の所有権を保持する。 |
| `src/render/cloud/generated-cloud-field.ts` | 組織場のgeneration、表示時刻、気候切替、破棄を既存雲場と同期する。 |
| `src/render/pipeline/cloud-atmosphere-renderer.ts` | `CloudFieldSampler`を既定UVで内部生成せず、雲場・組織場・注入UVを受け取る接続へ変更する。 |
| `src/render/pipeline/shadow/cloud-shadow-renderer.ts` | `CloudFieldSampler`を既定UVで内部生成せず、雲場・組織場・注入UVを受け取る接続へ変更する。 |
| `src/render/pipeline/atmosphere-cloud-layers.ts` | 大気雲へ渡すfield入力へ組織場とUVの契約を追加する。 |
| `src/render/pipeline/shadow/shadow-pass.ts` | 雲影候補へ渡すfield入力へ組織場とUVの契約を追加する。 |
| `src/game/celestial/celestial-entity/point-celestial-view.ts` | `CloudPresentation`から表面・大気が同じ投影入力を受け取れるよう接続する。 |
| `src/game/celestial/celestial-illumination.ts` | `CloudPresentation`から雲影へ同じ投影入力・組織場・generationを渡す。 |
| `tests/render/cloud-organization-sample.test.ts`（新規） | RGBAの往復、単位範囲、非有限値、風向wrap、組織場generationの単調性を検証する。 |
| `tests/render/cloud-field-sampler.test.ts` | surface/atmosphere/shadowが同じ注入UVとLODで組織場を読むことを追加検証する。 |

#### 達成条件と検証

雲場と組織場が同じ表示時刻・投影・generationで更新され、表現側に個別のUV・分散・風向計算がないことを
検索で確認する。`rg -n "dispose\(|sphereMeshUv|cellSize|rowStrength|rowAspect" src/render/opaque-cloud-surface-renderer.ts src/render/pipeline src/render/cloud`で所有権と重複を確認し、
`npm run typecheck`、`npm run test:render`を通す。

### 手順4. 風向きに沿う cellular evaluator を実装する

#### 目的

組織場から、海洋の離れたセル、陸域の融合したセル、風向に沿う雲列を同じ評価器で生成する。球面の
経度wrap・極付近・任意の斜め風向で連続し、完全なストライプにならないようにする。

#### 変更が必要な箇所

| ファイル | 変更内容 |
|---|---|
| `src/render/cloud/cloud-cellular.ts`（新規） | 球面hash-grid VoronoiのF1/F2、domain warp、局所風接平面、rowAspectの異方性、cell gap、connectivity、決定的な移流位相を実装する。 |
| `src/render/cloud/cloud-shape-evaluator.ts` | coverageへcellular maskを掛け、cell maskから雲頂 relief・opaque fraction・column optical depthを共通評価する。雲のないcoverageからセルだけで雲を生やさない。 |
| `src/render/cloud/cumulus-shape.ts` | 雲セル詳細の物理単位・解像度下限・既存の雲頂範囲を、概念の所有者として整理する。既存の雲光学定数を無関係に移動しない。 |
| `tests/render/cloud-cellular.test.ts`（新規） | F1/F2の範囲、風向0/斜め/南北、dateline・極、connectivity、cell size variance、時間位相の決定性をCPU参照実装で検証する。 |

#### 達成条件と検証

同じ入力のsurface/atmosphere/shadowで同じcell maskが得られ、東西・南北・斜めの風向で列の主軸が
連続回転することをテストする。cellular detailが画面の2〜4 pixel相当未満で0へ減衰することを確認し、
`npm run typecheck`、`npm run test:render`を通す。

### 手順5. 不透明表面・大気・雲影へ統合する

#### 目的

新しいセル形状を既存の3表現へ接続し、表面、大気、影が同じ密度・雲頂・分散を使う状態にする。描画の
ON/OFF、LOD、cirrus、translucent cumulus、既存の雲影品質は維持する。

#### 変更が必要な箇所

| ファイル | 変更内容 |
|---|---|
| `src/render/opaque-cloud-surface-renderer.ts` | cellular maskをsurface ray marchのcoverage・cloudTop・normalへ接続し、入口1回の分散値で全経路を固定しない。各地点の組織場とcell maskを共有評価する。 |
| `src/render/pipeline/cloud-atmosphere-renderer.ts` | translucent cumulusの柱光学へcellular maskを接続し、巻雲の上層分布は別フィールドとして維持する。surfaceと同じUV・組織場入力を使う。 |
| `src/render/pipeline/shadow/cloud-shadow-renderer.ts` | surfaceと同じcellular mask・cloudTop・optical depthを光路タップへ接続する。6タップと明示LODは維持し、既定UVへ戻さない。 |
| `src/render/pipeline/atmosphere-cloud-layers.ts` | 大気のイベント生成へ組織場を通し、rendererごとに別のcloud field samplerを隠れて生成しない。 |
| `src/render/pipeline/shadow/shadow-pass.ts` | 影候補のfield・組織場・UV・時刻を同じcloud presentationから配線する。 |
| `src/render/cloud/cloud-presentation.ts` | 表示時刻とセル移流位相を共有samplerへ同期し、表面・大気・影で異なる時刻を使わない。 |
| `src/game/celestial/celestial-entity/point-celestial-view.ts` | 大気雲の入力をsurfaceと同じfield projection/organization inputへ接続する。 |
| `src/game/celestial/celestial-illumination.ts` | 雲影の入力をsurfaceと同じfield projection/organization inputへ接続する。 |
| `tests/render/cloud-field-sampler.test.ts` | dateline・楕円体UVを含む同一方向で、表面・大気・影のsamplerが同じテクスチャを読むことを検証する。 |
| `tests/render/cloud-shape-consistency.test.ts`（新規） | 同じ方向・幅・組織場に対する表面、大気、影のmask、cloudTop、optical depthの一致を検証する。 |
| `tests/game/earth-system.test.ts` | 雲を持つEarthの時間変更、表示OFF、破棄、気候generation変更で組織場と雲場が同時に更新されることを検証する。 |

#### 達成条件と検証

表面・大気・影が同じsamplerから組織場を読み、個別のcell noise・row direction・variance式を持たないことを
`rg`と差分レビューで確認する。`npm run typecheck`、`npm run test:render`、`npm run test:game`を通す。

### 手順6. cloud-labと統計比較を拡張する

#### 目的

画像を目視するだけでなく、4つのプロファイルの平均、分散、隣接距離、列の向きを同じ条件で比較できる
診断を追加する。現行の実写比較と生成画像の比較を、新しいセル詳細の検証へ拡張する。

#### 変更が必要な箇所

| ファイル | 変更内容 |
|---|---|
| `tools/cloud-lab/views.ts` | `cellScale`、`cellVariance`、`connectivity`、`rowStrength`、`rowDirection`、`cellularComposite`の表示を追加する。 |
| `tools/cloud-lab/pane.ts` | 雲組織場をcloud-labのprojectionで焼き、weather/cloudビューから同じ場を読み出す。 |
| `tools/cloud-lab/lab.ts` | 全球・capの表示、時刻変更、組織場のcaptureを既存の雲場と同じ順序へ接続する。 |
| `tools/cloud-lab-compare.mjs` | セルの連結成分、最近傍距離、サイズ分布、分散、列方向の自己相関を地域別に集計する。 |
| `tools/cloud-lab-shot.mjs` | 新しいdiagnostic viewを撮影対象へ含める。 |
| `tests/render/cloud-lab-contract.test.ts`（新規） | labと本番のsampler、projection、時刻、組織場契約の一致を検証する。 |

#### 達成条件と検証

次の固定ケースを撮影し、目視と統計の両方で判定できる状態にする。

- 低緯度海洋: 10°N・160°E付近、4 km級のセルと明瞭な隙間
- 低緯度陸域: 15°N・陸域、8 km以上の雲塊と狭い隙間
- 中高緯度海洋: 45°N・150°E付近、斜め風向の雲列
- 中高緯度陸域: 50°N・陸域、融合した列と最大級の分散
- 台風・前線: 既存の広域包絡線にcellular detailを重ね、渦の腕で列が曲がるケース

`npm run typecheck`、`npm run test:render`、`npm run cloud-lab:shot`を通す。統計は`npm run cloud-lab:compare`
の出力へ、生成場のセル分布と実写分離画像のスペクトルを併記する。

### 手順7. コードレビュー、リファクタリング、最終検証を行う

#### 目的

実装後に、地域分岐の重複、CPU/GPUで異なる分散式、表現ごとのcellular noise、古い固定粒ノイズ、
組織場の解放漏れを整理する。今回の仕様と無関係な雲の光学・気候入力は変更しない。

#### 変更が必要な箇所

手順2〜6で変更した`src/render/cloud/`、`src/render/opaque-cloud-surface-renderer.ts`、
`src/render/pipeline/cloud-atmosphere-renderer.ts`、`src/render/pipeline/shadow/cloud-shadow-renderer.ts`、
`src/render/cloud/cloud-presentation.ts`、`tools/cloud-lab/`、関連テストを対象とする。

#### 達成条件と検証

- `rg -n "gradientNoise\(|rowStrength|cellSizeVariance|cellular|F1|F2" src/render`で、cellular形状の正本が一つである。
- `rg -n "sphereMeshUv|CloudShapeEvaluator|CloudFieldSampler" src/render/opaque-cloud-surface-renderer.ts src/render/pipeline`で、表現固有のUV・shape再実装がない。
- 雲組織場を`GeneratedCloudField`またはその所有するfieldだけが解放する。
- `npm run typecheck`
- `npm run test:render`
- `npm run test:game`
- `npm run cloud-lab:shot`
- `npm run cloud-lab:compare`
- `git diff --check`

## 並列実行の編成

計画承認後は専用worktreeで実装する。同じファイルを複数担当へ配らない。

| 作業 | 担当 | 書き込み範囲 | 依存 |
|---|---|---|---|
| プロフィール・分布モーメント | Luna | `cloud-cell-profile.ts`、そのテスト | 手順1の仕様契約 |
| cellular evaluator | Lunaの別タスク | `cloud-cellular.ts`、そのテスト | 手順2のプロフィール型 |
| 気象・組織場契約 | メイン | `weather-model.ts`、`atmospheric-wind.ts`、`cloud-organization-*`、`cloud-field*` | 手順2 |
| 描画経路統合 | メイン | 表面・大気・影・presentationと接続テスト | 手順3・4 |
| cloud-lab診断 | 独立タスク | `tools/cloud-lab/`、比較スクリプト、labテスト | 手順3 |
| 統合レビュー | メイン | 統合worktreeの差分、必要な修正 | 全手順 |

プロフィールとcellular evaluatorは新規ファイル中心で依存が分かれるため並列に進める。組織場の形式が
確定するまでは描画統合を開始しない。仕様・`DEVELOP/SPEC/`・`memos/`はサブエージェントに編集させない。

## 参考文献と値の根拠

- Mieslinger, Horváth, Buehler & Sakradzija (2019), *The Dependence of Shallow Cumulus Macrophysical Properties on Large-Scale Meteorology as Observed in ASTER Imagery*. 1,158枚の15 m ASTER画像から、サイズ分布の0.59 kmの折れ曲がり、風速増加に伴う雲量・雲頂・サイズ分布の変化を整理した。<https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2019JD030768>
- De Vera et al. (2024), *Observations of the macrophysical properties of cumulus cloud fields over the tropical western Pacific and their connection to meteorological variables*. 170枚のASTER画像、2,181,059雲、サイズ指数2.93 / 直接fit 2.16、折れ曲がり0.6 km、雲量の半分を1.6 km未満が占める値を採用した。<https://acp.copernicus.org/articles/24/5603/2024/>
- Liu et al. (2026), *The Reflectance Distribution of Shallow Cumulus and Its Environs From High Spatial Resolution ASTER Images*. 陸域と熱帯海洋の比較、海洋側に小さい雲が3〜6倍多いこと、陸域の雲が大きく高くなりうること、陸域の逆転層が4 kmまで達する事例を根拠にした。<https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2025JD045060>
- Weckwerth, Wilson & Wakimoto (1997), *Thermodynamic and Kinematic Conditions Associated with the Development of Horizontal Convective Rolls*. 雲街の向きが境界層風・シアに近いこと、波長/CBL深さの代表値2.8、観測された比の範囲2.2〜6.5、roll時の平均アスペクト比5.7を根拠にした。<https://weather.ou.edu/~hblue/metr6413/Weckwerthetal97.pdf>
- Melfi & Palm (2012), *Estimating the Orientation and Spacing of Midlatitude Linear Convective Boundary Layer Features*. 中緯度の線状境界層対流について、風・シアと方向・間隔を対応づける設計根拠にした。<https://doi.org/10.1175/JAS-D-11-070.1>

## 見積り

概算は、GPU実測前の作業量である。各手順の基礎実装、テスト、差分レビューを含める。

| 作業 | 導出式 | 概算 |
|---|---|---:|
| 仕様・プロフィール | 仕様更新1.5 h + 分布実装2.5 h + CPUテスト2 h | 6 h |
| 組織場契約 | 新規2型2 h + 気象接続3 h + field/sampler接続3 h + テスト3 h | 11 h |
| cellular evaluator | F1/F2と異方性4 h + 移流・LOD2 h + CPUテスト3 h | 9 h |
| 3表現への統合 | 表面3 h + 大気2 h + 影2 h + presentation/ゲーム接続3 h + 回帰3 h | 13 h |
| cloud-lab・比較 | 診断ビュー3 h + 統計4 h + 撮影・基準更新3 h | 10 h |
| レビュー・リファクタリング | 検索監査2 h + GPU計測2 h + 修正2 h | 6 h |
| **合計** | `6 + 11 + 9 + 13 + 10 + 6` | **55 h** |

GPU負荷の追加分は実装後に計測する。セル詳細の評価回数を`surface march samples + atmosphere samples + shadow taps`
とし、画面ピクセル数と各サンプルのcellular候補数を掛けた実測値で品質設定を決める。文献値だけからフレーム
時間を推定して固定しない。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
|---|---|---|
| 4 km・8 kmを個々の雲直径として実装する | 熱帯海洋の雲が大きすぎ、衛星画像より疎になる | 手順2・6のサイズ分布統計 |
| べき乗分布のfit値2.16と2.93を混同する | 分散と大きい雲の頻度が静かに変わる | 手順2の分布テスト、参考文献レビュー |
| 海陸・緯度を`if`や固定閾値で切り替える | 海岸・赤道・列形成域に継ぎ目が出る | 手順2・4の連続性テスト、cap撮影 |
| 風向を経度/緯度の2パターン混合で近似する | 斜め風で雲列が風向へ回転しない | 手順4・6のrowDirectionビュー |
| Voronoiの格子を球面へそのまま投影する | 極・日付変更線にセルの伸びや縫い目が出る | 手順4の極・datelineテスト |
| cellular detailを粗い全球テクスチャへ焼く | 4 km級の粒が消える、またはモアレになる | 手順4・6の距離別撮影、GPU計測 |
| cell maskがcoverage 0の場所へ雲を生やす | 晴天域に孤立した雲・雲影が現れる | 手順4・5の晴天ケース |
| 表面・大気・影が別々のcellular式を持つ | 雲頂・影・大気雲の位置がずれる | 手順5・7の検索と一致テスト |
| organization fieldとcloud fieldの時刻がずれる | 雲セルだけが包絡線を滑る、セーブ復帰で変わる | 手順3・5のgeneration/時間回帰 |
| 組織場を追加したまま遠距離でも評価する | shader命令数とフレーム時間が増える | 手順4・6・7のGPU timing |
| cell size variationを毎サンプル再計算する | 表面ray march・影6タップで負荷が過大になる | 手順5・7の差分レビューとGPU timing |
| 高緯度に熱帯の固定分散を流用する | 高緯度の列が同じサイズの粒へ均される | 手順2の値の根拠レビュー、手順6の高緯度統計 |

## スコープ外

- 新しい衛星画像アセットの本番データ化、実写テクスチャの直接貼り付け。
- 雲の三次元マイクロ物理、雨滴・降水、氷晶の物理モデル。
- 既存の巻雲の上層風・光学モデルの全面的な作り直し。
- 雲場を完全な高解像度全球テクスチャへ置き換えること。
- 雲のボリュームレイマーチ化、既存の雲表現分離、気候データ取得経路の再設計。
- `npm run build`や全層の回帰テスト。mainへ送る段階で別途実行する。

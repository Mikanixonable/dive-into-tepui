# 雲の実写近似: 実装状況と基盤の調査

起点の commit: `ec9e3ef71`(ブランチ `muse/dev`、行番号付きの参照はこの時点のもの)。
ユーザーの問い「描画経路段階の雲の形状を風向き・緯度・陸海で変え、風で移動し、セルの成長と崩壊を
繰り返す — 実現しているか」と「雲を似せていく基盤の現状」への調査をまとめたもの。

**追記(同日、devin/dev):** この調査は統合前の `muse/dev` で行った。`05a1c3223` で
`feat/cloud-scale-continuity` が devin/dev へ統合され、3節の「未統合」「構想段階」と書いたもの —
`cloud-detail:stability`、`cloud-lab:render-capture(-timeseries)`、`cloud-lab:reference-fine(-timeseries)`、
`cloud-lab:reference-cloudtop`、`cloud-detail:tiers`、compare の fineMotion 節 — は devin/dev に
全て存在する。4節の穴そのもの(8〜100 km の担い手・対流セルの寿命)の解消具合は別途評価が要る。

## 1. 要求された5機能の実装状況

雲の描画経路は `src/render/cloud/` にある TSL(three.js shading language)製の閉形式 GPU 気象モデル
(`.glsl`/`.wgsl` は無い)。生成物は**表示時刻の閉じた関数**で、状態・履歴・時間積分を持たない
(`weather-model.ts:2`)。パイプラインは: `game-presentation.ts:446` が毎フレーム `bakeClouds` を呼び、
`GeneratedCloudField.prepare()`(`generated-cloud-field.ts:47-64`)が displayTime・気候世代・投影版の
変化で中間場5枚+雲場を再ベイク — 再生中は実質フレームごと。

| 要求 | 判定 | 主な根拠 |
| --- | --- | --- |
| 形状が風向きで変わる | **実装済み** | 気圧勾配からの釣り合い風で湿度・対流場を2位相セミラグランジュ移流(`weather-transport.ts:135-160`)。雲塊と積雲の粒は別の風(粒は摩擦3倍・横切り角50°、`weather-model.ts:136-141,254-259`)。巻雲の筋は上層風に揃い細部も筋方向へ最大6倍伸びる(`condensation.ts:170`、`cloud-detail.ts:156,184-187`)。地形性上昇流(`weather-model.ts:98,267-268`) |
| 形状が緯度で変わる | **実装済み** | 緯度帯循環・貿易風/偏西風/極東風(`atmospheric-wind.ts:12-44`)、温帯限定前線と熱帯雨帯(`weather-model.ts:94-95,265,278-281`)、緯度別低気圧進路(`cyclone-tracks.ts:48-49,112-125`)、緯度依存圏界面 赤道17km→極9km(`weather-model.ts:118-121,424`)、コリオリで半球ごと渦向き反転(`wind-law.ts:64-88`) |
| 陸地/海で変わる | **実装済み** | 気候テクスチャから陸度(`climate-map.ts:101-104`)。海洋性層積雲は海限定(`condensation.ts:114-131`)、陸で対流活発度上昇(`convective-activity.ts:39`)、地形性上昇流、平年雲量の湿度バイアス(`weather-model.ts:158-164,286,293`)、熱帯低気圧は海上進路のみ |
| 風に乗って移動 | **実装済み** | 3層: 緯度帯物理風でノイズ座標を回すキャリー(`circulation.ts:76-139`)、場の2位相移流(`weather-transport.ts:55,135-160`、周期20h)、進路を辿る低気圧と位相速度3°/日のロスビー波(`rossby-wave.ts:13,44-46`) |
| セルの成長→崩壊 | **部分的** | 低気圧・台風は完全な一生(発生→最盛→衰退→消滅、寿命4〜10日、台風は温帯化、`cyclone-tracks.ts:38-45,196-213,255-270`)。総観規模は18h周期のエポック混ぜ替えでその場発達・衰退(`circulating-noise.ts:28-45,77-124`)。**個別対流セル(48/24km粒)の発生→成長→消滅は無い** — 対流ノイズはエポック非参加(`weather-transport.ts:88`)で粒は流れるだけ |

### 未実装の残り

- **対流セル単位のライフサイクル**: セルの発生時刻・寿命・段階状態を持つ仕組みが存在しない。
  「時空間格子にハッシュでセルを置き解析的に段階を出す」案は
  `suspended/cloud-lifecycle-leo-realism-proposal_2026-09-27.md` として未承認のまま。
- 通常積乱雲の風下側かなとこのせん断広がり(既存 anvil は渦の芯に貼り付く超ガウス円盤のみ、
  `cyclones.ts:122`)、かなとこが親塔から分離して残存巻雲へ変質する流れ(SPEC `RENDERING.md:567-569`)。

## 2. 実写近似の基盤

「実写参照取得 → 分離 → 撮影 → 同じ物差しで計測 → 封筒距離 → 履歴・差分・判定」の閉じたループが
**尺度帯ごとに2系統**動いている。

### 実写の供給源(3系統)

- `src/assets/8k_clouds.jpg` — solarsystemscope の 8k グレースケール雲(赤道 ~4.9km/texel)。
  分離パイプラインと cloud-lab「実写」ビューの入力。
- NASA Worldview Snapshots API — 台風 VIIRS 真色3例(`cloud-lab-reference.mjs`)と MODIS 250m
  真色14場面(`cloud-detail-reference.mjs`、`tools/cloud-detail/scenes.json` が目録)。
- NASA GIBS WMS — ひまわり AHI Band13 IR の時系列(Worldview は静止衛星レイヤで真っ黒を返すため)。
  夜でも雲が写る赤外を使う。

### 分離(`cloud-lab:separate`)

`tools/cloud-lab/separation-pipeline.ts`(426行)。高度次元が無いので構造テンソルの固有値で
巻雲らしさ(筋の向き)を検出し、スクリーン合成の逆算 `thick=(実写−veil)/(1−veil)` で分離。
出力は生成と同じ RGBA 規約(R=積雲量 G=巻雲量 B/A=筋の倍角ベクトル)で
`src/assets/cloud-field.png` へ → `ObservedCloudField` 経由で**実写ベースの雲を本番描画へ
載せる経路が通っている**。既知の癖(veil が 0 に落ちる所、雲頂は輝度推定、sRGB 未補正)があり、
`memos/hedalu244/cloud-generation/reference-separation.md` が「目標値にしない」と明記。

### 物差し(2層)

- **大きい尺度(~25–800km)**: `cloud-lab:compare` が全球+7capを撮影し、帯状平均/階調/
  スペクトル/構造/塊/地形/雲頂/台風/動きの表を実写成分・Worldview・ひまわりと比較。
- **細かい尺度(0.5–500km)**: `cloud-detail:compare` が `tools/cloud-detail-metrics.mjs` の
  `measureCloudDetail()` で FFT 傾き β・オクターブ・間欠性(DoG 尖度・変動係数)・周期性・
  形状(寸法分布冪 b、周長–面積次元 D)・異方性を計測。実写封筒(kind・category 別、最小〜最大+10%)
  からの正規化距離 → 家族平均 index。`variety` で「どの場面も同じ質感」を罰する。
- **尺度の梯子**: cloud-detail-compare が `.cloud-lab/history/` 最新の capSpectrum/spectrumGlobe
  を繋いで 0.5–1024km の1表にする(`cloud-detail-compare.mjs:703-755`)。
- 履歴は `<時刻>-<git sha>.json`、差分は `VERDICT_BAND=0.05` で改善/悪化/横ばいを判定。
  `cloud-distances.mjs` が sections から距離を再計算する純粋関数で、定義変更に遡及適用できる。

### 撮影

全てヘッドレス Chrome+CDP(`tools/chrome-session.mjs`)。cloud-lab は本体と同じ
`earthGeneratedCloudField` 工場で場の値を値のまま出す(描画パイプラインは通らない)。
cloud-detail は render-lab 経由で**本番の `earthCloudPresentation()` 全パイプライン
(トーンマップ・sRGB 込み)の最終絵**を実写と同じ km/px で撮る(9海域×3時刻×3段×3種=243枚、
`captureSettled` で決定性担保)。`render-lab:measure` が雲3パスの GPU 時間を出す。

## 3. 整っているもの / 足りないもの

**整っている**

- 2尺度帯の計測→封筒距離→履歴→前回差分の閉じたループ
- 実験環境が本番と同じ生成工場・cap テクスチャ・描画パイプラインを通る
- 物差しが文献検算付き(b=1.66±0.3 Wood&Field 2011、D=1.35±0.1 Lovejoy 1982)で、
  物差し自身の自己検査(`cloud-detail:selftest`)もある
- 実写ベース雲を本番へ載せる `ObservedCloudField` 経路

**足りない**

- **8〜100km の尺度の穴** — 生成の最細段(対流24〜48km)と描画細部の最粗段(8km)の間に担い手が無い。
  `feat/cloud-scale-continuity` で作業中(計画: `cloud-scale-continuity-plan_2026-11-14.md`)。
- **個別対流セルのライフサイクルと描画細部の環境応答・時間変化が無い** — 5機能表の「部分的」と同じ穴。
  閉形式セル寿命(suspended 提案)・cellular noise 組織化
  (`suspended/cloud-cell-organization-plan_2026-09-11.md`)ともに未承認。
- **CI 組み込みが無い** — cloud 系ツールは全て手動実行。`tools/run-ci.mjs`・PR ワークフローに無く、
  `.cloud-lab/`・`.cloud-detail/`・`.render-lab*` は `.gitignore` で実写参照と履歴はローカル蓄積。
- **封筒の場面数が少ない** — kind あたり数場面、陸3場面は判定外、外し撮影29枚はハードコード固定
  (`EXCLUDED_NEAR_CLEAR_SHOTS`)。
- **教師付き基盤は構想段階**(調査時点) — 「環境が同じなら統計が同じ」教師(場面へ環境ラベルを
  付け記述子を比較)は `cloud-scale-continuity-plan_2026-11-14.md` に考え方だけある。
  ※ 追記のとおり描画経路の教師比較(render-capture 系 + reference-fine 系)は devin/dev に実装済み。
- `cloud-detail` と `cloud-lab` の統合が `dev.md:583` にユーザー指示メモとして残るが未実施。

## 4. 読み取れる方向

要求の骨格(風・緯度・陸海・移流)は描画経路で実現済みで、足りないのは**個別セルのライフサイクル**
と**8〜100km の尺度の担い手**。どちらも `feat/cloud-scale-continuity` の計画と suspended 提案群が
同じ穴を指している。基盤側の次の大きな手は教師付き基盤(環境ラベル付き封筒)と CI/履歴の共有だが、
後者は実写参照の配布方法(ローカル蓄積のままか、何らかの形で共有するか)の決めが要る。

# 地球雲システム・リアリズム改善 修正計画書

## 1. 目的

現在の地球雲システムについて、宇宙・低軌道から観察した際の見た目と時間変化を、ひまわり等の静止気象衛星画像・動画に近づける。

本修正では特に次の問題を解決する。

* 個々の雲塊が実際より大きく、雲系内部の細かな構造が不足している。
* 大規模な雲域は移動するが、その内部で数十分〜数時間スケールの積雲・積乱雲が発生、成長、衰退する挙動が不足している。
* 雲の濃淡が「不透明な雲」と「半透明な雲」に大別され、中間的な光学的厚さが乏しい。
* 雲表面がほぼ単一スケールのノイズで変形されるため、全球で似た粒状感となっている。
* 前線雲、海洋性層積雲、積乱雲、巻雲など、形成機構の異なる雲が十分に異なる形状を持たない。
* 現在の気象モデルが持つ湿度、上昇流、対流活動、前線、低気圧等の情報が、最終的な雲形状へ十分に利用されていない。

全面的な数値気象モデルや3D流体計算への置換は行わない。現在の `WeatherModel` を全球・総観規模の気象場として維持し、その下にメソスケール・対流セルスケールの生成層を追加する。

## 2. 現在の構造と問題点

現在の生成経路は概ね次の構造である。

```text
AnnualClimateMap
      ↓
WeatherModel
      ↓
condense()
      ↓
CloudField 1024 × 512
      ↓
CloudShapeEvaluator
      ↓
OpaqueCloudSurfaceRenderer
CloudAtmosphereRenderer
CloudShadowRenderer
```

全球 CloudField は正距円筒図法の1024×512であり、赤道上では1 texelがおよそ39 kmに相当する。この解像度は低気圧、前線、ITCZ、広域の湿潤域を表現するには適しているが、数kmスケールの積雲そのものを表すには粗い。

したがって今後は CloudField を「最終的な雲形状」ではなく「雲が存在しやすい大規模 envelope」として扱う。

また現在 `CloudShapeEvaluator` は約6 kmを基準とした単一の粒状ノイズを利用している。これは輪郭の微細化には利用できるが、異なる雲種や異なる発達段階を生成する機構としては不足している。

## 3. 目標アーキテクチャ

雲生成を以下の3階層に分離する。

```text
┌────────────────────────────┐
│ 1. Synoptic / Mesoscale    │
│ WeatherModel               │
│ 50–3000 km                 │
│                            │
│ pressure / humidity        │
│ front / cyclone / ITCZ     │
│ lift / convection          │
└─────────────┬──────────────┘
              ↓
┌────────────────────────────┐
│ 2. Cloud Population        │
│ 1–200 km                   │
│                            │
│ convective cells           │
│ stratocumulus cells        │
│ frontal structures         │
│ anvils / cirrus            │
│ birth / growth / decay     │
└─────────────┬──────────────┘
              ↓
┌────────────────────────────┐
│ 3. Sub-grid Shape          │
│ 0.1–5 km                   │
│                            │
│ edge erosion               │
│ cloud-top variation        │
│ turrets                    │
│ filament / holes           │
└─────────────┬──────────────┘
              ↓
           Renderer
```

`WeatherModel` の責務は変更しない。主な変更対象は `condense()` より後段、および `WeatherModel` と CloudField の間である。

## 4. Phase 1: CloudField の役割変更

### 4.1 CloudField を大規模 envelope として再定義する

現在の `coverage` を「そのtexelを直接雲として描画する割合」から、「その地域で雲セルが存在できる確率・密度」へ意味変更する。

想定する出力例:

```ts
interface CloudEnvironment {
    cloudPotential: number;
    convectivePotential: number;
    stratiformPotential: number;
    upperCloudPotential: number;

    moisture: number;
    lift: number;
    organization: number;

    cloudBase: number;
    equilibriumTop: number;
}
```

既存 `CloudSample` はレンダラーとの互換性維持のため即時廃止せず、新しい中間値から生成する。

### 4.2 既存 WeatherModel は維持する

以下は大規模場としてそのまま利用する。

* `surfaceHumidity`
* `upperHumidity`
* `lift`
* `convection`
* `convectiveActivity`
* `band`
* `anvil`
* `warmth`
* `forcing.organization`
* `forcing.windPerturbation`
* `surfaceWind`
* upper-level wind

低気圧、前線、Rossby wave、ITCZ、地形上昇等のロジックは原則変更しない。

## 5. Phase 2: 対流セル生成層の追加

新規に `CloudPopulation` または `ConvectiveCellField` を追加する。

推奨配置:

```text
src/render/cloud/
    cloud-population.ts
    convective-cell.ts
    cloud-event-hash.ts
```

### 5.1 セル発生

地球を数km〜数十km単位の論理セルへ分割する。

各セル・時間スロットについて決定論的hashを生成する。

```ts
eventSeed = hash(
    spatialCellId,
    timeSlot,
    globalSeed
)
```

発生確率は概念的に、

```text
birthRate =
    humidity
  × positiveLift
  × convectivePotential
  × organizationModifier
  × regimeModifier
```

とする。

重要なのは `convectiveActivity` を単なる雲量増幅として使用するだけでなく、**新規セルの発生率**として利用することである。

### 5.2 セルのライフサイクル

一つの対流セルに以下を持たせる。

```ts
interface ConvectiveCell {
    origin: Direction;
    birthTime: number;
    lifetime: number;

    radius: number;
    baseHeight: number;
    topHeight: number;

    intensity: number;
    anvilStrength: number;

    driftVelocity: Vec2;
}
```

時間変化は原則解析関数とし、セル状態を毎フレーム積分しない。

```text
birth
  ↓
growing cumulus
  ↓
towering cumulus
  ↓
mature convection
  ↓
decay
  ↓
residual anvil / stratiform cloud
```

基準時間は以下から開始し、後で視覚比較により校正する。

```text
0–10 min      initial cumulus
10–25 min     rapid vertical growth
25–40 min     mature cell
40–60 min     collapse
30–120 min    residual anvil
```

時間スキップ時にも同じ結果を得るため、イベントは必ず絶対時刻から再構成可能にする。

### 5.3 移流

対流セルの低層部分は中低層風、anvil は上層風で移流する。

これにより、

```text
tower → vertical growth
anvil → downstream spreading
```

という異方的な形状を作る。

既存 `surfaceWind` と `upperCirculation` / upper wind の差を利用する。

## 6. Phase 3: 局所高解像度 Cloud Field

全球 CloudField の解像度を4096×2048等へ単純に増加させる方法は採用しない。

代わりに既存の `OrthographicCap` を利用し、カメラ周辺のみ高解像度化する。

構成例:

```text
Global Equirect Field
1024 × 512
~39 km/texel
       +
Local Orthographic Cap
1024 × 1024
~1–5 km/texel
```

局所 cap の対象は、

* カメラ直下
* 画面中心
* 地球limb付近
* 高詳細設定時

などから選択する。

### LOD

概念的には以下とする。

```text
地球全景
    global CloudFieldのみ

中距離
    global + coarse local field

LEO
    global + high-resolution local field
```

cap の移動時には境界のpopを避けるため、旧capと新capを一定時間クロスフェードする。

## 7. Phase 4: Cloud Regime の導入

全雲を同じ `gradientNoise` で変形することをやめる。

以下の regime を最低限区別する。

```ts
type CloudRegime =
    | "shallow-cumulus"
    | "deep-convection"
    | "stratocumulus"
    | "frontal"
    | "cirrus";
```

### Shallow cumulus

特徴:

* 小さな独立セル
* 高密度な中心部
* 周辺に小雲
* 比較的低い雲頂
* 短寿命

形状:

```text
cell blobs
+ edge erosion
+ small daughter cells
```

### Deep convection

特徴:

* 強い鉛直成長
* 狭いtower
* 高い雲頂
* anvil
* overshooting-top的な局所突出

形状:

```text
tower
+ expanding upper radius
+ anvil
+ top perturbations
```

### Stratocumulus

特徴:

* 多数のセル状構造
* open-cell / closed-cell 的パターン
* 雲頂高度は比較的揃う
* 穴が重要

形状:

```text
cellular Worley-like structure
+ low-frequency deformation
```

単純なVoronoi境界そのものは使用せず、距離場を歪ませて自然なセルへ変換する。

### Frontal cloud

特徴:

* 数百〜数千kmの帯
* 前線方向へ長く伸びる
* 横方向と縦方向でスケールが異なる

既存 `frontForcing` から前線方向を推定し、anisotropic noiseを使用する。

### Cirrus

特徴:

* 上層風方向へ伸びる
* filament状
* 非常に低い〜中程度のoptical depth
* anvilから派生するものと独立巻雲を区別可能にする

## 8. Phase 5: 光学的厚さ中心の表現へ変更

現在の `coverage` と `translucent` の二分的な意味を弱める。

中心的な値として `opticalDepth` を導入する。

```ts
interface CloudOpticalSample {
    opticalDepth: number;
    liquidOpticalDepth: number;
    iceOpticalDepth: number;

    cloudTop: number;
    cloudBase: number;
}
```

既存の

```text
T = exp(-τ × airmass)
```

系の実装をそのまま利用する。

### Renderer の使い分け

完全な統一ボリュームレンダラーへの変更は行わない。

```text
very low τ
    CloudAtmosphereRenderer

low / medium τ
    analytic shell / stochastic transparency

high τ
    OpaqueCloudSurfaceRenderer
```

とする。

重要なのはrenderer種別を雲種で固定するのではなく、局所 `τ` によって連続的に遷移させることである。

不透明rendererへの移行域ではディザリングまたはblue-noise thresholdを利用し、描画方式の境界を目立たなくする。

## 9. Phase 6: 雲頂高度の改善

現在の単一粒度による雲頂変動を以下に分解する。

```text
cloudTop =
    synopticTop
  + cellTop
  + turretTop
  + subgridNoise
```

deep convection ではセル中心ほど高くする。

例:

```text
          overshoot
              ▲
          /\  │
      /\ /  \ │
─────/──V────\──── anvil
```

anvil部分は高度変動を小さくし、active tower部分だけ大きな変化を持たせる。

`cloudTop` の高度勾配から法線を生成し、現在の球殻表面法線より局所的な立体感を強める。

## 10. Phase 7: 簡易 self-shadow

完全な3D volumetric ray marchは導入しない。

代わりに雲頂height fieldに対し、太陽方向へ少数回サンプルする。

例:

```text
4–8 taps
```

で

```text
neighbor cloudTop > expected ray altitude
```

の場合に遮蔽を増加させる。

これにより、

* 積雲の暗い側面
* bright top
* tower同士の陰影
* anvil下の陰影

を追加する。

既存 `CloudShadowRenderer` の地表影とは別の、雲内部の視覚表現として実装する。

## 11. 更新周期

すべてを毎表示フレーム再生成しない。

推奨初期設定:

```text
WeatherModel
    20 sim min

global cloud envelope
    10–20 sim min

cloud population
    5 sim min event slots

local cap
    2–5 sim min

cell lifecycle
    analytical every frame

sub-grid shape
    shader evaluation every frame
```

気象時刻間は補間する。

これにより、大規模場はゆっくり変化しながら、その内部ではセルが高速に生成・消滅する二重の時間スケールを作る。

## 12. Performance 方針

### 禁止事項

以下は初期実装では行わない。

* 全球3D voxel cloud
* 全球高解像度4096²以上の毎フレームbake
* Navier–StokesまたはLESの実時間計算
* 雲全体に数十〜数百stepのvolumetric ray marching

### GPU budget

新規処理は既存の、

```text
cloudBake
cloudSurface
cloudAtmosphere
cloudShadow
```

の計測とは分離する。

追加候補:

```text
cloudPopulationBake
cloudLocalField
cloudSelfShadow
```

品質設定ごとに処理を切る。

```text
coarse:
    global fieldのみ

standard:
    local field
    cell lifecycle

fine:
    local high-resolution field
    self-shadow
    full regime shape
```

## 13. 実装順序

### Step 1

`CloudEnvironment` を追加し、既存 `condense()` の入力・出力を整理する。

見た目は変えず、内部構造のみ変更する。

### Step 2

`ConvectiveCell` と決定論的 event hash を実装する。

まずCPU参照実装を作り、

```text
同じ方向
同じ時刻
同じseed
→ 常に同じセル
```

をテストする。

### Step 3

セル lifecycle を既存 CloudField に加算する。

この段階ではrendererは変更しない。

最初の視覚目標は、

「同じ雲域内で30〜60分単位に白い対流セルが発生・拡大・消滅する」

状態とする。

### Step 4

`OrthographicCap` を通常地球経路へ導入する。

低軌道表示で数kmスケールの構造を追加する。

### Step 5

`CloudRegime` を追加する。

最初は

```text
shallow-cumulus
deep-convection
stratiform
```

の3種類だけ実装し、その後 frontal / cirrus を分離する。

### Step 6

optical depthをCloudFieldの第一級データへ変更する。

中間的な濃度を増やす。

### Step 7

cloud-top shapeとself-shadowを追加する。

ここまで完了した時点で、衛星映像との見た目比較を行う。

## 14. テスト

### Determinism

```text
weatherAt(t, position)
cloudPopulationAt(t, position)
```

が同じ入力に対して完全に同じ結果を返すこと。

### Temporal continuity

時間を

```text
t
t + 1 s
t + 10 s
```

と変化させてもセル位置・サイズが飛ばないこと。

### Time jump

```text
t → t + 12 h
```

へ直接ジャンプした結果と、逐次進行した結果が一致すること。

### Spatial continuity

OrthographicCapの境界および再配置時に雲が瞬間的に生成・消滅しないこと。

### Optical continuity

opaque / translucent renderer の切替域で輝度や透過率が不連続にならないこと。

### Existing contracts

以下の既存テストは維持する。

* cyclone tracks
* atmospheric wind
* weather time
* cloud optics
* cloud model contracts
* earth system

## 15. Visual Regression

`cloud-lab` に比較用プリセットを追加する。

最低限以下を用意する。

```text
tropical-ocean-daytime
tropical-land-afternoon
midlatitude-front
marine-stratocumulus
deep-convection
limb-view
leo-closeup
```

各プリセットで、

```text
T
T + 30 min
T + 1 h
T + 3 h
T + 12 h
```

を自動撮影する。

静止画だけでなく連続フレームを確認し、「移動が自然か」だけでなく「発生・消滅が自然か」を評価する。

## 16. 完了条件

本修正は以下を満たした時点で完了とする。

1. 全球CloudField上の巨大な均一blobが減少し、低軌道では数km〜数十kmスケールの個別雲構造が確認できる。
2. 同一地点を数時間観察すると、雲域全体の移流とは独立して新しい積雲セルが継続的に発生・成長・消滅する。
3. deep convectionではtower、anvil、衰退後の残留上層雲が時間的に区別できる。
4. 海洋性層積雲、対流雲、前線雲が同一の粒状テクスチャに見えない。
5. 雲の透過率が二値的ではなく、薄い雲から非常に厚い雲まで連続して見える。
6. 雲頂に大小複数スケールの高度差があり、斜光時に立体構造が視認できる。
7. 地球全景時のGPU負荷を大きく増加させず、追加高詳細計算が主としてLEO・高LOD時だけ発生する。
8. 時刻ジャンプ、再ロード、同一seedで結果が再現可能である。

## 17. 最終的な責務分離

修正後の責務は以下とする。

```text
AnnualClimateMap
    「どこがどのような気候か」

WeatherModel
    「現在どこが湿潤・上昇・収束しているか」

CloudEnvironment
    「どこでどの種類の雲が成立可能か」

CloudPopulation
    「どの雲セルがいつ発生し、今どの発達段階か」

CloudShape
    「各セルが空間的にどのような形をしているか」

CloudOptics
    「その雲がどれだけ光を透過・散乱するか」

Renderer
    「現在のLODと画面条件でどう近似描画するか」
```

この責務分離を維持し、気象モデル側に描画ノイズを持ち込まず、renderer側に前線・対流発生等の気象ロジックを持ち込まないことを設計上の原則とする。

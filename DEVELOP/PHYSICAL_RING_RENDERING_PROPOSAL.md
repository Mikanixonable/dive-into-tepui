# 天体環の物理・光学レンダリング修正案

## 目的

現在の環描画を、固定 `opacity` による記号的な半透明表示から、観測幾何と環ごとの光学特性に応じて変化する表示へ置き換える。

目標は次のとおり。

- 法線光学的厚さ、観測開き角、太陽高度に応じた透過と散乱を表現する。
- 密な環と希薄な塵環を同じ材質値で描かない。
- 順光では見えにくく、逆光では前方散乱で浮かぶ塵環を表現する。
- 惑星による環の影と、環による惑星面の減光を表現する。
- マップビューと戦闘ビューで同じ物理モデルを使い、視認性強調が必要な場合は物理表示と明示的に分離する。
- サブピクセル環の総光量を保ち、1px線への切り替えで濃くならないようにする。

「写真と完全一致」ではなく、可視光の単色近似として物理量の依存関係と桁を正しくすることを第一段階の完成条件とする。

## 現状の問題

### 固定値が全環へ適用される

`src/game/celestial/ring-view.ts` は非テクスチャ環へ共通して次を使用している。

```ts
RING_OPACITY = 0.3
LINE_OPACITY = 0.5
TORUS_OPACITY = 0.18
```

正面視の単純な吸収板として換算すると、それぞれ法線光学的厚さ `τn ≈ 0.357`、`0.693`、`0.198` に相当する。実際には木星主環や土星E/G環が `10^-5〜10^-6` 級である一方、土星B環や天王星の一部の狭環は `τn > 1` であり、共通値では双方を再現できない。

### 固定アルファは光学的厚さではない

光を遮るだけの一様な薄板近似でも、視線方向の透過率は次になる。

```text
muView = abs(dot(ringNormal, viewDirection))
tauView = tauNormal / max(muView, epsilon)
transmittance = exp(-tauView)
extinctionAlpha = 1 - transmittance
```

したがって、実測 `tauNormal` をそのまま Three.js の `opacity` へ入れても正しくない。また、散乱でカメラへ入る光は遮光量とは別に計算する必要がある。

### 太陽・位相角・影を使っていない

環は `MeshBasicMaterial` で描かれ、太陽方向を受け取らない。このため昼夜、順光・逆光、表裏、惑星影がすべて同じ明るさになる。希薄な塵環の強い前方散乱も再現されない。

### 1px線LODが光量を増やす

帯幅が1px未満になると `opacity=0.5` の線に置換される。ピクセル被覆率を考慮しないため、本来消える細環ほど目立つ。

### 拡散環の形状が穴のない扁平球

`createTorusRing` は `SphereGeometry` を扁平化しており、内径より内側も満たす。前面と背面の重複合成も起きるため、希薄な環がさらに濃くなる。

### ビュー間で表示モデルが異なる

木星・土星・天王星は戦闘ビューで `PointBody` の光点へ置換され、環が消える。海王星、Quaoar、Charikloは `SphereBody` の距離圧縮メッシュとして環が残る。環を解像できない場合の扱いを天体クラスではなく、実際の画面占有サイズと積分光度で統一する必要がある。

## 採用する光学モデル

### 1. データモデル

`RingBandDef` に描画用の物理パラメータを追加する。

```ts
export type RingOpticsDef = {
  // 環面に垂直な可視光の消散光学的厚さ。
  readonly normalOpticalDepth: number;

  // 粒子に当たった光のうち吸収されず散乱される割合。
  readonly singleScatteringAlbedo: number;

  // Henyey-Greenstein 位相関数の非対称係数。0=等方、正=前方散乱。
  readonly phaseG: number;

  // 可視光での代表色。線形RGBとしてシェーダへ渡す。
  readonly color: readonly [number, number, number];

  // 放射方向のτプロファイルテクスチャ。必要な帯のみ指定する。
  readonly opticalDepthTexture?: RingOpticalDepthTextureId;

  // 一様な面ではなく体積密度として扱う拡散環。
  readonly volumetric?: {
    readonly radialScale: number;
    readonly verticalScale: number;
  };
};

export type RingBandDef = {
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly thickness: number;
  readonly arcs?: readonly RingArcDef[];
  readonly optics: RingOpticsDef;
};
```

アークは単なる重ね描きではなく、区間ごとの `normalOpticalDepth` 倍率として表現する。

```ts
export type RingArcDef = {
  readonly fromDeg: number;
  readonly toDeg: number;
  readonly opticalDepthScale: number;
};
```

これにより、基準環とアークを2枚重ねて実効alphaが意図せず上がる問題をなくす。

### 2. 薄い環の透過

平面環のフラグメントごとに、視線方向の光学的厚さを求める。

```text
muV = clamp(abs(dot(N, V)), muMin, 1)
tauV = tauN / muV
Tview = exp(-tauV)
alpha = 1 - Tview
```

`muMin` は数値発散を防ぐための下限であり、物理上の環厚とピクセルフットプリントから導く。固定値にする場合も `0.01` 程度から検証し、エッジオンで不自然な完全不透明面にならないようにする。

高光学的厚さでは単一散乱近似が破綻するが、透過についてはこの式で密な環が自然に飽和する。第一段階として十分である。

### 3. 単一散乱による反射光

太陽方向 `L`、カメラ方向 `V`、環面法線 `N` を使用する。

```text
mu0 = max(abs(dot(N, L)), epsilon)
mu  = max(abs(dot(N, V)), epsilon)
tauL = tauN / mu0
tauV = tauN / mu
phase = HG(dot(-L, V), g)

scattered = solarRadiance
          * singleScatteringAlbedo
          * phase
          * illuminationFactor(tauL, tauV)
          * ringColor
```

Henyey–Greenstein位相関数は次を使う。

```text
HG(cosTheta, g) = (1 - g^2) /
                  (4π * (1 + g^2 - 2g cosTheta)^(3/2))
```

第一実装では薄い環向けに、

```text
illuminationFactor ≈ (1 - exp(-tauL)) * exp(-0.5 * tauV)
```

を用いる。密な土星A/B環には、単一散乱の飽和と自己遮蔽を調整する別係数を導入し、Cassini画像と開き角別に回帰する。

重要なのは、描画色のalphaと放射輝度を分離することである。背景の遮光は `Tview`、環自身の明るさは `scattered` から計算する。

### 4. 惑星による環の影

各フラグメントから太陽方向へレイを伸ばし、中心天体の回転楕円体または第一段階では外接球と交差するか判定する。交差時は直射散乱を0にする。

```text
shadow = raySphereOccluded(fragmentPosition, sunDirection, bodyCenter, bodyRadius)
directLight *= 1 - shadow
```

境界には太陽の有限角直径を近似した `smoothstep` を使い、硬すぎる影を避ける。将来は天体ごとの扁平形状を使う。

### 5. 環が惑星へ落とす影

惑星表面シェーダで、表面点から太陽へ向かうレイと環平面の交点を求める。交点半径が帯内なら、太陽方向に対する光学的厚さから減光する。

```text
surfaceTransmission = exp(-tauNormalAt(ringPlaneHit) / muSun)
surfaceDirectLight *= surfaceTransmission
```

複数帯は透過率を乗算する。土星本体で最も見た目への寄与が大きいため、薄い環シェーダの次に実装する。

### 6. 拡散環の体積積分

木星ハロー・ゴサマー環、土星E環、フェーベ環は面ではなく低密度の3次元分布として扱う。穴のない扁平球を廃止し、内外半径を持つ境界ボリューム内で密度を評価する。

```text
rho(r, y) = radialProfile(r) * exp(-abs(y) / verticalScale)
```

カメラレイとボリュームの交差区間を8〜16ステップで積分し、各点で消散と単一散乱を加算する。画面上で小さい場合は解析的な柱密度近似へ落とす。

初期実装では専用レイマーチを避け、内外半径を持つ複数の薄い円筒シェルへ分割する方法でもよい。ただし現在の扁平球より、空洞・放射分布・経路長を保持できることを条件とする。

## 土星主環のデータ

現在の `2k_saturn_ring_alpha.png` は視覚用RGBA画像であり、alphaを物理的なτとして扱わない。

代わりに以下を分離する。

- `saturn-ring-tau`: 放射方向の法線光学的厚さ。線形値または対数符号化。
- `saturn-ring-albedo`: 可視光反射色。
- 必要なら `saturn-ring-phase-g`: 粒径構成に応じた位相関数係数。

PDS/Cassiniの掩蔽プロファイルを再配布条件を確認して前処理し、1次元テクスチャへ変換する。データが用意できるまではD/C/B/Cassini Division/Aを複数bandへ分割し、PDS代表値を設定する。

暫定値の出発点は次とする。

| 帯 | `tauNormal` の初期範囲 |
|---|---:|
| D | `1e-5〜1e-3` |
| C | `0.05〜0.35` |
| B | `0.4〜2.5`、高密度部はより高くする |
| Cassini Division | `0〜0.2` |
| A | `0.4〜1.0` |
| F | `0.1` 前後 |
| G | `1e-6` 前後 |
| E | `1e-6〜5e-6` |
| Phoebe | `2e-8` 前後 |

## その他の環の初期パラメータ方針

値は代表値であり、実装時に一次文献の波長・観測幾何・定義を再確認する。

- 木星主環: `tauNormal ≈ 6e-6〜1e-5`。小粒子向けに強い前方散乱 `g > 0` を設定する。
- 木星ゴサマー環: `tauNormal ≈ 1e-7`。主環よりさらに前方散乱優位とする。
- 天王星の狭い主環: 帯ごとに個別値を持たせる。密な部分は `tauNormal >= 1`、ν・μ塵環は `1e-5` 級として分離する。
- 海王星連続環: 多くを `tauNormal <= 0.004` とし、アダムス環アークのみ `0.03〜0.1` 程度へ上げる。
- Chariklo C1R/C2R: 初期値をそれぞれ `0.4`、`0.06` とする。
- Quaoar Q1R: 低密度の幅広成分と `tauNormal ≈ 0.4` の狭い核を分割する。Q2Rは `0.004` 程度から開始する。

## LODとビュー統一

### 物理表示LOD

annulusと線を固定閾値で切り替える現在方式をやめ、ピクセル被覆率を使う。

```text
projectedWidthPx = physicalWidth / metersPerPixel
coverage = clamp(projectedWidthPx, 0, 1)
pixelAlpha = 1 - exp(-tauView * coverage)
pixelRadiance = resolvedRadiance * coverage
```

1px未満では線を使ってもよいが、alphaと放射輝度を `coverage` で減らす。これによりズーム前後で総光量が連続し、希薄環は自然に消える。

アンチエイリアスだけでは安定しない場合、2px付近からannulusとlineをクロスフェードする。

### マップ上の視認性強調

物理表示では木星や土星E環の多くは通常条件で見えない。ゲーム上の情報として表示する必要がある場合は、物理シェーダのopacityを改変せず、別のオーバーレイとして表現する。

- 設定名例: `天体環を強調表示`
- 表示例: 細い破線、輪郭線、ラベル
- 色: HUDの単色規則に従う
- デフォルト: 物理表示。マップ上の必要性を確認後に強調表示を追加する

これにより「本物の環」と「地図記号」を混同しない。

### 戦闘ビュー

天体クラスによる `PointBody` / `SphereBody` の分岐ではなく、投影サイズで決める。

- 惑星本体または環外径が十分なピクセル数を持つ: 物理環メッシュを描画。
- サブピクセル: 惑星と環を合算した積分光度を輝点へ反映する。
- 環だけを非表示にして惑星を固定輝点へ置換しない。

積分光度を正確に求めるのが重い場合、天体・位相角・環開き角から求める低解像度近似を使用する。

## 実装構成案

### 変更対象

- `src/physics/solar-system.ts`
  - `RingOpticsDef`、帯ごとの物理値、アークτ倍率を追加。
- `src/render/ring.ts`
  - `MeshBasicMaterial`をTSLノード材質へ置換。
  - 観測角透過、単一散乱、惑星影を実装。
  - 穴のない扁平球を廃止。
- `src/game/celestial/ring-view.ts`
  - 太陽方向、カメラ位置、天体中心・半径をシェーダへ同期。
  - 二値判定から被覆率保存・クロスフェードのLODへ変更。
- `src/game/celestial/sphere-body.ts`
- `src/game/celestial/point-body.ts`
  - ビュー別分岐を投影サイズベースへ統合。
- `src/render/celestial-surface.ts`
  - 環による惑星表面の減光を追加。
- `src/assets/`
  - 土星のτプロファイルとアルベドを分離したテクスチャを追加。

### シェーダuniform

最低限、各環へ以下を渡す。

```ts
type RingUniforms = {
  bodyCenter: THREE.Vector3;
  bodyRadius: number;
  sunDirection: THREE.Vector3;
  cameraPosition: THREE.Vector3;
  normalOpticalDepth: number;
  singleScatteringAlbedo: number;
  phaseG: number;
  lodCoverage: number;
};
```

`sunDirection` は本体表面と同様に真の天体位置から計算する。戦闘ビューで描画位置を圧縮しても、照明方向は真の位置を基準にする。

## 実装順序

### Phase 1: データと薄板透過

1. `RingBandDef`へ光学パラメータを追加する。
2. 非テクスチャ環を帯ごとのτへ移行する。
3. 観測開き角から `alpha = 1 - exp(-tauN / muV)` を計算する。
4. アークを重ね描きではなくτ倍率へ変更する。
5. 1px LODに被覆率補正を入れる。

この段階だけでも「全環が0.3」「遠方ほど0.5」の主要問題を解消できる。

### Phase 2: 照明と位相関数

1. 太陽方向と単一散乱を追加する。
2. Henyey–Greenstein近似で塵環の前方散乱を実装する。
3. 惑星が環へ落とす影を追加する。
4. 順光、90度位相、逆光で基準画像と比較する。

### Phase 3: 土星主環

1. D/C/B/Cassini/Aを物理bandへ分割する。
2. PDSプロファイルから1次元τテクスチャを作る。
3. アルベドテクスチャを分離する。
4. 環による土星表面の影を実装する。

### Phase 4: 拡散環

1. 扁平球を内外径付き密度分布へ置換する。
2. 短いレイマーチまたは柱密度近似を実装する。
3. 木星・土星の塵環を位相角別に調整する。

### Phase 5: ビュー統一

1. `PointBody`の環非表示を投影サイズ判定へ置換する。
2. サブピクセル時の積分光度を輝点へ反映する。
3. マップ用の視認性オーバーレイを必要に応じて追加する。

## 検証計画

### 数値テスト

純関数として次を切り出す。

```ts
ringTransmission(tauNormal, muView)
henyeyGreenstein(cosTheta, g)
ringPixelCoverage(widthMeters, metersPerPixel)
ringArcOpticalDepth(baseTau, arcScale, longitude)
```

最低限の検証項目:

- `tau=0`で透過率1。
- `tau→∞`で透過率0。
- 正面視では `T=exp(-tau)`。
- エッジオンへ近づくほど透過率が単調減少する。
- LOD境界の前後で積分alpha・積分放射輝度が連続する。
- アーク外で基準τ、アーク内で倍率適用後のτになる。

### 画像回帰

各環付き天体について以下を固定カメラで撮る。

- 開き角: `90°`, `30°`, `5°`, ほぼエッジオン。
- 位相角: `0°`, `90°`, `150°`以上。
- 表側・裏側。
- 惑星影を横切る構図。
- annulus/line LOD境界の前後。
- マップビューと戦闘ビューで同じ角サイズとなる構図。

比較対象はNASA/JPL/PDSの未加工または処理内容が明記された画像を優先し、自動露出や強調処理済み画像を絶対輝度の基準にしない。

### 性能基準

- 平面環は既存環と同程度のドローコール数を維持する。
- 拡散環のレイマーチは画面占有時のみ有効化する。
- サブピクセル環はメッシュを描かず積分光度へ移行できるようにする。
- WebGPUでのフレーム時間を変更前後で計測し、環が画面を大きく占有する最悪条件も確認する。

## 完了条件

- 木星、土星E/G/Phoebe、天王星外側塵環が通常の順光条件では過剰に見えない。
- 希薄な塵環が高位相角では前方散乱によって現れる。
- 土星A/B/C環の濃度差とCassini Divisionがτデータに基づいて見える。
- 天王星の密な狭環と希薄な外環が別の濃度で描かれる。
- 海王星アークが重ね描きなしで周囲より濃くなる。
- エッジオン時の透過が観測開き角に応じて変化する。
- LOD切り替え時に環が突然濃くならない。
- マップビューと戦闘ビューで、同じ観測幾何なら同じ物理モデルの結果になる。
- 視認性強調を使う場合、それが物理環とは別レイヤー・別設定である。

## 参考文献・データ源

- NASA PDS, Optical Depth definition: <https://pds.nasa.gov/datastandards/documents/dd/all/current/ch105s160.html>
- NASA/NSSDCA, Saturnian Rings Fact Sheet: <https://nssdc.gsfc.nasa.gov/planetary/factsheet/satringfact.html>
- PDS Ring-Moon Systems Node, Vital Statistics for Saturn's Rings: <https://pds-rings.seti.org/saturn/saturn_rings_table.html>
- Cuzzi et al., *The Rings of Saturn*: <https://www.nasa.gov/wp-content/uploads/2018/03/rings-of-saturn-2018-review-chapter.pdf>
- Horányi et al. 2010, *Plasma conditions and the structure of the Jovian ring*: <https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2010JA015472>
- Braga-Ribas et al. 2014, *A ring system detected around the Centaur (10199) Chariklo*: <https://www.nature.com/articles/nature13155>
- Morgado et al. 2023, *A dense ring of the trans-Neptunian object Quaoar outside its Roche limit*: <https://www.aanda.org/articles/aa/pdf/2023/05/aa46365-23.pdf>
- Hamilton et al. 2015, *Small particles dominate Saturn's Phoebe ring to surprisingly large distances*: <https://www.nature.com/articles/nature14476>

実装時には各値の観測波長、normal/apparent optical depthの別、掩蔽と散乱測光の別を確認し、根拠を `solar-system.ts` の各bandコメントへ残す。

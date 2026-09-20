# 天体照をテクスチャ付き面光源にする — 要件と実装計画

**これは計画であって、現状の説明ではない。** 「いまどう動いているか」の正本はコード、「どう
振舞うべきか」の正本は `DEVELOP/SPEC/RENDERING.md`。ここにあるのは、これから何を作るかと、
その判断の根拠だけ。

**達成目標(1 文)**: 低軌道を飛んでいるとき、粗さの小さい金属面に、目下の天体の地表(海・陸・氷)と
昼夜の明暗が、その天体が空を占める広さのまま映ること。

由来は [`arealight_backlog.md`](arealight_backlog.md) の §1(等価円盤)と §2(テクスチャ付き
ランバート球)。**§2 の「実施しない」という判断を覆す。§1 の等価円盤は作らない** — 理由は
「不採用案」の 7。

---

## 0. 何が足りていないか

いまの天体照は、天体を **一様な放射輝度の球光源** として扱う
(`render/pipeline/lighting/planet-light-source.ts`)。球面上の輝度分布を 1 つの値
`L̄ = (2/3)·A·E_b/π` へ潰し、満ち欠けは位相関数で全体を一律に暗くする。帰結:

| 穴 | いまの絵 |
|---|---|
| 地表が映らない | 金属面に映るのは、天体の輪郭の形をした**単色の**広がりだけ |
| 昼夜が映らない | 三日月でも光は天体の中心から来て、円板全体が一様に暗くなる |
| 接触極限で暗い | 直下点へ集中している輝度を球面へ均すので、真値の 2/3(低軌道の地球で約 6 割) |

**総光量は正しい。** 足りないのは分布だけ — これが設計の出発点であり、後述の較正条件の根拠でもある。

---

## 1. 先行研究 — 何が出来ていて、何が前例の無い領域か

### 1-1. LTC のテクスチャ付き光源(採る土台)

Heitz, Dupuy, Hill, Neubelt, *Real-Time Polygonal-Light Shading with Linearly Transformed
Cosines*, ACM TOG 35(4), SIGGRAPH 2016(DOI: 10.1145/2897824.2925895,
<https://eheitzresearch.wordpress.com/415-2/>)の §5.2–5.4。

- 色つき光源の積分 `∫L(l)D(l)dl` を `I_D · I_L` へ分解する(式 12–15)。**`I_D` は既存の多角形の
  コサイン積分がそのまま担い、テクスチャは `I_L` — 色の倍率 — としてしか効かない。**
- テクスチャは複数の段へガウシアンで前もってぼかしておき、**フェッチは 1 回だけ**。選ぶ段は
  「テクスチャ平面までの距離の 2 乗 `r²` と多角形の面積 `A` の比の 1 変数関数」。
- 実測: GTX980・1280×720 で 4 辺の矩形光 1 個のシェーディングが 0.64 ms(粗さに非依存)。
  **「テクスチャフェッチを足しても性能は変わらない。ボトルネックは `I_D` 側」と明記。**
- **破綻条件(Fig.11–12)**: 等方ガウシアンは、実際には異方なフィルタの粗い近似でしかない。
  粗さが上がってフィルタが広がるほど誤差が増え、**高周波・不均質なテクスチャ(ステンドグラス柄)
  では大域的な色のバイアスが出る。** 低周波・均質なテクスチャなら平均へ収束するので誤差は小さい。

**含意**: 「変換後の広がりから段を選んで 1 フェッチ」は原論文の主提案そのもので、土台として妥当。
ただし**昼夜境界を持つ惑星面は Fig.11–12 の失敗例に近い**。この計画が「エネルギーは閉じた解と
LTC が持ち、写しは色の倍率としてしか効かない」構造を崩してはならないのは、この警告のため。

### 1-2. 球面にテクスチャを貼った先行実装は見つからなかった

- Heitz 2016 の関連研究部が「球面多角形の積分は正規化係数の評価自体が難しく、実用解は望み薄」と
  明記。Future Work で「線形変換で閉じた形(楕円体)へ拡張できるはず」と示唆するに留まる。
- Heitz & Hill, *Real-Time Line- and Disk-Light Shading with LTC*, SIGGRAPH 2017 Courses
  (<https://eheitzresearch.wordpress.com/757-2/>)が線・円盤・球へ拡張したが、**テクスチャ付きの
  扱いは無い。**
- Karis, *Real Shading in Unreal Engine 4*, SIGGRAPH 2013
  (<https://blog.selfshadow.com/publications/s2013-shading-course/karis/s2013_pbs_epic_notes_v2.pdf>)
  の球光源は representative point 法(式 11–14)で**単色・単一点**。
- Lagarde & de Rousiers, *Moving Frostbite to PBR*, SIGGRAPH 2014 の球・円盤・チューブ・矩形も
  すべて**単色**。

**→ ユーザーの問い「球面状のテクスチャライトが実現できるか、円盤などに近似する必要があるか」への
答え: 球面そのものを解く道は無い。既存の 8 角形(輪郭円盤)近似を保ち、テクスチャだけを別に持つ。**

### 1-3. Karis が却下した「ビルボード反射」— 我々が避けねばならない形

Karis 2013 は **Billboard Reflections**(Mittring & Dudash, GDC 2011)を検討して却下している。
「2D テクスチャを 3D 平面に貼り、粗さごとにプレフィルタし、反射コーンの中心線と平面の交点を
テクスチャ座標にして 1 フェッチ」— **今回やろうとしていることとほぼ同型**。却下理由は 3 つ:

1. 平面へのプレフィルタなので、**画像空間で表せる立体角に限界がある**。
2. **反射レイが平面と交差しない場合にデータが無い。**
3. 光源方向が未知(反射ベクトルで代用)なので**拡散項に使えない**。

**視半径 70° はこの 3 つに直撃する構図である。** 本計画が採る形は、この 3 つを次のように避ける:

1. テクスチャを **平面ではなく「光源の円錐そのものを覆う方向の円板」** に貼る。光源が空を
   どれだけ占めようと、写しは常にちょうどその円錐を覆う。
2. 円錐の外の方向は**縁へ clamp される**ので、データの無い方向が存在しない。
3. **拡散は閉じた解(Snyder)がエネルギーを持ち続ける。** 写しは色の倍率としてしか使わないので、
   光源方向を反射ベクトルで代用する必要が無い。

### 1-4. プレフィルタ環境マップ(split-sum)との比較

Karis 2013 の split-sum(式 7)は、キューブマップ 1 フェッチ + BRDF の 2D LUT 1 フェッチで
鏡面を出す。ただし **(a)** 拡散はこの枠組みの外で、別に SH プローブが要る。**(b)** 畳み込みが
シーンと視点に依存するので、カメラが動くたびに焼き直しが要る。Unity の公式マニュアル
(<https://docs.unity3d.com/Manual/RefProbePerformance.html>)は **reflection probe の 1 回の更新が
通常のカメラ描画の 2.5〜3 倍**と明記し、time slicing で 6 フレームへ分散するのを標準手法としている。

LTC は拡散も鏡面も**同じ機構**(多角形を `M⁻¹` で変換してコサイン積分)で扱え、本計画の写しは
**シーンを描き直さない**(正距円筒テクスチャを 1 枚読むだけの全画面 quad 1 枚)。→ **不採用案 3。**

### 1-5. 宇宙・惑星スケールの実例

- KSP の **PlanetShine** mod(<https://github.com/valerian/ksp-planetshine>)は、天体ごとに設定
  ファイルで **1 個の固定 RGB 色**を持たせ、太陽に照らされた側へ Directional Light を数本置くだけ。
  **テクスチャからのサンプリングは行っていない。**
- Hillaire, *Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite*, SIGGRAPH 2016
  course notes §5.5.1 は、雲のアンビエントに対する地表バウンス光を「非物理的」と明記した 2 つの
  ヒューリスティック(SH グラデーションの下限バイアス / 上下半球で別サンプル)で済ませている。
- Star Citizen / Elite Dangerous / NASA・ESA 可視化の技術文書は**見つからなかった。**

**→ 「惑星の見た目を per-pixel の反射に使う」は、探せた範囲の実例より一段先にある。**
だからこそ **一様球のモデルを描画設定の段として残す**(設定「天体照の光源モデル」)。

### 1-6. 遠方での縮退

- Frostbite notes §4.7.3「five times rule」: 光源までの距離が最大寸法の 5 倍(= 半径の 10 倍)を
  超えれば、点光源近似の誤差は 1% 未満(Fig.44)。視半径にして約 5.7°。
- Heitz 2016 §5.4: **段の選択が `A/r²` の連続関数なので、光源が小さくなるほど自動的に粗い段
  (= テクスチャ全体の平均 = 一様色)が選ばれる。**「均質・低周波なテクスチャなら十分広い
  フィルタは平均へ近い値を返すので、形状のミスマッチはほぼ問題にならない」と明記。

**→ ユーザーの問い「LOD 的に単色光源へ縮退させる必要があるか」への答え: 絵のうえでは不要。**
詳細は §5。

---

## 2. 設計

### 2-1. 光源テクスチャ(以下「写し」)の定義

**その天体の見た目そのものを、基準点から見た方向の円板へ 1 枚に焼く。**

- **投影**: 既存の `OrthographicCap`(`render/cloud/field-projection.ts`)を、天体表面の方向では
  なく**基準点から見た方向**の球面に置く。中心方向 `A = normalize(天体中心 − 基準点)`、
  角半径 `σ = asin(R/d)`。
  **→ 遠方から天体を見た画面そのものの写像なので、texel と反射像の画素の比が円板の全域でほぼ
  一定になる。** 天体表面側に置く取り方(中心の角半径 `π/2 − σ`)は、低軌道で中心付近を
  3.5 倍粗く持つことになるので採らない。
- **基準点**: 露出と光源選定がいま使っているのと同じ**注視点**
  (`celestial-illumination.ts` の `camera.viewpoint.lookTarget`)。
- **大きさ**: 1 辺 `PLANET_LIGHT_IMAGE_SIZE = 256` texel、`RGBA16F`、ミップ 9 段。
  中心の 1 texel が張る角は `2·sinσ / 256` — 低軌道(σ = 70°)で **0.42°**(7.3e-3 rad)。
  **これが質の上限を決める**: GGX のローブ幅 `2α` がこれを下回る面(**粗さ 0.06 未満**)では、
  反射像の精細さは写しの解像度で頭打ちになる。目視で足りなければ定数を上げる
  (512 にすると 2.7 MB/スロット)。
- **焼く中身**: uv → 方向 `ω`(基準点から)→ 球との交点 → 天体固定方向 `n` に対し

  ```
  L(ω) = albedo(n) · E_b · max(0, dot(n, s)) / π
  ```

  `s` は天体中心から恒星への単位方向、`E_b` はその天体の場所の太陽放射照度に**食の係数
  `sunlitFactor` を掛けたもの**(いま `planet-light-select.ts` が掛けているのと同じ値)。
  `albedo(n)` は正距円筒テクスチャ `× albedoScale`、テクスチャを持たない天体は
  `lightSourceAlbedo` の一様色。球と交わらない uv(円板の外、四隅)は 0。

**この 1 枚に、地表・昼夜境界・満ち欠け・食がすべて入る。** 昼夜だけを別の写しへ焼く理由は無い
(不採用案 5)。

**テクスチャが届くまでは `map` を `null` として渡す。** `DeferredTexture` は画像が届くまで 0 を
返すので、届いていないテクスチャを読むと**天体が真っ黒な光源になり、数フレームだけ天体照が消える。**
届くまでは `lightSourceAlbedo` の一様色で焼く — そのときの絵は現行の一様球と一致する(§2-2)。

### 2-2. 較正条件 — なぜこれが今のモデルと地続きなのか

**遠方・満相では、写しの平均が現行の `L̄ = (2/3)·A·E_b/π` にちょうど一致する。**

正射影の円板座標 `r`(0..1)では満相の入射余弦が `√(1−r²)` になるので、円板上の平均は
`∫₀¹ √(1−r²)·2r dr = 2/3`。**現行の `LAMBERT_SPHERE_GEOMETRIC_ALBEDO_RATIO = 2/3` は、写しを
焼けば積分から自然に出てくる。** よって:

- `planetRadiance()` の 2/3 も `receiverPhase()` / `sunlitCapFraction()` も、テクスチャ経路では
  **要らなくなる**(位相は写しの中にある)。一様球経路のためだけに残る。
- 接触極限では写しの平均が `A·E_b/π` へ近づく。**§0 の「真値の 2/3」がこれで消える。**
- **検証にそのまま使える**: 遠方(視半径 1° 未満)の構図で 2 つのモデルの画素値が一致しなければ、
  正規化が間違っている。

### 2-3. 受け手ごとの読み方

**エネルギーはいまの式のまま。写しは色の倍率としてしか効かない**(§1-1 の警告と §1-3 の
却下理由 3 への答え)。

```
diffuse  = image.radianceAt(dDiffuse, ψ_d) · π · sin²σ · sphereIrradianceFactor(cosβ, sin²σ)
specular = image.radianceAt(dSpec,    ψ_s) · sphereSpecular.factor(sample, center, radius)
```

**方向** — どちらも「ローブの峰を光源の円錐へ収めた向き」:

- 拡散 `dDiffuse` = 法線 `N` を、軸 `A`・半角 `σ` の円錐へ収めた向き。
- 鏡面 `dSpec` = 反射ベクトル `R = 2N(N·V) − V` を同じ円錐へ収めた向き。
  Karis 2013 式 11 の representative point を、球ではなく円錐へ当てたもの。

  ```
  // v を軸 axis・半角 σ の円錐へ収める。中なら v、外なら縁で v に最も近い向き。
  cosVA  = dot(v, axis)
  perp   = v − axis·cosVA
  edge   = axis·cosσ + normalize(perp)·sinσ     // perp ≈ 0 のときは v(= ±axis)
  return cosVA ≥ cosσ ? v : edge
  ```

  `σ → 0` で `A` へ、`σ → π/2` で `v` そのものへ連続に落ちる。**分岐点で絵が飛ばない。**

  **円錐へ収めるところまでは view 空間で行い、写しを引く直前に
  `sample.worldDirectionOf()` で描画座標へ戻す** — 写しの枠(中心・東・北)は描画座標で置くため。

**段(ミップ)** — フィルタの角幅 `ψ` を写しの texel が張る角と比べる:

```
texelAngle = 2·sinσ / PLANET_LIGHT_IMAGE_SIZE
lod        = clamp(log2(ψ / texelAngle), 0, 8)
ψ_d        = 1.05 rad            // クランプドコサインの等価円錐の半角(立体角 π)
ψ_s        = min(2·α, σ)         // α = roughness²。GGX のローブ半幅の標準的な近似
```

両端が正しいことが保証される: `ψ ≤ texelAngle` なら最も細かい段(鏡面)、`ψ ≥ 2 sinσ` なら
1×1 段 = 写しの平均 = **現行の一様球そのもの**。

### 2-4. 縮退(ユーザーの問い 4 への答え)

**絵のうえで LOD 分岐は要らない。** `texelAngle ∝ sinσ` なので、天体が遠ざかると `lod` が単調に
上がり、遠方で 1×1 段 = 写しの平均 = 一様球へ厳密に落ちる。Heitz 2016 §5.4 の設計そのままで、
**「距離とともに連続に縮退する 1 つのモデル」という
[`arealight_backlog.md`](arealight_backlog.md) §1 の要件を満たす。**
分岐を置けば、その境目で絵が飛ぶ危険を自分で作ることになる。

**負荷のうえでは、画素あたり 2 フェッチが遠方でも残る。** 視半径が小さいスロットで
uniform 条件の分岐を入れて読みを飛ばす余地はある(Frostbite の 5 倍則 = 視半径 5.7° が数値的な
根拠になる)。**入れるかどうかは段 6 の実測で決める** — 動く量が 0.1 ms 未満なら入れない。
焼く側はスロットあたり 0.03 ms 見込みなので、飛ばす価値は無い。

### 2-5. 新しい API

```ts
// render/pipeline/lighting/planet-light-image.ts(新規)
// 天体 1 体を光源として焼くのに要る見た目。すべて描画座標系の値。
// **型をここに置く** — 写しを持つ側が定義し、スロット(planet-light-source.ts)が読む。逆向きに
// 置くと、スロットが写しを所有しているのと import が食い違って循環する。
export interface PlanetLightAppearance {
  // 全球の正距円筒テクスチャ。持たない天体と、画像がまだ届いていない天体は null。
  readonly map: THREE.Texture | null;
  // map の色へ掛けて、平均をボンドアルベドへ合わせる倍率。map が null なら読まない。
  readonly albedoScale: number;
  // map を持たない天体の一様な拡散アルベド(線形 RGB)。
  readonly albedo: Albedo;
  // その天体の場所の太陽放射照度に、天体の食(sunlitFactor)を掛けたもの。
  readonly sunIrradiance: number;
  // 天体中心から恒星への単位方向。
  readonly starDirection: THREE.Vector3;
  // 描画座標のベクトルを天体固定の向きへ回す行列(writeBodyFromWorld が書くもの)。
  readonly bodyFromWorld: THREE.Matrix4;
}

// 天体 1 体の見た目を、基準点から見た方向の円板へ焼いて持つ写し 1 枚。
export class PlanetLightImage {
  public constructor();
  // このフレームに焼く内容を置く。reference / center は描画座標、radius は [m]。
  public set(
    reference: THREE.Vector3, center: THREE.Vector3, radius: number,
    appearance: PlanetLightAppearance,
  ): void;
  // 置いた内容を写しへ描く。ライティングパスより前に毎フレーム呼ぶ。
  public render(renderer: WebGPURenderer, gpu?: GpuTimingSink): void;
  // 写しのテクスチャ。デバッグ表示が読む。所有権はこのクラスに残す。
  public get texture(): THREE.Texture;
  // 描画座標の向き direction を、角幅 filterAngle [rad] のフィルタで読んだ放射輝度。
  public radianceAt(direction: Vec3Node, filterAngle: FloatNode): Vec3Node;
  public dispose(): void;
}

// render/pipeline/lighting/planet-light-source.ts(改修)
export interface PlanetLightValue {
  readonly center: THREE.Vector3;
  readonly radius: number;
  // 一様球経路の放射輝度。テクスチャ経路では読まない。
  readonly radiance: Albedo;
  // テクスチャ経路で焼く見た目。null なら、設定によらず一様球で描く。
  readonly appearance: PlanetLightAppearance | null;
}

export class PlanetLightSource {
  // 各スロットの写しを焼く。ライティングパスより前に毎フレーム呼ぶ。
  public bake(renderer: WebGPURenderer, gpu?: GpuTimingSink): void;
}

// render/pipeline/lighting/shading-sample.ts(改修)
export class ShadingSample {
  // view 空間の向きを描画座標の向きへ戻す。写しは描画座標の方向で引くので、光源はこれを通す。
  public worldDirectionOf(viewDirection: Vec3Node): Vec3Node;
}

// render/celestial/celestial-surface.ts(改修)
export interface SurfacePhotometry {
  readonly bondAlbedo: number;
  readonly lightSourceAlbedo: Albedo;
  // 全球の正距円筒テクスチャと、その倍率。テクスチャを持たない天体は null。
  readonly lightSourceMap: { readonly texture: THREE.Texture; readonly albedoScale: number } | null;
}

// render/baked-field.ts(cloud/ から移動、引数を 2 つ足す)
export class BakedField {
  public constructor(
    name: string, format: THREE.PixelFormat, projection: FieldProjection,
    source: (direction: Vec3Node) => Vec4Node,
    options?: { readonly pass?: GpuPass; readonly mipmaps?: boolean },
  );
  // 段を選んで読む。mipmaps を立てていないときは 0 段しか無い。
  public atLevel(direction: Vec3Node, level: FloatNode): Vec4Node;
}
```

### 2-6. 置き場と import の向き

| ファイル | 層 | 何をするか |
|---|---|---|
| `src/render/field-projection.ts` | 装置 | `cloud/` から移動。雲だけのものではなくなる |
| `src/render/baked-field.ts` | 装置 | `cloud/` から移動。ミップと GPU パス名を引数化 |
| `src/render/pipeline/lighting/planet-light-image.ts` | 装置 | 新規。写し 1 枚と、天体側と共有する型 |
| `src/render/pipeline/lighting/planet-light-source.ts` | 装置 | スロットが写しを 1 枚ずつ持つ |
| `src/render/pipeline/lighting/shading-sample.ts` | 装置 | `worldDirectionOf()` を足す |
| `src/render/celestial/celestial-surface.ts` / `earth-surface.ts` | 装置 | `lightSourceMap` を公開する |
| `src/render/celestial/celestial-illumination.ts` | 装置 | `appearance` を組んで渡す |
| `src/render/pipeline/render-pipeline.ts` | 装置 | ライティングパスの前に写しを焼く |
| `src/render/pipeline/debug-target.ts` | 装置 | 写しを全画面に出す行を足す |
| `src/render/graphics-settings.ts` | 装置 | `planetLightModel` を足す |
| `tools/render-lab/cases.ts` / `lab.ts` | — | 評価用ケース |

**import の向きは変わらない。** `celestial/ → lighting/` のまま(いまも
`celestial-illumination.ts → planet-light-select.ts`)。`lighting/` は `celestial/` を読まない —
テクスチャは `PlanetLightAppearance` という平たいデータとして渡ってくる。
すべて `src/render/` の中なので層(装置)も変わらず、`npm run check:boundaries` の対応表は無改修。

---

## 3. 手順

各段の終わりで `npm run typecheck`(ヒープ拡大が要る)と、触った層の回帰テストを通して commit する。

### 段 0. 仕様を先に更新する

**目的**: `DEVELOP/SPEC/RENDERING.md` の天体照の記述を「どう見えるべきか」として先に確定させる。

**変更箇所**: `DEVELOP/SPEC/RENDERING.md`

- 「地球の描画」節 — 「天体照も太陽と同じく視半径を持つ球光源として届く」を、**「天体照はその天体の
  見た目そのものを持つ面光源として届く。粗さの小さい面には、その天体の地表と昼夜の明暗が、その
  天体が空を占める広さのまま映る」**へ。満ち欠けの段落は「位相関数で暗くなる」ではなく
  「照らされている部分だけが明るい面光源として映る」へ。**「孤立した輝点が噴くことはない」は保つ。**
- 「描画品質設定」節 — 「天体照の光源モデル」を足す。
- 「デバッグ表示」節 — 候補を 15 → 16 種にし、「天体照の光源テクスチャ」を足す。
- 「未確定の案」— 「天体照の光源テクスチャに雲を載せる」を足す。

**書かないこと**: 解像度・ミップ・LTC・投影法。**仕様に実装は書かない。**

**達成条件**: `src/` を 1 行も触らず、`docs(spec):` の単独 commit になっている。

### 段 1. 評価用シーンを先に足し、現行の基準を撮る

**目的**: 実装前後を比べられる構図を用意する。**実装前に撮ることが要点** — あとから作ると
「良くなった」を確かめる相手がいない。

**変更箇所**: `tools/render-lab/cases.ts`、`tools/render-lab/lab.ts`、`tools/render-lab-shot.mjs`

- `leo-metal` — 実写テクスチャの地球(`earthAt()`)を背景に大きく写し、手前に
  `roughness 0.05 / metalness 1` の球(`metal-highlight` と同じ材質)を置く。カメラは地球が画面の
  半分以上を占める向き。`planetLights` にその地球を置く。**目標そのものの構図。**
- `leo-metal-terminator` — 同じ構図で、昼夜境界が円板を横切る位相。
- `crescent-150` — 既存 `crescent`(位相角 120°)に対して位相角 150°。
- `planetshine-far` — 同じ地球を視半径 0.95°(月軌道相当)に置いた、**較正用の**構図。
- `LabCase` に `ready?: () => boolean` を足し、`shoot()` がケースのテクスチャ到着を待つ
  (上限 10 秒)。**いまは待たないので、実写テクスチャのケースは shot で単色に写る** — これを
  直さないと段 4 以降を画像で評価できない。既存の `earth` 系ケースにも同じ効き方をする。

**達成条件**: `npm run render-lab:shot` の `leo-metal` に、地球がテクスチャ付きで写り、手前の
金属球に**単色の**広がりが映っている(= 現行の一様球の絵)。

**検証**: `npm run render-lab:shot`、目視は `npm run render-lab`。

**落とし穴**: shot は全ケースを撮り、`memos/mikanixonable/protein-motion-baseline.json` を
書き換える。差分が識別子だけのファイルは戻す。半影を持つケースは撮り直しで ±4 LSB 揺れる。

### 段 2. `BakedField` / `FieldProjection` を `render/` 直下へ移す

**目的**: 「単位方向の関数を投影の写しへ焼いて、単位方向で読み直す」という既存の器を、雲以外からも
使えるようにする。**同じものを 2 つ書かないため**であって、一般化のためではない。

**変更箇所**: `src/render/cloud/{baked-field,field-projection}.ts` → `src/render/` 直下へ移動。
`BakedField` に 2 つだけ足す:

- `options.pass?: GpuPass` — いま `GPU_PASS.cloudBake` の直書き。天体照の写しは
  `GPU_PASS.lighting` へ計上する(負荷確認ウィンドウの行を増やさない)。
- `options.mipmaps?: boolean` — 立てると `texture.generateMipmaps = true` と
  `minFilter = LinearMipmapLinearFilter` を置き、`atLevel(direction, level)` で段を選べる。
  three の WebGPU backend は render pass の終わりに自動でミップを作る
  (`WebGPUBackend.js:1291` の `textureUtils.generateMipmaps`)。

**達成条件**: 雲の絵が 1 texel も変わらない。`npm run check:boundaries` が通る。

**検証**: `npm run typecheck`、`npm run test:render`、`npm run render-lab:shot` の `earth*` ケースが
移動前と一致する。

### 段 3. 天体の表面テクスチャを光源側へ渡す

**目的**: 写しを焼くのに要るもの(正距円筒テクスチャ・倍率・自転姿勢・恒星の向き・食込みの
放射照度)を、天体側から光源側まで通す。**この段ではまだ誰も使わない。**

**変更箇所**:

- `celestial-surface.ts` / `earth-surface.ts` の `SurfacePhotometry` に `lightSourceMap` を足す。
  地球は `earth-surface-material-binding.ts` が作っている `baseColor` の `DeferredTexture` と
  `colorCalibration.diffuseAlbedoScale`、それ以外は `CelestialSurface.textured()` の `map` と
  `CelestialTexture.albedoScale`。`solid()` は `null`。
- `celestial-illumination.ts` の `syncPlanetLights()` が `PlanetLightAppearance` を組む。
  `bodyFromWorld` は既存の `writeBodyFromWorld()`、`sunIrradiance` は `planet-light-select.ts` が
  いま内部で持っている値(`irradianceAtDistance × sunlitFactor`)を `PlanetLight` へ載せて返す。
- `tools/render-lab/lab.ts` がケースの `planetLights` から同じ形を組む。ケース側は
  `surface?: { map, albedoScale }` を任意で持つ。

**達成条件**: 絵が 1 texel も変わらない。`PlanetLightAppearance` が毎フレーム組まれている。

**検証**: `npm run typecheck`、`npm run test:render`、`render-lab:shot` の全ケースが段 1 と一致。

**落とし穴**: `selectPlanetLights()` の戻り値に `sunIrradiance` を足すと `radiance` と重複する
(`radiance` は `albedo × sunIrradiance` の積)。**`radiance` を残すのは一様球経路のためだけ**で、
テクスチャ経路は読まない — どちらが正本かをコメントで明示する。

### 段 4. 写しを焼き、デバッグ表示で見る

**目的**: §2-1 の写しを毎フレーム焼き、**目で見て正しいことを確かめる。** まだ照明には使わない。

**変更箇所**: `planet-light-image.ts`(新規)、`planet-light-source.ts`(スロットが 1 枚ずつ持つ)、
`render-pipeline.ts`(`lightPrepass.render()` の直前で `planetLight.bake(renderer, gpu)`)、
`debug-target.ts`(1 行足す)。

- 写しは**スロットごとに 1 枚**。天体が入れ替わったら `TextureNode.value` を差し替える
  (three の `TextureNode` は `value` の setter を持つ:`TextureNode.js:186`)。
  **差し替えが効かないことが分かったら、テクスチャごとに 1 枚を遅延生成する持ち方へ倒す** —
  そのときは写しの数が「同時に光源になりうる天体の数」になる。
- 焼く式は §2-1。テクスチャの無い天体は 1×1 の白を束ねて一様色として焼く。

**達成条件**:

- デバッグ表示「天体照の光源テクスチャ」に、**そのフレームの地球がそのまま見える**
  — 地表の海陸、昼夜の境界、円板の外の黒。
- **較正**: `planetshine-far` で写しの平均(= 1×1 段)が、現行の `planetRadiance()` の
  `(2/3)·A·E_b/π` と **相対誤差 1% 以内**で一致する(§2-2)。一致しなければ正規化か投影が
  間違っている。一度だけ CDP から読んで確かめ、数値は報告に書く(コードへ残さない)。
- 負荷確認ウィンドウの「ライティング」の数字が、スロット 2 本で **+0.1 ms 以内**(見積り 0.06 ms)。

**検証**: `npm run render-lab` で目視、`npm run typecheck`、`npm run test:render`。

### 段 5. 写しを読む

**目的**: §2-3 の形で拡散・鏡面へ写しを掛け、描画設定の段を足す。**ここで絵が変わる。**

**変更箇所**: `planet-light-source.ts`、`shading-sample.ts`(`worldDirectionOf`)、
`graphics-settings.ts`、`render-pipeline.ts`(`rebuildForGraphics()`)。

```ts
planetLightModel: {
  kind: 'choice', group: 'light', label: '天体照の光源モデル',
  items: [[0, '一様球'], [1, 'テクスチャ']],
  presets: { low: 0, medium: 0, high: 1 },   // medium は段 6 の実測で決め直す
},
```

モードごとにマテリアル 1 枚を遅延生成する(`sun-source.ts` の `sunLightModel` と同じ形)。

**達成条件**:

- `leo-metal` の金属球に、**地球の地表が映る**。背景の地球と見比べて、映り込みの海陸の配置が
  合っている。
- `leo-metal-terminator` で、映り込みの中に昼夜境界が見える。
- `crescent-150` で、明るい面が天体の中心方向ではなく**三日月の側**へ寄る。
- `planetshine-far` で **2 つのモードの絵が画素値 ±2 LSB 以内で一致する**(§2-2 の較正が
  per-pixel でも成り立つ)。一致しなければ段の選択(`lod`)か方向の収め方が間違っている。
  **このケースは半影を持たないので、撮り直しの揺れは 0 のはず** — 揺れるならそれ自体が異常。
- **輝点が噴かない** — 球の輪郭・雲頂のように視線へ倒れた面で、周囲より桁違いに明るい画素が
  出ない(SPEC の保存すべき挙動)。

**検証**: `npm run render-lab`(目視)、`npm run render-lab:shot`、`npm run typecheck`、
`npm run test:render`、`npm run test:settings`。

**落とし穴**: §1-1 の警告 — **写しの値でエネルギーを作らないこと。** `sphereIrradianceFactor` と
`sphereSpecular.factor()` が大きさを持ち、写しは色の倍率である、という分業を崩すと、
高周波テクスチャで総光量が破れる。

### 段 6. 負荷を測り、LOD を判断し、実機で確かめる

**目的**: 見積り(§4)を実測へ置き換え、分岐を入れるかどうかを数字で決める。

**やること**:

- `render-lab` の `measure()` で「ライティング」行を、`planetLightModel` 一様球 / テクスチャ ×
  `planetLightCount` 0/1/2 の 6 通りで読む。**同じ組でも巡ごとに ±20% 動くので中央値で読み、
  2 つのビルドを別ディレクトリへ並べて 1 セッション内で交互に巡る**(熱ドリフトが差を飲む)。
- 実機(`npm run dev`)で、低軌道と月軌道の構図で同じ行を読む。
- **LOD 分岐の判断**: 視半径が 5.7°(Frostbite の 5 倍則)を切るスロットで写しの読みを uniform
  条件で飛ばしたとき、月軌道の構図で「ライティング」が **0.1 ms 以上**下がるなら入れる。
  下がらないなら入れない — §2-4 のとおり絵のうえでの理由は無い。
- `planetLightModel` の medium プリセットを、実測が **+0.3 ms 以内**なら 1 へ、超えるなら 0 のままに。
- `pipeline.md` §3「負荷の現況」と §4 の穴の表を書き戻す。

**達成条件**: 見積りと実測の差が報告に書かれ、`planetLightModel` のプリセットが数字で決まっている。

### 段 7(後段). 雲を写しへ重ねる

**目的**: 地球の反射で最も目立つ要素を入れる。**段 6 までを終えて、実際に足りないと分かってから。**

- 雲場は既に `CLOUD_CAP_SIZE = 512` の cap テクスチャとして GPU 上にある
  (`cloud/cloud-presentation.ts`)。写しを焼くときに被覆率で地表色と雲の色を混ぜる。
- **cap はカメラから見える範囲しか焼かれていない。その外は雲が無いものとして扱う** — 写しの
  基準点は cap の中心と同じ注視点なので、写しが覆う円錐は cap の内側にほぼ収まる。はみ出す縁は
  雲の無い地表として写る。**それが見える大きさの鏡は存在しない。**
- `lighting/` が `cloud/` に依存し始める段なので、依存の向きを段 6 までの結論と照らして決める。

---

## 4. 見積り

**すべて見積りであって実測ではない。** 段 6 で読み直す。

| 何 | 見積り | 根拠 |
|---|---|---|
| 写しを焼く(スロット 1 本) | +0.03 ms | 256² = 65536 texel。1080p 全画面 quad の 1/32。ライティングの全画面 1 枚が 0.3 ms 見込み |
| ミップ生成(9 段) | +0.01 ms | 元の 1/3 の texel |
| 写しを読む(スロット 1 本、1080p) | +0.05〜0.15 ms | 画素あたり 2 フェッチ。512 KB のテクスチャで L2 に収まる。Heitz 2016 は「フェッチを足しても性能は変わらない」 |
| **最も重い設定(スロット 2 本)** | **+0.4 ms** | 上の合計。現行のライティング見積り 1.1 ms に対して +36% |
| メモリ | +1.4 MB | 256²×RGBA16F×(1 + 1/3)×2 スロット |

**作業量**: 段 0〜2 が各半日、段 3〜5 が各 1 日、段 6 が半日。**段 4 と段 5 の較正で詰まる可能性が
最も高い** — 一致しなければ投影・正規化・段の選択のどれが原因かを切り分けることになる。

---

## 5. 不採用案

1. **球そのものを LTC で積分する(テクスチャ付き)** — Heitz 2016 が「正規化係数の評価自体が
   難しく実用解は望み薄」と明記し、2017 の球・円盤拡張もテクスチャを扱わない。既存の 8 角形
   (輪郭円盤)近似を保つ。
2. **ビルボード反射(平面テクスチャ + 反射コーン交差)** — Karis 2013 が却下。却下理由の
   「平面が表せる立体角の限界」と「平面と交わらないレイにデータが無い」が視半径 70° で直撃する。
   本計画は平面ではなく**光源の円錐そのものを覆う方向の円板**に貼ることでこれを避ける(§1-3)。
3. **ローカル環境マップ + split-sum** — 視点・シーン依存の畳み込みが要り(Unity の reflection
   probe 更新で通常描画の 2.5〜3 倍)、拡散項に別の SH を持つことになる。LTC は拡散・鏡面を同じ
   機構で扱え、本計画の写しは**シーンを描き直さない。**
4. **球面調和(SH)で拡散を持つ** — 低次 SH は小さく明るい光源を全天へ塗り広げるので、遠方で
   点光源へ縮退しない。「距離とともに連続に縮退する 1 つのモデル」という要件を満たさない。
5. **昼夜を別の写しへ焼く** — 分ける理由が無い。地表色・昼夜・満ち欠け・食は同じ 1 枚の
   放射輝度として焼け、分けると読みが 2 枚になる。
6. **地球の詳細タイル(z5〜z7)を写しへ使う** — 全球の正距円筒(`baseColorUrl`)だけを読む。
   写しの 1 texel は低軌道で 0.42° なので、z4 相当より細かい入力を入れても段で潰れる。
   タイルのページ表を光源側から辿る依存も避けられる。
7. **等価円盤の LTC(`arealight_backlog.md` §1)** — 作らない。光の来る向きの偏りは、写しを
   受け手ごとに絞り込んで読むこと(§2-3)から出るので、**同じ効果のために近似をもう 1 つ持つ
   理由が無い。** `lambert-phase-table.ts` も作らない。位相と重心の数値積分は、写しを焼けば
   積分そのものから出る(§2-2)。
8. **天体ごとに写しを持つ** — スロットごとに 1 枚とし、天体が入れ替わったらテクスチャノードの
   `value` を差し替える。差し替えが効かないと分かった場合のみ、テクスチャごとの持ち方へ倒す
   (段 4)。

---

## 6. 落とし穴

- **写しの値でエネルギーを作らないこと。** Heitz 2016 Fig.11–12 の警告 — 等方ガウシアンの
  プレフィルタは実際の異方なフィルタの粗い近似で、高周波・不均質なテクスチャで粗さが上がるほど
  **色のバイアス**が出る。昼夜境界を持つ惑星面はまさにその種類。エネルギーを閉じた解と LTC 側に
  置いておけば、バイアスは色に限られ、輝点や総光量の破れにはならない。
- **8 角形の頂点は受け手から見て反時計回り**(既存の警告)。逆に巻くと拡散は正常なまま鏡面だけが
  静かに消える。
- **`renderer.setMRT` を使わない** — MRT 側のブレンド既定が NoBlending になり、加算が効かない。
- **`minFilter` を `LinearMipmapLinearFilter` にしないと、段を選んでも効かない。**
- **半精度(`HalfFloatType`)をフィルタできない環境では黙って最近傍に落ちる**(既存コメント)。
  写しが階段状に見えたら、まずこれを疑う。
- **`render-lab:shot` はテクスチャの到着を待たない** — 段 1 で待つようにしないと、写しが黒いまま
  撮れる。撮影は全ケースを回し、`memos/mikanixonable/protein-motion-baseline.json` を書き換える。
- **半影を持つケースは撮り直しで ±4 LSB 揺れる。** 差分を根拠にする前に撮り直す。
- **`npm run typecheck` は OOM する** — ヒープ拡大が要る。
- **基準点は注視点**なので、注視点から遠い受け手ほど写しの視差誤差が乗る。低軌道で受け手が
  注視点から 10 km 離れると 0.025 rad ≈ 写しの 3 texel ぶんずれる。**艦の寸法(〜100 m)では
  1/30 texel で無視できる。**

---

## 7. 未確定の案

**決定事項ではない。**

- **拡散の向きの偏りが足りない場合の代案** — 写しの 1 次モーメント(放射輝度で重み付けした
  重心方向と総束)をミップ列から読み、そこへ置いた円盤として拡散を評価する。`arealight_backlog.md`
  §1 の等価円盤を、表ではなく**実測した重心**で行うもの。`crescent-150` の拡散が弱すぎたら検討する。
- **段の選択を Heitz §5.4 の形へ** — いまの案はローブの角幅を写しの texel 角と比べるだけで、
  視線が寝たときの異方を見ていない。掠める角で反射像が滲むなら、変換後の立体角(`A/r²`)から
  選ぶ形へ差し替える。
- **写しの解像度** — 256 で始める。粗さ 0.06 未満の面で反射像の解像度が頭打ちになるのが目に
  付いたら 512 へ(メモリは 2 スロットで 1.4 MB → 5.5 MB)。
- **天体照の遮蔽** — この計画では扱わない([`screenspace.md`](screenspace.md))。
- **環・大気の夜側** — 天体照が lit-opaque チャンネルにしか届かない件は変わらない
  ([`arealight_backlog.md`](arealight_backlog.md) §4)。
- **露出の順応が天体照を見ない**件も変わらない([`exposure_backlog.md`](exposure_backlog.md))。

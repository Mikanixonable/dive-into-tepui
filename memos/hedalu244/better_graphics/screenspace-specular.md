# 局所反射 — 滑らかな面に近くの物体を映す（計画）

**計画ファイル。** `/run-plan` で上から実施し、完了した手順はこの文書から消す。着手時点の構成は
`screenspace-base`（`3e646383`、拡散の近傍光輸送は main へ未マージ）で監査した（「着手時点の構成」）。
この計画は、拡散側がどう差し替わっても衝突しない境界（「拡散側との境界」）だけを前提にする。

---

## 目的

滑らかな面へ、反射方向にある近くの物体の像を映す。`DEVELOP/SPEC/RENDERING.md` は次の振舞いを
定めており、この計画はそれを実現する。仕様の追記は要らない。

- **滑らかな面には、反射方向にある近くの物体が映る。** 映った物体は、その向こうにあった天体照と
  環境光の像を置き換える。粗い面ほど像はぼけ、十分に粗い面では近くの物体の像は見えない。
- この映り込みは、近傍構造による拡散光の遮蔽とは別に決まる。**拡散光の遮蔽量をこの像の代わりに
  使わない。** 近傍の拡散光パスは拡散反射光だけに関わり、鏡面反射光を遮らない。
- 太陽の直射光は映り込みで遮り直さない — 太陽の遮り方は影パスが担う。映り込みが置き換えるのは
  天体照と環境光の鏡面像である。
- 描画パイプラインでは、映り込みパスがマテリアルパスの後・大気パスの前に来る。
- 描画設定「近くの物体の映り込み」はオン / オフ。オフでは滑らかな面に近くの物体が映らず、天体照と
  環境光の鏡面反射は残る。遮蔽と照り返しの設定とは独立して選べる。
- デバッグ表示は、通常のフレームで作られた中間バッファを生成順に直接選べ、表示のために別の計算を
  しない。描画設定で切られている段を選ぶと、何も作っていないことが黒として見える。GPU の計測は
  各描画段を実行順に個別の行として示す。

時間方向の蓄積（前フレームの履歴）は使わない。

---

## 決めたこと

覆すときは、各項目の括弧内の手順が変わる。

### 判定と合成の契約

- **局所反射の判定は幾何だけを見る。** 追跡は深度（と G バッファの法線・粗さ）だけを走査し、
  当たり位置・距離・置換重み `w` を決める。この段では遠方光（太陽・天体照・環境光）も、マテリアル
  パスの出力も、拡散側のどの target も読まない（手順2）。
- **鏡面の遮りを拡散の遮蔽から作らない。** 近傍拡散補正の遮蔽から、GTSO 風の一つのローブの鏡面
  可視率（`specularVisibility`）を作らない。粗さ・視線・反射ベクトルを必要とする鏡面の遮りは、拡散の
  遮蔽の副産物ではない。局所反射自身が「近傍へ当たった像」と「その向こうの遠方鏡面光を置き換える
  重み」を所有する（手順2・3）。
- **置換重み**: `w = roughness fade × edge fade × distance fade × hit confidence`。追跡が1回だけ作り、
  遠方鏡面の弱めと像の加算に1回ずつ使う（手順2・3）。
- **遠方鏡面との合成は、`w = 1` で遠方鏡面がそっくり像へ入れ替わる形にする。** 照度バッファの鏡面を
  太陽の分 `S_sun` と天体照・環境光の分 `S_far` に分けて書くと、画素の鏡面反射光は

  ```
  R × (S_sun + (1 − w) × S_far)  +  R × w × I
  ```

  とする。`R` はマテリアルパスが照度バッファの鏡面へ掛ける鏡面反射率（着手時点では
  `mix(0.04, baseColor, metalness)`）、`I` は当たった点の像（放射輝度）。**像に掛ける係数と遠方鏡面に
  掛ける係数を別々に書かない。** `R` は1つの関数に切り出し、マテリアルパスと像の解決の両方がそれを
  呼ぶ — マテリアルパス側の係数がフレネル項などで変わっても、像の側が自動で同じになる。miss では
  `w = 0` で遠方鏡面を変えない（手順2・3）。
- **放射輝度**: `I` は今のフレームのマテリアルパス出力の縮小列から読む。前フレームの履歴は使わない
  （手順3）。
- **パス位置**: 追跡は遠方鏡面を弱めるのでライトプリパス（光源ごとの照度を積む段）より前。像の解決は
  マテリアルパス後・大気パス前（手順2・3）。

### 拡散側との境界

拡散の近傍光輸送はマテリアルパスより前で完結し、マテリアルパスは局所拡散光を足す形に差し替わる。
どう差し替わっても衝突しないよう、局所反射の触れる範囲を次に限る（手順2・3）。

- **弱めるのは鏡面反射だけ。** `1 − w` を掛けるのは、天体照と環境光の光源が照度バッファの鏡面へ書く
  寄与だけ。拡散の寄与、照度バッファの拡散、近傍拡散補正、局所拡散光には一切触れない。太陽の鏡面も
  弱めない。
- **マテリアルパスへの変更は鏡面反射率 `R` の切り出しだけ。** 弱めはマテリアルパスの中ではなく光源の
  鏡面寄与で行うので、マテリアルパスの拡散の項・合成の式・パス順には手を入れない。マテリアルパスが
  `R` を呼んでいれば、ほかの中身が何に差し替わっても局所反射は成り立つ。
- **像の解決が読むのはマテリアルパスの出力だけ。** 出力に何が含まれているか（局所拡散光の有無を
  含めて）は問わない。拡散側の中間 target（照度補正・照り返しの源・その縮小や均し）は読まない。
  それ以外に読むのは追跡の target と G バッファ（`R` のため）だけ。
- **拡散側のファイル・target・GPU 行を共有しない。** 追跡は `screen-space-pass.ts` に足さず、独立した
  パスとして `render-pipeline.ts` から呼ぶ。半解像度の深度も拡散側の target を借りず、追跡パスが自前で
  G バッファの深度から縮小する。

### 追跡と像

- **追跡**: 鏡の向きに1本、半解像度の view depth 上を画面空間で透視補正した刻みで進める
  （McGuire & Mara 2014）。開始点を blue noise でずらし、画面外・空・カメラへ向かう ray は miss。
  画面の縁と最大距離の手前で confidence を0へフェードする（手順2）。
- **ぼかし**: 当たった点の色は、マテリアルパス出力の縮小列から読む。LOD は鏡面ローブが当たり距離で
  張る円の半径から選ぶ（Uludag 2014）（手順3）。
- **粗さの上限**: 知覚的粗さ0.3まで全量、0.6で0。それより粗い面では局所反射を足さず、遠方鏡面
  （天体照・環境光の鏡面）をそのまま残す（手順2・3）。

### 描画設定とデバッグ表示

- **描画設定は2項目。** どちらも設定表（`src/render/graphics-settings.ts`）へ足し、ゲームの描画設定
  パネルと render-lab の両方に `GraphicsPanel` 経由で出す（手順2・4）。
  - `screenSpaceSpecular`「近くの物体の映り込み」: オン / オフ。プリセット低 / 中 / 高 = オフ / オフ / オン。
    オフでは追跡・縮小列・像の解決を一切 dispatch しない。
  - `screenSpaceSpecularQuality`「映り込みの精細さ」: 低 / 中 / 高。負荷と引き換えに品質を上げる
    パラメーター — 追跡の歩数、追跡する深度の解像度（半 / 全）、縮小列の段数 — をこの1項目の段に
    束ねる。各段の値は手順4で実測から決める。プリセット低 / 中 / 高 = 低 / 中 / 中を初期値とし、
    手順4で見直す。
  - 既存の `screenSpaceDiffuse` / `screenSpaceQuality` には触れない。遮蔽と照り返しの設定とは独立。
- **デバッグ表示は局所反射の中間 target をすべて出す。** `src/render/pipeline/debug-target.ts` の
  `DEBUG_TARGETS` へ足せば、ゲームのデバッグ情報ウィンドウと render-lab の「デバッグ表示」の両方に
  ボタンが出る。足すのは次の5つ（id は仮）。

  | id | 表示名 | 中身 |
  | --- | --- | --- |
  | `reflection-depth` | 映り込みの深度 | 追跡パスが縮小した深度 |
  | `reflection-hit` | 映り込みの当たり位置 | hit uv（miss は黒） |
  | `reflection-distance` | 映り込みの当たり距離 | view-space の hit 距離 |
  | `reflection-weight` | 映り込みの置換重み | `w` |
  | `reflection` | 映り込み | 像の解決が足す `R × w × I` だけ |

  縮小列は中身がマテリアル出力の写しなので、別のボタンは作らない。
- **ボタンの並び順はパス順（生成順）と一致させる。** 上の4つは追跡パスの生成物として、
  `render-pipeline.ts` で追跡を呼ぶ位置に対応する場所へ並べる。`reflection` はマテリアルの後・大気の
  前。拡散側がパス順を変えた場合も、着手時点の `render-pipeline.ts` の実行順から並びを決め直す。
  `tests/render/debug-target.test.ts` の順序の固定もそれに合わせる。
- **GPU の行は2行。** 追跡（ライトプリパスより前）と像の解決（マテリアル後）は実行順で隣り合わない
  ので、「映り込みの追跡」と「映り込み」を実行順にそれぞれ置く。`tests/render/gpu-timings.test.ts` の
  順序の固定もそれに合わせる。

### 着手時点の構成（`3e646383` の監査）

- **境界は成り立つ。** `specularVisibility` は0件。環境光・天体照は近傍拡散補正を読まない。拡散側は
  マテリアルパスに手を入れておらず、照度補正を光源 `DiffuseCorrectionSource`（鏡面は0）として照度
  バッファの拡散へ足す。拡散側は照度バッファの鏡面もマテリアル出力の写しも持たない。
- **光源は1つ1枚の加算描画**（`[sun, planet slot×2, ambient, correction]`）。`1 − w` を掛けるのは
  `AmbientSource.contribution` と `PlanetLightSlot.contribution` の `specular` だけ。画素ごとの target を
  光源から読む前例は `DiffuseCorrection.at(sample)` で、`ScreenSpaceReflection` はこの形（render-pipeline
  が持ち、書くパスと読む光源へ渡す）を写す。光源のマテリアルは遅延生成して使い回すので、オン / オフは
  マテリアルを作り直さず、オフで target を `w = 0` にクリアして切る（`1 − 0` は厳密に1）。
- **`R`** は `material-pass.ts` の `mix(vec3(0.04), baseColor, metalness)`（`basecolorTexture` の rgb /
  a）。`R` は `material-pass.ts` から export する関数にし、像の解決がそれを import する。lighting/ は F0 を
  知らない設計なので、そこへは置かない。
- **パス順**: 影マップ → G バッファ → 影 → 天体照の bake → 遮蔽と照り返し → ライティング → マテリアル
  → 大気 → …。追跡は遮蔽と照り返しの直後・ライティングの直前、像の解決はマテリアルと大気の間。
  `compile()` の段表・`dispose()`・`buildDebugComposites` にも足す。
- **GPU の行**は0から連番で、テストが `[0..N)` を固定する。「映り込みの追跡」は「近傍拡散復元」と
  「ライティング」の間、「映り込み」は「マテリアル」と「大気」の間へ挿し、以降は繰り下げる。
- **デバッグ表示**: 追跡の4つは `correction` と `diffuse` の間、`reflection` は `material` と
  `atmosphere` の間。デバッグ「マテリアル」は像を足す前のマテリアル出力を見せる — `inspectBackdrop`
  を像の解決より前へ移す。
- **写し**: 大気パスの写し（`backdropTarget` / `inspectTarget`）は像を足した後の時点のものなので共有
  できない。局所反射は mip 付きの写しを自前で持つ。
- **半解像度の深度**は拡散側に無い（拡散は全解像度の G バッファ深度を点読みする）。追跡パスが新規に
  縮小する。深度は逆Z、空は0。blue noise は `src/render/blue-noise.ts` の `BlueNoise` を自前で持つ。
- **置き場**: 追跡の3ファイルは `screen-space/`（拡散側と同じ3分割）、像の解決は
  `src/render/pipeline/reflection-pass.ts`。

### 先行研究から採る範囲

| 論文・実装 | この計画で採るもの | 採らないもの |
| --- | --- | --- |
| [McGuire & Mara 2014「Efficient GPU Screen-Space Ray Tracing」](https://jcgt.org/published/0003/04/04/) | 深度バッファ上を画面空間で透視補正した刻みで進める追跡 | — |
| Uludag 2014「Hi-Z Screen-Space Cone-Traced Reflections」（GPU Pro 5） | 鏡面ローブが当たり距離で張る円の半径から、縮小列の LOD を選ぶこと | — |
| [GTSO](https://www.activision.com/cdn/research/PracticalRealtimeStrategiesTRfinal.pdf) | — | 拡散の遮蔽から作る鏡面遮蔽（一つのローブの可視率）。局所反射にも入れない |

---

## 達成目標

1. `leo-metal` の金属・粗さ0.05の球に隣の球が映り、映り込みオフでは映らない。
2. `bay-metal` の粗さ0.05の板に白い立方体と薬莢が映って遠方の天体照像を置き換える。粗さ0.4では
   像がぼけ、粗さ0.8ではオン/オフ差が3 LSB以下。
3. 映り込みオフのデバッグ「鏡面照度」と「マテリアル」は、着手時点のコードと pixel diff 0。
4. 映り込みオンで、マテリアルパスの拡散の項（デバッグ「拡散照度」と拡散側の中間 target）が
   映り込みオフと pixel diff 0 — 局所反射が拡散に触れていない。
5. GPU の「映り込みの追跡」と「映り込み」の median の和が、同じ session の「マテリアル」の5倍以下
   （精細さ「中」）。
6. `ssr-after` と `ssr-before-1/2` の比較で、封筒外は局所反射が出る金属面に限られる。
7. ゲームと render-lab の両方で、局所反射の5つのデバッグ表示がパス順の位置に並び、映り込みの2つの
   描画設定が選べる。

---

## 手順

before は `.render-lab-shots/ssr-before-1` / `ssr-before-2`（`3e646383`、各67枚、2組の md5 は全一致）。
`leo-metal` の粗さ0.05の球に映るのは地球の天体照と太陽の点だけ、`bay-metal` の粗さ0.05の板に映るのは
地球の雲模様だけで、どちらも近くの物体は映っていない。

### 手順 2. 鏡の向きへ追跡し、遠方鏡面との置換重みを作る

**目的** — 反射 ray の hit uv / 距離 / confidence を幾何だけから求め、像を足す前に、hit 部分の
天体照・環境光の鏡面だけを `1 − w` で弱める。描画設定とデバッグ表示もここで通す。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/screen-space/reflection-trace.ts`（新規） | 深度の透視補正追跡、blue-noise jitter、hit / miss、画面端・距離・粗さ confidence。ray thickness の単位と根拠をここに閉じる。遠方光・マテリアル出力・拡散側の target は読まない |
| `src/render/pipeline/screen-space/reflection-trace-pass.ts`（新規） | 深度の縮小と追跡の dispatch、target の持ち主。`screen-space-pass.ts` とは別のパスで、拡散側と target / GPU 行を共有しない |
| `src/render/pipeline/screen-space/screen-space-reflection.ts`（新規） | 全解像度 target。`rg = hit uv`、`b = view-space hit distance [m]`、`a = w` の符号化と、遠方鏡面を置換する読み口 |
| `src/render/pipeline/lighting/ambient-source.ts` / `src/render/pipeline/lighting/planet-light-source.ts` | コンストラクタで `ScreenSpaceReflection` を受け取り、鏡面の寄与へ `farSpecularWeight` を掛ける（オフでは target が `w = 0` なので係数は厳密に1）。拡散の寄与には掛けない。近傍拡散補正は参照しない |
| `src/render/graphics-settings.ts` | `screenSpaceSpecular` と `screenSpaceSpecularQuality` を足す |
| `src/render/pipeline/render-pipeline.ts` | 追跡パスを遮蔽と照り返しの直後・ライトプリパスの直前に呼び、`rebuildForGraphics` で設定を配る。`compile()` の段表と `dispose()` にも足す |
| `src/render/pipeline/debug-target.ts` / `src/render/pipeline/render-pipeline.ts` | `reflection-depth` / `reflection-hit` / `reflection-distance` / `reflection-weight` を `correction` と `diffuse` の間へ足し、`buildDebugComposites` で実 target を直接表示する |
| `src/render/gpu-timings.ts` | 「映り込みの追跡」を「近傍拡散復元」と「ライティング」の間へ挿し、以降の ID を繰り下げる |
| `tests/render/debug-target.test.ts` / `tests/render/gpu-timings.test.ts` | 順序の固定を直す |
| `tools/render-lab/` の case | 追跡の4つのデバッグ表示を `leo-metal` / `bay-metal` で撮る case を足す |

```ts
export class ScreenSpaceReflection {
  public readonly texture: THREE.Texture;
  public farSpecularWeight(sample: ShadingSample): FloatNode; // off/miss は 1、hit は 1-w
  public dispose(): void;
}
```

**達成条件と検証**

- `npm run typecheck` / `npm run check:boundaries` / `npm run test:render` / `npm run test:settings`。
- 映り込みオンの `bay-metal` で、粗さ0.05の板の立方体が映るはずの領域から遠方天体照の像が消える。
  まだ局所像は足さないので、その領域は暗く見える。粗さ0.8はオフと差が3以下。
- 空・画面外・カメラへ向かう ray が miss になり、`leo-metal` の上端に黒い像が出ない。
- 映り込みオンとオフでデバッグ「拡散照度」が pixel diff 0（達成目標4）。
- 映り込みオフの組は `ssr-before-*` と封筒外0件。オフでは追跡の4つのデバッグ表示が黒。
- render-lab の描画設定に2項目が出て、デバッグ表示に4つのボタンがパス順の位置に並ぶ。
- `leo-metal` と `bay-metal` で GPU「映り込みの追跡」の行を測り、見積りの1歩あたりの費用を実測で置き換える。
- commit: `feat(render): 滑らかな面の映る向きを追い遠方鏡面を置き換える`

### 手順 3. 当たった像を粗さに応じて足す

**目的** — 当たった点の色をマテリアルパス出力の縮小列から粗さに応じて読み、マテリアルパスと同じ
鏡面反射率 `R` を掛けた `R × w × I` をマテリアル後・大気前へ足す。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/material-pass.ts` | 鏡面反射率 `R` を G バッファから求める関数を切り出して export し、鏡面の係数をその呼び出しへ置き換えるだけ。拡散の項・合成・パス順は変えない |
| `src/render/pipeline/reflection-pass.ts`（新規） | マテリアル出力の写し（mip 付き、自前で持つ）と縮小列、roughness LOD、hit uv 解決、`material-pass.ts` の `R` を使った `R × w × I` の加算。GPU「映り込み」へ計上。マテリアル出力以外に読むのは追跡の target と G バッファだけ |
| `src/render/pipeline/render-pipeline.ts` | マテリアルパス後・大気前に呼ぶ。`inspectBackdrop` を像の解決より前へ移し、デバッグ「マテリアル」が像を含まないようにする。`compile()` の段表と `dispose()` にも足す |
| `src/render/gpu-timings.ts` | 「映り込み」を「マテリアル」と「大気」の間へ挿し、以降の ID を繰り下げる |
| `src/render/pipeline/debug-target.ts` | `reflection`「映り込み」を `material` と `atmosphere` の間へ足す |
| `tests/render/debug-target.test.ts` / `tests/render/gpu-timings.test.ts` | 順序の固定を直す |

大気パスの写しは像を足した後の時点のものなので共有しない。共有 target を書きながら読まない。

**達成条件と検証**

- `npm run typecheck` / `npm run check:boundaries` / `npm run test:render`。
- 映り込みオフのデバッグ「マテリアル」が着手時点と pixel diff 0（`R` の切り出しで値が変わっていない）。
- 縮小列の各 mip を別色にした最小プローブで、選んだ LOD と実 target が一致する。
- 置換の一致を確かめる最小プローブ: 遠方鏡面と同じ放射輝度を像として返す場面で、`w = 1` の画素の
  鏡面反射光が映り込みオフと一致する（係数の食い違いがない）。
- `npm run render-lab:shot -- ssr-on` で達成目標1〜4。デバッグ「映り込み」は像だけを表示する。
- commit: `feat(render): 滑らかな面に近くの物体の像を映す`

### 手順 4. 精細さの段を決め、追い込み、比較して main へ送る

**目的** — 精細さの各段の値（追跡歩数・追跡解像度・縮小列の段数）を実測で決め、粗さ・画面端・距離の
フェードと hit tolerance を追い込み、意図しない画像差と負荷を確認して閉じる。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/screen-space/reflection-trace.ts` / `src/render/pipeline/reflection-pass.ts` | 粗さ・画面端・距離のフェード、hit tolerance を追い込む |
| `src/render/graphics-settings.ts` | `screenSpaceSpecularQuality` の各段の値とプリセットを実測で確定する |
| `tools/render-lab-measure.mjs` | `screen-space` の軸に映り込みオン/オフと精細さの段を足し、構図に `leo-metal` / `bay-metal` を足す（既定の構図 bay は白い面がほぼ粗さ0.7で、追跡がほとんど歩かず負荷を過小に読む） |
| `memos/hedalu244/better_graphics/pipeline.md` | パス表と残件を更新する |

**達成条件と検証**

- `npm run render-lab:shot -- ssr-after`。
- `npm run render-lab:compare -- .render-lab-shots/ssr-after .render-lab-shots/ssr-before-1 .render-lab-shots/ssr-before-2` で達成目標6。
- `node tools/render-lab-measure.mjs 3 screen-space` で達成目標5。精細さの各段の負荷と画を並べ、段の値を
  決めた根拠を commit メッセージに残す。
- `bay-metal` の粗さ sweep（0.05 / 0.4 / 0.8）で、中間粗さの天体照の映り込みだけが過剰に暗くならない。
- ゲームの描画設定パネル・デバッグ情報ウィンドウと render-lab で達成目標7。
- `npm run typecheck` / `npm run check:boundaries` / `npm run test:render` / `npm run test:settings`。
- `/refactor` / `/comment-cleanup` / `/send-pr`。
- 残件がなければこの計画ファイルを削除する。

---

## 見積り

| 作業 | 手順 | 中央見積り |
| --- | --- | ---: |
| 最終監査 | 4 | 1 h |
| 追跡と深度の縮小 | 2 | 8 h |
| 置換境界と設定・デバッグ表示 | 2 | 4 h |
| `R` の切り出しと置換一致のプローブ | 3 | 2 h |
| 縮小列と像 | 3 | 6 h |
| 精細さの段・品質・負荷・比較 | 4 | 7 h |

**合計 28 h。**

負荷の初期予算（960×540、Intel gen-12lp、`3e646383` のマテリアル行 ≈ 0.30 ms）。拡散の走査の段の差から
出した1/4解像度の標本1回の限界費用は 0.023 ms（マテリアル行の約0.08倍）で、半解像度へ直すと1歩
約0.3倍。これは深度と法線を読み遮りを計算する標本の値なので上限で、深度だけを読む追跡の1歩は
0.1〜0.3倍と置く。32歩の追跡 3.2〜9.9倍、写しと縮小列約1倍、解決約1倍（拡散の全解像度の多タップ段の
復元が約1.9倍）、深度の縮小と固定費約0.5倍で、合計約5.7〜12倍。達成目標5の5倍以下は精細さ「中」
32歩では危ういので、「中」の初期値は手順2の追跡行の実測まで仮置きとする。5倍以下へは、画を見ずに
歩数だけ削らず、hit率・miss率・edge fade と内訳を合わせて追い込む。

---

## リスクと落とし穴

| リスク | 影響 | 露見する手順 |
| --- | --- | --- |
| 局所反射が近傍拡散補正の遮蔽（GTSO 風の鏡面遮蔽）に再依存する | 不自然な鏡面影が復活する | 着手時点で `specularVisibility` 0件。手順2で局所反射が所有する confidence だけを使う |
| 拡散側のファイル・target・パス順に依存する | 拡散側の差し替えで衝突し、マージのたびに作り直しになる | 着手時点で境界は成立。手順2で追跡を独立パスにし、手順2・3で拡散のデバッグ表示が pixel diff 0 であることを確かめる |
| 像と遠方鏡面に別々の係数を掛ける | `w = 1` で鏡面の明るさが段差になり、マテリアル側の係数変更で食い違いが広がる | 手順3で `R` を1つの関数にし、置換一致のプローブで確かめる |
| 空の深度を hit として扱う | 虚空が黒い像として映る | 手順2で空・画面外・カメラ向き ray を明示的に miss とし、`leo-metal` 上端を確認 |
| 粗さ fade と遠方鏡面の置換を二重適用する | 中間粗さだけ天体照の映り込みが過剰に暗くなる | 手順2・3で同じ `w` を置換と像に一度ずつ使い、手順4で `bay-metal` の粗さ sweep を測る |
| 太陽の鏡面まで弱める | 仕様に反して太陽のハイライトが映り込みで消える | 着手時点で光源ごとに弱められる。手順2で天体照・環境光の光源だけに掛ける |
| 局所反射の解決で書き込み中の共有 target を読む | WebGPU validation error で画面全体が失敗する | 手順3で copy / ownership を先に確定し、同じ描画命令の read-write を禁止 |
| 縮小列の特定 mip へ描けない | 粗い面でも像が鋭いままになる | 手順3の最小プローブで各 mip を別色にし、LOD と実 target を照合 |
| debug のために段を再実行する | 見ている値と通常フレームが違う | 手順2・3でデバッグ表示が実 target を直接読むことを確認 |
| デバッグ表示や GPU 行の順がパス順でない / 複数段が同じ行 | 重い場所や生成元を誤認する | 手順2・3で実行順の位置へ置いてテストで固定し、手順4で render-lab UI と `tools/render-lab-measure.mjs` を照合 |
| blue noise をフレームごとに動かす | 静止画は良いが動画がちらつく | 手順2で固定2D pattern にし、手順4で連続フレーム readback の一致を確認 |

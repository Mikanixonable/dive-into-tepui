# ロードの軽量化 その2 — 現在地と次の手

対象コミット `e948488c`(ブランチ `optimize-load-and-runtime`)。
**スナップショットであって、コードの現状を説明する文書ではない。全手順を実施したら消す。**

## 目的

ブランチの一連の作業で、起動の固まりは 53〜60 秒から 19 秒へ落ちた。残っているのは次の3つで、
どれも別々の原因を持つ。

1. **ローディング表示が消えた直後に、画面が 4.3 秒(creative では 9.3 秒)固まる。**
   進捗表示は 100% になって消えているのに、最初の絵が出るまで無反応になる — 体感としては
   いちばん悪い。原因は「初回フレームでしか組まれないパイプラインが 9 本(creative 15 本)
   残っていること」で、実測済み。
2. **ロード表示中のシェーダ構築 19 秒のうち、11 秒が大気パスと遮蔽パスの2つに集中している。**
   どちらも静的展開で 100 KB を超える単一のフラグメントシェーダになっている。
3. **creative は、その周回で置くとは限らないタンパク質 1 体(25 MB)をロード表示中に取りに行く。**

あわせて、最初のテクスチャが揃った直後に **1.05 秒 JS スレッドが止まる**(プレイ中の固まり)。

---

## 現在地(実測)

### 測り方と、その限界

`webpack --mode development` でビルドしたものを静的配信し、ヘッドレス Chrome を CDP で駆動する
使い捨てのプローブで測った(`src/` は変更していない)。`Page.addScriptToEvaluateOnNewDocument` で
`GPUDevice.prototype` の `createShaderModule` / `createRenderPipeline(Async)` /
`createComputePipeline(Async)` をスタックごと包み、同時に rAF の到来時刻・20 ms 間隔のタイマー
心拍・ローディング表示の注記の変化・Resource Timing を取る。開発ビルドを使うのはスタックに
`src/render/pipeline/*.ts` の関数名が残るため。

- **測定機の GPU は Intel gen-9 の内蔵 GPU**、Chrome、1280×720、品質プリセット high(既定)。
  **絶対値は実機の値ではない。信じてよいのは条件間の比と、どこで何が起きているかという形だけ。**
- 同じ条件で 2 回測ったばらつきは compile 段合計で 17.7 秒 / 19.0 秒。**1 秒台の差は差と見なさない。**
- アセットのサイズは `webpack --mode production` の出力を実測したもの。gzip は level 6 で自分で
  掛けた値(公開先は `.js` `.json` `.epk` を gzip、画像とフォントは無変換で返す)。

### 1. アセット — 何が、いつ落ちてくるか

**ローディング表示中に取りに行くもの**(`?stage=1`)

| アセット | 素 | 転送 | 起点 |
| --- | ---: | ---: | --- |
| `main.js` | 6.13 MB | 1.40 MB | `<script>` |
| HackGen-Regular.woff2 | 1.55 MB | 1.55 MB | `src/hackgen-400.css` |
| JetBrains Mono 400 woff2 | 0.02 MB | 0.02 MB | `@fontsource/jetbrains-mono/latin-400.css` |
| `ephemeris/far-future-20115-10y.epk` | 4.12 MB | 3.01 MB | `system` 段(**await する**) |
| `8k_stars.jpg` | 1.82 MB | 1.82 MB | `bodies` 段(await しない) |
| **計** | **13.64 MB** | **7.80 MB** | |

`?stage=creative` は、これに **タンパク質の既定 1 体**が加わる(実測でロード表示中の 2.3 秒に開始):

| `models/rubisco8rucStructure.json` | 16.45 MB | 4.79 MB |
| `models/rubisco8rucMotion.json` | 8.58 MB | 1.98 MB |
| **creative 計** | **38.67 MB** | **14.57 MB** |

**最初に使うフレームで取りに行くもの**(stage 1 でも creative でも同じ 5 枚。ローディング表示が
消えるのとほぼ同時に始まる)

| `cloud-field.png` | 13.00 MB |
| `earth.jpg` | 4.35 MB |
| `8k_moon.jpg` | 2.96 MB |
| `2k_saturn.jpg` | 0.19 MB |
| `earth-smoothness.png` | 0.14 MB |
| **計** | **20.64 MB**(画像なので転送も同じ) |

**条件が揃うまで取りに行かないもの**(110 秒の観測で 1 バイトも落ちてこなかった)

| `2k_*.jpg` 12 枚 | 4.73 MB | 見かけ直径が閾値未満のまま。**土星だけが閾値を越えて落ちてくる** |
| `ephemeris/modern-2026-10y.epk` | 4.07 MB | 元期が 2026 年台のときだけ |
| `orbits/lagrange-orbits-<系>.json` 7 本 | 13.20 MB | 表示オプションでその族を有効にしたときだけ |
| タンパク質 Structure/Motion 8 本 | 93.63 MB | creative で選ばれた体だけ |
| `8k_clouds.jpg` / `earth-climate.png` | 5.68 MB | **本体から参照が無い**(cloud-lab 専用) |

**`main.js`(素のモジュール 9.93 MB → 出力 6.13 MB → 転送 1.40 MB)の中身**

| three | 3.55 MB | |
| `src/` のコード | 2.82 MB | |
| `models/`(艦艇・弾薬) | 2.23 MB | gz 寄与は小さい(`ammo.json` 1.39 MB → 0.066 MB) |
| **タンパク質 Backbone 4 本** | **0.53 MB** | **gz 寄与 0.17 MB。creative でしか使わない** |
| `moon-features.json` | 0.46 MB | **gz 寄与 0.18 MB(単体では最大)** |
| `luts/*.cube` 3 本 | 0.21 MB | `asset/source` で全文が同梱される |
| `earth-coastline.json` | 0.11 MB | gz 寄与 0.048 MB |

### 2. シェーダ — 何本が、いつ組まれるか

`?stage=1`・品質 high・1280×720。**パイプライン 59 本 / シェーダモジュール 86 本 / WGSL 626.9 KB。**
compute パイプラインは 0 本(タンパク質の敵を置くまで作られない)。

内訳は生成時のスタックで分けた(`compileInto` / `*.compile` から来たものが「ロード中」、
`RenderPipeline.render` から来たものが「初回フレーム」):

| 区分 | パイプライン | シェーダ | WGSL | compile 段の所要 |
| --- | ---: | ---: | ---: | ---: |
| ロード中 / compile 前(`run` 段) | 1 | 2 | 3.5 KB | — |
| ロード中 / 影 | 7 | 9 | 20.2 KB | 549 ms |
| ロード中 / G バッファ | 7 | 9 | 37.9 KB | 535 ms |
| ロード中 / **遮蔽** | 4 | 8 | **153.2 KB** | **4,289 ms** |
| ロード中 / 照明 | 4 | 7 | 37.1 KB | 1,154 ms |
| ロード中 / マテリアル | 2 | 4 | 6.8 KB | 391 ms |
| ロード中 / **大気** | 2 | 4 | **117.8 KB** | **6,827 ms** |
| ロード中 / ワールド | 9 | 14 | 53.0 KB | 860 ms |
| ロード中 / レンズ | 5 | 8 | 127.1 KB | 2,860 ms |
| ロード中 / 合成 | 1 | 0 | 0.0 KB | 129 ms |
| ロード中 / オーバーレイ | 8 | 10 | 29.6 KB | 197 ms |
| **実行中 / 初回フレーム** | **9** | **11** | **40.9 KB** | — |
| **計** | **59** | **86** | **626.9 KB** | **19.0 秒**(2 回目は 17.7 秒) |

`?stage=creative` は影パスが 0 本になるぶん **パイプライン 50 本(ロード中 35 / 初回フレーム 15)/
シェーダ 75 本 / 584.1 KB**、compile 段 20.5 秒。

**初回フレームに残っている 9 本の出どころ**(スタックで特定済み):

| 何 | 本数 | 呼び出し元 |
| --- | ---: | --- |
| `MeshStandardNodeMaterial`(天体表面の solid / textured) | 2 | `gbuffer.ts:116` ← `render-pipeline.ts` の `render` |
| 合成板(`MeshBasic` / `MeshBasicNode` / `outputColorTransform`) | 3 | `render-pipeline.ts` の合成パス |
| オーバーレイ(`MeshBasicMaterial` ×2 / `LineBasicMaterial`) | 3 | `overlay-pass.ts:138` `renderRealistic` |
| `outputColorTransform` | 1 | `antialias-pass.ts:72` |

原因は2つに分かれる。

- **天体表面の 2 本** — `CelestialSurface` は `activeLevel` が決まるまで全 LOD メッシュを
  `visible = false` にしている。compile 段が走る時点ではまだ `syncLod` が一度も通っていないので、
  `compileAsync(scene, camera)` が天体表面を1つも拾えない。**しかもこの 2 本は G バッファの
  MeshStandard で、初回フレームで作られるシェーダ 40.9 KB のうち 23.6 KB を占める最も高い部類。**
- **合成・オーバーレイ・アンチエイリアスの 7 本** — これらの実描画は
  `setOutputRenderTarget()` を張った状態の `QuadMesh.render()` / `renderer.render()` を通るのに対し、
  `compile-into.ts` の `compileInto` は `setRenderTarget()` を張る。three が出力ターゲットへ書く
  ときだけ挟む色変換の経路が、compile 側には現れない。

**その結果**: ローディング表示を DOM から外した直後に、**stage 1 で 4,345 ms(別回 3,221 ms)、
creative で 9,273 ms、rAF が1回も来ない。** この間 20 ms タイマーの心拍は期待どおり届いている
(4,345 ms に対し 210 / 217 回)ので、**JS は暇で、詰まっているのは GPU 側のパイプライン構築**。

### 3. そのほかの実測

- **初回テクスチャが揃った直後に 1,047 ms、JS スレッドが完全に止まる**(心拍 0 / 52 回)。
  上の 20.64 MB が届いた直後のフレーム。デコードかアップロードかミップマップ生成かは切り分けて
  いない。
- ロード表示中の rAF は、compile 段のあいだ 100 ms 前後で来続けている(止まらない)。
  **`compileAsync` はロード表示を殺さない** — 進捗ゲージは実際に動く。
- タンパク質の compute シェーダは、起動時には 1 本も作られない。敵を置いた瞬間に体ごとに組まれる
  (`protein-motion-material.ts` の `flushProteinMotionComputes`)。**creative 限定なので、この計画では
  触らない。**
- Chrome の GPU ディスクキャッシュは WGSL 本文を鍵にする。**バンドルを配信し直すたび、全プレイヤーが
  1 回だけこの構築を踏む。**

---

## 決めたこと

判断の根拠はユーザーが示した優先順(ロード時間を短く / プレイ中に固まらせない / 非同期の取得と
コンパイルは容認 / アセット遅延による単色球は容認 / タンパク質専用の費用は省く)。

1. **初回フレームのパイプライン構築を、ロード表示の中へ移す**(手順 1)。総時間はほとんど変わらないが、
   「進捗 100% で消えた後に無反応」が「進捗の中で進む」に変わる。**移動の向きとしては 実行時 → ロード中。**
2. **creative のタンパク質取得は、ロード表示の外へ出す**(手順 2)。**移動の向きとしては ロード中 → 実行時。**
   `DEVELOP/SPEC/PROTEIN.md`「出現」は「選ばれた時点で取得を始める」「選ぶ画面を開いた直後は既定の
   1 体だけ」までしか要求していない。パネルがまだ画面に出ていないロード表示中に取り始める必要はない。
3. **天体テクスチャの遅延は現状のままにする。** 12 枚の `2k_*.jpg` は落ちてこず、狙いは既に達成
   されている。単色球が一瞬見えるのは容認済み。
4. **レンズパス(2.9 秒)には手を付けない。** 26 本 → 5 本まで既に畳まれていて、これ以上は
   `lens-kernels.ts` が持つ「向き1つにつき1本の鎖」という設計を崩す。**費用対効果が合わない。**
5. **タンパク質の compute シェーダ、メッシュ間引き、`8k_clouds.jpg` / `earth-climate.png` の
   置き場所は、この計画では扱わない。**

**覆されたときに変わる手順**: 2 を覆す(ロード表示中の取得を続ける)なら手順 2 を落とす。
3 を覆す(遠くの惑星も先に取る)なら現状のコードを戻す別の手順が要る。

---

## 達成目標

全手順の実施後、`?stage=1` と `?stage=creative` の両方で次を満たす。すべて後述のプローブで測る。

1. **`RenderPipeline.render` を起点に作られるパイプラインが 0 本。**
2. **ローディング表示が消えてから 10 秒間の最大フレーム欠落が 500 ms 以下**
   (現状 stage 1 で 4,345 ms、creative で 9,273 ms)。
3. **compile 段の合計が stage 1 で 12 秒以下**(現状 19.0 秒)。
   導出: 大気 6.8 秒 → 2.0 秒、遮蔽 4.3 秒 → 2.0 秒 で 19.0 − 7.1 = 11.9 秒。
4. **creative のロード表示が消える前に、`assets/*Structure.json` / `*Motion.json` の
   Resource Timing エントリが1つも現れない。**
5. **`main.js` の gzip 転送が 1.25 MB 以下**(現状 1.40 MB)。
6. **見た目が変わらない。** 大気・遮蔽に触れた前後で `npm run render-lab:shot` の絵が一致する
   (撮り直しの揺れ ±4 LSB を超える差が無い)。

---

## 手順

### 手順 1. 初回フレームで組まれるパイプラインを 0 にする

**目的**: ローディング表示が消えた直後の 4.3 秒(creative 9.3 秒)の無反応を消す。総コンパイル
時間はほぼ変わらず、進捗ゲージの中へ移る。**絵は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/main.ts:146-149` | `new Launcher(...)` へ `graphics`(`GraphicsSettings`)を渡す |
| `src/launcher/launcher.ts:52-66` | コンストラクタへ `private readonly graphics: GraphicsSettings` を足す |
| `src/launcher/launcher.ts:118-121` | `Game.create(...)` へ `graphics.current` を渡す |
| `src/game/game.ts:110-151` | `create` の引数へ `graphics: GraphicsSettingsData` を足し、`await progress.enter('shaders')` の**直前**に `game.sync(graphics, hud.renderStyle.current)` を1回通す。天体表面の `activeLevel` が決まり、`compileAsync` が実際に描かれるメッシュを拾えるようになる |
| `src/render/pipeline/compile-into.ts` | 出力ターゲット経由の入口を足す(下記の署名) |
| `src/render/pipeline/render-pipeline.ts:343-355` | 「合成」を `compileIntoOutput` へ替える |
| `src/render/pipeline/overlay-pass.ts:104-121` | realistic 経路を `compileIntoOutput` へ替える |
| `src/render/pipeline/antialias-pass.ts:61-63` | `compileIntoOutput(renderer, null, ...)` へ替える |

```ts
// src/render/pipeline/compile-into.ts(追加)
// 描画時に setOutputRenderTarget を張って描くパスのための入口。three は出力ターゲットへ
// 書くときだけ色変換の経路を挟むので、setRenderTarget で組んだものとは別のパイプラインになる。
export async function compileIntoOutput(
  renderer: WebGPURenderer,
  outputTarget: THREE.RenderTarget | null,
  object: THREE.Object3D,
  camera: THREE.Camera,
): Promise<void>;
```

**`compileAsync` が three の出力色変換パスまで組めるとは限らない。** 組めないことが分かったら、
`outputColorTransform` の 2 本については代わりに **`sync` を通した直後に表示用ターゲットへ 1 フレーム
だけ `pipeline.render()` を投げて捨てる**(ローディング表示は出したまま)。この順なら、以前
レンダラごと落ちた「`sync` を通さずに `pipeline.render()` を呼ぶ」状態にはならない。

**達成条件と検証**

- `npm run typecheck` が通る。
- `npm run test:render` と `npm run test:game` が通る。
- プローブで `?stage=1` / `?stage=creative` のどちらも、
  **`RenderPipeline.render` を起点とするパイプラインが 0 本**。
- プローブで、**ローディング表示が消えてから 10 秒間の最大フレーム欠落が 500 ms 以下**。
- compile 段の合計が現状(19.0 秒 / 20.5 秒)から大きく伸びていない(+5 秒以内)。

### 手順 2. creative のタンパク質取得を、ロード表示の外へ出す

**目的**: creative のロード表示中に走る 25.03 MB(転送 6.77 MB)の取得と `JSON.parse` を、
ゲームが動き出してからへ移す。**その周回でタンパク質を置かないプレイでも払っている費用を無くす。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/creative/stage-controls-panel.ts:193` | 構築時の `selectShape(selectedShape)` が既定 1 体の取得を起こしている。選択状態の反映と取得の起動を分け、**取得はパネルが実際に画面へ出てから**起こす |
| `src/game/creative/creative-stage.ts:108` | パネルの構築(= 上の呼び出し)は `new Game()` の中、つまり `run` 段で走っている。取得の起点をここから外す |

`dynamic-system.ts:156-165` の `spawnEnemyWhenReady` が「準備できるまで実体化を遅らせる」機構を
既に持っているので、**取得が間に合わなくても置く操作は壊れない。**

**達成条件と検証**

- `npm run typecheck` が通る。`npm run test:game` が通る。
- プローブの Resource Timing で、`?stage=creative` の **ローディング表示が消える前に
  `assets/*.json`(Structure / Motion)のエントリが1つも無い。**
- creative を開いてタンパク質の敵を置けること(`npm run dev` で目視。形状を選び直しても置ける)。
- `DEVELOP/SPEC/PROTEIN.md`「出現」の記述は変えない — 「選ばれた時点で取得」は保たれている。

### 手順 3. 大気パスの静的展開を畳む

**目的**: compile 段で最も高い 6,827 ms を削る。`atmosphere-pass.ts` は 1 本 117.8 KB の
フラグメントシェーダを作っていて、その大半が天体スロットの静的展開。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/pipeline/atmosphere-pass.ts:188` | `accumulateLayers` が `MAX_ATMOSPHERE_BODIES` 回ぶんを JS の `for` で並べている。TSL の `Loop()` + スロットごとの uniform 配列(または storage)へ移す |
| `src/render/atmosphere.ts:26` | `MAX_ATMOSPHERE_BODIES = 4`。畳んだあとも上限としては残るが、シェーダ本文には現れなくなる |
| `src/render/ray-march.ts:46` | **手本**。刻み数を uniform + `Loop()` にしてあり、品質設定を変えても WGSL が変わらない。同じ形に揃える |

**達成条件と検証**

- `npm run typecheck` が通る。`npm run test:render` が通る。
- プローブで **大気パスの WGSL が 117.8 KB → 40 KB 以下**、かつ **compile 段の所要が 2.5 秒以下**。
- `npm run render-lab:shot` の絵が、変更前後で一致する(**撮り直しの揺れ ±4 LSB を超える差が無い**。
  半影を持つケースは揺れるので、差を根拠にする前に撮り直す)。
- `PerfMeter` の大気パスの GPU 時間が悪化していない(`npm run dev` で `perf` 表示。悪化していたら
  この手順を差し戻す — 動的ループはレジスタ圧を変える)。

### 手順 4. 遮蔽パスの静的展開を畳む

**目的**: compile 段で2番目に高い 4,289 ms(creative では 6,477 ms)を削る。
`sun-occlusion.ts` は 4 枚のフルスクリーンマテリアルで計 153.2 KB を作っていて、
その大半が帯・タップ・スロットの静的展開。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/pipeline/sun-occlusion.ts:345` | `ringTransmittance` が `MAX_RING_BANDS = 13`(`:26`)回ぶんを並べている。`Loop()` + 帯ごとの uniform 配列へ |
| `src/render/pipeline/sun-occlusion.ts:569` | `slotVisibility` の Vogel disk PCF が `PCF_TAPS = 12`(`:107`)回ぶん。`Loop()` へ |
| `src/render/pipeline/sun-occlusion.ts:392` | `cumulusTransmittance` が `CUMULUS_SHADOW_TAPS = 6`(`:80`)回ぶん。`Loop()` へ |
| `src/render/pipeline/sun-occlusion.ts:325` / `:492` / `:527` | `MAX_OCCLUDERS = 4`(`:22`)と影スロット 4 枚の展開。**帯とタップを畳んだ後の実測を見てから、要るかを決める** |

**達成条件と検証**

- `npm run typecheck` が通る。`npm run test:render` が通る。
- プローブで **遮蔽パスの WGSL が 153.2 KB → 60 KB 以下**、かつ **compile 段の所要が 2.5 秒以下**。
- `npm run render-lab:shot` の絵が変更前後で一致する(土星の環の影・雲の影・メッシュの影が
  写っているケースを必ず含める)。
- `PerfMeter` の遮蔽パスの GPU 時間が悪化していない。

### 手順 5. タンパク質の Backbone を `main.js` から外す

**目的**: creative でしか使わない 0.53 MB(gzip 寄与 0.17 MB)を、全ステージの起動から外す。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `tools/protein-builder/generate-protein-catalog.mjs` | **生成側が正本。** `*Backbone.json` を値としてではなく URL として import するよう生成物を変える |
| `src/game/protein/protein-asset-catalog.generated.ts` | 上の再生成物(`npm run protein:catalog`)。手で書き換えない |
| `webpack.config.js:31-38` | `/(Structure|Motion)\.json$/` の `asset/resource` ルールへ `Backbone` を足す |
| `src/game/protein/protein-asset-loader.ts:75-81` | `Promise.all` で Structure / Motion と一緒に Backbone も取る。**`isProteinAssetReady` が Backbone の到着も条件に含めること** |
| `src/render/protein-enemy-ship.ts` | `ProteinBackboneAsset` を同期に受け取る前提が残っていないか確認する |

`*Protein.json`(定義、計 0.01 MB)は形状一覧の組み立てに同期で要るので **バンドルに残す。**

**達成条件と検証**

- `npm run typecheck` が通る。`npm run test:game` が通る。
- `npm run protein:catalog:check` が通る(生成物とツールが一致している)。
- `npm run build` の出力で **`main.js` の gzip が 1.25 MB 以下**。
- `grep -n "Backbone" src/game/protein/protein-asset-catalog.generated.ts` の結果が、
  すべて URL 型(`string`)になっている。
- creative でタンパク質の敵を置き、**当たり判定が効く**こと(`npm run dev` で撃って確認)。

### 手順 6. 初回テクスチャ投入の 1 秒ブロックを均す

**目的**: 20.64 MB のテクスチャが揃った直後に JS スレッドが 1,047 ms 止まるのを解消する。
**手順 1 を終えるまで、この 1 秒は 4.3 秒の固まりに埋もれていて測れない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/deferred-texture.ts:22-27` | まず切り分ける — `THREE.ImageLoader`(`<img>` 経由)を `THREE.ImageBitmapLoader` へ替え、デコードをワーカースレッドへ出したときにブロックが減るかを測る |
| `src/render/celestial-surface.ts:139` / `src/render/cumulus-shell.ts:130` | 減らなければアップロード側。`syncLod` が全 `DeferredTexture` を同時に `request()` している。**1 フレームにつき 1 枚だけ**起こす形にする |

**達成条件と検証**

- `npm run typecheck` が通る。`npm run test:render` が通る。
- プローブで、**ローディング表示が消えてから 10 秒間に 300 ms を超える JS ブロック
  (心拍が 0 回の欠落)が無い。**
- 地球・月・土星の表面テクスチャが最終的に貼られること(`npm run dev` で目視)。

---

## 検証用プローブ

使い捨てなので、実施時に書き直す。要点だけ残す。

1. `webpack --mode development --output-path <dir>` でビルドする。スタックに `src/` の関数名が残る
   (生成される WGSL は本番ビルドと一致することを確認済み)。**`NODE_OPTIONS=--max-old-space-size=8192`
   を付ける** — 付けないと OOM する。
2. `tools/chrome-session.mjs` の `openChromeSession` で配信 + ヘッドレス Chrome を上げる。
   **`serveDir` は `path.resolve` すること**(前方スラッシュのままだと静的サーバが 403 を返す)。
3. `Page.addScriptToEvaluateOnNewDocument` で注入するスクリプトは**別ファイルに置いて
   `readFileSync` で読む。** テンプレートリテラルへ埋め込むとエスケープが壊れ、注入が
   無言で失敗する(実際に踏んだ)。
4. 注入するもの: `Error.stackTraceLimit = 80` を立てて `GPUDevice.prototype` の 5 つのメソッドを
   スタックごと包む / rAF の到来時刻 / **20 ms 間隔のタイマー心拍**(欠落中に JS が暇かどうかの
   切り分けに要る)/ ローディング表示の注記の変化を 8 ms 間隔で拾う / 最後に
   `performance.getEntriesByType('resource')`。
5. **区分は時刻ではなくスタックで付ける。** ローディング表示の消滅時刻は、初回フレームで
   メインスレッドが止まると遅れて記録されるため、時刻で切ると初回フレームのぶんが
   compile 段へ紛れ込む。`compileInto` / `.compile (` / `compileAsync` を含むスタックが
   「ロード中」、`RenderPipeline.render` から来たものが「初回フレーム」。
6. **プロファイルは毎回捨てる。** 使い回すと Chrome の GPU ディスクキャッシュに当たって
   1.6 秒になる。

---

## 見積り

| 手順 | 何がどれだけ動くか | 導出 |
| --- | --- | --- |
| 1 | 表示が消えた後の固まり 4.3 秒(creative 9.3 秒)→ 0.5 秒以下。compile 段は +2〜4 秒 | 初回フレームの 9 本 = 40.9 KB のうち 23.6 KB が G バッファの MeshStandard。compile 段の G バッファは 7 本 37.9 KB で 535 ms なので、2 本増えて +0.2〜0.5 秒。残る 7 本は小さく合計 17 KB |
| 2 | creative のロード表示中の転送 −6.77 MB、`JSON.parse` −0.2 秒 | 実測: rubisco Structure 4.79 MB gz + Motion 1.98 MB gz。取得は 2.29〜3.28 秒に走り、直後に 203 ms の JS ブロックがある |
| 3 | compile 段 −4.3 秒 | 大気 6,827 ms。本文 117.8 KB のうち天体スロット 4 ぶんの展開が支配的で、`Loop()` へ畳めば本文はおよそ 1/4。**費用は本文長に厳密には比例しない**ので、2.5 秒を切らなければ実測で判断し直す |
| 4 | compile 段 −2.3 秒 | 遮蔽 4,289 ms。153.2 KB のうち 13 帯 × 12 PCF タップ × 6 積雲タップの展開が支配的 |
| 5 | `main.js` 転送 1.40 → 1.23 MB | Backbone 4 本の gzip が 0.17 MB(実測: 48.3 + 95.5 + 24.5 + 2.8 KB) |
| 6 | プレイ開始直後の JS ブロック 1.05 秒 → 0.3 秒以下 | 1 フレーム 1 枚に均せば、5 枚で 5 フレームに分散する |

**合計の見込み**: compile 段 19.0 秒 → 12 秒前後、表示が消えた後の固まり 4.3 秒 → 0.5 秒以下、
creative のロード転送 14.57 MB → 7.80 MB。**測定機(Intel gen-9 内蔵 GPU)での値であり、
実機の絶対値ではない。**

---

## リスクと落とし穴

| リスク | 影響 | それが露見する場所 |
| --- | --- | --- |
| `update()` を一度も通していない状態で `sync()` を呼ぶ。`sync()` は「`update()` が確定させた表示窓をそのまま読める」前提で書かれている | 表示窓・カメラが未初期化の値を読み、compile 段が実際とは違うマテリアルを組む。無言で「初回フレームのパイプラインが減らない」形になる | 手順 1(プローブの本数で分かる) |
| `compileAsync` は three の出力色変換の経路を組まない可能性がある | `outputColorTransform` 2 本が初回フレームに残り、達成目標 1 が満たせない | 手順 1 |
| `compileInto` は描画先を `await` の**あと**に戻す作法で書かれている。`compileIntoOutput` で同じ作法を落とすと、フラグメント出力の型が違う別物のシェーダが組まれる | パイプラインが 1 本増え、初回フレームの本数が減らない | 手順 1 |
| `Loop()` は展開されないぶん実行時のレジスタ圧が変わる | コンパイルは短くなるが fps が落ちる。ロードを直してプレイを悪くする | 手順 3・4(`PerfMeter` の GPU 時間) |
| 遮蔽の帯を `Loop()` にすると、帯ごとの uniform を配列へまとめる必要がある。配列長を `MAX_RING_BANDS` に固定すると、**uniform 配列の長さがシェーダ本文へ焼かれる**(このブランチで一度踏んだ形) | 展開を畳んだのにコンパイル時間が減らない | 手順 4 |
| `protein-asset-catalog.generated.ts` は生成物 | 手で直すと `npm run protein:catalog:check` が落ちる | 手順 5 |
| Backbone を fetch へ回すと、`isProteinAssetReady` のゲートに含め忘れる | 敵が実体化した後に当たり判定だけが未着で、**撃っても当たらない**(例外は出ない) | 手順 5 |
| creative のパネル構築から取得を外すと、パネルを開いた瞬間ではなく置く瞬間に取得が始まる形へ倒れうる | `DEVELOP/SPEC/PROTEIN.md`「出現」の「選んでから置くまでの間に取得が済む」を満たさなくなる | 手順 2 |
| `ImageBitmapLoader` は `ImageLoader` と色空間・Y 反転の扱いが違う | 天体テクスチャが上下反転したりガンマがずれる | 手順 6(`npm run dev` で地球を見る) |
| WGSL の本文が変わると Chrome の GPU ディスクキャッシュが全部外れる | 手順 3・4 を入れた配信では、全プレイヤーが 1 回だけ冷キャッシュの構築を踏む。**これは避けられない**ので、リリースをまとめる理由にはなる | 手順 3・4 |
| 測定機の GPU は Intel gen-9 の内蔵 GPU。速い GPU では全部の絶対値が縮む | 「12 秒以下」のような絶対値の達成条件を実機で当てようとすると合わない | 全手順(比で読む) |

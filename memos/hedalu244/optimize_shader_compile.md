# シェーダのコンパイル — 調査結果と改善計画

対象コミット `1d3daf8d`(作業ブランチ `optimize-load-and-runtime`)。
`optimize_loading.md` の修正案 A(「83% で固まる」の正体)を掘り下げたもの。

## 何のための文書か

`optimize_loading.md` が「体感するロードのほぼ全部は最初の1フレームのシェーダ構築」までを
突き止めたので、その先を測った結果と修正案。**スナップショットであって、コードの現状を説明する
文書ではない。実施したら消す。**

答えを出した問い:

1. シェーダの事前コンパイルは技術的に可能か。TSL のコードベースを保ったまま、コンパイル済みの
   ものを配信できないか。
2. できないなら、どのパスで何本コンパイルされ、それぞれ何秒かかっているのか。
3. 定数差のバリエーションや静的展開で、本数が無駄に増えていないか。
4. ロード表示をパスごとに動かせるか。

## 測り方と、その限界

`webpack --mode development` でビルドしたものを静的配信し、ヘッドレス Chrome を CDP で駆動する
使い捨てのプローブを書いた(`src/` は一切変更していない)。`Page.addScriptToEvaluateOnNewDocument`
で `GPUDevice.prototype` の `createShaderModule` / `createRenderPipeline(Async)` /
`createComputePipeline(Async)` を包み、**呼び出し時のスタックごと**記録する。開発ビルドを使うのは
スタックに `src/render/pipeline/*.ts` の関数名が残るため。

- **開発ビルドと本番ビルドは、生成される WGSL がバイト単位で一致した**(どちらも 120 本・
  計 800,212 バイト)。以下の数値は本番ビルドにもそのまま当てはまる。
- 計測機の GPU は **Intel gen-9 の内蔵 GPU**(`GPUAdapterInfo` で確認。ヘッドレスでも
  SwiftShader ではなく実 GPU が使われている)。Chrome 152。1280×720。`?stage=1`。
- **絶対値は「この GPU での値」。** 速い GPU では比例して短い。信じてよいのは条件間の比。
- 「固まる時間」は **rAF が来ない最長の欠落**で測っている。この間、画面は1枚も更新されない。
- 同じ条件でも **52.6 秒と 60.1 秒**のばらつきがあった。数秒の差は差と見なさない。

---

## 分かったこと

### 1. シェーダの事前コンパイルは、Web では原理的にできない

Chrome 152 の WebGPU に、コンパイル済みバイナリを渡す入口は無い。実測で確認した API 表面:

- `GPUDevice.prototype` のメソッドは `createShaderModule` / `createRenderPipeline` /
  `createRenderPipelineAsync` ほか。**パイプラインキャッシュを扱うものは1つも無い**
  (`GPUPipelineCache` に相当するグローバルも存在しない)。
- `createShaderModule` が受けるのは **WGSL のテキストだけ**。WebGL2 の
  `getProgramBinary`/`programBinary` に当たるものは WebGPU の仕様に無い。
- `adapter.features` にも `wgslLanguageFeatures` にも、キャッシュに関わる項目は無い。

**つまり「コンパイル済みシェーダを配信する」は不可能。** できるのは「WGSL のテキストを事前に
生成して配信する」まで — すなわち TSL のノードグラフ構築(JS・メインスレッド)を省くこと。

その価値は小さい。実測では、120 本のシェーダモジュールが作られたのは **t=2.6 秒 から 4.0 秒**
の 1.4 秒間で、そのあと **53〜60 秒**の固まりが来る。**ノードグラフ構築は全体の 3% 未満**で、
しかも three 側に「組み上がった `NodeBuilderState` を差し込む」公開の入口は無い
(`Nodes#getForRender` が `renderObject.getCacheKey()` で引く内部キャッシュしかない)。
**やる価値は無い。**

### 2. Chrome は自前でキャッシュしている — 固まるのは配信のたびに1回だけ

同じブラウザプロファイルで3回続けて開いた実測:

| 回 | 最大フレーム欠落 |
| --- | --- |
| 1回目(冷) | **57.5 秒** |
| 2回目 | **1.65 秒** |
| 3回目 | **1.60 秒** |

Chrome の GPU ディスクキャッシュがほぼ全部を吸収する。**キャッシュの鍵は WGSL の本文**なので、

- **バンドルを配信し直すたびに、全プレイヤーが1回だけこの固まりを踏む。**
- しかも生成される WGSL には three が振る **`NodeBuffer_<ノードid>` という自動生成名**が
  埋まっている(下の 4 を参照)。ノード id は生成順で決まるので、**描画と無関係な場所で
  ノードを1つ増やしただけで、意味の変わっていないシェーダまで全部キャッシュから外れる。**
  実際、`occlusion.ts` に数行足しただけのビルドで、影パスと G バッファの頂点シェーダ 36 本が
  「`NodeBuffer_35064` → `NodeBuffer_35142`」だけの違いで全部別物になった。

### 3. 起動の1フレーム目に組まれるのは、パイプライン 94 本 / シェーダ 120 本

`?stage=1`・素の設定(品質プリセット high が既定)。パスの内訳は、生成時のスタックから取った。

| パス | パイプライン | シェーダ(頂点/フラグメント) | WGSL |
| --- | ---: | ---: | ---: |
| `gbuffer.ts` | 22 | 22 / 5 | 97.0 KB |
| `sun-shadow-maps.ts` | 20 | 20 / 3 | 55.2 KB |
| `lens-pass.ts` | 26 | 4 / 26 | 291.8 KB |
| `render-pipeline.ts`(world・合成・mipmap) | 10 | 6 / 10 | 24.9 KB |
| `antialias-pass.ts` | 5 | 4 / 4 | 27.0 KB |
| `light-prepass.ts` | 3 | 3 / 3 | 55.3 KB |
| `material-pass.ts` | 3 | 2 / 2 | 7.0 KB |
| `overlay-pass.ts` | 3 | 1 / 1 | 2.6 KB |
| `occlusion.ts` | 1 | 1 / 1 | 105.6 KB |
| `atmosphere-pass.ts` | 1 | 1 / 1 | 115.0 KB |
| **計** | **94** | **120** | **781.5 KB** |

compute パイプラインは `?stage=1` の起動時には 0 本(タンパク質の敵が湧いた時点で作られる)。
`?stage=creative` の起動は 77 本・47.9 秒で、形は同じ(影パスが無く、その他は同じ顔ぶれ)。

**1本ずつ「初コンパイル」させ直して測った所要時間**(記録した記述子の WGSL 末尾へ一意な
コメントを足して Dawn のキャッシュを外し、`createRenderPipelineAsync` を直列に待った。
同じ WGSL のままの対照も取り、その差を「正味」とした):

| パス | 本数 | 直列合計 | 対照 | 正味 |
| --- | ---: | ---: | ---: | ---: |
| `gbuffer.ts` | 22 | 72.0 s | 8.8 s | **63.2 s** |
| `sun-shadow-maps.ts` | 20 | 68.0 s | 8.2 s | **59.8 s** |
| `atmosphere-pass.ts` | 1 | 14.4 s | 0.4 s | **14.0 s** |
| `occlusion.ts` | 1 | 12.0 s | 0.4 s | **11.6 s** |
| `lens-pass.ts` | 26 | 19.7 s | 10.0 s | **9.8 s** |
| `light-prepass.ts` | 3 | 3.4 s | 1.2 s | 2.3 s |
| `antialias-pass.ts` | 5 | 4.1 s | 2.0 s | 2.2 s |
| その他 3 パス | 16 | 7.1 s | 6.3 s | 0.8 s |

**この表は直列の合計なので、実際の固まり(53〜60 秒)より大きい** — Dawn は複数スレッドで並行に
コンパイルする。また1回あたり 0.4 秒ほどの固定費が乗っている。**順位だけを読むこと。**

読み取れること: **費用はシェーダの長さに比例しない。** レンズは 291.8 KB・26 本で正味 9.8 秒
なのに、影パスは 55.2 KB・20 本で 59.8 秒。**1本 3 KB の頂点シェーダが、1本 100 KB の
フラグメントシェーダより高い。**

### 4. 費用を決めていたのは、シェーダに焼き込まれた固定長の uniform 配列だった

影パスの頂点シェーダ 20 本のうち **18 本は、1 箇所を除いてバイト単位で同じ**だった。違うのは
three が自動で振る uniform バッファ名だけ:

```
struct NodeBuffer_35064Struct { value : array< mat4x4<f32>, 600 > }
struct NodeBuffer_35142Struct { value : array< mat4x4<f32>, 600 > }
```

G バッファでも同じ 18 本が重複していた。名前の違いを潰すと **120 本 → 86 本**、
G バッファは 27 → 10、影は 23 → 6 になる。

正体は **`InstancedPool` の `instanceMatrix`**。three の `createInstanceMatrixNode`
(`three.webgpu.js` の `createInstanceMatrixNode`)は、

- `instanceMatrix` が storage 属性なら storage バッファ、
- **そうでなく `count × 64` バイトが `maxUniformBufferBindingSize`(65536)に収まるなら
  `array<mat4x4<f32>, count>` の uniform 配列**、
- 収まらなければインスタンス頂点属性、

と分岐する。`DEBRIS_FRAGMENT_VARIANT_COUNT = 18`(`render/ships.ts`)ぶんの `InstancedPool` が
`CAP.debris = 600`(`game/dynamic/dynamic-system.ts`)で作られるので、**600 要素の uniform 配列を
持つ頂点シェーダが 18 本 × 2 パス = 36 本**でき、そのどれもが `frustumCulled = false` で
シーンに常駐しているため、**破片が1つも存在しない起動直後に全部コンパイルされる**。

弾のプール(`CAP.bullet = 1200`)は 1200 × 64 = 76,800 バイトで上限を超えるため頂点属性の経路へ
落ち、**3本のプールが1本のシェーダを共有していて費用はほぼゼロ**。皮肉なことに、**枠が大きい
プールのほうが安い。**

A/B 実測(いずれも `?stage=1`・冷キャッシュ・素の設定):

| 条件 | パイプライン | シェーダ | WGSL | 最大フレーム欠落 |
| --- | ---: | ---: | ---: | ---: |
| **素のまま**(2回) | 94 | 120 | 781.5 KB | **52.6 s / 60.1 s** |
| 本番ビルド `docs/` | 94 | 120 | 781.5 KB | 60.1 s |
| 同プロファイル2回目・3回目 | 94 | — | — | 1.65 s / 1.60 s |
| レンズ効果オフ | 68 | 90 | 488.8 KB | 49.7 s |
| メッシュの影オフ | 74 | 97 | 726.3 KB | 37.5 s |
| **破片の形 18 → 1** | 60 | 86 | 686.8 KB | **21.7 s** |
| **破片の枠 600 → 64**(本数は 18 のまま) | 94 | 120 | 781.4 KB | **22.7 s** |
| **破片の枠 600 → 1200**(= 頂点属性の経路) | 62 | 86 | 686.7 KB | **19.8 s** |
| `InstancedPool` を storage 属性へ | 95 | 123 | 788.3 KB | 25.2 s |
| 全 `InstancedPool` を頂点属性の経路へ | 62 | 86 | 686.7 KB | 22.5 s |
| 上 + 影オフ | 58 | 80 | 677.4 KB | 21.6 s |
| `?stage=creative`(素のまま) | 77 | 100 | 732.9 KB | 47.9 s |

**「枠 600 → 64」がいちばん雄弁**: パイプラインの本数は 94 本のまま1本も減っていないのに、
固まりが 52.6 → 22.7 秒になる。**コンパイル費用は配列の長さで決まっている。**

固まりの 53〜60 秒のうち、**約 31 秒(半分以上)が破片のプール 18 本ぶん**。1本あたり
およそ 1.8 秒。

### 5. それを直すと、残る山は `occlusion` と `atmosphere` の2本になる

破片を直した後の固まりは 20〜23 秒。そこからさらに影を切っても 21.6 秒で変わらない。
3 の表の正味を見ると、**`atmosphere-pass` 14.0 秒 と `occlusion` 11.6 秒**が残りを占めている。
どちらも 1 本きりだが、**それぞれ 100 KB を超える単一のフラグメントシェーダ**で、並行に
コンパイルされても片方ぶんの時間は必ず待つ。

この2本が大きいのは静的展開のため(`sun-occlusion.ts` は遮蔽器 4 × 環の帯 13 × 積雲のタップ 6 ×
PCF 12 × 影スロット 4 を JS の `for` で並べる。`atmosphere-pass.ts` は大気を持つ天体 4 体ぶん)。
**なお `ray-march.ts` は刻み数を uniform + TSL の `Loop()` にしていて、品質設定を変えても
WGSL が変わらない — この形が手本。**

### 6. そのほか、定数差でシェーダが増えている箇所

コンパイル時間への効きは小さいが、記録として。

- **`lens-pass.ts` の条(すじ)** — `STREAK_DIRECTIONS = 10` × `STREAK_PASSES = 2` の 20 本が、
  `Math.cos(angle) * distance` を JS で計算して定数として焼いているため全部別シェーダ。
  拡大段 4 本も `coarserWeight` の定数差で別物。**合わせて 26 本・291.8 KB あるが、正味 9.8 秒**
  (1本あたりは安い)。角度と重みを uniform にすれば数本へ畳めるが、**費用対効果は低い。**
- **`cumulus-shell.ts`** — `groundRadius` / `grainFrequency` / `gradientAngle` を uniform に
  通さず定数として焼いている。いま `new CumulusShell` は地球の1箇所だけなので顕在化していないが、
  **殻を持つ天体を増やすとそのぶんシェーダが増える構造**になっている。
- **`protein-motion-material.ts` の compute** — `residueCount` / `modeCount` を定数ノードと
  `Loop` の上限に焼いているので、**タンパク質アセットの種類ぶん compute シェーダができる**。
  起動時には作られず、敵が湧いた瞬間にコンパイルされる = **プレイ中のカクつきになる。**
- **`curve.ts`** — `setVertexColors()` が実行時に `vertexColors` を切り替えるので、そこで
  シェーダが組み直される。
- 天体の表面(`celestial-surface.ts` の `solid`/`textured`)は色を `material.color` に入れて
  いるので、**約 100 体が 2 本のシェーダを共有している** — 良い側。`thermal-emissive.ts` の
  グラフ memo 化、`base-station-model.ts` のモジュールスコープ共有も同じく良い側。

### 7. `compileAsync` はロード表示を止めない。ただし落とし穴が2つある

`OcclusionPass` に使い捨ての `compile()` を足し、`Game.create` の中で `await` する実験をした。

- **コンパイル中もフレームは 60 fps(中央値 17 ms)で来続けた。** 大きい1本の途中で 2.4 秒の
  スパイクが1回あっただけ。**ロード表示は普通に動く。**
- パスの入口としての `compileAsync(quad, quad.camera)` は成立する。`QuadMesh.render()` は
  `renderer.render(quad, quad.camera)` と等価で、`compileAsync` も `render()` も
  非 Scene のオブジェクトには同じ内部 `_scene` を使うので、キャッシュキーの土台は揃う。

**落とし穴 1 — 描画先は `await` が終わるまで張ったままにする。**
最初の実験では `void compileAsync(...)` と投げっぱなしにして直後に `setRenderTarget(null)` した
結果、**フラグメント出力の型が `f32` ではなく `vec4<f32>` になった別物のシェーダ**が作られた。
`NodeBuilder#getOutputType()` は `this.renderer.getRenderTarget()` を**グラフを組む時点で**読むが、
`compileAsync` はその手前で `await` するので、描画先を戻したあとに評価される。**必ず
`await` してから戻すこと。**

**落とし穴 2 — `renderer.depth` / `renderer.stencil` を描画先に合わせる。**
`await` して直しても、まだパイプラインが1本余分に作られた。記述子を突き合わせると、
`compileAsync` 側だけ `depthStencil: { format: 'depth32float', … }` が付いていた。
three の `Renderer#compileAsync` は `renderContext.depth = this.depth`(= レンダラ既定の `true`)を
使うのに対し、`_renderScene` は `renderContext.depth = renderTarget.depthBuffer` を使う。
**`depthBuffer: false` のターゲット(遮蔽・ライトプリパス・大気のスナップショットなど)では
必ず食い違う。** `renderer.depth` / `renderer.stencil` は `@types/three` でも公開の
可変プロパティなので、呼ぶ前後で描画先の値に差し替えれば済む。

なお `optimize_loading.md` に書いた「`compileAsync(scene, camera)` は 85 秒のうち 5.3 秒しか
吸えなかった」も、これで説明がつく — シーンに対する既定の描画先(キャンバス)で組んだ
パイプラインは、G バッファ(MRT 4 枚)でも影(深度のみ)でも使われない別物だった。

---

## 改善計画

**効果の大きい順。1 と 2 は独立に実施できる。**

### 1. `InstancedPool` の `instanceMatrix` を uniform 配列から外す

**固まりの半分以上(約 31 秒)がこれ。** 見た目も挙動も変えずに済む。3 つの案があり、
実測値はどれも上の表にある。

| 案 | 変更 | 実測 | 残る問題 |
| --- | --- | ---: | --- |
| a. storage 属性へ移す | `InstancedPool` の1箇所 | 25.2 s | シェーダは 18 本のまま(1本ずつは安い)。プールを足すたびに 2 本増える |
| b. 枠を 1024 超にする | `CAP.debris` を 1200 へ | 19.8 s | 「枠を大きくすると軽くなる」という非自明な結合。空枠ぶんの描画が増える |
| c. 破片の形の本数を減らす | `DEBRIS_FRAGMENT_VARIANT_COUNT` | 18→1 で 21.7 s | **見た目が変わる。ユーザー判断** |

**推奨は a。** 構造として言えることが「毎フレーム全枠を書き換えるプールの行列は、uniform では
なく storage で渡す」であり、three の内部しきい値に依存しないため。

```ts
// src/render/instanced-pool.ts — 現在 new THREE.InstancedMesh(geometry, material, capacity) の直後
this.mesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(this.capacity, 16);
this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
```

**b は採らない**(非自明な結合を残すため)。**c は a と直交する** — 18 本という数がそもそも
要るのかは見た目の話なので、別途ユーザーに問う。減らせば a の上にさらに効く(1本あたり約 1.8 秒。
実測の傾きから、18 → 4 でおよそ 25 秒ぶん)。

**達成条件**: `?stage=1` の起動でパイプラインが 94 → 62〜95 本、最大フレーム欠落が
52〜60 秒 → 25 秒以下。**検証はプローブ(後述)。**

### 2. パスごとの `compile` 入口を作り、ロード表示の段として待つ

**総時間は縮まないが、「固まって見える」が「進んで見える」に変わる。** どのパスを組んでいるかを
画面へ出すので、**重いシェーダを足したときに気づける** — これが本命の狙い。

各パスへ `compile` を足す。引数は自身の `render` と揃え、**そのパスが選びうるマテリアルを
全部**組む(遮蔽なら環あり/なしの2枚、アンチエイリアスなら現在の方式)。

```ts
// src/render/pipeline/gbuffer.ts
public async compile(scene: THREE.Scene, camera: THREE.Camera, width: number, height: number): Promise<void>;
// src/render/pipeline/sun-shadow-maps.ts
async compile(scene: THREE.Scene, camera: THREE.Camera, sun: SunLight): Promise<void>;
// src/render/pipeline/occlusion.ts
async compile(width: number, height: number): Promise<void>;
// src/render/pipeline/light-prepass.ts
async compile(width: number, height: number): Promise<void>;
// src/render/pipeline/material-pass.ts
public async compile(scene: THREE.Scene, camera: THREE.Camera, sharedTarget: THREE.RenderTarget): Promise<void>;
// src/render/pipeline/atmosphere-pass.ts
public async compile(camera: THREE.Camera, sharedTarget: THREE.RenderTarget): Promise<void>;
// src/render/pipeline/lens-pass.ts
async compile(width: number, height: number): Promise<void>;
// src/render/pipeline/overlay-pass.ts
public async compile(scene: THREE.Scene, camera: THREE.Camera, style: RenderStyle): Promise<void>;
// src/render/pipeline/antialias-pass.ts
public async compile(): Promise<void>;
```

**描画先を張っている間の作法**(全パス共通。落とし穴 1・2 のため、ヘルパへ畳むべき):

```ts
// 描画先を張ったまま compileAsync を待ち切る。renderer.depth/stencil を描画先へ合わせるのは、
// three の compileAsync が renderContext.depth をレンダラ既定から取るため(render() は
// renderTarget.depthBuffer から取る) — 揃えないと別のパイプラインが組まれる。
async function compileInto(
  renderer: WebGPURenderer, target: THREE.RenderTarget | null,
  object: THREE.Object3D, camera: THREE.Camera,
): Promise<void>;
```

まとめ役と、ロードの段:

```ts
// src/render/pipeline/render-pipeline.ts
// 1フレーム目に組まれるパイプラインを、パス単位で先に組む。onPass はいま組んでいるパスの
// 名前と進み具合を受ける。
public async compile(
  scene: THREE.Scene, camera: THREE.Camera,
  onPass: (name: string, done: number, total: number) => void,
): Promise<void>;

// src/game/loading-progress.ts
export type LoadingPhase = 'system' | 'bodies' | 'run' | 'shaders';
// 段の中の進捗と、いま何をしているかの表示。
public within(ratio: number, note?: string): void;

// src/launcher/loading-overlay.ts
// note は円形ゲージの下の行へ出す(いまは「初期化中(WebGPU)…」の固定文字列)。
export function setLoadingProgress(ratio: number, note?: string): void;
```

`Game.create` は `run` 段を組み終えたあとに `shaders` 段を挟む。**シーンが実体化した後でないと
G バッファ・影パスのマテリアルが揃わない**ので、`bodies` の後であることが必須。

```ts
await progress.enter('shaders');
await gs.pipeline.compile(gs.scene, camera, (name, done, total) => progress.within(done / total, name));
```

`LOADING_PHASE_WEIGHTS` は実測し直して振り直す(いまの重みは 1 フレーム目の費用を勘定に
入れていない)。

**残る穴**(この段では潰せないもの。文書化して受け入れる):
- 後から湧くもの(敵・タンパク質の compute・破片以外の VFX)は初出現でコンパイルされる。
- デバッグ表示・模式図・アンチエイリアス方式の切り替えも、切り替えた瞬間に組まれる。

**達成条件**: `shaders` 段の間、rAF が 100 ms 以上途切れない(実験では中央値 17 ms だった)。
かつ **1フレーム目に新しく作られるパイプラインが 0 本**。後者はプローブで数える —
`compile` と `render` のキャッシュキーが揃っていない限り 0 にはならないので、**落とし穴 2 を
踏んでいないことの検査になる。**

### 3. `occlusion` と `atmosphere` の 2 本を縮める(別途調査)

1 を実施した後の残り 20 秒は、実質この 2 本。どちらも 100 KB 超の単一フラグメントシェーダで、
静的展開が理由。**縮め方は絵に関わるので、この文書では決めない。** 候補:

- `sun-occlusion.ts` の環の帯 13 本・PCF 12 タップ・積雲 6 タップを、`ray-march.ts` と同じく
  uniform + `Loop()` へ移せるか。**動的ループのほうが実行も速い前例がある**(刻み数を
  uniform にした大気)。ただし **TSL の `Loop()` は展開されないぶん実行時のレジスタ圧が
  変わる**ので、`render-lab` と `PerfMeter` で描画時間を測ってから決める。
- 遮蔽器 4 本・影スロット 4 枚の展開は、いまも `MAX_*` 定数で固定されている。

### 4. `lens-pass` の 26 本(効果は小さい。やるとしても最後)

条の角度とパス番号、拡大段の重みを uniform に移せば 26 → 数本になる。ただし**正味 9.8 秒
(並行実行後の実測差では約 3 秒)**しかないうえ、条は「向き 1 つにつき 1 本の鎖」という
設計上の理由で分かれている(`lens-kernels.ts` のコメント)。**1〜3 を終えてから、まだ気になる
なら。**

---

## 検証のしかた

使い捨てのプローブは `C:\Users\takayuki\AppData\Local\Temp\claude\…\scratchpad\` に置いた
(セッション限定なので、必要なら書き直す)。要点だけ残す:

1. `webpack --mode development --output-path <dir>` でビルドする(スタックに `src/` の関数名が
   残る。生成される WGSL は本番ビルドと一致することを確認済み)。
2. `tools/chrome-session.mjs` の `openChromeSession` で配信 + ヘッドレス Chrome を上げる。
   **`serveDir` は `path.resolve` すること** — 前方スラッシュのまま渡すと静的サーバが 403 を返す。
3. `Page.addScriptToEvaluateOnNewDocument` で `GPUDevice.prototype` を包み、
   `Error.stackTraceLimit = 80` を立ててスタックごと記録する(既定の 10 段では `src/` まで
   届かない)。rAF の到来時刻も同時に取る。
4. 見るのは **パイプライン本数・シェーダ本数・WGSL の総バイト数・rAF の最大欠落**の4つ。
5. **プロファイルは毎回捨てる。** 使い回すと GPU ディスクキャッシュに当たって 1.6 秒になる。
   逆に、キャッシュの効き目を見たいときは使い回す。

## 未確定・要判断

- **破片の形の本数(`DEBRIS_FRAGMENT_VARIANT_COUNT = 18`)を減らすか。** 見た目が変わるので
  ユーザー判断。減らせば 1 本あたり約 1.8 秒効く。
- **`sun-occlusion.ts` の静的展開を `Loop()` へ移すか。** コンパイルは短くなるが、実行時の
  速さは測らないと分からない。
- `?stage=creative` でタンパク質の敵が湧いたときの compute シェーダのコンパイル費用は
  まだ測っていない。**プレイ中のカクつきとして出ているはず。**
- `optimize_loading.md` の C(motion アセットの精度落とし)と F(`cloud-field.png` の縮小)は
  **実施しないことに決まった**(効果に対して割に合わない)。

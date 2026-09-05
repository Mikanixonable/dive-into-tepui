# 大気パスを1天体分のシェーダにして、層はピンポンで重ねる

ブランチ `optimize-load-and-runtime`、着手時点 `99e6f94a`。**数字はすべて `9ae4115e` で測った
もので、以後 `src/render/` は変わっていない。**
**スナップショットであって、コードの現状を説明する文書ではない。全手順を実施したら消す。**

## 目的

起動時のシェーダ事前コンパイルで、**大気段が最も高い — 1 段で 118.0 KB / 6,083 ms**(内訳は
「測り方」節)。原因は、`atmosphere-pass.ts` が 1 枚のフラグメントシェーダへ天体スロット
`MAX_ATMOSPHERE_BODIES = 4` 体ぶんを JS の `for` で並べていること。**実際にはインゲームの
ほとんどの構図で大気は高々 1 体しか見えない**ので、4 体ぶんの本文は毎回コンパイルされて
毎回ほとんど使われない。

**この計画は、シェーダを 1 天体分だけにして、複数天体のときだけ描画を増やす。** 層の合成は
`下地 × 透過率 + 内部散乱` で、奥の層の出力がそのまま手前の層の下地になる — つまり
**奥から順に重ねるだけの鎖**であり、1 本のシェーダへ畳み込む必要はない。大気パスは既に
「不透明の絵の控えを撮ってから、その控えを読んで共有ターゲットへ上書きする」というピンポンを
1 回ぶん持っているので、**その 1 回を層の数だけ回す**形になる。

**動的ループ(`Loop()` + スロットごとの uniform 配列)へ畳む案は採らない。** 理由は3つ。

- **実行時のレジスタ圧を変える。** ロードを直してプレイを悪くしうる。
- **uniform 配列の長さがシェーダ本文へ焼かれる**ので、畳んだのにコンパイル時間が減らない形へ
  倒れうる(このブランチで一度踏んだ)。
- **1 体しか見えない構図でも 4 体ぶんのループが走る。** 描画を分ければ、そのフレームに
  見えない天体は描画命令ごと落ちる。

同じ「モノリシックなシェーダを避けて分けて描く」方針は、遮蔽パスを遮蔽源ごとの
フルスクリーン 1 枚へ分けた `51f9a301` で既に採っている(105.6 KB の 1 本を源ごとに分割。
render-lab 全 38 ケース中 35 ケースが分割前とバイト一致、残る3ケースも最大 1 LSB)。
**この計画はその形を、積ではなく「下地 × 透過率 + 内部散乱」の鎖へ広げるもの。**

## 決めたこと

1. **シェーダは 1 天体分だけ持ち、層は奥から順に描き重ねる。** ピンポンの控えは 1 枚で足り、
   **層 1 つにつき「共有ターゲット → 控え」のコピー 1 回と、板 1 枚の描画 1 回**を回す。
   大気が 1 体のときの描画命令は現状と同じ(コピー 1 + 描画 1)。
2. **控えの板とターゲットは大気パスが持つ。** いまは `render-pipeline.ts` が持っていて
   大気パスへテクスチャだけ渡しているが、**回数がパスの中の層数で決まる**ようになるので、
   持ち主をパスへ移す。
3. **描画デバッグ表示の「マテリアル」と「大気」は、いま `DEVELOP/SPEC/RENDERING.md` が書いて
   いるものを映したまま保つ。**「マテリアル」はマテリアルパスの出力そのもの、「大気」は大気パスが
   重ねる内部散乱だけ。**「大気」は、下地を黒にして同じ鎖を回した結果**として作る — 内部散乱
   だけを解く2本目のノード(`scatteredLight()`)は消える。**重いノードグラフは 1 つだけになる。**
4. **`MAX_ATMOSPHERE_BODIES` は 4 のまま。** シェーダ本文からは消えるが、描画命令の上限として
   残す。上限を上げるのは絵の変更なので、この計画では扱わない。
5. **層ごとに視錐台で間引く。** いまは「1 体でも写るなら 4 体ぶん全部走る」なので、
   写らない層を描画命令ごと落とせるようになる。判定はいまと同じ「裾球が視錐台に掛かるか」。

**覆されたときに変わる手順**: 3 を覆す(デバッグ表示の意味を変えてよい)なら、手順 2 から
控え 1 枚(`debugTarget`)と `renderScattered` が丸ごと落ち、`scatteredLight()` は
1 層ぶんを返すだけの形になる。**そのときは `DEVELOP/SPEC/RENDERING.md` の
「デバッグ表示」節を先に書き換えること。** 5 を覆すなら、手順 2 の間引きを落として
「1 体でも写れば全層描く」に留める(絵は変わらない)。

`memos/hedalu244/optimize_loading2.md` の手順3(大気の静的展開を `Loop()` へ畳む)は、
この計画を採るなら要らなくなる。**その差し替えは指示があったときだけ行う。**

---

## 測り方(この計画の数字の出どころ)

数字はすべて **コミット `9ae4115e`・`?stage=1`・品質プリセット high・1280×720・
Intel gen-9 内蔵 GPU の Chrome** で測ったもの。**絶対値は実機の値ではない。信じてよいのは
条件間の比だけ。**

- **シェーダの本数・本文長・コンパイル所要**: `webpack --mode development` の出力を静的配信し、
  ヘッドレス Chrome を CDP で駆動する使い捨てのプローブで測る。
  `Page.addScriptToEvaluateOnNewDocument` で `GPUDevice.prototype` の `createShaderModule` /
  `createRenderPipeline(Async)` を包み、WGSL の文字数と呼び出し時刻を記録する。段の区分は、
  ローディング表示の注記(`シェーダを準備中: <パス名>`)を 8 ms 間隔で読んで付ける。
  **プロファイルは毎回捨てる** — 使い回すと Chrome の GPU ディスクキャッシュに当たる
  (WGSL 本文が鍵なので、本文を変えた側は必ず冷キャッシュで測ることになる)。
  **`NODE_OPTIONS=--max-old-space-size=8192` を付けないとビルドが OOM する。**
- **現状値**: 大気段 = パイプライン 2 本 / シェーダ 4 本 / **WGSL 118.0 KB** /
  **6,083 ms**。2 本の内訳は「控えへのコピー板」と「大気の合成板」で、**118.0 KB のほぼ全部が
  後者**(比較: 合成段は同じ全画面 1 枚で 5.6 KB)。ロード表示中の全段合計は 21.0 秒。
- **大気パスの GPU 時間**: `webpack --config webpack.render-lab.config.js --mode production` の
  あと `node tools/render-lab-measure.mjs 2`。earth / earth-mars / earth-mars d=-2 / far ×
  大気の段 4 通りで、パス別 GPU 時間の「大気」行を巡ごとの平均と中央値で出す。
- **絵**: `npm run render-lab:shot`(`.render-lab/shots/*.png` に全ケース)。

---

## 達成目標

全手順の実施後、次を満たす。

1. **大気段の WGSL が 40 KB 以下**(現状 118.0 KB)。
2. **大気段の事前コンパイルが 2.5 秒以下**(現状 6,083 ms)。
3. **`atmosphere-pass.ts` に、天体スロットを複数並べる JS のループが 1 つも無い。**
   `grep -n "MAX_ATMOSPHERE_BODIES" src/render/pipeline/atmosphere-pass.ts` が
   「描画命令の上限」としての 1 箇所だけになる。
4. **絵が変わらない。** `npm run render-lab:shot` を変更前後で撮り、**大気が 1 体しか写らない
   ケース(`earth` `earth-oblique` `earth-polar` `earth-polar-terminator` `earth-terminator`
   `earth-eclipse`)はバイト一致**。大気が 2 体写る `earth-mars` だけは f16 の中間丸めのぶん
   動いてよいが、**±4 LSB 以内**(撮り直しの揺れがこの幅なので、差を根拠にする前に撮り直す)。
5. **大気パスの GPU 時間が悪化していない。** `node tools/render-lab-measure.mjs 2` の中央値で、
   `earth` / `far` は変更前以下、`earth-mars` / `earth-mars d=-2` は **+0.5 ms 以内**
   (層が 2 つのときだけ全画面コピーが 1 回増えるため)。
6. **描画デバッグ表示の「マテリアル」と「大気」が、SPEC どおりのものを映す。**
   `npm run render-lab` で `earth-mars`(大気 2 体)を出し、それぞれを選んで確かめる。
7. `npm run typecheck` と `npm run test:render` が通る。

---

## 手順

### 手順 1. 下地の控えを大気パスへ移す

**目的**: いま `render-pipeline.ts` が持っている「不透明の絵の控え」を、それを読む大気パス自身へ
移す。手順 2 で控えを撮る回数が層の数で決まるようになるので、**回数を知っている側が持ち主で
なければならない。** **この時点でシェーダも絵も変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/pipeline/render-pipeline.ts:124-130` | `backdropTarget` の生成と `AtmospherePass` の生成を入れ替える。**共有ターゲット `this.target`(`:132-140`)の生成を、`AtmospherePass` の生成より前へ動かす** — パスがコンストラクタで共有ターゲットを受け取るため |
| `src/render/pipeline/render-pipeline.ts:142-146` | `backdropMaterial` / `backdropQuad` を削除する |
| `src/render/pipeline/render-pipeline.ts:51-53` | `backdropTarget` / `backdropMaterial` / `backdropQuad` のフィールドを削除する |
| `src/render/pipeline/render-pipeline.ts:204-206` | デバッグ表示「マテリアル」の材質が読むテクスチャを `this.atmospherePass.backdropTexture` へ替える |
| `src/render/pipeline/render-pipeline.ts:331-337` | 事前コンパイルの「大気」段から、控えのサイズ合わせと `compileInto` を削る(パスの `compile` の中へ移る) |
| `src/render/pipeline/render-pipeline.ts:398-411` | 控えのサイズ合わせ・`beginPass`・ブリットを削り、`this.atmospherePass.render(camera)` の1行にする。「マテリアル」表示のための控え撮りは `captureBackdrop()` の呼び出しへ |
| `src/render/pipeline/render-pipeline.ts:465-467` | `backdropTarget` / `backdropMaterial` の解放を削る |
| `src/render/pipeline/atmosphere-pass.ts:104-176` | コンストラクタの引数 `backdrop: THREE.Texture` を `sharedTarget: THREE.RenderTarget` へ替え、控えのターゲットとコピー板をパスの中で作る。合成板が読む下地は自前の控え |
| `src/render/pipeline/atmosphere-pass.ts:442-462` | `render` / `compile` から `sharedTarget` 引数を落とし(コンストラクタで受けたものを使う)、控えのサイズ合わせ・コピー・`beginPass` をパスの中で行う |
| `src/render/pipeline/atmosphere-pass.ts:464-468` | `dispose` で控えのターゲットとコピー板を解放する |

新しい公開面(この手順の時点):

```ts
// src/render/pipeline/atmosphere-pass.ts
export class AtmospherePass {
  public constructor(
    renderer: WebGPURenderer,
    gbuffer: GBufferPass,
    sharedTarget: THREE.RenderTarget,
    sunLight: SunLight,
    sunOcclusion: SunOcclusion,
    gpu: GpuTimings,
  );
  // 大気が重なる直前の下地。デバッグ表示「マテリアル」だけが読む。
  public get backdropTexture(): THREE.Texture;
  // マテリアルパスの出力を控えへ撮る。大気が写らないフレームでもデバッグ表示のために撮る。
  public captureBackdrop(): void;
  public render(camera: THREE.Camera): void;
  public compile(camera: THREE.Camera): Promise<void>;
}
```

`render` は自身で `anyBodyInView` を見て、写らないフレームは何も描かずに戻る(呼び出し側の
`if` が消える)。`anyBodyInView` は `private` へ落とす。

**達成条件と検証**

- `npm run typecheck` が通る。`npm run test:render` が通る。
- `grep -n "backdropTarget\|backdropMaterial\|backdropQuad" src/render/pipeline/render-pipeline.ts`
  が **0 件**(残るのは `atmospherePass.backdropTexture` を読む1行だけ)。
- プローブで、**大気段のパイプライン 2 本 / WGSL 118.0 KB が変わらない**(移しただけなので
  シェーダは同一のはず)。
- `npm run render-lab:shot` の絵が**全ケースでバイト一致**。
  **撮影は `memos/mikanixonable/protein-motion-baseline.json`(追跡ファイル)を書き換えるので、
  比較が済んだら戻すこと。**
- `npm run dev` で描画デバッグ表示「マテリアル」を選び、マテリアルパスの出力が映ること。

### 手順 2. スロットを1つにして、層ごとに1回描く

**目的**: 大気の合成板が持つ天体スロットを 1 つにして、**複数の大気は描画を複数回に分ける。**
これが本命の変更で、シェーダ本文が 1/4 前後になる。

**合成の順序**: 大気が足す色は、視点に近い順の層 0..N−1 について

```
result = Σ_i ( inscatter_i · Π_{j<i} T_j ) + backdrop · Π_i T_i
```

で、これは `c_{k+1} = inscatter_k + T_k · c_k` を **奥の層から**回した結果に等しい。
つまり **`atmosphereDraws` が返す「視点に近い順」を逆順にたどり**、各層で
「共有ターゲット → 控えへコピー」「控えを読んで共有ターゲットへ上書き」を1回ずつ行う。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/pipeline/atmosphere-pass.ts:107` | `slots: readonly BodySlot[]` を `slot: BodySlot` 1 つにする |
| `src/render/pipeline/atmosphere-pass.ts:183-201` | `accumulateLayers` を削除する。合成板の色は「1 層ぶんの区間判定 → 積分 → 下地との合成」だけになる |
| `src/render/pipeline/atmosphere-pass.ts:111` / `:161-167` / `:396` | 内部散乱だけを返すノード `scattered` と `scatteredLight()` を削除する。**重いノードグラフは合成板の 1 つだけ**になる |
| `src/render/pipeline/atmosphere-pass.ts:400-427` | `setDraws` は uniform を書かず、**このフレームの層とその裾球を溜めるだけ**にする。uniform を書くのは描く直前(`render`) |
| `src/render/pipeline/atmosphere-pass.ts:429-440` | `anyBodyInView` を「層 1 つが写るか」の判定へ分解する。視錐台の組み立ては `render` で1回 |
| `src/render/pipeline/atmosphere-pass.ts:442-455` | `render` を層のループにする。**逆順(奥→手前)**、**層ごとに `gpu.beginPass(GPU_PASS.atmosphere)`**、**`autoClear = false` を層ごとの描画すべてに掛ける** |
| `src/render/pipeline/atmosphere-pass.ts`(追加) | デバッグ表示用の控え 1 枚(既定 1×1、選ばれたときだけ画面寸法へ)と、そこから読むコピー板。`renderScattered` が黒い下地から同じ鎖を回して書く。**手順 1 の `backdropTexture` はこの控えを指す `debugTexture` へ改名する** — 2 つの表示が同じ 1 枚を共有するので、下地専用の名前ではなくなる |
| `src/render/pipeline/render-pipeline.ts:204-209` | 「マテリアル」と「大気」の材質を、どちらも `atmospherePass.debugTexture` を読む**同じ 1 枚**にする。`dispose`(`:474`)は `new Set(Object.values(...))` を回す形へ |
| `src/render/pipeline/render-pipeline.ts:398-411` | 「大気」表示のときだけ `renderScattered(camera)` を、「マテリアル」表示のときだけ `captureBackdrop()` を呼ぶ |
| `src/render/atmosphere.ts:26` | `MAX_ATMOSPHERE_BODIES` のコメントを「描画命令の上限」の意味へ直す。**値は 4 のまま** |
| `src/render/pipeline/atmosphere-pass.ts:1-8` | 冒頭のコメントを、層をどう重ねるかの記述へ直す |

この手順のあとの公開面:

```ts
export class AtmospherePass {
  // このフレームに大気を描く天体を、視点に近い順に受け取る。描く順はこの逆。
  public setDraws(draws: readonly AtmosphereDraw[]): void;
  // 視錐台に掛かる層だけを、奥から順に共有ターゲットへ重ねる。
  public render(camera: THREE.Camera): void;
  // デバッグ表示が読む 1 枚。「マテリアル」なら下地、「大気」なら内部散乱だけ。
  public get debugTexture(): THREE.Texture;
  // 下地(= マテリアルパスの出力)を debugTexture へ撮る。render より前に呼ぶ。
  public captureBackdrop(): void;
  // 黒い下地から同じ層の鎖を回し、内部散乱だけを debugTexture へ書く。render より後に呼ぶ。
  public renderScattered(camera: THREE.Camera): void;
  public compile(camera: THREE.Camera): Promise<void>;
  public dispose(): void;
}
```

`renderScattered` の1層目は控えを黒でクリアしてから読む。**クリア色はレンダラの共有状態
なので、`occlusion.ts` / `light-prepass.ts` と同じく退避して戻すこと。**

**達成条件と検証**

- `npm run typecheck` が通る。`npm run test:render` が通る。
- `grep -n "MAX_ATMOSPHERE_BODIES" src/render/pipeline/atmosphere-pass.ts` が、
  **描画命令の上限を掛ける 1 箇所だけ**になる。
- `grep -n "scatteredLight" src/` が **0 件**。
- プローブで **大気段の WGSL が 40 KB 以下**、**事前コンパイルが 2.5 秒以下**。
- `npm run render-lab:shot` の絵が、**`earth` `earth-oblique` `earth-polar`
  `earth-polar-terminator` `earth-terminator` `earth-eclipse` でバイト一致**、
  **`earth-mars` は ±4 LSB 以内**(超えたら撮り直してから判断する)。
  撮影後は `memos/mikanixonable/protein-motion-baseline.json` を戻す。
- `node tools/render-lab-measure.mjs 2` の「大気」行の中央値が、`earth` / `far` で変更前以下、
  `earth-mars` / `earth-mars d=-2` で **+0.5 ms 以内**。
- `npm run render-lab` で `earth-mars` を出し、デバッグ表示を「マテリアル」→ 地球と火星の
  陰影だけ(大気の霞みが乗っていない)、「大気」→ 2 つの大気の内部散乱だけ(下地の地表が
  透けていない)であることを目で確かめる。
- `npm run dev` で地球の低軌道から地平線を見て、大気の見えが変わっていないこと。

---

## 見積り

| 何 | どれだけ動くか | 導出 |
| --- | --- | --- |
| 大気段の WGSL | 118.0 KB → **32〜38 KB** | 段の 2 本のうちコピー板は数 KB(合成段の全画面 1 枚が 5.6 KB)。合成板 ≈ 114 KB が「共通部 P + スロット 4 体ぶん 4S」なので、P を 5 KB 程度と見て S ≈ 27 KB。1 スロットで P + S ≈ 32 KB、コピー板を足して 35 KB 前後 |
| 大気段のコンパイル | 6,083 ms → **1.8〜2.5 秒** | 本文長に対して線形と置いた下限が 6,083 × 35/118 = 1,804 ms。**コンパイル費用は本文長に厳密には比例しない**(レジスタ割り当てとインライン展開が超線形に効く)ので、線形外挿は下限として読む。2.5 秒を切らなければ実測で目標を置き直す |
| ロード表示中の全段合計 | 21.0 秒 → **17 秒前後** | 21.0 − (6.083 − 2.0) = 16.9 秒 |
| 大気 1 体のフレームの GPU | 変わらない〜わずかに速い | 描画命令は現状と同数(コピー 1 + 描画 1)。使われないスロット 3 つぶんの区間判定と分岐が本文から消えるぶん、命令数は減る |
| 大気 2 体のフレームの GPU | **+0.3〜0.6 ms** | 全画面コピーが 1 回増える。1280×720 の RGBA16F は 1 枚 7.4 MB で、読み書きで 14.7 MB。内蔵 GPU の実効帯域を 30〜50 GB/s と見て 0.3〜0.5 ms。レイマーチの総量は変わらない |
| メモリ | 通常のプレイで変わらない | ピンポンの控えは現状と同じ 1 枚。デバッグ表示用の控えは選ばれるまで 1×1 |

---

## リスクと落とし穴

| リスク | 影響 | それが露見する場所 |
| --- | --- | --- |
| 層を **手前から**重ねてしまう(`atmosphereDraws` は視点に近い順に返すので、素直に回すと逆) | 手前の層の透過率が奥の層の内部散乱へ掛からず、遠くの大気が濃く出る。**大気が 1 体のときは正しいまま**なので、ほとんどの構図で気付けない | 手順 2 / `earth-mars` の撮影 |
| 層ごとの描画で `autoClear` を戻し忘れる | 共有ターゲットの深度(マテリアルパスが書いたもの)が消え、後段の world パスで**自艦の手前の透明物(噴射炎・オービットライン)が上書きされる** | 手順 2 / `npm run dev` で噴射中の自艦、render-lab の `order` |
| `renderScattered` の黒クリアでレンダラのクリア色を戻し忘れる | 他のパスの背景が黒に化ける。**「大気」デバッグ表示を一度選んだ後だけ**起きるので、通常のプレイでは出ない | 手順 2 |
| デバッグ表示「マテリアル」「大気」が SPEC の記述から外れる(1 層目の控えを使い回す、内部散乱を 1 層ぶんしか映さない、など) | 大気 2 体の構図でだけ違うものが映る。無言で SPEC 違反 | 手順 2 / render-lab の `earth-mars` × デバッグ表示 |
| ピンポンの各段で f16 へ丸められる(控えも共有ターゲットも `HalfFloatType`)。いまは 4 層ぶんが 1 本のシェーダの f32 レジスタで積まれている | 層が 2 つ以上のケースの絵が動く。`51f9a301` の同型の分割では最大 1 LSB だった | 手順 2 / `earth-mars` の撮影 |
| `setDraws` が uniform を書かなくなるので、**`compile()` は 1 度も `setDraws` を通らない状態で走る** | `steps` の初期値が 0 だと積分の段幅が 0 除算になる。初期値 1 を保つこと | 手順 2 / 起動時の事前コンパイル |
| 共有ターゲット `this.target` の生成をコンストラクタで動かし忘れる | `AtmospherePass` が `undefined.texture` を読み、起動時に例外か真っ黒な画面 | 手順 1 |
| 層ごとに `gpu.beginPass(GPU_PASS.atmosphere)` を申告し忘れる | 2 層目以降の GPU 時間が別のパスへ計上されるか落ちる。**達成目標 5 の判断を誤る** | 手順 2 / `render-lab-measure.mjs` |
| 視錐台での間引きは「裾球が視錐台に掛かるか」で、遠平面より奥の層も落とす | いまの `anyBodyInView` と同じ判定なので新しい危険ではないが、**層ごとに効くので落ち方が細かくなる**。遠平面のすぐ外にある大気が消える構図があれば、そこで初めて見える | 手順 2 / `far` と `earth-mars d=-2` の撮影 |
| `npm run render-lab:shot` は `memos/mikanixonable/protein-motion-baseline.json`(追跡ファイル)を書き換える | 関係ない差分が commit へ混ざる | 手順 1・2 |
| render-lab の撮影は決定的でない。半影を持つケースは撮り直しで ±4 LSB 揺れる | 揺れを変更の影響と読み違える | 手順 1・2(差を根拠にする前に撮り直す) |
| WGSL の本文が変わると Chrome の GPU ディスクキャッシュが全部外れる | 配信し直した後、全プレイヤーが 1 回だけ冷キャッシュの構築を踏む。**避けられない**ので、リリースをまとめる理由にはなる | 手順 2 |
| 測定機の GPU は Intel gen-9 の内蔵 GPU | 「2.5 秒以下」のような絶対値の達成条件を実機で当てようとすると合わない | 全手順(比で読む) |

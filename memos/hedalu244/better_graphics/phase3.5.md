# Phase 3.5 — 描画テスト環境

## 目的

**描画の正しさを確かめる場が無い。**

- ヘッドレスのスモーク(`npm run smoke:browser`)は実行時例外とエンティティ数しか見ない。絵は見ない。
- 実機での目視は、z-fighting のように「出るときは出るが再現手順が定まらない」欠陥に弱い。
  ヘッドレスでのカメラ操作も安定せず、遠距離の見た目には到達できていない。
- **画素一致の画像回帰は基準として使えない。** いま基準画を撮ると、いま入っているものごと固定してしまう。
  実際にこのパイプラインでは「星殻が不透明物を上書きする」「本番ビルドだけ陰影が消える」
  「圧縮した天体が近距離の艦を誤って遮蔽する」が起きており、どれも撮った時点では
  「そういう絵」として基準に焼き付いたはずのものである。

そこで **基準を過去の自分ではなく、同じ入力に対する別経路の描画に取る。**
ライトプリパス(5 パス)とフォワード描画を並べ、**差分そのものを画像として出す。**

**出力は人間の目視とエージェントの読み取りの両方に使う。**

- **目視**: `npm run render-lab` で開発サーバが立ち、ブラウザで 2 枚を並べて見る。
- **撮影**: `npm run render-lab:shot` でヘッドレス Chrome が全ケースを回り、
  `.render-lab/shots/*.png` を書く。エージェントはこの PNG を直接読む。

Phase 4(深度からの位置復元とパスの疎結合化)はこの環境の上で測る。

### この環境がやらないこと

- **画素一致の判定をしない。** 撮った PNG は人間とエージェントが見るためのものであって、
  期待値として突き合わせる基準ではない(`DEVELOP/CODING-RULE.md` 4.1)。
- **カメラ操作を持たない。** ケースは固定。操作で到達する状態は実機で見る。
- **ゲーム状態・HUD・DOM を持ち込まない。** 持ち込むのは球・自機メッシュ・線と、その深度のオーダーだけ。

---

## 決めたこと

### (1) フォワード側も同じ `RenderPipeline` を通す

別に前方描画のコードを書かない。`RenderPipeline` の 5 パスは、対象が `LIT_OPAQUE_LAYER` に
載っているかどうかだけで振り分けるので、**同じパイプラインへ入れ方を変えて流すだけで
2 経路になる。**

- **ライトプリパス経路**: 艦のメッシュを `markLitOpaque()` で `LIT_OPAQUE_LAYER` へ置く
  (ゲーム本体と同じ)。G バッファ → ライティング → マテリアルパスが描く。
- **フォワード経路**: 同じメッシュをチャンネル 0 のまま置き、シーンへ `DirectionalLight` と
  `AmbientLight` をチャンネル 0 で足す。G バッファ・ライティング・マテリアルの 3 パスは
  対象ゼロで空回りし、**world パスが three 標準の前方描画で同じ艦を描く。**

**2 経路の違いは「メッシュとライトがどのチャンネルに居るか」だけになる。**
HDR ターゲット・露出係数・合成パス・色空間変換はどちらも同一のコードを通るので、
**画面に出る差はシェーディング経路の差そのもの**である。フォワード側の露出を別に合わせる必要も、
LDR クリップの違いを補正する必要も無い。

**代償**: フォワード側でも空のパスが 3 段走る。比較の厳密さと引き換えに払う。

### (2) 撮影は WebGPU の提示経路を通さない

`DEVELOP/SPEC/RENDERING.md` が書くとおり、ヘッドレスでの `Page.captureScreenshot` は
GPU の起動オプション依存で不安定である。**この環境はその経路を使わない。**

`renderer.setOutputRenderTarget(captureTarget)` を張ると、`RenderPipeline` が
`setRenderTarget(null)` で「キャンバスへ」と書いた合成パスの出力先がそのターゲットへ差し替わる。
`Renderer.isOutputTarget` は `_renderTarget === null` で真のままなので、
**トーンマッピングと sRGB 変換もキャンバスと完全に同じに掛かる。**
そこから `readRenderTargetPixelsAsync()` で画素を読み、2D canvas の `ImageData` へ入れて
`toDataURL('image/png')` する。**WebGPU キャンバスの提示・合成・スクリーンショットを一切経由しない。**
`RenderPipeline` への変更も要らない。

### (3) 描画は 960×540 に固定する

撮影した PNG の大きさを決め打ちにするため。**深度プローブ(手順 10)の判定は無次元の比なので、
解像度に依らない。**

---

## 達成目標

1. `npm run render-lab` で http://localhost:8082 が開き、**2 枚の canvas が並ぶ。**
2. `npm run render-lab:shot` が `.render-lab/shots/` へ **7 ケース × 3 枚 = 21 枚の PNG** を書き、
   **`Page.captureScreenshot` を一度も呼んでいない。**
3. **`leo` ケースの `diff` で、艦の輪郭とハイライト以外がほぼ黒。** 残る差がライトプリパスの
   鏡面近似(照度バッファに材質の F0 を畳めない)の誤差そのものであり、
   **この環境の最初の測定結果になる。**
4. **`order` ケースで、5 本の線が `reference` → `predicted` の順に手前へ重なる。**
5. **`depth-1e4` で、ε=1e-3 が澄み、ε=1e-4 以下が斑になる**(手順 10 の導出表と一致する)。
6. `far` ケースで、3.8e8 m と 4.5e12 m の球が両方とも画面に出る。
7. **`src/` の描画結果はこのフェーズで変わらない。**
8. **クラス `GraphicsSettings` を参照するのが設定の供給側 4 ファイルだけになる**
   (`graphics-settings.ts` の定義・`main.ts`・`hud/settings-view.ts`・`hud/graphics-panel.ts`)。
9. `npm run typecheck` と `npm run smoke:browser` が通る。

---

## 手順

### 手順 5. テストシーンの組み立てを書く

**目的**: 何を描くかを、レンダラーから切り離した純粋な関数の表にする。
**ケースを増やすのが表への追記だけで済む形**にしておく — Phase 4 が 2 つ足す。

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `tools/render-lab/cases.ts`(新規) | 球・艦・線を置く共通の下請けと、下の表の 7 ケース。各ケースは「`THREE.Object3D` の列」と「カメラの位置・注視点・near・far」を返す純粋な関数。**シーンへ足すのもチャンネルを振るのも呼び出し側の仕事** |

置くもの:

| # | 名前 | 中身 | 何を見るか |
|---|---|---|---|
| 1 | `leo` | 自機メッシュを 10 m 先に、半径 6.371e6 m の球をカメラから 6.791e6 m(高度 420 km 相当)に、球の中心を通る円軌道の線を 1 本。near=2 / far=6e7 | 艦の陰影が 2 経路で一致するか。線が艦と球に正しく隠れるか |
| 2 | `order` | 深度 1e4 m にほぼ同心の線を 5 本、`LINE_RENDER_ORDER` の 0〜4 を与えて重ねる。背後にカメラ追従の背景板(`renderOrder = -10` / `depthTest: false`) | **描画順が反転していないか** |
| 3 | `depth-1e4` | 半径 1e3 m の球 2 個を距離 1e4 m に置き、視線方向に δ = 1e4·ε だけずらす。ε は 1e-3 / 1e-4 / 1e-5 / 1e-6 / 1e-7 の 5 組を横に並べる。色は前後で変える | **深度分解能 = 位置復元の精度** |
| 4 | `depth-1e6` | 同上、距離 1e6 m・半径 1e5 m | 同上 |
| 5 | `depth-1e8` | 同上、距離 1e8 m・半径 1e7 m。far=1e13 | 同上 |
| 6 | `depth-1e11` | 同上、距離 1e11 m・半径 1e10 m。far=1e13 | 同上 |
| 7 | `far` | 半径 1.737e6 m の球を 3.8e8 m(月)に、半径 2.46e7 m の球を 4.5e12 m(海王星)に。far=1e13 | far の外に落ちないか。遠方の球が潰れたり消えたりしないか |

球はすべて `CelestialSurface.solid()`、線は `Curve`、艦は `buildPlayerShip()` —
**ゲーム本体が使っているものと同一。テスト専用に別途作ったメッシュは使わない。**
測りたいのは、そのマテリアルとそのジオメトリの挙動である。

**深度プローブの球は、距離 z に対して半径 z/10 を置く。** 見かけの大きさをケース間で揃えるため。

**達成条件と検証**

- ケース関数がシーンにもレンダラにも依存していない(引数にも戻り値にも出てこない)。
- `npm run typecheck`
- `grep -n "Scene\|Renderer" tools/render-lab/cases.ts` → 0 件

---

### 手順 6. 2 経路を並べる

**目的**: 同じケースをライトプリパスとフォワードで同時に描き、**目視で見比べられる状態**にする。

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `tools/render-lab/lab.ts`(新規) | canvas 2 枚それぞれに `WebGPURenderer` と `RenderPipeline`(設定は `QUALITY_PRESETS.high` をそのまま渡す — localStorage を読まない)を作り、ケースの物体を 2 つのシーンへ入れる。**違いは 2 点だけ** — 左は艦へ `markLitOpaque()`、ライトを `LIT_OPAQUE_LAYER` にも属させ、`pipeline.sunLight.set(dir, SUN_COLOR, SUN_INTENSITY, AMBIENT_INTENSITY, 1)` を毎フレーム書く。右は `markLitOpaque()` を打ち消してチャンネル 0 へ戻し、ライトもチャンネル 0 のまま |
| `tools/render-lab/main.ts` | ケース切替のボタン列。押されたら両方のシーンを組み直す |

**`NodeMaterial.setupLighting` はカメラのチャンネルと重なる光源が 1 つも無いと
`setupLightingModel()` を呼ばず、受け手が一斉に真っ黒になる。** 左のライトを
`LIT_OPAQUE_LAYER` にも属させるのはそのため。

**達成条件と検証**

- 2 枚の canvas が並び、ボタンで 7 ケースを切り替えられる。
- `leo` で左右とも艦・球・線が出ている。
- `order` で 5 本の線が `reference` → `predicted` の順に手前へ重なる。
- `npm run typecheck`
- `npm run render-lab` → 7 ケースすべてを順に開き、左右とも黒画面でないこと
- `order` を開き、手前の線ほど `predicted` に近い色であること
- ブラウザのコンソールにエラーが出ていないこと(**`init()` の失敗を握り潰さずページへ文字で出す**)

---

### 手順 7. 画素の読み出しと差分画像

**目的**: 目で見た同じ絵を、**提示経路を通さずに PNG として取り出せる**ようにする。
差分画像は、エージェントが最初に読む 1 枚になる。

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `tools/render-lab/lab.ts` | 「ケース名を渡すと 3 枚の PNG の data URL を返す」非同期関数。経路ごとに ①`renderer.setOutputRenderTarget(captureTarget)` ②`pipeline.render(scene, camera)` ③`setOutputRenderTarget(null)` ④`await renderer.readRenderTargetPixelsAsync(captureTarget, 0, 0, 960, 540)` ⑤`ImageData` → 2D canvas → `toDataURL('image/png')`。差分は 2 つの撮影ターゲットを読む `QuadMesh` を 3 枚目のターゲットへ描いて同じ手順 |
| `tools/render-lab/main.ts` | その関数を `window` の 1 つのプロパティへ据える |

**撮影ターゲットは `RGBAFormat` + `UnsignedByteType`、`colorSpace` は既定のまま。**
合成パスが既に sRGB へ変換した値を書くので、ターゲット側を sRGB フォーマットにすると二重変換になる。

差分の増幅率は **8 固定**(1/255 の丸め差が見えず、実質的な差は見える倍率)。

**達成条件と検証**

- ブラウザのコンソールからその関数を呼ぶと 3 枚の data URL が返る。
- `leo` の `diff` が、艦の輪郭とハイライト以外ほぼ黒。
- `npm run typecheck`
- `npm run render-lab` → コンソールでその関数を呼び、返った data URL を新しいタブで開く
- **上下が反転していないこと**(艦は前後非対称なので `leo` で分かる)
- `diff` を目で見て、球の部分が光っていないこと(球は 2 経路で同じになるのが正しい)

---

### 手順 8. Chrome の起動・配信・CDP を共通化する

**目的**: 手順 9 で 3 つ目の写しを作らないため。`tools/browser-smoke.mjs` と
`tools/perf-probe.mjs` に、Chrome の探索・`--headless=new` 一式での起動・静的配信・
CDP クライアント・セッション生成が**同じものとして 2 つある**(約 180 行)。

**このステップは切り離せる。** 見送るなら手順 9 で 3 つ目の写しを作ることになり、
その費用は「同じ約 180 行が 3 箇所」— `DEVELOP/CODING-RULE.md` 1.2 の重複禁止に正面から反する。

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `tools/chrome-session.mjs`(新規) | 上の共通部分を移す。**振る舞いは変えない** |
| `tools/browser-smoke.mjs` | 共通部分を削り、`chrome-session.mjs` から読む |
| `tools/perf-probe.mjs` | 同上 |

**達成条件と検証**

- `browser-smoke.mjs` と `perf-probe.mjs` に Chrome 起動・静的配信・CDP のコードが残っていない。
- `npm run smoke:browser` が通る(**これが唯一の合否判定** — `npm run ci` の最後にいる)
- `PERF_ONLY=map node tools/perf-probe.mjs` が結果を出す
- `grep -n "headless=new\|createServer\|remote-debugging-port" tools/browser-smoke.mjs tools/perf-probe.mjs` → 0 件

---

### 手順 9. 撮影の駆動を書く

**目的**: エージェントがコマンド 1 つで全ケースの PNG を得られるようにする。

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `tools/render-lab-shot.mjs`(新規) | `chrome-session.mjs` で Chrome を上げ、`.render-lab/` を配信し、ページを開き、ケースごとに手順 7 の関数を `Runtime.evaluate` で呼び、`.render-lab/shots/` へ書く |
| `package.json` | `"render-lab:shot": "webpack --config webpack.render-lab.config.js --mode production && node tools/render-lab-shot.mjs"` |
| `CLAUDE.md` のコマンド表 | `npm run render-lab:shot` の行(用途:描画を画像で確かめるとき) |

出力の名前:

```
.render-lab/shots/<case>-prepass.png    ライトプリパス経路
.render-lab/shots/<case>-forward.png    フォワード経路
.render-lab/shots/<case>-diff.png       |prepass − forward| × 8
```

**本番ビルドを踏むこと。** 開発ビルドで回すと、クラス名のマングルで陰影が消える種類の不具合を
撮影が見逃す。

**達成条件と検証**

- `.render-lab/shots/` に 21 枚の PNG が出る。
- ソースに `Page.captureScreenshot` が 1 件も無い。
- `npm run render-lab:shot`
- `ls .render-lab/shots/ | wc -l` → 21
- `grep -rn "captureScreenshot" tools/` → 0 件
- 出た PNG を開いて、手順 6・7 で目視したものと同じ絵であること

---

### 手順 10. 深度プローブのケースを当てる

**目的**: **この器が信用できるかを確かめる。** Phase 4 の判断をここへ預ける以上、
理論値と実測が合わないまま先へ進まない。

**変更が必要な箇所**

コード変更なし。**この文書へ結果を書き戻す。**

**期待値(導出)**

深度分解能 Δz は、非反転 `depth24plus` では `Δz = z²·2⁻²⁴ / near`、
反転 `depth32float` では `Δz ≈ z·2⁻²⁴`。2 個の球のずれ `δ = z·ε` が Δz を下回ると斑になる。
斑になる境目の ε は:

- **いま(非反転 24bit、near=2)**: `ε_min = z·2⁻²⁴/near = z · 2.98e-8`
- **Phase 4 後(反転 32bit)**: `ε_min = 2⁻²⁴ = 5.96e-8`(**z に依らない**)

| ケース | 距離 z | いまの ε_min | いま斑になる ε | (Phase 4 後の予測) |
|---|---|---|---|---|
| `depth-1e4` | 1e4 | 3.0e-4 | 1e-4 以下 | 1e-7 だけ境界 |
| `depth-1e6` | 1e6 | 3.0e-2 | 5 組すべて | 1e-7 だけ境界 |
| `depth-1e8` | 1e8 | 3.0(> 1) | 5 組すべて | 1e-7 だけ境界 |
| `depth-1e11` | 1e11 | 3.0e3(> 1) | 5 組すべて | 1e-7 だけ境界 |

**ε は無次元の比なので、この表は描画解像度に依らない。**

**達成条件と検証**

- `depth-1e4` で ε=1e-3 が澄み、ε=1e-4 以下が斑になる。
- `depth-1e6` / `depth-1e8` / `depth-1e11` で 5 組すべてが斑(または far の外)。
- `far` で 3.8e8 m と 4.5e12 m の球が両方出る。
- **どの ε から斑になったかをこの文書へ書き戻してある。**
- `npm run render-lab:shot`
- `.render-lab/shots/depth-*.png` を開き、斑の出方を上の表と突き合わせる
- **合わなければ器を疑う** — `CelestialSurface` の自前 `depthNode`(深度をシェーダで書き直している)
  の影響で境目が 1 段ずれることはありうるが、桁がずれるなら組み方が違う

---

## 見積り

**新規コード**

| ファイル | 行 | 内訳 |
|---|---|---|
| `tools/render-lab/cases.ts` | 約 120 | 共通の下請け 3 種 40 + 7 ケース × 約 12 |
| `tools/render-lab/lab.ts` | 約 130 | レンダラ 2 系統 40 + ケース投入 30 + 撮影 40 + 差分 20 |
| `tools/render-lab/main.ts` | 約 70 | ボタン列 30 + レイアウト/リサイズ 20 + `window` への公開 20 |
| `tools/render-lab/index.html` | 約 45 | |
| `webpack.render-lab.config.js` | 約 45 | bgm-lab 版 35 + minimizer 10 |
| `tools/chrome-session.mjs` | 約 190 | **既存 2 ファイルからの移動。** 純増はほぼ 0 |
| `tools/render-lab-shot.mjs` | 約 80 | 共通化した分だけ小さい |

**純増は約 490 行、うち移動が 190 行なので実質 300 行。**
`DEVELOP/CODING-RULE.md` の 200 行/モジュール基準に収めるための 3 分割(`main` / `lab` / `cases`)。

**既存への変更**: 手順 1〜3 の描画設定の受け渡しで 12 ファイル。ほとんどが型と引数の差し替えで、
実体のある移動は `scaleApparentSize` の 1 つだけ。残りは `package.json` 2 行、`.gitignore` 1 行、
`CLAUDE.md` 2 行、それに `browser-smoke.mjs` / `perf-probe.mjs` の import 差し替え。

**実行時の費用**: `WebGPURenderer` 2 台。ゲーム本体の実測(戦闘ビュー、1920×1080)が
G バッファ 0.6ms / ライティング 0.5ms / マテリアル 0.6ms / ワールド 2.6ms / 合成 0.4ms = 4.7ms/枚。
テストシーンは球数個 + 艦 1 機、しかも 960×540(画素数で 1/4)なのでこれを大きく下回り、
**2 台でも 1 フレーム 10ms を超えない。** シーンを組み直すのはケース切替のときだけ。

**撮影の所要**: Chrome 起動 約 3s + ページ読み込み 約 2s + 7 ケース × 3 枚 × 約 0.2s ≒ **約 10 秒。**

---

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
|---|---|---|
| **この環境のヘッドレスは 1〜2 fps しか出ない** | `npm run smoke:browser` の「30 秒で 60 フレーム」判定に届かず落ちる。**実測(2026-08-23、`docs/` 本番ビルド): 起動・HUD・コンソールとも正常で、30 秒間の rAF が 40 回。** 撮影も見積りより遅くなる | 全手順。**smoke の失敗を変更の回帰と読み違えない** |
| **設定値を構築時に受け取って保持する** | 環・オーロラ・大気・点群・詳細度の切り替えが次の起動まで効かなくなる。**絵は出るので気付きにくい** | 手順 3。設定パネルで切り替えて、その場で絵が変わるか |
| **`bindResolutionTarget` の呼び出しが宙に浮く** | 解像度倍率の設定が起動時に反映されず、常に 1 倍で描く | 手順 1。`main.ts` が `initScene` の直後に呼んでいるか |
| **撮影ターゲットを sRGB フォーマットで作る** | 合成パスは既に sRGB へ変換済みの値を書く。ターゲットも `-srgb` だと**二重変換**になり、撮った PNG だけが白っぽくなる。「パイプラインが明るすぎる」と誤読する | 手順 7。`RGBAFormat` + `UnsignedByteType` で作っているか |
| **読み出した画素の上下が逆** | `readRenderTargetPixelsAsync` の行順と `ImageData` の行順が食い違うと上下反転する。左右対称なシーンだと**気付かない** | 手順 7。艦は前後非対称なので `leo` で分かる |
| **`setOutputRenderTarget` を戻し忘れる** | 以後キャンバスに何も出なくなる。**目視のページだけが真っ黒になり、撮影は通る** | 手順 7。撮影のたびに `null` へ戻す |
| **`WebGPURenderer` を 2 台作るとデバイスも 2 つになる** | 環境によっては 2 台目の `init()` が失敗し、右の canvas だけ黒いまま無言で残る | 手順 6。**`init()` の失敗を握り潰さず、失敗したらページに文字で出す** |
| **フォワード側で艦がチャンネル 0 に残っていない** | `buildPlayerShip()` は内部で `markLitOpaque()` を呼ぶ。**呼ばないのではなく、呼ばれたあとに戻す**必要がある | 手順 6。右の canvas に艦が出ない |
| **`CelestialSurface` の球は `LIT_OPAQUE_LAYER` に載らない** | 球は `MeshBasicNodeMaterial` で自前 Lambert を持つので、**2 経路で同じ絵になるのが正しい。** `diff` の球が光ったら器の不備 | 手順 7。露出か合成の扱いが揃っていない |
| **`CelestialSurface` は自前の `depthNode` を持っている** | 深度をフラグメントシェーダで書き直しているので、ハードウェア深度と最後の桁が違いうる。プローブの境目が導出値から 1 段ずれる | 手順 10。**ずれても器の失敗ではない** — Phase 4 でこの `depthNode` は消えるので、そのとき再測 |
| **`far=1e13` のケースが現状の版で破綻する** | 深度デバッグ表示や `viewDistanceFromDepth` が使えなくなりうる | 手順 10。**それが観測結果であって器の失敗ではない** |
| **球の見かけの大きさをケースごとに揃え損ねる** | 距離 z に対し半径 z/10 の規則を外すと、遠いケースで球が 1px 未満になって斑が見えず、「澄んでいる」と誤読する | 手順 10。`depth-*` の球が同じ大きさに見えるか |
| **`Curve.setCurve` の `revision` を毎フレーム変える / カメラを渡し忘れる** | 適応分割が毎フレーム焼き直されて線がちらつく、あるいは焼かれず線が出ない。**撮影ではフレームごとに違う絵が撮れる** | 手順 6・9。`leo` / `order` で線が出ない、または撮り直すたびに違う |
| **共通化が `npm run ci` を壊す** | `browser-smoke.mjs` は `npm run ci` の最後にいる。壊すとリリース検証が止まる | 手順 8。**単独 commit にし、`npm run smoke:browser` を通してから次へ行く** |
| **撮影を開発ビルドで回す** | クラス名のマングルで陰影が消える種類の不具合を、撮影が見逃す | 手順 9。`render-lab:shot` が本番ビルドを踏んでいるか |
| **ケースを増やしたくなる** | 「ついでに環も」「オーロラも」と足すと持ち込む依存が増え、器そのものが壊れやすくなる | 全手順。**球・艦・線の 3 種を超えたら、それは別フェーズの要求である**(Phase 4 が足す 2 ケースを除く) |

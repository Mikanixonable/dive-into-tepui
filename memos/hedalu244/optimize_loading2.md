# ロードの軽量化 その2 — 現在地と次の手

対象コミット `4ecc4895`(ブランチ `optimize-load-and-runtime`。手順 1・2 実施済み)。
**スナップショットであって、コードの現状を説明する文書ではない。全手順を実施したら消す。**

## 目的

ブランチの一連の作業で、起動の固まりは 53〜60 秒から 19 秒へ落ちた。残っているのは1つ。

1. **ロード表示中のシェーダ構築のうち、大気パスと遮蔽パスの2つに時間が集中している。**
   どちらも静的展開で 100 KB を超える単一のフラグメントシェーダになっている。

あわせて、最初のテクスチャが揃った直後に **1 秒ほど JS スレッドが止まる**。手順 1 でこの
ブロックはロード表示の中へ移り、プレイ中の固まりとしては消えた(ロード表示が消えた後
10 秒の最大 JS ブロックは 0.17 秒)。残るのはロード表示中の 1.0〜1.5 秒の欠落。

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
- 同じビルドを続けて測ったばらつきは compile 段合計で 28.6 秒 / 35.3 秒(creative)。
  **数秒の差は差と見なさない。前後を比べるなら同じ回で測る。**
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

`?stage=creative` も同じ。**タンパク質は 1 体も取りに行かない**(手順 2 の前は既定の 1 体
25.03 MB / 転送 6.77 MB をロード表示中の 2.3 秒に取り始めていた)。

**事前コンパイル中に取りに行くもの**(stage 1 でも creative でも同じ 5 枚。手順 1 で加わった
ロード中の `sync` が `syncLod` を通すので、ロード表示が消えるより前に始まる)

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

`?stage=1`・品質 high・1280×720。**パイプライン 50 本 / シェーダモジュール 80 本 / WGSL 591.2 KB。**
compute パイプラインは 0 本(タンパク質の敵を置くまで作られない)。**すべてロード表示の中で
組まれる** — 表示が消えた後に作られるパイプラインは 0 本(手順 1 の前は stage 1 で 9 本、
creative で 15 本)。

区分はローディング表示の注記(`シェーダを準備中: <パス名>`)を生成時に読んで付けた。
「完了」は事前コンパイル後に投げる捨て 1 フレームのぶん。

| 段 | パイプライン | シェーダ | WGSL | 所要 |
| --- | ---: | ---: | ---: | ---: |
| 影 | 6 | 9 | 17.4 KB | 1,358 ms |
| G バッファ | 10 | 14 | 58.8 KB | 4,561 ms |
| **遮蔽** | 4 | 8 | **148.8 KB** | **3,639 ms** |
| 照明 | 3 | 6 | 55.3 KB | 1,346 ms |
| マテリアル | 2 | 4 | 7.0 KB | 267 ms |
| **大気** | 2 | 4 | **118.0 KB** | **6,083 ms** |
| ワールド | 7 | 11 | 17.5 KB | 220 ms |
| レンズ | 5 | 8 | 128.1 KB | 2,488 ms |
| 合成 | 1 | 2 | 5.6 KB | 65 ms |
| オーバーレイ | 2 | 4 | 4.9 KB | 130 ms |
| アンチエイリアス | 4 | 8 | 27.0 KB | 836 ms |
| 完了(捨て 1 フレーム) | 4 | 2 | 2.8 KB | — |
| **計** | **50** | **80** | **591.2 KB** | **21.0 秒** |

`?stage=creative` は **パイプライン 48 本 / シェーダ 71 本 / 578.6 KB**、compile 段 28.6 秒
(G バッファ 4,462 ms・遮蔽 5,004 ms・大気 6,121 ms・ワールド 6,667 ms・レンズ 3,079 ms)。

**最初の生フレームまでの合計は手順 1 の前後で変わらない**(stage 1: 23.8 → 24.2 秒、
creative: 34.2 → 33.9 秒)。compile 段が伸びたのは、初回フレームで組まれていたぶんが
そこへ移ったためで、増えたわけではない。

### 3. そのほかの実測

- **初回テクスチャが揃った直後に 1.0〜1.5 秒、JS スレッドが完全に止まる。** 上の 20.64 MB が
  届いた直後のフレーム。デコードかアップロードかミップマップ生成かは切り分けていない。
  手順 1 以降、この取得は事前コンパイル中(ロード表示の中)に始まるので、ブロックもロード表示の
  中にある — stage 1 で 1,034 ms(3.1 秒地点)、creative で 1,401 ms(2.1 秒地点)。
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

1. **天体テクスチャの遅延は現状のままにする。** 12 枚の `2k_*.jpg` は落ちてこず、狙いは既に達成
   されている。単色球が一瞬見えるのは容認済み。
2. **レンズパス(2.5 秒)には手を付けない。** 26 本 → 5 本まで既に畳まれていて、これ以上は
   `lens-kernels.ts` が持つ「向き1つにつき1本の鎖」という設計を崩す。**費用対効果が合わない。**
3. **タンパク質の compute シェーダ、メッシュ間引き、`8k_clouds.jpg` / `earth-climate.png` の
   置き場所は、この計画では扱わない。**

**覆されたときに変わる手順**: 1 を覆す(遠くの惑星も先に取る)なら現状のコードを戻す別の手順が要る。

---

## 達成目標

全手順の実施後、`?stage=1` と `?stage=creative` の両方で次を満たす。すべて後述のプローブで測る。

1. **ローディング表示が消えた後に作られるパイプラインが 0 本。**
   達成済み(stage 1 / creative とも 0 本。手順 1 の前は 9 本 / 15 本)。
   **当初は「`RenderPipeline.render` を起点に作られるパイプラインが 0 本」と書いていたが、
   three の出力階調変換の板は実際に描いたときにしか組まれない**(`_renderOutput` は
   `_renderScene` からしか呼ばれず、`compileAsync` は通らない)ので、ロード表示の中で 1 フレーム
   描いて組ませる形にした。その 4〜6 本は `RenderPipeline.render` を起点に持つ。
2. **ローディング表示が消えてから 10 秒間の最大フレーム欠落が 500 ms 以下**
   (手順 1 の前は stage 1 で 3,151 ms、creative で 10,002 ms)。
   現状 stage 1 で 400 ms、creative で 534 ms。creative の 534 ms は表示消滅の 11 ms 前に
   始まる欠落で、消滅より後に始まるものは 417 ms。
3. **compile 段の合計が stage 1 で 14 秒以下**(現状 21.0 秒)。
   導出: 大気 6.1 秒 → 2.0 秒、遮蔽 3.6 秒 → 2.0 秒 で 21.0 − 5.7 = 15.3 秒 … に届かないので、
   **G バッファ(4.6 秒)へも手を伸ばすか、この目標を実測で置き直す。**
   当初の「12 秒以下」は手順 1 の前の 19.0 秒を基準にしていた値で、初回フレームぶんが
   compile 段へ移った現在は基準が違う。
4. **creative のロード表示が消える前に、`assets/*Structure.json` / `*Motion.json` の
   Resource Timing エントリが1つも現れない。** 達成済み(60 秒の観測で 0 件)。
5. **`main.js` の gzip 転送が 1.25 MB 以下**(現状 1.40 MB)。
6. **見た目が変わらない。** 大気・遮蔽に触れた前後で `npm run render-lab:shot` の絵が一致する
   (撮り直しの揺れ ±4 LSB を超える差が無い)。

---

## 手順

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

**目的**: 20.64 MB のテクスチャが揃った直後に JS スレッドが 1.0〜1.5 秒止まるのを解消する。
手順 1 で取得が事前コンパイル中へ移ったので、このブロックはロード表示の中にある — プレイ中の
固まりではなくなり、**ロード時間を縮める手順に変わった。**

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
4. 注入するもの: `GPUDevice.prototype` の 5 つのメソッドを包む / rAF の到来時刻 /
   **20 ms 間隔のタイマー心拍**(欠落中に JS が暇かどうかの切り分けに要る)/ ローディング表示の
   注記の変化を 8 ms 間隔で拾う / 最後に `performance.getEntriesByType('resource')`。
5. **段の区分は、生成のたびにローディング表示の注記を DOM から同期に読んで付ける。**
   `シェーダを準備中: <パス名>` がそのまま段の名前になるので、スタックを解析するより正確で短い。
   注記が読めない(表示が無い)なら、それがロード表示の外で作られたということ。
6. **「ロード表示が消えた後か」は時刻ではなく rAF の中かどうかで見る。** `requestAnimationFrame`
   を包んで、コールバックの実行中だけ立つフラグを持たせる。フレームループの中で作られたか
   どうかがそのまま判定になる — ローディング表示の消滅時刻は、メインスレッドが止まると遅れて
   記録されるので境界に使えない。
7. **プロファイルは毎回捨てる。** 使い回すと Chrome の GPU ディスクキャッシュに当たって
   1.6 秒になる。
8. `performance.getEntriesByType('resource')` は**完了した取得しか出さない。** 「取得が始まったか」
   を見るなら、始まった直後ではなく完了するまで待つこと。

---

## 見積り

| 手順 | 何がどれだけ動くか | 導出 |
| --- | --- | --- |
| 3 | compile 段 −3.6 秒 | 大気 6,083 ms。本文 118.0 KB のうち天体スロット 4 ぶんの展開が支配的で、`Loop()` へ畳めば本文はおよそ 1/4。**費用は本文長に厳密には比例しない**ので、2.5 秒を切らなければ実測で判断し直す |
| 4 | compile 段 −1.6 秒 | 遮蔽 3,639 ms。148.8 KB のうち 13 帯 × 12 PCF タップ × 6 積雲タップの展開が支配的 |
| 5 | `main.js` 転送 1.40 → 1.23 MB | Backbone 4 本の gzip が 0.17 MB(実測: 48.3 + 95.5 + 24.5 + 2.8 KB) |
| 6 | ロード表示中の JS ブロック 1.0〜1.5 秒 → 0.3 秒以下 | 1 フレーム 1 枚に均せば、5 枚で 5 フレームに分散する |

**合計の見込み**: compile 段 21.0 秒 → 16 秒前後。**測定機(Intel gen-9 内蔵 GPU)での値であり、
実機の絶対値ではない。**

---

## リスクと落とし穴

| リスク | 影響 | それが露見する場所 |
| --- | --- | --- |
| **踏んだ(手順 1)。** `update()` を一度も通していない状態で `sync()` を呼ぶ | `Belt.sync()` が未初期化の節点配列を読んで例外を投げ、ロードが止まった。ベルトのリンク数のように update が決める可視性も落ちる | 解決: 事前コンパイルの前に `update(0)` → `sync()` を通す。時間の進まない 1 フレームとして扱う |
| **踏んだ(手順 1)。** `compileAsync` は three の出力色変換の経路を組まない | `outputColorTransform` は `_renderOutput` でしか作られず、`_renderOutput` は `_renderScene`(実描画)からしか呼ばれない | 解決: 事前コンパイルの後、ロード表示を出したまま 1 フレーム描いて捨てる |
| `Loop()` は展開されないぶん実行時のレジスタ圧が変わる | コンパイルは短くなるが fps が落ちる。ロードを直してプレイを悪くする | 手順 3・4(`PerfMeter` の GPU 時間) |
| 遮蔽の帯を `Loop()` にすると、帯ごとの uniform を配列へまとめる必要がある。配列長を `MAX_RING_BANDS` に固定すると、**uniform 配列の長さがシェーダ本文へ焼かれる**(このブランチで一度踏んだ形) | 展開を畳んだのにコンパイル時間が減らない | 手順 4 |
| `protein-asset-catalog.generated.ts` は生成物 | 手で直すと `npm run protein:catalog:check` が落ちる | 手順 5 |
| Backbone を fetch へ回すと、`isProteinAssetReady` のゲートに含め忘れる | 敵が実体化した後に当たり判定だけが未着で、**撃っても当たらない**(例外は出ない) | 手順 5 |
| `ImageBitmapLoader` は `ImageLoader` と色空間・Y 反転の扱いが違う | 天体テクスチャが上下反転したりガンマがずれる | 手順 6(`npm run dev` で地球を見る) |
| WGSL の本文が変わると Chrome の GPU ディスクキャッシュが全部外れる | 手順 3・4 を入れた配信では、全プレイヤーが 1 回だけ冷キャッシュの構築を踏む。**これは避けられない**ので、リリースをまとめる理由にはなる | 手順 3・4 |
| 測定機の GPU は Intel gen-9 の内蔵 GPU。速い GPU では全部の絶対値が縮む | 「14 秒以下」のような絶対値の達成条件を実機で当てようとすると合わない | 全手順(比で読む) |
| **同じビルドを続けて測ると、compile 段の合計が数秒ぶれる**(creative で 28.6 秒 / 35.3 秒を観測) | 手順 3・4 の効果を1回の測定で判定すると、ぶれを効果と読み違える | 手順 3・4(前後を同じ回で測る) |

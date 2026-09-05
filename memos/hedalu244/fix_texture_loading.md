# 初回テクスチャ投入の主スレッド停止 — 調査結果と修正計画

## 結論

再現する。`?stage=1&perf=1` を、新規 Chrome プロファイル・キャッシュなしで 3 回起動した。
初回画像が到着した後、ローディング表示が出ている間に **0.93〜1.05 秒の連続した主スレッド停止**が毎回出た。
最初の試行では同じ一群が 0.93 秒と 0.39 秒へ二分され、合計 1.32 秒だった。

直接の原因は画像デコードではなく、three の WebGPU バックエンドが `Texture.needsUpdate` を処理して呼ぶ
`GPUQueue.copyExternalImageToTexture` である。第3回の停止区間（3.70〜4.72 秒、心拍欠落 1,017 ms）は次と一致した。

| 入力画像 | 寸法 | `copyExternalImageToTexture` の同期所要 |
| --- | ---: | ---: |
| `earth.jpg` | 8192 × 4096 | 552.5 ms |
| `cloud-field.png` | 4096 × 2048 | 299.7 ms |
| `earth-smoothness.png` | 4096 × 2048 | 49.7 ms |
| 合計（呼び出し間の隙間を除く） | | 901.9 ms |

同じ起動では Long Task が 916 ms、別のコールド起動では `copyExternalImageToTexture` が
573.6 + 287.3 + 59.9 ms、心拍欠落が 1,045.9 ms だった。いずれもエラーはなく、
`gameReady` まで到達した。停止時刻はローディング表示の表示開始後・消滅前であり、プレイ中へは漏れていない。

`8k_stars.jpg`（8192 × 4096）にも別の 267.8 ms の投入があり、こちらはローディング中の後半に起きる。

## 切り分け

- `ImageLoader` の `load` 通知は、画像の Resource Timing の `responseEnd` より後に来るが、1 秒の
  Long Task と一致しない。大きな停止は画像通知後に WebGPU API 呼び出しの内側で起きる。
- `src/render/deferred-texture.ts` は画像の load callback で直ちに `texture.image` と
  `texture.needsUpdate` を設定する。ここ自体は短いが、次の three の compile/render が、準備済みの
  全テクスチャを同じ仕事単位で GPU へコピーする。
- `Game.create()` は最初の `update()` / `sync()` を `pipeline.compile()` より先に実行する。
  その `sync()` が地球・月・土星などの `CelestialSurface.syncLod()` と地球の
  `CumulusShell.syncLod()` を通し、各 `DeferredTexture.request()` を同時に開始する。
- 星野だけは `src/render/stars.ts` が `TextureLoader` を直接使うため、上の遅延ロード経路の外にある。

よって、元メモの「`ImageLoader` を `ImageBitmapLoader` に替えてデコードをワーカーへ出す」を最初の
修正にする根拠はない。ImageBitmap 化はコピー元の表現を変えるため比較対象にはなるが、今回観測した
552 ms の同期 GPU コピーを、それだけで解消する保証はない。

また「1フレームにつき1枚」だけでも不十分である。地球 1 枚が既に 300 ms の目標を超え、雲場も
ほぼ上限に達しているためである。

## 修正計画

### 方針

画像の取得・デコード完了と GPU への公開を分け、ロード表示中に公開数を制御する。テクスチャの
解像度・品質・LOD はこの修正では変更しない。より良い方式を別途検討する。

### 手順 1. GPU投入を計測可能な待ち行列へ分離する（実施済み）

対象:

- `src/render/deferred-texture.ts`
- `src/render/celestial-surface.ts`
- `src/render/cumulus-shell.ts`
- `src/render/stars.ts`
- `src/render/pipeline/render-pipeline.ts`

変更:

1. `DeferredTexture` の load callback は画像を待ち行列へ入れるだけにし、その場では
   `texture.image` / `needsUpdate` を変更しない。
2. `DeferredTexture` が準備済み画像を待ち行列で保持する。`RenderPipeline` はコンパイル／描画の
   実際の GPU 投入境界で 1 枚だけ公開して `renderer.initTexture()` で直ちに投入し、コンパイル中は
   次の投入前にブラウザへ制御を返す。
3. 星野も `TextureLoader` の直呼びをやめ、同じ待ち行列を通す。初回テクスチャの投入経路を一つにする。
4. `CelestialSurface.syncLod()` と `CumulusShell.syncLod()` は「取得要求」だけを続け、投入順・上限を
   render 側へ渡す。天体ごとの可視性判定は変えない。

確認:

- WebGPU API のラッパーで、各 `copyExternalImageToTexture` の URL・開始・終了を出す。
- stage 1 と creative のコールド起動を各3回測り、同一のコンパイル仕事単位で複数枚が公開されないことを確認する。
- `npm run typecheck` と `npm run test:render` を通す。

実施結果（2026-09-05）:

- 独立した Chrome プロファイルで stage 1 / creative を各3回起動した。`copyExternalImageToTexture` の
  計測では、8192×4096 と 4096×2048 の初回アセットはすべて異なる animation frame で GPU へ投入された。
- 単独の 8192×4096 転送は 0.39〜0.61 秒、4096×2048 転送は 0.04〜0.32 秒だった。解像度を変えていないため
  単独転送の停止は残るが、初回テクスチャが揃った直後の複数枚連続転送は解消した。
- `npm run typecheck`、`npm run test:render`（19/19）、`npm run build`、`npm run smoke:browser` は成功した。

### 棄却: 手順 2. 初期表示用の投入解像度を上限化する

テクスチャ品質・LOD の設計は別途検討する。現時点では解像度を下げず、この手順は実施しない。

### 手順 3. ロード完了の条件と回帰を固定する

対象:

- 起動計測プローブ（恒久コードには残さない）
- 必要なら `tools/browser-smoke.mjs`

確認:

1. 新規プロファイルの stage 1 / creative を各3回起動し、ローディング表示中・消滅後10秒の
   心拍欠落と投入順を記録する。単一画像のコピー時間はこの手順では変えないため、300 ms を
   超える値が残ることは失敗条件にしない。
2. Resource Timing で、初期表示に不要なテクスチャが前倒しで取得されていないこと。
3. 60フレーム到達、fatal error なし、`npm run typecheck`、`npm run test:render` を確認する。

## リスク

- 解像度を下げずに待ち行列だけを導入しても、地球1枚の 552 ms は残る。この手順の達成は、複数画像の
  同時投入をなくすことまでである。単一画像を短くする品質・LOD の対策は別途検討する。
- 取得済み画像をゲーム開始後に一括公開すれば、ロード画面の停止をプレイ中へ移すだけになる。通常の
  描画フレームでも待ち行列の上限を守る必要がある。

## 実施時の検証コマンド

```text
npm run typecheck
npm run test:render
npm run render-lab:shot
npm run smoke:browser
```

この文書は調査と計画のみであり、上記の実装はまだ行っていない。

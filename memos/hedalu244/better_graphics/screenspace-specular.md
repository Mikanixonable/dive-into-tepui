# 局所反射 — 滑らかな面に近くの物体を映す（計画）

**計画ファイル。** `/run-plan` で上から実施し、完了した手順はこの文書から消す。`screenspace-base`
（近傍の光輸送の計画を拡散補正と局所反射に分けた時点）から生やした `screenspace-specular` ブランチで、
拡散補正の再調整（`screenspace-diffuse.md`）と**並行して**進める。拡散補正側の実装は見ず、その改善も
前提にしない。着手時点の target / timing 構成は手順1で監査する。

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

- **拡散補正に触れず、前提にもしない。** 局所反射の計算は新しいファイルへ閉じ、拡散補正のファイル —
  `src/render/pipeline/screen-space/` の既存ファイル（`screen-space-pass.ts` を含む）と
  `src/render/pipeline/lighting/diffuse-correction-source.ts` — は変えない。`screen-space-pass.ts` は
  拡散補正の描画命令の列で、並行中に大きく書き換わるので、追跡をそこへ足すと合流で衝突する。共有の
  登録表（`render-pipeline.ts` の構築と呼び出し・`gpu-timings.ts` の行・`debug-target.ts` の並び・描画
  設定）へは行を足すだけにする（全手順）。
- **鏡面の遮りを拡散の遮蔽から作らない。** 近傍拡散補正の遮蔽から、GTSO 風の一つのローブの鏡面
  可視率（`specularVisibility`）を作らない。粗さ・視線・反射ベクトルを必要とする鏡面の遮りは、拡散の
  遮蔽の副産物ではない。局所反射自身が「近傍へ当たった像」と「その向こうの遠方鏡面光を置き換える
  重み」を所有する（手順1〜3）。
- **追跡**: 鏡の向きに1本、半解像度の view depth 上を画面空間で透視補正した刻みで進める
  （McGuire & Mara 2014）。半解像度の深度は局所反射が自分で作り、近傍拡散補正の描画先を借りない。
  開始点を blue noise でずらし、画面外・空・カメラへ向かう ray は miss。画面の縁と最大距離の手前で
  confidence を0へフェードする（手順2）。
- **局所反射の源**: 映す像は、局所反射が自分で描く仮の描画「局所反射の源」から読む — 遠方の光源
  （太陽・天体照・環境光）で照らした、見えている面の放射輝度（拡散・鏡面・自己発光）。近傍拡散補正
  （遮蔽と照り返し）は入れず、拡散補正の「照り返しの源」とも共有しない。マテリアルパスの出力も読まない。
  そのため映った物体には、その物体自身の遮蔽と照り返しが入らない。源を1つの描画先に分けておくのは、
  合流の後に照り返しも映したくなったとき、源だけを差し替えられるようにするため。前フレームの履歴は
  使わない（手順3）。
- **ぼかし**: 当たった点の色は、局所反射の源の縮小列から読む。LOD は鏡面ローブが当たり距離で張る
  円の半径から選ぶ（Uludag 2014）（手順3）。
- **粗さの上限**: 知覚的粗さ0.3まで全量、0.6で0。それより粗い面では局所反射を足さず、遠方鏡面
  （天体照・環境光の鏡面）をそのまま残す。近傍拡散補正の遮蔽から鏡面遮蔽を作らない（手順2・3）。
- **遠方鏡面との合成**: `w = roughness fade × edge fade × distance fade × hit confidence` とし、hit 部分の
  遠方鏡面を `1 - w` で弱め、`F0 × local image × w` を足す。miss では遠方鏡面を変えない（手順2・3）。
- **パス位置**: 追跡は遠方鏡面を弱めるので、影パスの後・ライティングパスの前に、拡散補正のパス
  （`ScreenSpacePass`）とは別のパスとして置く。遮蔽と照り返しの設定によらず動く。源・縮小列・像の
  解決はマテリアルパス後・大気パス前（手順2・3）。
- **設定**: `screenSpaceSpecular`（真偽、低 / 中 / 高 preset = オフ / オフ / オン）。既存の
  `screenSpaceDiffuse` / `screenSpaceQuality` の値は振り直さない（手順2）。

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
3. 映り込みオフのデバッグ「鏡面照度」は、着手時点のコードと pixel diff 0。
4. GPU の「映り込み」median が同じ session の「マテリアル」の5倍以下。
5. `ssr-after` と `ssr-before-1/2` の比較で、封筒外は局所反射が出る金属面に限られる。

---

## 手順

### 手順 1. 着手時点の構成を監査し、局所反射の before を2組撮る

**目的** — この計画が前提にする構成を着手時点のコードで確かめ、`leo-metal` と `bay-metal` に近くの
物体がまだ映っていないことを確認して比較基準を残す。コードは変えない。

**変更が必要な箇所** — なし（コードは変えない）。

**達成条件と検証**

- `grep -rn "specularVisibility" src/` が0件で、遠方鏡面
  （`src/render/pipeline/lighting/ambient-source.ts` / `src/render/pipeline/lighting/planet-light-source.ts`）が
  近傍拡散補正を読んでいない。
- 着手時点の target / timing 構成 — `src/render/pipeline/render-pipeline.ts` のパス順、
  `src/render/gpu-timings.ts` の行、`src/render/pipeline/debug-target.ts` の並び — を確かめ、手順2〜4の
  変更箇所と見積りをそれに合わせて直す。
- `DEVELOP/SPEC/RENDERING.md` の映り込みの記述が、目的に書いた振舞いから変わっていない。変わって
  いれば、この計画を直してから進む。
- 次の未決を決め、手順2〜4へ書き込んでから進む。
  - 追跡が読む半解像度の深度の作り方（局所反射が自分で持つ）。
  - 局所反射の源の解像度（全 / 半）。源は遠方の光源を積み直すので、同じ session のライティングの行の
    実測から費用を見積もって決める。
  - GPU の行: 追跡（ライティングより前）と源・像の解決（マテリアル後）は実行順で隣り合わないので、
    「映り込み」1 行にまとめるか、実行順に分けるか。源を別の行にするか。達成目標4と見積りの予算を
    それに合わせる。
  - 縮小列を永続する中間 target として持つなら、そのデバッグ表示を生成順に足す。
  - 順序を固定するテスト `tests/render/debug-target.test.ts` と `tests/render/gpu-timings.test.ts` を、
    手順2・3の変更箇所に加える。
- `npm run render-lab:shot -- ssr-before-1` と `-- ssr-before-2`。
- `leo-metal` の粗さ0.05の球に隣の球、`bay-metal` の粗さ0.05の板に立方体と薬莢が映っていないことを
  画像で確認する。
- 見積りの負荷の初期予算を、同じ機材・同じ session の before の実測で確かめ直す。

### 手順 2. 鏡の向きへ追跡し、遠方鏡面との置換重みを作る

**目的** — 反射 ray の hit uv / 距離 / confidence を求め、像を足す前に、hit 部分の遠方鏡面だけを
`1 - w` で弱める。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/screen-space/reflection-trace.ts`（新規） | 半解像度 view depth の透視補正追跡、blue-noise jitter、hit / miss、画面端・距離・粗さ confidence。ray thickness の単位と根拠をここに閉じる |
| `src/render/pipeline/screen-space/screen-space-reflection.ts`（新規） | 全解像度 target。`rg = hit uv`、`b = view-space hit distance [m]`、`a = w` の符号化と、遠方鏡面を置換する読み口。半解像度の深度と追跡の描画命令を自分で出し、自分の GPU の行へ計上する |
| `src/render/pipeline/lighting/ambient-source.ts` / `src/render/pipeline/lighting/planet-light-source.ts` | 局所反射オン時だけ miss confidence を遠方鏡面へ掛ける。近傍拡散補正は参照しない |
| `src/render/graphics-settings.ts` / `src/render/pipeline/render-pipeline.ts` | `screenSpaceSpecular` を配り、影パスの後・ライティングパスの前に追跡を呼ぶ |
| `src/render/pipeline/debug-target.ts` / `src/render/pipeline/render-pipeline.ts` | hit uv / distance / confidence の実 target を生成順に直接表示する |

```ts
export class ScreenSpaceReflection {
  public readonly texture: THREE.Texture;
  public setEnabled(enabled: boolean): void;
  public render(camera: THREE.Camera, width: number, height: number): void; // オフでは何も描かない
  public farSpecularWeight(sample: ShadingSample): FloatNode; // off/miss は 1、hit は 1-w
  public dispose(): void;
}
```

**達成条件と検証**

- `npm run typecheck` / `npm run check:boundaries` / `npm run test:render` / `npm run test:settings`。
- `git diff --diff-filter=M screenspace-base -- src/render/pipeline/screen-space/ src/render/pipeline/lighting/diffuse-correction-source.ts`
  が空。
- 映り込みオンの `bay-metal` で、粗さ0.05の板の立方体が映るはずの領域から遠方天体照の像が消える。
  まだ局所像は足さないので、その領域は暗く見える。粗さ0.8はオフと差が3以下。
- 遮蔽と照り返しをオフにしても、追跡の target が描かれる。
- 空・画面外・カメラへ向かう ray が miss になり、`leo-metal` の上端に黒い像が出ない。
- 映り込みオフの組は `ssr-before-*` と封筒外0件。
- commit: `feat(render): 滑らかな面の映る向きを追い遠方鏡面を置き換える`

### 手順 3. 局所反射の源を描き、当たった像を粗さに応じて足す

**目的** — 局所反射の源を描き、当たった点の色をその縮小列から粗さに応じて読み、`F0 × image × w` を
マテリアル後・大気前へ足す。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/screen-space/reflection-source.ts`（新規） | 局所反射の源。遠方の光源の寄与を自分の照度へ積み、素材を掛けて放射輝度にする。近傍拡散補正の光源は積まない |
| `src/render/pipeline/reflection-pass.ts`（新規） | 源の縮小列、roughness LOD、hit uv 解決、加算。GPU「映り込み」へ計上 |
| `src/render/pipeline/render-pipeline.ts` | マテリアルパス後・大気前に呼び、源と像だけのデバッグ表示を生成順へ足す |
| `src/render/gpu-timings.ts` | 着手時点の実行順に「映り込み」を追加。数値IDはそのとき採番する |
| `src/render/pipeline/debug-target.ts` | `'reflection-source'`「局所反射の源」と `'reflection'`「映り込み」を追加 |

```ts
// farSources は遠方の光源(太陽・天体照・環境光)だけ。DiffuseCorrectionSource は渡さない。
export class ReflectionSource {
  public constructor(
    renderer: WebGPURenderer, gbuffer: GBufferPass, farSources: readonly LightSource[], gpu: GpuTimings,
  );
  // rgb = 見えている面が放つ放射輝度(SUN_IRRADIANCE_1AU の目盛り)。
  public get texture(): THREE.Texture;
  public render(camera: THREE.Camera, width: number, height: number): void;
  public dispose(): void;
}
```

像は源の縮小列だけから読み、マテリアルパスの出力（共有の描画先）は読まない — 写しが要らず、共有の
描画先を書きながら読むことも起きない。光源の寄与はライティングパスと同じ `LightSource` を呼んで
作り、式を写さない。素材の掛け方を `material-pass.ts` から切り出して共有するかは、ここで決める。

**達成条件と検証**

- `npm run typecheck` / `npm run check:boundaries` / `npm run test:render`。
- `git diff --diff-filter=M screenspace-base -- src/render/pipeline/screen-space/ src/render/pipeline/lighting/diffuse-correction-source.ts`
  が空。
- 遮蔽と照り返し・映り込みをオフにした組で、デバッグ「局所反射の源」と「マテリアル」が面の内側で
  同じ明るさと色に見える（源が全解像度なら差は3 LSB以下）。
- 縮小列の各 mip を別色にした最小プローブで、選んだ LOD と実 target が一致する。
- `npm run render-lab:shot -- ssr-on` で達成目標1〜3。デバッグ「映り込み」は像だけを表示する。
- commit: `feat(render): 滑らかな面に近くの物体の像を映す`

### 手順 4. 追い込み、比較して閉じる

**目的** — 粗さ・画面端・距離のフェード、追跡歩数と hit tolerance を追い込み、意図しない画像差と負荷を
確認して閉じる。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/render/pipeline/screen-space/reflection-trace.ts` / `src/render/pipeline/reflection-pass.ts` | 粗さ・画面端・距離のフェード、追跡歩数、hit tolerance を追い込む |
| `tools/render-lab-measure.mjs` | `screen-space` の軸に映り込みオン/オフを足す |
| `memos/hedalu244/better_graphics/pipeline.md` | パス表と残件を更新する |

**達成条件と検証**

- `npm run render-lab:shot -- ssr-after`。
- `npm run render-lab:compare -- .render-lab-shots/ssr-after .render-lab-shots/ssr-before-1 .render-lab-shots/ssr-before-2` で達成目標5。
- `node tools/render-lab-measure.mjs 3 screen-space` で達成目標4。
- `bay-metal` の粗さ sweep（0.05 / 0.4 / 0.8）で、中間粗さの天体照の映り込みだけが過剰に暗くならない。
- `npm run typecheck` / `npm run check:boundaries` / `npm run test:render` / `npm run test:settings`。
- `git diff --diff-filter=M screenspace-base -- src/render/pipeline/screen-space/ src/render/pipeline/lighting/diffuse-correction-source.ts`
  が空。
- `/refactor` / `/comment-cleanup`。main への送り方と拡散補正側との合流の順はユーザーが決めるので、
  ここでは送らない。

---

## 拡散補正側との合流

合流の順と時期はユーザーが決める。手が要るのは次の所で、どれも局所反射が足した行を合流後の形へ
移し直せば済むよう、局所反射は登録表へ行を足すだけにしておく。

- `gpu-timings.ts` の行と `debug-target.ts` の並びは、両側が実行順・生成順の途中へ挿入する。合流後の
  実行順で並べ直し、順序のテストも合わせる。
- `render-pipeline.ts` のパスの構築・呼び出し・デバッグ表示の表。
- 局所反射の源は合流後も分けたままにする。照り返しも映したくなったら源を差し替える。
- 追跡の半解像度の深度と同じ働きの描画先が拡散補正側にあれば、合流の後にまとめるかを決める。

---

## 見積り

| 作業 | 手順 | 中央見積り |
| --- | --- | ---: |
| before と最終監査 | 1・4 | 3 h |
| 追跡 | 2 | 7 h |
| 置換境界 | 2 | 3 h |
| 局所反射の源 | 3 | 3 h |
| 縮小列と像 | 3 | 6 h |
| 品質・負荷・比較 | 4 | 6 h |

**合計 28 h。** 手順1の監査で着手時点の target / timing 構成を確かめてから更新する。

負荷の初期予算は、960×540 の実測で半解像度の深度標本1回がマテリアル行の約0.1倍だったことから置く。
32歩の追跡 32 × 0.1 = 3.2倍、5段の縮小列1.0倍、全解像度の解決1.0倍に、局所反射の源（遠方の光源を
積み直すので、ライティングの行と同程度）を足したものを出発点とする。これは採用値ではなく、手順1で
同じ機材・同じ session の before を取り直して確かめる仮説である。達成目標4の5倍以下へは、画を見ずに
歩数だけ削らず、hit率・miss率・edge fade と内訳を合わせて追い込む。

---

## リスクと落とし穴

| リスク | 影響 | 露見する手順 |
| --- | --- | --- |
| 拡散補正のファイルへ手を入れる / その改善を前提にする | 並行中に衝突し、合流が重くなる | 手順2〜4で `git diff --diff-filter=M screenspace-base` が拡散補正のファイルに差分を出さないことを確かめる |
| 局所反射が近傍拡散補正の遮蔽（GTSO 風の鏡面遮蔽）に再依存する | 不自然な鏡面影が復活する | 手順1で `specularVisibility` 0件を確認し、手順2で局所反射が所有する confidence だけを使う |
| 空の深度を hit として扱う | 虚空が黒い像として映る | 手順2で空・画面外・カメラ向き ray を明示的に miss とし、`leo-metal` 上端を確認 |
| 粗さ fade と遠方鏡面の置換を二重適用する | 中間粗さだけ天体照の映り込みが過剰に暗くなる | 手順2・3で同じ `w` を置換と像に一度ずつ使い、手順4で `bay-metal` の粗さ sweep を測る |
| 源の光の積み方や素材の掛け方がライティング・マテリアルパスと食い違う | 映った物体の明るさや色が本体と違って見える | 手順3で、遮蔽と照り返し・映り込みオフの源とマテリアルを面の内側で比べる |
| 源に鏡面を入れ忘れる | 映った金属の物体が黒くなる | 手順3で `leo-metal` の金属の行の球の映り込みを見る |
| 縮小列の特定 mip へ描けない | 粗い面でも像が鋭いままになる | 手順3の最小プローブで各 mip を別色にし、LOD と実 target を照合 |
| debug のために段を再実行する | 見ている値と通常フレームが違う | 手順2・3で hit uv / distance / confidence と源・像のデバッグ表示が実 target を直接読むことを確認 |
| GPU 行の順が実行順でない / 複数段が同じ行 | 重い場所を誤認する | 手順3で「映り込み」の行を実行順に置き、手順4で render-lab UI と `tools/render-lab-measure.mjs` を照合 |
| blue noise をフレームごとに動かす | 静止画は良いが動画がちらつく | 手順2で固定2D pattern にし、手順4で連続フレーム readback の一致を確認 |

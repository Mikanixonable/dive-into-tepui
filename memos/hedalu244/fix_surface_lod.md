# PR #72 の詳細 LOD 地表タイルの後始末

行番号はすべて `origin/main` = `713755b1`(PR #75 のマージ)時点のもの。
PR #72 の前の main は `b9b6f9d8`、PR #72 のマージは `db090876`。

**この計画は保留中。** 地表 LOD は別ブランチで動きがありそうなので、そちらの形が決まるまで着手
しない。もとは fix_PR72.md の一部で、そこから地表 LOD にかかる手順だけを切り出した(旧手順
0・1・5・6・12 が、この計画の手順 1〜5)。着手するときは、`origin/main` の現状で行番号と
commit の並びを取り直し、別ブランチの成果と突き合わせてから判断をやり直す。

**保留のあいだ、main の公開は止まったままになる。** 「Build and deploy」は #72 以降一度も
通っておらず、落ちているのは手順 2 が外す 2 ステップだけ(#74・#75 のマージは `npm run test` と
`npm run build` を通っている)。手順 2 だけを保留から外して先に入れる判断もありうる — 別ブランチが
CI の配置ステップごと作り直すなら、待つ意味がある。

## 目的

PR #72(workspace3、346 commit)が持ち込んだ地球の詳細 LOD 地表タイルと、その足場である天体表面の
汎用化を main から外す。配信物のデプロイも、必要な範囲だけを取りに行く通信の最適化も立たないまま
main に入っていて、次の3つが起きている。

- **main の CI が PR #72 以降一度も通っておらず、公開が止まっている。** #72・#73 のマージは
  `npm run test`(地表タイルの逆順到着テスト、#74 で修正)で、#74・#75 のマージは
  「Stage Earth surface bundle for Pages」(`earth-surface:pages: baseColor JPEG must start with SOI`)
  で落ちた。どちらも地表タイルが持ち込んだもの。
- 本番では起動のたびに地表 manifest が 404 になり、詳細タイルは一度も有効にならない。
- 地表タイルのためだけにある汎用化の費用を、全天体が毎フレーム払っている
  (`createCelestialSurfaceFrame` の行列 compose と clone、`performance.now()`)。

修正後の状態:

- main は地表タイル・天体表面の汎用化・月別気候を持たず、公開が再開している。地球の表面は
  `CelestialSurface.textured(EARTH_TEXTURE, earthSmoothnessUrl)` で直接組まれる。
- 地表タイルと月別気候は保護ブランチ `earth-surface-tiles` で生き続け、main の撤去 commit を
  revert した形で main に追随する。eventLog は上限を持ち、既定の地形法線は放射方向になっている。

### 項目ごとの判定

| 項目 | 主な commit | 判定 | 扱い | 手順 |
| --- | --- | --- | --- | --- |
| CI の地表バンドル配置 | `.github/workflows/build.yml` | 不採用(保護) | 2 ステップを外す | 2 |
| 詳細 LOD 地表タイル | 292005d7、a53d3a52、13157b06、827d5dcd、7d04a3d8 ほか | 不採用(保護) | 撤去 | 3 |
| 天体表面の汎用化 | 6abda4a4、d909e606、de50e55c | 不採用(保護) | 撤去 | 4 |
| 地表タイルの eventLog の肥大・初期法線 | earth-surface-request.ts、-material-binding.ts | 要修正(保護ブランチ側) | 保護ブランチで直す | 5 |
| 月別気候(sin 波の架空気候) | 5055f0e1、3f7245b7、893e6700、1991b243、6efe3b9e、#75 の c16347e0・0e4a1eb1 | 不採用(保護) | 撤去は fix_PR72.md 手順 3、保護はこの計画 | 5 |

**触らないもの**: #72 の描画以外の変更(UI・入力・太陽系精度・物理)。雲・大気の後始末は
fix_PR72.md が扱う。

## fix_PR72.md との関係

両計画は独立に進む。跨るのは次の3点だけで、いずれも **fix_PR72.md が先** になる。

| 跨る点 | なぜ先か |
| --- | --- |
| サングリントの修正(fix_PR72.md 手順 1) | 撤去 commit に修正を混ぜないため(決めたこと 4)。先に入れておけば、この計画の手順 3 の撤去 commit を保護ブランチが revert しても、退行だけが戻ることはない |
| 雲場の楕円体投影の撤去(fix_PR72.md 手順 2) | `src/render/cloud/field-projection.ts` が、手順 3 で消す `earth-surface-coordinate.ts` を import している。先に外さないと import が宙に浮く |
| 月別気候の撤去(fix_PR72.md 手順 3) | 月別気候の実データは地表タイルの配信物(`EarthSurfaceSource.climateMapUrls`)に入っているので、保護先はこの計画のブランチ。手順 5 の revert 対象にその commit を含める |

fix_PR72.md 手順 3 のあと、`EarthSurfaceSource.climateMapUrls` は呼び手 0 のまま main に残る。
手順 3 で地表タイルごと消えるので、main 側で先に消さない。

## 決めたこと

**すべて覆せる。** 覆したときにどの手順が変わるかを併記する。

### 1. main の履歴は書き換えない。撤去は機能ごとに1つの commit にする

#72〜#75 はマージ済みで、release は main から CI が作る。rebase・force push はしない。

個別 revert は、次の試し(`origin/main` の上で `git revert --no-commit`)のとおり使えない。
天体表面の汎用化の 3 commit(6abda4a4 / d909e606 / de50e55c)はいずれも衝突する。

そこで、**保護する機能の撤去はそれぞれ1つの commit に閉じ、修正を混ぜない。** 保護ブランチは
その commit を revert すれば機能を取り戻せる(手順 5)。

### 2. 保護するのは地表タイル・天体表面の汎用化・月別気候・CI の配置ステップ

月別気候の実データ(12 か月の気候図)は地表タイルの配信物(`EarthSurfaceSource.climateMapUrls`)に
入っているので、地表タイルと同じ場所で育てる。楕円体投影・ディザ撤去・ミップ・ヒステリシス・
診断つまみは保護しない。タグ `pr72-merged`(= `713755b1`)から参照できれば足りる。

**覆されたら**(楕円体投影も保護する場合): 手順 5 の revert 対象に fix_PR72.md 手順 2 の commit を
足す。

### 3. 天体表面の汎用化は地表タイルの足場なので、一緒に保護ブランチへ移す

`CelestialSurfaceLike` / `CelestialSurfaceFrame` / `syncFrame` / `setCelestialSurfaceViewport` /
`replaceMaterial` / `diagnostics` を使っているのは `EarthSurface` と、その診断を出すデバッグ窓の
「地表」グループだけ。`CelestialSurface.syncFrame` は空(celestial-surface.ts:253)。
`diagnostics` の中身(`residentMaxZ`・`usesDetailedMaterial`)もタイル固有。地表タイルが無い main
では、全天体が毎フレーム `createCelestialSurfaceFrame`(行列の compose と clone)と
`performance.now()` を払うだけになる(point-celestial-view.ts:129-135)。

`DeferredTexture` の世代番号(`generation`)は残す。#75 の `ObservedCloudField` と、fix_PR72.md
手順 3 で戻す平年の気候が使う。失敗時の通知(`onError`)は呼び手が 0 件なので消す。

**覆されたら**(汎用化を main に残す場合): 手順 4 を飛ばす。ただし毎フレームの割り当てとモジュール
グローバルの描画先寸法は直す(→ 手順 5 の「再上陸までの todo」を main 側で行う)。

### 4. サングリントの修正は地表タイルの撤去より前の、独立した commit にする

撤去 commit に混ぜると、保護ブランチがそれを revert したときに退行も戻る。修正そのものは
fix_PR72.md 手順 1。

## 達成目標

1. main の「Build and deploy」が成功し、`release` へ push される。
2. main で次が **0 件**。
   `git grep -nEi 'earth-?surface|EarthSurface' -- src tools tests webpack.config.js package.json .github`
   さらに `tools/earth-surface/`・`.earth-surface/`・`assets-src/earth-surface/` がリポジトリに無い。
3. main で次が **0 件**。
   `git grep -nE 'CelestialSurfaceLike|CelestialSurfaceFrame|syncFrame|setCelestialSurfaceViewport' -- src tools tests`
4. `earth-system.ts` の地球は `CelestialSurface.textured(EARTH_TEXTURE, earthSmoothnessUrl)` で
   組まれる(工場も runtime も経由しない)。
5. デバッグ情報ウィンドウに「地表」グループが無い。
6. **目視**: `npm run dev` でコンソールに地表 manifest の 404 が出ない。地球は実写テクスチャで
   描かれ、昼側の海にサングリントが残っている。
7. `earth-surface-tiles` は「main + 手順 2・3・4 と fix_PR72.md 手順 3 の revert + 修正」の形で、
   `npm run typecheck`・`npm run test`・`npm run earth-surface:test` が通る。eventLog は上限を持ち、
   既定の地形法線は放射方向になっている。
8. main で `npm run typecheck`・`npm run test`・`npm run build` が通る。

## 手順

main へは `/send-pr` で送る。区切りは次の 2 つ。**マージは merge commit で行い、squash しない**
(手順 5 が撤去 commit の hash を revert するため)。

- PR-1(至急): 手順 2 — 公開の再開。手順 1 を済ませてから送る
- PR-2(撤去): 手順 3〜4

手順 5 は PR-2 のマージ後に行う。

### 手順 1. 保護ブランチとタグを作る

**目的**: 撤去を始める前に、#75 までの全部を失わない参照点を置く。コードは変えない。

| 操作 | 何をするか |
| --- | --- |
| `git tag pr72-merged 713755b1` | 不採用にする実装(地表タイル・汎用化・月別気候、fix_PR72.md が外すディザ撤去・ミップ・楕円体投影)を後から読める参照点 |
| `git branch earth-surface-tiles 713755b1` | 保護ブランチ。**手順 5 まで commit を積まない** |
| `git push origin pr72-merged earth-surface-tiles` | リモートへ置く |

どちらも固定 hash を指すので、fix_PR72.md が先に main へ入っていても作れる。

**達成条件と検証**: `git ls-remote origin earth-surface-tiles pr72-merged` が 2 行とも `713755b1` を返す。

### 手順 2. CI から地表バンドルの配置を外す

**目的**: 公開の再開。#74・#75 のマージは `npm run test` と `npm run build` を通っていて、配置の
ステップだけで落ちている。保護ブランチは手順 5 でこの commit を revert する。

| ファイル | 何をするか |
| --- | --- |
| `.github/workflows/build.yml` | 「Stage Earth surface bundle for Pages」「Verify Earth surface Pages layout」の 2 ステップ(と直前のコメント 2 行)を消す。`npm run verify:ui-style` は UI の検査なので残す |

**達成条件と検証**: main への push で「Build and deploy」が成功し、`release` ブランチが更新される
(`gh run list --branch main -L 1` が success)。

### 手順 3. 詳細 LOD 地表タイルを撤去する

**目的**: 配信物のデプロイも、必要な範囲だけを取りに行く通信の最適化も立たないまま main に入って
いる。本番では起動のたびに 404 になり、一度も有効にならない。保護ブランチは手順 5 でこの commit
を revert する。

**前提**: fix_PR72.md の手順 1(サングリント)と手順 2(楕円体投影)が main へ入っていること。

| 操作 / ファイル | 何をするか |
| --- | --- |
| `git rm` | `src/render/earth-surface*.ts`(12 ファイル)、`src/game/celestial/solar-system/earth-surface-runtime.ts`・`earth-surface-source.ts`、`src/types/earth-surface-config.d.ts`、`tests/render/earth-surface*.test.ts`(12 ファイル)、`tests/render/tsl-node-evaluator.ts`(地表の2テストだけが使う)、`tools/earth-surface/`、`tools/render-lab-earth-surface.mjs`、`tools/render-lab/earth-surface-capture.ts`、`assets-src/earth-surface/`、`.earth-surface/` |
| `git checkout b9b6f9d8 -- webpack.config.js tools/verify-release.mjs .gitignore` | 3 ファイルとも #72 の差分は地表タイルだけで、#72 以降は誰も触っていない。**実施時に `git log db090876..HEAD -- <file>` が空であることを確かめ直す** |
| `package.json` | `earth-surface:*` の 15 スクリプトを消す。`verify:ui-style`・`test:settings`・model-builder のパスは別の変更なので残す |
| `src/game/celestial/solar-system/earth-system.ts` | `EARTH_SURFACE_FIXTURE_SOURCE`・`EarthSurfaceFactoryOptions/Result`・`EarthSurfaceRuntimeHandle`・`fallbackSurface`・`EarthSurfaceConnection`・`detailedMaterialFor`・`coordinatorFor`・`createEarthSurfaceRuntime`・`createEarthSurface`・`defaultEarthSurfaceColorToRgba8` と、それらの import を消す。地球の表面は `CelestialSurface.textured(EARTH_TEXTURE, earthSmoothnessUrl)` を直接渡す。`earthSystem` の `renderer` 引数を消す。雲場の工場へ渡していた `earthSurfaceRuntime.ready` は fix_PR72.md 手順 3 で既に消えている |
| `src/game/celestial/solar-system/solar-system.ts` と、その先で renderer を運んでいる箇所 | `earthSystem` へ renderer を渡す経路を消す(`git grep -n 'earthSystem(' -- src` から辿る) |
| `tests/game/earth-system.test.ts` | 「earth runtime」「manifestなしのfactory」のテストを消す |
| `tools/render-lab/cases.ts`、`main.ts`、`index.html` | 地表キャプチャの口を消す |
| `tools/png.mjs`(1991b243 で +5 行) | `tools/earth-surface/fixture-climate.mjs` 用。**ほかの呼び手を `git grep` で確かめてから** 戻す |
| `DEVELOP/SPEC/` | 触らない。詳細タイルの記述(CELESTIAL.md:298-301、RENDERING.md:302)は未実装の仕様として残す |

**達成条件と検証**:

- `npm run typecheck`、`npm run test`(render・game・tools に跨る)、`npm run build`。
- 達成目標 2 の検索が 0 件。
- `npm run dev` で起動し、コンソールに地表 manifest の 404 が出ない。地球は実写テクスチャで描かれ、
  サングリントが残っている。

### 手順 4. 天体表面の汎用化を外す

**目的**: 地表タイルのためだけにある契約・毎フレームのフレーム値・描画先寸法のモジュール
グローバルを外す(決めたこと 3)。**この時点で挙動は変えない。**

| ファイル | 何をするか |
| --- | --- |
| `src/render/celestial/celestial-surface.ts` | `CelestialSurfaceStatus`・`CelestialSurfaceDiagnostics`・`CelestialSurfaceFrame`・`surfaceViewport` と `setCelestialSurfaceViewport`/`celestialSurfaceViewport`(71-84)・`createCelestialSurfaceFrame`(86-107)・`CelestialSurfaceLike`・`CelestialSurfaceMaterialAttachment`・`replaceMaterial`・`restoreFallbackMaterial`・`fallback*` の3フィールドと `usingFallbackMaterial`・`materialOnDispose`・`diagnostics`・`syncFrame` を消し、`dispose` を1系統へ戻す |
| `src/render/celestial/celestial-entity/point-celestial-view.ts:8, 129-136` | `syncFrame` の呼び出しと `performance.now()` を消す。表面の型を `CelestialSurface` にする。fix_PR72.md 手順 5(オーロラ)がこの関数を触っているので、行番号は取り直す |
| `src/render/celestial/celestial-entity/sphere-celestial-view.ts:14, 38, 49` ほか `CelestialSurfaceLike` を型に使う箇所 | `git grep -n CelestialSurfaceLike -- src` で列挙して `CelestialSurface` へ。`surfaceDiagnostics` を消す |
| `src/render/pipeline/render-pipeline.ts:37, 299` | `setCelestialSurfaceViewport` の import と呼び出しを消す |
| `src/render/deferred-texture.ts:24, 46` | 呼び手の無い `onError` を消す。`generation` は残す |
| `src/game/hud/windows/debug-info-window.ts:362-371` | 「地表」グループを消す |
| `src/game/perf-counts.ts` | 地表の診断を持つ天体の列挙を消す(`git grep -n diagnostics -- src/game` で当たる箇所) |
| `tests/render/celestial-surface-like.test.ts` | 削除 |
| `tests/game/earth-system.test.ts` | 「PerfCountsは詳細地表を持つ天体だけ列挙する」を消す |

**達成条件と検証**:

- `npm run typecheck`、`npm run test:render`、`npm run test:game`。
- 達成目標 3 の検索が 0 件。
- デバッグ情報ウィンドウに「地表」グループが無い。

### 手順 5. 保護ブランチを main に追随させ、地表タイル側の欠陥を直す

**目的**: 保護ブランチを「main + 地表タイル・月別気候」の形にし、再上陸の前に直すべきものを直す。
**PR-2(手順 3〜4)が main へマージされてから行う。**

| 操作 / ファイル | 何をするか |
| --- | --- |
| `git switch earth-surface-tiles && git merge --ff-only origin/main` | 手順 1 から commit を積んでいないので早送りになる |
| `git revert <手順4> <手順3> <fix_PR72.md 手順3> <手順2>` | 新しい順に revert する。fix_PR72.md 手順 2(楕円体投影)は revert しない(保護しない)。このとき main に fix_PR72.md の手順 4〜8 が入っていれば、それらが触った point-celestial-view.ts・opaque-cloud-surface-renderer.ts・cloud-field-sampler.ts・generated-cloud-field.ts・earth-system.ts(`earthGeneratedCloudField` と雲の工場)・tools/cloud-lab・tools/render-lab/cases.ts で衝突する。**fix_PR72.md 手順 4〜8 の形を保って解く** |
| `src/render/earth-surface-request.ts:303, 313-314, 473` | `eventLog` に上限を持たせる(直近 N 件の環状バッファ)。`metrics` は読むたびに `eventLog.slice()` と失敗の Map を写すので、失敗の問い合わせを写しなしで答える口に分ける |
| `src/render/earth-surface-resident.ts:93, 231` | `failureReason` と失敗の判定を、上の写しなしの口で読む。`failureReason` は `EarthSurface.diagnostics.reason` 経由でデバッグ窓が読むたびに呼ばれている |
| `src/render/earth-surface-material-binding.ts:29-36` | `defaultTerrainData` が全 texel の法線を天体固定の +Y 一定で埋めている。earth-surface-material-node.ts:146 は `terrain.xyz` を天体固定の法線として読むので、base terrain(正距円筒 `EARTH_BASE_TERRAIN_WIDTH × HEIGHT`)の各 texel の地理緯度・経度に立つ楕円体の法線で埋める |
| `src/game/celestial/solar-system/earth-system.ts`、`src/render/cloud/monthly-climate-fixture.ts` | 月別気候が読めないときの代わりを sin 波の架空気候から `AnnualClimateMap`(`earth-climate.png`)へ替え、架空気候を消す |
| `tests/render/earth-surface-request.test.ts`、`earth-surface-material.test.ts` | 上限と既定の法線のテストを足す |

**再上陸までの todo**(この計画では行わない。保護ブランチの PR 本文へ持っていく):

- CI の配置が `baseColor JPEG must start with SOI` で落ちる(`tools/earth-surface/stage-pages.mjs:47`
  の fixture `base/earth.jpg` が contract.mjs:315 の検査を通らない)。
- ビルドが埋め込む manifest の URL(`earth/earth-2026-09-09-a/earth-surface.json`)と、
  stage-pages.mjs の配置先(`docs/earth-surface/earth-pages-fixture/`)が食い違っている。
- 全天体が毎フレーム `createCelestialSurfaceFrame` で行列を組み、`performance.now()` を呼んでいる。
  描画先寸法をモジュールグローバルで共有している。
- ページ表を毎フレーム GPU へ送り直している。約 117 MB のテクスチャ配列(144 層)を、地球へ
  近づかなくても有効化の時点で確保している。
- 月別気候図は地理緯度の正距円筒なので、雲場の cap(fix_cloud_projection.md)とは別に、気候の
  読み取りだけが楕円体の uv を使う形にする。雲場の投影へ楕円体を持ち込まない。
- 再上陸の条件は、配信物のデプロイと、必要な範囲だけを取りに行く通信の最適化が立つこと。

**達成条件と検証**(保護ブランチ上で):

- `npm run typecheck`、`npm run test`、`npm run earth-surface:test`。
- `git diff origin/main --stat` が、地表タイル・月別気候・天体表面の汎用化・CI の配置・上の修正だけに
  なる。
- `git push origin earth-surface-tiles`。

## 見積り

行数はすべて PR #72 の差分(`git diff --stat b9b6f9d8 04963d5d`)と、`origin/main` の実測から。

| 手順 | 削除(git 操作) | 手作業で編集するファイル |
| --- | --- | --- |
| 1 | — | — |
| 2 | — | 1(13 行) |
| 3 | src 約 3,000 行(earth-surface*.ts 12 本の合計)+ tests 約 2,050 行 + tools/earth-surface 約 5,500 行 + `.earth-surface/verification` 約 15,000 行(JSON)。checkout 3 ファイル | 約 6(earth-system.ts は約 250 行減) |
| 4 | テスト 1 本(33 行) | 約 8(celestial-surface.ts は約 160 行減) |
| 5 | revert 4 本 | 約 6 |

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 保留のあいだ手順 2 も止める | main の公開が止まったまま。落ちているのは配置の 2 ステップだけで、ほかの検証は通っている | 冒頭、手順 2 |
| 保護ブランチへ手順 5 より前に commit を積む | main の撤去を取り込むとき、変更した側と消した側がぶつかる。変更していないファイルは**黙って消える** | 手順 1、5 |
| PR を squash でマージする | 撤去 commit が1つに潰れるか hash が変わり、手順 5 の revert が別の変更まで巻き戻す | 手順 5 |
| 撤去 commit に修正を混ぜる(サングリント・CI 以外の変更) | 保護ブランチがその commit を revert したとき、修正も一緒に戻る | 手順 2、3 |
| fix_PR72.md 手順 2(楕円体投影)を済ませずに手順 3 へ入る | `src/render/cloud/field-projection.ts` が消えた `earth-surface-coordinate.ts` を import したままになり、型検査で落ちる | 手順 3 |
| 手順 5 の revert 対象に fix_PR72.md 手順 3 を含め忘れる | 保護ブランチから月別気候が消える。`pr72-merged` からは読めるが、追随した形では失われる | 手順 5 |
| `webpack.config.js` / `verify-release.mjs` / `.gitignore` を `b9b6f9d8` から checkout する前に、#72 以降の変更の有無を確かめない | 後から入った別の変更を黙って巻き戻す(`origin/main` 時点では 3 ファイルとも変更なし) | 手順 3 |
| `tools/png.mjs` の +5 行を呼び手を確かめずに戻す | cloud-lab の撮影など、ほかのツールの PNG 出力が壊れる | 手順 3 |
| 手順 3 で `EarthSurface` を消し、手順 4 までデバッグ窓の「地表」グループが空のまま残る | 行が出ないだけで何も言わない。手順 4 を飛ばすと宙に浮く | 手順 3、4 |
| 手順 5 の revert の衝突を、保護ブランチ側の形で解く | fix_PR72.md の手順 4〜8(ディザ・オーロラ・エアグロー・計測・cap)が保護ブランチでだけ巻き戻る | 手順 5 |
| #74 のテスト修正(`earth-surface-resident.test.ts`)が手順 3 で main から消える | 保護ブランチの revert で戻るので失われない。消えたことに驚いて手で戻さない | 手順 3、5 |

# 雲の表現別完全分割 — 調査と編成計画

作成日: 2026-09-10  
調査対象: `workspace3` の `59975acf`  すでに作業ツリーにある地表計画・タンパク質関連の変更は対象外とし、雲の構造だけを変更する。

## 目的

現在の雲は、同じ雲場を使う不透明雲・大気中の半透明雲・雲影を、`CumulusShell`、
`CloudScattering`、`CumulusShadow`、`AtmosphereLayer`、`PointEntity` の間で個別に解釈している。
そのため、場の読み方、雲頂・被覆率の計算、LOD、表示可否、天体姿勢、破棄の責務が複数の表現へ漏れている。

この作業では、既存の `0028edf5` 時点の雲の見え方を保ったまま、**表現ごとに実装と所有権を完全に分ける**。
対象は次の三つであり、ボリュームレイマーチ化は今回のスコープに含めない。

- 不透明雲: G-bufferへ深度・法線を書き、地表の前に立つ表面表現
- 大気雲: 大気の視線積分へ挟む巻雲・半透明積雲の殻表現
- 雲影: 太陽光路の雲の透過率を地表・物体へ渡す表現

雲場の生成はこれらの表現から独立した一つの入力源とし、同じ表示時刻・同じテクスチャ・同じ天体姿勢を
各表現へ渡す。表現側が別々に生成・補間・二値化を行わないことを主な達成条件とする。

## 現状調査

### 雲場の生成と読み取り

| 現在の型 | 実際の責務 | 問題 | 編成後 |
| --- | --- | --- | --- |
| `GeneratedCloudField` | 気候要求、`WeatherModel` の時刻同期、GPU焼き込みキャッシュ、`CloudField` の寿命 | 「生成」と「描画向けの読み取り」の入口が同じ型に見える | `GeneratedCloudField` は生成・寿命だけを持ち、表現は共有サンプラーを受け取る |
| `CloudField` | `BakedField` の出力テクスチャ、生成時の書き込み、TSLでの直接サンプル | テクスチャ所有、投影、サンプル規則が混在 | 場の出力所有者と読み取り規則を分離。サンプラーはテクスチャを解放しない |
| `cumulus-shape.ts` | coverage、cloudTop、粒、LOD、光学的厚み、空テクスチャの契約 | 表面・大気・影の三つが同じ式を直接参照し、表現の境界が無い | `CloudShapeEvaluator` 相当の共通形状評価へ集約し、各表現は必要な結果だけを受け取る |

`GeneratedCloudField` の再生成判定は `displayTime` と climate generation の組み合わせで正しく閉じているため、
この作業では生成アルゴリズムや気候モデルを変更しない。`CloudField` のテクスチャ形式と投影も変更しない。

### 表現ごとの現在の責務

| 現在の型 | 現在そこにあるもの | 分割後の責務 |
| --- | --- | --- |
| `CumulusShell` (318行) | メッシュとLOD、表示状態、場の焼き込み、表面マテリアル、視線レイマーチ、雲頂法線、粒、破棄 | `OpaqueCloudSurfaceRenderer`: 不透明雲のメッシュ・深度・法線・LOD。場の生成と大気・影の状態は持たない |
| `CloudScattering` (165行) | 殻の種類、殻高度、coverage/translucentの光学厚、場の読み、交差点からの散乱 | `CloudAtmosphereRenderer`: 大気雲だけの殻交差・場読み・散乱。命名を `CloudScattering` から責務に合わせる |
| `AtmosphereLayer` (522行) | 大気の幾何・密度・太陽光路・エアグロー・Blue Noise・雲殻の順序と合成 | `AtmosphereIntegrator` と `AtmosphereCloudLayers` に分割。前者は大気、後者は雲殻の区間分割・合成だけを担当 |
| `CumulusShadow` (168行) | 影用uniform、場サンプル、雲頂高度、coverage、6タップの太陽光路透過 | `CloudShadowRenderer`: 雲影のGPU式と入力状態だけ。表面メッシュや大気の設定は知らない |
| `PointEntity` (297行) | 雲をshapeGroupへ登録、LOD・表示可否、姿勢を二つの入力構造へ組み立て、焼き込み、破棄 | 雲表現の個別クラスを直接操作せず、天体の雲表示コンポーネントへ委譲 |
| `CelestialEntity` / `CelestialSystem` | 雲用フック、全天体の焼き込み、影候補と大気候補の配線 | `CloudPresentation` のようなゲーム境界の契約を渡すだけ。描画式は持たない |

### 重複している計算

- `CumulusShell`、`CloudScattering`、`CumulusShadow` がそれぞれ `sphereMeshUv` と場テクスチャを直接読む。
- `CumulusShell` と `CumulusShadow` が雲頂高度・coverage・粒・天体半径から形状を再構成する。
- `CloudScattering` と `CumulusShadow` がそれぞれ画面幅からfield mipを選ぶ。
- `PointEntity` が同じ `CumulusShell` から、表面・大気・影へ異なる構造を毎回組み立てる。
- `AtmosphereLayer` は大気の積分と雲の交差順を同じクラスの状態・関数群で保持している。

### 崩せない実行順

```text
表示時刻
  -> CelestialSystem.bakeClouds
  -> GeneratedCloudField が climate -> weather -> baked texture を更新
  -> PointEntity が各表現へ texture / bodyFromWorld / LOD を同期
  -> G-buffer: OpaqueCloudSurfaceRenderer
  -> shadow pass: CloudShadowRenderer
  -> atmosphere pass: AtmosphereIntegrator + CloudAtmosphereRenderer
```

焼き込みはG-bufferより前、影と大気は同じフレームの同期値を読む必要がある。`bodyFromWorld` はフレーム間で
使い回さず、表現ごとの入力スナップショットとして渡す。`CloudFieldSampler` はテクスチャを所有しないため、
表現の破棄順がテクスチャ所有者へ逆流しないようにする。

## 編成後の構造

```text
GeneratedCloudField
  ├─ ClimateMap / WeatherModel / CloudField の生成とGPU資源所有
  └─ CloudFieldHandle (テクスチャ + 投影の読み取り契約)
       └─ CloudFieldSampler
            ├─ sphere UV / wrap / mip選択 / field sample
            └─ CloudShapeEvaluator
                 ├─ coverage -> opacity fraction
                 ├─ cloudTop + grain -> surface radius
                 └─ column optical depth

PointEntity / CloudPresentation
  ├─ OpaqueCloudSurfaceRenderer
  │    └─ G-bufferの表面・深度・法線・LOD
  ├─ CloudAtmosphereRenderer
  │    └─ 大気積分へ渡す殻の交差・散乱
  └─ CloudShadowRenderer
       └─ 太陽光路の雲影透過

AtmosphereLayer
  ├─ AtmosphereIntegrator
  │    └─ RaySegment / medium / sun radiance / airglow / Blue Noise
  └─ AtmosphereCloudLayers
       └─ cloud shell crossing / ordering / cloud contribution
```

### API境界の方針

1. `GeneratedCloudField` は `THREE.Texture` を返す場合でも、テクスチャの所有権と `dispose` の責務を一つだけ持つ。
   表現側へは `CloudFieldSampler` を生成して渡し、表現側から `GeneratedCloudField` のモデルや気候へ触れさせない。
2. サンプラーは「方向・実寸幅・天体半径」を受けてfield値を返す。各表現が独自にUVやmipを組まない。
3. 形状評価は `coverage`、`cloudTop`、粒、`opaqueFraction`、`columnOpticalDepth` の関係を一箇所へ集約する。
   不透明表面が現在使っている連続clearance、線形補間後の二分探索、最後の表示判定は保持する。
4. 表現ごとのrendererは、他のrendererを参照しない。同じ場を読むために共有サンプラーを参照するだけにする。
5. `AtmosphereLayer` は天体単位の大気積分を管理し、雲の種類・雲の場の式を直接持たない。雲は専用の
   `AtmosphereCloudLayers` へ委譲する。
6. `PointEntity` は雲の各シェーダーのuniformを知らず、雲表示コンポーネントの `build / sync / bake / dispose` と、
   影・大気の候補契約だけを呼ぶ。既存の天体表面、環、オーロラ、マップ表示の責務は変更しない。

## 実装段階

### 段階0 — 契約固定と基準確認

- この文書の契約を実装前の基準とする。
- `0028edf5` の連続clearance、線形補間 + 二分探索、blue noiseを表面探索へ入れない条件を確認する。
- 既存の `npm run typecheck`、`npm run test:render`、`npm run test:game` を基準値として記録する。
- 既存の作業ツリー変更は雲の差分へ混ぜない。

### 段階1 — 共通入力層

対象: `src/render/cloud/`、必要な共通型・renderテスト。

- `CloudFieldSampler` を追加し、UV、テクスチャ読み、mip選択、空の雲場の契約を集約する。
- `CloudShapeEvaluator` または同等の責務を持つモジュールを追加し、表面・影・大気が共有する式を移す。
- `GeneratedCloudField` と `CloudField` の生成・出力所有を壊さず、サンプラーが出力テクスチャを解放しないことをテストする。
- ここでは表示経路をまだ置き換えず、旧クラスから新しい共通層を使える状態を作る。

### 段階2 — 不透明雲の分離

対象: `src/render/cumulus-shell.ts`、新しい不透明表現モジュール、`PointEntity` の接続。

- `CumulusShell` の場生成・大気可否・影入力を除き、`OpaqueCloudSurfaceRenderer` へ移す。
- メッシュの生成、詳細度ごとのマテリアル、LOD、`depthNode`、`normalNode`、破棄を新クラスへ閉じ込める。
- `PointEntity` の `build` と `sync` は不透明表現のファサードへ委譲する。
- 表面探索の最後のopaque判定だけがdiscardし、探索中はcoverageを連続値として扱うことを維持する。

### 段階3 — 大気雲と大気積分の分離

対象: `src/render/pipeline/cloud-scattering.ts`、`src/render/pipeline/atmosphere-layer.ts`、`atmosphere.ts`、
`atmosphere-pass.ts`。

- `CloudScattering` の責務を `CloudAtmosphereRenderer` へ整理し、雲殻の入力・有効化・交差・散乱を閉じ込める。
- `AtmosphereLayer` から雲固有の `CloudShellLayer`、殻高度、雲の順序付けを `AtmosphereCloudLayers` へ移す。
- `AtmosphereIntegrator` は大気密度、太陽光路、エアグロー、Blue Noise、地表深度による区間だけを扱う。
- `AtmospherePass` は大気層へ入力を書き込み、合成順を決める配線に留める。
- cirrus と translucent cumulus の設定名・表示条件・既存の殻高度と光学厚の挙動を変えない。

### 段階4 — 雲影の分離

対象: `src/render/pipeline/shadow/cumulus-shadow.ts`、`shadow-pass.ts`、`shadow-select.ts`、`CelestialSystem`。

- `CumulusShadow` を `CloudShadowRenderer` へ整理し、影専用のuniformとGPU式を閉じ込める。
- field読み、coverage、雲頂、光学的厚みの式を共通入力層から使い、表面・大気と別の雲形状を再構成しない。
- 影の候補契約は `CloudShadowInput` に絞り、`CelestialSystem` は選定・同期だけを行う。
- 既存の6タップ、receiver floor、太陽光路上限など、影品質の挙動は変更しない。

### 段階5 — ゲーム境界と寿命の整理

対象: `PointEntity`、`CelestialEntity`、`CelestialSystem`、`earth-system.ts`、render-lab接続。

- `CloudPresentation` (名称は実装時に責務に合わせて確定) を天体ごとの雲表示の所有者とする。
- `PointEntity` は表面・環・オーロラとの兼務を維持しつつ、雲の内部状態を直接操作しない。
- 焼き込み、G-buffer表示、影候補、大気候補が同じ場と時刻を読むように接続する。
- 雲を持たない天体は `null` で表し、空テクスチャをゲーム層で組み立てない。
- render-labの既存 `cumulus`・大気・影のテスト入口を新しい名前へ移行する。

### 段階6 — 旧構造の削除・レビュー・リファクタリング

- `CumulusShell`、`CloudScattering`、`CumulusShadow` を単なる別名として残さず、役割が移ったら削除または責務に合う名前へ統合する。
- `AtmosphereLayer` に雲式が残っていないか、各rendererが別々のUV/mip/coverage式を持っていないか検索する。
- 500行超のクラスが残る場合は、行数だけでなく責務境界を再診断してから追加分割する。
- リファクタリングが新しいrendererのAPIを変更する規模になった場合は、統合前に別計画を作成し、型検査を一段階ずつ通す。

## 並列実行の編成

依存関係があるコード編集は一つのLuna worktreeへ集約し、同じファイルの競合を作らない。並列化するのは次の独立作業とする。

| 作業 | 担当 | 書き込み範囲 | 依存 |
| --- | --- | --- | --- |
| C本体の実装 | Luna | 新旧の雲render・cloud・game接続・対応テスト | 段階1から順序実施 |
| 現行コードの独立監査と回帰観点 | Lunaの別監査タスク | ファイル変更なし、報告のみ | 現行 `59975acf` の読み取りだけ |
| 計画・最終文書 | メイン | 本計画と完了記録 | C本体の差分を見て更新 |
| 統合後レビュー | メイン（必要なら監査結果を利用） | 統合worktreeのみ | Lunaのコミット後 |

Lunaへは、実装前にこの計画の表現境界と「現行の見え方を変えない」条件を渡す。Lunaは専用worktreeで実装し、
自己検証とコミットを行う。メインはそのworktreeの変更を直接編集せず、完了後にコミットを取り込む。

## 検証計画

変更層に対応して次を実行する。

1. 常時: `npm run typecheck`
2. render層: `npm run test:render`
3. game接続を触った場合: `npm run test:game`
4. 見た目の確認を求められた範囲: `npm run cloud-lab:shot`、必要なら `npm run render-lab:shot`
5. 検索による構造確認:
   - `CumulusShell` / `CloudScattering` / `CumulusShadow` の旧責務が残っていない
   - `AtmosphereLayer` が雲場のUV、coverage、雲頂計算を直接持っていない
   - field textureの所有者が一つだけで、表現rendererがdisposeしない
   - 不透明表面・大気・影が同じ表示時刻の場を読む

見た目の比較では、雲ON/OFF、cirrus/translucent cumulus個別ON/OFF、影ON/OFF、戦闘ビュー、マップビュー、
斜め視線、リム、昼夜境界を確認する。表面の等高線状の縞、半透明殻だけの再現、影だけの別形状、黒化、
二重描画、LOD境界のちらつきを合格条件とする。

## リスクと判断

| リスク | 対策 |
| --- | --- |
| TSLノードが複数rendererで別々に生成され、uniformやtextureの寿命がずれる | サンプラーは非所有、rendererは自分のuniformだけ所有。全GPU資源を各クラスの `dispose` へ閉じ込める |
| 表現ごとにbodyFromWorldの更新時点がずれる | ゲーム境界で表示時刻から毎回スナップショットを作り、renderer間でmutableな行列を共有しない |
| 表面だけ共通shapeを使い、大気・影が古い式へ戻る | 共通shape evaluatorの利用を検索で確認し、旧式の重複を削除する |
| `AtmosphereLayer` の分割で大気と雲の合成順が変わる | 既存の外側殻からの順序、opaque depthによる打ち切り、奥から手前の合成をテストする |
| 形だけの薄いラッパーが増える | 1クラスごとに独自の状態・GPU資源・式の所有を要求し、委譲だけの型は統合する |
| 地表タイル作業と雲の接続が競合する | 現行の地表変更は保持し、雲の差分以外を変更しない。統合後に `git diff` で確認する |

## 完了条件

- 表現ごとのクラス名と責務が一致し、生成・不透明面・大気・影・ゲーム配線の境界がコードから読める。
- 同じ雲場を使う三表現の形状・UV・mip規則に重複実装がない。
- 既存の雲の視覚仕様と表示設定を保ち、各ビューで等高線状の模様・ディザ由来のちらつき・別表現だけの黒化が悪化しない。
- `npm run typecheck`、`npm run test:render`、必要な `npm run test:game` が通る。
- コードレビューと必要なリファクタリングを終え、workspace3へ統合してコミットする。
- この計画文書へ実装結果・検証結果・残課題を追記し、Lunaのworktreeを削除する。

## 実装結果・レビュー記録

実装コミット: `b9a5cb0e` (`refactor(render): split cloud representations`)

実装した構造:

- `GeneratedCloudField` / `CloudField` は雲場の生成・焼き込み・GPU資源所有を継続。
- `CloudFieldSampler` は球面UV、テクスチャ読み、明示mip選択を共有。
- `CloudShapeEvaluator` はcoverage、雲頂、粒、光学的厚みを共有。
- `OpaqueCloudSurfaceRenderer` は不透明雲のメッシュ、LOD、深度、法線だけを所有。
- `CloudAtmosphereRenderer` と `AtmosphereCloudLayers` は大気雲の殻、交差順、合成を所有。
- `AtmosphereIntegrator` は大気の密度積分、太陽光路、エアグロー、Blue Noiseを所有。
- `CloudShadowRenderer` は雲影の太陽光路だけを所有。
- `CloudPresentation` は天体側の雲場・不透明rendererの寿命と、表現へ渡すsnapshotを束ねる。
- `PointEntity`、`CelestialEntity`、`CelestialSystem` は表現内部のTSL式を持たず、接続とフレーム同期だけを行う。

レビューで確認したこと:

- `CumulusShell`、`CloudScattering`、`CumulusShadow`、`AtmosphereLayer` の旧クラス名と旧ファイル参照はコードから除去した。
- 不透明雲の `depthNode` と `normalNode` は同じ `marched.toVar()` を共有している。
- 表面探索の連続clearance、線形補間 + 二分探索、最後のopaque判定、表面探索へBlue Noiseを入れない条件を保持した。
- 大気雲は巻雲B・積雲Rの解釈を保持し、雲殻の外側entry → 内側entry → 内側exit → 外側exitの順序を維持した。
- 雲影は6タップ、`STEP_BLUR`、共有形状評価を維持した。
- `GeneratedCloudField`だけが雲場を解放し、各rendererのsamplerはテクスチャを解放しない。
- `bodyFromWorld`は大気・影へ別々のcloneとして渡される。
- 旧表現との二重登録・二重描画になる参照は残っていない。

検証結果:

- `npm run typecheck`: 成功
- `npm run test:render`: 85/85 成功
- `npm run test:game`: 200/200 成功
- `npm run render-lab:shot`: Earth関連の撮影（`earth`、`earth-oblique`、`earth-terminator`、`earth-eclipse`など）まで成功。
  後半のタンパク質ケース `pdb-5i4r` で既存の `Unknown Render Lab protein asset` エラーが発生したが、雲とは無関係。
- `earth-oblique`、`earth-terminator`、`earth-eclipse` を目視確認し、今回の撮影では等間隔の◆状暗青模様や、雲殻だけが再表示する等高線状の帯は確認されなかった。

追加のコードリファクタリングは不要と判断した。新しいrendererへ責務を移した直後であり、さらに細かく分割すると
薄い委譲型が増えるため、今回は行わない。GPU上の連続フレームによるちらつきと品質設定全組み合わせは、今後の実機比較課題として残す。

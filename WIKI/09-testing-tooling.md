# 09. テスト・ツール

Dive into Tepui は、単純な unit test だけでなく、**型、アーキテクチャ境界、データ生成、描画比較、ブラウザ起動、リリース成果物**まで複数段の検証を持ちます。変更内容に応じて、必要な検証を選ぶことが重要です。

## 1. 基本方針

通常の変更では、まず `npm run typecheck` を通します。

その上で、変更した層に対応するテストを追加します。

| 変更 | 主な検証 |
| --- | --- |
| `src/math/` | `npm run test:math` |
| `src/physics/` | `npm run test:physics` |
| `src/game/` | `npm run test:game` |
| `src/render/` | `npm run test:render` |
| launcher / settings | 対応する tests 配下 + typecheck |
| main へ送る前 | 全体検証 |

「念のため全部」を毎回行うより、変更箇所に対応した検証をまず使い、main へ送る段階で全体を見る方が効率的です。

## 2. typecheck

```bash
npm run typecheck
```

TypeScript の型検査です。

このプロジェクトでは、型は単なる補助ではなく、

- 読み取り専用
- union
- nullability
- port
- serialized type
- device declaration

などの境界を表すために使われています。

型エラーを `any` で潰すと、設計境界まで失うことがあります。

## 3. test harness

`tests/harness.ts` と `tests/run.ts` がテスト実行の基盤です。

テスト群は対象層に近いディレクトリへ分かれています。

```text
tests/
├─ math/
├─ physics/
├─ game/
├─ render/
├─ launcher/
├─ settings/
└─ perf/
```

## 4. math tests

数学層では、

- ベクトル
- 四元数
- 幾何
- 射影
- データ構造
- 最適化

などの純粋な処理を検証します。

この層は外部依存が少ないため、入力と期待値を明確にした小さなテストが向いています。

## 5. physics tests

物理テストでは、単に「関数が返るか」ではなく、

- 保存量
- 既知解
- 対称性
- 座標変換の往復
- 単位
- 境界条件
- 数値安定性

を見ることが重要です。

### 例: 座標変換

```text
ECI
 ↓ transform
rotating
 ↓ inverse
ECI
```

で元へ戻るか。

### 例: 軌道

既知の円軌道で、一定時間後に半径・速度が想定範囲を保つか。

## 6. game tests

ゲーム層では、

- ステージ進行
- コマンド
- 操作対象
- ShipAssembly
- docking
- save / deserialize
- Viewer
- plan

などを検証します。

### 状態所有をテストする

「画面にそう見える」ではなく、モデル状態そのものを検証できるならそちらを優先します。

表示テストだけでは、たまたま表示が合っていて内部状態が壊れているケースを見逃します。

## 7. render tests

描画層では、CPU 側で検証できるものと目視が必要なものを分けます。

### 自動化しやすい

- 座標計算
- page table
- tile key
- material input
- LOD 判定
- resource lifetime
- color conversion

### 画像確認が必要

- 雲の質感
- 大気リム
- banding
- aliasing
- clipping
- 露出
- LOD の継ぎ目

## 8. launcher tests

launcher では、

- セーブスロット
- snapshot
- resume
- autosave
- stage transition
- unlock
- save transfer

などを確認します。

特に「現在の run を畳んでから次を開始する」という寿命順序が重要です。

## 9. settings tests

設定では、

- parse
- format
- default
- legacy migration
- storage key

を確認します。

保存文字列は既存ユーザーとの契約なので、format を変える場合は旧値の読み込みも考えます。

## 10. boundary check

```bash
npm run check:boundaries
```

`tools/check-boundaries.mjs` が import 境界などを検査します。

対象は、例えば、

- physics → game の逆依存
- device → model の依存
- 禁止されたフォルダ間 import
- src 直下への不適切な追加

などです。

### boundary check の位置づけ

これはアーキテクチャそのものではなく**自動検査可能な部分の代理**です。

通過しても、

- 正本が二重
- mutable state の所有者が曖昧
- device が間接的に意味を知る

といった問題は残りえます。

## 11. ESLint

```bash
npm run lint
```

一般的な構文・スタイルに加え、リポジトリ独自ルールが `tools/eslint-rules/` にあります。

Lint を「警告を消す作業」とだけ考えず、設計意図を機械的に守る仕組みとして読みます。

## 12. build

```bash
npm run build
```

本番用成果物を生成します。

開発サーバーで動くコードでも、

- asset path
- chunk
- production define
- minify
- GitHub Pages の base path

などで本番ビルドだけ失敗することがあります。

## 13. browser smoke

```bash
npm run smoke:browser
```

`tools/browser-smoke.mjs` はブラウザを起動して、最低限のロード・操作を確認するためのスモークテストです。

unit test では、

- WebGPU 初期化
- DOM
- event listener
- asset loading
- page navigation

の統合不具合を検出できません。

## 14. verify release

`tools/verify-release.mjs` は公開成果物の整合を確認するためのツールです。

release は CI が生成するため、ソースが正しくても公開物の組み立てが壊れていないかを見る必要があります。

## 15. UI style verification

`verify-ui-style.mjs` は UI のスタイル規約を自動確認する入口です。

UI は CSS を書けば終わりではなく、テーマ変数、色、レイアウト規則などの契約を持ちます。

## 16. theme contrast

`verify-theme-contrast.mjs` はテーマ色のコントラストを検査します。

タイトル画面や HUD は暗背景とアクセント色を多用するため、テーマ追加で文字が読めなくならないようにします。

## 17. dependency metrics

`dep-metrics.mjs` は依存関係を定量的に見るための道具です。

巨大なファイルや依存集中は、それだけで悪ではありませんが、責務が集まり過ぎていないかを調査する手掛かりになります。

## 18. perf probe

`perf-probe.mjs` は性能計測の入口です。

性能問題では、体感だけでなく、

- CPU
- GPU
- entity count
- draw call
- tile requests
- prediction
- frame phase

など、どこに時間が使われているかを分けます。

## 19. Render Lab

```bash
npm run render-lab
```

ゲーム全体から独立して描画を試す環境です。

### shot

```bash
npm run render-lab:shot
```

結果を画像として保存します。

### compare

```bash
npm run render-lab:compare
```

変更前後などを比較します。

## 20. Cloud Lab

```bash
npm run cloud-lab
```

雲専用の検証環境です。

雲は、

- 形
- 被覆率
- 高度
- 光学
- 時間変化
- 地球曲率
- 観測角度

が絡むため、独立環境が有効です。

## 21. cloud shot

```bash
npm run cloud-lab:shot
```

特定条件の雲を撮影し、変更前後を固定視点で比較できます。

## 22. cloud compare

```bash
npm run cloud-lab:compare
```

生成結果と参照画像を統計的に比較します。

「リアルに見える」を完全に数値化することはできませんが、

- 被覆率
- 分布
- 輝度
- 構造スケール

のような量は比較できます。

## 23. cloud separate

```bash
npm run cloud-lab:separate
```

実写雲画像から、被覆率・高度・薄い雲などの仮入力を分離するための処理です。

参照画像そのものをゲームで使うのではなく、モデル検証用の材料へ変換します。

## 24. Earth surface tools

`tools/earth-surface/` は地球表面データの処理・配信・検証を行います。

地球表面はデータ量が大きいため、

- source
- bake
- package
- pages
- serve
- capture
- contract test

のように段階を分けます。

## 25. 地球表面の契約

地球表面では、コードと外部配信データが同じフォーマット契約を理解する必要があります。

コードだけテストしても、実データの manifest やページ配置が違えば表示できません。

そのため contract test が重要です。

## 26. ephemeris tools

`tools/ephemeris/` は天体暦データの取得・変換に関係します。

天体暦では、

- time scale
- epoch
- frame
- unit

を間違えると、数値は正常に見えても天体位置が大きくずれます。

## 27. orbit catalog

`fetch-orbit-catalog.mjs` と軌道関連ツールは、参照軌道データを取得・生成します。

`export-lagrange-orbits.mjs` や `orbit-family.mjs` はラグランジュ点近傍軌道のデータ作成・調査に使われます。

## 28. coastline / climate

`fetch-coastline-source.mjs`、`export-coastline.mjs`、`fetch-climate-source.mjs`、`export-climate.mjs` は地球データをゲーム用形式へ変換します。

外部データは、

```text
取得
 ↓
正規化
 ↓
ゲーム用形式へ変換
 ↓
検証
 ↓
配信
```

という流れで考えます。

## 29. protein builder

`tools/protein-builder/` はタンパク質型敵の構造データを扱います。

外部構造データをそのまま runtime へ読ませるのではなく、必要な形式へ生成・検証します。

関連 script には、

- fetch source
- generate
- validate
- motion
- catalog

があります。

## 30. model builder

`tools/model-builder/` はモデル生成に関係するツールです。

生成結果だけを手編集せず、元になる定義と生成経路を確認します。

## 31. generated assets

生成物を更新するときは、

1. 正本を確認
2. generator を確認
3. generator を実行
4. 差分を確認
5. 不要な ID 差分を除外
6. 対応テスト

の順が安全です。

## 32. 性能テスト

`tests/perf/` は性能上の退行を検出するためのテスト領域です。

性能値は実行環境で揺れるため、単一の絶対時間だけでなく、処理件数やアルゴリズム上の上限を見るテストも有効です。

## 33. CI を読む

CI を理解するときは「何を順に実行するか」だけでなく、**どの契約を守るための段か**を見ます。

代表的には、

- style
- lint
- boundary
- typecheck
- tests
- data validation
- build
- release verification
- browser smoke

です。

## 34. 失敗の切り分け

### typecheck 失敗

型・境界・API の問題。

### test 失敗

モデル・計算・不変条件の問題。

### build 失敗

bundle・asset・production 設定。

### browser smoke 失敗

統合・初期化・ブラウザ環境。

### image compare 失敗

見た目の退行。

## 35. PR 前の最低確認

main へ送る前は、少なくとも、

- 差分一覧
- 不要ファイル
- typecheck
- 全テスト
- build
- boundary
- PR 本文
- mergeability

を確認します。

---

<p align="center">
  <a href="08-development-workflow.md"><strong>← 08. 開発方針</strong></a>
  ·
  <a href="README.md"><strong>WIKI 目次</strong></a>
  ·
  <a href="10-reading-guides.md"><strong>10. 読み方・調査手順 →</strong></a>
</p>

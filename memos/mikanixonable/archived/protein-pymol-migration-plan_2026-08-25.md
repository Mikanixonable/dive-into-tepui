# タンパク質の立体化を PyMOL へ置き換える計画(2026-08-25)

## 目的

タンパク質のビルド時アセット生成は、PDB/mmCIF の解析・二次構造の判定・共有結合の推定・分子表面の
生成を、すべて `tools/protein-builder/` の自前コードで行っている。この自前実装が、次の形で
**正確性と安定性の両方を損なっている。**

**正確性の欠陥(いずれも実測で確認済み)**

- **残基番号が2つのアセットで食い違う。** mmCIF を入力とする 6N2Y で、backbone アセットは
  `label_seq_id`(最大 501)、structure アセットは `auth_seq_id`(最大 616)を残基番号として
  書き出している。同じ残基を指す番号が2系統あり、どちらが正本か決まっていない。
- **二次構造が寄託ファイルの著者注釈に依存している。** `HELIX`/`SHEET` レコードをそのまま採用して
  おり、著者ごとに基準が違う注釈が、そのままリボンの断面形状(oval / rectangle / rope)になる。
  6N2Y では残基の 58.6% が helix、12.7% が sheet と判定されている。さらに、開始鎖と終了鎖が
  異なるシート範囲は判定条件から外れて coil に落ちる。
- **mmCIF パーサが仕様の一部しか読めない。** セミコロン区切りの複数行テキスト値を扱わないことを
  自ら明記しており、そこに当たる構造は静かに欠落する。
- **共有結合が距離のヒューリスティックで決まる。** 連続する残基の間は、原子の種類を問わず 1.9 Å
  以内の全ペアを結合とみなしており、ペプチド結合以外の偽の結合が入りうる。
- **分子表面が近似であることを資産自身が宣言している。** 原子の van der Waals 球と 1.4 Å プローブの
  和を marching tetrahedra で等値面化したもので、`approximate: true` を立て、
  「非多様体の辺は修復せず検証エラーのまま残す」と注記している。

**安定性の欠陥**

- **アセットが巨大で、その巨大さが精度の妥協を強制している。** structure アセット4件の合計は
  124.5 MB(6N2Y 単体で 62.7 MB)。生成コードには「大型複合体は既定の 1.25 Å 格子だと表面メッシュが
  数百万頂点になり型検査のヒープを超える」ため格子を粗くできるようにした、という注記があり、
  6N2Y と 8RUC は実際に 1.5 Å へ粗くしてある。**サイズ問題を回避するために表面の解像度を
  落としている。**
- **ネットワークが落ちると、黙って別物を作る。** `--network` の取得に失敗すると警告を1行出すだけで
  Cα と O だけの `backbone-proxy` へ切り替わる。この経路では全残基が `UNK` になり、疎水性と電荷が
  すべて 0 になる。生成が再現しない。

この計画は、解析・二次構造判定・結合推定・分子表面生成を **PyMOL(open-source 版)へ置き換え、
入力の原構造ファイルをリポジトリへ取り込んで生成を再現可能にする。**

## 決めたこと

**1. PyMOL を使うのはビルド時だけで、ランタイムの描画は一切変えない。**

リボンの生成(`src/render/protein-ribbon.ts`)、断面形状、three.js / WebGPU の描画経路は変更しない。
`DEVELOP/SPEC/PROTEIN.md` が定める断面の意匠(ヘリックス幅 2.0 Å 厚 0.4 Å の oval、C 末端へ収束する
矢印、隣接断面の 180° 反転禁止)は PyMOL の標準表現には無く、置き換えても書き直しになるため。

覆された場合 — リボン生成まで PyMOL へ寄せるなら、手順 3 の範囲が
`src/render/protein-ribbon.ts` と `src/render/protein-collision-ribbon.ts` へ広がり、
衝突形状の一致検証が別途要る。

**2. アセットの JSON スキーマは維持し、ランタイム側の型と読み出しコードは変えない。**

structure / backbone / semantic / motion の4アセットの構造を保つ。ただし **ランタイムがどこからも
読んでいないフィールドは削除する**(手順 6)。

覆された場合 — スキーマを作り直すなら、`src/game/protein/protein-display-asset.ts`、
`src/render/protein-ribbon.ts`、`src/render/protein-atom-view.ts`、
`src/render/protein-silhouette-view.ts`、`src/render/protein-collision-ribbon.ts`、
`src/render/protein-ribbon-color.ts` の読み出しを全て追随させる手順が増える。

**3. PyMOL は `pymol-open-source-whl` を pip で `.venv-protein-builder` へ入れる。**

`tools/protein-builder/run-all.mjs` は既に `.py` スクリプトを `.venv-protein-builder/bin/python`
(無ければ `python3`、`PROTEIN_PYTHON` で上書き可)へ振り分けており、`requirements-lock.txt` で
numpy / scipy をバージョン固定している。**PyMOL はこの既存の Python 境界に乗せるだけで済む。**
`pymol-open-source-whl` は Linux / macOS / Windows のビルド済み wheel を配布しているため、
ソースからのコンパイルは要らない。ライセンスは BSD 系で、配布物への制約は無い。

覆された場合 — conda / Homebrew での導入にするなら、手順 2 が `requirements-lock.txt` への追記
ではなく導入手順の文書化に変わり、CI で `npm run ci` を回す前提が崩れる。

**4. 二次構造は PyMOL の `dss` による判定へ切り替える。**

寄託ファイルの著者注釈をやめ、座標から判定する。**リボンの見た目が変わる。**
このため仕様の更新を最初の手順に置く。

覆された場合 — 寄託注釈を維持するなら手順 1 と、手順 3 の二次構造部分が不要になる。ただし
鎖をまたぐシート範囲が coil に落ちる欠陥は残るので、その修正を別に立てる。

**5. 分子表面は PyMOL の solvent-excluded surface(分子表面)へ切り替える。**

現行は原子球と 1.4 Å プローブの和の等値面、つまり solvent-accessible surface に相当する。
PyMOL の既定は solvent-excluded surface で、**溝が見えるぶん形が締まる。見た目が変わる。**

覆された場合 — 現行の見た目を保つなら PyMOL 側で `set surface_solvent, 1` を指定する。手順の
構成は変わらない。

**6. 原構造ファイル(PDB / mmCIF)をリポジトリへ取り込み、生成をネットワークから切り離す。**

`assets-src/proteins/<id>/` へ原本を置き、生成は常にそれを読む。ネットワーク取得は
「原本を更新するとき」だけの別コマンドにする。これにより `backbone-proxy` フォールバックを
廃止できる。現在コミットされている4アセットはすべて `coverage: all-atom` で、フォールバックは
実際には使われていない。

覆された場合 — 原本を置かない方針なら、生成の再現性は担保できないので `--check` を CI から外す
必要がある。

## 達成目標

全手順の完了時、以下がすべて満たされている。

1. `rg -n "parseMmcifLoop|parsePdb|parseCif|fallbackAtoms|inferBonds|surfaceField" tools src` が **0 件**。
2. `tools/protein-builder/mmcif-format.mjs` と `tools/protein-builder/fetch-pdb-backbone.mjs` が
   **存在しない**。
3. `rg -n "backbone-proxy|existing-backbone-fallback|surfaceGridSpacingAngstrom" tools src assets-src` が
   **0 件**。
4. 6N2Y の backbone アセットと structure アセットの残基番号が **同一の番号系** になる
   (両者の最大残基番号が一致する)。
5. `npm run protein:generate-structure` と `npm run protein:generate` が **ネットワークを切った状態で
   完走し**、再実行しても `--check` が差分なしで通る。
6. `npm run protein:validate-structure` が 4 アセットすべてで
   **boundary edge 0 / non-manifold edge 0 / degenerate triangle 0** で通る。
7. structure アセット 4 件の合計サイズが **124.5 MB から 50 MB 未満** へ下がる。
8. 全 `protein.config.json` から `surfaceGridSpacingAngstrom` が消え、**表面の解像度が
   サイズ都合で粗くされていない**。
9. `npm run ci` が通る。
10. `npm run render-lab:shot` で 4 タンパク質の見た目を撮影し、リボン・表面・分子模型が
    破綻していない(欠損した鎖、裏返った面、消えた部位マーカーが無い)。

## 手順

### 手順 1. 構造データの由来を仕様へ書く

**目的**

二次構造の判定根拠を著者注釈から座標由来の判定へ、表面を solvent-accessible から
solvent-excluded へ変える。どちらもリボンと表面の見た目を変えるので、**何をどう見せるべきかを
先に確定させる。** この手順ではコードを変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `DEVELOP/SPEC/PROTEIN.md`「表示」節 | 二次構造は寄託ファイルの注釈ではなく座標から判定する、と書く。鎖をまたぐ範囲の扱いも明記する |
| `DEVELOP/SPEC/PROTEIN.md`「表示」節 | 表面は溶媒排除表面(プローブ半径 1.4 Å)であると書く。現行の「原子球の和」という定義を置き換える |
| `DEVELOP/SPEC/PROTEIN.md`「表示」節 | 残基番号は寄託ファイルの著者番号(`auth_seq_id` に相当)を正本とする、と書く |
| `CLAUDE.md`「タンパク質を1体追加する」 | 手順 2〜6 で確定する新しいコマンド列へ差し替える(この手順では下書きのみ、最終形は手順 6 で確定) |

**達成条件と検証**

- `DEVELOP/SPEC/PROTEIN.md` に上記3点が書かれている。
- `rg -n "溶媒排除|著者番号|座標から判定" DEVELOP/SPEC/PROTEIN.md` が 3 件以上を返す。
- `npm run typecheck` が通る(コード変更が無いことの確認を兼ねる)。

### 手順 2. 原構造ファイルを取り込み、PyMOL の実行境界を用意する

**目的**

生成の入力をネットワークからリポジトリ内のファイルへ移し、PyMOL を既存の Python 境界へ載せる。
**この時点で生成ロジックは変えず、既存アセットは1バイトも変わらない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `tools/protein-builder/requirements-lock.txt` | `pymol-open-source-whl` をバージョン固定で追記する(現在は numpy と scipy の2行) |
| `assets-src/proteins/1mbn/1MBN.pdb`(新規) | RCSB の原本を取り込む |
| `assets-src/proteins/5i4r/5I4R.pdb`(新規) | 同上 |
| `assets-src/proteins/6n2y/6N2Y.cif`(新規) | 同上 |
| `assets-src/proteins/8ruc/8RUC.pdb`(新規) | 同上 |
| `assets-src/proteins/*/protein.config.json` | `sourceStructureFile` を追加する。`sourceStructureUrl` は原本の更新元として残す |
| `tools/protein-builder/fetch-source-structure.mjs`(新規) | `sourceStructureUrl` から `sourceStructureFile` へ落とす。原本を更新するときだけ走らせる |
| `tools/protein-builder/run-all.mjs` :13 | `supportedActions` へ `fetch-source` を追加する |
| `tools/protein-builder/run-all.mjs` :38-47 | `commandFor` に `fetch-source` の分岐を足す |
| `package.json` scripts | `protein:fetch-source` を追加する |
| `CLAUDE.md`「タンパク質を1体追加する」 | `.venv-protein-builder` の作り方(`python3 -m venv` と `pip install -r tools/protein-builder/requirements-lock.txt`)を書く |

**達成条件と検証**

- `.venv-protein-builder/bin/python -c "import pymol; from pymol import cmd; print(cmd.get_version()[0])"` が
  バージョン文字列を出す。
- `git status --porcelain src/assets/models/` が **空**(既存アセットが変わっていない)。
- `npm run protein:fetch-source` を走らせても `assets-src/proteins/*/` の原本に差分が出ない。
- `npm run typecheck` が通る。

### 手順 3. backbone アセットの生成を PyMOL へ置き換える

**目的**

PDB / mmCIF の解析と二次構造の判定を PyMOL に任せ、残基番号を著者番号へ一本化する。
**リボンの二次構造が変わるため、見た目が変わる最初の手順。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `tools/protein-builder/extract-backbone.py`(新規) | `cmd.load` → `cmd.dss` → `cmd.iterate_state` で Cα と カルボニル O、鎖、entity、B-factor、二次構造、著者残基番号を取り出し、全原子重心で中心化して現行と同じ JSON を書く |
| `tools/protein-builder/fetch-pdb-backbone.mjs`(178 行) | **削除する** |
| `tools/protein-builder/mmcif-format.mjs` (60 行) | `generate-protein-structure.mjs` がまだ使うため、この手順では残す(削除は手順 4) |
| `tools/protein-builder/run-all.mjs` :13, :38-47 | `backbone` アクションを追加し、`extract-backbone.py` へ振り分ける |
| `package.json` scripts | `protein:backbone` を追加する |
| `tools/protein-builder/protein-content-hash.mjs` | `backboneContentHash` の対象フィールドが変わらないことを確認する。変わるなら追随させる |
| `src/assets/models/*Backbone.json`(4 件) | 再生成する |
| `src/assets/models/*Motion.json`(4 件) | **再生成する。** backbone のハッシュを参照しているため、再生成しないと読み込み時に不整合になる |
| `src/game/protein/protein-asset-catalog.generated.ts` | `npm run protein:catalog` で更新する |

**達成条件と検証**

- 6N2Y の backbone と structure の残基番号系が揃う。
  `node -e "const b=require('./src/assets/models/atpSynthase6n2yBackbone.json'),s=require('./src/assets/models/atpSynthase6n2yStructure.json');console.log(Math.max(...b.backboneResidueNumbers),Math.max(...s.atoms.residueNumbers))"`
  が **同じ値を2つ**出す(置き換え前は `501 616`)。
- `rg -n "parseMmcifLoop" tools/protein-builder/fetch-pdb-backbone.mjs` が
  **ファイルごと存在しない**ことで 0 件になる。
- `npm run protein:validate` と `npm run protein:motion:validate` が 4 件とも通る。
- `npm run protein:generate:check` が差分なしで通る。
- `npm run typecheck` が通る。
- `npm run render-lab:shot` を撮り、**4 タンパク質のリボンで、ヘリックスの oval とシートの矢印が
  以前より座標に沿って割り当てられていること**、鎖の切断が増えていないことを目で見る。

### 手順 4. structure アセットの原子と結合を PyMOL へ置き換える

**目的**

全原子の解析と共有結合の決定を PyMOL に任せ、距離ヒューリスティックによる偽の結合をなくす。
表面生成はこの手順では触らない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `tools/protein-builder/extract-structure.py`(新規) | `cmd.load` → `cmd.get_model()` で原子(座標・元素・残基名・著者残基番号・鎖・entity・B-factor)と結合表(`model.bond`)を取り出し、JSON へ書く |
| `tools/protein-builder/generate-protein-structure.mjs` :38-87 `parsePdb` | **削除する** |
| `tools/protein-builder/generate-protein-structure.mjs` :89-115 `parseCif` | **削除する** |
| `tools/protein-builder/generate-protein-structure.mjs` :117-139 `fallbackAtoms` | **削除する**(手順 2 で原本を取り込んだためフォールバックが不要になる) |
| `tools/protein-builder/generate-protein-structure.mjs` :141-193 `addBond` / `inferBonds` | **削除する** |
| `tools/protein-builder/generate-protein-structure.mjs` :541-558 | ネットワーク分岐とフォールバック分岐を削除し、`extract-structure.py` の出力を読む形にする |
| `tools/protein-builder/generate-protein-structure.mjs` :526-527 | `coverage` を常に `all-atom`、`approximate` を常に `false` にする |
| `tools/protein-builder/generate-protein-structure.mjs` :533 | `bonds.inference` を PyMOL 由来である旨へ書き換える |
| `tools/protein-builder/mmcif-format.mjs` (60 行) | **削除する**(最後の利用者が消える) |
| `tools/protein-builder/run-all.mjs` :38-47 | `generate-structure` が Python を先に走らせる形へ変える |
| `src/assets/models/*Structure.json`(4 件) | 再生成する |
| `src/assets/models/*Motion.json`(4 件) | **再生成する**(structure のハッシュを参照しているため) |
| `src/game/protein/protein-asset-catalog.generated.ts` | `npm run protein:catalog` で更新する |

**達成条件と検証**

- `rg -n "parsePdb|parseCif|fallbackAtoms|inferBonds|parseMmcifLoop" tools src` が **0 件**。
- `ls tools/protein-builder/mmcif-format.mjs` が **失敗する**。
- `rg -n "backbone-proxy|existing-backbone-fallback" tools src` が **0 件**。
- 4 アセットすべてで `coverage` が `all-atom`、`approximate` が `false`。
- **ネットワークを切った状態で** `npm run protein:generate-structure` が 4 件とも完走する。
- `npm run protein:validate-structure` が 4 件とも通る。
- `npm run typecheck` が通る。
- `npm run render-lab:shot` を撮り、**分子模型表示で結合線が原子間だけに引かれていること**、
  離れた原子をまたぐ線が無いことを目で見る。

### 手順 5. 分子表面の生成を PyMOL へ置き換える

**目的**

自前の marching tetrahedra を捨て、PyMOL の溶媒排除表面へ移す。
**非多様体の辺と境界の辺を、生成側の後処理ではなく元の実装の質で解消する。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `tools/protein-builder/extract-structure.py` | `set surface_solvent, 0` と `set surface_quality` を設定し、`cmd.show("surface")` の後 `cmd.dump` で三角形を取り出す。`dump` は三角形ごとに3頂点を重複して吐くため、**座標を量子化して溶接し、共有頂点のインデックス配列を作る** |
| `tools/protein-builder/extract-structure.py` | 頂点ごとの `charge` / `hydrophobicity` / `component` を最近傍原子から決める。現行 `generate-protein-structure.mjs` :195-200 `residueFields`(Kyte-Doolittle 疎水性と形式電荷)と同じ換算を Python 側へ移す |
| `tools/protein-builder/generate-protein-structure.mjs` :202-489 `surfaceField`(288 行) | **削除する** |
| `tools/protein-builder/generate-protein-structure.mjs` :473-488 | `surface` の組み立てを、PyMOL 由来のメッシュを詰めるだけの形にする。`metadata.method` を書き換え、`metadata.approximate` を落とす |
| `assets-src/proteins/6n2y/protein.config.json` | `surfaceGridSpacingAngstrom: 1.5` を削除し、`surfaceQuality` へ置き換える |
| `assets-src/proteins/8ruc/protein.config.json` | 同上 |
| `src/assets/models/*Structure.json`(4 件) | 再生成する |
| `src/assets/models/*Motion.json`(4 件) | **再生成する** |
| `src/game/protein/protein-asset-catalog.generated.ts` | `npm run protein:catalog` で更新する |

**達成条件と検証**

- `rg -n "surfaceField|marching tetrahedra|surfaceGridSpacingAngstrom" tools src assets-src` が **0 件**。
- `npm run protein:validate-structure` が 4 件とも通り、出力に
  **`boundary edge` / `non-manifold edge` / `degenerate triangle` のいずれも現れない**。
- `npm run typecheck` が通る。
- `npm run render-lab:shot` を撮り、**シルエット表示で表面に穴・裏返った面・自己交差が無いこと**、
  溝が見えて形が締まっていることを目で見る。

### 手順 6. アセットを縮め、ランタイムが読まないフィールドを落とす

**目的**

**表面の解像度をサイズの都合で粗くする必要をなくす。** 整形された JSON の行あたりの余白と、
ランタイムがどこからも読んでいないボクセル配列が、アセットの大半を占めている。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `tools/protein-builder/generate-protein-structure.mjs` :564 | `JSON.stringify(encoded, null, 2)` をやめ、`atoms` と `surface.mesh` の数値配列だけ1行へ畳む直列化にする。トップレベルのキーは1行ずつ保ち、差分を読めるままにする |
| `tools/protein-builder/generate-protein-structure.mjs` :473-476 | `surface.grid` / `sampleIndices` / `surface.hydrophobicity` / `surface.surfaceCharge` を出力から**削除する**(ランタイムのどこからも読まれていない。読まれているのは `surface.mesh` の position / index / charge / hydrophobicity / component のみ) |
| `tools/protein-builder/validate-protein-structure.mjs` :19-22 | `surface.grid` と `sampleIndices` を必須とする検査を削除する。メッシュ検査(:23-65)は残す |
| `src/game/protein/protein-display-asset.ts` :28-30 | 型から `surface.grid` / `sampleIndices` / `hydrophobicity` / `surfaceCharge` の宣言を削除する |
| `src/game/protein/protein-display-asset.ts` :35-50 | `assertProteinDisplayAsset` が削除したフィールドを見ていないことを確認する |
| `src/assets/models/*Structure.json`(4 件) | 再生成する |
| `src/assets/models/*Motion.json`(4 件) | **再生成する** |
| `src/game/protein/protein-asset-catalog.generated.ts` | `npm run protein:catalog` で更新する |
| `CLAUDE.md`「タンパク質を1体追加する」 | 手順 2〜5 で確定したコマンド列へ差し替える |

**達成条件と検証**

- `du -ch src/assets/models/*Structure.json | tail -1` が **50 MB 未満**(置き換え前は 124.5 MB)。
- `rg -n "sampleIndices|surfaceCharge|surface\.grid" src tools` が **0 件**。
- `rg -n "surfaceGridSpacingAngstrom" assets-src tools src` が **0 件**。
- `npm run typecheck` が **`NODE_OPTIONS` のヒープ拡張なしで**通る。
- `npm run protein:validate-structure` が 4 件とも通る。
- `npm run ci` が通る。
- `npm run render-lab:shot` を撮り、4 タンパク質すべてでリボン・表面・分子模型・部位マーカーが
  出ていることを目で見る。

## 見積り

### 削除・新規のコード量

削除対象は実測で以下のとおり。

| 対象 | 行数 |
| --- | --- |
| `fetch-pdb-backbone.mjs` 全体 | 178 |
| `mmcif-format.mjs` 全体 | 60 |
| `generate-protein-structure.mjs` `parsePdb` (:38-87) | 50 |
| `generate-protein-structure.mjs` `parseCif` (:89-115) | 27 |
| `generate-protein-structure.mjs` `fallbackAtoms` (:117-139) | 23 |
| `generate-protein-structure.mjs` `addBond` / `inferBonds` (:141-193) | 53 |
| `generate-protein-structure.mjs` `surfaceField` (:202-489) | 288 |
| **合計** | **679** |

新規は `extract-backbone.py`(座標取り出しと二次構造で 80 行程度)と
`extract-structure.py`(原子・結合・表面・頂点溶接・最近傍原子の場で 180 行程度)、
`fetch-source-structure.mjs`(40 行程度)で **約 300 行**。差し引き **約 380 行の純減。**

`generate-protein-structure.mjs` は 576 行から、残る `residueFields`(:195-200)と
`encodeStructure`(:491-539)と入出力を中心に **約 130 行**へ縮む。

### アセットサイズ

現行(整形 JSON)と、1行へ畳んだ場合の実測値。

| アセット | 現行 | 畳んだ場合 | ボクセル配列削除後の見込み |
| --- | --- | --- | --- |
| `atpSynthase6n2yStructure.json` | 62.7 MB | 25.5 MB | 約 23 MB |
| `rubisco8rucStructure.json` | 31.8 MB | — | 約 12 MB |
| `pdb5i4rStructure.json` | 25.9 MB | — | 約 9 MB |
| `myoglobin1mbnStructure.json` | 4.1 MB | — | 約 1.5 MB |
| **合計** | **124.5 MB** | — | **約 46 MB** |

導出 — 6N2Y で整形 62.7 MB に対し `JSON.stringify` の余白を落とすと 25.5 MB(**−59.4%**、実測)。
うちランタイム未使用のボクセル配列(`sampleIndices` 241,377 要素、`hydrophobicity`、`surfaceCharge`)は
整形時 5.2 MB(全体の 8%)で、畳んだ状態では約 2.6 MB。よって 25.5 − 2.6 ≈ 23 MB。
他の3件は同じ 8〜9% のボクセル比率と同等の余白率を当てはめた。**表面の三角形数が現行と同程度
である前提**で、PyMOL 側の解像度を上げれば比例して増える。

### 生成時間

現行の表面生成は格子の全ボクセルで場の値を求め、内側のボクセルごとに最近傍原子を引く。

| アセット | 格子 | ボクセル数 | 四面体数 |
| --- | --- | --- | --- |
| `atpSynthase6n2y` | 83×90×149 | 1,113,030 | 6,480,624 |
| `rubisco8ruc` | 93×92×69 | 590,364 | 3,415,776 |
| `pdb5i4r` | 86×82×89 | 627,628 | 3,635,280 |
| `myoglobin1mbn` | 40×37×37 | 54,760 | 303,264 |

PyMOL の表面生成は原子球の交差から直接三角形を張るため、格子の全走査が消える。
一方で **PyMOL プロセスの起動とファイル受け渡しが1タンパク質あたり定数で乗る。**
`npm run protein:generate-structure` は4件を直列に回すため、置き換え後の総時間は
「PyMOL 起動 4 回 + 表面生成 4 回 + JSON 直列化 4 回」で決まる。**実測してから
この節の数字を置き換える。**

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| motion アセットは backbone と structure の `contentHash` を参照している。backbone / structure を再生成して motion を再生成しないと、ハッシュ照合に落ちる | ゲーム起動時にアセット読み込みが失敗し、タンパク質敵が出ない | 手順 3・4・5・6。各手順の再生成に motion を必ず含める。`npm run protein:motion:validate` で検出 |
| `cmd.dump` は三角形ごとに3頂点を重複して吐く。座標の丸め方を誤ると溶接に失敗し、隣接三角形が別頂点を持つ | 検証器が `boundary edge` を報告する。表面に髪の毛のような裂け目が出る | 手順 5。`npm run protein:validate-structure` の `boundary edge` 件数で検出 |
| PyMOL の `save .obj` はカメラ座標系で書き出す。`dump` と取り違えると全体が回転・平行移動した表面になる | 表面がリボンから完全にずれる。それ以外は正常に見えるため気付きにくい | 手順 5。`render-lab:shot` のシルエット表示で、表面がリボンを包んでいるかを目で見る |
| structure と backbone は別々に全原子重心で中心化している。PyMOL 側で水分子や代替配座の除外条件が2つのスクリプトでずれると、重心がずれて2つのアセットが平行移動でずれる | 原子・結合とリボンが噛み合わない。部位マーカーが構造の外へ出る | 手順 3・4。両スクリプトで同じ選択式を使い、`coordinateFrame.centeredAt` を目視で突き合わせる |
| `cmd.dss` の判定は寄託注釈と一致しない。6N2Y は現在 helix 58.6% / sheet 12.7% だが、この比率が動く | リボンの断面形状が広範囲で変わる。仕様どおりだが、意図しない変化と区別が付かない | 手順 3。`backboneSecondary` の比率を置き換え前後で出して差を確認し、`render-lab:shot` で目で見る |
| PyMOL は `HETATM` のリガンドや金属イオンを既定の選択から外す設定がある。除外すると原子数が減る | 分子模型からリガンドが消える。`buildProteinLigands` が空になる | 手順 4。`atoms.count` を置き換え前後で比較する(現行 6N2Y 35,043、8RUC 18,848、5I4R 8,941、1MBN 1,260) |
| `pymol-open-source-whl` の wheel は Python のマイナーバージョンごとにビルドされる。`.venv-protein-builder` の Python が対象外だと pip がソースビルドへ落ちて失敗する | 手順 2 が環境ごとに通ったり通らなかったりする | 手順 2。`requirements-lock.txt` に対応 Python バージョンを注記し、`import pymol` の確認を達成条件に含める |
| PyMOL は代替配座(altLoc)の扱いが現行コードと違う。現行は空白 / `A` / `1` だけを採る | 原子数が増え、同じ位置に重なった原子が結合推定を汚す | 手順 4。`atoms.count` の増加として現れる。PyMOL 側で `alt ''+A` の選択式を明示する |
| 数値配列を1行へ畳むと、アセットの差分が1行の巨大な変更として出る | 再生成のたびに実質レビュー不能な差分になり、意図しない変化が紛れる | 手順 6。トップレベルのキーは1行ずつ保ち、`atoms.count` / `bonds.count` / 頂点数を別キーで持たせて差分から読めるようにする |
| `surface.grid` を消すと、現行の型 `ProteinDisplayAsset` を必須として読む箇所が型エラーになる | ビルドが落ちる(黙って壊れはしない) | 手順 6。`npm run typecheck` で必ず検出される |
| ネットワーク取得を別コマンドへ分離した結果、原本の更新を忘れたまま PDB 側が改訂される | 古い構造のまま気付かずに使い続ける | 手順 2。`fetch-source-structure.mjs` が取得後にハッシュ差分を報告する形にする |
| 表面の解像度を上げられるようになった結果、三角形数が増えてアセットが再び肥大する | 型検査のヒープを再び超える | 手順 5・6。手順 6 の達成条件「合計 50 MB 未満」で歯止めにする |

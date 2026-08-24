# タンパク質立体構造を論文図へ近づける修正計画

対象コミット: `eccd4881`

## 目的

タンパク質型敵のランタイム Ribbon/Cartoon 表示を、構造生物学の論文で長く使われている表現へ
近づける。Cα 主鎖のトポロジーを読み取れることを最優先にし、αヘリックス、βストランド、
ループが形だけでも区別でき、二次構造境界が切れず、立体的な重なりを陰影から読める状態にする。

色には論文全体で共通する単一の標準がない。そのため、既存の表示形態と着色選択肢を削除・改名せず、
論文図で使いやすい鎖別の着色を新しい選択肢として追加する。形状と非金属のマットな材質は既存の
リボン表示そのものを修正し、どのリボン着色を選んでも同じ二次構造形状を使う。

表示用メッシュの形状変更で弾丸・接触の当たり判定が変わらないよう、表示用と衝突用のリボン生成を
先に分離する。ゲームルール、PDB 由来の座標・二次構造割り当て、分子模型、表面電荷・疎水性の
シルエット表示は変更対象にしない。

## 文献から採る基準

調査日は 2026-08-24。実装上の基準は次の一次資料・公式仕様から採る。

- Priestle の RIBBON は、αヘリックスを helical ribbon、βストランドを twisted arrow、
  random coil と reverse turn を滑らかな rope として定義している
  ([J. Appl. Cryst. 21, 572–576](https://doi.org/10.1107/S0021889888005746))。
- MOLSCRIPT は αヘリックスを helical ribbon、βストランドを太い矢印、ループを円筒状 coil とし、
  陰影で三次元性を与える
  ([J. Appl. Cryst. 24, 946–950](https://doi.org/10.1107/S0021889891004399))。
- ChimeraX の Cartoon 公式仕様は、Cα をガイド点とし、初期値を幅 2.0 Å・厚さ 0.4 Å、
  ヘリックスと coil を oval、strand を rectangle、断面分割を 12、βストランドの C 末端側の
  arrow scale を 2.0 としている
  ([Cartoon command](https://www.rbvi.ucsf.edu/chimerax/docs/user/commands/cartoon.html))。
- ChimeraX は chain、entity、residue 順の rainbow、B-factor など複数の着色を並列の選択肢として
  提供しており、単一の「論文標準色」は定めていない
  ([Color command](https://www.rbvi.ucsf.edu/chimerax/docs/user/commands/color.html))。
- 新しい鎖別プリセットには、順序を意味しないカテゴリへ使う固定色として ColorBrewer Set2 の
  8色を採る
  ([ColorBrewer](https://colorbrewer2.org/?type=qualitative&scheme=Set2&n=8))。

## 決めたこと

この節の判断は計画レビュー時に覆せる。覆された場合は、括弧内の手順を修正する。

1. **実装の正本は Three.js のランタイム Ribbon とする。** ゲームが実際に読む Cα・カルボニル
   酸素・PDB の `HELIX` / `SHEET` 注釈は既に生成済み JSON に揃っている。Blender/Molecular Nodes
   の任意 GLB 経路や生成済み JSON は変更しない（手順2〜4）。
2. **αヘリックスは幅 2.0 Å・厚さ 0.4 Å の12分割した扁平 oval、βストランドは
   2.0 Å × 0.4 Å の rectangle、coil は直径 0.4 Å の円形 rope とする。** 長手方向は現行の
   1残基あたり12分割を維持する。βストランドだけ、C 末端側の最後2残基で最大2.0倍へ広がってから
   先端へ絞る。ヘリックスには矢印を付けない（手順3）。
3. **二次構造が変わっても主鎖を切らない。** 鎖境界または Cα 間が 8 Å を超える欠損だけを切断とし、
   helix/sheet/coil の境界では共通の中心点と chain-wide frame を共有する。カルボニル酸素方向を
   優先し、情報が退化した箇所だけ parallel transport で補う（手順3）。
4. **材質は非金属のマット表示にする。** リボンは `metalness = 0`、`roughness = 0.68`、
   smooth shading とし、現行の PBR ライトで陰影を付ける。発光、透明化、ワイヤーフレーム、
   輪郭線は追加しない（手順3）。
5. **新しい色モードを `publication`、表示名を「論文調（鎖別）」とする。** 色は chain ID ごとに
   ColorBrewer Set2 の `#66c2a5`, `#fc8d62`, `#8da0cb`, `#e78ac3`, `#a6d854`,
   `#ffd92f`, `#e5c494`, `#b3b3b3` を割り当てる。PDB の1文字 chain ID は A→1色目、
   B→2色目のアルファベット順で9鎖目から循環し、それ以外の ID は文字列の安定 hash で同じ8色へ
   写像する。リガンドは既存の元素色を保つ（手順4）。
6. **新規タンパク質の既定着色は `publication` にするが、既存セーブの明示値は変えない。**
   `chain`, `b-factor`, `entity`, `rainbow`, `secondary-structure`, `component-role` を含む既存の
   リボン着色はすべて残す。旧形式セーブで着色が欠けていた場合だけ、従来どおり `chain` として
   復元する（手順4）。
7. **衝突用リボンは現行形状を凍結する。** 表示プロファイルを論文図へ変更しても、衝突 BVH の
   三角形、外接半径、代表的な hit/miss は変更しない（手順2・3）。
8. **この計画の承認を、手順1に記す仕様文面の承認とみなす。** `/run-plan` ではその文面を
   `DEVELOP/SPEC/RENDERING.md` へ先に反映し、その後にコードへ着手する（手順1）。

## 達成目標

1. 5I4R と 1MBN のリボンで、αヘリックスが扁平 oval、βストランドが C 末端を向く明確な矢印、
   coil が細い円形 rope として描かれる。
2. 同一鎖内の二次構造境界で中心線の未接続が 0 件になり、隣接断面の向きが突然 180°反転する箇所が
   0 件になる。鎖境界と 8 Å 超の座標欠損だけは分離したままにする。
3. リボン材質の `metalness` が 0、`roughness` が 0.68 で、法線が有限かつ正規化可能である。
4. `proteinColorModesFor('ribbon')` が既存6モードをすべて含んだまま `publication` を追加で返し、
   Creative Stage の「着色」に「論文調（鎖別）」が追加される。
5. 新規生成の既定値は `ribbon + publication`、既存セーブの有効な色モードは同じ値で復元され、
   旧形式で色が無いセーブは `ribbon + chain` へ復元される。
6. 表示形状変更の前後で、5I4R と 1MBN の衝突用メッシュの三角形 fingerprint、外接半径、
   代表的な静止球・swept sphere の結果が一致する。
7. 5I4R の表示用リボンは 22万 triangle 以下に収まり、メッシュ再生成は生成時・表示形態変更時だけで、
   毎フレームの geometry 生成を増やさない。
8. Render Lab の 5I4R・1MBN ケースで、二次構造、鎖別色、リガンド、陰影を判読でき、
   前後面の欠落、ピンチ、隙間、Z-fighting が見えない。
9. `npm run typecheck`、`npm run test:physics`、`npm run ci` が通る。

## 手順

上から順に実施し、各手順を独立して commit できる状態で終える。

### 手順1. タンパク質 Ribbon の表示仕様を先に確定する

#### 目的

論文図へ寄せる形状、材質、着色、互換性、衝突不変の境界をコードより先に仕様へ置く。
この時点ではコードの挙動を変えない。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `DEVELOP/SPEC/RENDERING.md` | 「タンパク質立体構造」節を追加し、上記「決めたこと」2〜7を識別子なしの規範文として記載する |

#### 達成条件と検証

- 仕様本文が αヘリックス、βストランド、coil、二次構造境界、材質、既存色の保持、新しい鎖別色、
  衝突不変をそれぞれ明記している。
- `rg -n "タンパク質立体構造|αヘリックス|βストランド|衝突" DEVELOP/SPEC/RENDERING.md` が
  追加節の該当行を返す。
- `npm run typecheck` が通る。

### 手順2. リボン生成を分離し、衝突形状を凍結する

#### 目的

表示形状だけを安全に変更できる境界を作る。現行のリボン生成を専用モジュールへ移し、表示用と
衝突用に明示的な profile を渡す。この時点では描画・色・衝突の挙動を変えない。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `src/render/protein-ribbon.ts`（新規） | backbone 型、二次構造 run、frame、リボン/coil geometry、頂点色、リボン材質、リボン group 構築を移す。表示 profile と凍結した collision profile を定義する |
| `src/render/protein-enemy-ship.ts` | 分子模型・リガンド・シルエット・表示形態合成だけを残し、新モジュールの表示用リボンを呼ぶ。外部 export の互換性は保つ |
| `src/game/protein/protein-enemy-registry.ts` | `buildCollisionObject` を表示用 builder ではなく専用 collision builder へ接続する |
| `src/game/protein/protein-ribbon-collision.ts` | 「表示メッシュと同一」というコメントを、凍結した専用リボンから抽出する契約へ改める。BVH 計算自体は変えない |
| `tests/physics/protein-combat-state.test.ts` | 5I4R/1MBN の現行リボンの構成要素タグ、二次構造タグ、頂点色、リガンド保持を characterization test として固定する |
| `tests/physics/protein-ribbon-collision.test.ts` | 実アセットの collision builder から triangle fingerprint・外接半径・代表 hit/miss を記録し、分離前後で一致させる |

#### 達成条件と検証

- `src/render/protein-enemy-ship.ts` から `CatmullRomCurve3`, `TubeGeometry`, `RIBBON_SUBDIVISIONS`,
  `ribbonGeometry` の定義が 0 件になり、専用モジュールだけに存在する。
- 移動前に記録した 5I4R/1MBN の衝突 fingerprint と `outerRadius` が移動後も完全一致する。
- 表示用・衝突用のどちらも `proteinRibbon`, `proteinSecondary`, `proteinComponent`,
  `ownsGeometry`, `ownsMaterial` の既存タグを保つ。
- `npm run typecheck` と `npm run test:physics` が通る。

### 手順3. 表示用 Ribbon の形状と材質を論文図へ合わせる

#### 目的

二次構造ごとの断面と C 末端方向を形で読めるようにし、境界の隙間・frame の反転・金属的な反射を
解消する。collision profile は変更しない。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `src/render/protein-ribbon.ts` | 鎖/gap 単位の centerline と chain-wide frame を作り、二次構造 run が同じ境界点・向きを共有するよう再構成する。helix oval、sheet rectangle＋2倍 arrowhead、coil rope、0.4 Å 厚、マット材質を表示 profile に実装する |
| `tests/physics/protein-ribbon-geometry.test.ts`（新規） | 合成 backbone と実アセットで断面寸法、C 末端矢印、境界連続、frame 反転なし、有限法線、材質値、triangle 上限を検証する |
| `tests/physics/index.ts` | 新しい geometry test の `register` を追加する |

#### 達成条件と検証

- 合成 backbone の helix 断面が `2.0 × 0.4 Å`、sheet shaft が `2.0 × 0.4 Å`、coil が直径
  `0.4 Å` になり、浮動小数誤差を含む許容差 `1e-3 Å` 以内でテストが通る。
- sheet の C 末端側だけが最大 `2.0 × shaft width` へ広がって先端へ収束し、N 末端側には
  arrowhead が無い。
- 連続する異種 run の境界 center 間距離が `1e-6 Å` 以下で、隣接 width direction の内積が
  0 未満になる箇所が 0 件である。
- 全 geometry の position/normal/color が有限で、面積 `1e-10 Å²` 以下の縮退 triangle が
  0 件である。小さな合成 geometry には `validateGeometry(..., { checkCoplanarOverlap: false })` を
  適用し、cap 以外の open edge が無いことも確認する。
- 表示 profile の `metalness === 0`、`roughness === 0.68`、collision fingerprint が手順2の値と
  一致する。
- 5I4R の表示用リボンが 22万 triangle 以下である。
- `npm run typecheck` と `npm run test:physics` が通る。

### 手順4. 「論文調（鎖別）」を追加し、既存着色とセーブ互換を保つ

#### 目的

色の標準が一つではないことを設定構造へ反映し、既存の分析用着色を残したまま、論文図向けの
落ち着いた鎖別色を選べるようにする。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `src/game/protein/protein-display.ts` | `publication` 型・ラベル・リボン選択肢を追加する。新規既定値を `publication` にし、旧形式で値が欠けた場合は `chain`、有効な既存値はその値へ復元する |
| `src/render/protein-ribbon.ts` | Set2 の固定鎖別 palette と `publication` の色解決を追加する。既存6モードの分岐と色値は変更しない |
| `tests/physics/protein-combat-state.test.ts` | 既存6モード＋新規1モードの完全な配列、ラベル、各 chain の決定性、9鎖目の循環、新規既定値、旧セーブ復元を検証する |

#### 達成条件と検証

- `proteinColorModesFor('ribbon')` が次の順序を返す。

  `['publication', 'chain', 'b-factor', 'entity', 'rainbow', 'secondary-structure', 'component-role']`

- `PROTEIN_COLOR_LABELS.publication === '論文調（鎖別）'` で、Creative Stage のリボン着色欄に
  7項目すべてが表示される。既存項目のラベルと選択結果は変わらない。
- `DEFAULT_PROTEIN_DISPLAY` と `defaultProteinDisplayFor('ribbon')` は `publication`、
  旧形式の `undefined` は `chain`、既存6モードは同じモードへ復元される。
- 同じ chain ID はアセットや生成順に依存せず同じ Set2 色を返し、リガンドの元素色は変わらない。
- UI の確認前に `/ui-design` を通す。Creative Stage の右ドックを 1280×720 と 1920×1080 で開き、
  「着色」が折り返してもボタン文字が切れず、7項目すべてを選択できることを確認する。
- `npm run typecheck` と `npm run test:physics` が通る。

### 手順5. Render Lab の再現ケースを追加し、画像・回帰・負荷を締める

#### 目的

今後の形状変更を同じカメラ・照明・アセットで比較できるようにし、数値テストで拾えない陰影、
重なり、ピンチ、リガンドの見え方を固定した観察点で検査する。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `tools/render-lab/cases.ts` | `protein-5i4r-publication` と `protein-1mbn-publication` を追加する。各モデルを bounding box から自動 framing し、helix/sheet/coil とリガンドを判読できる固定姿勢にする |

#### 達成条件と検証

- `npm run render-lab:shot` が `.render-lab/shots/` に両ケースの prepass/forward/diff、計6枚を出す。
- `protein-5i4r-publication-prepass.png` で helix・sheet・coil が形で区別でき、β矢印が C 末端を向き、
  二次構造境界に背景色の隙間が無く、鎖が Set2 色で分離して見える。
- `protein-1mbn-publication-prepass.png` でヘリックスの扁平 oval と heme/Fe が同時に見え、
  メッシュの裏面消失、急な frame 反転、黒いピンチが無い。
- 両ケースで forward/prepass の差が形状欠落として現れず、diff はシェーディング経路差だけを示す。
- Render Lab の統計または geometry test で、5I4R が 22万 triangle 以下であることを再確認する。
- `/refactor` で責務境界と重複を、`/comment-cleanup` で新規コメントを監査する。
- 最終的に `npm run typecheck`、`npm run test:physics`、`npm run ci` を順に実行し、すべて成功する。

## 見積り

時間は環境と画像調整の反復回数に依存するため置かず、変更量と計算量で見積もる。

- 手順1: 仕様1ファイル、規範7項目。
- 手順2: 新規1ファイル、移動対象は `src/render/protein-enemy-ship.ts` のリボン関連およそ285行、
  接続変更3ファイル、characterization test 2群。挙動を変えない commit 1個。
- 手順3: 二次構造 profile 3種、frame 計算1系統、geometry test 7観点。形状変更 commit 1個。
- 手順4: 色モード1個、固定色8個、互換性ケース「新規既定1＋旧欠損1＋既存6」の8ケース。
- 手順5: Render Lab 2ケース × 3出力 = 6画像、最終検証コマンド3本。

5I4R の現行データを1残基12分割すると、longitudinal segment は helix 4,704、sheet 3,420、
coil 3,108。現行の4頂点 helix/sheet と12角形 coil の本体 triangle は、cap を除いて

`8 × (4,704 + 3,420) + 24 × 3,108 = 139,584`

である。提案形状は12角形 helix、4頂点 sheet、12角形 coil なので、

`24 × 4,704 + 8 × 3,420 + 24 × 3,108 = 214,848`

となり、現行比は `214,848 / 139,584 = 1.54`。cap と境界接続を含めても 22万以下を上限にする。
生成計算量は `O(longitudinal segments × cross-section vertices)` のままで、衝突メッシュは現行 profile
を使うため BVH の三角形数と起動時構築量は増えない。geometry は spawn・表示形態変更時だけ作り、
毎フレーム負荷は頂点数増加に伴う描画分だけである。

検証実行数は `npm run typecheck` が各手順1回で5回、`npm run test:physics` が手順2〜5で4回、
`npm run render-lab:shot` が1回、最終 `npm run ci` が1回。

## リスクと落とし穴

| リスク | 影響 | それが露見する場所 |
| --- | --- | --- |
| 二次構造 run ごとに spline と frame を独立計算したままにする | helix/coil、sheet/coil 境界に隙間または角度の飛びが残り、静止画の一方向では偶然隠れる | 手順3の境界距離・width direction テスト、手順5の5I4R画像 |
| カルボニル酸素方向の符号を各 sample で独立に選ぶ | リボンが途中で180°反転し、黒いピンチやねじれとして見える | 手順3の隣接内積テスト、手順5の1MBN画像 |
| β矢印を配列末尾へ付け、鎖の N→C 順を確認しない | 矢印が N 末端を指してトポロジーを逆に伝える | 手順3の非対称な合成 backbone テスト、手順5の固定姿勢画像 |
| 表示用 profile を既存 builder に上書きして衝突にも流用する | 見た目だけの変更で当たり判定、外接半径、接触距離が無言で変わる | 手順2の fingerprint、手順3の collision 不変テスト |
| module 分割時に `proteinComponent` または shadow layer タグを落とす | Brownian motion で鎖が動かない、またはシルエット内部リボンへ影が落ちない | 手順2のタグ characterization、既存 protein runtime/shadow tests、手順5画像 |
| `publication` を既存モードの置換として実装する | 既存セーブの外観や分析用表示が失われ、ユーザー要件に違反する | 手順4の完全配列・旧セーブ8ケース、Creative Stage の7ボタン |
| 新しい既定値を旧形式の欠損値にも適用する | 古いセーブだけがロード後に別色となるが、エラーは出ない | 手順4の `undefined → chain` 回帰テスト |
| Set2 色をそのまま emissive または metallic にする | 色が照明から浮く、あるいは暗部で黒く潰れ、論文図のマットな陰影から外れる | 手順3の材質値テスト、手順5の prepass 画像 |
| 12角形 helix と境界接続で triangle が想定以上に増える | 5I4R を複数出したときだけ GPU 負荷が上がる | 手順3・5の22万 triangle 上限、最終負荷計測 |
| coil を直径0.4 Åへ細くした結果、ゲームの通常戦闘距離で消える | 近景の論文図には近いが、戦闘中に主鎖の接続が読めない | 手順5の固定カメラに加え Creative Stage の通常戦闘距離で確認。消える場合は達成目標8を未達として止め、幅を変えるなら仕様を先に再承認する |
| リファクタリング時にリガンド追加を collision builder へ残す | BVH はタグで除外するため結果は同じでも、敵生成時に不要な原子 mesh を作って捨てる負荷が残る | 手順2で collision builder の子要素が `proteinRibbon` のみであることをテスト |


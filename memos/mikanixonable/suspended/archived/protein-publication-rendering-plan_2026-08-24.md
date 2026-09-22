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
7. 5I4R の表示用リボンは 26万 triangle 以下に収まり、メッシュ再生成は生成時・表示形態変更時だけで、
   毎フレームの geometry 生成を増やさない。
8. Render Lab の 5I4R・1MBN ケースで、二次構造、鎖別色、リガンド、陰影を判読でき、
   前後面の欠落、ピンチ、隙間、Z-fighting が見えない。
9. `npm run typecheck`、`npm run test:physics`、`npm run ci` が通る。

## 実装結果

- 表示用 `protein-ribbon.ts`、固定衝突用 `protein-collision-ribbon.ts`、着色用
  `protein-ribbon-color.ts` へ責務を分離した。表示形状の変更後も、5I4R/1MBN の衝突
  fingerprint、三角形数、外接半径、固定した静止球・swept sphere の結果は一致した。
- helix oval、sheet rectangle＋C末端矢印、coil rope、12分割/残基、非金属マット材質を実装した。
  SSE 境界には正の長さを持つ断面遷移面を追加し、全表示 mesh を結合して検査した結果、鎖端と
  8 Å超の欠損以外の open edge は0件、180°反転と縮退 triangle も0件となった。
- `publication` と Set2 8色を新しい選択肢として追加し、既存6モードと旧セーブ復元を維持した。
  Creative Stage の着色ボタンは7項目を返し、長いラベルを切らず2列へ折り返す。
- Render Lab に 5I4R/1MBN の固定 publication ケースを追加した。各 prepass/forward/diff の計6枚を
  含む75 PNGを生成し、二次構造、鎖別色、リガンド、陰影、境界遷移を目視確認した。
- workspace3 の Brownian motion 実装と統合し、表示用 Ribbon の全頂点へ補間 residue binding を
  付与した。材質は共有 GPU motion buffer を読む `MeshStandardNodeMaterial` とし、publication の
  Render Lab ケースも controller の更新・GPU upload 計測・binding の破棄へ対応した。固定衝突
  Ribbon は motion binding を持たない静的 geometry のまま維持した。
- Lunaの独立レビューで、初版のSSE境界が中心線だけ共有して側面未接続だった問題と、衝突回帰テストが
  子Mesh変換および固定代表座標を十分に拘束していなかった問題を検出し、実装とテストを修正した。
- Brownian motion との統合後レビューでは、`StorageBufferAttribute` の CPU 配列だけを空にして GPU
  buffer を解放していない問題を検出した。`RenderPipeline` が renderer の attribute owner を登録し、
  binding 破棄時に各 backend buffer を1回だけ解放するよう修正し、重複破棄の回帰テストを追加した。
- `npm run typecheck`、`npm run test:physics`（575/575）、`npm run render-lab:shot`、
  `npm run ci`（production build と browser smoke を含む）はすべて成功した。対話ブラウザが
  セッションへ接続されていなかったため、1280×720/1920×1080 の手動操作確認だけは実施できなかった。

## 見積り

時間は環境と画像調整の反復回数に依存するため置かず、変更量と計算量で見積もる。

- 手順1: 仕様1ファイル、規範7項目。
- 手順2: 新規1ファイル、移動対象は `src/render/protein-enemy-ship.ts` のリボン関連およそ285行、
  接続変更3ファイル、characterization test 2群。挙動を変えない commit 1個。
- 手順3: 二次構造 profile 3種、frame 計算1系統、geometry test 7観点。形状変更 commit 1個。
- 手順4: 色モード1個、固定色8個、互換性ケース「新規既定1＋旧欠損1＋既存6」の8ケース。
- 手順5: Render Lab 2ケース × 3出力 = 6画像、最終検証コマンド3本。

5I4R の連続した Cα 間隔を1残基12分割すると、longitudinal segment は helix 5,028、sheet 4,116、
coil 4,116。現行実装は二次構造境界で169間隔を切っているため、本体 triangle は cap を除いて

`139,584`

である。提案形状は12角形 helix、4頂点 sheet、12角形 coil なので、

`24 × 5,028 + 8 × 4,116 + 24 × 4,116 = 252,384`

となる。さらに168箇所のSSE境界へ、旧断面と新断面の辺数を足す zipper 遷移面を入れた実測値は
`252,400` triangle である。現行比は `252,400 / 139,584 = 1.81`。当初見積りは二次構造境界で欠けていた169間隔を
連続化後にも数え落としていた。12分割と境界連続を両立する理論下限を踏まえ、26万以下を上限にする。
生成計算量は `O(longitudinal segments × cross-section vertices)` のままで、衝突メッシュは現行 profile
を使うため BVH の三角形数と起動時構築量は増えない。geometry は spawn・表示形態変更時だけ作り、
毎フレーム負荷は頂点数増加に伴う描画分だけである。

最終検証は typecheck、575件の physics test、75枚の Render Lab 撮影、全生成物検査・production build・
browser smoke を含む CI まで実行した。

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
| 12角形 helix と境界接続で triangle が想定以上に増える | 5I4R を複数出したときだけ GPU 負荷が上がる | 手順3・5の26万 triangle 上限、最終負荷計測 |
| coil を直径0.4 Åへ細くした結果、ゲームの通常戦闘距離で消える | 近景の論文図には近いが、戦闘中に主鎖の接続が読めない | 手順5の固定カメラに加え Creative Stage の通常戦闘距離で確認。消える場合は達成目標8を未達として止め、幅を変えるなら仕様を先に再承認する |
| リファクタリング時にリガンド追加を collision builder へ残す | BVH はタグで除外するため結果は同じでも、敵生成時に不要な原子 mesh を作って捨てる負荷が残る | 手順2で collision builder の子要素が `proteinRibbon` のみであることをテスト |

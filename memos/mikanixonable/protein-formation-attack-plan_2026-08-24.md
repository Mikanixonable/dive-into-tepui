# タンパク質陣形攻撃 実装計画(2026-08-24)

## 目的

ルビスコ・ATPシンテターゼ・攻撃担当タンパク質の 3 役から成る「陣形を持った敵集団」を導入する。
現状のタンパク質敵は単体で湧いて単体で撃つだけであり、集団としての役割分担が存在しない。
この計画の完了後は、役割の異なるタンパク質が陣形を組んで出現し、陣形が維持されている間だけ
攻撃担当が射撃できる(= 支援役を先に潰すと攻撃が止まる)という崩し甲斐のある敵集団になる。

新機能なので、**最初の手順で `DEVELOP/SPEC/` を更新してから実装する**(SPEC はコードより先行)。

## 決めたこと

ユーザーが覆せるよう、根拠と、覆した場合に変わる手順を併記する。

| 決定 | 内容 | 根拠 | 覆すと変わる手順 |
| --- | --- | --- | --- |
| 役割分担 | ATPシンテターゼ=エネルギー供給(生存中のみ攻撃担当の action が有効)。ルビスコ=盾(高 integrity、自身は攻撃しない)。攻撃担当=射撃(projectile) | `protein-schema.ts` の `isActionEnabled` / integrity が既にあり、最小の拡張で役割が表現できる | 手順 1(SPEC 文面)・手順 4 |
| 攻撃担当の実体 | 既存の `pdb-5i4r` を攻撃担当に流用し、新規アセットはルビスコと ATPシンテターゼの 2 種のみ | アセット追加は Blender + MolecularNodes を要する重い工程。攻撃挙動は既存 action 定義で動く | 手順 2 |
| PDB の選定 | ルビスコ = **8RUC**(ホウレンソウ RuBisCO)、ATPシンテターゼ = **6N2Y**(ミトコンドリア ATP synthase) | どちらも全体構造が揃った代表的エントリ。科学的正確性の検討は `memos/mikanixonable/protein-scientific-accuracy-plan_2026-08-24.md` の管轄で、本計画では立ち入らない | 手順 2 |
| 陣形の表現 | 新しい「陣形オブジェクト」クラスは作らず、既存の集団同一性(accent / waveId、`enemy.ts:128-129`)に **formationId + 役割** を足して都度集計する方式 | 既存の群れ実装(`attackingCountInGroup`、`countActiveWaveGroups`)がすべて都度集計方式で、集団オブジェクトを持たない設計と揃える | 手順 3・手順 4 |
| 陣形の形 | 攻撃担当を中心に、ルビスコを プレイヤー方向の前面、ATPシンテターゼを後方に置く 3 層配置。位置は生成時に決め、以後は各機の軌道慣性に任せる(隊列維持の操舵はしない) | SPEC COMBAT.md「AI と射撃」が回避機動なし(軌道慣性のみ)を定めており、隊列維持操舵はそれと矛盾する | 手順 1・手順 3 |

## 達成目標

1. `DEVELOP/SPEC/COMBAT.md` にタンパク質陣形の仕様節があり、本計画の挙動がすべてそこに書かれている。
2. `PROTEIN_ASSET_IDS` にルビスコと ATPシンテターゼの assetId が増え、creative stage で両者のメッシュが表示される。
3. 陣形で湧いた敵集団において、ATPシンテターゼ全滅 → 攻撃担当の射撃が止まる、が実機で観測できる。
4. ルビスコの integrity が攻撃担当より高く、正面から撃つより支援役を狙う方が早く陣形を崩せる。
5. `npm run typecheck` と `npm run ci` が通る。

## 詳細設計

### 陣形データと永続化

- `formationId` は文字列とし、Creative Stageが陣形ごとに重複しない値を採番する。
- `formationRole` は `attacker | shield | energy` の直和型とし、単体敵では両フィールドを省略する。
- 両フィールドを敵の初期化データ、実行時個体、セーブデータへ通す。旧セーブに存在しない場合は
  単体敵として扱い、既存挙動を維持する。
- 陣形専用クラスや役割対応表を実行時状態として重複保持しない。同じ陣形の生存個体は敵配列から
  必要時に集計する。

### 生成規則

- `generateProteinFormation` は中央状態、プレイヤー位置、表示設定、陣形IDを受け、3機を返す。
- 攻撃担当は中央の5I4R、盾役は中央からプレイヤー方向へ450 mの8RUC、エネルギー役は反対方向へ
  450 mの6N2Yとする。3機のepochと速度は同じにする。
- Creative Stageのタンパク質欄には既存の単体生成を残し、別の「陣形をスポーン」ボタンを追加する。
  選択中のタンパク質表示形態・着色は陣形3機にも共通適用する。

### 射撃条件

- 攻撃担当が陣形に属する場合だけ、同じ`formationId`を持つ生存中の`energy`役を検索する。
- タンパク質内部の攻撃部位有効性と外部のエネルギー供給条件をAND合成する。どちらかが偽なら
  新規バーストだけでなく進行中バーストも発射しない。
- 単体の5I4Rと、陣形情報を持たない既存敵は外部条件を常に真として従来どおり動く。

### アセット生成

- asset IDは`pdb-8ruc-rubisco`と`pdb-6n2y-atp-synthase`とする。8RUCの最大integrityは640、
  6N2Yは320、両者ともactionを持たない。
- PDB由来backboneを取得してリポジトリへ固定し、既存の再現可能なJSON生成系でsemantic、structure、
  motion、静的catalogを生成する。現在のパイプラインは新規backboneを取得できるため、Blenderと
  MolecularNodesは完了条件にしない。
- 座標scaleは、8RUCを盾として5I4Rより大きく見せ、6N2Yの長軸がゲーム内で過大にならない値を、
  取得したbackboneの境界寸法から決定してdefinitionとconfigで一致させる。

### テスト境界

- 純粋な陣形供給判定、外部条件を含むaction有効判定、相対配置、セーブ往復を回帰テストで固定する。
- catalog生成チェック、protein生成・構造・motion検証、Render Lab撮影、型検査、全CIを完了条件とする。
- 既存の単体タンパク質敵、既存配色・表示設定、既存セーブ読み込みに退行がないことを確認する。

### 実装中の資産監査で追加した設計

- 6N2YはレガシーPDBを配布していないため、backbone取得器をPDB/mmCIFの両形式へ対応させる。
  生成済みJSONを手で補修する工程は認めず、取得からhash付き生成物までコマンドだけで再現できることを
  完了条件に加える。
- 全atom座標のsurface表面は、configでsurface格子間隔を指定できるようにする。既存資産の
  1.25 Å既定値は変えず、新規2資産だけ1.5 Åを用いて、標準4 GBヒープで型検査が通る容量へ抑える
  (2.0 Å以上は等値面の境界閉包が破綻する個体があり不採用)。
- 6N2YのRCSB B-factorはbackboneへ保持する。低周波モードの較正振幅が非物理的に発散したため、
  configで`uncalibrated-display`を明示し、元データをゼロへ書き換えず表示用振幅へ切り替えた。
- structure生成後の境界閉包は生成器の一般処理だけで完結させ、生成直後の`--check`が一致することを
  必須とする。疎な多量体で近傍バケットが空になり等値面が発散する不具合を、探索半径を広げる
  一般処理として修正した(個体固有の補修はしていない)。

## 手順

### 手順 1. SPEC を更新する

**目的** — 陣形と役割分担の「どう振舞うべきか」を確定させる。タンパク質敵のゲームプレイ仕様を書いた節は
現状 SPEC に存在しない(RENDERING.md:216 は描画のみ)ため、新設する。この時点でコードは変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `DEVELOP/SPEC/COMBAT.md` | 「敵機」(:82)の後に「タンパク質陣形」節を新設。3 役の役割・配置・エネルギー供給リンク(ATPシンテターゼ生存中のみ攻撃 action 有効)・崩し方(支援役撃破で無力化)を記述 |

**達成条件と検証** — COMBAT.md に上記節が存在し、「決めたこと」の 5 項目がすべて文面に落ちている。
`npm run typecheck`(コード無変更の確認を兼ねて常に)。

### 手順 2. ルビスコ・ATPシンテターゼのアセットを追加する

**目的** — 陣形の 2 役に使うタンパク質アセットを増やす。挙動はまだ変えない(カタログに載るだけ)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `assets-src/proteins/8ruc/protein.config.json`(新規) | 既存 `assets-src/proteins/1mbn/protein.config.json` を雛形に 8RUC 用を作成。`coordinateScale` は 5I4R(0.06)を基準にサイズ比で調整 |
| `assets-src/proteins/8ruc/protein.definition.json`(新規) | sites / integrity を定義。ルビスコは actions 空(攻撃しない)、integrity 高め |
| `assets-src/proteins/6n2y/protein.config.json`(新規) | 同上、6N2Y 用 |
| `assets-src/proteins/6n2y/protein.definition.json`(新規) | actions 空。integrity は攻撃担当と同程度 |
| `src/game/protein/protein-asset-catalog.generated.ts` ほか生成物 | `npm run export-assets` で再生成。**識別子だけの差分ファイルは commit せず戻す**(CLAUDE.md) |

**達成条件と検証** — `npm run typecheck`。`PROTEIN_ASSET_IDS` に 2 種が増えていることを
`grep -r "8ruc\|6n2y" src/game/protein/protein-asset-catalog.generated.ts` で確認。
`npm run render-lab:shot` で両メッシュの見た目を撮影確認(`.render-lab/shots/`)。
PDB由来backboneを先に取得し、再現可能なJSON backendで構造・semantic・motionを生成する。
Blender + MolecularNodesは高精細GLBを再authoringする場合だけ必要で、本手順の完了前提にはしない。

### 手順 3. 陣形スポーンを実装する

**目的** — 3 役を相対配置つきで一括生成する生成関数を足す。この時点で役割リンクは無く、
全員が従来どおり個別に振る舞う(挙動の変化は配置のみ)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/game-entity/enemy.ts` | `EnemyInit`(:112)に `formationId` と `formationRole: 'attacker' \| 'shield' \| 'energy'` を追加(省略可)。`Enemy` に保持(:125 付近、accent/waveId と同列) |
| `src/game/stages/spawner/enemy-generator.ts` | `generateProteinFormation(...)` を新設。中心軌道を 1 つ決め、`generateProteinEnemy`(:38)を役割ごとの相対オフセットで呼ぶ。配置は攻撃担当中心・ルビスコ前面・ATPシンテターゼ後方(`enemy-spawner.ts:16` `generateCluster` の円周配置+ジッターを参考) |
| `src/game/stages/creative-stage.ts` | :339 のタンパク質生成箇所に陣形生成の呼び出しを追加(動作確認用の湧き) |
| `src/game/save-data.ts` | 陣形IDと役割を任意フィールドとして保存し、旧セーブとの互換を保つ |

**達成条件と検証** — `npm run typecheck`。`npm run dev` で creative stage を開き、3 役が
前面/中心/後方の相対位置で湧くことを目視。

### 手順 4. 役割リンク(エネルギー供給と盾)を実装する

**目的** — 陣形を「崩せる集団」にする本体。同一 formationId 内で ATPシンテターゼが全滅したら
攻撃担当の attack action を無効化する。ルビスコは definition.json の integrity 値で表現済みのため
コード変更不要。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/protein/protein-combat-state.ts` | `isActionEnabled`(:103)に外部条件(エネルギー供給の有無)を合成できる口を追加 |
| `src/game/game-entity/enemy.ts` | `behave()`(:446)の射撃判定に「同一 formationId に energy 役が生存しているか」の集計を追加。集計は `attackingCountInGroup`(:482)と同じ都度集計方式 |

**達成条件と検証** — `npm run typecheck`。`npm run dev` で ATPシンテターゼだけを撃破 →
攻撃担当の射撃が止まることを目視。逆に攻撃担当だけ残して supply 生存なら撃ち続けることも確認。

### 手順 5. 締めの検証と後始末

**目的** — 全体を通し、規約逸脱がないか点検して締める。

**変更が必要な箇所** — なし(点検のみ)。`/refactor` を通す。

**達成条件と検証** — `npm run ci` が通る。`export-assets` 由来の識別子だけの差分が
`git diff --stat` に残っていない。

## 見積り

| 手順 | 導出 | 見積り |
| --- | --- | --- |
| 1 | SPEC 1 節 ≒ 30〜50 行の文面 | 小 |
| 2 | config/definition 4 ファイル × 各 30 行 + `export-assets` 実行 + PDB 取得・Blender ビルド(外部工程、環境依存) | **最大。環境が無ければここでブロック** |
| 3 | 型追加 ~10 行 + 生成関数 ~60 行 + 呼び出し ~10 行 | 中 |
| 4 | 集計関数 ~20 行 + 合成条件 ~15 行 | 小 |
| 5 | `npm run ci` 1 周 | 小 |

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| RCSBから新規backboneを取得できない | アセット生成を再現できず手順3以降へ進めない | 手順2(backbone取得時) |
| ATP synthase(6N2Y)は原子数が多く、motion asset・描画コストが 5I4R より大きい | フレーム落ち。無言で重くなる | 手順 2(`render-lab:shot`)・手順 3(`npm run dev` の体感) |
| `export-assets` が全アセットの識別子を振り直す | 無関係ファイルの差分混入 | 手順 2・手順 5(`git diff --stat`) |
| 陣形の相対配置が軌道慣性で時間とともに崩れる(隊列維持しない設計のため) | 湧いてしばらくすると陣形の意味が消える。仕様どおりだが、崩れが速すぎると役割リンクが体感できない | 手順 3(目視で 1〜2 分放置して確認) |
| energy 役の生存集計を毎フレーム全敵走査で書くと敵数に対し O(n²) になる | 敵が多いステージで無言で遅くなる | 手順 4(実装時。`attackingCountInGroup` と同程度の走査に抑える) |
| 攻撃無効化が `waiting_for_ammo` 等 wave 状態機械(`wave-attack.ts:19`)と干渉する | wave が終了判定できず進行が止まる | 手順 4(creative stage 外で陣形を使う場合のみ) |

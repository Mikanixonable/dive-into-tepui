# タンパク質敵 科学的正確性向上・リファクタリング計画(2026-08-24)

調査時点: `git rev-parse --short HEAD` = `7933d81a`(workspace3)

## 目的

タンパク質敵の「振動」と「見た目」を、構造生物学の文献・分子グラフィックスの標準に合わせて
正確にする。あわせて、今後タンパク質を多種追加する前提で実装を単一責務に分割し、重複を除く。

現状の問題(コードから確認済みの事実):

1. **振動が粗い。** 揺らぎはコンポーネント(鎖・ドメイン)単位の剛体並進のみ
   (`src/game/protein/protein-runtime.ts:148-214` が Object3D ごと動かす)。モード生成も
   `tools/protein-builder/generate-protein-asset.mjs` がコンポーネント数×3 の Hessian しか
   組んでおらず、残基・頂点レベルの局所揺らぎ(ループの震え、末端のばたつき)が仕組み上
   存在しない。実際のタンパク質は残基ごとに RMSF 0.3〜1.5Å(コアは小さくループ・末端は大きい)
   の熱揺らぎを持ち、これは B-factor から `RMSF = √(3B/8π²)` で得られる。
2. **リボンが論文標準(Richardson / Carson–Bugg cartoon)と異なる。**
   `src/render/protein-enemy-ship.ts:148-237` は helix/sheet とも同一の平矩形断面
   (厚さ 0.32 固定)、coil のみ丸チューブ(半径 0.38)。標準は:
   - helix: **楕円断面**の平リボン、幅:厚み ≈ 2.0 : 0.4(Å、ChimeraX 既定)
   - sheet: 矩形断面 + 末端矢印(矢印幅は本体の **2倍**)
   - coil: 細チューブ(半径 0.2〜0.3。現状 0.38 は太すぎ、リボンとの太さの対比が弱い)
   - リボン法線はペプチド平面(Cα→O ベクトル)に揃え、中心軸はガイド点を平滑化してから
     スプラインを通す(Cα を厳密に通すと折れて見える)
   現実装は helix 法線を慣性軸フレーム(`helixFrame`)から取っており、巻きに沿った自然な
   ねじれが出ない。
3. **SPEC/ にタンパク質敵の記述が一切ない**(`grep -ri protein DEVELOP/SPEC/` が 0 件)。
   コードだけが正本になっており、CLAUDE.md の運用規則に反する。
4. **責務の混在・重複。** `protein-enemy-ship.ts`(515行)に molecular/ribbon/silhouette の
   3表現+6配色モードが同居。`ProteinRuntime` が可視化と攻撃座標計算を兼務。`Enemy` が
   レガシー HP とタンパク質 HP を二重管理(`enemy.ts:210-212, 392`)。モード合成ループが
   `updateVisual`(runtime.ts:162-170)と `setModalPosition`(runtime.ts:245-259)で重複。

## 決めたこと

ユーザーが覆せる形で列挙する。覆った場合に変わる手順を併記。

| 決定 | 根拠 | 覆すと変わる手順 |
| --- | --- | --- |
| 微細振動は**頂点シェーダーでのモード合成+残基ノイズ**で実装し、CPU でのメッシュ再生成はしない | 既存メモの設計原則「ブラウン振動で毎フレームメッシュを再生成しない」と一致。5i4r はリボンだけで 1113 残基 × 12 分割の頂点があり CPU 更新は不経済 | 手順3全体 |
| 微細振動は**当たり判定に反映しない**(判定は静止形状のまま) | 振幅が RMSF 相当(モデル比 数%未満)で、判定形状 `protein-ribbon-collision.ts` は BVH を静的構築しており毎フレーム再構築は不可能。仕様として SPEC に明記する | 手順1・3 |
| ENM(弾性ネットワーク)モードは **Cα 粗視化(数残基=1ノード)** でビルド時に計算し、残基単位のモードベクトルをアセットへ焼き込む | ANM 低周波モードは全原子 MD の主成分と実質一致し、粗視化しても低周波精度は保たれる(文献調査より)。5i4r の 1113 残基を全部ノードにすると固有値分解が重いが、ビルド時処理なので許容範囲を実測して決める | 手順3の焼き込み部分 |
| `visualGain = 4` の一律誇張は**廃止**し、RMSF 準拠の振幅+フェーズ連動の増幅(critical で増幅)へ置き換える | 一律4倍は科学的根拠がなく、「振動が大きな単位で起きる」印象の一因。critical 時の振動増幅は既存メモのフェーズ案とも一致 | 手順1・3 |
| 機能運動(回転・歩行・開閉)は本計画では**仕様提案として SPEC の「未確定の案」に書くだけ**で、実装しない | 敵種ごとのゲームデザイン確定が要り、本計画の範囲(正確性+リファクタリング)を超える | 手順1のみ |
| リボン断面パラメータは ChimeraX 既定比(helix/sheet 幅 2.0Å・厚み 0.4Å、sheet 矢印幅2倍、coil 半径 0.25Å)を Å→モデル単位の一括スケールで採用 | 分子グラフィックスの事実上の標準。現状の `RIBBON_THICKNESS = 0.32`・チューブ半径 0.38 との換算係数はモデルスケールから手順2で導出 | 手順2 |

## ゲーム性・仕様の修正・廃止・追加の提案(手順1で SPEC に反映)

**本文に書く(確定仕様とする)もの:**

- 揺らぎの三層構造: ①剛体全体の微小漂い(OU 並進+回転)、②ENM 低周波モードによる
  ドメイン変形(周期 0.5〜3 秒に演出圧縮)、③残基単位の高周波ノイズ(RMSF 準拠)。
  ①②は現行実装の延長、③が新規。いずれも当たり判定に反映しない。
- リボン見た目の標準(上記断面仕様)。
- critical フェーズで揺らぎ振幅を増幅する(現状はフェーズと振動が無関係)。

**「未確定の案」節へ書く(提案)もの:**

- **機能運動を敵の攻撃機構にする**: ATP合成酵素型(120°ステップ回転しながらビーム掃射、
  ステップ間の静止が撃ち込みチャンス)、キネシン型(地形・構造物上を8nmステップ相当の
  hand-over-hand 歩行で移動)、ヘモグロビン型(アロステリック開閉 — 緩慢な予備動作の後に
  急峻に開き、開いた瞬間だけ core 部位が露出する)。いずれも実在の運動周期(回転 2〜350回転/秒、
  T⇔R 転移 µs)を秒スケールへ圧縮して使う。
- **B-factor を弱点設計に流用する**: RMSF の大きい(=揺らぎの大きい)ループ領域は被弾判定を
  甘く・ダメージ倍率を高くする。「柔らかい所が弱い」という直感と科学が一致する。
- **廃止候補**: `applyDamage` のサイト命中時に全体 HP も 0.35 倍で削る仕様
  (`protein-combat-state.ts:137`)。部位破壊の順序戦略を薄める。維持するなら SPEC に理由を書く。

## 達成目標

計画全体の合格条件。全手順後にこれを1つずつ当てる。

1. `DEVELOP/SPEC/PROTEIN.md` が存在し、見た目・揺らぎ・戦闘の振る舞いが本文に、機能運動等の
   提案が「未確定の案」節に書かれている。
2. render-lab のスクリーンショットで、helix が楕円断面リボン・sheet が矢印付き平リボン・
   coil が細チューブとして描かれ、PyMOL/ChimeraX の cartoon 表示と並べて形状の対応が取れる。
3. 近距離で観察したとき、ドメイン全体の動きとは独立に残基レベルの細かな揺らぎが見える
   (ループ・末端が大きく、helix/sheet コアが小さく揺れる)。
4. `grep -rn "visualGain" src/` が 0 件(一律誇張の廃止)。
5. `src/render/protein-enemy-ship.ts` が解体され、リボン生成・原子表示・シルエット・配色が
   別ファイルに分かれている(各ファイル ≦ 250 行目安)。
6. `Enemy` の HP 正本が一本化され、`enemy.ts` から `combat.integrityHp` との同期代入が消える。
7. 新しいタンパク質1種の追加が「config JSON 追加 + `npm run export-assets` + 敵テーブル登録」
   だけで済むことを、手順書として SPEC または tools/ の README に1画面で書ける。
8. `npm run typecheck` と `npm run test:physics`(物理を触った場合)が通り、
   `npm run smoke:browser` が通る。

## 手順

### 手順 1. SPEC/PROTEIN.md の新設(/modify-feature)

**目的**: 仕様はコードより先行する。タンパク質敵の「どう振舞うべきか」を初めて文書化し、
以降の手順の正本を作る。この時点でコードは変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `DEVELOP/SPEC/PROTEIN.md`(新規) | 見た目(リボン断面仕様)・揺らぎ三層・戦闘(HP二層、部位、フェーズ)・追加手順を本文に。機能運動・B-factor弱点・0.35倍削り廃止を「未確定の案」節に |
| `DEVELOP/SPEC/COMBAT.md` | タンパク質敵の戦闘が PROTEIN.md にある旨の参照1行(既存構成を確認して置き場を決める) |

**達成条件と検証**: `grep -l "リボン" DEVELOP/SPEC/PROTEIN.md` がヒット。
`npm run typecheck`(コード無変更の確認を兼ねて常に)。

### 手順 2. リボンジオメトリの標準化

**目的**: helix/sheet/coil の断面・法線・平滑化を Carson–Bugg 系 cartoon の標準に合わせる。
見た目だけの変更で、**当たり判定用ジオメトリも同じ生成関数を使うため判定形状も追随する**
(判定と見た目の一致は現仕様どおり維持)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/protein-enemy-ship.ts:148-237`(`ribbonGeometry`) | helix 断面を楕円化(幅:厚み=2.0:0.4 の比)、法線を Cα→O ベクトル由来のペプチド平面法線+parallel transport に変更(`helixFrame` L124-139 は削除)、ガイド点を隣接平均で平滑化してから CatmullRom へ |
| 同 `arrowFactor`(L200-203) | sheet 矢印幅を本体の2倍に(現状の先細りだけでなく、矢印根元で一段広げる) |
| 同 `buildRibbon`(L263-269) | coil チューブ半径 0.38 → helix 幅との比 0.25/2.0 に合わせた値へ |
| `src/game/protein/protein-ribbon-collision.ts` | 変更なしの見込みだが、頂点数が変わるので BVH 構築時間を再実測 |

Cα→O ベクトルは sheet では既に参照している(L141-146)。helix でも同じ O 座標が
アセットに焼かれているかを `src/assets/models/*.json` で確認し、無ければ
`tools/protein-builder/generate-protein-structure.mjs` に O 原子出力を足して
`npm run export-assets`(識別子だけの差分は commit しない)。

**達成条件と検証**: `npm run typecheck`。`npm run render-lab:shot` で 5i4r と 1mbn を撮影し、
`.render-lab/shots/` の画像で (a) helix の断面が丸みを帯びた平リボンで巻きに沿ってねじれる、
(b) sheet 末端に幅2倍の矢印、(c) coil がリボンより明確に細い、を目視。RCSB の 5I4R / 1MBN
の cartoon 画像と並べて対応が取れる。`npm run smoke:browser`。

### 手順 3. 残基レベル微細振動の追加と visualGain 廃止

**目的**: 「大きな単位の振動しかない」を解消する。ビルド時に Cα 粗視化 ENM の低周波モード
(残基単位モードベクトル)と B-factor 由来 RMSF を焼き込み、ランタイムは頂点シェーダーで
①既存コンポーネント剛体運動 ②ENM モード合成 ③残基 OU ノイズを重畳する。
当たり判定・部位アンカーには反映しない(振幅が小さいことを仕様の前提とする)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `tools/protein-builder/generate-protein-asset.mjs` | コンポーネント剛体 Hessian(`HESSIAN_SIZE = COMPONENT_COUNT * 3`, L13)に加え、Cα 粗視化 ANM(1ノード=4残基程度から実測で決める)の下位 3〜6 モードを固有値分解して残基単位ベクトルへ展開・出力。B-factor→RMSF 換算値も残基ごとに出力 |
| `tools/protein-builder/fetch-pdb-backbone.mjs` / `generate-protein-structure.mjs` | B-factor がまだ抽出されていなければ PDB から抽出(b-factor 配色モードが既にあるため抽出済みの可能性大 — 着手時に確認) |
| `src/game/protein/protein-schema.ts:62-84` | `ProteinMotionDefinition` に残基モード(頂点属性用データ)と RMSF の型・バリデーションを追加 |
| `src/render/protein-enemy-ship.ts`(手順4で分割後のリボン生成ファイル) | 頂点属性に残基インデックス・モード変位・RMSF を焼く |
| リボン用マテリアル(新規 or onBeforeCompile) | 頂点シェーダーで `Σ coeff_i × modeVec_i + rmsf × noise(residue, t)` を加算。uniform はモード係数(既存 `ProteinBrownianSampler` を流用して CPU で生成)と時刻のみ |
| `src/game/protein/protein-runtime.ts:148-214` | モード係数を uniform へ渡す配線を追加。`visualGain` 参照を削除し、phase が `critical` のとき振幅係数を上げる(combat から phase を読む) |
| `src/game/protein/protein-brownian-motion.ts` | 変更なしの見込み(サンプラは汎用)。モード数が増えるだけ |
| `assets-src/proteins/*/protein.config.json` | `visualGain` 項目を削除 |

**達成条件と検証**: `npm run typecheck`。`grep -rn "visualGain" src/ assets-src/` が 0 件。
`npm run render-lab:shot` を数秒おきに2枚撮り、ループ末端の頂点が helix コアより大きく
変位していることを画像差分で確認。`npm run smoke:browser`(シェーダーコンパイル失敗の検出)。
`src/physics/` は触らない見込みだが、触れたら `npm run test:physics`。

### 手順 4. protein-enemy-ship.ts の分割(挙動は変えない)

**目的**: 515行に3表現+6配色が同居している描画モジュールを単一責務へ分割する。
**この時点で挙動は変えない**(移動と改名のみ)。手順2・3がこのファイルを触るため、
本来は先にやる選択もあるが、見た目の正解が確定してから器を整える方が手戻りが少ないと判断した
(逆順にしたい場合は手順2の変更箇所の行番号がずれるだけで内容は同じ)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/protein/ribbon-geometry.ts`(新規) | `backboneRuns`/`ribbonGeometry`/`buildRibbon` を移動 |
| `src/render/protein/atom-view.ts`(新規) | 全原子 InstancedMesh 生成を移動 |
| `src/render/protein/silhouette-view.ts`(新規) | シルエット表面+影レイヤ操作を移動 |
| `src/render/protein/ribbon-coloring.ts`(新規) | `ribbonColor` と 6 配色モードを移動し、`ribbonGeometry` と `tubeColors` に重複していた頂点色決定ループ(旧 L211-213 / L239-253)をここへ一本化 |
| `src/render/protein-enemy-ship.ts` | 上記を組み合わせる薄い入口だけ残す(または registry から直接参照して削除) |
| `src/game/protein/protein-enemy-registry.ts` | import 先の付け替え |
| `src/render/pipeline/protein-shadow-pass.ts` | シルエット参照の付け替え(必要な場合) |

**達成条件と検証**: `npm run typecheck`。`wc -l src/render/protein/*.ts` で各ファイル 250 行以下。
`npm run render-lab:shot` の画像が手順3完了時と一致(挙動不変の確認)。

### 手順 5. ProteinRuntime の責務分離と HP 一本化

**目的**: 可視化クラスから戦闘用座標計算を分離し、`Enemy` の二重 HP を解消する。
**挙動は変えない**(構造の移動と正本の一本化のみ)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/protein/protein-anchors.ts`(新規) | `siteWorldPosition`/`activeSiteWorldPosition`/`nextAttackSiteWorldPosition`/`localImpactPoint` を `protein-runtime.ts` から移動。モード合成によるコンポーネント並進計算を1関数に集約し、`updateVisual`(旧 L162-170)と `setModalPosition`(旧 L245-259)の重複ループを解消 |
| `src/game/protein/protein-runtime.ts` | 可視化(マーカー・ボンド線・uniform 更新)だけ残す |
| `src/game/game-entity/enemy.ts:210-212, 392 ほか` | `hp`/`maxHp` への同期代入を削除し、タンパク質敵では getter が `combat.integrityHp` を返す形へ一本化。着手前に `/inv-callstack` で `enemy.hp` の読み手(HUD・スコア・セーブ)を洗う |
| `src/game/save-data.ts` | HP 一本化でセーブ形式が変わらないことを確認(変わるなら旧データ読込の既定値を定義) |

**達成条件と検証**: `npm run typecheck`。`grep -n "integrityHp" src/game/game-entity/enemy.ts`
の残存箇所が getter 1箇所のみ。`npm run smoke:browser` でスポーン・被弾・撃破が通る。
セーブ→ロードで部位 HP が維持される(smoke で確認できなければ `/verify` はユーザーの明示要求
待ちとし、単体で combat-state の serialize/deserialize を確認)。

### 手順 6. 締めの点検

**目的**: 達成目標を1つずつ当て、リスク表を照合し、規約逸脱を是正する。

**変更が必要な箇所**: `/refactor` と `/comment-cleanup` を手順2〜5の変更範囲に通す。
新タンパク質追加手順(達成目標7)を SPEC/PROTEIN.md に書く。

**達成条件と検証**: `npm run ci` が通る。達成目標 1〜8 をすべて確認済みと報告できる。

## 見積り

| 手順 | 導出 | 見積り |
| --- | --- | --- |
| 1 | SPEC 1ファイル ≈ 150行 × 執筆のみ | 小(1セッション内) |
| 2 | `ribbonGeometry` 90行の書き換え+O原子焼き込み確認。頂点数は 1113残基 × 12分割 × 断面8点 ≈ 10.7万頂点で現状比 ~2倍(断面4→8点)。BVH 構築は三角形数に線形なので構築時間も ~2倍 → 起動時実測で判断 | 中 |
| 3 | ANM 固有値分解はビルド時: ノード数 n=278(1113/4)で 3n=834 次元、Jacobi は O(n³)≈5.8×10⁸ 演算 ≈ 数秒(export-assets 内なので許容)。ランタイム追加コストは頂点シェーダーで +数演算/頂点 × 10.7万頂点 ≈ 無視できる。アセット増分: 6モード × 1113残基 × 3float × 4B ≈ 80KB/タンパク質 | 大(本計画の中心) |
| 4 | 移動のみ、515行を4ファイルへ | 小 |
| 5 | 移動+`enemy.hp` 読み手の洗い出し(HUD/スコア/セーブの3系統見込み) | 中 |
| 6 | 点検のみ | 小 |

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 頂点シェーダー変位により見た目と当たり判定がズレる | ミリ単位のズレでも「当てたのに外れた」体感になる | 手順3。RMSF 振幅がモデル半径の何%かを焼き込み時に検証し、上限(例: 部位半径の 10%)を validate に入れる |
| ペプチド平面法線が隣接残基間で反転し、リボンが局所的に裏返る | helix がねじれ切れて見える | 手順2。flip 検出(前フレームとの内積が負なら反転)を実装し、render-lab:shot で全鎖を目視 |
| O 原子がアセット未収録で export-assets が必要になり、識別子が全部振り直される | 差分が識別子だけのファイルを commit すると履歴が汚れる | 手順2。CLAUDE.md の規則どおり識別子のみの差分は戻す |
| morph 相当の頂点変位で部位マーカー・発射アンカーが本体から浮く | 発射位置が視覚的に乖離(既存メモのリスクと同種) | 手順3。マーカーはコンポーネント剛体運動のみ追随(現仕様)とし、微細変位は小さいので追随しないことを SPEC に明記 — 目視は render-lab |
| `enemy.hp` の読み手(HUD・スコア・セーブ)が直接代入前提で書かれている | HP 表示 0 固定やセーブ破損 | 手順5。着手前の `/inv-callstack` で全読み手を列挙してから触る |
| モード数増でセーブの乱数再現性が壊れる | ロード後に揺らぎ位相が飛ぶ(実害は小) | 手順3。サンプラはシード付きカウンタハッシュで tick から決定論的に再現されるため、モード番号の割り当てを既存モードの後ろに追加する形にする |
| BVH 構築時間が頂点倍増でスポーン時のヒッチになる | スポーン瞬間のフレーム落ち | 手順2。構築時間を console 計測し、閾値超なら断面点数を落とすか構築を分割 |
| ANM の粗視化が粗すぎて低周波モードが剛体運動と区別つかない | 手順3の狙い(細かい揺らぎ)が出ない | 手順3。焼き込み時にモードベクトルの残基間分散を出力し、コンポーネント剛体モードとの内積が高いモードは捨てる |

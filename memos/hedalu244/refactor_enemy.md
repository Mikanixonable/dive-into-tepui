# enemy 周辺のリファクタリング — 細切れモジュールの回収と kind 分岐の多態化

## 目的

`src/game/dynamic/dynamic-entity/` の敵まわりが、2つの問題を同時に抱えている。

**1つめ — 責務を持たない細切れモジュールが 6 本ある。** `enemy-kind.ts` (43) /
`enemy-marker.ts` (35) / `enemy-save.ts` (29) / `enemy-render.ts` (27) / `enemy-formation.ts` (21) /
`enemy-sun-glare.ts` (17) は、いずれも `enemy.ts` からしか(型を除いて)呼ばれず、`Enemy` から
1回だけ委譲されるだけで独立した責務を果たしていない。`enemy.ts` を短くする意図で切り出されたと
見えるが、実際には減っていない — 委譲する側のメソッドと `import` 行が、切り出した行数とほぼ同じだけ
残る。結果として、`enemy.ts` は 528 行のまま、読むべきファイルが 7 本に増えた。

**2つめ — `EnemyKind` による分岐が `Enemy` 1クラスに同居している。** `enemy.ts` 内に
`proteinRuntime` が 30 箇所、`enemyKind` が 13 箇所現れ、コンストラクタ・衝突判定・被弾処理・
接触ダメージ・`sync`・射撃・`dispose`・シリアライズのほぼ全メソッドが「タンパク質型か否か」で
二又に割れている。**タンパク質型に固定すると通らない行が全メソッドに散らばっており、逆も同じ** —
これは長さの問題ではなく、本質的に違う2つのものが1つの型に同居しているという診断結果である。
細切れモジュールは、この分岐を外へ出そうとして失敗した副産物でもある(`enemy-render.ts` の中身は
種別の `switch` そのもので、分岐は `enemy.ts` に残ったままになっている)。

**一方で、`drifting` と `stage0` の違いは定数だけで、どちらかに固定したときに通らなくなる行は
1行も無い。** 同じ `EnemyKind` の値でも、こちらは分けるべきものではない。「kind があること」が
問題なのではなく、**kind で切り替わっているものが振る舞いなのかデータなのか**が問題である。

**修正後に期待される状態:**

- 敵は `Enemy`(抽象基底) / `MetalEnemy`(金属機体) / `ProteinEnemy`(タンパク質)の3クラスで
  表され、種別による実行時分岐はセーブからの復元(タグ → 具象クラス)1箇所だけになる。
- 復元は、既にステージが使っている「**静的側インターフェース + クラス辞書**」の形
  (`stage-dictionary.ts` / `StageClass`)へ揃える。読み込み機構はタグからクラスを引くまでを担い、
  そこから先の復元は各クラスのコンストラクタが持つ。
- `enemy-*.ts` は `enemy-dictionary.ts` の 1 本だけになり、各モジュールが 500 行以内かつ独立した
  責務を持つ。
- 同じ失敗を繰り返さないよう、`DEVELOP/CODING-RULE.md` に「長いモジュールはまず原因を診断する
  (多態にすべきかどうかもその診断の1項目)」「短すぎるモジュールの増殖は長すぎるモジュールと
  同格の違反」「多態の保存と復元の形」を明記する。

## 決めたこと

以下は自分で決めた。根拠と、覆したときに変わる手順を併記する。

**(1) 金属機体側のクラス名は `MetalEnemy` にする。**
`ShipEnemy` は使わない — `Ship` は `Enemy` の基底クラス名なので、`ShipEnemy extends Enemy extends Ship`
という並びが読めない。モデルの設計記録から採る:

- `tools/export-models.mjs` 547〜576 行(`buildEnemyShip`)は、ガンメタルのコアに `F0_STEEL` の
  `metalness: 1` リングとフィン 4 枚・ランプを付けた機体。642〜733 行(stage0 敵 A/B/C)は
  `core` / `ligand` / `bond` / ring で組んだ配位錯体だが、bond と ring はやはり `F0_STEEL` の金属。
- `DEVELOP/SPEC/PROTEIN.md` 26 行 —「リボンの表面は滑らかな陰影の、**金属的でない**マットな材質と
  する」。**仕様書自身が、タンパク質を金属との対比で定義している。**
- `MetalEnemy` / `ProteinEnemy` は「機体が何でできているか」で対になり、コードの差
  (固定メッシュ + パーツ式被弾 / 揺らぐ構造 + 部位式被弾)とも一致する。

`RigidEnemy` は退けた — `SPEC/PROTEIN.md`「表示形態を変えても、衝突形状は静止したリボン形状を
使い続ける」の通り、タンパク質側の衝突形状も剛体なので区別にならない。`HardEnemy` は難易度に読める。
→ 覆すなら手順 4 のクラス名とファイル名だけが変わる(構造は変わらない)。

**(2) 具象クラスは 2 つにする。3 つにはしない。**
現行の `EnemyKind` は `drifting` / `stage0` / `protein` の3値だが、`drifting` と `stage0` の違いは
メッシュ(`buildEnemyShip` / `buildStage0EnemyShip(typeIndex)`)と主慣性モーメント
(`v3(1,1.1,1.05)` / `v3(1,1,1)`)の2定数だけである。**どちらの値に固定しても、通らなくなる行が
1行も無い** — 切り替わっているのはデータであって振る舞いではない。ここを別クラスにすると、
**まさに今回潰そうとしている「責務の無い小さなモジュール」を新しく作ることになる。**
分岐の実体は「パーツ式の被弾モデルか、部位式(`ProteinCombatState`)の被弾モデルか」の1軸で、
`enemy.ts` の分岐 43 箇所はすべてこの軸に対応している。データの差は `MetalEnemy` のフィールド
(`typeIndex: number | null`)で持つ。
→ 覆すなら手順 4 が変わる(`MetalEnemy` を `DriftingEnemy` / `Stage0Enemy` に割る)。

**(3) 復元は `stage-dictionary.ts` と同じ形にする。`EnemyKind` union は消す。**
「多態で表したものを保存し、タグから復元する」口は、このリポジトリに既にある —
`StageClass`(`stage.ts` 72〜92 行)が静的側インターフェースとして `id` と構築シグネチャを宣言し、
`stage-dictionary.ts` が `STAGE_CLASSES` と `findStageClass(id)` を持ち、
`Stage.stageClass`(139〜143 行)が `this.constructor` から自分の静的側を引く。**技術的な障害は
無く、Enemy 側にこの形を実装するだけでよい。** 制約は2つだけで、どちらも Stage が既に解いている:

- **辞書は独立したモジュールでなければならない。** 基底のモジュールに置くと
  `enemy.ts → protein-enemy.ts → enemy.ts` の実行時循環になり、`class ProteinEnemy extends Enemy`
  の評価時に `Enemy` が TDZ で `ReferenceError` になる。呼び出し元(`dynamic-system.ts`)に
  `switch` を直書きすると、分岐が呼び出し元へ戻る。
- **復元のコンストラクタ・シグネチャは全具象で揃っていなければならない。** 具象ごとに異なるのは
  「新規生成」の引数だけなので、`init` を union にして、復元の腕
  (`{ saved, simTime }`)を全具象で共通にする。

セーブの互換は問わないので、`EnemyKind` は型ごと削除する。**種別タグは
`EntitySaveData.kind` を使う** — 現在 `'player' | 'enemy' | 'ammo' | 'rcs-fuel' | 'booster'` が
入っているが、**書かれるだけでどこからも読まれていない**(各実体は `save.enemies` のように配列で
分かれて復元されるため)。ここを具象クラス名のタグに使えば、新しいフィールドを足さずに済み、
将来 Player / Base などへ同じ機構を広げるときも `kind` がそのまま使える。
`'enemy'` を `'metal-enemy' | 'protein-enemy'` に置き換える。
→ 覆すなら手順 4 が変わる(`enemyKind: string` を別フィールドとして残す)。

**(4) 一般化した復元機構を他の実体へ広げるのは、このブランチのスコープ外。**
Player / Base / Bullet / AmmoPickup / RcsFuelPickup / DetachedBooster の復元経路には触らない。
`EntitySaveData.kind` の union に敵の2値を入れる以外、それらのセーブ形式も変えない。
Enemy 側を上記の形にしておけば、後から同じ形を横へ広げられる。
→ 覆すなら手順が 1 つ増える(全実体の `kind` を具象タグ化し、`dynamic-system.restoreFromSave` を
辞書引きへ統一する)。

**(5) CODING-RULE の改定は 1.2 と 1.6 への小節追加だけにする。新しい節は立てない。**
1.2 への追記は「関数を切り出すな」ではなく「**まず原因を診断しろ**」という形にする —
独立した意味を持つ手続きが直に書かれている場合は切り出すのが正解であり
(`player-throttle.ts` 267 行 / `player-fire.ts` 419 行がその例)、今回の enemy のように
「本質的に違うものが1つの型に同居している」のは診断結果の別の1種である。

**多態にすべきかどうかも、独立した規則ではなく診断の1項目として書く。** `kind` フィールドが
あること自体は違反ではない — 外部形式のタグとして必要だし、`drifting` / `stage0` のように
振る舞いを伴わない区別にも使う。判断は**その値を固定したときに通らなくなる行がどれだけあるか**で
下すものなので、診断の側にしか置き場所が無い。

復元機構の形(静的側インターフェース + クラス辞書)は診断ではなく手順なので、`1.6 データ構造`
の小節として置く。**新しい節を立てないので、1.7 以降の節番号の繰り下げと、その相互参照の
追随作業が丸ごと不要になる。**
→ 覆すなら手順 1 が変わる。

**(6) 旧セーブの `pdb-5i4r` 読み替えは削除する。**
互換は問わないという判断に従い、`LegacyPdb5i4rEnemyKind` / `normalizeEnemyKind` /
`proteinDisplayFromLegacyColorMode` と、後者を検査している
`tests/game/protein-combat-state.test.ts` の該当ケースを消す。
`proteinDisplayFromLegacyColorMode` の参照は `enemy-kind.ts` とそのテストだけなので、消せる。
→ 覆すなら手順 4 で読み替えを `enemy-dictionary.ts` の復元経路へ残す。

**(7) `isFormationEnergyAvailable` はモジュールレベルの関数として `protein-enemy.ts` に残し、
export する。** 陣形の供給条件は `DEVELOP/SPEC/COMBAT.md`「タンパク質陣形」に正本があるので、
`tests/game/protein-formation.test.ts` は残す価値がある(CODING-RULE 4.1「期待値の正本がコードの
外にあるもの」)。テストのために構造を歪めはしないが、この関数は素直な純関数なので、
`ProteinEnemy` の private メソッドにせず module scope の export で持つ。
→ 覆すならテストを削除し、`ProteinEnemy` の private メソッドにする。

## 達成目標

全手順の実施後に、次がすべて満たされていること。

1. `ls src/game/dynamic/dynamic-entity/enemy-*.ts` が `enemy-dictionary.ts` の 1 本だけを返す
   (現在 6 本)。
2. `grep -c 'proteinRuntime' src/game/dynamic/dynamic-entity/enemy.ts` が 0(現在 30)。
3. `grep -rn 'EnemyKind' src tests` が 0 件。種別で振る舞いを選ぶコードが
   `enemy-dictionary.ts` の外に存在しない。
4. `src/game/dynamic/dynamic-entity/` の敵関連モジュールが、いずれも 500 行以内。
5. `grep -rn 'setProteinDisplay\|proteinHudSnapshot\|proteinSiteMarkers\|proteinRuntime' src tests` が
   `protein-enemy.ts` 内と、`instanceof ProteinEnemy` で絞り込んだ呼び出し側だけになる。
   `Enemy`(基底)に `protein` を名前に含む public メンバーが 0 個。
6. `Enemy` の静的側が `EnemyClass` として宣言され、`enemy-dictionary.ts` が
   `ENEMY_CLASSES` と `findEnemyClass(kind)` を持つ。`dynamic-system.ts` の敵復元が、
   具象クラス名を1つも書かずに辞書引きだけで書けている。
7. `DEVELOP/CODING-RULE.md` に、(a) 長いモジュールの原因を診断する手順(多態にすべきかどうかの
   判断を含む)、(b) 短すぎるモジュールの増殖の禁止、(c) 多態の保存と復元の形の3つがある。
   `##` 見出しの並びは改定前と同じで、節番号を動かしていない。
8. `npm run typecheck` と `npm run test`(全層)が通る。
9. `npm run dev` でクリエイティブステージを開き、タンパク質敵の生成・表示形態の切り替え・
   陣形生成・撃破が変更前と同じに見える。セーブ → ロードで敵が同じ姿・同じ HP で戻る。
   **← 未達。この環境では確かめられていない**(下記)。

**1〜8 は達成済み。9(目視)だけが残っている。** `npm run smoke:browser` はこの環境では
`origin/main`(bf40eec2)でも「60 フレームを 30 秒以内に描けない」で落ちるため、実行時の
確認経路が無い。**次に実機で開いたとき、次の 7 点を確かめること:**

1. 「敵を配置」で金属機体の敵が出る → 撃つと火花・ガスパフが出て、HP が減って撃破できる。
2. 「陣形を生成」でタンパク質 3 体(5I4R / ルビスコ / ATP シンテターゼ)が出る。
   部位マーカー(3km 以内)に略号と HP が並ぶ。
3. 表示形態のセレクタを切り替えると、既に出ている 3 体すべての見た目が変わる。
4. ATP シンテターゼを先に破壊すると、5I4R がプラズマを撃たなくなる。撃破直後に部位マーカーが
   残らない。
5. セーブ → タイトルへ戻る → ロードで、3 体が同じ表示形態・同じ部位 HP で戻る。
6. 敵マーカー(名前・距離・HP 三角形・画面外方位三角形)が変更前と同じに出る。
7. ステージ 00 のウェーブ敵が、機首をプログレードへ向けたまま回転せずに飛んでくる。

**特に 1 と 2 は、下のリスク表の先頭行(`ProteinEnemy` の `hp` getter が `super()` 中に
読まれる)を潰す検証である。** コードの読みでは `initDefaultParts` の無効化と setter の
無視で読まれる経路は無いが、実行では確かめていない。

---

## 実測(実施後)

**行数.** 見積りと実測。

| 時点 | 敵のモジュール数 | 見積り | 実測 |
| --- | --- | --- | --- |
| 着手前 | 7 | — | **700** (528+43+35+29+27+21+17) |
| 手順 3 後 | 1 | 654 | **659** |
| 手順 5 後 | 4 | 625 | **760** — `enemy.ts` 424 / `protein-enemy.ts` 249 / `metal-enemy.ts` 73 / `enemy-dictionary.ts` 14 |

**見積りを 135 行超えた。** 内訳は、抽象メンバー5つの宣言とコメント、`EnemyClass` /
`EnemyPlacement` / `EnemyRestore` の型定義、`ProteinSiteMarker` の型定義、および具象2つが
それぞれ持つ import 群。**分岐を消して契約を明示すると、行数は増えるほうが普通である** —
減らすことは目的ではないと計画の時点で決めてあり、判定は下の分岐の箇所数で行った。
`save-data.ts` は +18 行(見積りどおり)。

`enemy-dictionary.ts` の 14 行は `stage-dictionary.ts` の 18 行と同じ規模である。行数は小さいが、
「タグから具象を引く」という責務を持ち、かつ構造上ここにしか置けない(基底へ置くと循環)。
CODING-RULE 1.2「どんなに行数が少なくても、責務を持っているのであれば単独のモジュールとして
維持すべき」に当たる。

**分岐の箇所数(実測).**

| 指標 | 着手前 | 実施後 |
| --- | --- | --- |
| `enemy.ts` 内の `proteinRuntime` 出現 | 30 | 0 |
| `enemy.ts` 内の `enemyKind` 出現 | 13 | 0 |
| `src/` 全体で種別を見て振る舞いを選ぶ箇所 | 4 ファイル | 1 ファイル(`enemy-dictionary.ts`) |
| 読むべきファイル数 | 7 | 4 |

**触るファイル数.** 見積り 36(実体 22)に対し、実測は 27 ファイル
(手順 1: 1 / 手順 2: 7 / 手順 3: 6 / 手順 4: 18 / 手順 5: 4、重複を除く)。
見積りに無かったのは、死んだ `legacyHealth`(`protein-combat-state.ts` /
`protein-runtime.ts`)と `player.ts` のコメント内の旧定数名。

---

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `ProteinEnemy` の `hp` / `maxHp` getter が `super()` 実行中に読まれる。`Ship` のコンストラクタは `this.hp = hp; this.maxHp = hp; this.initDefaultParts();` を走らせ、その時点で `this.runtime` はまだ未代入 | 生成時に `Cannot read properties of undefined` で即例外。タンパク質敵が 1 体も出ない | 手順 4。`initDefaultParts()` を「パーツを持たない」override にし、setter を無視する形にすれば、super の中で getter を読む経路が無くなる。**この 2 つを同時に入れること。**片方だけだと落ちる。検証は手順 4 の目視 2 |
| `initDefaultParts()` を無効化すると `ProteinEnemy.parts` が空配列になる | `Ship.applyDamageToParts` / `updateOverallHp` / `refreshFromParts` は空配列で早期 return するので安全。`ship.parts` を触るのは `docking.ts`(260・297 行)と `base-view-parts-tab.ts` だが、いずれも `Player` のドッキング経路で、敵は到達しない | 手順 4。`grep -rn '\.parts\b' src/` で敵が到達しうる経路が無いことを再確認する |
| `EnemyClass` の構築シグネチャに具象のコンストラクタが代入できない。具象は `MetalEnemyPlacement \| EnemyRestore` を受けるが、インターフェースは `EnemyRestore` だけを渡す | `ENEMY_CLASSES` の型注釈で型エラー。`as` で潰すと辞書が型安全でなくなる | 手順 4。union を受ける側は狭い型を受け入れられるので通るはずだが、通らなければ**復元専用の static factory**(`static restore(saved, simTime, …): Enemy`)を `EnemyClass` に置く形へ切り替える。`new (...)` に固執しない |
| `static pendingAssetId` を `EnemyClass` に置くと、タンパク質固有の関心が全具象の契約に載る | `MetalEnemy` 側が意味の無い `null` を返すだけの宣言を持つ。`StageClass.picksStartEpoch` と同じ形(全ステージが自分について宣言する)なので許容するが、第3の具象が増えたときに再検討が要る | 手順 4。レビューで「基底から外そう」とするなら、`dynamic-system` が具象を知ることになる点とセットで判断する |
| `EntitySaveData.kind` の union を差し替えたとき、`kind: 'enemy'` を書いていた箇所が残る | 型エラーで止まるので無言では壊れない。ただし `save-transfer.ts` / `save-slots.ts` が `kind` を素通しでコピーしている場合、旧セーブが読み込み時に静かに落ちる可能性がある | 手順 4。`grep -rn "kind: 'enemy'" src` が 0 件、`grep -rn '\.kind' src/game/save/` で読み取りが無いことを確認する |
| `EnemyKind` を消したことで、`display` の正本が `ProteinEnemy` のフィールドへ移る。`serialize()` が生成時の値を返してしまう | セーブ → ロードで表示形態が生成時のものへ巻き戻る。クリエイティブステージで切り替えてから保存した設定が消える | 手順 4。検証: 手順 4 の目視 5(切り替え → セーブ → ロード) |
| `saved.display` / `saved.assetId` はセーブ由来の未検証値である。`isProteinDisplaySettings` の検査を落とす | 壊れたセーブで表示設定が不正なまま構築され、描画時に落ちる | 手順 4。`ProteinEnemy` の復元側で `isProteinDisplaySettings` を通し、外れたら `DEFAULT_PROTEIN_DISPLAY` へ倒す |
| `targeter.ts` 182 行の `if (!(tgt instanceof Enemy)) continue;` を `ProteinEnemy` へ狭め忘れる | 金属機体に `siteMarkers` が無く型エラー。`as` で潰すと実行時に落ちる | 手順 4。`npm run typecheck` |
| `targeter.ts` の部位マーカーは「生死にかかわらず全タンパク質敵を辿る」ループになっている。絞り込みを `alive` にすり替える | 撃破直後に部位マーカーが画面に残り続ける | 手順 4。検証: タンパク質敵を撃破し、部位マーカーが即座に消えること |
| `enemy-dictionary.ts` を `enemy.ts` に置く / `dynamic-system.ts` に `switch` を直書きするほうが速い、と手順 4 の途中で判断する | 前者は `enemy.ts → protein-enemy.ts → enemy.ts` の実行時循環で `class ProteinEnemy extends Enemy` が TDZ の `ReferenceError`。後者は分岐が呼び出し元へ戻る | 手順 4。「決めたこと (3)」で塞いである |
| 慣性 `v3(1,1.1,1.05)` が `MetalEnemy`(漂流)と `ProteinEnemy` の 2 箇所に書かれる | 重複実装に見えるが、別々の物体の物理量なので統一しない(CODING-RULE 1.5「個別に調整されうる要素」) | 手順 4。レビューで「まとめよう」としないこと |
| 手順 3 で `enemy.ts` が 654 行になった状態で止める | CODING-RULE 1.2 の 500 行基準を破ったまま残る。しかも「長いから切り出そう」という、今回直している動機を再生産する | 手順 3〜4。**手順 3 と手順 4 は続けて実施する** |
| 一般化した復元機構を、この場で Player / Base / Bullet などへ広げたくなる | 手順 4 が commit できない規模に膨らみ、挙動の変わる範囲が敵の外へ出る | 手順 4。「決めたこと (4)」で塞いである。広げるなら別ブランチ |
| `npm run typecheck` がヒープ不足で落ちる | 変更の是非と無関係に赤くなる | 全手順。既知の環境事情なので、ヒープを広げて再実行する |
| main へ送るとき、触った層だけのテストで済ませる | CI が全層を回すので、通らないものを送ると `release` の更新が止まる | 手順 5 の後。`npm run typecheck` と `npm run test`(全層)を必ず通す |

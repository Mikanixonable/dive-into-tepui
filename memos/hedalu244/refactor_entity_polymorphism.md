# DynamicEntity の保存・復元・被選択判定を、種別ごとの手展開から多態へ寄せる

## 目的

`DynamicSystem` は `players` / `enemies` / `bases` / `ammoPickups` / `rcsFuelPickups` /
`detachedBoosters` を種別ごとに公開しており、新しい種別が増えるたびにここへ追記が要る。この
アクセサ列を、実際に種別を横断して同じ処理をしたいだけの3箇所が使っている。

- **`Game.serialize()`** が `players.map(...)` / `enemies.map(...)` / … と種別ごとに畳んで
  `GameSaveData` を組み立てている。`Game` は各エンティティが何を保存するかを知る必要が無いのに、
  種別の一覧そのものを知ってしまっている。
- **`GameSaveData`** も `players` / `enemies` / … と種別ごとの配列を並べて持つ。`DynamicSystem`
  が保持側で `entities` という1本の配列に畳んでいるのに、保存側だけ畳まれていない。
- **`ObjectPickables.refresh()`** が `enemies` / `ammoPickups` / `rcsFuelPickups` /
  `controllables` を個別に読んで `append` している。これらは全部「被選択物(`ObjectPickable`)
  として公開する種別」という1つの性質で選べるはずのものを、4つの経路に手展開している。

**方針は、この3箇所が読む「種別の一覧」を、各エンティティ自身が答える性質(直列化した自分の姿・
被選択物として公開する自分)へ置き換えること。** これは `DEVELOP/CODING-RULE.md` 1.6「多態を
保存し、復元する」が既に `Enemy`(`EnemyClass` / `enemy-dictionary.ts`)に対して適用している
パターンを、`DynamicEntity` 全体へ広げるものである。

セーブデータの後方互換性は保持しない(開発中であり、その制約が今回の設計変更の足枷になっている
ため)。`SAVE_VERSION` を上げ、旧形式(種別ごとの配列)を読む経路は残さない。

## 決めたこと

### A. 復元も1本のクラス辞書へ寄せる

ユーザーが名指ししたのは保存(直列化)側と被選択判定側だが、`DynamicSystem.restoreFromSave` も
種別ごとに6本の `for` ループを持っており、`GameSaveData` を1本の `entities` 配列へ畳むなら
このループも1本にせざるを得ない。**`Enemy` 用に既にある `EnemyClass` / `enemy-dictionary.ts`
のパターン(静的側インターフェース + 独立モジュールのクラス辞書)を、`Player` /
`AmmoPickup` / `RcsFuelPickup` / `DetachedBooster` / `Base` を含む全種別へ拡張した
`entity-dictionary.ts` を新設し、そこへ寄せる。** `enemy-dictionary.ts` 自体は変更せず、
`entity-dictionary.ts` から `findEnemyClass` を呼ぶ形で合成する(具象 Enemy クラスを直接
import すると TDZ 循環に落ちる、という `enemy-dictionary.ts` 冒頭のコメントの制約を保つため)。

覆すなら: `DynamicSystem.restoreFromSave` に6本のループを残したまま `GameSaveData` だけ
`entities: EntitySaveDataUnion[]` にする手もあるが、その場合 `restoreFromSave` の中で
`data.kind` によるフィルタが種別の数だけ必要になり、種別が増えるたびに触る箇所が
`DynamicSystem` の中に残ってしまう。今回の目的(種別が増えても触らずに済む)に反するため採らない。

### B. 被選択判定は `controllable` と同じ形(独立した boolean フィールド)にする

`ObjectPickable` を実装する種別を束ねるのに、`asPickable: ObjectPickable | null` のような
getter ではなく、既存の `DynamicEntity.controllable: boolean` + `isControllable()` と同じ形
(`pickable: boolean` + `isObjectPickable()`)を使う。**理由は、このプロジェクトに既に
2つ(`capKind` / `mapKind` / `controllable`)ある「種別の性質をフィールドで持たせ、束ねるときは
その性質でフィルタする」パターンへ揃えるため。** 新しい形を増やさない。

### C. `players` / `enemies` / `bases` / `ammoPickups` / `rcsFuelPickups` / `bullets` /
`controllables` ゲッタは残す

これらは `targeter.ts` / `stages/stage-utils/logistics.ts` / `hud/panels/enemies-panel.ts` /
`lines/entity-line-manager.ts` / `pickable/line-pickables.ts` / `pickable/object-windows.ts`
など、種別固有のドメインロジックから実際に使われている(調査済み)。**削除するのは
`detachedBoosters` ゲッタだけ** — これは保存(`Game.serialize()`)と復元
(`DynamicSystem.restoreFromSave`)以外に使われておらず、今回の書き換えでその2箇所が無くなれば
参照が0件になる。

### D. `normalize-save.ts` は空にせず削除する

`normalize-save.ts` は「同じ `SAVE_VERSION` のまま追加されたフィールドの読み替え」を担って
いるが、中身(`ammos` → `ammoPickups` の旧キー読み替え、`activePlayerId` → `activeControlledId`、
`@activeShip` → `@controlled` のロールトークン読み替え、`rcsFuelPickups` /
`detachedBoosters` の既定値補完)はすべて今回消える旧形式(種別ごとの配列)に対するものである。
`SAVE_VERSION` を上げれば `snapshot-service.ts` の version チェックがこれより先に旧セーブを
弾くため、このファイルの中身は到達不能になる。**空の通過関数として残さず、ファイルごと削除する**
(`tests/game/normalize-save.test.ts` も対象がなくなるため削除)。将来また同種の読み替えが要る
ときに作り直せばよい、という判断。

### E. `BaseSaveData` を `EntitySaveData` の派生へ戻す

`BaseSaveData` だけが `EntitySaveData` を継承していない。現在その理由として置かれているコメント
(`save-data.ts` 112-113行目「基地は艦と持ち物が根本的に異なる(所持金・燃料)ため、kind で分岐する
`EntitySaveData` の派生ではなく独立した型にする」)は、**理由になっていない** — 持ち物が異なることは
`PlayerSaveData`(`fire` / `thermal` / `parts`)や `EnemySaveData`(`health` / `accent`)にも
当てはまり、それこそが派生の目的だからである。

**実際に継承を阻んでいるのは `q?` / `w?` の optional 一点である。** 必須プロパティを派生側で
optional へ弱めることはできず、`extends` を書くと TS2430(`Types of property 'q' are
incompatible`)になる — 同じ形を再現して確認済み。この optional は、基地が姿勢を持たなかった頃
(`4aca424b`、コメントもこのとき書かれた)の名残に対して、基地を操作対象化した `f669a62f` が
「`SAVE_VERSION` を 2 に据え置いたまま `q` を欠くセーブ」への対処として付けたものである。

**`SAVE_VERSION` を 3 へ上げる今回、この optional は読み手を失う** — `Base.serialize()` は
`q` / `w` を常に書くため、version 3 のセーブでこれらが欠けることはない。よって手順3で必須へ戻し、
`extends EntitySaveData` にする。**必須化を版上げと同じ手順に置く**のは、手順2へ前倒しすると
その間だけ「必須と宣言した `q` を欠く version 2 セーブが読める」状態になるためである。
`fuel?` / `throttle?` / `showTrajectoryLine?` は継承を阻まないので今回は触らない。

## 達成目標

1. `src/game/game.ts` の `serialize()` に、エンティティの種別名(`players` / `enemies` /
   `ammoPickups` / `rcsFuelPickups` / `detachedBoosters` / `bases`)が1つも現れない。
2. `GameSaveData` がエンティティを1本の配列(`entities: EntitySaveDataUnion[]`)だけで持つ —
   種別ごとの配列フィールドが0件。
3. `DynamicSystem.restoreFromSave` に具象クラスを直接 `new` する行が無い(すべて
   `entity-dictionary.ts` の `restorationFor` 経由)。種別ごとの `for` ループが1本になっている。
4. `ObjectPickables.refresh()` が `dynamicSystem` から読む被選択物の経路が1本(`objectPickables`)
   だけになっている。
5. `BaseSaveData` が `EntitySaveData` を継承しており、`save-data.ts` に「基地だけ独立した型に
   する」趣旨のコメントが残っていない。
6. `npm run typecheck` と `npm run test:game` が通る。

## 実績

| 手順 | 変更ファイル数 | diff 行数 | commit |
| --- | --- | --- | --- |
| 手順1 被選択物の多態化 | 9 | 21 | `8bf3caf9` |
| 手順2 kind の判別可能化 | 2 | 19 | `86f4516c` |
| 手順3 直列化・復元の多態化 | 19 | 400 | `1ba693fa` |
| 事後の /refactor(公開範囲の明示) | 7 | 16 | `314fc820` |

合計 21 ファイル・166 追加 / 274 削除(新規1件、削除2件を含む)。見積り(約230行)に対し、
実際は削除が多く純減した。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `SAVE_VERSION` を上げると、開発中に作った実機のセーブスロットが読めなくなる | ローカルの動作確認用セーブが読み込み失敗するように見える(スロット自体は残るが `load` が `null` を返す) | 手順3の手動確認。新規セーブを作り直す前提で進める |
| `Enemy.serialize` を `serializeEnemyFields` へ改名する際、`super.serialize()` の呼び出し元を数え漏らす | 型エラーで気付けるはずだが、見落とすとビルドが壊れる | 手順3。事前調査で `super.serialize()` の呼び出し元は `metal-enemy.ts` と `protein-enemy.ts` の2件のみと確認済み |
| `entity-dictionary.ts` が具象 Enemy クラス(`MetalEnemy` / `ProteinEnemy`)を直接 import する | `enemy.ts` → 具象 → `enemy.ts` と同型の実行時循環に落ち、起動時に例外(`enemy-dictionary.ts` 冒頭コメントに既知の地雷として記録されている問題と同型) | 手順3。`findEnemyClass` 経由でのみ Enemy 具象へ触れる |
| `spawnWhenReady` への改名で `stage.ts` 側の呼び出し名を混同する | `Stage.spawnEnemyWhenReady`(据え置き)と `DynamicSystem.spawnWhenReady`(改名後)は別物なので、取り違えると存在しないメソッドを呼んでビルドが壊れる | 手順3。`stage.ts` 262行目の**呼び出し先**だけを直し、261行目の `Stage` 自身のメソッド定義名は変えない |
| `legacy-save.ts` の `enemyAliveCount` 判定を `metal-enemy` か `protein-enemy` の片方だけにする | 移行データの一覧に出す撃破可能数が過小に出る | 手順3検証。両方の `kind` を判定に含める |
| `normalize-save.ts` を削除したことで、将来 additive なフィールドを version を上げずに足したくなったとき、パッチ先が無い | 次にその種の変更が要るとき、同名のファイルを新規に作り直すことになる(実害は無い、手戻りだけ) | 将来の変更時。今回は「不要なら持たない」を優先した判断(決めたこと D) |
| `BaseSaveData.q` / `w` の必須化を手順2へ前倒しする | 2026-08-09〜08-16 に作られた version 2 のセーブは `q` を欠いたまま読めてしまうため、型だけ必須になった状態で `base.ts` の防御的読みを畳むと `undefined` の spread で姿勢が壊れる | 手順3。必須化は `SAVE_VERSION` の版上げと同じ手順で行う(決めたこと E) |

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

## 手順

### 手順2. `save-data.ts` の `kind` を判別可能にする

**目的**: `EntitySaveDataUnion` という判別可能な union を作れるように、`kind` フィールドの型を
各インタフェースで実際に書き込まれているリテラルへ絞る。**この時点では挙動を変えない** —
`EntitySaveDataUnion` はまだどこからも参照されない、型だけの追加。

**変更が必要な箇所**

| ファイル | 変更 |
| --- | --- |
| `src/game/save/save-data.ts` | `PlayerSaveData`(83行目)に `kind: 'player';` を明示して上書きする。`AmmoPickupSaveData`(163行目)に `kind: 'ammo';` を追加する。`RcsFuelPickupSaveData`(166行目)に `kind: 'rcs-fuel';` を追加する。`EntitySaveData` の `kind`(26行目)の union へ `'base'` を足す。`BaseSaveData`(114行目)に新規フィールド `kind: 'base';` を追加し、**112-113行目の理由コメントを削除する**(継承しない理由になっていないため。決めたこと E)。継承そのものは `q?` / `w?` の必須化と不可分なので手順3で入れる。`export type EntitySaveDataUnion = PlayerSaveData \| MetalEnemySaveData \| ProteinEnemySaveData \| AmmoPickupSaveData \| RcsFuelPickupSaveData \| DetachedBoosterSaveData \| BaseSaveData;` を追加する。 |
| `src/game/dynamic/dynamic-entity/base.ts` | `serialize()`(296行目)の返り値へ `kind: 'base',` を追加する(新規必須フィールドの唯一の生成元)。 |

**達成条件と検証**

- `npm run typecheck` が通る。
- `npm run test:game` が通る。
- `grep -n "基地は艦" src/game/save/save-data.ts` が0件。

### 手順3. `DynamicEntity.serialize()` を基底へ持たせ、復元辞書を作り、`GameSaveData` を1本の `entities` 配列へ畳む

**目的**: 手順1・2で用意した性質を使い、直列化・復元の両方を多態化し、`Game` /
`DynamicSystem.restoreFromSave` から種別の一覧を消す。`SAVE_VERSION` を上げるので、この手順は
挙動(セーブデータの形式)を変える。版上げで読み手を失う `BaseSaveData` の `q?` / `w?` を必須へ
戻し、`EntitySaveData` の派生に戻すのもここで行う(決めたこと E)。

**変更が必要な箇所**

*エンティティ側(直列化を多態化)*

| ファイル | 変更 |
| --- | --- |
| `dynamic-entity.ts` | `checkLoss`(632-636行目)の並びに `public serialize(): EntitySaveDataUnion \| null { return null; }` を追加する。`import type { EntitySaveDataUnion } from '../../save/save-data';` を追加する。 |
| `player/player.ts`(608行目) | `serialize(): PlayerSaveData` に `public override` を付す。 |
| `dynamic-entity/enemy.ts`(418-441行目) | `public serialize(): EnemySaveData` を `protected serializeEnemyFields(): EnemySaveData` へ改名する(具象が共通項目を足すためのヘルパーへ位置づけを変える。`DynamicEntity.serialize()` の override ではなくなる)。冒頭コメントもヘルパーとしての説明へ書き直す。 |
| `dynamic-entity/metal-enemy.ts`(75行目) | `...super.serialize()` を `...this.serializeEnemyFields()` へ変更する。 |
| `dynamic-entity/protein-enemy.ts`(236行目) | 同様に `...super.serialize()` を `...this.serializeEnemyFields()` へ変更する。 |
| `dynamic-entity/ammo-pickup.ts`(73行目) | `public override` を付す。 |
| `dynamic-entity/rcs-fuel-pickup.ts`(70行目) | `public override` を付す。 |
| `dynamic-entity/detached-booster.ts`(162行目) | `public override` を付す。 |
| `dynamic-entity/base.ts`(296行目) | `public override` を付す。 |

*復元の辞書(新規)*

| ファイル | 変更 |
| --- | --- |
| `dynamic/dynamic-entity/entity-dictionary.ts`(新規) | `interface EntityRestoration { readonly pendingAssetId: ProteinAssetId \| null; build(): DynamicEntity; }` と `function restorationFor(data: EntitySaveDataUnion, simTime: number, scene: THREE.Scene, hud: Hud, worldSfx: WorldSfx, markerManager: MarkerManager, effects: EffectsSystem): EntityRestoration \| null` を export する。`data.kind` の網羅的な switch で `Player` / (`findEnemyClass` 経由の) Enemy 具象 / `AmmoPickup` / `RcsFuelPickup` / `DetachedBooster` / `Base` を組み立てる各分岐を書く。`enemy-dictionary.ts` の `findEnemyClass` を import する(具象 Enemy クラスは直接 import しない)。 |

*`DynamicSystem`*

| ファイル | 変更 |
| --- | --- |
| `dynamic-system.ts`(15行目) | `import { findEnemyClass } from './dynamic-entity/enemy-dictionary';` を `import { restorationFor } from './dynamic-entity/entity-dictionary';` へ差し替える。 |
| `dynamic-system.ts`(64行目) | `detachedBoosters` ゲッタを削除する。`DetachedBooster` の import(20行目)も削除する(他に使用箇所が無いことを確認済み)。 |
| `dynamic-system.ts`(106-135行目) | `restoreFromSave` を、`save.entities` を1本の `for` で回して `restorationFor(...)` → `this.spawnWhenReady(restoration.pendingAssetId, restoration.build)` する形へ書き直す。`restorationFor` が `null` を返す(未知の `kind`)場合は読み飛ばす。 |
| `dynamic-system.ts`(161-186行目) | `spawnEnemyWhenReady` を `spawnWhenReady` へ改名し、`build` の型を `() => Enemy` から `() => DynamicEntity` へ、`pendingEnemySpawns` の要素型も同様に広げる(内部の分岐ロジックは変えない)。 |
| `dynamic-system.ts`(新規メソッド、`all()` の近く) | `serialize(): readonly EntitySaveDataUnion[]` を追加する(`this.entities.map((e) => e.serialize())` から `null` を除いたもの)。 |

*呼び出し元*

| ファイル | 変更 |
| --- | --- |
| `stages/stage.ts`(262行目) | `dynamicSystem.spawnEnemyWhenReady(...)` を `dynamicSystem.spawnWhenReady(...)` へ変更する(`Stage` 自身が持つ同名メソッド `spawnEnemyWhenReady`〈261行目の定義〉は改名しない — Stage の呼び出し口としては引き続き Enemy 専用の名で正しい)。 |
| `game.ts`(162-169行目) | 種別ごとの6行を `entities: this.dynamicSystem.serialize(),` の1行へ置き換える。 |

*セーブデータの型(`GameSaveData` の形と `BaseSaveData` の継承)*

| ファイル | 変更 |
| --- | --- |
| `save-data.ts` | `SAVE_VERSION` を `2` から `3` へ。`GameSaveData` の `players` / `enemies` / `ammoPickups` / `rcsFuelPickups?` / `detachedBoosters?` / `bases` の6フィールドを `entities: EntitySaveDataUnion[]` の1本へ置き換える。 |
| `save-data.ts`(114-127行目) | `BaseSaveData` の `q?` / `w?` を必須(`q` / `w`)へ戻し、`export interface BaseSaveData extends EntitySaveData` にする。`EntitySaveData` と重複する `id` / `name?` / `r` / `v` の宣言を落とし、`kind: 'base';`(手順2で追加)・`money` / `fuel?` / `throttle?` / `showTrajectoryLine?` だけを残す。 |
| `dynamic/dynamic-entity/base.ts`(158-167行目) | `savedAtt` の組み立てから `init.saved.q` の真偽分岐と `init.saved.w ? … : v3()` の既定値を落とす(`q` / `w` が欠けることがなくなるため)。`savedAtt` は `'saved' in init` だけで決まる。 |

*旧形式の移行コードの整理*

| ファイル | 変更 |
| --- | --- |
| `save/normalize-save.ts` | 削除する。 |
| `tests/game/normalize-save.test.ts` | 削除する。 |
| `launcher/save/snapshot-service.ts` | `normalizeSaveData` の import と呼び出しを削除する。version チェック後の `data` をそのまま `isEphemerisContextRestorable(data.ephemerisContext)` へ渡し、`stageId` の一致確認と返り値も `data` に対して行う。 |
| `launcher/save/legacy-save.ts`(66-68行目) | `data.bases.reduce(...)` / `data.players.length` / `data.enemies.filter(...)` を、`data.entities` を `kind` でフィルタする形へ書き直す — `money` は `kind === 'base'` の `money` 合計、`playerCount` は `kind === 'player'` の件数、`enemyAliveCount` は `kind` が `'metal-enemy'` または `'protein-enemy'` かつ `alive` の件数。 |

**達成条件と検証**

- `npm run typecheck` が通る。
- `npm run test:game` が通る。
- `grep -n "\.serialize()" src/game/game.ts` の該当行が `this.dynamicSystem.serialize()` の1件だけになっている(`activeStage.serialize()` / `cameraSystem.serialize()` / `celestialSystem.serialize()` は別責務の直列化なので対象外)。
- `grep -n "players:\|enemies:\|ammoPickups:\|rcsFuelPickups?:\|detachedBoosters?:\|bases:" src/game/save/save-data.ts` に `GameSaveData` のフィールドとしての出現が無い(`StageSaveData` 系など無関係な型は対象外)。
- `grep -rn "dynamicSystem.spawnEnemyWhenReady" src` が0件。
- `grep -n "q?:\|w?:" src/game/save/save-data.ts` が0件(`BaseSaveData` の姿勢が必須へ戻っている)。
- `grep -n "interface BaseSaveData extends EntitySaveData" src/game/save/save-data.ts` が1件。
- 手動確認(`npm run dev`): 新規に開始 → セーブ → 一覧から同じスロットをロード、を行い、自機・敵・弾薬・RCS燃料・分離ブースター・基地がそれぞれ復元されることを目視する。**この確認で使う既存のセーブスロットは version 不一致で読めなくなる**ので、確認は今回の変更を含むビルドで新規に作ったセーブを対象に行う。

## 見積り

編集ファイル数と、ファイルあたりの目安行数(diff 行数)から見積もる。

| 手順 | 対象ファイル数 | 内訳 | 目安 diff |
| --- | --- | --- | --- |
| 手順1 | 9(実測) | — | 21行(実測、8bf3caf9) |
| 手順2 | 2 | 型追加・フィールド追加(各数行) | 約15行 |
| 手順3 | 15 | 新規1ファイル(約60行)+ 改名/override付与9ファイル(各1〜5行)+ DynamicSystem書き直し(約40行)+ Game/stage.ts(各1〜7行)+ 削除2ファイル+ launcher側2ファイル(各5〜10行)+ `BaseSaveData` の継承化(`save-data.ts` / `base.ts` で約15行) | 約195行 |

合計 約230行の diff(新規ファイル1件、削除ファイル2件を含む)。

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

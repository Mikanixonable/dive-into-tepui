# 被選択物とフォーカスマーカーを実体へ統合する

マップ上の右クリック対象(`MapPickable`)・天体ラベル(`FocusMarkers`)・エンティティ種別の
語彙、この3つを1つの修正としてまとめる計画。コード計測はすべて **930853c8** 時点。行数・
分岐数・行番号を根拠にしているので、着手前に測り直す。

---

## 目的

### いま何が起きているか — `MapPickable.kind` の 10 値 union

`pickable/map-pickable.ts:5` の

```ts
export type MapPickKind = 'body' | 'ship' | 'player' | 'apsis' | 'relnode' | 'ammo' | 'fuel'
  | 'empty-space' | 'eqnode' | 'base';
```

が、**振る舞いを持たない素の struct のタグ**として置かれ、その振る舞いは全部外側の
`switch` / `if` に手展開されている。値に対する分岐の箇所数:

| モジュール | 行数 | 分岐 |
| --- | --- | --- |
| `pickable/map-context-actions.ts` | 687 | 26 |
| `pickable/map-pickables.ts` | 261 | 15 |
| `pickable/map-property-rows.ts` | 233 | 14 |
| `hud/object-groups.ts` | 63 | 10 |
| `hud/panels/physical-object-list-order.ts` | 246 | 9 |
| `pickable/map-pickable-menu.ts` | 463 | 7 + ディスパッチ表 |
| `hud/panels/physical-object-list-tree.ts` | 224 | 2 |
| `marker/pick-glyphs.ts` | 48 | 2 |
| `hud/panels/physical-object-list-panel.ts` | 426 | 1 |
| **合計** | | **86** |

さらに `MapPickable` は**種別ごとにしか意味を持たない optional フィールド**を 10 本並べている
(`time` / `detail` / `approaching` / `collectable` / `distance` / `distanceFromStar` /
`priority` / `inFocusedSystem` / `ownerName` / `pickable`)。規約 1.6 の「不在は `T | null`」
以前に、そもそも**ある種別には存在しえない値**が全種別に生えている。

**決定的な証拠は `map-pickable-menu.ts:92-383` の
`private readonly handlers: Record<MapPickable['kind'], PickHandler>`。** ここでは既に
「種別ごとに `itemsFor` と `run` を持つ」ことが認められていて、それを**1クラスの中の
291 行のオブジェクトリテラルとして手で書いている。** 多態が必要だと気づいた上で、多態を
使わずに表で代用している状態。

規約 1.2 の「1つの `kind` で、多くのメソッドの大部分が切り替わっている」に真っ直ぐ当たる。
`kind` を1つに固定すると、`map-context-actions` の `isTargetGone`(546) /
`stateOfPickable`(677) / `renameHandlerFor`(591) / `relatedItemsFor`(637) /
`windowParts`(605)、`map-property-rows.rowsFor`(31)の9分岐、
`map-pickable-menu.handlers` の該当キー以外、`object-groups.groupPickables`(11)の switch が
まるごと通らなくなる。

### 同じ物体を指す型が並立している

`MapPickable` は `Player` / `Enemy` / `Base` / `AmmoPickup` / `RcsFuelPickup` /
`CelestialEntity` の**影**でしかない。id と名前と位置を写し取り、実体の側は
`entities.findPlayer(target.id)` で毎回引き直している(`map-property-rows.ts` の 6 メソッド
すべて、`map-pickable-menu.ts` の全 `run`、`map-context-actions.isTargetGone`)。
**「右クリックされたら何をするか」は実体自身の関心事**であり、影の側に持たせているから
実体を引き直す手続きが 30 箇所に散っている。

### 派生値と正データが割れている

`MapPickables` は候補を `itemRecords: Map<string, MutableMapPickable>` で使い回し、毎フレーム
全フィールドを上書きしている。`FocusMarkers` は別に `bodyPickableRecords` /
`cachedBodyPickables` / `cachedBodyPickablesTime` / `cachedBodyPickablesPolicy` を持ち、
`pickable`(画面に出ているか)は次の3箇所が順に書き換える:

1. `FocusMarkers.update()` が `cacheBodyPickable(..., true)` で無条件に `true` を書く。
2. `FocusMarkers.bodyPickables()` のキャッシュヒット枝が `labelsById` の値で上書きし直す。
3. sync フェーズの `MapPickables.syncVisibility()` が `itemRecords` 側へ書き戻す。

**2 が無ければ 1 が前フレームの間引き結果を消す。** 規約 1.6 の
「複数箇所が一定の整合性を保つことが要求されるデータ」そのもので、整合性保持責務が
3モジュールへ漏れている。

### `camera/focus-markers.ts` の4責務

609 行で、次の4つを同居させている。

1. **天体ラベルの構築** — `FocusLabel` の組み立て、ラグランジュ点の命名
   (`lagrangeName` / `lagrangeMarkerLabel`)、分類別の優先度表(`LABEL_PRIORITY`)、
   親を先に子を後に並べる木の構築(コンストラクタの `appendBody`、236-267)。
2. **混雑の解決** — `CrowdingGrid` クラス(103-170)。
3. **マーカーの同期** — `syncLabels`(386-468、82 行)、`syncSubLabels`(473-602、**129 行**)。
4. **`MapPickable` の生成** — `bodyPickables`(271-311)と `cacheBodyPickable`(313-325)。

- **置き場所が誤り。** `camera/` はカメラの姿勢・投影・追従を持つフォルダで、
  「天体ラベルを何個出すか」も「どの被選択物があるか」もカメラの関心ではない。
- 4 は上の `MapPickable` の問題と直結する。
- `syncSubLabels` の 129 行は規約 1.2 の 100 行上限に違反している。

「フォーカスマーカーになるために必要な性質」— 表示名・マーカー表記・分類別の優先度・
階層の深さ — は**どれも天体自身が答えられる**。集合でしか決まらないのは混雑の解決だけで、
これは `GroupedMarkers` が戦闘マーカーに対して既に取っている形(各実体が `markerItem()` を
出し、集合クラスが間引く)とそのまま同じ。

### エンティティ種別の語彙が5つ

「その物体は何か」を表す union が5つある。

```
src/game/random-name.ts:5                     ObjectType        = 'player' | 'enemy' | 'ammo' | 'fuel' | 'base'
src/game/map/visibility-policy.ts:8           DynamicEntityKind = 'player' | 'ship'  | 'ammo' | 'fuel' | 'base'
src/game/marker/marker-manager.ts:98          CombatMarkerKind  = 'self' | 'ally' | 'enemy' | 'base' | 'ammo' | 'fuel'
src/game/pickable/map-pickable.ts:5           MapPickKind       = 'body' | 'ship' | 'player' | 'apsis' | 'relnode'
                                                                  | 'ammo' | 'fuel' | 'empty-space' | 'eqnode' | 'base'
src/game/dynamic/dynamic-entity/bullet.ts:26  Shooter           = 'player' | 'enemy'
```

**`ObjectType` と `DynamicEntityKind` は同じ5要素の集合で、違いは `'enemy'` と `'ship'` という
綴りだけ。** 同一の情報量を持つ型が2つある(規約 1.6 の型の重複)。

`ObjectType` の**定義が `random-name.ts`(ランダム命名ジェネレータ)にある。** ゲームの
物体分類を、命名の都合で作られたモジュールが所有している(規約 1.6「定数は概念の所有者が
持つ」に対応する置き場所の誤り)。しかも `creative/object-placer-panel.ts:32` が
`export type { ObjectType }` で再 export していて、同じ値への入口が2つある。

`'ship'` は**敵機だけ**を指しているのに、同じ union の `'player'` も艦なので、名前が区別を
言えていない — 規約 2.1「曖昧な区別。区別すべきものを同じ名前で指す命名」。規約 2.2 は
「機体は `ship`」と定めているので、敵機だけを `ship` と呼ぶのは規約違反でもある。実際に
破綻していて、`physical-object-list-order.ts:93` は
`if (this.filter === 'enemy') return item.kind === 'ship' …` と**同じものを2つの語で
書き分けている。** 表示トグルのキー(`shipVisible` / `shipName` / `shipOrbit`)も同じ綻びで、
`view-options-panel.ts:92` は `{ label: '敵', categoryKey: 'shipVisible' }` とラベルだけ
正しい。

`CombatMarkerKind` は `'self'` / `'ally'` を分けている点だけが違う — これは
「自分か味方か」という**別の軸(視点)を種別に畳み込んだ**もので、規約 1.6
「『たまたま』同時に切り替わるフラグは別個にする」に当たる。さらに
`combatMarkerKindOf(cls: string)`(marker-manager.ts:102)が CSS クラス名から種別を復元して
いて、**表示文字列から値を読み戻している**(規約 1.6 の正データの分散)。読み戻した値は
`marker-manager.defaultPriorityForClass`(65)・`isCombatMarker`(115)と
`focus-markers.syncSubLabels` の内訳集計(550)に使われている。

`Shooter` は残してよい。弾がどちら側から出たかは**種別ではなく所属**で、2値であることに
意味がある(規約 1.5「自機と敵の戦闘挙動は一般化しない」)。

### 修正後に期待される状態

- 「右クリックされたら何を出し、選ばれたら何をするか」を、**その物体自身**が答える。
  実体を id で引き直す手続きが消える。
- 天体ラベルに要る性質は `CelestialEntity` が持ち、集合でしか決まらない間引きだけを
  マーカー集合クラスが持つ。`camera/` から天体ラベルの知識が消える。
- 物体の種別を表す語彙が1つになり、`'ship'` が敵機を指す用法が `src/` から消える。

---

## 決めたこと

ユーザーが覆せる判断を先に置く。覆されたときにどの手順が変わるかも書く。

### 1. 中間形を作らず、最終の持ち主へ直接移す

「まず `pickable/` に具象クラスを 10 個作り、次にそれを実体へ畳む」という2段構えを取らない。
`PlayerPickable.menuItems` を書いてから `Player.mapMenuItems` へ移す、という**同じコードの
移動を2回**行うことになるうえ、途中の commit で「実体としての Player」と「被選択物としての
Player」が並立する。

代わりに**関心ごとに手順を割る** — メニュー(手順3)・プロパティ行(手順4)・一覧の見え方
(手順5)を、それぞれ1回だけ最終の持ち主へ移す。各手順は独立して commit でき、分岐は手順を
追うごとに単調に減る。

**覆されたとき:** 手順2〜5 を「具象クラスを作る」「実体へ畳む」の2段に割り直す。
手順6以降は変わらない。

### 2. 実体でないものはマーカークラスにする

`apsis` / `relnode` / `eqnode` / ラグランジュ点は実体ではない(積分の対象でもメッシュの
持ち主でもない)が、**画面上に存在し、右クリックの挙動を持つ**。これは1つのオブジェクトの
関心事なので、クラスにする。置き場所は `marker/`。

現状これらは「表示用の struct」として `plan-display.ts`(`ApsisIcon`、48-50)・
`nav-target.ts`(301-311 のその場のリテラル)・`equator-node-marker-pair.ts`
(`EqNodeIcon`、17-19)・`focus-markers.ts`(ラグランジュ点)に散っており、**マーカーを描く
処理もそれぞれの所有者側にある。** クラスへ寄せると、被選択物としての振る舞いと、マーカーと
しての描画が1箇所に揃う。

最終的に `pickable/` に残る `MapPickable` 専用の具象型は、どれにも当たらなかったときへ落ちる
`EmptySpacePickable` だけになる。

**覆されたとき:** マーカー4種は `pickable/` の具象クラスのまま残し、手順9(描画責務の集約)を
落とす。手順2〜6 の内容は変わらない。

### 3. 種別語彙は `DynamicEntityKind` 1つ(実施済み — a77c1cc4)

`MapPickKind` は手順5で消えるが、`DynamicEntityKind` は**消えない** — 表示トグルの引き当て
(`MapVisibilityPolicy.entity`)・軌道物体一覧の区画キー・ランダム命名・物体配置パネルの
選択肢という、**表の鍵としての用途**が残る。これは振る舞いの分岐ではないので多態にしない
(規約 1.8 が天体分類の switch を許しているのと同じ理由)。

いまコードは次の状態にある。

- `dynamic/dynamic-entity/entity-kind.ts` が
  `DynamicEntityKind = 'player' | 'enemy' | 'ammo' | 'fuel' | 'base'` を持つ唯一の所有者。
  `ObjectType` は無い。
- `Player` / `Enemy` / `Base` / `AmmoPickup` / `RcsFuelPickup` が
  `public readonly mapKind: DynamicEntityKind` を名乗る。基底 `DynamicEntity` は持たない。
- 表示トグルのキーは `enemyVisible` / `enemyName` / `enemyOrbit`。旧キーは既定値へ落ちる。
- `MapPickKind` の `'ship'` は `'enemy'` になっている。

**残った疑問点。** `object-placer-panel.ts` の `objectType`(`ObjectPlacerForm.objectType` /
`ObjectPlacerPreset` / `openObjectPlacerForDuplicate` の引数)が `DynamicEntityKind` と
同じものを別の語で指している(規約 2.1 の類義語の混雑)。手順3で `MapCommands.duplicate` を
通すときに `entityKind` へ揃える。

`dynamic-system.ts` の `applyVisibility` に、分離ブースターが敵トグルへ従っていることへの
TODO を置いた。挙動は変えていない。

### 5. `MapCommands` という役割インターフェースを立てる

実体(`Player` / `Base` / …)は `Docking` / `PlanEditor` / `SimSpeedManager` / `PauseMenu` /
`Hud` を**直接 import できない** — `docking/docking.ts` は `Player` を値 import しており、
逆向きの import を足すと実行時の循環になる。したがってメニューの構築と実行を実体へ移すには、
**操作の側をインターフェースで受ける**しかない。

```ts
// src/game/pickable/map-commands.ts (新規)
// マップ上の被選択物が起動できる操作と、項目のラベル・可否を決めるために要る現在の操作状態。
// 実体・マーカーはこの口だけを見て項目を組み、選ばれた操作を実行する。
export interface MapCommands {
  focus(id: string, name: string): void;
  toggleNavTarget(id: string, name: string): void;
  warpTo(t: number): void;
  addNodeAt(t: number): void;
  setActivePlayer(ship: Player | null): void;
  removePlayer(ship: Player): void;
  setControlledBase(base: Base | null): void;
  dock(target: DynamicEntity): void;
  undock(): void;
  transferResources(target: DynamicEntity): void;
  duplicate(kind: DynamicEntityKind, state: KinematicState): void;
  openObjectPlacer(): void;
  openSettings(): void;
  toggleBasePanel(base: Base): void;
  hint(text: string): void;

  readonly activePlayer: Player | null;
  readonly controlledBase: Base | null;
  readonly authoring: ObjectAuthoring | null;
  readonly executesPlans: boolean;
  isNavTarget(id: string): boolean;
  canNavTarget(id: string, simTime: number): boolean;
  dockState(target: DynamicEntity): 'docked' | 'dockable' | 'none';
  isBasePanelExpanded(base: Base): boolean;
}
```

**これは規約 1.6 が禁じる `Ctx` ではない。** 集めているのは値ではなく**操作**であり、名前は
「何が集まっているか」(マップから起動できるコマンド)を言っている。既存の `FrameControls`
(座標系に対する操作)と同じ形。後半の 8 本は操作そのものではないが、「どの項目を出すか」を
決めるためだけに要る**同じ操作面の状態**なので、同居させる。

**天体レジストリ(`CelestialSystem`)はここへ入れない。** 名前の解決に要るのは天体の
メニューと行だけなので、`mapMenuItems` / `mapPropertyRows` の引数として渡す。

実装は **`MapContextActions` 自身が `implements MapCommands` する。** 協力者はすでに全部
そこにあり、`toggleBasePanel` / `isBasePanelExpanded` はウィンドウ台帳を必要とするので、
別クラスへ切ると台帳へのコールバックを足すことになる。

**覆されたとき:** メニュー構築だけは実体の外(`pickable/` の具象クラス)に残す。手順3が
「具象クラスへ移す」に変わり、手順4・5はそのまま実体へ移す。

### 6. キャッシュは全部落とす

`MapPickables.itemRecords` / `activeRecordKeys`、`FocusMarkers.bodyPickableRecords` /
`cachedBodyPickables` / `cachedBodyPickablesTime` / `cachedBodyPickablesPolicy` は
**新設しない。** 候補列は毎フレーム組み直す。

候補数は負荷確認ウィンドウの `mapItems` で観測できる(`MapPickables.perfCounts()`)。実測して
困ったらそのとき戻す。

**覆されたとき:** 手順2・6の一部が落ちるだけで、他の手順は変わらない。

### 7. 一覧の並べ替えに使う派生値は一覧が持つ

`distance` / `distanceFromStar` / `inFocusedSystem` は `MapPickable` のフィールドから外す。
これらは**軌道物体一覧の並べ替えと絞り込みにしか使われない**(`PhysicalObjectListOrder` の
`compare`(168)と `matches`(85))。`compare` は毎フレーム O(n log n) 回呼ばれるので、その中で
`mapPosAt()` を呼び直すと 200 候補で 3,200 回の状態補間になる。したがって一覧側が
1フレーム1回だけ導出して持つ。

```ts
// physical-object-list-order.ts
// 一覧の1行が今フレームどこに並ぶかを決める値。候補そのものは MapPickable が持つ。
interface ListSortKey {
  readonly distance: number;         // 自艦から [m]
  readonly distanceFromStar: number; // 恒星から [m]。恒星が無ければ distance と同値
  readonly inFocusedSystem: boolean;
}
```

**これは手順2で実施する。** 手順2が `itemRecords` を落とすと派生値の書き込み先が無くなる。
手順5まで待つと、候補を包む1フレームだけの器を作って捨てることになり、決めたこと1に反する。

**覆されたとき:** 手順2で `MapPickable` に `listDistance(viewer)` 等のメソッドを置き、
一覧側の派生値を持たない。`compare` の呼び出し回数を実測してから決め直す。

---

## 達成目標

全手順の実施後、次がすべて満たされること。

1. `grep -rn "MapPickKind" src/` が **0 件**。
2. `grep -rn "ObjectType" src/` が **0 件**(`DynamicEntityKind` へ一本化)。
3. `grep -rn "'ship'" src/` が **0 件**(敵機を指す用法が消える)。機体一般を指す語としての
   `ship`(`LINE_RENDER_ORDER.shipOrbit`、`shipMarkerSvg` など)は残ってよい。
4. `grep -rn "combatMarkerKindOf\|CombatMarkerKind" src/` が **0 件**。
5. 冒頭の表に挙げた 86 箇所の `kind` 分岐が **0 件**。
6. `src/game/pickable/map-pickable-menu.ts` / `src/game/pickable/map-property-rows.ts` /
   `src/game/marker/pick-glyphs.ts` / `src/game/camera/focus-markers.ts` が **存在しない**。
7. `grep -rn "MutableMapPickable\|cachedBodyPickables\|itemRecords\|syncVisibility" src/` が
   **0 件**。
8. `grep -rn "findPlayer(target.id)\|findEnemy(target.id)\|findBase(target.id)" src/` が
   **0 件**(被選択物から実体を引き直す手続きが消える)。
9. `src/game/` に 100 行を超える関数が**増えていない**。特に `syncSubLabels`(129 行)が
   解消されている。
10. `npm run typecheck` と `npm run test` が通る。
11. 各手順の「達成条件と検証」に挙げた目視項目が、すべて確認できている。

---

## 手順

### 手順 2. `MapPickable` を interface にして、実体・マーカーに実装させる

**目的**

被選択物の**同一性・位置・可視性・存否**を、その物体自身が答える形にする。振る舞い
(メニュー・行・一覧)はまだ移さない — この手順は器を差し替えるだけで、**挙動を変えない。**
`kind` は各実装が `readonly kind` として持ち続け、外側の分岐もそのまま残る。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `pickable/map-pickable.ts` | `MapPickable` を下記の interface へ。`pickNearest` は `{ readonly pos: Vec3 }` を取る形をやめ、位置を取り出す関数を受ける形にする |
| `player/player.ts` | `implements MapPickable`。`mapPosAt` = `stateAt(t)?.r`、`gone` = `findPlayer` 相当の除去判定、`mapState` = `state` |
| `dynamic/dynamic-entity/enemy.ts` / `base.ts` / `ammo-pickup.ts` / `rcs-fuel-pickup.ts` | 同上。`gone` = `!alive` |
| `celestial/celestial-entity/celestial-entity.ts` | `implements MapPickable`。`mapPosAt` = `stateAt(t).r`、`gone` = `false`、`mapState` = `stateAt(t)` |
| `marker/apsis-marker.ts` | **(新規)** `plan-display.ts:48-50` の `ApsisIcon` を昇格。`id` / `name` / `pos` / `time` / `ownerName` / `label` を持つ |
| `marker/relative-node-marker.ts` | **(新規)** `nav-target.ts:301-311` が組んでいる AN / DN / 再接近点のリテラルを昇格 |
| `marker/equator-node-marker.ts` | **(新規)** `equator-node-marker-pair.ts:17-19` の `EqNodeIcon` を昇格 |
| `marker/lagrange-point-marker.ts` | **(新規)** `focus-markers.ts` がラグランジュ点として組んでいる候補を昇格。`parentId` と点番号(1〜5)を値として持ち、id からの正規表現解決に頼らない |
| `pickable/empty-space-pickable.ts` | **(新規)** `map-context-actions.ts:446` のリテラルを昇格 |
| `pickable/map-pickables.ts` | `MutableMapPickable` / `itemRecords` / `activeRecordKeys` / `addCandidate` / `appendPickable` を削除。候補列は各供給元が返す `MapPickable` をそのまま積む。`syncVisibility()`(51-63)を削除し、`pickable` の参照を `shownOnMap()` の問い合わせへ置き換える |
| `camera/focus-markers.ts:271-325` | `bodyPickables` は `CelestialEntity` と `LagrangePointMarker` を返すだけにする。`cachedBodyPickables*` / `bodyPickableRecords` / `cacheBodyPickable` を削除 |
| `plan/plan-display.ts:48-50,88,116,130,169-176,233-,323` | `ApsisIcon` を `ApsisMarker` へ差し替え |
| `nav-target.ts:301-311` | `RelativeNodeMarker` を返す |
| `marker/equator-node-marker-pair.ts:17-19,93-113` | `EqNodeIcon` を `EquatorNodeMarker` へ差し替え |
| `camera/focus-target.ts:26-33` | `FocusCandidate` は `{ id, pos }` を要求している。`pos` がメソッドになるので `{ id: string; mapPosAt(t: number): Vec3 \| null }` へ変えるか、`map-camera.ts` 側で解決済みの位置を渡す。**`focus-target.ts` は `tsconfig.test.json` の include に入っているので、`MapPickable` 型そのものを import してはいけない**(既存コメントの理由がそのまま生きる) |
| `camera/map-camera.ts:443,499` / `camera/camera-system.ts:217` | 候補列の型に追随 |
| `hud/frame/frame-controls.ts:98` / `anchor-zone.ts:54,65` / `camera-frame-panel.ts:122` / `trajectory-frame-panel.ts:69` | 同上 |

```ts
// src/game/pickable/map-pickable.ts
// この手順では identity/位置/可視/存否まで。手順3〜5で口が増える。
export interface MapPickable {
  readonly id: string;
  readonly name: string;
  // 表示時刻の ECI 位置。予測地平の外などで求まらないフレームは null(その回は候補に出ない)。
  mapPosAt(displayTime: number): Vec3 | null;
  // 表示トグルによる可否。activePlayer は「操作中の自艦はカテゴリを閉じても残す」例外の判定に使う。
  mapVisibility(policy: MapVisibilityPolicy, activePlayer: Player | null): MapVisibility;
  // 直前のフレームで画面にマーカーが出ていたか。ラベル衝突・遮蔽で消えた対象を掴めなくする。
  shownOnMap(markers: MarkerManager): boolean;
  // 対象そのものが消滅したか(true でプロパティウィンドウを閉じる)。
  readonly gone: boolean;
  // 軌道要素の導出に使う現在状態。実体を持たないマーカーは null。
  readonly mapState: KinematicState | null;
}
```

**達成条件と検証**

- `grep -rn "MutableMapPickable\|itemRecords\|cachedBodyPickables\|syncVisibility" src/` が 0 件。
- `npm run typecheck` / `npm run test:game`。
- `npm run dev`:
  - マップで天体・自艦・敵艦・基地・弾薬・RCS燃料・近点/遠点・AN/DN・赤道交点をそれぞれ
    右クリックしてプロパティウィンドウが開く。
  - ラベルが混雑して消えた天体を右クリックしても掴めない(手前のラベルが拾われない)。
  - 敵艦を撃破するとその敵のプロパティウィンドウが閉じる。未来ゴーストのスライダーを先へ
    出して位置が求まらないフレームでは閉じない。
  - 負荷確認ウィンドウの `mapItems` と frame time が手順前と同じ桁。

---

### 手順 3. メニュー項目と実行を実体・マーカーへ移す

**目的**

`map-pickable-menu.ts` の 291 行のディスパッチ表を解体し、各物体が自分の項目と実行を持つ形に
する。**この手順で `MapCommands` を新設する**(決めたこと 5)。表示される項目とその効果は
変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `pickable/map-commands.ts` | **(新規)** `MapCommands` インターフェース(決めたこと 5 の署名) |
| `pickable/map-pickable.ts` | `mapMenuItems(commands, celestialSystem, simTime)` / `runMapMenu(act, commands)` を追加 |
| `pickable/map-pickable-menu.ts` | **削除。** `bodyParentId`(38-45)は `celestial/lagrange-id.ts` か `celestial-system.ts` へ移す(`map-context-actions.ts:648` が使う) |
| `pickable/map-context-actions.ts` | `implements MapCommands`。`pickableMenu` フィールドを削除し、`this.menu.onSelect`(121)・`w.onSelect`(209)・`windowParts`(605)を `target.runMapMenu(act, this)` / `target.mapMenuItems(this, …)` へ。`isTargetGone`(546-558)・`renameHandlerFor` の呼び出し・`relatedTitleFor`(672-675)・`stateOfPickable`(677-685)を削除 |
| `player/player.ts` | `map-pickable-menu.ts:227-294` の `'player'` ハンドラを移す |
| `dynamic/dynamic-entity/enemy.ts` | 同 `'ship'` ハンドラ(115-141) |
| `dynamic/dynamic-entity/base.ts` | 同 `'base'` ハンドラ(315-382) |
| `dynamic/dynamic-entity/ammo-pickup.ts` / `rcs-fuel-pickup.ts` | 同 `'ammo'` / `'fuel'` ハンドラ(142-179)。**共通の基底は作らない** — 2種の違いは削除先だけで、`DynamicEntity` の直下に並ぶのが自然 |
| `celestial/celestial-entity/celestial-entity.ts` | 同 `'body'` ハンドラ(93-114)。副題(母星/衛星/恒星の別)は天体自身が答える |
| `marker/lagrange-point-marker.ts` | `'body'` ハンドラのラグランジュ点枝(96-103) |
| `marker/apsis-marker.ts` / `relative-node-marker.ts` / `equator-node-marker.ts` | 同 `'apsis'` / `'relnode'` / `'eqnode'` ハンドラ(180-226)と `runApsisRelnode`(445-461)。時刻は各マーカーが必ず持つので、`editor.planDisplay.apsisTimeOf` / `navTarget.passTimeOf` へのフォールバックは消える |
| `pickable/empty-space-pickable.ts` | 同 `'empty-space'` ハンドラ(295-314) |
| `pickable/map-pickable-menu.ts` の `targetItems`(387) / `duplicateItems`(394) / `runDuplicate`(399) / `duplicateSourceFor`(409) / `runBodyShip`(436) | 「ターゲット設定」「複製」「フォーカス」は複数の種別が同じ項目を出す。**共通の項目ファクトリとして `hud/windows/menu-actions.ts` の `MenuCommon` へ寄せる** — 既にそこが「頻出する項目を組み立てる共通ファクトリ」を名乗っている。`duplicateSourceFor` の5分岐は `mapKind` と `state` が実体にあるので消える |
| (全実装) | **`hud/windows/index.ts`(バレル)を import してはいけない** — バレルは `resource-transfer-dialog.ts` 経由で `Player` を値 import しており実行時の循環になる。`hud/windows/menu-actions` / `hud/windows/context-menu`(型のみ)を直接指す |

**達成条件と検証**

- `src/game/pickable/map-pickable-menu.ts` が存在しない。
- `grep -rn "PickHandler\|handlers\[" src/game/pickable/` が 0 件。
- `npm run typecheck` / `npm run test:game`。
- `npm run dev`:
  - 天体・自艦(操作中/非操作)・敵艦・基地・弾薬・RCS燃料・近点/遠点・AN/DN・赤道交点・
    空域、**10 種すべて**を右クリックして、項目の並びと有効/無効が手順前と同じ。
  - 自艦の「操作対象にする/解除」「軌道計画の実行」「複製」「削除」「ドッキング/資源移送/
    分離」、基地の「基地パネルを展開/収納」「操作対象にする」、近点の「ワープ」
    「ノードを追加」が動く。
  - 戦闘ビューでの右クリック(実体ヒット/空域)も同じ項目が出て、ショートカット表記だけが
    出ないこと。

---

### 手順 4. プロパティ行を実体・マーカーへ移す

**目的**

`MapPropertyRows.rowsFor` の9分岐を各物体へ移し、実体を id で引き直す6メソッドを消す。
**この時点で行の内容は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `pickable/map-pickable.ts` | `mapPropertyRows(celestialSystem, celestialBodies, pivot, viewer: Player \| null, simTime): readonly PropertyRow[]` と `readonly mapRename: ((name: string) => void) \| null` を追加 |
| `pickable/orbit-rows.ts` | **(新規)** `map-property-rows.ts:50-73` の `orbitRows` を関数として切り出す。`DynamicEntity` を受け、基準天体・高度・速度・AP/PE/INC/PRD を返す |
| `pickable/map-property-rows.ts` | **削除** |
| `pickable/map-context-actions.ts:578-603` | `propertyRows` フィールドを削除。`syncRows` は `entry.target.mapPropertyRows(...)`、`buildContent` の `onRename` は `target.mapRename` |
| `player/player.ts` | `playerRows`(75-91)。`mapRename` は `(name) => { this.name = name; }` |
| `dynamic/dynamic-entity/enemy.ts` | `shipRows`(93-117) |
| `dynamic/dynamic-entity/base.ts` | `baseRows`(119-132)。`mapRename` あり |
| `dynamic/dynamic-entity/ammo-pickup.ts` / `rcs-fuel-pickup.ts` | `ammoPickupRows` / `rcsFuelPickupRows`(134-173) |
| `celestial/celestial-entity/celestial-entity.ts` | `bodyRows`(175-206)の天体枝。`motion.kind` に対する switch は規約 1.8 が許すのでそのまま |
| `marker/lagrange-point-marker.ts` | `bodyRows` のラグランジュ点枝(181-184) |
| `marker/apsis-marker.ts` | `apsisRows`(208-219) |
| `marker/relative-node-marker.ts` / `equator-node-marker.ts` | `nodeRows`(221-233)。対象名の求め方が違う(前者は航法ターゲット名、後者は中心天体名)ので、分岐ごと2つへ割れる |
| `pickable/empty-space-pickable.ts` | 空配列 |

**達成条件と検証**

- `src/game/pickable/map-property-rows.ts` が存在しない。
- `grep -rn "findPlayer(target.id)\|findEnemy(target.id)\|findBase(target.id)" src/` が 0 件。
- `npm run typecheck` / `npm run test:game`。
- `npm run dev`:10 種すべてのプロパティウィンドウを開き、行の顔ぶれ・順序・「詳細」トグルの
  下に畳まれる行・「軌道」グループの中身が手順前と同じ。自艦と基地で改名できる。自艦がいない
  状態(操作対象を解除)でも敵艦・基地の行が落ちない。

---

### 手順 5. 一覧・選択ウィジェット・記号を実体・マーカーへ移す

**目的**

軌道物体一覧・`ObjectPicker` のジャンル分け・凡例記号の分岐を消し、**`MapPickKind` を
削除する。** ここで `kind` に対する分岐が `src/` から無くなる。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `pickable/map-pickable.ts` | `MapPickKind` を削除。代わりに次を追加:<br>`readonly mapGlyph: string \| null`(文字記号。空域は null)<br>`readonly mapGlyphSvg: string \| null`(SVG を描ける場所用)<br>`readonly listSection: MapListSection \| null`(null = 一覧に出さない)<br>`readonly pickerGenre: ObjectPickerGenre \| null`(null = 選択ウィジェットに出さない)<br>`listDetail(celestialSystem, viewer: KinematicState \| null, displayTime: number): string`(行に**表示する**補助表示。天体は空文字)<br>`listSearchText(celestialSystem, viewer: KinematicState \| null, displayTime: number): string`(検索が**照合する**文字列。天体は距離と中心天体名を返す)<br>`listCounted(viewer: KinematicState \| null): boolean`(区画見出しの内訳に数えるか)<br>`readonly listPriority: number`(小さいほど先。既定 0) |
| `hud/panels/physical-object-list-panel.ts:19-26,45-49,392-409` | `export type MapListSection = 'body' \| DynamicEntityKind;` を定義。`SECTIONS` はここに残す — 区画の順序と見出しはパネルの関心。`HEADER_SUMMARY` は `{ section, label }` だけを持ち、数える述語は `listCounted` へ |
| `hud/object-groups.ts:8,11-58` | `ObjectPickerGenre` を定義(11 ジャンル)。`groupPickables` の switch(23-42)を削除し、`item.pickerGenre` で振り分けるだけにする。`includeAllCelestialBodies` の枝(47-58)は `CelestialEntity.pickerGenre` を読む |
| `hud/panels/physical-object-list-order.ts:4,85-97,102-118,131-165,168-190,197-204` | `MapPickKind` の import を削除。`matches` の `item.kind === …` を `listSection` と `ListSortKey.inFocusedSystem` へ。`compare` は `ListSortKey`(決めたこと 7)を引く。`lagrangeSortKeyOf` は `LagrangePointMarker` が点番号を値として持つので、id からの正規表現解決ごと不要になる。`rebuildOrder` の `kind` 引数は `MapListSection` へ。`PrevInput.kind` も同様 |
| `hud/panels/physical-object-list-tree.ts:75,82,89,91` | `pickGlyphSvg` / `pickGlyphText` を `item.mapGlyphSvg` / `item.mapGlyph` へ。`item.kind === 'body'` による detail の出し分け(89,91)は、天体の `listDetail` が空文字を返すことで消える |
| `marker/pick-glyphs.ts` | **削除。** `TEXT_GLYPHS` / `SVG_GLYPHS` の各行は対応する実体・マーカーの `mapGlyph` / `mapGlyphSvg` へ。「一覧とプロパティウィンドウで同じ種別が別の形に見えない」という不変は、値が1箇所になることで自動的に保たれる |
| `pickable/map-context-actions.ts:581` | `pickGlyph(target.kind, …)` → `target.mapGlyphSvg ?? target.mapGlyph` |
| `pickable/map-pickables.ts:152-181` | `detail` / `approaching` / `collectable` / `priority` / `distance` / `distanceFromStar` / `inFocusedSystem` を組み立てる部分を削除 |
| `hud/panels/physical-object-list-order.ts:210-217` | `matchText` は `listSearchText` を読む。キャッシュの古さ判定に使っている `name`/`detail` の保持も `listSearchText` の結果1本にする |
| (全実装) | `mapGlyph` / `mapGlyphSvg` / `listSection` / `pickerGenre` / `listDetail` / `listSearchText` / `listCounted` / `listPriority` を実装。中身は `map-pickables.ts:168-172` の三項演算子の連鎖を種別ごとに割ったもの。**表示と検索が分かれるのは天体だけ**で、他の種別は `listSearchText` が `listDetail` をそのまま返す |

**達成条件と検証**

- `grep -rn "MapPickKind" src/` が 0 件。
- `src/game/marker/pick-glyphs.ts` が存在しない。
- 冒頭の表の 86 箇所の分岐が 0 件。
- `npm run typecheck` / `npm run test:game`。
- `npm run dev`:
  - 軌道物体一覧の6区画(天体/自艦/敵/弾薬/RCS燃料/基地)の顔ぶれ・件数・記号・補助表示・
    並び(太陽系順/近さ/名前)・絞り込み(惑星〜ラグランジュ点/人工物/敵)・検索が手順前と同じ。
  - 見出しの内訳「接近 N」「回収可 N」が正しい。
  - 天体区画の親子ツリーと、「衛星」絞り込み時のクラスタ見出し(淡色の親惑星行)が崩れない。
  - 木星 L4/L5 を出した状態で行が毎フレーム入れ替わらない。
  - 座標系パネルのアンカー選択(`ObjectPicker`)のジャンル分けが同じで、11 ジャンル出る。

---

### 手順 6. 候補列とウィンドウ台帳から寿命の混在を外す

**目的**

`MapPickables` を「今フレーム選べるものを並べるだけ」にし、`MapContextActions` のウィンドウ
台帳が**対象そのものを保持する**形にする。いまは毎フレーム作り直す候補と、フレームを跨いで
持つ target が同じ器で混ざっていて、`byKey` で毎フレーム引き直している。手順2〜5で対象が
安定した同一性を持つオブジェクトになったので、この引き直しは不要になる。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `pickable/map-pickables.ts` | `refresh`(76-200)を、供給元が返す `MapPickable` を積むだけの形へ。可視・遮蔽の絞り込み(183-197)は残す |
| `pickable/map-context-actions.ts:55,192-222,228-230,502-506` | `WindowEntry.target` を `readonly` にし、`sync` の `byKey` 引き直しを削除。`windowKey` は `${target.id}` だけで足りるか確認する — 天体・実体・マーカーの id 空間が衝突しないなら種別込みをやめる |
| `pickable/line-pickable.ts:21` / `line-pickables.ts:42,52,92` | `ownerKeys` の `${kind}:${id}` を `windowKey` の変更に追随させる |
| `hud/panels/physical-object-list-order.ts` | `ListSortKey` を1フレーム1回導出する |

**達成条件と検証**

- `grep -rn "byKey" src/game/pickable/` が 0 件。
- `npm run typecheck` / `npm run test:game`。
- `npm run dev`:
  - プロパティウィンドウを開いたまま未来ゴーストのスライダーを動かし、値が更新され続ける。
  - ウィンドウを開いたまま対象が遮蔽・ラベル衝突で候補列から外れても閉じない。撃破・回収・
    削除では閉じる。
  - 軌道線を右クリックして開くウィンドウの「所属」欄から、所属先のプロパティウィンドウが開く。
  - 天体のプロパティウィンドウの「周回物体」欄に、その天体を回る船・基地が出る。

---

### 手順 7. 戦闘マーカーの種別を値として渡す

**目的**

`combatMarkerKindOf(cls: string)` が CSS クラス文字列から種別を読み戻しているのをやめ、
マーカー登録時に値として渡す。同時に「自分か味方か」という視点の軸を種別から外す。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `marker/grouped-markers.ts:19-36` | `GroupedMarkerItem` に `readonly kind: DynamicEntityKind` と `readonly isSelf: boolean` を追加 |
| `marker/marker-manager.ts:65-82,98-117` | `CombatMarkerKind` / `combatMarkerKindOf` / `isCombatMarker` を削除。`defaultPriorityForClass` の陣営枝を削除する前に、戦闘マーカーがすべて `markerItem` で `priority` を明示していて既定へ落ちる経路が無いことを確かめる |
| `player/player.ts:745-766` | `markerItem` に `kind: 'player'`, `isSelf: isActive` を足す。`kindCls` の決め方(`mk-self` / `mk-ally`)は変えない |
| `dynamic/dynamic-entity/enemy.ts:195-210` / `base.ts:320-340` / `ammo-pickup.ts:65-82` / `rcs-fuel-pickup.ts:62-79` | 同上 |
| `camera/focus-markers.ts:75-89,543-566` | `SUB_LABEL_GLYPH_BY_KIND` / `cleanSubLabelGlyph` / 内訳集計を `item.kind` と `item.isSelf` で書き直す |

**達成条件と検証**

- `grep -rn "combatMarkerKindOf\|CombatMarkerKind" src/` が 0 件。
- `npm run typecheck` / `npm run test:game`。
- `npm run dev`:マップで自艦・僚艦・敵・基地・弾薬・燃料のマーカーの色・記号・重なり順が
  手順前と同じ。遠距離の天体ラベル下のサブ行(`△3 ▲1 ⬡1` の形)の内訳が正しい。

---

### 手順 8. 天体ラベルを `CelestialEntity` とマーカー集合へ分ける

**目的**

`camera/focus-markers.ts` を解体し、`camera/` から天体ラベルの知識を出す。ラベルに要る性質は
天体自身が持ち、集合でしか決まらない間引きだけを集合クラスが持つ。129 行の `syncSubLabels` を
分ける。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `celestial/celestial-entity/celestial-entity.ts` | `markerLabel`(= `name`)と `labelPriority`(`focus-markers.ts:92-100` の `LABEL_PRIORITY` を `bodyClass` から引く)を持たせる。優先度の値は `game/const.ts` の `MARKER_PRIORITY` にあるので、所有者を天体側へ寄せられるか併せて見る |
| `celestial/celestial-system.ts` | 親を先に子を後に並べた順序と `depth` を持たせる(`focus-markers.ts:236-267` のコンストラクタから移す)。`ancestorsOf` / `sameSystemIds` と同じ場所にあるべき情報 |
| `marker/celestial-markers.ts` | **(新規)** `FocusMarkers` の残り(`update` / `syncLabels` / `activeLabels` / `shownLabelCount` / `hideLabels`)。`GroupedMarkers` と同じ形 — 各天体・ラグランジュ点マーカーが自分の項目を出し、集合が間引く |
| `marker/celestial-sub-labels.ts` | **(新規)** `syncSubLabels`(473-602)。天体ラベルの下へ隠れた船をぶら下げる処理は、ラベルの間引きとは別の関心。第1段階(左揃えリスト)と第2段階(記号+個数)を別メソッドへ割り、いまマジックナンバーで置かれている `DIST_STAGE2_THRESHOLD = 5e9` と `maxLines = 3` を名前付き定数にする |
| `marker/crowding.ts` | `CrowdingGrid`(`focus-markers.ts:103-170`)をここへ移す。`resolveCrowdingWinner` が既にここにある。**前フレームの隠し集合(ヒステリシス)を落とさない** |
| `camera/focus-markers.ts` | **削除** |
| `camera/camera-system.ts` | `focusMarkers` フィールドの持ち主を変える。天体マーカーはカメラではなく `MarkerManager` が持つ |
| `game.ts:362,380,573,578,629` ほか | 呼び出し元の追随 |
| `pickable/map-pickables.ts:88-90,104` | `focusMarkers.update` / `bodyPickables` の呼び出しを差し替え |
| `targeter.ts:203` | `cameraSystem.focusMarkers.activeLabels` の参照先 |
| `pickable/map-context-actions.ts:489` | `cameraSystem.focusMarkers.allLabels` の参照先。親子関係は `CelestialSystem` から引ける形になる |

**達成条件と検証**

- `src/game/camera/focus-markers.ts` が存在しない。
- `grep -rn "Label\|Pickable" src/game/camera/` が `focus-target.ts` の `FocusCandidate` だけになる。
- `src/game/` に 100 行超の関数が無い。
- `npm run typecheck` / `npm run test:game` / `npm run test:render`。
- `npm run dev`:
  - マップをズームイン/アウトして、天体名とアイコンの間引きが手順前と同じ挙動
    (名前だけ消えてアイコンが残る距離帯があること、**明滅しないこと**)。
  - ラグランジュ点の2行表記(`L4` / 天体名)が出る。
  - 天体に遮られたラベルがフェードアウトする。
  - 遠距離でサブ行が第2段階(記号+個数)へ切り替わる。

---

### 手順 9. マーカーの描画責務をマーカークラスへ集める

**目的**

手順2〜5で被選択物としての振る舞いはマーカークラスへ集まっているが、**マーカーを描く処理は
所有者側に残っている**(`plan-display.syncApsisMarkers`、`nav-target.sync`、
`equator-node-marker-pair.sync`)。同じ物の表示と挙動が2箇所に割れたままなので、描画を
マーカー自身へ移す。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `marker/apsis-marker.ts` | `sync(markerManager, project, overviewMode, cameraPos, …)` を持つ。`plan-display.ts` の `syncApsisMarkers`(遮蔽時 `fadeOut`、非表示時 `hide`)を移す |
| `marker/relative-node-marker.ts` | `nav-target.ts:317-345` の3ブロック(AN / DN / 再接近点)を1つのメソッドへ畳む。3ブロックは記号とラベルだけが違う |
| `marker/equator-node-marker.ts` | `equator-node-marker-pair.ts:113-133` の `sync` を移す。`EquatorNodeMarkerPair` は「2点を解いて2つのマーカーを持つ」だけになる |
| `marker/lagrange-point-marker.ts` | 手順8で `CelestialMarkers` へ寄せた描画のうち、ラグランジュ点固有(2行表記・`mk-lagrange` クラス・`ENTITY_GLYPH.lagrange`)をここへ |
| `plan/plan-display.ts` / `nav-target.ts` / `marker/equator-node-marker-pair.ts` | 上記を取り除き、マーカーへ委譲するだけにする |

**達成条件と検証**

- `grep -rn "markerManager.setNodePosition\|markerManager.setPosition" src/game/plan/ src/game/nav-target.ts` が 0 件。
- `npm run typecheck` / `npm run test:game`。
- `npm run dev`:近点/遠点(◇)・AN/DN(△▽)・再接近点(✧)・赤道交点・ラグランジュ点(✦)の
  マーカーが、位置・記号・ラベル(PREDICT パネルの「軌道要素の時刻を表示」ON/OFF の両方)・
  遮蔽フェードとも手順前と同じ。

---

## 見積り

「移す分岐の数」と「触るファイルの数」から出す。1分岐の移送(切り出し・貼り付け・呼び出し元の
差し替え・目視)を 5〜10 分、単純な改名 1 箇所を 0.5 分として積む。

| 手順 | 導出 | 見積り |
| --- | --- | --- |
| 2 | 新規 5 ファイル + 実装 6 クラス + 供給元 5 ファイル + 型追随 8 ファイル + キャッシュ削除 2 箇所 | 約 4 時間 |
| 3 | 分岐 10 種 × 7.5 分 + `MapCommands` 23 メンバー × 3 分 + 目視 40 分 | 約 3 時間 |
| 4 | 分岐 9 種 × 7.5 分 + `orbit-rows` 切り出し + 目視 30 分 | 約 2 時間 |
| 5 | 分岐 24 箇所 × 7.5 分 + `ListSortKey` の導入 + 目視 40 分 | 約 4 時間 |
| 6 | 4 ファイル・寿命の整理のみ + 目視 20 分 | 約 1.5 時間 |
| 7 | `markerItem` 5 箇所 + 読み手 3 箇所 + 目視 20 分 | 約 1.5 時間 |
| 8 | 609 行を 3 モジュールへ分割 + 呼び出し元 7 ファイル + 目視 40 分 | 約 4 時間 |
| 9 | sync 4 種 × 20 分 + 目視 30 分 | 約 2 時間 |
| **合計** | | **約 22 時間** |

per-frame の費用の見積り: 候補列の再生成は `mapItems`(負荷確認ウィンドウで観測できる)ぶんの
オブジェクト生成になる。天体 + ラグランジュ点 + 実体で 200 件規模なら
200 obj/frame × 60 fps = 12,000 obj/s で、いまの `itemRecords` 再利用が防いでいるのはこの量の
短命オブジェクトだけ。**実測して困ってから戻す**(決めたこと 6)。

行数の見込み: `map-context-actions.ts` 687 → 350 前後、`map-pickable-menu.ts` 463 → 0、
`map-property-rows.ts` 233 → 0、`focus-markers.ts` 609 → 0(3 モジュールへ分割)。
実体側は `player.ts` が 818 → 950 前後、`base.ts` が 374 → 500 前後まで伸びる。
**これは問題にしない** — 1ファイルが1つの物体を全部言い切る形になるための増加で、分割が
要るなら別の軸(ブースター運用・ドッキング)で切る。

---

## リスクと落とし穴

| リスク | 影響 | それが露見する場所 |
| --- | --- | --- |
| 実体が `hud/windows/index.ts`(バレル)を import する | バレルが `resource-transfer-dialog.ts` 経由で `Player` を値 import しているため実行時の循環参照になり、`extends` の評価時に `undefined` で落ちる。**型検査では出ない** | **手順3**。`npm run dev` で起動すると真っ黒か例外になる。import 先が `hud/windows/menu-actions` などの葉モジュールであることを目視で確認する |
| 実体が `MarkerManager` を値 import する | `marker-manager.ts` → `lead-markers.ts` → `player.ts` の循環。`player.ts:38` の現状の `import type` を値 import に変えた瞬間に起きる | **手順2**(`shownOnMap(markers: MarkerManager)`)。`import type` のままであることを確認する |
| `focus-target.ts` が `MapPickable` を import する | `tsconfig.test.json` の include に入っているため、`three/webgpu` を要求して `npm run test:build` が壊れる | **手順2**。`npm run test` で落ちる。`FocusCandidate` を構造的な形のまま保つ |
| `MapVisibilityPolicy` のキャッシュキーが種別だけになっている | `entityResults` は `${kind}:${isActivePlayer}` を鍵にしている。実体ごとの判定を足すと静かに古い値を返す(規約 1.6「キャッシュキーには結果に影響する入力をすべて入れる」) | **手順2**。表示トグルを切り替えたのに一部の実体だけ消えない/出ないという形で出る |
| `pickable`(画面に出ているか)の評価タイミングがずれる | いまは sync フェーズで書き戻した値を次フレームの update で読んでいる。`shownOnMap()` の問い合わせも**同じ1フレーム遅れ**であることを確かめずに直すと、ラベルが消えた直後の1フレームだけ掴めてしまう/掴めなくなる | **手順2**。混雑した天体群でラベルが消えかけている瞬間に右クリックを繰り返して確かめる |
| `DetachedBooster` が敵トグルに従っている | `dynamic-system.ts:457` は `entity('ship')` を使う。機械的に `mapKind` へ置き換えると、ブースターが敵として一覧・マーカーに出る | **手順1**。`DetachedBooster` に `mapKind` を持たせないこと自体で防ぐ。呼び出し側で `entity('enemy')` を直に書く |
| ラグランジュ点が `kind: 'body'` として天体と同じ扱いを受けている箇所の取りこぼし | `object-groups.ts:26` / `physical-object-list-order.ts:94,199` / `map-context-actions.ts:643` / `map-pickable-menu.ts:39` はすべて `isLagrangeId(id)` で天体から分けている。`LagrangePointMarker` を作った後もこの id 判定が残ると、正データが2つになる | **手順2・5**。`grep -rn "isLagrangeId\|lagrangePointOf" src/` が、マーカー生成箇所と `MapVisibilityPolicy` の判定だけになっていることを確認する |
| `ObjectPicker` のジャンルと一覧の区画が別の分け方をしている | 天体をクラス別に割るのは `ObjectPicker` だけ。片方の分け方でもう片方を実装すると、座標系パネルの候補一覧が「天体」1つに潰れる | **手順5**。座標系パネルのアンカー選択を開いて 11 ジャンルが出ることを見る |
| `apsisTimeOf` / `passTimeOf` へのフォールバックが消えることによる差 | `runApsisRelnode` は `target.time ?? apsisTimeOf(id)` と二重に時刻を引いている。マーカーが必ず `time` を持つならフォールバックは不要だが、**持たない経路が残ると `null` で無言に何もしなくなる** | **手順3**。近点/遠点・AN/DN の「ワープ」「ノードを追加」を、時刻ラベル表示 ON/OFF の両方で試す |
| 候補列を毎フレーム作り直すことで GC が増える | フレーム落ち。200 obj/frame 規模なら効かないはず | **手順2・6**。負荷確認ウィンドウの frame time を手順前後で比べる |
| `MapCommands` の口が増え続ける | 「マップから起動できる操作」を名乗りながら、実体が必要とするものを何でも足す器になる。そうなった時点で規約 1.6 が禁じる `Ctx` と同じものになる | **手順3以降**。口を足すときに「それはマップから起動する操作か、その項目を出すか決めるための状態か」を毎回問う。どちらでもない値はメソッドの引数へ回す |
| 天体ラベルの間引きのヒステリシスを落とす | `CrowdingGrid` は前フレームの隠し集合を持って明滅を防いでいる。移設時にこの状態を落とすと、ラベルが毎フレーム点滅する | **手順8**。ズーム操作中にラベルが明滅しないことを見る |
| 一覧の並び順が微妙に変わる | `compare` は距離の同値判定に相対誤差 `1e-12` を使い、ラグランジュ点は点番号を正本にしている。`ListSortKey` の導出順を変えると L4/L5 の順が毎フレーム入れ替わる | **手順5**。木星 L4/L5 を出した状態で一覧を眺め、行が入れ替わらないことを見る |
| 一覧の検索が `detail` を読んでいる | `PhysicalObjectListOrder.matchText` は「名前 + 補助表示文字列」を検索対象にしている(SPEC/MAP.md §10)。天体の `detail` は行に表示されないが検索には効いているので、`listDetail` を1本にすると検索が静かに狭まる(表示用と検索用を分けるのはこのため) | **手順5**。天体の中心天体名(例:「地球」)で一覧を検索して、その天体を回る行が出ることを見る |

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

### いまの被選択物の口

`MapPickable` は次を持つ(`src/game/pickable/map-pickable.ts` が正本)。`kind` は無い。

- 同一性と存否: `id` / `name` / `gone` / `mapState` / `ownerName` / `mapTime`
- 位置と可視: `mapPosAt` / `mapVisibility` / `shownOnMap` /
  `hiddenBehindBodies` / `onlyInFocusedSystem`
- 見た目: `mapGlyph` / `mapGlyphSvg`
- 一覧: `listSection` / `pickerGenre` / `listDetail` / `listSearchText` /
  `listCounted` / `listPriority`
- 操作: `mapMenuItems` / `runMapMenu` / `mapPropertyRows` / `mapRename`

ウィンドウ台帳のキーと軌道線の所属キーは対象の id そのもの(天体・実体・マーカーで id の
名前空間が衝突しない)。台帳は開いた時点の対象を持ち続け、候補列から引き直さない。
自艦・基地を名指しで扱うクリック処理は `instanceof` で絞る。

**手順5で消えた到達不能な分岐。** プロパティウィンドウの副題は
`(ownerName && 軌道点でない) ? '所属: …' : header.subLabel` を組んでいたが、`ownerName` を
持つのは軌道点だけなので前半は成立しえない。副題は常にヘッダー項目のものになる。

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

### 2. 実体でないものはマーカークラスにする(実施済み — ff2531a1 / 65d590f6)

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

いまコードは次の状態にある。

- `marker/apsis-marker.ts` / `relative-node-marker.ts` / `equator-node-marker.ts` /
  `lagrange-point-marker.ts` と `pickable/empty-space-pickable.ts` があり、
  `ApsisIcon` / `EqNodeIcon` は無い。
- **マーカーは生成元が持ち続ける長命オブジェクト。** 毎フレーム `place(...)` で解を書き込み、
  解けなかったフレームを `gone` で表す。プロパティウィンドウの生存判定がこれを読む。
- `MapPickable` は identity / 位置 / 可視 / 存否 / 一覧向けの値を持つ interface で、
  `Player` / `Enemy` / `Base` / `AmmoPickup` / `RcsFuelPickup` / `CelestialEntity` と
  上記5クラスが実装している。`kind` は手順5まで残る。
- 「画面に出ているか」の正本は `MarkerManager.shows(key)` ひとつ。
  `GroupedMarkers.isPickable` / `visibleKeys`・`FocusMarkers.isBodyPickable`・
  `MapPickables.syncVisibility` は無い。
- 一覧の派生値は `PhysicalObjectListOrder` の `ListSortKey` が1フレーム1回導く。
- `MapPropertyRows.rowsFor` / `PhysicalObjectListPanel.sync` / `MapContextActions.sync` は
  `displayTime` を受け取る。`MapContextActions` は `MarkerManager` を受け取る。
- `NavTarget.passTimeOf` / `PlanDisplay.apsisTimeOf` は呼び出し元が消えたので無い。
- 新設: `pickable/body-search-text.ts`(天体区画の行が検索に使う文字列)。

**この手順で変わった挙動。** 以降の目視確認はこの状態を基準にする。

- 弾薬・RCS燃料も、マーカーが出ていないフレームは掴めない(従来は常に掴めた)。
- 名前トグルを閉じた実体でも、アイコンが出ていれば掴める(従来は掴めなかった)。
- クラスタ代表に吸収された実体も、アイコンが描かれていれば掴める(従来は代表だけ)。
- 近点/遠点・AN/DN・赤道交点は、天体遮蔽でフェードしている間は掴めない(従来は掴めた)。
- 表示トグル・ラベル衝突で候補列から外れた天体・ラグランジュ点のプロパティウィンドウは、
  閉じずに残る(消滅・撃破・回収では閉じる)。手順6が目指す形を先に満たしている。
- 赤道交点は「直前の sync 以降に update が書き込んだか」で捨てるため、更新が止まった最初の
  1フレームだけ候補列に古い交点が残る(描画は従来どおり即座に消える)。

**覆されたとき:** マーカー4種は `pickable/` の具象クラスへ移し、手順9(描画責務の集約)を
落とす。手順3〜6 の内容は変わらない。

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

### 5. `MapCommands` という役割インターフェース(実施済み — 3e7c9c3b)

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

`src/game/pickable/map-commands.ts` にある実際の口は上の草案から次の点だけ違う。

- `hint` は無い。フォーカスの通知は `focus`、ワープ不可の通知は `warpTo` が自分で出す。
- `toggleBasePanel` は無い。その act はウィンドウ側が横取りするので、項目のラベルを決める
  `isBasePanelExpanded` だけが要る。
- `authoring` の代わりに `canAuthor: boolean` と `openObjectPlacer()` を置き、
  `ObjectAuthoring` そのものは渡さない。
- `overviewMode` を足した(空域の「オブジェクトを配置する」の可否)。
- 基地の削除は `removeBase(base)` 1本にした(操作対象の解除・ドッキング先の解除・`alive` を含む)。

**併せて消えたもの。** `MapContextActions.setControlledBaseHandler` と `Game.setControlledBase` は
`activePlayers.setBase` への素通しだったので落とし、同じ操作の別経路だった `MenuAction` の
`activateBase` / `deactivateBase` も削除した。`bodyParentId` は `CelestialSystem` のメソッドへ移した。
「ターゲット設定」「複製」は `MenuCommon.targetItems` / `MenuCommon.duplicateItems` にある。

**この手順で変わった挙動。**

- 近点/遠点・赤道交点のヘッダーの呼称は、マーカーが `place` で受けた中心天体から引く
  (従来は `strongestAttractor` で引き直していた)。マーカーの表記と必ず一致する方向の変化。
- 「ノードを追加」で時刻が求まらないときの通知は消えた。時刻はマーカーが必ず持つ。

**プロパティ行も `MapCommands` を通す。** 基地の「操作対象か」は操作中の基地を要るので、
行の導出に渡すのは自艦(`Player | null`)ではなく `MapCommands` にした
(`mapPropertyRows(commands, celestialSystem, simTime, displayTime)`)。旧 `rowsFor` の
`pivot` と `simTime` は呼び出し側で同じ値だったので1つに畳んである。軌道要素の行は
`pickable/orbit-rows.ts` の `orbitRows(entity, celestialSystem, simTime)` が持つ。

**残った疑問点。** `CelestialEntity` の副題の既定値は `'天体・ラグランジュ点'` のままだが、
ラグランジュ点はもうこのクラスへ来ない。文言を変えるなら `/modify-feature` を通す。

**覆されたとき:** メニュー構築だけは実体の外(`pickable/` の具象クラス)に残す。手順4・5は
そのまま実体へ移す。

### 6. キャッシュは全部落とす(実施済み — c76ddea8)

`MapPickables.itemRecords` / `activeRecordKeys`、`FocusMarkers.bodyPickableRecords` /
`cachedBodyPickables` / `cachedBodyPickablesTime` / `cachedBodyPickablesPolicy` は
**新設しない。** 候補列は毎フレーム組み直す。

候補数は負荷確認ウィンドウの `mapItems` で観測できる(`MapPickables.perfCounts()`)。実測して
困ったらそのとき戻す。

一覧側の id キーのキャッシュ(`matchTextCache` / `lagrangeSortKeyCache` と、それを掃除する
`dropStaleCaches`)も落ちた。検索文字列は絞り込み中しか組まず、ラグランジュ点の点番号は
マーカーが値として持つ。

**覆されたとき:** 手順2・6の一部が落ちるだけで、他の手順は変わらない。

### 7. 一覧の並べ替えに使う派生値は一覧が持つ(実施済み — ff2531a1)

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

## 実施の結果

全9手順を実施した(a77c1cc4 / ff2531a1 / 3e7c9c3b / 10a6cd14 / c76ddea8 / e68dcb01 /
471e94a3 / 7f2e1372 / 65d590f6)。`npm run typecheck` と `npm run test`(653/653)が通る。

### 達成目標の点検

| # | 結果 |
| --- | --- |
| 1 | `MapPickKind` 0 件 ✓ |
| 2 | `ObjectType` 0 件 ✓(`objectType` の識別子も `entityKind` へ揃えた) |
| 3 | 敵機を指す `'ship'` 0 件 ✓。残る4件は機体一般(`DockingCandidateKind` と「取り付け艦」の行キー) |
| 4 | `combatMarkerKindOf` / `CombatMarkerKind` 0 件 ✓ |
| 5 | 冒頭の表の `kind` 分岐 0 件 ✓ |
| 6 | 4ファイルとも存在しない ✓ |
| 7 | `MutableMapPickable` / `cachedBodyPickables` / `itemRecords` / `syncVisibility` 0 件 ✓ |
| 8 | 被選択物から実体を id で引き直す手続き 0 件 ✓ |
| 9 | 100 行超の関数は 3 件で、いずれも着手前(e7a9e82e)と同じもの・同じ長さ ✓。`syncSubLabels`(129 行)は 3 つの段へ割れた |
| 10 | ✓ |
| 11 | **未実施** — 実行時の目視確認はしていない |

### 行数の実測

| ファイル | 着手前 | 現在 |
| --- | --- | --- |
| `pickable/map-context-actions.ts` | 687 | **705** |
| `pickable/map-pickables.ts` | 262 | 120 |
| `camera/focus-markers.ts` | 517 | 0(`marker/celestial-markers.ts` 316 + `celestial-sub-labels.ts` 142 + `crowding.ts` へ 83 行) |
| `player/player.ts` | 625 | 777 |
| `dynamic/dynamic-entity/base.ts` | 376 | 505 |

実体側が伸びるのは織り込み済み(1ファイルが1つの物体を言い切る形になるための増加)。

**`map-context-actions.ts` だけが見込みを外した。** 350 前後まで縮むと見ていたが、
メニュー・行が出て行った代わりに `MapCommands` の実装(21 メンバー)が入り、差し引きで増えた。
いま同居しているのは、プロパティウィンドウの台帳・クリックの振り分け・パーツウィンドウ・
軌道線ウィンドウ・`MapCommands` の5つで、規約 1.2 に対して重い。

### 残っている手順

**手順 10. `map-context-actions.ts` を責務で割る**

- `pickable/part-windows.ts`(新規) — `openPartPropertyWindow` / `partWindowContent` /
  `partWearText` / `setPartDeployment` / `closePartWindowsForShip` と `partWindows` 台帳。
- `pickable/orbit-line-windows.ts`(新規) — `openOrbitPropertyWindow` /
  `orbitWindowContent` / `relatedItemsForOrbit` と `lineWindows` 台帳、
  `ORBIT_PICK_KIND_LABEL` / `ORBIT_CALC_METHOD_LABEL`。
- 残る `MapContextActions` は「被選択物のウィンドウ台帳 + クリックの振り分け + MapCommands」。

**達成条件と検証**: `src/game/pickable/` に 400 行を超えるファイルが無い。
`npm run typecheck` / `npm run test:game`。`npm run dev` でパーツウィンドウ(自艦の
「搭載部品」から開く)と軌道線のプロパティウィンドウが手順前と同じ。

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

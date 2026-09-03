# `PhysicalObject` / `Object` の用法 — 実態調査と是正計画

以下の件数はすべて **`980b7929`** 時点のコードから実測したもの(`tests/dist/` は除外)。
**維持しない** — 着手時に測り直す。

---

# 目的

`PhysicalObject` は「天体と機体をまとめて指す語」として作られているが、**`Physical` も
`Object` も、指している集合に対して事実として誤っている。** 加えて `Object` は互いに無関係な
4 系統へ散っていて、CODING-RULE 2.1 の「類義語の混雑」「漠然とした命名」に同時に当たる。

**この計画は、`Physical` を落として `Object` の 4 系統をほどき、「総称が要る」という状況
そのものを消す。挙動は変えない。**

## 前提の検証結果 — 「空クリックとラグランジュ点を扱っている」は半分だけ正しい

着手前に、`PhysicalObject` が何を扱っているかを実測した。

| 主張 | 判定 | 根拠 |
| --- | --- | --- |
| ラグランジュ点を扱っている | **正しい** | `PhysicalObjectListFilter` に `'lagrange'`(`physical-object-list-order.ts:14`)。`matches()` は `item.kind === 'body' && isLagrangeId(item.id)` で拾う(`:94`)。一覧の天体区画に、親天体の子として並ぶ |
| 空クリックを扱っている | **誤り** | 一覧の区画は `SECTIONS`(`physical-object-list-panel.ts:19-26`)の `body`/`player`/`ship`/`ammo`/`fuel`/`base` の6つだけで、`'empty-space'` は入らない。`rebuildOrder()` が `item.kind === kind` で弾く(`:139`)。SPEC/MAP.md 10節も「空域はマーカーであって物体ではないため一覧に含まれない」と明記していて、コードはそれに従っている |

**したがって `PhysicalObject` の罪状は「空クリックまで含む」ではない。** 実際の罪状は次の4つ。

1. **`Physical` が対を持たない。** `NonPhysicalObject` は無く、`Physical` は何も区別していない。
   その上で**ラグランジュ点(質量を持たない幾何点)を含むので、事実としても誤り。**
2. **`Object` が4つの無関係な概念に付いている**(次節)。CODING-RULE 2.1「類義語の混雑」。
3. **一覧が扱うのは `ObjectPickable` であってエンティティではない。** `ObjectPickable` は
   `id`/`name`/`pos`/`kind`/`detail` を毎フレーム組み直す表示用のレコードで、
   CODING-RULE 2.2 の `entity`(= 物体ひとつの動きと見た目を統合するもの)ではない。
   **`EntityListPanel` へ改名すると、いま無い誤りを新しく作る。**
4. **ラグランジュ点が `MapPickKind` の `'body'` を名乗っている。** 天体かラグランジュ点かの
   区別は `isLagrangeId(item.id)` という **id の文字列形の検査**に散っている(8箇所)。

## 空クリックには「2Dを3Dにする」処理が無い

`object-windows.ts:448` が組んでいるのは
`{ id: 'empty', name: '宇宙空間', pos: v3(0, 0, 0), kind: 'empty-space' }` で、
**`pos` は原点固定のダミー。** 逆投影もレイも無い。
`map-pickable-menu.ts:295-315` の `itemsFor` / `run` は `target` を一切読まず、
読まれるのは `name`(メニューの題名)だけである。

**したがって `ClickRay` / `MouseRay` の類は当たらない** — 光線は存在しない。
ここにあるのは `ContextMenu<ObjectPickable, MenuAction>` の型を満たすためだけに
`ObjectPickable` を借りている状態で、CODING-RULE 1.7「オブジェクトの流用の禁止」に当たる。
**改名ではなく、型の流用をやめることで直す**(手順1)。

## `Object` が指している4つの別概念

| # | 何 | 中身 | `Object` が誤っている点 | 行 |
| --- | --- | --- | --- | --- |
| A | `PhysicalObjectList*`(`hud/panels/physical-object-list-{panel,order,tree}.ts`) | マップ被選択物の一覧パネル | 上記1・3・4 | 114 |
| B | `ObjectPicker<T>` / `ObjectPickerGroup<T>`(`hud/windows/object-picker.ts`) | **候補が数十〜百件ある値を選ばせる汎用ウィジェット。** `T` は `ReferenceCelestialBody` / `string` / `string \| null` | **物体とは無関係。** `SegmentedControl` の兄弟で、選ばせる値が何であってもよい。CODING-RULE 2.1「漠然とした命名」 | 41 |
| C | `ObjectType`(`random-name.ts:5`)/ `ObjectAuthoring` / `openObjectPlacer*` / `ObjectPlacerPanel` / `ObjectPlacerForm` / `ObjectPlacerPreset` | **`'player' \| 'enemy' \| 'ammo' \| 'fuel' \| 'base'`** — 配置できる dynamic の種別と、その配置 UI | 指しているのは **dynamic の種別**であって「物体一般」ではない。しかも `DynamicEntityKind`(`map/visibility-policy.ts:9` = `'player' \| 'ship' \| 'ammo' \| 'fuel' \| 'base'`)と**同じ集合を別名で持っている**(`enemy` / `ship` だけ違う)。CODING-RULE 2.1「曖昧な区別」 | 79 |
| D | `FocusTarget` の `kind: 'object'`(`camera/focus-target.ts:11`) | id で指す注視対象。対は `kind: 'point'`(座標系に焼いた固定点) | **apsis / relnode / eqnode マーカーもラグランジュ点もこの `'object'` で解決される**(`focus-target.ts` の `candidates` の用途がまさにそれ)。しかし**セーブに載る値**(`save/save-data.ts:301`)なので、改名にはマイグレーションが要る | 19 |

`renderObject` / `getObjectByName` / `setFromObject` / `Object3D` は three.js の語なので対象外。

## 派生する未解決 — マーカー字形の総称

`marker/marker-glyphs.ts` は字形の表を3つ持つ。

- `ENTITY_GLYPH` = `ship` / `enemyShip` / `base` / `ammo` / `fuel` / `body` / `star` /
  `satellite` / `lagrange` / `ghost` / `preview`
- `DIRECTION_GLYPH` = 向き
- `ORBIT_POINT_GLYPH` = `apsis` / `ascendingNode` / `descendingNode` / `maneuverNode` /
  `burnPoint` / `impact` / `closestApproach`

`ENTITY_GLYPH` は CODING-RULE 2.2 の「見た目だけを扱うものに `entity` を付けない」に当たるが、
**改名先が決まらない** — celestial と dynamic と「物でないもの」(`lagrange` / `ghost` /
`preview`)をまたぐ総称が要り、`OBJECT_GLYPH` も同じ問題を引き継ぐ。**本計画の手順4 がこれに
答える。**

**加えて、`marker-glyphs.ts:1-4` のファイル見出しコメントは事実として嘘である。**
「塗りつぶし=実体・矢=方向・中空=軌道上の点、と字形の族をその区別に対応させる」と書いてあるが、
実際には3組が同じ文字を共有している。

| 文字 | `ENTITY_GLYPH` | `ORBIT_POINT_GLYPH` |
| --- | --- | --- |
| `△` | `enemyShip` | `ascendingNode` |
| `⬡` | `base` | `burnPoint` |
| `◈` | `fuel` | `maneuverNode` |

しかも `enemyShip`(`△`)・`satellite`(`○`)・`base`(`⬡`)は中空である。
**したがって「字形で名付ける」(`SOLID_GLYPH` 等)という逃げ道も取れない。**

---

# 決めたこと

**すべて自分で決めた。覆されたときにどの手順が変わるかを各項に書く。**

## 決定1. 総称を作らない。集合をほどいて、総称が要らない形にする

`ENTITY_GLYPH` が総称を要求しているのは、**無関係な3つのキー集合を1つの `Record` に
まとめているから**である。CODING-RULE 1.6「情報をまとめるためだけの型を作らない」と
1.5「早急な一般化」に照らすと、**まとめていること自体が誤り。**

3つに割れば、それぞれは既に名前を持つ集合になる — dynamic の種別、天体クラス、そして
1回ずつしか使われない3つの個別定数。**総称は要らなくなる。**

- **覆された場合**: 「総称を1語決める」を選ぶなら手順4 が全面的に変わり、決定2・決定3 も
  その語に寄せ直すことになる。ただし本計画は**その語の候補を持たない** — `entity` は
  CODING-RULE 2.2 が別の意味で固定済み、`object` は上の A〜D で既に4分裂、`body` は
  2.2 が無標での使用を禁止、字形での命名は上表のとおり事実に反する。

## 決定2. `PhysicalObjectList*` は `ObjectPickableList*` にする

一覧が消費しているのは `ObjectPickable` そのもの(`sync(items: readonly ObjectPickable[], ...)`)
なので、**中身の型で名乗る。** 新しい語を1つも導入しない。

- `PhysicalObjectListPanel` → `ObjectPickableListPanel`(`object-pickable-list-panel.ts`)
- `PhysicalObjectListOrder` / `-Tree` / `-Filter` / `-Sort` も同様
- DOM id / CSS クラスの `physical-object-list` → `object-pickable-list`
- **日本語ラベル「軌道物体」は変えない。** SPEC/MAP.md 10節・UI-DESIGN.md 207/210 が持つ
  UI 用語で、変えるなら SPEC が先行する(`/modify-feature`)。
  本計画は**画面に出る文字を1文字も変えない。**

`ObjectPickable` の全種別を出すわけではない(軌道点は出さない)という点でわずかに広く名乗るが、
**その除外はパネル自身の表示規則**(`SECTIONS`)であり、SPEC/MAP.md 10節が明文で持っている。

- **覆された場合**: 日本語ラベルごと変える判断なら、SPEC/MAP.md 10節・UI-DESIGN.md 207/210 の
  更新が手順0 として先頭に入り、`/modify-feature` を通す。識別子だけ別案にするなら
  手順5 の置換文字列が変わるだけで、他の手順は動かない。

## 決定3. ラグランジュ点は `MapPickKind` の独立した種別にする

**`'lagrange'` を `MapPickKind` へ足す。** いま `kind === 'body' && isLagrangeId(id)` の
2条件で書かれている判定が `kind === 'lagrange'` の1条件になり、**id の文字列形の検査が
表示層から消える。**

これは `MapPickKind` の `'body'` を無標のまま残さないための最小の変更でもある。
**`'body'` そのものを `'celestial'` へ改めるのは本計画では行わない**(後述「他2計画との順序」)。

- **覆された場合**: 手順3 を落とす。そのとき `isLagrangeId` による判定は8箇所に残り、
  `MapPickKind` の `'body'` はラグランジュ点を含んだままになる。手順4・5 は影響を受けない。

## 決定4. `ObjectPicker` は `ListPicker` にする

指しているのは「候補を縦のグループ付き一覧で選ばせるウィジェット」で、`SegmentedControl`
(横並び)と対になる。値の型は `T` で外から入るので、**値が何であるかを名前に含めてはいけない。**

- **覆された場合**: 手順6 の置換文字列だけが変わる。

## 決定5. `ObjectType` は dynamic の族語へ寄せ、値の統一は行わない

`ObjectType`(`'enemy'`)と `DynamicEntityKind`(`'ship'`)は同じ集合の別名だが、
**値の統一は挙動に触れる**(`generateRandomName()` の分岐キー)。本計画は**型名だけ**を
`PlaceableDynamicKind` へ改め、**2つの union を1つにまとめる判断は記録に留める。**

- **覆された場合**: 統一まで行うなら手順7 が `random-name.ts` の分岐と
  `map/visibility-policy.ts` の `ENTITY_KEYS` 表にも触れることになり、`test:game` が要る。

## 決定6. `FocusTarget` の `kind: 'object'` は触らない

`save/save-data.ts:301` に載る**永続化された値**で、改名にはセーブのマイグレーションが要る。
本計画の他のどの手順とも独立に通せるので、**別件として記録だけする。**

- **覆された場合**: マイグレーションを含む独立した計画が要る。本計画の手順は動かない。

---

# 達成目標

全手順の実施後、以下がすべて満たされていること。

1. `grep -rn "PhysicalObject\|physical-object\|physicalObject" src/` が **0 件**。
2. `grep -rn "ENTITY_GLYPH" src/` が **0 件**。
3. `grep -rn "empty-space" src/` が **0 件**。ダミーの `ObjectPickable`
   (`id: 'empty'` / `pos: v3(0, 0, 0)`)を組む行が `src/` に無い。
4. `grep -rn "isLagrangeId" src/` が **`celestial/lagrange-id.ts` の定義 +
   `map/visibility-policy.ts` + `pickable/map-pickable-menu.ts` の3ファイルだけ**に減っている
   (表示層の8箇所 → 2箇所)。
5. `grep -rn "ObjectPicker\|ObjectType\|ObjectPlacer\|ObjectAuthoring" src/` が **0 件**。
6. `npm run typecheck` と `npm run test`(全層)が通る。
7. **画面に出る日本語が1文字も変わっていない。** `git diff` を
   `grep -nE "^[-+].*[ぁ-んァ-ヶ一-龠]"` に通し、変更行の日本語がコメントだけであること。
8. `npm run smoke:browser` が通り、マップビューで軌道物体一覧が開き、
   ラグランジュ点フィルタ・衛星フィルタ・検索が従来どおり動く。

---

# 手順

**上から順に着手する。手順1・2・4・6・7 は互いに独立、手順5 は 2・3 の後。**

## 手順 1. `empty-space` を `MapPickKind` から外す

### 目的

`'empty-space'` は被選択物ではなく「**何にも当たらなかった**」という結果である。
それを `ObjectPickable` として表すために中身が全部ダミーのレコードを組んでおり、
CODING-RULE 1.7「オブジェクトの流用の禁止」に当たる(冒頭「空クリックには…」節)。

**この手順で挙動は変えない** — 空域メニューの項目と文言は同じ。

### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `src/game/pickable/object-pickable.ts:5` | `MapPickKind` から `'empty-space'` を外す |
| `src/game/pickable/object-windows.ts:77` `:447-450` | ダミー `ObjectPickable` の生成をやめる。空域メニューは `ObjectPickable` を経由せず項目列を直接渡して開く経路にする。`:77` のコメントもその形に合わせる |
| `src/game/pickable/map-pickable-menu.ts:295-315` | `'empty-space'` の `itemsFor` / `run` を、`ObjectPickable` を受けない独立したメソッドへ出す。**現状どちらも `target` を一切読んでいない**ので引数を落とすだけで済む |
| `src/game/marker/pick-glyphs.ts:22` `:45-47` | `TEXT_GLYPHS` の `'empty-space': '·'` を削除。`pickGlyph()` の `if (kind === 'empty-space') return undefined;` も削除 |
| `src/game/hud/object-groups.ts:41` | `case 'empty-space':` を落とす |
| `src/game/pickable/map-property-rows.ts:44` | `case 'empty-space': return [];` を落とす |

`ContextMenu` の型引数をどう扱うかは `hud/windows/context-menu.ts` を読んで決める
(空域専用の開き方を1つ足す形を優先する — 下の「リスク」)。

### 達成条件と検証

- `grep -rn "empty-space" src/` が 0 件。
- `npm run typecheck` / `npm run test:game`。
- `npm run dev` でマップビューを開き、**何も無いところを右クリック** →
  「オブジェクトを配置する」「設定メニューを開く」「キャンセル」が従来どおり出て、
  題名が「宇宙空間」であること。**戦闘ビューでも空振り右クリックで同じメニューが出ること**
  (`handleCombatRightClick` が同じ `openEmptySpaceMenu` を通る)。

## 手順 2. 軌道上の点を型で括る

### 目的

`apsis` / `relnode` / `eqnode` が「他の対象の軌道から導かれた点であって物体ではない」という
区別は、**3箇所に別々の形で書かれている** — `object-windows.ts:620` の直書き
`isOrbitPoint`、`object-groups.ts:41` の素通し `case`、`physical-object-list-panel.ts` の
`SECTIONS` に**入っていないこと**(暗黙)。1つ増えたときに3箇所とも直す保証が無い。

**この時点で挙動は変えない。**

### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `src/game/pickable/object-pickable.ts:5` | `OrbitPointPickKind = 'apsis' \| 'relnode' \| 'eqnode'` を定義し、`MapPickKind` をそれと物体側の union として組み直す。`isOrbitPointKind(kind)` を置く |
| `src/game/pickable/object-windows.ts:620` | 直書きの3項比較を `isOrbitPointKind(target.kind)` に置換 |
| `src/game/hud/object-groups.ts:23-41` | 素通しの `case` を `isOrbitPointKind` による early continue へ。ファイル見出しコメント(`:2`)もその形に合わせる |
| `src/game/hud/panels/physical-object-list-panel.ts:19-26` | `SECTIONS` の直前に「軌道点は `OrbitPointPickKind` として除いてある」ことをコメントで示す。**表そのものは変えない** |
| `src/game/pickable/map-property-rows.ts:41-44` | **触らない。** `apsis` だけ別メソッド(`apsisRows`)なので、括ると分岐が増える。触らない判断をコメントで残す |

### 達成条件と検証

- `grep -rn "=== 'apsis'" src/` が 0 件(`plan-display.ts:262` の生成側と
  `map-pickable-menu.ts:447` `:454` の時刻導出は `target.kind === 'apsis'` を含むので、
  ここも `isOrbitPointKind` で置き換えられるか個別に判定する)。
- `npm run typecheck`。
- 見た目の変更なし。`npm run smoke:browser`。

## 手順 3. ラグランジュ点を `MapPickKind` の独立した種別にする

### 目的

決定3 のとおり。**ラグランジュ点が `'body'`(= 天体)を名乗っている状態を解く。**
`isLagrangeId(id)` による id の文字列検査を表示層から消し、`kind` の判定1つにする。

**この時点で挙動は変えない** — 一覧に出る行も、フィルタの結果も、字形も同じ。

### 変更が必要な箇所

`kind === 'body'` を書いている全 24 箇所を、**ラグランジュ点を含むべきか1つずつ判定して**
振り分ける。含むべき側は `kind === 'body' || kind === 'lagrange'`(あるいは
`isCelestialPickKind()` を1つ置く)にする。

| ファイル:行 | いまの判定 | どうするか |
| --- | --- | --- |
| `camera/focus-markers.ts:50` | `FocusLabel.kind: 'body'` に `isLagrange: boolean` を併記 | `kind: 'body' \| 'lagrange'` にして `isLagrange` を落とす |
| `camera/focus-markers.ts:238` `:246` | ラベル生成 | `:246` が `'lagrange'` を出す |
| `camera/focus-markers.ts:313-323` | `cacheBodyPickable()` が `kind: 'body'` を直書き(天体とラグランジュ点の両方から呼ばれる) | kind を引数で受ける |
| `hud/frame/anchor-zone.ts:75` | `p.kind !== 'body' \|\| !isLagrangeId(p.id)` | `p.kind !== 'lagrange'` |
| `hud/object-groups.ts:25-27` | `case 'body'` の中で `isLagrangeId` 分岐 | `case 'lagrange'` を独立させる |
| `hud/panels/physical-object-list-order.ts:94` | `kind === 'body' && isLagrangeId(id)` | `kind === 'lagrange'` |
| `hud/panels/physical-object-list-order.ts:95` | `kind === 'body' && !isLagrangeId(id)` | `kind === 'body'` |
| `hud/panels/physical-object-list-order.ts:151` | `kind === 'body' && filter === 'satellite'` | **含めない**(下の「リスク」) |
| `hud/panels/physical-object-list-order.ts:197` | `item.kind !== 'body'` → ソートキャッシュの早期 return | **`'lagrange'` のみに絞る**(ラグランジュ点だけが持つキー。下の「リスク」) |
| `hud/panels/physical-object-list-panel.ts:20` `:260` | `SECTIONS` の天体区画 / ツリー操作ボタン | **区画は「天体」1つのまま。** ラグランジュ点も天体区画へ入れる(SPEC/MAP.md 10節が親天体の直下と定めている)ので、区画の割り当てだけ `'lagrange'` を `'body'` の区画へ寄せる |
| `hud/panels/physical-object-list-tree.ts:89` `:91` | `kind === 'body'` なら detail を出さない | 含む |
| `marker/pick-glyphs.ts:39-41` | `kind !== 'body'` → 表引き、`isLagrangeId` → lagrange 字形 | `'lagrange'` を表側へ移す |
| `pickable/object-windows.ts:643` | `kind !== 'body' \|\| isLagrangeId(id) \|\| !has(id)` | `kind !== 'body'` |
| `pickable/object-windows.ts:648` | 周回物体の絞り込み | 含めない(判定して確定させる) |
| `pickable/map-pickable-menu.ts:40` `:93` | `isLagrangeId(id)` で親を引く / `'body'` のメニュー表 | `'lagrange'` の表を独立させるか同じ表を共有するかを決める。**`:40` は id を受ける口なので `isLagrangeId` が残ってよい** |
| `pickable/object-pickables.ts:53` | `pickable` の同期 | 含む |
| `pickable/object-pickables.ts:179` | detail 文字列 | 含む |
| `pickable/object-pickables.ts:186` | `inFocusedSystem` | 含む |
| `pickable/object-pickables.ts:201` | `distanceFromStar` | 含む |
| `pickable/map-property-rows.ts:41` | `case 'body': bodyRows()` | 含む |

`map/visibility-policy.ts:118` の `isLagrangeId` は **id を受ける口**(`body(id)`)で
`MapPickKind` を持たないため、**この手順では触らない。**

### 達成条件と検証

- `grep -rn "isLagrangeId" src/` が `celestial/lagrange-id.ts` / `map/visibility-policy.ts` /
  `pickable/map-pickable-menu.ts` の3ファイルだけになる。
- `npm run typecheck` / `npm run test:game`。
- `npm run dev` でマップビュー:
  - 軌道物体一覧の天体区画で、**地球の下に月と地球のラグランジュ点が従来どおり並ぶ。**
  - 「ラグランジュ点」フィルタで全系のラグランジュ点だけが残る。
  - 「衛星」フィルタで各衛星の親惑星がクラスタ見出し(淡色)として出る。
    **ラグランジュ点の親は出ない。**
  - 太陽系順の並びで、ラグランジュ点が親天体の近くに並ぶ(先頭へ寄らない)。
  - 地球の L4 / L5 が一覧でちらつかない。
  - ラグランジュ点の行の字形が `✦` のまま。右クリックのプロパティウィンドウが従来どおり開く。
  - フレームアンカーのプルダウン(`anchor-zone`)にラグランジュ点が従来どおり出る。

## 手順 4. `ENTITY_GLYPH` を3つに割る

### 目的

決定1 のとおり。**「celestial ∪ dynamic ∪ 物でないもの」の総称を要求しているのは、この表が
無関係な3つのキー集合を1つの `Record` にまとめているからである。** 割れば総称は要らなくなる。

割った先はそれぞれ既に名前を持つ。

| 新 | 中身 | 使用箇所 |
| --- | --- | --- |
| `DYNAMIC_KIND_GLYPH` | `ship` / `enemyShip` / `base` / `ammo` / `fuel` | `pick-glyphs.ts` / `ammo-pickup.ts` / `base.ts` / `enemy-marker.ts` / `rcs-fuel-pickup.ts` / `object-placer-panel.ts` |
| `CELESTIAL_CLASS_GLYPH` | `body` / `star` / `satellite` | `marker-glyphs.ts` の `bodyEntityGlyph()` の中だけ |
| `LAGRANGE_GLYPH` / `GHOST_GLYPH` / `PREVIEW_GLYPH` | 1つずつの単独定数 | 順に `focus-markers.ts` + `pick-glyphs.ts` / `plan-display.ts` / `creative-stage.ts` |

**加えて `marker-glyphs.ts:1-4` の見出しコメントを事実に合わせる**(冒頭の表のとおり、
「塗りつぶし=実体・中空=軌道上の点」の対応は成立していない)。成立しない説明を外す。

**定数の値は1つも変えない。** 正しく通れば画面は変わらない。

### 変更が必要な箇所

| ファイル | 何をするか | 行 |
| --- | --- | --- |
| `src/game/marker/marker-glyphs.ts:1-20` `:47-51` | `ENTITY_GLYPH` を上表の5つへ分割。見出しコメントを事実に合わせる。`bodyEntityGlyph()` は `CELESTIAL_CLASS_GLYPH` を引く形へ | 5 |
| `src/game/marker/pick-glyphs.ts` | `TEXT_GLYPHS` の5参照 + `:40` の lagrange | 7 |
| `src/game/camera/focus-markers.ts` | `ENTITY_GLYPH.lagrange` → `LAGRANGE_GLYPH`(2箇所)+ import | 3 |
| `src/game/creative/object-placer-panel.ts` | `ammo` / `fuel` の2参照 + import | 3 |
| `src/game/dynamic/dynamic-entity/ammo-pickup.ts` / `base.ts` / `enemy-marker.ts` / `rcs-fuel-pickup.ts` | 各1参照 + import | 8 |
| `src/game/plan/plan-display.ts` | `ENTITY_GLYPH.ghost` → `GHOST_GLYPH` + import | 2 |
| `src/game/stages/creative-stage.ts` | `ENTITY_GLYPH.preview` → `PREVIEW_GLYPH` + import | 2 |

### 達成条件と検証

- `grep -rn "ENTITY_GLYPH" src/` が 0 件。
- **分割の前後で文字が一致すること**を機械的に確かめる —
  `grep -oE "'[^']'" src/game/marker/marker-glyphs.ts | sort` の結果が変更前後で一致する。
- `npm run typecheck` / `npm run test:render` / `npm run test:game`。
- `npm run dev` で、マップの敵マーカー(`△`)・基地(`⬡`)・弾薬(`▣`)・RCS燃料(`◈`)・
  ラグランジュ点(`✦`)、PLAN のゴースト(`⬢`)、CREATIVE の配置プレビュー(`▷`)が
  従来どおり出ること。

## 手順 5. `PhysicalObjectList*` → `ObjectPickableList*`

### 目的

決定2 のとおり。**この時点で挙動は変えない** — 識別子・DOM id・CSS クラスの改名だけ。

### 変更が必要な箇所

| ファイル | 何をするか | 行 |
| --- | --- | --- |
| `src/game/hud/panels/physical-object-list-panel.ts` → `object-pickable-list-panel.ts` | ファイル改名 + 中身の置換 | 59 |
| `src/game/hud/panels/physical-object-list-order.ts` → `object-pickable-list-order.ts` | 同上 | 9 |
| `src/game/hud/panels/physical-object-list-tree.ts` → `object-pickable-list-tree.ts` | 同上 | 8 |
| `src/game/hud/style/map-view-style.ts` | CSS セレクタ 28 行 | 28 |
| `src/game/pickable/map-picking.ts` | import / フィールド `physicalObjectListPanel` / 生成・使用 | 9 |
| `src/game/pickable/object-pickables.ts:177` | コメント中の `PhysicalObjectListOrder.matches()` | 1 |

置換は3語のみ — `PhysicalObject` → `ObjectPickable` / `physicalObject` → `mapPickable` /
`physical-object` → `object-pickable`。

**`hud-physical-object-list` は `wirePanelCollapse` の `storageId`(`panel.ts:211`)であり、
`hud-physical-object-list-section-${kind}`(`:219`)は区画ごとの開閉状態の localStorage キー
である。** 改名すると既存プレイヤーの開閉状態が既定へ戻る(下の「リスク」)。

### 達成条件と検証

- `grep -rn "PhysicalObject\|physical-object\|physicalObject" src/` が 0 件。
- `npm run typecheck` / `npm run test:game` / `npm run test:render`。
- `npm run dev` でマップビューを開き、**一覧パネルの見た目が変わっていないこと**
  (`map-view-style.ts` の 28 セレクタが1つでも外れると、sticky 見出しの背景・行の色・
  コンパクト幅のレイアウトが崩れる)。区画の開閉・全展開/全折りたたみ・検索欄・フィルタ・
  並び順が動くこと。

## 手順 6. `ObjectPicker` → `ListPicker`

### 目的

決定4 のとおり。**挙動は変えない。**

### 変更が必要な箇所

| ファイル | 何をするか | 行 |
| --- | --- | --- |
| `src/game/hud/windows/object-picker.ts` → `list-picker.ts` | ファイル改名。`ObjectPicker` → `ListPicker`、`ObjectPickerGroup` → `ListPickerGroup`。CSS クラス `object-picker-pop` → `list-picker-pop`(このファイル内で閉じている — 外部参照が無いことを確認済み) | 17 |
| `src/game/hud/windows/index.ts:9` | 再 export | 1 |
| `src/game/creative/object-placer-panel.ts` | import + 型注釈 | 10 |
| `src/game/creative/orbit-form-fields.ts` | `ObjectPickerGroup` | 2 |
| `src/game/hud/frame/anchor-zone.ts` | import + 型注釈 | 8 |
| `src/game/hud/object-groups.ts` → `pickable-groups.ts` | `ObjectPickerGroup` の参照 + ファイル改名(中身は `ObjectPickable` のグループ分けであって「オブジェクト」ではない)。**`groupPickables()` の名前は正しいので据置** | 3 |

`object-groups.ts` を import しているのは `hud/frame/anchor-zone.ts:11` のみ(確認済み)。

### 達成条件と検証

- `grep -rn "ObjectPicker\|object-picker\|object-groups" src/` が 0 件。
- `npm run typecheck` / `npm run test:game`。
- `npm run dev`:
  - マップ上部のフレームアンカーのプルダウンが開き、グループ分け・絞り込み・選択が動く。
  - CREATIVE ステージで「オブジェクトを配置」→ 基準天体のプルダウン、
    ラグランジュ点モードの副天体プルダウンが動く。
  - コンパクト幅(横 600px 未満)で、ポップアップが画面下端のシートとして開く。

## 手順 7. `ObjectType` / `ObjectAuthoring` / `ObjectPlacer*` の族語を直す

### 目的

決定5 のとおり。指しているのは **dynamic の種別とその配置 UI** であって「物体一般」ではない。
**挙動は変えない。値(`'player'` 等の文字列)は1つも変えない。**

### 変更が必要な箇所

| 現 | 新 | ファイル |
| --- | --- | --- |
| `ObjectType` / `objectType` | `PlaceableDynamicKind` / `placeableKind` | `random-name.ts:5` `:38`、`creative/object-placer-panel.ts`、`creative/placement-validation.ts:93`、`pickable/map-pickable-menu.ts:409`、`stages/stage.ts:23` `:98`、`stages/creative-stage.ts` |
| `ObjectAuthoring` | `DynamicPlacement` | `stages/stage.ts:96` `:150`、`stages/creative-stage.ts:57` |
| `openObjectPlacer` / `openObjectPlacerForDuplicate` | `openDynamicPlacer` / `openDynamicPlacerForDuplicate` | `stages/stage.ts:97-98`、`stages/creative-stage.ts:230` `:239`、`pickable/map-pickable-menu.ts:298` `:307` `:308` `:404`、`hud/windows/menu-actions.ts:19` |
| `ObjectPlacerPanel` / `ObjectPlacerForm` / `ObjectPlacerPreset` / `object-placer-panel.ts` | `DynamicPlacerPanel` / `-Form` / `-Preset` / `dynamic-placer-panel.ts` | `creative/object-placer-panel.ts`、`stages/creative-stage.ts` |

合計 79 行(`object-placer-panel.ts` 34 / `creative-stage.ts` 23 / `map-pickable-menu.ts` 11 /
`stage.ts` 5 / `placement-validation.ts` 3 / `random-name.ts` 2 / `menu-actions.ts` 1)。

**`MenuAction` の `'openObjectPlacer'`(`menu-actions.ts:19`)は UI の内部トークンであって
セーブに載らない**(`src/game/save/` に `objectType` / `openObjectPlacer` が現れないことを
確認済み)ので改名してよい。

**メニュー文言「オブジェクトを配置する」(`map-pickable-menu.ts:298`)は変えない** —
SPEC/MAP.md 560-561 と 597-598 が持つ UI 用語(決定2 と同じ理由)。

### 達成条件と検証

- `grep -rn "ObjectType\|objectType\|ObjectPlacer\|objectPlacer\|ObjectAuthoring" src/` が 0 件。
- `npm run typecheck` / `npm run test:game`。
- `npm run dev` で CREATIVE ステージ:
  - 空域右クリック → 「オブジェクトを配置する」で配置パネルが開き、種類(自艦/敵/弾薬/
    RCS燃料/基地)を選んで配置できる。名前を空にしたときのランダム命名が種類ごとに従来どおり出る。
  - 既存の自艦を右クリック → 「複製」で、同じ種類が事前選択された状態で配置パネルが開く。

---

# 見積り

**実測した置換対象の行数から出す**(`980b7929`)。

| 手順 | 置換行 | 判断の要る箇所 | 重さ |
| --- | --- | --- | --- |
| 1. `empty-space` | 約 10 | `ContextMenu` の型引数の扱い(1つ) | **中**(設計判断1つを含む) |
| 2. 軌道点の型 | 約 8 | `map-property-rows` を括らない判断、`map-pickable-menu:447/454` の扱い(2つ) | **小** |
| 3. ラグランジュ点の種別 | **24 箇所** | **24 箇所すべてが個別判断** | **最大。この計画の半分** |
| 4. `ENTITY_GLYPH` 分割 | 30 | 分割の境界(決定済み) | **中** |
| 5. `PhysicalObject` 改名 | 114 | 無し(機械置換3語) | **小**(CSS 28 行の目視確認が要る) |
| 6. `ObjectPicker` 改名 | 41 | 無し(機械置換) | **小** |
| 7. `ObjectType` 族 | 79 | 新しい語の一貫性(決定済み) | **中** |

**合計 約 306 行の置換 + 27 箇所の個別判断。**

**手順3 だけが他と桁が違う**(24/27 の判断がここに集中する)。
決定3 が覆れば、残りはほぼ機械置換になる。

---

# リスクと落とし穴

| リスク | 影響 | それが露見する場所 |
| --- | --- | --- |
| **`hud-physical-object-list` は localStorage キー**(`storageId`、および区画ごとの `sectionId`)。改名すると既存プレイヤーの区画開閉状態が既定へ戻る | 保存された開閉状態が1回だけ失われる。**壊れはしないが、無言で起きる** | 手順5。**移行しないと決めるならその判断を残して通す**(既定は6区画とも開なので実害は小さい) |
| **`map-view-style.ts` の 28 セレクタは別ファイルにある。** パネル側だけ改名すると、**型検査もテストも通ったまま見た目だけが崩れる** | sticky 見出しの背景が消える・行の色が当たらない・コンパクト幅のレイアウトが崩れる | 手順5。目視確認を達成条件に入れてある |
| **手順3 で `physical-object-list-order.ts:151`(`kind === 'body' && filter === 'satellite'`)に `'lagrange'` を含めてしまう** | 衛星フィルタでラグランジュ点の親までクラスタ見出しとして出る。**件数 (N) は変わらないので見落としやすい** | 手順3。「衛星フィルタで親惑星が出る/ラグランジュ点の親は出ない」を目視 |
| **手順3 で `object-pickables.ts:186`(`inFocusedSystem`)・`:201`(`distanceFromStar`)からラグランジュ点が落ちる** | 太陽系順の並びでラグランジュ点だけが先頭へ寄る。**例外も型エラーも出ない** | 手順3。太陽系順でラグランジュ点が親天体の近くに並ぶことを目視 |
| **手順3 で `order.ts:197` の `lagrangeSortKeyOf` の早期 return を `'body'` のまま残す** | `kind` が `'lagrange'` になった瞬間に全ラグランジュ点が `null` を返し、**L4/L5 の順序が浮動小数点誤差で毎フレーム反転する**(`compare()` のコメントが警告している状態そのもの) | 手順3。地球の L4/L5 が一覧でちらつかないことを目視 |
| **手順4 で字形の値を写し間違える** | 別の記号が出る。**型は通る**(どれも `string`) | 手順4。分割前後で `grep -oE "'[^']'"` の結果が一致することを確認する |
| **手順1 で `ContextMenu` の型を緩めすぎる** | 空域以外の右クリックでも対象なしのメニューが開けるようになり、後で誤用される | 手順1。型引数を弱める代わりに、空域専用の開き方を1つ足す形を優先する |
| **手順7 で `'openObjectPlacer'` を `MenuAction` の値として改名する際、`map-pickable-menu.ts` の `act` 文字列と `menu-actions.ts` の union の片方だけを直す** | 型エラーになるので露見する(無言では壊れない) | 手順7 |
| **日本語ラベルを巻き込んで置換する** | 画面の文言が変わり、SPEC が嘘になる | 全手順。達成目標7 の `git diff` 検査で当てる |

---

# この計画で触らないもの

| 何 | なぜ外すか |
| --- | --- |
| **`FocusTarget` の `kind: 'object'`**(`camera/focus-target.ts:11`、19 箇所) | 決定6。`save/save-data.ts:301` に載る**永続化された値**で、改名にはセーブのマイグレーションが要る。**`'point'` との対で `'object'` 側が誤っている**(apsis / relnode / eqnode マーカーもラグランジュ点もこの `'object'` で解決される)ことは記録しておく |
| **`MapPickKind` の `'body'` → `'celestial'`** | `rename_body.md` 手順6 の担当。本計画は `'lagrange'` を**抜き出すだけ**で、残った `'body'` の語には触らない |
| **`ObjectType` と `DynamicEntityKind` の値の統一**(`'enemy'` / `'ship'`) | 決定5。`generateRandomName()` の分岐キーなので挙動に触れる。**2つの union が同じ集合を別名で持っている**ことは記録しておく |
| `renderObject` / `buildRenderObject` / `getObjectByName` / `setFromObject` / `Object3D` | three.js の語。CODING-RULE 2.1「ライブラリが定めた表記は変更しない」 |
| `map-property-rows.ts` の `bodyRows` / `apsisRows` / `nodeRows` | 手順2 で括らないと決めた(`apsis` だけ別メソッドなので、括ると分岐が増える) |
| **画面に出る日本語**(「軌道物体」「宇宙空間」「オブジェクトを配置する」ほか) | 決定2。SPEC/MAP.md・UI-DESIGN.md が持つ UI 用語で、変えるなら SPEC が先行する(`/modify-feature`) |
| `DEVELOP/SPEC/` | 上と同じ理由で、**この計画で嘘にならない。** 手順3 でラグランジュ点が別種別になっても、SPEC/MAP.md 10節が定める「親天体の直下に入れ子で並ぶ」は変わらない |
| `DEVELOP/CODING-RULE.md` | 決定1 が総称を作らないので、規約へ足す語が無い。**`entity` の定義(2.2)にも触れない** |

---

# 同ディレクトリの他2計画との順序

`memos/hedalu244/` には `rename_entity.md` と `rename_body.md` があり、識別子が重なる。

**推奨する順序: `rename_entity.md` → 本計画 → `rename_body.md`。**

| 重なり | 本計画 | 相手 | 順序の理由 |
| --- | --- | --- | --- |
| `ENTITY_GLYPH`(`marker/marker-glyphs.ts`、30 行) | **手順4 が分割する** | `rename_entity.md` は「総称の語が決まらない」として保留し、本計画へ送っている | どちらが先でもよい。相手はこのファイルに触らないと明記している |
| `ENTITY_ROWS` → `DYNAMIC_KIND_ROWS`(`hud/panels/view-options-panel.ts`) | 触らない | `rename_entity.md` が行う | **手順4 の `DYNAMIC_KIND_GLYPH` は同じ語形を採る。** 相手が先なら語が既に立っている |
| `bodyEntityGlyph` → `celestialClassGlyph` | **手順4 が `CELESTIAL_CLASS_GLYPH` を作る**(関数の中身が変わる) | `rename_body.md` が関数名を改名する | **本計画が先。** 相手は関数名だけを変えるので、中身が `CELESTIAL_CLASS_GLYPH` を引く形でも衝突しない |
| `MapPickKind` の `'body'` | **手順3 が `'lagrange'` を抜き出す** | `rename_body.md` 手順6 が `'body'` → `'celestial'` へ改める | **本計画が先。** 相手は「`'celestial'` にするとラグランジュ点が `'celestial'` を名乗る状態が残る。総称の是正が済んだら見直す」と自ら記録している。**本計画の手順3 がその見直しそのもの**で、先に通せば相手の手順6 は素直な改名になる |

**順序が入れ替わっても壊れない** — どれも識別子の改名で、片側だけ main に入った状態でも
型検査は通る。ただし `MapPickKind` は**同じ union に両方が触る**ので、
`rename_body.md` 手順6 と本計画の手順3 は**同時に走らせない。**

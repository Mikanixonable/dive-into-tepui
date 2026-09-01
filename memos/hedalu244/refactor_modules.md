# モジュール分割の再点検 — 検出と修正計画

PR #48(enemy の多態化)をモデルケースとして、**同じ病気が他所に無いか**を `src/` 全体で
探した結果と、論点ごとの修正方針。

コード計測はすべて **53071459** 時点。行数・参照数を根拠にしているので、着手前に測り直す。

---

## モデルケースが示した形(PR #48)

| | 前 | 後 |
| --- | --- | --- |
| enemy.ts | 528 | 412 |
| protein-enemy.ts | — | 251 |
| metal-enemy.ts | — | 77 |
| enemy-dictionary.ts | — | 13 |
| enemy-kind / -formation / -marker / -render / -save / -sun-glare | 43 / 21 / 35 / 27 / 29 / 17 | 削除 |
| **合計** | **700 行 / 7 モジュール** | **753 行 / 4 モジュール** |

**行数はほぼ変わっていない。** 変わったのは、「`kind` を見て振る舞いを選ぶ分岐が、6つの小さな
ファイルと本体に散っていた」状態が「型が振る舞いを持つ」状態になったこと。**これが判定基準で
あって、行数の増減ではない。**

同時に確認しておくべき裏返し: 統合の結果として `enemy-dictionary.ts`(13行)は**新設**された。
規約 1.6「クラス辞書は独立したモジュールに置く」が要求する形なので、これは短くても正しい。
**短いモジュールを一律に潰す作業ではない。**

---

## 検査の方法(再実行できるように)

### 何を「怪しい」とするか

**分岐の数ではなく、「その値を固定したときに通らなくなる行がどれだけあるか」で疑う。**
識別子が `kind` である必要はない — `*Type` / `*Mode` / `is*` / 素の `boolean` / `instanceof`、
どれも同じ病気を運ぶ。実際、この節の 1〜3 は当初 `kind` だけを見ていて、
論点15〜20 を丸ごと取り逃していた。

判定の目盛りは3段階:

- **on/off を表す boolean は容認する。** `visible` は 22 モジュールの署名に現れるが、
  「出す/出さない」以上のことを言っていないので、どこにあっても読める。
- **on/off でない2分を疑う。** 「AとBのどちらか」を boolean や別名の型で表しているもの。
  `overviewMode`(戦闘ビュー/マップビュー)がこれで、23 モジュールの署名を横断している。
- **3値以上は原則として疑う。** 1箇所でディスパッチする状態機械(`WaveState`)なら正しい形だが、
  分岐が複数のメソッド・複数のモジュールへ散っていれば多態の候補。

### 走査の手順

1. `src/**/*.ts` の import を静的に解決して**参照グラフ**を作り、各モジュールの行数と
   「何モジュールから import されているか」を出した。
2. 参照元が1つのモジュール(167件)を、行数と**参照元の行数**で並べた。
   「単一参照 × 参照元が500行超」に当たるものを抽出。
3. **文字列リテラル union の型別名を全部集め(97件)、その値に対する分岐
   (`=== 'x'` / `!== 'x'` / `case 'x'`)をモジュール別に集計した。** 型名では絞らない。
4. **クラスのフィールドのうち boolean / union / nullable のものについて、そのクラスの
   何本のメソッドが読んでいるか**を数え、`読むメソッド数 / 全メソッド数 × 分岐行数` で並べた。
5. **`boolean` 引数の名前を集め、何モジュールの署名に現れるかを数えた**
   (`overviewMode` はこれで出た)。
6. **`instanceof` の出現を、判定対象のクラス別に集計した。** 規約 1.3 が
   「当事者の型を分岐するコードは境界が破れているサイン」と名指ししている形。
7. 疑わしいものだけ中身を読み、**規約 1.2「長いモジュールは、まず原因を診断する」の4分類**
   (手続きの切り出し / 多態 / そのままでよい / 単に多い)へ振り分けた。

### 数え方の癖(再実行するときの注意)

- **バレル(`index.ts`)越しに export されているモジュールは、参照数が 1 と出る。**
  `hud/widgets/` `hud/windows/` はこの理由で単一参照に見えるだけで、実際は多数から使われている。
  手順 2 の結果を読むときはここを外すこと。
- **手順 3 は値で数えるので、値を共有する型どうしが混線する。** `MapPickKind` と
  `DynamicEntityKind` と `ObjectType` は `'player'` を共有しているので、互いの分岐を数え込む。
  **この混線自体が論点16 の発見につながった**ので、潰さずに残してある。

---

## 判定の要約

| # | 論点 | 診断 | 規模 | 優先 |
| --- | --- | --- | --- | --- |
| 1 | `MapPickable.kind` の 10 値 union | **多態で分ける** | 7モジュール 2,177行 / 分岐65箇所 | 最優先 |
| 2 | BVH・三角形衝突の重複実装 | **重複の解消 + 置き場所** | 2モジュール 825行 | **実施済** |
| 3 | `base-station-model.ts` の 845 行 1 関数 | **手続きの切り出し** | 852行 | 高 |
| 4 | `game/const.ts` の 104 定数 | **所有者へ戻す** | 319行 / 参照76モジュール | 高 |
| 5 | `hud/style/` の 22 ファイルと結合ハブ | **短すぎるモジュールの多数** | 22モジュール 1,980行 | 中 |
| 6 | `marker-manager.ts` のラベル間引き同居 | **手続きの切り出し** | 659行 | 中 |
| 7 | `camera/focus-markers.ts` の4責務 | **分割 + 置き場所** | 609行 | 中 |
| 8 | Player のブースター運用が正本割れ | **責務の集約** | 818 + 201行 | 中 |
| 9 | `plan-editor.ts` の5責務 | **分割** | 726行 | 中 |
| 10 | 「ラベル付き入力行」の重複 | **共通化(要判断)** | 4箇所 | 中 |
| 11 | `view-hud-controller.ts` | **たらい回し。畳む** | 32行 | 低(即実施可) |
| 12 | `partFromSaveData` の8分岐 | **全腕同一。畳む** | parts.ts:79-90 | 低(即実施可) |
| 13 | `overviewMode` が23モジュールの署名に漏れる | **要判断(保留)** | 署名23 / 分岐28 | 要相談 |
| 14 | `DynamicSystem` の種別手展開 | **要判断(保留)** | 575行 | 要相談 |
| 15 | 「戦闘/マップ」の軸に**5つの語彙** | **型の重複。1つに畳む** | 型4 + boolean 1 | 高(型統合は即実施可) |
| 16 | エンティティ種別の語彙が**5つ** | **型の重複。1つに畳む** | 型5 | 高(論点1 と同時) |
| 17 | `OrbitAnalysisWindow` のタブが**半分だけ切り出し** | **多態で分ける** | 466行 / 分岐約30 | 中 |
| 18 | `Player`/`Base` を消費側が `instanceof` で判別し直す | **多態の復元** | 26箇所 / 11モジュール | 中 |
| 19 | その他の重複 union(`L1..L3` 等) | **型の重複。1つに畳む** | 3組 | 低(即実施可) |
| 20 | `MapCamera` の2つの非 on/off 2分 | **要検討** | 531行 / 分岐12 | 低 |

---

## 論点1 — `MapPickable.kind` の 10 値 union(最優先)

### 症状

`map-pickable.ts:5` の

```ts
export type MapPickKind = 'body' | 'ship' | 'player' | 'apsis' | 'relnode' | 'ammo' | 'fuel'
  | 'empty-space' | 'eqnode' | 'base';
```

が、**振る舞いを持たない素の struct のタグ**として置かれ、その振る舞いは全部外側の
`switch` / `if` に手展開されている。enemy が `EnemyKind` でやっていたことと同型で、規模はこちらが
大きい。

### 証拠

`MapPickKind` の値に対する分岐の箇所数:

| モジュール | 行数 | 分岐 |
| --- | --- | --- |
| `pickable/map-context-actions.ts` | 687 | 23 |
| `pickable/map-pickables.ts` | 261 | 11 |
| `pickable/map-property-rows.ts` | 233 | 10 |
| `pickable/map-pickable-menu.ts` | 463 | 7 + ディスパッチ表 |
| `hud/object-groups.ts` | 63 | 7 |
| `hud/panels/physical-object-list-order.ts` | 246 | 5 |
| `hud/panels/physical-object-list-tree.ts` | 224 | 2 |

さらに `MapPickable` は**種別ごとにしか意味を持たない optional フィールド**を並べている
(`time` / `detail` / `approaching` / `collectable` / `distanceFromStar` / `priority` /
`inFocusedSystem` / `ownerName` / `pickable`)。規約 1.6 の「不在は `T | null`」以前に、
そもそも**ある種別には存在しえない値**が全種別に生えている。

**決定的な証拠は `map-pickable-menu.ts:92-383` の
`private readonly handlers: Record<MapPickable['kind'], PickHandler>`。** ここでは既に
「種別ごとに `itemsFor` と `run` を持つ」ことが認められていて、それを**1クラスの中の
291行のオブジェクトリテラルとして手で書いている。** 多態が必要だと気づいた上で、多態を使わずに
表で代用している状態。

### 診断

規約 1.2 の「1つの `kind` で、多くのメソッドの大部分が切り替わっている」に真っ直ぐ当たる。
`kind` を1つに固定すると、`map-context-actions.isTargetGone` / `stateOfPickable` /
`renameHandlerFor` / `relatedItemsFor` / `windowParts`、`map-property-rows.rowsFor` の
9分岐、`map-pickable-menu.handlers` の該当キー以外、`object-groups.groupPickables` の
switch がまるごと通らなくなる。

### 修正

1. `MapPickable` を **interface + 具象クラス**にする。共通の口は
   `id` / `name` / `pos`(データ)と、
   - `isGone(entities): boolean`
   - `stateAt(): KinematicState | null`
   - `propertyRows(…): readonly PropertyRow[]`
   - `menuItems(simTime): readonly MenuItem<MenuAction>[]` / `runMenu(act)`
   - `groupLabel(): string | null`(一覧の区画見出し)
   - `renameHandler(): ((name: string) => void) | null`
   (メソッド。データの optional フィールドは各具象のフィールドへ落とす)
2. 具象は `BodyPickable` / `ShipPickable` / `PlayerPickable` / `BasePickable` /
   `AmmoPickable` / `RcsFuelPickable` / `ApsisPickable` / `RelNodePickable` /
   `EqNodePickable` / `EmptySpacePickable`。**近い種別は基底を共有する**
   (`apsis` / `relnode` / `eqnode` は `isOrbitPoint` で同じ扱いを受けているので
   `OrbitPointPickable` 派生でよい。`ammo` / `fuel` も同様)。
3. `map-pickable-menu.ts` の `handlers` 表を各具象の `menuItems` / `runMenu` へ移す。
   表が消えたあとに残る `MapPickableMenu` は**メニュー DOM の表示制御だけ**になるので、
   そこまで痩せたら `ContextMenu` 側へ畳めるか見る。
4. `map-property-rows.ts` の `rowsFor` の9分岐は各具象の `propertyRows` へ。
   共通の `orbitRows` は基底に残す。
5. `object-groups.ts` / `physical-object-list-order.ts` / `-tree.ts` の分岐も同様に消す。
   ただし**天体分類(`bodyClass`)に対する switch は残してよい** — 規約 1.8 が
   明示的に許可している。

### 注意

- **`MapPickable` は毎フレーム作り直される表示用の候補列。** クラス化してもその性質は変えない
  (キャッシュを足さない)。`MapPickables` が per-frame に `new` するだけ。
- `MapContextActions` は開いているウィンドウの `target: MapPickable` を**フレームを跨いで
  保持している**(`WindowEntry.target`、`sync` で `isTargetGone` を見て閉じる)。ここは
  「毎フレーム作り直す candidate」と「保持している target」が同じ型で混ざっているので、
  **具象化のついでに、保持側は id + 種別だけを持って毎フレーム引き直す形に変える**か、
  少なくとも寿命の違いを明示する。

### 見込み

`map-context-actions.ts` 687 → 350前後、`map-pickable-menu.ts` 463 → 100前後、
`map-property-rows.ts` 233 → 具象へ分散。具象10個ぶんの新ファイルが増えるが、
**enemy と同じく1ファイルが1つの種別を全部言い切る形**になる。

---

## 論点2 — BVH・三角形衝突の重複実装(実施済)

`math/triangle-mesh.ts` を新設し、`Triangle` / `RayHit` / `SphereHit` / `BVHNode` と、BVH 構築・
レイキャスト・球衝突・AABB 判定を集約した。base 側と protein 側の二重実装は消え、両者はこの
モジュールを呼ぶだけになった。

- **BVH の分割は中央値ソートへ統一した。** 構築は生成時の1回だけで毎フレームの費用にならない
  ため、偏りに強い側を実測を待たずに採った。葉16枚・深さ12 は名前付き定数にした。
  **基地側の木の形は変わるが、返る最近交差・最深接触は同じ。**
- `BVHNode` を葉と枝の union にしたので、`left` / `right` の `?` と `!` は消えた。
- `base-collision.ts` は「基地の当たり形状を組む」だけに戻した。OBB は箱の集合という基地固有の
  形なのでここに残し、LOD1 / LOD2 の箱表を定数へ出し、読まれていなかった三角形配列を消した。
  `base.ts` の隣にあるのでモジュール名はそのまま、`OBB` は非 export にした。
- `protein-ribbon-collision.ts` のローカル再定義 `lenSq` は `math/vec3` のものへ寄せた。
- 型の import 元は `base.ts` / `dynamic-entity.ts` / `entity-contact-response.ts` /
  `protein-ribbon-collision.ts` の4モジュールを `math/triangle-mesh` へ差し替えた。

825行 → math 218 + base 259 + protein 158。`npm run typecheck` / `test:math` 42件 /
`test:game` 161件 通過。

---

## 論点3 — `render/base-station-model.ts` の 845 行 1 関数

### 症状

`buildBaseModel(): THREE.Group` が **7行目から852行目までの単一関数。** 途中で
`buildContainer`(632)・`buildAdvancedCargoGroup`(685)・`pseudoHash`(792)という
ローカル関数が定義されるだけで、それ以外は全部トップレベルのベタ書き。

比較: 同じ `render/` の `ships.ts` は 556行で 26 関数、`booster.ts` は 459行で 3 関数。

### 診断

規約 1.2「関数は100行を基準とする」への単純な違反。
**モジュールとしては1本でよい**(基地の造形という単一の関心)。分けるべきは関数。

### 修正

部位ごとの `function buildXxx(): THREE.Group`(または `THREE.Object3D[]`)へ切り、
`buildBaseModel` は**それらを組み立てて `markLitOpaque` / `markSunShadowCaster` を掛けるだけ**
にする。切り目はコード中の区画コメント(トラス・ハブ・ドッキング部・ラジエータ・コンテナ群…)
に既に現れているはずなので、それをそのまま関数名にする。

**新しいファイルを作らない。** 852行のままでよい(規約 1.2「同じ関心の実装が単に多い」)。
ファイルを増やすと `ships.ts` との対称が崩れる。

---

## 論点4 — `game/const.ts` の 104 定数

### 症状

`src/game/const.ts` は 319行・**104 export**・**76 モジュールから参照**されている。
規約 1.6 が名指しで禁じている「フォルダごとの集約ファイル(`const.ts` の類)」そのもの。

`memos/hedalu244/module_restructure.md` の「残っている宿題」に
「`const.ts` に残る 107 export は、**複数モジュールから参照されるもの**」とあるが、
**これは現状と合っていない。** 実測:

- **参照モジュールが1つだけ**: 21 定数
- **参照が1ディレクトリ内に閉じている**: 49 定数

| 閉じている先 | 定数の数 |
| --- | --- |
| `game/dynamic/` | 16 |
| `game/dynamic/dynamic-entity/` | 15 |
| `game/player/` | 6 |
| `game/camera/` | 4 |
| `game/stages/` | 4 |
| `game/plan/` | 2 |
| `game/vfx/` / `game/hud/panels/` | 各1 |

参照が1モジュールのもの(そのまま移して export をやめられる):

```
BULLET_BCINV BULLET_MASS BULLET_RADIUS        → dynamic-entity/bullet.ts
STAGNATION_AREA_FRACTION                       → dynamic-entity/dynamic-entity.ts
SHIP_BULK_DENSITY SHIP_SPECIFIC_HEAT           → dynamic-entity/ship.ts
AMMO_PHYS_RADIUS                               → dynamic-entity/ammo-pickup.ts
MAX_BULLETS MAX_CASINGS                        → dynamic/dynamic-system.ts
DRAG_STEP_MAX_SPEED_LOSS DRAG_STEP_MAX_SCALE_HEIGHTS → dynamic/time-step.ts
CONTACT_GRID_CELL_SIZE_FLOOR                   → dynamic/entity-contact-physics.ts
HULL_START_TEMP                                → player/player.ts
RADIATOR_FOLD_COUNT                            → player/radiator.ts
BELT_MAX_VISIBLE                               → player/belt.ts
EJECTED_MAG_PHYS_RADIUS                        → vfx/effects-system.ts
DEBUG_LOAD_DEBRIS_COUNT / _DEBRIS_MAX_DIST /
  _PLACEMENT_MIN_DIST / _RNG_SEED              → stages/stage-debug-load.ts
guideKindDefaultColors                         → hud/panels/guide-kind-def.ts
```

### 修正

1. 上の21件を移し、**export をやめる**(規約 1.6「必要になってから export する」)。
2. 1ディレクトリに閉じている残り28件を、そのディレクトリの**概念の所有者モジュール**へ移して
   そこから export する。所有者の候補:
   - 熱・弾道係数・SRP 係数 → `dynamic-entity/dynamic-entity.ts`(比量モデルを渡す側)
   - 破片系 → `dynamic-entity/debris-piece.ts`
   - 積分・接触の刻み → `dynamic/time-step.ts` / `dynamic/entity-contact-physics.ts`
   - カメラ画角 → `camera/camera-system.ts`
3. **本当に複数フォルダから参照されるもの**(`PLAYER_MASS` / `SIM_SPEED_LEVELS` /
   `MARKER_PRIORITY` / `MAG_ROUNDS` / 色トークンなど)だけを `const.ts` に残す。
   `MARKER_PRIORITY`(7ディレクトリ10モジュール)は `marker/` が所有者なので `marker/` へ、
   色トークンは `theme.ts` 側へ寄せられる可能性がある。**残るのは 20〜30 件が目標。**
4. `module_restructure.md` の「残っている宿題」を実測値へ直す(この文書の数字で置き換える)。

### 注意

`guideKindDefaultColors` とそれが使う `GUIDE_GROUP_HUE` / `guideKindShade` / `lerpColor` は
`module_restructure.md` が「移動先の判断が要る」として保留したもの。**参照は
`hud/panels/guide-kind-def.ts` の1件だけ**なので、そこへ移せば済む。

---

## 論点5 — `hud/style/` の 22 ファイルと 2 つの結合ハブ

### 症状

`game/hud/style/` は **22ファイル 1,980行**。中身は全部 CSS のテンプレート文字列。
組み立てはハブ2枚を通る:

- `panel-content-style.ts`(21行) — **import 14本 + 連結式1つだけ。** 責務ゼロ。
- `skeleton-style.ts`(50行) — 3つを連結 + レスポンシブの追記。半分はハブ。
- `hud-root.ts:35` が `LAYOUT_TOKENS_STYLE + SKELETON_STYLE + PANEL_CONTENT_STYLE
  + COMBAT_VIEW_STYLE + MAP_VIEW_STYLE` を注入。

`panel-content-style.ts` にぶら下がる 14 枚のうち **10枚が 41行以下**
(`view-options`18 / `object-placer`20 / `result-screen`22 / `navball`23 /
`frame-controls`28 / `stage-controls`28 / `stage-status`29 / `orbit-guide`35 /
`pause-menu`38 / `plan-panel`40)。うち6枚は **TypeScript 側の値を1つも参照していない**
純粋な CSS 文字列(`view-options` / `object-placer` / `orbit-guide` / `frame-controls` /
`stage-controls` / `combat-panel-rows`)。

### 診断

規約 1.2「短すぎるモジュールが多数あることは、長すぎるモジュールと同格の違反」+
「不要なたらい回しをするだけの薄すぎるラッパー」。`panel-content-style.ts` は後者そのもの。

**CSS を TS の文字列で持つこと自体は論点にしない。** webpack には `css-loader` が入っているが
`.css` ファイルは1枚も無く、トークンやブレークポイントを TS 側から差し込んでいる箇所がある
(`marker-style` 13箇所、`map-view-style` 6箇所)。**移行するなら別の判断が要るので、ここでは
ファイル数だけを問題にする。**

### 修正

`panel-content-style.ts` を消し、14枚を **画面のまとまりで4枚**へ統合する。統合先は
`hud-root.ts` が直接連結する:

| 統合先(案) | 元 | 行数 |
| --- | --- | --- |
| `panel-rows-style.ts` | combat-panel-rows / navball / predict / plan-panel | 約220 |
| `map-panel-style.ts` | view-options / orbit-guide / object-placer / stage-controls / frame-controls | 約130 |
| `screen-style.ts` | pause-menu / result-screen / stage-status | 約90 |
| `settings-view-style.ts` / `help-panel-style.ts` | そのまま(167 / 146) | — |

`skeleton-style.ts` も同様に、`hud-layout-style` / `hud-badge-style` / `marker-style` を
畳めるか見る(3枚で380行なので、統合すると1枚が430行。**500行の上限内には収まるが、
`marker-style` はマーカー意匠という独立した関心なので残してよい**)。

**目標は 22 → 10 前後。** 0にはしない。

---

## 論点6 — `marker-manager.ts` にラベル間引きが同居

### 症状

`game/marker/marker-manager.ts`(659行)は2つの関心を持っている。

| 関心 | 範囲 | 行数 |
| --- | --- | --- |
| マーカー DOM のレジストリ | `set` / `setPosition` / `setNodePosition` / `setDirection` / `setBearing` / `hide` / `fadeOut` / `remove` / `dispose`(134-416) | 約280 |
| ラベルの間引き・反発の解決 | `resolveCollisions` / `collectActiveMarkerRecords` / `thinByPriority` / `relaxLabelRects` / `applyLabelOffsets`(420-658)+ 先頭の優先度ヘルパ | 約260 |

`relaxLabelRects` は **490-624 の 134 行 1 メソッド**(規約 1.2 違反)。

### 診断

規約 1.2「独立した意味を持つ手続きが直に書かれている」。
間引きと反発は **「画面上のラベルの混雑をどう解くか」という、それ自身の名前で呼べる責務。**
入力は `MarkerRecord[]`(位置・優先度・距離・ラベル矩形)だけで、DOM の生成にも
マーカーの登録にも触らない。

### 修正

`game/marker/label-declutter.ts`(仮)へ、`thinByPriority` / `relaxLabelRects` /
`applyLabelOffsets` と優先度ヘルパ(`defaultPriorityForClass` / `canHideIconByPriority` /
`NEVER_HIDE_ICON_CLASSES` / `COLLISION_BUCKET_SIZE` / `COLLISION_PADDING`)を移す。
`MarkerManager.resolveCollisions` は集めて渡すだけになる。

`relaxLabelRects` は移した先で**さらに分ける**(矩形の初期配置 / 反発の反復 / 収束後の適用)。

### 前提

論点7 と同時に見ること。**ラベル混雑の解決は現在3箇所にある**:
`marker-manager.thinByPriority`、`camera/focus-markers.ts` の `CrowdingGrid`(103-170)、
`marker/grouped-markers.ts`。共有しているのは `marker/crowding.ts`(31行)の
`resolveCrowdingWinner` だけ。3つを1つにできるかは**先に SPEC/MAP.md 7.2 を読んで、
「別々の挙動であるべきか」を確かめる。** 別々であるべきなら統合しない。

---

## 論点7 — `camera/focus-markers.ts` の4責務

### 症状

`game/camera/focus-markers.ts` は 609行で、次の4つを同居させている。

1. **天体ラベルの構築** — `FocusLabel` の組み立て、ラグランジュ点の命名
   (`lagrangeName` / `lagrangeMarkerLabel`)、分類別の優先度表(`LABEL_PRIORITY`)。
2. **混雑の解決** — `CrowdingGrid` クラス(103-170)。
3. **マーカーの同期** — `syncLabels`(386-468, 82行)、`syncSubLabels`(473-602, **129行**)。
4. **`MapPickable` の生成** — `bodyPickables`(271-311)と `cacheBodyPickable`。
   `MutableMapPickable` を作り、`cachedBodyPickablesTime` / `cachedBodyPickablesPolicy` で
   キャッシュしている。

### 診断

- **置き場所が誤り。** `camera/` はカメラの姿勢・投影・追従を持つフォルダで、
  「天体ラベルを何個出すか」も「どの被選択物があるか」もカメラの関心ではない。
- 4 は論点1 と直結する。`MapPickable` を具象クラス化すると、ここは
  `BodyPickable` を作って返すだけになる。
- `syncSubLabels` の129行は規約違反。

### 修正

論点1 の後に着手する。

1. `bodyPickables` / `cacheBodyPickable` を `pickable/` 側へ移す
   (`BodyPickable` の生成は `MapPickables` が持つのが自然)。
   **キャッシュは持ち込まない** — 毎フレーム作り直す(既定)。フレームレートで困ったら
   そのとき測って戻す。
2. 残りを `marker/celestial-labels.ts`(仮)として `game/marker/` へ移す。
   `CrowdingGrid` は論点6 の `label-declutter` へ寄せられるか、同じ判断で決める。
3. `syncSubLabels` を分割する。

---

## 論点8 — Player のブースター運用が正本割れ

### 症状

`Player`(818行)は既に 13 個の下位オブジェクトを合成している
(`throttle` / `fire` / `belt` / `aero` / `altitudeAlarm` / `radiator` / `power` /
`thrustEffects` / `rcsEffects` / `reentryEffects` / `markers` / `boosterPlumes` / `boosters`)。
**ブースターだけが例外で、運用が `Player` に直接書かれている。**

`Player` 側にあるもの:

- `attachBooster`(270-290) / `toggleBoosterIgnition`(292-304) / `decoupleBooster`(307-355)
- `boosterManagementViewModel`(357-371) / `activeBooster`(373-376)
- `rebuildBoosterModels`(378-389) / `refreshBoosterMassAndInertia`(391-403)
- `stepAttachedBooster`(405-413) / `combinedThrust`(415-418)
- 定数 8 本(`BOOSTER_DEFAULT_DRY_MASS` 〜 `BOOSTER_COLLISION_GRACE`)

`BoosterStack`(201行)側にあるもの: `attach` / `toggleIgnition` / `step` /
`detachOutermost` / `exportData` / `importData` のみ。

さらに `player/booster-id.ts`(**8行**)は `EntityIdAllocator` を1つ持つだけのモジュールで、
参照は `player.ts` と `dynamic-entity/detached-booster.ts` の2つ。
`player/booster-separation.ts`(28行)は運動量保存で速度差を配る純関数1本で、
参照は `player.ts` のみ。

### 診断

規約 1.6「正データが複数箇所に分散、重複しているデータ」。
「接続中のブースター段」という1つの概念について、**段の数値は `BoosterStack`、
既定値・見た目・質量慣性・分離・HUD 文言は `Player`** に割れている。
`Player` が 818行なのはこれが主因ではないが、**`fire` / `belt` と同じ形になっていない
のは一貫性の欠落。**

### 修正

`PlayerBoosters`(`player/player-boosters.ts`)を新設し、`PlayerFire` と同じ形にする
(`Player` 本体・`Hud`・`THREE.Scene` を受け取り、自分で HUD 文言も模型も持つ)。

- `BOOSTER_DEFAULT_*` / `BOOSTER_MAX_ATTACHED` / `BOOSTER_MOUNT_Z` /
  `BOOSTER_SEPARATION_SPEED` / `BOOSTER_COLLISION_GRACE` を移す。
- `booster-id.ts`(8行)を畳む。**`EntityIdAllocator` を1つ持つだけのモジュールに
  責務はない。** 接続中の段と分離後の `DetachedBooster` で ID を引き継ぐ都合があるので、
  畳む先は `BoosterStack`(セーブ形式の単位)にして、`detached-booster.ts` はそこから引く。
- `booster-separation.ts`(28行)も畳む。運動量保存の式そのものは厳密な物理だが、
  「船とブースターの2体」に特化しているので `physics/` へ出す価値もない。
- `BoosterStack` は**数値の段スタックのまま残す**(`exportData` / `importData` を持つ
  ので、セーブ形式の単位として意味がある)。

`Player` は 818 → 700前後。**500行は超えたままだが、それは「同じ関心の実装が単に多い」
(規約 1.2 の第4分類)なので、そこで止める。**

---

## 論点9 — `plan-editor.ts` の5責務

### 症状

`game/plan/plan-editor.ts`(726行)。

| 関心 | メンバー |
| --- | --- |
| ノードの当たり判定・選択 | `nodeScreenPos` / `pickNodeAt` / `handleMapClick` / `handleNodeRightClick` / `selectNewNode` / `isEmptyNode` / `removeSelectedIfEmpty` |
| ノードの編集 | `addNodeAt` / `deleteNode` / `deleteSelected` / `setSelectedNodeTime` / `rebuildDraggedNode` / `dragNodeToNearestSample` / `applyDv` / `setNodeDvLocal` / `nodeDv` |
| ギズモの配線と同期 | `wireNodeGizmo`(31行) / `syncGizmo`(61行) / `hideGizmo` |
| パネルの同期 | `syncPanel`(39行) |
| 入力の受け口 | `handleInput` / `handleMapPointer` / `updateEditing` / `clearPlanByKey` |

加えて `PlanDisplay`(424) / `NodeGizmo`(302) / `PlanPanel`(201) / `PlanGizmo3D`(106) /
`PlanAxisDrag`(103) を**すべて単独で所有**している(`plan/` は10ファイル 2,755行)。

### 診断

「独立した意味を持つ手続きが直に書かれている」。ただし**論点1 ほど明快ではない。**
編集操作(Δv の適用・時刻の変更・ドラッグでのノード再構築)は
**「計画ノードを編集する」という名前で呼べる責務**で、当たり判定・入力の受け口とは別物。

### 修正(案。着手前に再検討する)

`plan/plan-node-edit.ts`(仮)へ、`addNodeAt` / `setSelectedNodeTime` /
`rebuildDraggedNode` / `applyDv` / `setNodeDvLocal` / `nodeDv` / `isEmptyNode` /
`relativeToBody` / `bodyState` を移す。`PlanEditor` は「入力を受けて、選択を管理して、
編集を呼び、表示を同期する」だけになる。

**単独では優先度が低い。** 論点1〜4 を終えてから、`plan/` 全体(`plan-path.ts` 508行を含む)
をまとめて見るほうが効率がよい。

---

## 論点10 — 「ラベル付き入力行」の重複

### 症状

`w-group` + 見出し + `ValueInput`(+ `Slider`)という**同じ形の行**が、少なくとも4箇所で
別々に組まれている。

| 場所 | 行数 | 参照 |
| --- | --- | --- |
| `creative/slider-field.ts` | 149 | `object-placer-panel.ts` のみ |
| `hud/panels/guide-value-field.ts` | 240 | 軌道ガイドのみ |
| `hud/panels/bgm-settings-panel.ts` | 178 | `new Slider` × 2 |
| `hud/frame/camera-frame-panel.ts` | 161 | `new Slider` × 1 |

`new ValueInput(` は 10 モジュールに散っている。

### 診断

規約 1.4「類似した形の式、類似した形の処理が異なるモジュールに分散」。
ただし**規約 1.5 の分かれ目(「共通化した側が変更されたとき、参照側の挙動も変更されるべきか」)
を先に決めないと一般化してよいか判定できない。**

- `slider-field` と `bgm-settings-panel` / `camera-frame-panel` の行は
  **同じ見た目であるべき**(UI-DESIGN の一貫性)なので共通化の対象。
- `guide-value-field` は `ValueMapping`(対数振幅・位相ラジアン・族範囲の写像)を持つ
  ので**別物**。共通の行部品の上に写像を載せる形になら分けられる。

### 修正

`hud/widgets/` は規約 1.12 が認める「公開境界として意図的に設計したディレクトリ」なので、
そこへ `LabeledField` / `SliderField` を置く。`creative/slider-field.ts` は移動して消える。
`guide-value-field.ts` は `ValueMapping` を残したまま、行の組み立てだけ差し替える。

**先に SPEC/UI-DESIGN.md を見て、行の見た目が「個別に調整されうる要素」でないことを
確認する。** 調整されうるなら共通化しない(規約 1.5)。

---

## 論点11 — `hud/view-hud-controller.ts` は純粋なたらい回し

`game/hud/view-hud-controller.ts`(32行)の全体:

```ts
export class CombatHudController {
  public constructor(private readonly hud: Hud) {}
  public sync(game: Game): void { /* hud の 7 パネルを sync するだけ */ }
}
export class MapHudController {
  public constructor(private readonly hud: Hud) {}
  public sync(game: Game): void { /* hud の 5 パネルを sync するだけ */ }
}
```

`Hud` 以外の状態を持たず、`Hud` のメンバーを呼ぶ以外に何もしない。
参照は `game.ts` の 5 行(111/112/209/210/601-602)だけ。

**規約 1.2「責務がないモジュール。例えば不要なたらい回しをするだけの薄すぎるラッパー」。**

### 修正

`Hud` に `syncPanels(view: HudWorldView, game: Game): void` を1本足し、モジュールごと消す。
`Hud` は既に `setWorldView(view)` を持っていて**どちらのビューかを知っている**ので、
`game.ts:601-602` の分岐も一緒に消える。

---

## 論点12 — `partFromSaveData` の8分岐は全腕が同一

`game/dynamic/dynamic-entity/parts.ts:79-90`:

```ts
export function partFromSaveData(data: AnyPart): AnyPart {
  switch (data.type) {
    case 'hull': return createPart('hull', data);
    …8腕、すべて createPart(<自分のtype>, data)
  }
}
```

**8つの腕は全部同じことをしている。** ジェネリクスを通すためだけの手展開で、
振る舞いの違いは1つも無い。規約 1.2「多態で書けるものを分岐で手展開すること」の
一番退化した形。

### 修正

`createPart` のシグネチャを見直して `return createPart(data.type, data)` の1行にする。
`ExtractPart<TType>` の推論が通らないなら、`partFromSaveData` の側で1回だけ
アサーションする(規約 1.12 の「前提が型以外の仕組みで保証されている場合」に当たる —
`data.type` と `data` が同じ値から来ていることは自明)。

---

## 論点13 — `overviewMode` が23モジュールの署名に漏れている(要判断)

### 症状

「マップビューか戦闘ビューか」を表す `overviewMode: boolean` が、引数として層を横断している。
**boolean 引数の名前を全部集めて署名の出現モジュール数で並べたとき、これが単独で首位。**
2位の `visible`(22モジュール)は純粋な on/off なのでどこにあっても読めるが、
`overviewMode` は「AとBのどちらの画面か」という**on/off でない2分**を boolean で表している。

| 引数 | 署名に現れるモジュール | 分岐箇所 | 判定 |
| --- | --- | --- | --- |
| `overviewMode` | 23 | 28 | **疑わしい** — on/off でない2分 |
| `visible` | 22 | 9 | 容認 — 純粋な on/off |
| `on` | 10 | 2 | 容認 |
| `enabled` | 5 | 1 | 容認 |

モジュール別の出現(識別子の全出現):

| モジュール | 行数 | 出現 |
| --- | --- | --- |
| `game/targeter.ts` | 279 | 26 |
| `game/camera/camera-system.ts` | 293 | 18 |
| `game/plan/plan-display.ts` | 424 | 14 |
| `game/pickable/map-context-actions.ts` | 687 | 12 |
| `game/game.ts` | 638 | 12 |
| `game/celestial/celestial-system.ts` | 555 | 9 |
| `game/marker/marker-manager.ts` | 659 | 8 |
| `game/lines/entity-line-manager.ts` | 158 | 7 |

`targeter.ts` は特に露骨で、`handleTargetSelectKey` は `if (overviewMode) return;` で始まり、
`updateEquatorNodes` は `if (!overviewMode) return;` で始まり、`syncTargetDirMarkers` は
`if (overviewMode || …) return;` で始まる。**値を固定すると通らない行が半分近くある。**

### 判断が要る点

- これは**エンティティの種別ではなく、実行時に切り替わる画面モード。**
  多態にすると `CombatTargeter` / `MapTargeter` の2インスタンスを持ち、
  ビュー切替のたびに使い分けることになる。**両者が共有する状態
  (`aliveTarget` / `boardMarks` / マーカーレジストリ)をどちらが持つかを先に決めないと、
  正本が割れて論点8 と同じ病気になる。**
- `ViewManager` が既にビューの正本を持っているので、**「モードを引数で配る」のをやめて
  「モードごとに違う同期経路を通す」形**(論点11 の `Hud.syncPanels` と同じ発想)なら、
  多態にしなくても分岐は減る。
- **論点15 と同じ軸なので、先に型を1つに畳んでから考える。** `boolean` のままにするか
  `WorldView` を渡すかは、型が1つになった後でないと議論できない。

**この論点は、修正方針をユーザーへ問うてから着手する。** 保留。

---

## 論点14 — `DynamicSystem` の種別手展開(要判断)

`game/dynamic/dynamic-system.ts`(575行)は 9 本の型付き配列
(`enemies` / `bullets` / `casings` / `debris` / `detachedBoosters` / `players` / `bases` /
`ammoPickups` / `rcsFuelPickups`)を持ち、種別ごとに `addX` / `findX` / `updateX` / `syncX` と
上限定数(`MAX_BULLETS` / `MAX_CASINGS` / `MAX_DEBRIS` / `MAX_DETACHED_BOOSTERS`)を
手で並べている。

**しかし、これを1つのレジストリへ畳むのは規約 1.5 の「早急な一般化」に当たる恐れが強い。**
`players: Player[]` は `Player` 固有の API(`updatePlayerControls` / `syncPlayer`)で
使われていて、型を落とすと呼び出し側にキャストが増える。

**判断材料が足りないので保留。** `SPEC/` の「未確定の案」に、エンティティ種別が今後増えるか
(増えるなら畳む価値がある)の記述があるか確認してから決める。

---

## 論点15 — 「戦闘ビュー / マップビュー」の軸に5つの語彙

### 症状

たった2値の同じ軸に、**4つの型別名と1つの boolean** が並んでいる。

```
src/game/view-manager.ts:14        export type ViewId       = 'combat' | 'map';
src/game/view-manager.ts:22        export type WorldViewId  = 'combat' | 'map';
src/game/hud/panel-shell.ts:12     export type HudWorldView = 'combat' | 'map';
src/game/hud/windows/help-content.ts:7  export type HelpMode = 'combat' | 'map';
src/game/camera/camera-system.ts:135    private _overviewMode = false;
```

`ViewId` と `WorldViewId` は**同一ファイルの8行違いに、同一の定義**として並んでいる。
しかも同じクラスの中で両方使われている:

```ts
private worldView: WorldViewId;
get current(): ViewId { return this.worldView; }
get isMapView(): boolean  { return this.worldView === 'map'; }
get isCombatView(): boolean { return this.worldView === 'combat'; }
```

さらに `CameraSystem.setMapMode(open: boolean)` / `PlanEditor.setMapMode(open: boolean)` と、
論点13 の `overviewMode: boolean`(23モジュール)。**同じ2値に対する言い方が6つある。**

### 診断

規約 1.6「**同一の意味、同一の情報量を持つ型を複数作ること。これは重複実装である。**」と
規約 2.1「類義語の混雑。同じものを異なる言葉で指している命名」に真っ直ぐ当たる。
`isMapView` / `isCombatView` の対は規約 2.1「並列なものは両方を有標にする」を満たしているので
そこは問題ない — 問題は**型が4つあること**。

### 修正

1. `WorldView = 'combat' | 'map'` を1つだけ残す。所有者は `view-manager.ts`
   (「どのワールドビューを表示しているかの正本」とファイル先頭コメントが宣言している)。
   `ViewId` / `WorldViewId` / `HudWorldView` / `HelpMode` を全部そこへ寄せる。
   **規約 1.11 に従い、旧名は 0 件になるまで消す**(エイリアスの再エクスポートを残さない)。
2. `HelpMode` は `help-content.ts` が持つ必要が無い — ヘルプの分類は `HelpCategory`(7値)の
   ほうで、`HelpMode` はビューそのもの。
3. `overviewMode: boolean` を `WorldView` へ置き換えるかは**論点13 として保留**。
   型統合(1.)だけなら振る舞いを一切変えないので、先に単独で入れられる。

---

## 論点16 — エンティティ種別の語彙が5つ

### 症状

「その物体は何か」を表す union が5つある。

```
src/game/random-name.ts:5              ObjectType        = 'player' | 'enemy' | 'ammo' | 'fuel' | 'base'
src/game/map/visibility-policy.ts:8    DynamicEntityKind = 'player' | 'ship'  | 'ammo' | 'fuel' | 'base'
src/game/marker/marker-manager.ts:98   CombatMarkerKind  = 'self' | 'ally' | 'enemy' | 'base' | 'ammo' | 'fuel'
src/game/pickable/map-pickable.ts:5    MapPickKind       = 'body' | 'ship' | 'player' | 'apsis' | 'relnode'
                                                          | 'ammo' | 'fuel' | 'empty-space' | 'eqnode' | 'base'
src/game/dynamic/dynamic-entity/bullet.ts:26  Shooter     = 'player' | 'enemy'
```

**`ObjectType` と `DynamicEntityKind` は同じ5要素の集合で、違いは `'enemy'` と `'ship'` という
綴りだけ。** 同一の情報量を持つ型が2つある。

`CombatMarkerKind` は `'self'` / `'ally'` を分けている点だけが違う — これは
「自分か味方か」という**別の軸(視点)を種別に畳み込んだ**もので、規約 1.6
「『たまたま』同時に切り替わるフラグは別個にする」に当たる。

`ObjectType` の**定義が `random-name.ts`(ランダム命名ジェネレータ)にある。**
ゲームの物体分類を、命名の都合で作られたモジュールが所有している。

### 診断

規約 1.6 の型の重複 + 規約 2.1 の類義語の混雑 + 定義の置き場所の誤り。
値を共有しているせいで、分岐の計数もこの5つの間で混線する(検査の方法の注意を参照)。

### 修正

**論点1 と同じ PR で片付ける。** 論点1 で `MapPickable` を具象クラス化すると
`MapPickKind` は消える。残る整理は:

1. `ObjectType` と `DynamicEntityKind` を1つにする。型名は `DynamicEntityKind`
   (規約 2.2 の `celestial` / `dynamic` の対に沿う)。所有者は `dynamic-entity/` 側へ移し、
   `random-name.ts` は import する側になる。
   **値は `'enemy'` 側を採る。** `'ship'` は**敵機だけ**を指しているのに、
   同じ union の `'player'` も艦なので、名前が区別を言えていない — 規約 2.1
   「曖昧な区別。区別すべきものを同じ名前で指す命名」。実際に破綻していて、
   `physical-object-list-order.ts:93` は
   `if (this.filter === 'enemy') return item.kind === 'ship' …` と**同じものを
   2つの語で書き分けている。**
2. `CombatMarkerKind` から視点の軸(`self` / `ally`)を外し、
   「種別」+「自分か否か」の2つの値で表す。`combatMarkerKindOf(cls: string)` が
   CSS クラス名から種別を復元しているのも、**表示文字列から値を読み戻している**ので
   規約 1.6(正データの分散)に当たる。マーカー登録時に種別を値として渡す。
3. `Shooter` は残してよい。弾がどちら側から出たかは**種別ではなく所属**で、
   2値であることに意味がある(規約 1.5「自機と敵の戦闘挙動は一般化しない」)。

---

## 論点17 — `OrbitAnalysisWindow` のタブが半分だけ切り出されている

### 症状

`game/hud/orbit/orbit-analysis-window.ts`(466行)は
`AnalysisTab = 'altitude' | 'approach' | 'projection'`(3値)に対する分岐を
**9本のメソッド・約30箇所**に持っている。

```
266  if (this.tab === 'approach' && !this.approachAvailable) …
270  this.chart.element.classList.toggle('hidden', this.tab === 'projection');
271  this.projectionTab.chart.element.classList.toggle('hidden', this.tab !== 'projection');
274  if (this.tab === 'altitude') { … } else if (this.tab === 'approach' …) { … }
                                  else if (this.tab === 'projection' …) { … }
295  this.relIncRow.classList.toggle('hidden', tab !== 'approach');
296  this.yField.classList.toggle('hidden', tab === 'projection');
323  if (this.tab === 'projection') return;
331  return this.tab === 'altitude' ? 'h' : 'km';
337  if (!isScaleTab(this.tab)) return;
376  if (tab === 'altitude') { … }
430  if (this.tab === 'approach') { … }
```

`isScaleTab(tab): tab is ScaleTab` というヘルパまで生えている — **「投影タブだけ他の2つと
違う」という事実を型で言い直しただけ**で、分岐は残っている。

**そして `orbit-projection-tab.ts`(80行、単一参照)が既に存在する。** 投影タブだけが
モジュールとして切り出され、高度タブと接近タブは本体に残り、**分岐も本体に残った。**

### 診断

規約 1.2 が名指ししている形そのもの:

> **分岐の片側だけを別ファイルへ切り出しても分岐は元の場所に残る**ので、何も解決しない。

これは**ユーザーが疑った「安直に切り出しただけで構造的に整理されていない」の実例**であり、
同時に「切り出したせいでモジュールが1本増えた」例でもある。

### 修正

3つのタブを対等な具象にする。共通の口は:

```ts
interface AnalysisTabView {
  readonly id: AnalysisTab;
  readonly label: string;
  readonly element: HTMLElement;          // チャート本体
  available(game: Game): boolean;         // タブバーに出すか
  scaleFields(): ScaleFieldSpec | null;   // Y/X の入力欄。投影タブは null
  draw(game: Game, …): void;
  dispose(): void;
}
```

- `AltitudeTab` / `ApproachTab` / `ProjectionTab`(既存の `OrbitProjectionTab` が原型)。
- `isScaleTab` は `scaleFields() !== null` に置き換わって消える。
- `OrbitAnalysisWindow` は**タブの列を持ち、選択されたものへ委譲するだけ**になる。
- `orbit-chart.ts`(211) / `orbit-projection-chart.ts`(249) / `orbit-analysis-data.ts`(228)は
  そのまま各タブの下請けとして残る。

466行 → 200前後 + タブ3本。**ファイル数は増えるが、`orbit-projection-tab.ts` が
「なぜこれだけ外にあるのか」を説明できない現状より良い。**

---

## 論点18 — `Player` / `Base` を消費側が `instanceof` で判別し直している

### 症状

`instanceof` の出現をクラス別に数えると、`Player`(16)と `Base`(13)が突出している。
両者は `Controllable` を実装する対だが、**消費側が26箇所で型を判別し直している。**

| モジュール | 箇所 |
| --- | --- |
| `hud/panels/vessel-panel.ts` | 8 |
| `hud/windows/resource-transfer-dialog.ts` | 5 |
| `docking/docking.ts` | 3 |
| `targeter.ts` / `pickable/map-context-actions.ts` | 各2 |
| `pickable/combat-pickable.ts` / `hud/orbit/orbit-panel.ts` / `dynamic/entity-contact-response.ts` / `dynamic-entity/debris-piece.ts` / `dynamic-entity/bullet.ts` / `camera/combat-camera-system.ts` | 各1 |

`vessel-panel.ts` の `sync`(98行)が典型で、同じ1つのパネルを描くために8回判別する:

```ts
const throttleObj = target instanceof Player ? target : (target instanceof Base ? target : null);
const hasQdyn = target instanceof Player;                       // 動圧は Player だけ
const fineAtt = target instanceof Player ? target.fineAttitude : false;
if (target instanceof Player) { currentFuel = target.totalFuel; … }
else if (target instanceof Base) { currentFuel = target.fuel; … }
if (target instanceof Player) { ammo.textContent = fmtAmmoStatus(…); }
else if (target instanceof Base) { ammo.textContent = `Fuel: …`; }
```

`target-panel.ts` はさらに露骨で、`target instanceof Ship ? target.hp : BASE_ARMOR_PLACEHOLDER`
— **型が合わないので定数で埋めている。**

原因は `Controllable`(24行)が公開しているのが 13 メンバーだけで、
`fuel` / `maxFuel` / `hp` / 状態読み値を含まないこと。

### 診断

規約 1.3:

> **検出側やオーケストレータで当事者の型を分岐するコードは、この境界が破れているサインである。**

規約 1.6「多態を保存し、復元する」と同じ発想で、**当事者が自分の分を答えるべき。**

### 修正

`Hud` が既に `BurnManagementViewModel` でこの形を持っている
(`game.player?.boosterManagementViewModel()` — HUD は `Player` 型を知らない)。同じ形に揃える。

1. `Controllable` に `vesselStatus(): VesselStatusView` を足し、`Player` と `Base` が
   それぞれ自分の燃料・弾薬(または燃料)・動圧の有無・微調整状態を詰めて返す。
   **「動圧を持たない」は `qdyn: number | null` で表す**(規約 1.6「不在は `T | null`」)。
   `BASE_ARMOR_PLACEHOLDER` のようなダミー値は消す。
2. `resource-transfer-dialog.ts` の5箇所も同じ経路にする。
3. `docking.ts` / `entity-contact-response.ts` の `instanceof Base` は**接触の帰結**を
   見ているので別件。規約 1.3「a と b の接触の帰結は a と b の責務」に照らして
   別途見る(この文書では扱わない)。

### 注意

規約 1.5 が「**自機と敵の戦闘挙動は一般化しない**」と決めているが、**これは `Player` と
`Base` の話で、しかも表示だけなので抵触しない。** 戦闘挙動(射撃・散布界・被弾判定)には
触れないこと。

---

## 論点19 — その他の重複 union

型別名を全部集めた副産物。どれも規約 1.6「同一の意味、同一の情報量を持つ型を複数作ること」。

| 重複 | 場所 | 修正 |
| --- | --- | --- |
| `CollinearPoint` = `GuidePoint` = `'L1' \| 'L2' \| 'L3'` | `physics/halo.ts:19` / `physics/orbit-guide.ts:18` | 1つに。`LagrangeLabel`(`physics/zero-velocity.ts:8`、5値)との関係を `Extract` で表す |
| `FixedDurationKey` ⊂ `DisplayDurationKey` | `hud/panels/predict-panel.ts:14` / `display-window-manager.ts:22` | `Exclude<DisplayDurationKey, 'custom'>` にする。値を書き写さない |

`EphemerisScale`(`'TT' | 'TDB'`)⊂ `TimeScale`(`'UTC' | 'TT' | 'TDB'`)は**畳まない。**
`JulianDate<EphemerisScale>` のように**型引数の制約**として使われていて、
「この口は UTC を受け取らない」という主張そのもの。値の写しではない。

`SolarSide` = `RadiatorSide` = `'up' \| 'down'`(`player/power.ts:11` / `player/radiator.ts:24`)は
**畳まない。** 太陽電池の面と放熱板の面は別の部品で、片方だけ枚数が変わりうる。
値が一致しているのは偶然で、規約 1.6 の「たまたま同時に切り替わるものは別個にする」に従う。

---

## 論点20 — `MapCamera` の2つの非 on/off 2分(要検討)

`game/camera/map-camera.ts`(ファイル625行、`MapCamera` クラス531行・36メソッド)は
2値の union を2本持っている。

| フィールド | 型 | 分岐 |
| --- | --- | --- |
| `projectionMode` | `ProjectionMode = 'perspective' \| 'orthographic'` | 8 |
| `rotationMode` | `CameraRotationMode = 'quaternion' \| 'euler'` | 4 |

どちらも on/off ではなく「**2つの違うやり方のどちらか**」。とくに `rotationMode` は
ドラッグ処理(508行・532行)で**別々の積分方式**に分かれる。
`perspectiveCamera` と `orthographicCamera` の実体も両方保持している。

### 判断が要る点

- 投影方式は THREE の2クラスに対応しているので、**両方保持すること自体は避けにくい。**
  分岐8箇所のうち「どちらのカメラを返すか」は1箇所に閉じているので、実質の分岐は
  ズーム操作(522-525)と縮尺計算(578)。**大きくはない。**
- `rotationMode` のほうが本命。回転の積分だけを2つの実装に分けられるなら、
  `MapCamera` から 100 行前後が抜ける。
- **625行のうちどれだけが実際に片方だけの経路か**を測ってから決める。
  この文書の時点では測っていない。

**優先度は低い。** 論点1〜4 を終えてから測り直す。

---

## 分割が正しいと判定したもの(再検討しないための記録)

作業中に「単一参照」「短い」で引っかかるが、**触ってはいけない**もの。

| 対象 | 行数 | 残す理由 |
| --- | --- | --- |
| `hud/widgets/index.ts` / `hud/windows/index.ts` | 21 / 16 | 規約 1.12 が認める「公開境界として意図的に設計したディレクトリ」のバレル。widgets は 45 モジュールから参照されている |
| `hud/widgets/*`(index.ts を除く15枚, 13〜102行) | 835 | 各々が再利用される UI 部品。バレル越しなので参照数が1に見えるだけ |
| `dynamic-entity/enemy-dictionary.ts` | 13 | 規約 1.6「クラス辞書は独立したモジュールに置く」。基底へ入れると実行時循環で落ちる |
| `render/radiator-hinge.ts` / `render/rcs-nozzles.ts` | 4 / 20 | `tools/export-models.mjs` が TypeScript のまま単体で transpile する。import を持てない |
| `hud/windows/property-window-{rows,related-items,rename,items}.ts` | 156/110/67/63 | 各々が自分の DOM 要素と差分状態(`lastItemsKey` 等)を持つ。合成であって切り出しではない |
| `marker/crowding.ts` | 31 | 3モジュールから参照される実責務。引数が多いのはホットパスの意図的な選択で、コメントに理由がある |
| `player/aero-load.ts` / `altitude-alarm.ts` / `reentry-effects.ts` / `player-markers.ts` | 41/67/56/69 | いずれも自分の状態(動圧・EMA・ビルボード・マーカーキー)を持つ |
| `render/pipeline/sun-occlusion-select.ts` / `lighting/planet-light-select.ts` | 78/62 | 「このフレームに何を光源/遮蔽器として扱うか」という独立した判断。参照元が `celestial-system.ts` 1つでも責務がある |
| `dynamic-entity/debris-piece.ts` の `DebrisKind` | 192 | `kind` で切り替わるのはメッシュ・材質・寿命・効果音の**値**が中心。6具象へ割ると責務の無いクラスが6つ増える。規約 1.2 の第3分類「そのままでよい」 |
| `celestialClassVisible` 等の `CelestialClass` switch | — | 規約 1.8 が明示的に許可(分類が3種で閉じているという主張そのもの) |
| `hud/hud.ts` | 155 | パネル群の所有と DOM ルートの切替。パネルが単一参照なのは所有関係であって切り出しではない |
| `game/game.ts` | 638 | 500行超だが中身はオーケストレーション(規約 1.2 が `game.ts` に許している唯一のもの) |
| `hud/{map-scale,layout,sync-throttle}.ts` | 39/19/17 | DOM 非依存の純関数/状態。複数から参照されている |

第2次走査(分岐の形で探した分)で引っかかったが、**正しい形だったもの**。

| 対象 | 形 | 残す理由 |
| --- | --- | --- |
| `WaveState`(3値、`stage-utils/wave-attack.ts`) | 3値 union | **ディスパッチが1箇所**(`update` が3本の phase メソッドへ振るだけ)で、遷移も1クラスに閉じている。**3値 union の正しい形の見本。** 78行 |
| `ProteinPhase`(4値、`protein/protein-schema.ts`) | 4値 union | `recomputePhase` の1箇所でだけ決まり、他モジュールはデータとして読むだけ。振る舞いが切り替わっていない |
| `visible: boolean`(22モジュールの署名) | boolean | 純粋な on/off。「出す/出さない」以上のことを言っていない |
| `RenderStyle`(`'realistic' \| 'schematic'`、23モジュール) | 2値 union | 分岐は12モジュールに散るが**各所1〜2箇所**で、いずれも局所的な値の選択(色・線種)。振る舞いを分けていない |
| `instanceof OrbitingMotion`(13箇所) | 型の絞り込み | 8箇所が `if (!(x instanceof OrbitingMotion)) return/throw` のガードで、**能力の有無**を絞っている。`instanceof Player`/`Base` と違い、分岐の先で別の振る舞いを書いていない |
| `CelestialClass`(5値)/ `CelestialKind`(3値) | 分類 union | 規約 1.8 が明示的に許可。分類が閉じているという主張そのもの。粒度が違うので2つあってよい |
| `SolarSide` / `RadiatorSide`(ともに `'up' \| 'down'`) | 値が一致 | 別部品。片方だけ枚数が変わりうるので畳まない(論点19 参照) |
| `MenuAction`(22値) | 22値 union | メニュー項目の識別子。`map-pickable-menu` の30箇所は**項目ごとの処理**であって、同じ処理が種別で分岐しているのではない。論点1 で具象へ分配される |

---

## 実施順序

**論点1 を先にやる。** 論点7 の `bodyPickables` と論点13 の一部が論点1 に依存していて、
先に他所を触ると二度手間になる。

1. **型の重複を先に潰す** — **論点15**(ビューの型4本→1本)/ **論点19**(`L1..L3` 等)。
   **振る舞いを一切変えない改名なので、単独で安全に入る。** 規約 1.11 に従い旧名を 0 件にする。
   論点13 と論点17 の議論は、型が1本になってからのほうが早い。
2. **論点12**(`partFromSaveData`)と **論点11**(`view-hud-controller`)—
   それぞれ 10 分程度。独立していて、他に一切影響しない。
3. **論点1 + 論点16**(`MapPickable` の多態化と種別語彙の統合)— 最大。1つの PR で丸ごと。
   `pickable/` に加えて `hud/object-groups.ts` と `hud/panels/physical-object-list-*.ts`、
   `ObjectType` / `DynamicEntityKind` / `CombatMarkerKind` の整理まで含める。
   **`MapPickKind` が消えるので、論点16 を別 PR にすると二度手間になる。**
4. ~~**論点2**(BVH の重複)~~ — **実施済。**
5. **論点3**(`base-station-model`)と **論点4**(`const.ts`)— どちらも機械的。並行できる。
6. **論点18**(`Player`/`Base` の `instanceof`)— 論点1 の後。
   `vessel-panel` / `resource-transfer-dialog` / `target-panel` をまとめて。
7. **論点7**(`focus-markers`)— 論点1 の後。
8. **論点6**(`marker-manager`)— 論点7 と同時に、ラベル混雑3実装の統合可否を1回で決める。
9. **論点17**(軌道分析タブの多態化)/ **論点8**(`PlayerBoosters`)/
   **論点5**(`hud/style/`)/ **論点10**(入力行)— 独立。手が空いたときに。
10. **論点9**(`plan-editor`)— `plan/` 全体を見るときに。
11. **論点13 / 14 / 20** — 方針をユーザーへ問うてから。論点20 は先に実測が要る。

各段階の検証は変更箇所に対応させる(`npm run typecheck` は常に。`src/game/` を触ったら
`npm run test:game`、`src/physics/`・`src/math/` を触ったら該当層)。**main へ送る前は
必ず `npm run test` を全層回す。**

論点1・7 は画面に出るものが変わるので、**`/verify` か実機での目視を挟む**
(マップの右クリックメニュー・プロパティウィンドウ・物体一覧・天体ラベルの間引き)。

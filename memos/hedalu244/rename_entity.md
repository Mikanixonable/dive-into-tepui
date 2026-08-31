# `entity` の用法 — 実態調査と是正計画

前身は `rename_entity_body.md`(`body` と `entity` を1つの計画で扱っていたもの)。**独立に通せる
2つの問題だったので分割した。`body` 側は `rename_body.md`。** 両者が対になっていて同時に
通す必要のある識別子は **3.6** に一覧する。

**この計画を先に通す**(確定)。`rename_body.md` は案A / 案B が未決で、しかも案B
(`CelestialMotion` → `CelestialBody`)を採ると `celestialBodies` の隣に無標の `entities`
(= `DynamicSystem`)が並び、**まさにこの計画が消したい「`body` = 天体 / `entity` = ゲーム個体」
という誤った軸に見える。** こちらを先に通せば、どちらの案を採っても対は
`celestial` / `dynamic` の軸に収まる。

**この計画は CODING-RULE を変えない。** 是正対象はすべて**いま書かれている `entity` 節から
コードが逸脱しているだけ**で、規約側に足すべき記述は無い(1.6)。

**背景。** いまの対立軸は **`celestial` / `dynamic`**。歴史的にはゲーム個体側が `GameEntity` と
呼ばれ、**天体側の `CelestialBody` と対にして `body` / `entity` へ略されていた時期がある。**
`GameEntity` は `DynamicEntity` へ改名済みだが、**その時期の語だけが識別子に残っている。**
**挙動は一切変えない。**

**`entity` は `body` と違って、正しい用法のほうが多い。** CODING-RULE 2.2 は
「`entity` は物体ひとつの動きと見た目を統合するもの」と定めていて、`DynamicEntity` と
`CelestialEntity` はどちらもこれに適合している。**問題はその定義に合わないものが `entity` を
名乗っていることと、族をまたぐ場所で無標のまま使われていること**の2点だけ。

以下の件数はすべて **`980b7929`**(`refactor_celestial_set.md` 実施後)時点のコードから
実測したもの(`tests/dist/` は除外)。**維持しない** — 着手時に測り直す。

---

# 第1部 実態調査

## 1.1 `entity` の当たり

| # | 意味 | 代表 | 行 | 判定 |
| --- | --- | --- | --- | --- |
| a | **積分で動く個体**(有標) | `DynamicEntity` 179 / `DynamicEntityKind` 5 | **184** | **正しい。据置** |
| b | **天体の見た目付き**(有標) | `CelestialEntity` 38 / `SphereEntity` / `PointEntity` / `StarEntity` | **171** | **正しい。据置** |
| c | **`DynamicSystem` の別名** | `entities: DynamicSystem` **57 箇所 / 31 ファイル** | **57** | **落とす。型名の不一致**(1.2) |
| d | **`DynamicEntity` の無標** | `EntityContact*` 17 / `collideWithEntity` 15 / `EntityIdAllocator` 15 / `entity: DynamicEntity` 15 / `EntityLineManager`・`entityLines` 13 / `entityStateAt` 11 / `EntitySaveData` 8 | **97** | **個別判断**(1.3・規範2)。**うち約 51 行を改名、残り約 46 行は据置** |
| e | **`CelestialEntity` の無標** | `entityOf` 23 / `entitiesById` / `CelestialSystem.entities` / `centerEntity` / `originEntity` / `starEntity` / `readerEntity` | **55** | **据置(族が自明)**(規範2) |
| f | **物一般(celestial ∪ dynamic ∪ 物でないもの)** | `ENTITY_GLYPH` 30 / `ENTITY_ROWS` 2 | **32** | **`ENTITY_ROWS` は落とす。`ENTITY_GLYPH` は保留**(1.3) |
| g | **mmCIF の entity** | `backboneEntities` / `ProteinComponentDefinition.entities` / `extract-structure.py` | **11** | **据置。別ドメインの定訳かつ生成アセットのキー**(1.5) |
| h | **`identity`** | `identity` / `identityAttitude` | 15 | 別語 |

**是正対象は約 120 行**(c 57 + d の改名分 51 + `ENTITY_ROWS` 2 + `OrbitAnalysisTarget` の
ユニオン 6 + テストファイル1件)。**残る約 490 行は据置。**

**`bodyEntityGlyph`(両方の語が付いた1語)は `rename_body.md` の担当**(3.6)。

## 1.2 `entities: DynamicSystem` — 57 箇所・31 ファイルの型名不一致

**`DynamicSystem` を受け取る引数・フィールドの名前が、ほぼ全部 `entities`。**
`stages/stage.ts:62,162,242,249,254,262,264`(**Stage の抽象契約そのもの**)、
`stage0.ts` / `stage00.ts` / `stage1.ts` / `stage2.ts` / `stage-debug*.ts` /
`stage-utils/logistics.ts:41`、`nav-target.ts`(6箇所)、`player/player.ts`(4)・
`player/player-fire.ts`(4)、`pickable/` 6ファイル、`targeter.ts`(2)、
`docking/docking.ts:74` / `docking-guide.ts:42`、`vfx/effects-system.ts:32`、
`dynamic/simulator.ts` / `predictor.ts` / `next-event-time.ts` / `nan-watchdog.ts`、
`orbit-reference.ts:52`、`active-controllable-controller.ts:20`、
`lines/entity-line-manager.ts:43`。

**これは「系」を「配列」の名前で呼んでいる。** `DynamicSystem` は配列を持つが、それ自体は
`addEnemy` / `spawnEnemyWhenReady` / `getCombatTargets` / `findPlayer` を持つ管理者で、
`entities.players` / `entities.enemies` / `entities.bases` と**中の配列を名前で持っている。**
`this.entities.addAmmoPickup(...)` は「エンティティ列が補給物を足す」と読める。

**さらに `CelestialSystem.entities`(`readonly CelestialEntity[]`)と直接ぶつかっている。**
両方が同じファイルに出てくるのが **8 ファイル**:
`camera/focus-markers.ts` / `celestial/celestial-system.ts` / `creative/orbit-form-fields.ts` /
`hud/object-groups.ts` / `nav-target.ts` / `pickable/line-pickables.ts` /
`pickable/map-context-actions.ts` / `stages/creative-stage.ts`。

```ts
// src/game/pickable/line-pickables.ts — 同じクラスの中で
private readonly entities: DynamicSystem,          // ← 27 行目
this.celestialSystem.entityOf(secondary).motion    // ← 62 行目(CelestialEntity)
```

**受け皿は既に決まっている。** `Game` は最初からこれを `dynamicSystem` と呼んでいる
(`game.ts:100` の `readonly dynamicSystem: DynamicSystem`)。**`dynamicSystem` の当たりは
既に 57 行あり、`entities: DynamicSystem` と同数。** つまり同じ値が**トップで
`dynamicSystem`、下位で `entities`** と呼ばれていて、この計画は**既存の名前を下へ広げるだけ。**

**`dynamics` は使えない** — `src/physics/dynamics.ts`(力学。`stepDynamics` / `j2Accel`)と
衝突する。

## 1.3 `entity` を名乗っているが「動きと見た目の統合」ではないもの

| 何 | 中身 | 現行 CODING-RULE のどこから外れるか |
| --- | --- | --- |
| **`EntityIdAllocator`**(`dynamic/dynamic-entity/entity-id.ts`) | `${prefix}${連番}` を発番する接頭辞付きカウンタ。`next(restoredId?)` だけ | **物体を1つも持たない。** `booster-` の採番にも使われ(`player/booster-id.ts`)、そこは**分離前の段**でまだエンティティですらない。`creative-player-` / `creative-ammo-` / `creative-rcs-fuel-` も同様 |
| **`EntitySaveData`**(`save/save-data.ts:22`) | `id` / `name` / `kind` / `r` / `v` / `q` / `w` の直列化レコード | **「動きだけを扱うもの」そのもの。** 現行規約が名指しで禁じている形 |
| **`ENTITY_GLYPH`**(`marker/marker-glyphs.ts:8-20`) | 字形の表。`ship` / `base` / `ammo` / `fuel` と `body` / `star` / `satellite` / **`lagrange`** / **`ghost`** / **`preview`** | **「見た目だけを扱うもの」そのもの。** これも名指しで禁じられている。加えて `lagrange` / `ghost` / `preview` は物体ですらない |
| **`ENTITY_ROWS`**(`hud/panels/view-options-panel.ts:90`) | 自艦・敵・弾薬・RCS燃料・基地の表示トグル行 | **物体ひとつではない**(種別の表)。しかも中身は**ちょうど dynamic の全種別**で、UI の見出しも既に「機体と設備」(`:261`) |
| **`EntityContactPhysics` / `entityContactResponse`** | 剛体接触の列挙・解決 | 当事者はエンティティだが、**モジュール自身は接触の物理。** ただし `src/game/dynamic/` の中なので無標であること自体は規範2 に適合 → **据置** |

### `ENTITY_GLYPH` だけは保留する

**`ENTITY_ROWS` は中身がちょうど dynamic の全種別なので `DYNAMIC_KIND_ROWS` で片が付く。**
一方 **`ENTITY_GLYPH` は celestial と dynamic と「物でないもの」をまたぐ総称**で、改名するには
**その総称を何と呼ぶかを決める必要がある。**

**既存の `PhysicalObject`(`hud/panels/physical-object-list-*.ts`)は使わない。**
あれ自身が悪い命名で(空クリック・ラグランジュ点という `Physical` でも `Object` でもないものを
指している)、**別件で是正する。本件では扱わず、利用範囲も広げない。**

**`OBJECT_GLYPH` のような素の総称も同じ問題を引き継ぐ**(`lagrange` / `ghost` / `preview` は
object ではない)。**したがって `ENTITY_GLYPH` の改名は `PhysicalObject` の是正計画へ送る**
— 総称の語が決まってから同じ語で名付ける。**この計画では触らない**(3.5)。

## 1.4 `entity` 側が無標のままになっている対

CODING-RULE 2.1 は**「並列なものは両方を有標にする」**と定めている。旧 `body` / `entity` の対が
残っている箇所は、**天体側が過剰に有標で、ゲーム個体側が無標**という形でこの規則に反している。
**ここに挙げるのは `entity` 側の半分だけで、対になる `body` 側は `rename_body.md` が扱う**
(対応表は 3.6)。

**(1) 判別可能ユニオン** — `hud/orbit/orbit-analysis-data.ts:38-39`:

```ts
| { readonly kind: 'entity'; readonly entity: DynamicEntity }
| { readonly kind: 'celestialBody'; readonly body: CelestialMotion };
```

`'entity'` と `entity` がこの計画の担当。**同じファイルの 67 行目には
`const centerEntity = celestialSystem.entityOf(center.id)` があり、`entity`(ゲーム個体)と
`centerEntity`(天体)が同じ語で別の族を指している** — このファイルの中では
`entity` が両方の族に掛かっている。

**(2) メソッドの対** — `dynamic-entity/dynamic-entity.ts:615,619`:

```ts
collideWithEntity(_other: DynamicEntity, _contact: Contact, _activeStage: Stage): void
collideWithCelestialBody(_body: CelestialMotion, _contact: Contact, _activeStage: Stage): void
```

**(3) HUD の表** — `hud/panels/view-options-panel.ts:68,75,90`:

```ts
const BODY_CLASS_ROWS: readonly BodyClassRow[] = [ 惑星, 衛星, 準惑星, 小天体, ラグランジュ点 ];
const ENTITY_ROWS:     readonly BodyClassRow[] = [ 自艦, 敵, 弾薬, RCS燃料, 基地 ];
```

この計画は `ENTITY_ROWS` を担当する。**共有している型 `BodyClassRow` の改名は
`rename_body.md`**(どちらの族にも寄らない `MapDisplayRow` にする)。
**同じ2群を出す UI の見出しは既に「天体」/「機体と設備」**(`:260-261`)で、
**日本語のほうは `body` / `entity` の対を使っていない。**

## 1.5 触れない `entity` — protein の mmCIF entity

PDB/mmCIF の `_entity` は「1つの分子種(ポリマー鎖・リガンド・水)」を指す**標準語**で、
このゲームの `entity` とは無関係。しかも**値が焼き込まれている:**

- `src/assets/models/*Backbone.json` の **`backboneEntities`**(`tools/protein-builder/
  extract-backbone.py:92` が書き、`render/protein-ribbon-color.ts:72` が読む)
- `ProteinComponentDefinition.entities`(`game/protein/protein-schema.ts:9`、
  `extract-structure.py:70` が書く)

**作り直すと CLAUDE.md のとおり全アセットの識別子が振り直される。据置。**

## 1.6 コードが現 CODING-RULE から逸脱しているだけで、規約側は直さない

**`entity` 節の記述は正しく、足すべきものは無い。** 1.3 の5件はすべて**いまの2文から導ける。**

> `entity` は「物体ひとつの動きと見た目を統合するもの」。
> **動きだけを扱うもの、見た目だけを扱うものに `entity` を付けない。**

| 逸脱 | どの語に反するか |
| --- | --- |
| `entities: DynamicSystem` | **「物体ひとつ」ではない**(集合) |
| `EntityIdAllocator` | **物体を持たない**(文字列の発番) |
| `EntitySaveData` | **「動きだけを扱うもの」**(名指しで禁止) |
| `ENTITY_GLYPH` | **「見た目だけを扱うもの」**(名指しで禁止) |
| `ENTITY_ROWS` | **「物体ひとつ」ではない**(種別の表) |
| `collideWithEntity` / `'entity'` ユニオン | 2.1「並列なものは両方を有標にする」 |

**したがって CODING-RULE の変更は無い。** この計画は**規約に追いつく作業だけ**で構成される。

---

# 第2部 決めたこと

## 2.1 規範

**どれも CODING-RULE へは記録しない**(1.6 のとおり既存の記述から出る帰結)。
判断の基準としてだけ使う。

1. **`entity` の定義に合わないものから語を落とす。** 現行の2文から出る帰結として、
   **集合・id の採番・保存レコード・字形の表**は `entity` ではない(1.3)。

2. **無標の `entity` / `celestial` は、族がスコープから自明なときに限る。**
   - `src/game/dynamic/` の中、`DynamicEntity` のメソッド、`CelestialSystem` のメソッド
     → **無標可。**
   - 族をまたぐファイル(1.2 の8ファイル、1.4 の3箇所)→ **両方を有標にする。**
   - **無標 `entity` を機械的に `dynamic` へ置換しない。** `Dynamic` 単体では「動きと見た目の
     統合体」という意味が落ちる語(`DynamicSaveData` など)があり、逆に `dynamic/` の中では
     `Dynamic` を足しても情報が増えない。

3. **`DynamicSystem` を受ける名前は `dynamicSystem`。** 新しく決めるのではなく
   **`Game.dynamicSystem` を下へ広げる**(1.2)。`dynamics` は `src/physics/dynamics.ts`
   (力学)と衝突するので使わない。

4. **`EntityIdAllocator` は族語を足すのではなく落とす。** 実装がどの族にも限定されていない
   (1.3)ので、CODING-RULE 2.2 の
   「**どの族にも限定されないものには族語を付けない**」がそのまま当たる。`IdAllocator`。

5. **総称が要る場所は、この計画では触らない。** `ENTITY_GLYPH` は celestial ∪ dynamic ∪
   物でないものをまたぐので、**総称の語が決まるまで保留**(1.3)。**`PhysicalObject` は
   使わない・広げない** — あれ自身が別件の是正対象。

6. **protein の `entity` は別ドメインの定訳かつ生成アセットのキー。据置**(1.5)。

**覆された場合**: 1 が覆ると手順2 のほぼ全部が変わる。2 が覆ると手順1・2 の範囲が変わる。
4 が覆ると `DynamicIdAllocator` になる(手順2 の1行だけ)。
5 が覆る(= 総称を先に決める)なら `ENTITY_GLYPH` 30 行が手順2 へ戻る。

## 2.2 適用後の名前

| 現 | 案 | 行 |
| --- | --- | --- |
| `entities: DynamicSystem`(引数・フィールド) | **`dynamicSystem`**(規範3) | 57 |
| `collideWithEntity` | **`collideWithDynamic`**(対は 3.6) | 15 |
| `orbit-analysis-data.ts` の `kind: 'entity'` / `entity` | **`'dynamic'` / `dynamic`**(対は 3.6) | 6 |
| `EntityIdAllocator` / `dynamic/dynamic-entity/entity-id.ts` | **`IdAllocator` / `id-allocator.ts`**(規範4)。**`'entity-'` / `'booster-'` などの接頭辞の値は据置** — セーブに載る id そのもの。置き場所も `dynamic-entity/` から出す(どの族にも属さない) | 15 + 移動1 |
| `EntitySaveData` | **`DynamicEntitySaveData`** — ワイヤキーではなく型名なので自由。`PlayerSaveData` / `EnemySaveData` / `DetachedBoosterSaveData` / `AmmoPickupSaveData` / `RcsFuelPickupSaveData` の基底 | 8 |
| `EntityLineManager` / `lines/entity-line-manager.ts` / `entityLines` | **`DynamicLineManager` / `dynamic-line-manager.ts` / `dynamicLines`** — `src/game/lines/` にあり族が自明でない(`DynamicEntity` / `DynamicSystem` / `Player` だけを受ける)。ファイル内の局所関数 `applyEntityLines` も追従 | 13 |
| `ENTITY_ROWS` | **`DYNAMIC_KIND_ROWS`**(型 `BodyClassRow` の改名は 3.6) | 2 |
| `tests/render/game-entity-dispose.test.ts` | **`dispose-owned-render-resources.test.ts`** — 中身は `disposeOwnedRenderResources` の検査で、エンティティを触らない。`tests/run.ts` は `*.test.js` を自動収集するので登録表の追従は不要 | 移動1 |
| **`ENTITY_GLYPH`** | **保留**(規範5)。総称の語が決まってから | 30 |
| `entityStateAt` / `dynamic/entity-state-at.ts` / `EntityContactPhysics` / `entityContactResponse` / `dynamic/entity-contact-*.ts` / `contactEntitiesScratch` / `cachedOtherEntities` / `cachedAllEntities` / `otherEntities` / `resolveEntityContacts` / `canResolveEntityContacts` | **据置**(規範2 — すべて `src/game/dynamic/` の中で、族が自明) | 約 46 |
| `CelestialSystem.entities` / `entityOf` / `entitiesById` / `centerEntity` / `originEntity` / `starEntity` / `readerEntity` | **据置**(規範2) | 55 |
| `SphereEntity` / `PointEntity` / `StarEntity` | **据置** — 参照は `src/game/celestial/` と `src/game/stages/` だけで、`CelestialEntity` の派生であることが継承で立っている | (b に含む) |
| `resource-transfer-dialog.ts` の `entityB`(対は `shipA: Player`) | **据置。** `hud/windows/` にあり族が自明でないので規範2 の境界だが、**`dynamicB` は読めず、この画面に天体は出ない。** 判断を記録だけしておく | 4 |
| `backboneEntities` / protein の `entities` | **据置**(規範6) | 11 |
| `mapEntityVisible`(`base.ts` の局所)/ `activeControllableEntity` / `hitEntity` / `bestEntity` / `targetEntity` / `fallbackEntity` / `entityToPickable` / `pickCombatEntityAtPoint` | **据置**(狭いスコープ、または `DynamicEntity` を返すことが呼び出し側で自明) | 約 25 |

---

# 第3部 実施

## 3.1 手順

**CODING-RULE を触る手順は無い**(1.6)。

1. **`entities: DynamicSystem` → `dynamicSystem`**(57 箇所・31 ファイル)。
   **`stages/stage.ts` の抽象契約から先に** — `update` / `init` の署名が全ステージへ波及する。
2. **`entity` の個別是正**(2.2 の表の上から 8 行目まで)。
   `collideWithEntity` / `orbit-analysis-data.ts` のユニオン / `EntityIdAllocator` /
   `EntitySaveData` / `EntityLineManager` / `ENTITY_ROWS` / テストファイル1件の改名。
3. **日本語コメントの追従。** 「エンティティ」はそのままでよい(定義に適合する語)が、
   **手順1〜2 で触ったファイルのコメントを同じ commit で揃える。** とくに
   `vfx/effects-system.ts:24,28,180` は本文中で `entities` を `DynamicSystem` の意味で使っている。

**手順1 と手順2 は独立で、並行できる。**

## 3.2 達成目標

1. `grep -rn "entities: DynamicSystem" src/ tests/` が **0 件**。
2. `grep -rniE "\bentit(y|ies)\b" src/` の当たりが、**`DynamicEntity` / `CelestialEntity` と
   その派生・`src/game/dynamic/` 内の無標・`CelestialSystem` の無標・protein の mmCIF entity・
   `ENTITY_GLYPH`(保留)** だけ。
   **`ENTITY_ROWS` / `EntityIdAllocator` / `EntitySaveData` / `EntityLineManager` /
   `collideWithEntity` が消えている。**
3. **`collideWithDynamic` が存在する**(対の `collideWithCelestial` は `rename_body.md`)。
   `orbit-analysis-data.ts` のユニオンのゲーム個体側が `'dynamic'` になっている。
4. **`DEVELOP/CODING-RULE.md` に `git diff` が出ない。**
5. **既存セーブが復元できる** — `EntityIdAllocator` に渡す接頭辞の値
   (`'entity-'` / `'booster-'` / `'ammo-'` / `'base-'` / `'rcs-fuel-'` / `'creative-*'`)と
   `EntitySaveData` の**フィールド名**(`id` / `name` / `kind` / `r` / `v` / `q` / `w`)が
   変わっていない。
6. `src/assets/models/*Backbone.json` に `git diff` が出ない(`backboneEntities` 未変更)。
7. `npm run typecheck` と `npm run test`(全層)が通る。

## 3.3 見積り

| 手順 | 触る行 | 根拠 |
| --- | --- | --- |
| 1 | 約 60 / 31 ファイル | `entities: DynamicSystem` 57 + 参照の追従 |
| 2 | 約 60 | `collideWithEntity` 15 + `EntityIdAllocator` 15 + `EntityLineManager` 13 + `EntitySaveData` 8 + ユニオン 6 + `ENTITY_ROWS` 2 + 移動2 と import 追従 |
| 3 | 約 20 | 触ったファイルのコメント |

**合計約 140 行。`rename_body.md` の 1/5 以下。** 判断の要る箇所(据置か改名か)のほうが多い。

## 3.4 リスクと落とし穴

| リスク | 影響 | どこで露見するか |
| --- | --- | --- |
| **生成アセットを巻き込む**(`backboneEntities` / protein の `entities`) | `src/assets/models/*Backbone.json` と読み手がずれる。作り直すと**全アセットの識別子が振り直される** | 手順2。`src/game/protein/` / `src/render/protein-*.ts` / `tools/protein-builder/` を置換範囲から**外す**。達成目標6 |
| `entities` は protein・`CelestialSystem`・`DynamicSystem` の3つに掛かる | 一括置換が3つを同時に壊す | 手順1。**`entities: DynamicSystem` という型注釈付きの形だけ**を起点に、その識別子の参照を追う |
| `entity` を `dynamic` へ機械置換 | `dynamic/` の中では情報が増えず、`DynamicSaveData` では意味が落ちる(規範2) | 手順2。**2.2 の表に挙げた識別子だけ**を触る |
| `EntityIdAllocator('entity-')` の**接頭辞の値** | エンティティ id は `EntitySaveData.id` としてセーブに載る。値を変えると旧セーブの id と衝突しうる | 手順2。**クラス名とファイル名だけを変え、値は据置。** 達成目標5 |
| `EntitySaveData` の**フィールド名** | `GameSaveData` の `players` / `enemies` / `ammoPickups` / `detachedBoosters` が持つレコードのキー。旧セーブが読めなくなる | 手順2。**型名だけを変える。** 達成目標5 |
| `entity` は `identity` / `identityAttitude` の部分文字列(15 行) | 単語境界を見ない置換が姿勢の計算を壊す | 手順1・2。`\b` 付きで当たること |
| `stages/stage.ts` の抽象契約を変えると全ステージが動く | `stage0` / `stage00` / `stage1` / `stage2` / `stage-debug*` / `creative-stage` / `stage-utils/logistics` が同時に落ちる | 手順1。**先に契約側を変え、typecheck の赤を辿って追従する**(この順なら漏れない) |
| `ENTITY_ROWS` は型 `BodyClassRow` を参照している | `rename_body.md` が同じ行に触る | 手順2。3.6 のとおり **この計画を先に通す**ので、`rename_body.md` 側が追従する |
| `ENTITY_GLYPH` を「ついでに」巻き込む | 総称の語が決まっていないので、後で二度改名になる | 手順2。規範5。達成目標2 が明示的に許す |
| コメントを別 commit で直す | 識別子と対応が取れないまま残る | 手順3 ではなく、**触ったファイルは同じ commit で揃える** |

## 3.5 この計画で触らないもの

| 何 | なぜ外すか |
| --- | --- |
| **`ENTITY_GLYPH`** | 規範5。celestial ∪ dynamic ∪ 物でないものの総称で、**語が決まっていない。`PhysicalObject` の是正計画へ送る** |
| **`PhysicalObject` 族**(`hud/panels/physical-object-list-*.ts`、`PhysicalObjectListFilter` / `-Sort` / `-Order`) | **それ自体が別件の是正対象**(空クリック・ラグランジュ点という `Physical` でも `Object` でもないものを指している)。**本件では扱わず、利用範囲も広げない** |
| protein の `entities` / `backboneEntities` | 規範6。mmCIF の定訳かつ生成アセットのキー |
| `EntityIdAllocator` に渡す接頭辞の値 / `EntitySaveData` のフィールド名 | セーブに載る値・キー |
| `SphereEntity` / `PointEntity` / `StarEntity` | 2.2。参照が `celestial/` と `stages/` に閉じていて、`CelestialEntity` の派生が継承で立っている |
| `src/game/celestial/celestial-entity/` ディレクトリ名 | **`CelestialEntity` は定義に適合している**(運動と見た目を統合)ので改名の理由が無い。中の `celestial-entity-def.ts` は `CelestialClass` しか持たないので別扱いだが、**その改名は `rename_body.md` 3.5** |
| `src/game/dynamic/dynamic-entity/` ディレクトリ名 | 同上。`DynamicEntity` は定義に適合している |
| `DEVELOP/CODING-RULE.md` | **1.6。規約は正しく、コードが逸脱しているだけ** |
| `body` を含むすべての識別子 | **`rename_body.md` の担当**(3.6) |
| `DEVELOP/SPEC/` | 英語の識別子を含まず、「エンティティ」が日本語で5回出るだけ。**この計画で嘘にならない** |

## 3.6 `rename_body.md` との境界

**対になっていて、片方だけ直すと CODING-RULE 2.1 違反が残る識別子。**

| 対 | `entity` 側(この計画) | `body` 側(`rename_body.md`) |
| --- | --- | --- |
| 衝突のメソッド | `collideWithEntity` → `collideWithDynamic` | `collideWithCelestialBody` → `collideWithCelestial` |
| `OrbitAnalysisTarget` のユニオン | `kind: 'entity'` / `entity` → `'dynamic'` / `dynamic` | `kind: 'celestialBody'` / `body` → `'celestial'` / `celestial` |
| 表示トグルの表 | `ENTITY_ROWS` → `DYNAMIC_KIND_ROWS` | 型 `BodyClassRow` → `MapDisplayRow` と `BODY_CLASS_ROWS` → `CELESTIAL_CLASS_ROWS` |
| マーカー字形 | **`ENTITY_GLYPH` は保留**(規範5) | `bodyEntityGlyph` → `celestialClassGlyph` は**単独で通せる**(定数名が変わらないだけ) |

**同じファイルに触るのは3つ** — `hud/orbit/orbit-analysis-data.ts` /
`hud/panels/view-options-panel.ts` / `dynamic/dynamic-entity/dynamic-entity.ts`。
`marker/marker-glyphs.ts` は `ENTITY_GLYPH` を保留したので**この計画では触らない。**

**この計画を先に通す**(冒頭のとおり確定)。`rename_body.md` は案A / 案B が未決で、
どちらを採る場合もこちらが前提になる。**片側だけが main に入っている状態でも壊れない** —
対の片側が有標になるだけで、現状より悪くはならない。

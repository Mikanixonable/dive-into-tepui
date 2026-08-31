# `body` の用法 — 実態調査と是正計画

前身は `rename_entity_body.md`(`body` と `entity` を1つの計画で扱っていたもの)。**独立に通せる
2つの問題だったので分割した。`entity` 側は `rename_entity.md`。** 両者が対になっていて同時に
通す必要のある識別子は **3.6** に一覧する。

**背景。** いまの対立軸は **`celestial` / `dynamic`** で、CODING-RULE 2.2 がその二語を定義して
いる。歴史的には天体側が `CelestialBody` / `ephemeris` / `attractor` などバラバラに呼ばれ、
**`body` / `entity` の対へ略されていた時期がある。** `CelestialBody` モジュールは解体済みだが、
**その時期の語だけが識別子に残っている。** それを洗い出して落とす。**挙動は一切変えない。**

**この計画は未確定。** 第1部の実態調査を受けて、是正の向きに**2つの案**が立っている(1.9)。

- **案A**(当初案)— **天体に `body` を使わない。** `celestialBodies` → `celestialMotions`。
- **案B**(対抗案)— **`CelestialMotion` こそを `CelestialBody` へ改める。** 名前ではなく
  型のほうを直す。

**第2部・第3部は案A を前提に書いてある。** 案B を採るなら 2.1 規範2 以降を差し替える。

以下の件数はすべて **`980b7929`**(`refactor_celestial_set.md` 実施後)時点のコードから実測したもの(`tests/dist/` は除外)。
**維持しない** — 着手時に測り直す。

---

# 第1部 実態調査

## 1.1 `body` の当たりは9つの意味に分かれる

`body` / `bodies` を含む行は **src 1561・tests+tools 401**。意味で分けると9つある。

| # | 意味 | 代表 | 行 | 判定 |
| --- | --- | --- | --- | --- |
| A | **天体**(有標) | `celestialBodies` 177 / `celestialBody` 78 / `CelestialBodyDef` 14 / `FutureCelestialBodyProvider` 14 / `frameOfCelestialBody` 11 / `collideWithCelestialBody` 9 / `ArcCelestialBodies` 8 | **391** | **落とす**(1.2) |
| B | **天体**(無標) | `FrameAnchorSource.bodies` / `bodiesPivot` 22 / `attractor.ts` の `bodies` / `predicted-arc.ts` の `body` / `collisionBodies` / `nearestBody` | 約 90 | **落とす**(1.3) |
| C | **大気を持つ天体** | `atmosphereBody` 36 / `AtmosphereBody` 5 / `nearestAtmosphereBody` 10 / `MAX_ATMOSPHERE_BODIES` / `BodySlot` / `bodyCount` / `anyBodyInView` | **79** | **落とす。ただし2種類ある**(1.4) |
| D | **天体の表示クラス** | `bodyClass` 20 / `BodyClassRow` / `BODY_CLASS_ROWS` / `_bodyClassToggles` / `saveBodyClassToggles` / `bodyEntityGlyph` 7 | **50** | **落とす。名前が二重に嘘**(1.6) |
| E | **本体(系の重心ではないほう)** | `PlanetSystem.body` / `setBody` / `planetBody` / `bodyFromBarycenter` / `SystemMembers.body` / `EphemerisPointKind = 'body' \| 'systemBarycenter'` | 39 + 8 | **据置。多義ではなく明確な対**(1.5) |
| F | **DOM のパネル本体** | `document.body` 17 / `PanelShell.body` / `DraggableWindow.body` / `buildTabBody` / `guideBody` / `sectionBody` / `data-id="planbody"` / `theme.ts` の `'body'` | **50+17** | **据置。HTML の語**(1.5) |
| G | **物理の定訳** | `blackbody*` 22 / `twoBodyAccel` / `n-body.test.ts` | **27** | **据置** |
| H | **モデルの胴体** | `bulletBodyResources` / `plasmaBodyMat` / `casingBodyResources` / `hexBody` / `shipBodyShadow` | **24** | **据置(狭いスコープ)**(1.4) |
| I | **機体固定座標系** | `attitude.ts` の `axisBody` 5 / `belt-physics.ts` の `v_body_total` 4 | **9** | **要判断**(1.4) |

**A〜D の約 610 行が是正対象。** E〜H の 165 行は据置。I の 9 行だけが判断待ち。

## 1.2 `celestialBody` は `CelestialMotion` の第二の名前になっている

**型注釈のある `celestialBodies` は 52 箇所すべてが `readonly CelestialMotion[]`。** 例外はゼロ。
つまり `celestialBodies` という名前は、型が既に言っていること以上を何も言っていない。

**同じ値が同じファイルの中で2つの名前を持っている。** `celestialBodies` と `celestialMotions`
の両方が出てくるファイルが **17 個**あり、いちばん露骨なのが:

```ts
// src/game/game.ts:518
const celestialBodies = this.celestialSystem.celestialMotions;
```

**これは別名を作るためだけの行。** 同ファイルの 330 行目・426 行目は同じ値を
`this.celestialSystem.celestialMotions` のまま渡している。

`celestialMotions` は思いつきの語ではなく、**既に確立した受け皿**である
— `CelestialSystem.celestialMotions`、型 `CelestialMotions`(`celestial-motion.ts:88`、
`celestialMotions` / `gravityMotions` / `atmosphereMotions` の3本を持つ)、
`FutureCelestialBodyProvider.celestialMotions`。**`celestialBodies` はこの体系から
取り残された1語。**

## 1.3 無標の `body` / `bodies` が指すのも、ほぼ全部が天体

無標で宣言されているものを型で分けると:

| 型 | 場所 | 扱い |
| --- | --- | --- |
| `readonly CelestialMotion[]` | `FrameAnchorSource.bodies`(**公開 interface**)/ `bodyAnchorSource` / `attractor.ts` の3関数 / `lagrange.ts` / `surface-candidates.ts` / `predicted-arc.ts` | **天体。落とす** |
| `CelestialMotion` | `predicted-arc.ts:48` / `surface-candidates.ts:17` / `plan-path.ts:258` / `orbit-analysis-data.ts:39` | **天体。落とす** |
| `HTMLElement` | `panel-shell.ts:148` / `draggable-window.ts:83` / `help-panel.ts` / `pause-menu.ts` / `plan-panel.ts` / `view-options-panel.ts` ほか | **DOM。据置** |
| `ChebyshevBodyManifest[]` / `ChebyshevBodySegments` | `ephemeris/pack-types.ts` / `pack-evaluator.ts` | **凍結**(1.5) |
| `KinematicState<F>` | `kinematic-state.ts:47,56`(`toPrimaryRelative` / `toEciRelative` の第2引数) | **狭いスコープ。据置可** |

**`FrameAnchorSource` の `bodies` / `bodiesPivot` が特に効いている** — `physics/frame.ts:49-51` の
公開 interface なので、`game/` 全域(`map-camera.ts` / `dynamic-entity.ts` / `plan-path.ts` /
`nav-target.ts` / `equator-node-marker-pair.ts`)が無標のまま引いている。その受け側が
`celestialBodiesPivot` という名前を付け直している箇所が2つある
(`nav-target.ts:191`、`equator-node-marker-pair.ts:68`)。**無標 → 有標 → また無標** と3回名前が
変わる。

## 1.4 剛体・球体としての `body` はどこにあるか

**遮蔽と衝突では、`body` は例外なく `CelestialMotion` だった。** 「剛体や球体であることを指して
いる可能性が高い」という想定は、この2ドメインには当たらない。

| 場所 | 引数の型 | 結論 |
| --- | --- | --- |
| `physics/occlusion.ts`(`isOccluded` / `occlusionFactor`) | `readonly CelestialMotion[]` | **天体限定。** 球として扱うのは `def.radius` を読むからで、型は天体 |
| `game/dynamic/surface-contact-physics.ts` | `readonly CelestialMotion[]` | **天体限定**(`collideWithCelestialBody` を呼ぶ側) |
| `game/dynamic/predicted-arc.ts` の `collisionBodies` | `readonly CelestialMotion[]` | **天体限定** |
| `physics/collision-response.ts` | — | **`body` の当たりが1件も無い** |
| `game/dynamic/dynamic-entity/base-collision.ts` | — | **同上。`SphereHit` / `OBB` / `Triangle`** |
| `game/dynamic/contact-participant.ts` / `entity-contact-physics.ts` | — | **同上** |

**つまり衝突応答・当たり形状の層は、そもそも `body` という語を使っていない。** 使っているのは
「天体との接触」を扱う層だけで、そこの `body` は天体である。

**剛体を指す `body` は TS コードに1つも無い。** `rigidBody` は CODING-RULE の中に仮定として
書かれているだけで実体が無く、`rigid_body_basis` は `tools/protein-builder/` の Python
(snake_case が正しい別言語)。

**「機体固定座標系」の意味では2箇所ある**(カテゴリ I、計 9 行):

- `physics/attitude.ts:206-234` の **`axisBody`** — `attitudeAlignError` が返す誤差回転軸を
  機体座標系で表したもの。航空宇宙の定訳 "body frame / body axes"。
- `player/belt-physics.ts:253,271` の **`v_body_total`** — 機体座標系での速度。
  (この2つは snake_case でもあり、表記規則にも反している。)

**現 CODING-RULE 2.2 は「機体に固定した座標系も `ship` で表す」と書いているので、
この2箇所は現行規則にも反している。** ただし "body frame" は定訳なので、`OrbitalElements` /
`blackbody` と同じ扱いで例外にする選択肢もある。**判断を要する唯一の箇所**(規範4)。

**球であることを指す `body` は1件だけある** — `render/atmosphere.ts:90` の
**`AtmosphereBody`**。中身は `{ center: THREE.Vector3; surfaceRadius: number; optics }` で、
**`CelestialMotion` ではなく描画座標の球**。同じ名前が `physics/dynamics.ts:117` と
`attractor.ts:64` では `CelestialMotion` を指しているので、**`atmosphereBody` は2つの別物に
またがっている。**

**モデルの胴体**(カテゴリ H)は `ships.ts` の中で `body` / `halo` / `casing` と対になっていて、
その場で一意に決まる。**現 CODING-RULE の「狭いスコープに限って無標の `body` でよい」に当たる。**

## 1.5 凍結されている `body` — 触ると壊れるもの

| 何 | どこ | なぜ凍結か |
| --- | --- | --- |
| `series[i].body` | `ephemeris/pack-format.ts:169,256` / `tools/ephemeris/cli.mjs:75` | **`.epk` のワイヤキー。** 既存の同梱パック2本が読めなくなる |
| `bodyPoints` と、その値 `'body'` / `'systemBarycenter'` | `pack-format.ts:68,201-206` / `ephemeris/point.ts:10` / `pack.ts:54` | **同上。** `EphemerisPointKind` の literal は JSON の値そのもの |
| `manifest.bodies` / `ChebyshevPack.bodies` | `ephemeris/pack-types.ts:33,50` | **同上** |
| `centerBodyId` | `save/save-data.ts:213` / `legacy-save.ts:59` / `snapshot-service.ts:36` | **`SnapshotMeta` のキー。** `save-store.ts` が `SaveIndex` ごと localStorage へ JSON 化する |
| `smallBodyVisible` / `smallBodyOrbit` / `smallBodyName` | `map/display-toggles.ts:16-18` | **`MapDisplayToggles` のキー。** `tepui.mapDisplayToggles` として localStorage へ丸ごと JSON 化される(`camera-system.ts:23,43`) |
| `document.body` / `<body>` / CSS の `body` | `main.ts` / `theme.ts:476` / `celestial-grid.ts` ほか | **HTML の要素名** |

**`smallBody` は凍結キーであると同時に定訳でもある** — JPL Small-Body Database(`sbdb.api`、
`dwarf-planets.ts` が出典 URL ごと引いている)と IAU の "small Solar System body"。
**`OrbitalElements` と同じ扱いで例外にする。**

**`E` の「本体 vs 系重心」も落とせない** — `PlanetSystem.body` は「惑星本体」で、対になるのは
`systemBarycenter`。ここの `body` は多義ではなく、**対が名前で立っている。** `.epk` の
`EphemerisPointKind` が同じ対を持つのも同じ理由。

## 1.6 `body` 側が「片方だけ有標」になっている対

CODING-RULE 2.1 は**「並列なものは両方を有標にする」**と定めている。旧 `body` / `entity` の対が
残っている3箇所は、**天体側が過剰に有標で、ゲーム個体側が無標**という形でこの規則に反している。
**ここに挙げるのは `body` 側の半分だけで、対になる `entity` 側は `rename_entity.md` が扱う**
(対応表は 3.6)。

**(1) 判別可能ユニオン** — `hud/orbit/orbit-analysis-data.ts:38-39`:

```ts
| { readonly kind: 'entity'; readonly entity: DynamicEntity }
| { readonly kind: 'celestialBody'; readonly body: CelestialMotion };
```

`'celestialBody'` と `body` がこの計画の担当。**同じファイルの 67 行目には
`const centerEntity = celestialSystem.entityOf(center.id)` があり、`body`(天体)と
`centerEntity`(天体)が別の語で同じ族を指している。**

**(2) メソッドの対** — `dynamic-entity/dynamic-entity.ts:615,619`:

```ts
collideWithEntity(_other: DynamicEntity, ...)
collideWithCelestialBody(_body: CelestialMotion, ...)
```

**(3) HUD の表** — `hud/panels/view-options-panel.ts:68,75,90`。
**`BODY_CLASS_ROWS`(天体クラス)と `ENTITY_ROWS`(ゲーム個体)が、どちらも型 `BodyClassRow`
で宣言されている** — **共有している型名だけが `body` 側に寄っている。** この計画は
`BodyClassRow` と `BODY_CLASS_ROWS` を担当する。

同じ族の名前がさらに3つある:

- **`bodyClass` は `CelestialClass` 型**(`celestial-entity.ts:50`)。フィールド名と型名が違う語。
- **`_bodyClassToggles` は `MapDisplayToggles`** で、中身は**天体クラスとゲーム個体の両方**
  (`display-toggles.ts` の冒頭コメントが「同じ表で持つ」と明言)。
  `loadBodyClassToggles` / `saveBodyClassToggles` / `setBodyClassToggles` /
  `onBodyClassModeChange` / `BODY_CLASS_TOGGLES_STORAGE_KEY` / `bodyClassDisplayIcon` /
  `BODY_CLASS_DISPLAY_ICONS` / `setBodyClassModeButton` も同様。
  **保存キーの値のほうは既に `'tepui.mapDisplayToggles'`** なので、**名前だけが古い。**
- **`bodyEntityGlyph(cls: CelestialClass)`**(`marker/marker-glyphs.ts:47`)は**両方の語が付いた
  1語**。中身は天体クラス → 字形なので、この計画で `body` も `entity` も落とす。
  参照先の定数 `ENTITY_GLYPH` の改名は `rename_entity.md`。

**(4) `MapPickKind` の `'body'`**(`pickable/map-pickable.ts:5`、約 30 行)。
`'body' | 'ship' | 'player' | 'apsis' | ...` の第1項で、**ラグランジュ点も `'body'` に含まれる**
(`map-pickable-menu.ts:36` が明言、`object-groups.ts:41` / `anchor-zone.ts:74` /
`physical-object-list-order.ts:94` が `LAGRANGE_ID` で再分岐している)。
**天体でないものが `'body'` を名乗っている。** これは `body` 側だけの問題。

## 1.7 現 CODING-RULE の `body` 関連の記述が持つ嘘

| 箇所 | 記述 | 実態 |
| --- | --- | --- |
| 2.2 `celestialBody` 節 | 「**天体は `celestialBody`。**`CelestialBodyDef` / `SubstepCelestialBodies` / `ArcCelestialBodies`」 | **`celestial` / `dynamic` の対が既に区別しているので `Body` は情報を足していない**(1.2)。理由も「天体を指すから」になっていて、**多義だから避けるという本来の理由が消えている** |
| 2.2 `celestialBody` 節 | 「剛体一般が要るようになったら `rigidBody`」 | TS に剛体は1件も無い(1.4)。**仮定** |
| 2.2 `celestialBody` 節 | 「機体に固定した座標系も `ship`」 | `axisBody` / `v_body_total` が反している(1.4) |
| 2.1 表記 | 略語の例に **`celestialBodyId`** | **その識別子はコードに存在しない。** 規則の例が、これから禁じる語形 |
| 2.1 | 「並列なものは両方を有標にする」 | **規則自体は正しく、1.6 がその違反。** 語を足すのではなく、**この規則を根拠に是正する** |

## 1.8 `CelestialMotion` は「運動」より広い — 名前のほうが嘘の可能性

案A は「`celestialBodies` という名前が型 `CelestialMotion` 以上のことを言っていない」を根拠に
名前を型へ寄せる(1.2)。**だが逆向きの読みが成り立つ** — 型の名前のほうが実態より狭い。

**`CelestialMotion` の公開メンバ 19 のうち、運動(位置・速度・加速度)は 6 だけ。**

| 運動 | 運動でない |
| --- | --- |
| `stateAt` / `positionAt` / `analyticStateAt` / `analyticAccelAt` / `ownNumericStateAt` / `numericStateAt` | `def`(半径・質量パラメータ・大気・環・自転モデル)/ `kind` / `primary` / `id` / `spinPhase0` / **`degree2At`(2次重力場)**/ **`atmosphereAt`(大気)**/ **`orientationAt`・`spinRotationAt`・`spinRate`(自転)**/ `bindEphemeris` / `bindEciTransform` / `cacheStats` |
| **6** | **13** |

**CODING-RULE 2.2 の `ephemeris` 節が、この区別をすでに言葉にしている** —
「暦が答えるのは位置と速度だけ。**自転・重力場・大気・加速度は含まない**」。
`CelestialMotion` はその3つ全部を答える。**つまり「運動」は暦の守備範囲であって、
このクラスの守備範囲ではない。** クラスが担っているのは**天体そのもの**である。

**`CelestialBody` という名前は空いている。** 素の `CelestialBody` の当たりは **0 件**
(`CelestialBodyDef` は別語)。**しかも過去の `CelestialBody` は別物だった** —
`2a49eab1`「積分と表示の経路を CelestialMotion + pivot へ移し、CelestialBody を消す」の
commit message のとおり、旧 `CelestialBody` は**天体の瞬間値を凍結した値オブジェクト**で、
「時刻を引数に取る天体1体」へ置き換えるために消された。**解体されたのは器の設計であって、
語ではない。** 同じ綴りを別の意味で再利用することになるので、その旨は記録が要る(1.9)。

**`celestialBodies`(177 行)は `celestialMotions`(107 行)の 1.6 倍ある。** 実態としては、
このコードベースは既にこの値を「天体」と呼ぶほうが多い。**案A は多数派を少数派へ寄せ、
案B は少数派を多数派へ寄せる。**

## 1.9 二案の比較(未決)

### 量 — 案B のほうが大きい

| | 触る行 | 触るファイル | 適用後に残る是正 |
| --- | --- | --- | --- |
| **案A**(`celestialBody` → `celestial` / `celestialMotion`) | **625** | **101** | **0**(第3部が全部) |
| **案B**(`CelestialMotion` → `CelestialBody`) | **801**(protein の別ドメイン 255 行を除外後) | **139** | **約 190**(下記) |

案B の内訳: `CelestialMotion` 368 / `celestialMotions` 107 / `.motion`・`motion:` 120 /
`SatelliteMotion` 70 / `motionOf` 52 / `OrbitingMotion` 42 / `StarMotion` 32 /
`PlanetMotion` 16 / `CelestialMotions`(型)15 / `gravityMotions` 13 / `atmosphereMotions` 7 /
`celestial-motion.ts` の移動と import 追従。

**案B でも消えない残渣(約 190 行)** — `bodyClass` / `BodyClassRow` / `BODY_CLASS_ROWS` /
トグル族 / `MapPickKind` の `'body'`(ラグランジュ点を含む)/ `*BodyPickable*` /
`bodyEntityGlyph` / `runBodyShip` / `AtmosphereBody`(描画座標の球、1.4)/
`ReferenceCelestialBody`(実体は id 文字列)/ `axisBody`・`v_body_total`。
**これらは「天体を `body` と呼ぶかどうか」とは無関係な間違いなので、どちらの案でも直す。**

**合計すると案A 625 行、案B 約 990 行。「作業範囲を大幅に小さくできる」という見込みは
実測では成り立たない。**

### ただし行数だけでは決まらない

| | 案A | 案B |
| --- | --- | --- |
| **判断の数** | 2.3 の表で **約 25 の別々の改名判断**(`celestialBody` 単数を `motion` にするか `celestialMotion` にするかなど、局所ごとに変わる) | **約 10。** うち `CelestialMotion` → `CelestialBody` の 368 行は**判断の要らない一括置換**で、typecheck が全部拾う |
| **1.8 の嘘** | **残る。** しかも `celestialMotions` を 177 箇所へ広げるので**嘘が増える** | **消える** |
| **`CelestialBodyDef`** | `CelestialDef` へ改名(14 行)。しかも `celestial-entity-def.ts` と名前が衝突する(3.5) | **無改名で正しくなる**(`CelestialBody` の `Def`) |
| **凍結キーとの整合**(`.epk` の `series[].body` / `bodyPoints` / `'body'`、`centerBodyId`、`smallBody*`) | **例外として残る**(規範3)。コードは `celestial`、データは `body` | **一致する。** 例外規定が要らなくなる |
| **CODING-RULE 2.1 の略語例 `celestialBodyId`** | 実在しない語なので落とす | **実在する語になる**(`ReferenceCelestialBody` → `celestialBodyId`) |
| **定訳との距離** | `celestials` / `celestialMotions` は独自語(2.2) | **`celestial body` は天体の定訳。** `blackbody` / `small body` と同じ列に並ぶ |
| **git 履歴の読みやすさ** | 影響なし | **`CelestialBody` が別の意味で復活する**(1.8)。`git log -S` が2つの時代を混ぜる |
| **`DynamicEntity` との見え方** | `celestialMotions` と `entities` が並ぶ | **`celestialBodies` と `entities` が並ぶ** — 旧 `body` / `entity` の対に見え、**読み手が celestial/dynamic の軸を再導出しかねない**(下記) |

### 案B を採るなら、先に `rename_entity.md` が要る

案B の唯一の実質的な危険がこれ。**`celestialBodies` と、`DynamicSystem` を指す無標の
`entities`(57 箇所)が同じファイルに並ぶと、まさにこの計画が消したい
「`body` = 天体 / `entity` = ゲーム個体」という誤った軸に見える。**

**したがって案B を採るなら、`rename_entity.md`(`entities: DynamicSystem` → `dynamicSystem`)
を先に通す必要がある。** そうすれば `celestialBodies` の向かいに立つのは
`dynamicSystem.enemies` などになり、対は `celestial` / `dynamic` の軸に戻る。

**そのうえで、`Entity` / `Body` は「新しい対立軸」ではないと決めるのがよい。**
`celestial body` は**定訳の複合語**(天体)であって、多義語 `body` に `celestial` を
付けたものではない。この読みなら:

- **規範1(無標の `body` は多義だから使わない)はそのまま生き残る。**
- `CelestialBody`(物理だけの天体)と `CelestialEntity`(それに見た目を統合したもの)の対は
  **`Celestial*` の内側にだけある。**
- **`DynamicBody` は作らない。** `DynamicEntity` は物理と見た目を分けていないので、対応物は
  存在しない。**この非対称は意図的だと明記する**(でないと誰かが対を「完成」させに来る)。

### `refactor_celestial_set` は差を詰めなかった(実測済み)

`refactor_celestial_set.md`(`e278ec10`〜`980b7929` で実施済み)は
**`readonly CelestialMotion[]` を引数で配る形そのものを減らした** — `system-membership.ts` を
削除して星系への問い合わせを `CelestialSystem` のメソッドへ移し、線形 id 検索を
`CelestialSystem` の口へ寄せた。**この計画の量に効くと見込んでいたが、実測では両案が
同じだけ縮んだだけで、差は変わらなかった。**

| | 実施前(`dd5e2d68`) | 実施後(`980b7929`) |
| --- | --- | --- |
| 案A | 655 行 / 103 ファイル | **625 行 / 101 ファイル** |
| 案B | 810 行 / 142 ファイル | **801 行 / 139 ファイル** |

主な変化は `celestialBodies` 206 → **177**、`CelestialMotion` 384 → **368**、
`bodyClass` 26 → **20**、**`motionById` は消滅**(`CelestialSystem` の表へ吸収)。
**結論は動かない。**

### いま言えること

**案B のほうが診断として正しい**(1.8)。**案A は量が小さいが、`CelestialMotion` という
名前の嘘を残したまま、その名前を 177 箇所へ広げる。**

**順序は確定している** — **`rename_entity.md` を先に通す**(案B の前提。案A を採る場合も無害)。
**その後に測り直して案A / 案B を決める。**

**決めるべきは1点だけ** — 「`CelestialMotion` が答えている重力場・大気・自転を、名前に
含めるべきか」。含めるなら案B、運動だけを名乗り続けてよいなら案A。

---

# 第2部 決めたこと

**以下は案A を前提に書いてある。** 案B を採る場合、規範2 と 2.2・2.3 は差し替えになり、
規範1・3・4・5・6 と第3部の手順5・6 はそのまま使える。

## 2.1 規範

**各項に、CODING-RULE へ記録するかどうかを付す。** 基準は
**「将来また同じ間違いが起きうるか」**だけ。記録しない項もこの計画では同じように適用する。

1. 【**記録する**。現行記述の差し替え】**無標の `body` を使わない理由は「天体を指すから」では
   なく「多義語だから」。** `body` は天体・機体・剛体・本体・DOM の本体・胴体のどれにも読める。
   **したがって、有標にすれば済むのではなく、指すものの語で置き換える。**
   `celestialBody` のように `body` を残す形は、**`celestial` が既に区別を付け終えているので
   語を増やしているだけ**(1.2)。

2. 【**記録する**】**天体は `celestial`。`celestialBody` を使わない。** `celestial` / `dynamic`
   の対が物体の分類を担い、**その先は「何の celestial か」を頭語ではなく主名詞で言う** —
   `CelestialMotion` / `CelestialEntity` / `CelestialDef` / `CelestialClass`。
   複数形は**主名詞の複数形**(`celestialMotions` / `entities` / `defs`)。
   **`celestials` という名詞を作らない**(2.2)。

3. 【記録しない。是正後は定訳と凍結キーだけが残り、再発の余地が無い】
   **`body` を残してよいのは次の4つだけ。**
   - **定訳** — `blackbody`(黒体放射)/ `twoBodyAccel`・`n-body`(二体・N体問題)/
     `smallBody`(IAU "small Solar System body"、JPL SBDB)。
   - **HTML の要素名** — `document.body`、パネルの `body: HTMLElement`、CSS セレクタ。
   - **「本体 vs 系の重心」の対** — `PlanetSystem.body` / `SystemMembers.body` /
     `EphemerisPointKind = 'body' | 'systemBarycenter'`。**多義ではなく対が名前で立っている。**
   - **凍結キー** — `.epk` のワイヤ(`series[].body` / `bodyPoints` / `manifest.bodies`)と
     セーブのキー(`centerBodyId` / `smallBody*`)。**名前を変えるならデータの移行が要る。**

4. 【**保留。ユーザー判断待ち**】**機体固定座標系の `body`**(`axisBody` / `v_body_total`、計 9 行)。
   - **案 a: 定訳として例外にする。** "body frame / body axes" は航空宇宙の標準語で、
     `OrbitalElements` と同じ扱い。現 CODING-RULE の「機体に固定した座標系も `ship`」を緩める。
   - **案 b: `ship` へ寄せる**(`axisShip` / `v_ship_total`)。現行規則どおり。ただし**この2箇所は
     どちらも `Ship` クラスではなく剛体一般の姿勢制御**(`physics/attitude.ts` は敵艦・基地・
     デブリにも効く)なので、`ship` は逆に狭すぎる。
   - **推奨は a。** 併せて snake_case(`v_body_total`)は表記規則違反なので、どちらへ倒しても
     camelCase へ直す。

5. 【記録しない】**`AtmosphereBody`(`render/atmosphere.ts:90`)は天体ではなく描画座標の球。**
   同名の `atmosphereBody`(`physics/dynamics.ts` / `attractor.ts`)は `CelestialMotion`。
   **2つを別の語にする** — 前者は球の記述なので `AtmosphereSphere`、後者は天体なので
   `atmosphereCelestial`(あるいは主名詞を出して `atmosphereMotion`)。

6. 【記録しない】**`attractor` は現行どおり**(重力源としての値)。
   1.1 の走査で `attractor` 族に歴史的な残骸は見つからなかった。

**覆された場合**: 2 が覆ると手順2〜6 が全部変わる。4 は手順1 の1項だけに効く。
5 は手順4 の半分に効く。

## 2.2 `celestials` を作らない理由と、採らない選択肢

`ArcCelestialBodies → ArcCelestials` という案は、意味は通るが**採らない。**

**理由。** `celestial` は形容詞で、名詞化した `celestials` は英語として非標準(天文の文献は
"celestial body" / "celestial object" を使う)。**しかも自作の名詞を導入しなくても、
このコードベースには既に主名詞が3つある**(1.2):

| 値の型 | 既存の主名詞 | 既存の用例 |
| --- | --- | --- |
| `CelestialMotion` | **`celestialMotions`** | `CelestialSystem.celestialMotions` / 型 `CelestialMotions` / `gravityMotions` / `atmosphereMotions` |
| `CelestialEntity` | **`entities` / `entityOf`** | `CelestialSystem.entities` / `entitiesById` |
| `CelestialBodyDef` | **`defs`** | `CelestialSystem.defs` |

**`celestialBodies` → `celestialMotions` は、造語ではなく既存語への合流。** しかも
`game.ts:518` の別名行がそのまま消える。

**動詞句で主名詞が要らない位置**(`collideWithCelestialBody` / `occludedByCelestialBody`)
だけは、**族語をそのまま名詞位置に置く** — `collideWithCelestial` / `occludedByCelestial`。
これは対になる `collideWithEntity` → `collideWithDynamic`(`rename_entity.md`)と語形が揃うのが
利点で、**1.6 (2) の片方だけ有標がここで解消する。**

**代案 a — `ArcCelestialMotions` / `SubstepCelestialMotions`。** クラス名でも主名詞を出す案。
**正確で、実際に保持しているのも `CelestialMotion`。** 欠点は長いことだけ。
**この計画はこちらを採る**(2.3)。

**代案 b — `ArcBodies` のように `celestial` を落として `body` を残す。** 短いが 1.1 の多義に
戻るので却下。

**代案 c — `PhysicalObject` を天体側にも使う。** `physical-object-list-*.ts` の既存語だが、
**あれは celestial ∪ dynamic の総称。** 天体側だけに使うと総称が消える。却下。

## 2.3 適用後の名前

### 天体側

| 現 | 案 | 行 |
| --- | --- | --- |
| `celestialBodies`(`readonly CelestialMotion[]`) | **`celestialMotions`** | 177 |
| `celestialBody`(`CelestialMotion`、局所) | **`motion`**(狭いスコープ)/ **`celestialMotion`** | 78 |
| `CelestialBodyDef` | **`CelestialDef`** | 14 |
| `physics/celestial-body-def.ts` | **`physics/celestial-def.ts`** | 移動1 |
| `FutureCelestialBodyProvider` | **`FutureCelestialMotions`** | 14 |
| `ArcCelestialBodies` / `ArcCelestialBodyWindow` | **`ArcCelestialMotions` / `ArcCelestialWindow`** | 12 |
| `game/dynamic/arc-celestial-bodies.ts` | **`arc-celestial-motions.ts`** | 移動1 |
| `SubstepCelestialBodies` / `substep-celestial-bodies.ts` | **`SubstepCelestialMotions`** | 3 + 移動1 |
| `frameOfCelestialBody` | **`frameOfCelestial`** | 11 |
| `collideWithCelestialBody` | **`collideWithCelestial`**(対は 3.6) | 9 |
| `occludedByCelestialBody` | **`occludedByCelestial`** | 6 |
| `isFiniteCelestialBody` / `collectCelestialBodies` / `includeAllCelestialBodies` | **`isFiniteCelestial` / `collectCelestialMotions` / `includeAllCelestials`** | 9 |
| `ReferenceCelestialBody`(実体は `string` の id) | **`ReferenceCelestialId`** | 12 |
| `celestialBodyValue` / `celestialBodyItems` / `celestialBodyControl` / `baseCelestialBodyItems` | **`celestialValue` / `celestialItems` / `celestialControl` / `baseCelestialItems`** | 28 |
| `celestialBodiesPivot` | **`celestialPivot`** | 20 |
| `FrameAnchorSource.bodies` / `.bodiesPivot` / `bodyAnchorSource` | **`.celestialMotions` / `.celestialPivot` / `celestialAnchorSource`** | 34 |
| `physics/body-orientation.ts` / `BodyOrientation` | **`celestial-orientation.ts` / `CelestialOrientation`** | 36 |
| `render/body-graticule.ts` / `BodyGraticule` | **`celestial-graticule.ts` / `CelestialGraticule`** | 7 |
| `CelestialMotion.bodyEphemeris`(private) | **`ephemeris`** — `CelestialMotion` の内側なので `body` は情報を足していない | 3 |
| `nearestAtmosphereBody` / `atmosphereBody`(`CelestialMotion`) | **`nearestAtmosphereCelestial` / `atmosphereCelestial`** | 46 |
| `render/atmosphere.ts` の `AtmosphereBody`(球の記述) | **`AtmosphereSphere`**(規範5) | 33 |
| `MapPickKind` の `'body'` | **`'celestial'`**(値も型も。永続化されない) | 約 30 |
| `object-placer-panel.ts` の preset `kind: 'body'` | **`'celestial'`** | 4 |
| `runBodyShip` | **`runCelestialShip`** | 3 |
| `cachedBodyPickables` / `isBodyPickable` / `cacheBodyPickable` / `cachedBodyPickablesTime` / `…Policy` | **`cachedCelestialPickables` ほか** | 33 |

### 表示クラス側(1.6 (3))

| 現 | 案 | 行 |
| --- | --- | --- |
| `CelestialEntity.bodyClass`(型は `CelestialClass`) | **`celestialClass`** | 26 |
| `BodyClassRow` | **`MapDisplayRow`** — `BODY_CLASS_ROWS` と `ENTITY_ROWS` が共有する型なので、どちらの族にも寄らない名前にする | 5 |
| `BODY_CLASS_ROWS` | **`CELESTIAL_CLASS_ROWS`**(`ENTITY_ROWS` は 3.6) | 2 |
| `_bodyClassToggles` / `loadBodyClassToggles` / `saveBodyClassToggles` / `setBodyClassToggles` / `onBodyClassModeChange` / `BODY_CLASS_TOGGLES_STORAGE_KEY` / `bodyClassDisplayIcon` / `BODY_CLASS_DISPLAY_ICONS` / `setBodyClassModeButton` | **`mapDisplayToggles` 系へ揃える**(保存キーの**値**は既に `'tepui.mapDisplayToggles'`) | 28 |
| `bodyEntityGlyph(cls: CelestialClass)` | **`celestialClassGlyph`** — 参照先 `ENTITY_GLYPH` の改名は 3.6 | 7 |

---

# 第3部 実施

## 3.1 手順

**手順1 を先に置く。** 以降は「規範から外れているものを直す」作業になる。

1. **CODING-RULE の改訂。** 2.2 の `celestialBody` / `ship` / `attractor` 節を規範1〜3 で
   差し替え、2.1 の略語の例から `celestialBodyId` を落とす。
   **規範4 の判断をここで確定させる**(ユーザーへ問う唯一の点)。
   `entity` 節への追記は `rename_entity.md` 側。
2. **`celestialBody` → `celestial` / `celestialMotion`**(2.3 第1表、上から 12 行目まで)。
   型・関数・フィールドの改名と、`physics/celestial-body-def.ts` /
   `game/dynamic/arc-celestial-bodies.ts` / `substep-celestial-bodies.ts` の移動。
3. **無標の `bodies` / `bodiesPivot` の是正。** `physics/frame.ts` の `FrameAnchorSource` から
   始めて、`attractor.ts` / `predicted-arc.ts` / `surface-candidates.ts` / `lagrange.ts` /
   `plan-path.ts` と、受け側の `celestialBodiesPivot` 2箇所を同時に。
4. **`body-orientation.ts` / `body-graticule.ts` / `atmosphereBody` / `AtmosphereBody`。**
   規範5 の2分割を含む。
5. **表示クラス側**(2.3 第2表)。`bodyClass` → `celestialClass`、`BodyClassRow` →
   `MapDisplayRow`、`BODY_CLASS_ROWS`、トグル族、`bodyEntityGlyph`。
6. **`MapPickKind` の `'body'` → `'celestial'`。** 型 literal と全分岐、`runBodyShip`、
   `*BodyPickable*` 族、`object-placer-panel.ts` の preset。
7. **日本語コメントの追従。** 「天体」はそのままでよい(元から `body` と対応していない)が、
   **手順2〜6 で触ったファイルのコメントを同じ commit で揃える。**

**手順2〜4 は互いに独立で、並行できる。** 手順5 と手順6 は
`hud/panels/physical-object-list-*.ts` と `pickable/` で同じファイルに触るので、順に通す。

## 3.2 達成目標

1. `grep -rnE "[Cc]elestialBod(y|ies)" src/ tests/ tools/` が **0 件**。
2. `grep -rniE "\bbod(y|ies)\b" src/ tests/ tools/` の当たりが、**規範3 の4種だけ** —
   定訳(`blackbody` / `twoBody` / `n-body` / `smallBody`)、DOM(`document.body` /
   `body: HTMLElement` / CSS)、本体対重心(`PlanetSystem.body` / `EphemerisPointKind`)、
   凍結キー(`.epk` の `series[].body` / `bodyPoints` / `manifest.bodies`、
   `centerBodyId`、`smallBody*Visible`)。**規範4 の結論次第で `axisBody` / `v_body_total` が加わる。**
3. **`collideWithCelestial` が存在する**(対の `collideWithDynamic` は `rename_entity.md`)。
   `orbit-analysis-data.ts` のユニオンの天体側が `'celestial'` になっている。
4. CODING-RULE 2.2 に `celestial` を主とする節があり、**`body` を避ける理由が「多義だから」に
   なっている。** 2.1 の略語の例から `celestialBodyId` が消えている。
5. **既存セーブが復元できる** — `centerBodyId` / `smallBodyVisible` / `smallBodyOrbit` /
   `smallBodyName` と `'tepui.mapDisplayToggles'` の値が変わっていない。
   **`.epk` が読める** — `node tools/ephemeris/cli.mjs verify src/assets/ephemeris/modern-2026-10y.epk`
   が着手前と同じ segment 数・payload SHA-256 を報告する(**着手時に実測して記録すること**)。
6. `npm run typecheck` と `npm run test`(全層)が通る。

## 3.3 見積り

| 手順 | 触る行 | 根拠 |
| --- | --- | --- |
| 1 | 文書 約 45 行 | CODING-RULE 1ファイル(2.2 の2節を差し替え、2.1 の例を1語) |
| 2 | 約 370 | `celestialBodies` 177 + `celestialBody` 78 + 型・関数 約 90 + 移動3 と import 追従 約 25 |
| 3 | 約 95 | `bodiesPivot` 22 + `bodies` 約 60 + `bodyAnchorSource` 12 |
| 4 | 約 120 | `body-orientation`/`BodyOrientation` 36 + `body-graticule`/`BodyGraticule` 7 + `atmosphereBody` 46 + `AtmosphereBody` 33 |
| 5 | 約 70 | `bodyClass` 26 + `BodyClassRow` 5 + トグル族 28 + `bodyEntityGlyph` 7 |
| 6 | 約 70 | `'body'` literal 約 34 + `*BodyPickable*` 33 + `runBodyShip` 3 |
| 7 | 約 35 | 触ったファイルのコメント |

**手順2 が量の半分。機械的な置換だが、単語境界の取り方に注意**(3.4)。

## 3.4 リスクと落とし穴

| リスク | 影響 | どこで露見するか |
| --- | --- | --- |
| **`.epk` のワイヤキーを巻き込む**(`series[].body` / `bodyPoints` / `'body'` / `manifest.bodies`) | 同梱パック2本が読めなくなる。直すには `EPHEMERIS_PACK_VERSION` の major 上げが要り、**既存セーブが全部 incompatible になる** | 手順2・6。`src/physics/ephemeris/` を置換範囲から**外す**。達成目標5 |
| **セーブキーを巻き込む**(`centerBodyId` / `smallBodyVisible` / `smallBodyOrbit` / `smallBodyName`) | 旧セーブ・旧トグルが復元できなくなる | 手順2・5。`save/save-data.ts:213` / `map/display-toggles.ts:16-18`。達成目標5 |
| `body` は `blackbody` / `busybody` / `everybody` の部分文字列、`Body` は `AtmosphereBody` の一部 | 単語境界を見ない置換が `blackbody` 22 行を壊す | 手順2〜6。`\b` 付きで当たること、`blackbody` を明示除外 |
| `document.body` / `panel.body` / `this.body` が `body` の当たりの大半 | DOM を巻き込むと HUD が丸ごと壊れる。**typecheck は通ってしまう**(どちらも `HTMLElement`) | 手順2〜6。`src/game/hud/` / `windows/` / `panels/` は**手順5・6 の対象識別子だけ**に触る |
| `PlanetSystem.body` / `SystemMembers.body` / `members.body` | 「本体 vs 重心」の対が消える。`.body` は総当たりで 39 行 | 手順2。`src/physics/planet-system.ts` を置換範囲から外す |
| `'body'` は `MapPickKind` と `EphemerisPointKind` の両方の literal | 一括置換が `.epk` を壊す | 手順6。`src/game/` に限る |
| `BODY_CLASS_DISPLAY_ICONS` の**SVG の値** / `ENTITY_GLYPH` の**字形の値** | マーカー・ボタンの見た目が変わる | 手順5。定数名とキー名だけ |
| `arc-celestial-bodies.ts` / `substep-celestial-bodies.ts` / `celestial-body-def.ts` / `body-orientation.ts` / `body-graticule.ts` の移動 | `src/perf-meter.ts:42` が `'arc-celestial-bodies'` を**文字列キー**で持っている(HUD の行ラベル)。**typecheck も test も通る** | 手順2。移動のたびに `grep -rn "'<旧ファイル名>'"` |
| `BodyClassRow` を改名すると `ENTITY_ROWS` の型注釈も動く | `rename_entity.md` が同じファイルに触る | 手順5。3.6 のとおり **`rename_body.md` を先に通す** |
| コメントを別 commit で直す | 識別子と対応が取れないまま残る | 手順7 ではなく、**触ったファイルは同じ commit で揃える** |

## 3.5 この計画で触らないもの

| 何 | なぜ外すか |
| --- | --- |
| `.epk` のワイヤキーと `EphemerisPointKind` | 規範3 の凍結キー。変えるなら形式の major 上げとセーブ移行が要る |
| `centerBodyId` / `smallBody*Visible` / `'tepui.mapDisplayToggles'` の値 | 同上(localStorage) |
| `PlanetSystem.body` / `SystemMembers.body` | 規範3。「本体 vs 系の重心」の対 |
| `blackbody` / `twoBodyAccel` / `n-body` / `smallBody` | 規範3。定訳 |
| DOM の `body`(`document.body` / `PanelShell.body` / `buildTabBody` / CSS) | 規範3。HTML の要素名 |
| `bulletBodyResources` / `plasmaBodyMat` / `casingBodyResources` / `hexBody` | 1.4。`ships.ts` の中で `halo` / `casing` と対になり、その場で一意 |
| `attractor` / `ship` / `center` | 規範6。走査で歴史的な残骸が見つからなかった |
| `entity` を含むすべての識別子 | **`rename_entity.md` の担当**(3.6) |
| `DEVELOP/SPEC/` | 英語の識別子を含まず、「エンティティ」が日本語で5回出るだけ。**この計画で嘘にならない** |
| `axisBody` / `v_body_total` の**扱いの決定** | 規範4。ユーザー判断待ち。**決まってから手順1 に含める** |

**1件だけ、手順2 の中で名前が衝突する。** `CelestialBodyDef` → `CelestialDef` にすると、
`src/game/celestial/celestial-entity/celestial-entity-def.ts` を素直に `celestial-def.ts` へ
畳んだときに同名になる。**後者の中身は `CelestialClass` と `celestialClassOfKind` の2つだけ**
なので、**`celestial-class.ts` へ改名する**(規範2 の「主名詞で言う」の適用)。
`CelestialEntityDef → CelestialDef` という当初案は、この衝突を避ける形で
**`CelestialClass` 側へ寄せる**ことになる。**このファイル名の変更は手順2 に含める**
(`celestial-entity/` ディレクトリ自体は据置 — 理由は `rename_entity.md` 3.5)。

## 3.6 `rename_entity.md` との境界

**対になっていて、片方だけ直すと CODING-RULE 2.1 違反が残る識別子。**

| 対 | `body` 側(この計画) | `entity` 側(`rename_entity.md`) |
| --- | --- | --- |
| 衝突のメソッド | `collideWithCelestialBody` → `collideWithCelestial` | `collideWithEntity` → `collideWithDynamic` |
| `OrbitAnalysisTarget` のユニオン | `kind: 'celestialBody'` / `body` → `'celestial'` / `celestial` | `kind: 'entity'` / `entity` → `'dynamic'` / `dynamic` |
| 表示トグルの表 | 型 `BodyClassRow` → `MapDisplayRow` と `BODY_CLASS_ROWS` → `CELESTIAL_CLASS_ROWS` | `ENTITY_ROWS` → `DYNAMIC_KIND_ROWS` |
| マーカー字形 | `bodyEntityGlyph` → `celestialClassGlyph` | **`ENTITY_GLYPH` は保留** — celestial ∪ dynamic ∪ 物でないものの総称で、語が決まっていない。`PhysicalObject` の是正計画へ送られた |

**同じファイルに触るのは3つ** — `hud/orbit/orbit-analysis-data.ts` /
`hud/panels/view-options-panel.ts` / `dynamic/dynamic-entity/dynamic-entity.ts`。
`marker/marker-glyphs.ts` は `ENTITY_GLYPH` が保留になったので**この計画だけが触る**
(`bodyEntityGlyph` → `celestialClassGlyph` は定数名を変えないので単独で通る)。

**`rename_entity.md` を先に通す**(確定)。理由は2つ:

1. **案B(`CelestialMotion` → `CelestialBody`)を採る場合の前提になる。** `celestialBodies` の
   隣に無標の `entities`(= `DynamicSystem`)が並ぶと、旧 `body` / `entity` の軸に見える(1.9)。
2. **量が 1/5 以下**(約 140 行)で、CODING-RULE も触らないため、こちらの未決を待たずに通せる。

**`BodyClassRow` → `MapDisplayRow` の改名は、`rename_entity.md` の `ENTITY_ROWS` →
`DYNAMIC_KIND_ROWS` より後になる。** 同じ2行に触るので、**この計画が後から型注釈へ追従する。**

**どちらか片方だけが main に入っている状態でも壊れない** — 対の片側が有標になるだけで、
いまより悪くはならない。

## 3.7 `PhysicalObject` は使わない

**2.3 の表に `PhysicalObject` は出てこない。** 総称が要る場面(`ENTITY_GLYPH` /
`MapPickKind` の `'body'` がラグランジュ点を含むこと)でも、この語へは寄せない
— **`PhysicalObject` 自身が悪い命名**(空クリック・ラグランジュ点という `Physical` でも
`Object` でもないものを指している)で、**別件で是正される。**

**この計画に効くのは1点だけ** — **`MapPickKind` の `'body'` → `'celestial'`**(手順6)は、
**ラグランジュ点が `'celestial'` を名乗る状態を残す。** `'body'` よりは正確
(ラグランジュ点は天体に付随する点なので `celestial` の側ではある)だが、**完全には正しくない。**
**総称の是正が済んだら見直す**ことを記録しておく。**この計画で `'body'` のままにするのは、
1.6 (4) のとおり「天体でないものが `body` を名乗っている」ほうがより悪いから。**

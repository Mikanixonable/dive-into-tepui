# 天体の集合・検索を扱うモジュールの是正

## 目的

天体の集合(配列・Map・集合)を持つ/組むモジュールを棚卸ししたところ、20 以上あった。
そのほとんどは**計算量削減のための事前絞り込み**であり、存在すること自体は正しい。問題は
集合が多いことではなく、次の2点である。

1. **`id → 天体` の対応表が 4 系統に分裂している。** `CelestialSystem.entitiesById` という正本が
   あるのに、`ReferenceFrames` は同じ表を独自に組み直し、`system-membership.motionById()` は
   呼ばれるたびに表を作り直し、残り 15 箇所以上は `Array.find((b) => b.id === …)` の線形検索で
   引いている。CODING-RULE 1.6「配列に対して外部から対応付けを行う設計を避ける」に真っ向から
   反する。
2. **星系全体への問い合わせが `CelestialSystem` の外にある。** `system-membership.ts` の全関数は
   「星系の木を辿って親・兄弟・子・祖先・所属系を答える」もので、答えは登録天体だけで決まる。
   にもかかわらず `readonly CelestialMotion[]` を毎回引数で受け取るため、id 引きの表をその場で
   組む羽目になっている(CODING-RULE 1.4「クラス外から情報をもらいまくっていて、クラス内の情報に
   全然手を付けていない関数は、置き場所が適切でない懸念がある」)。

副次的に、**ラグランジュ点 id (`${親id}-l${n}`) の判定が 8 ファイルに散り、正規表現リテラルが
5 箇所に直書きされている**。正本は HUD のグループ分け(`hud/object-groups.ts`)に置かれており、
id を作っている `camera/focus-markers.ts` とは所有関係が逆になっている。

修正後は、`id → 天体` を引く方法が `CelestialSystem` の口ただ1つになり、星系への問い合わせが
すべてそこを通る。ラグランジュ点 id の生成と解釈が1モジュールに閉じる。

## 決めたこと

### 決定1: 事前絞り込みは容認し、触らない

次のものは**参照(`CelestialMotion` そのもの)を保持していて id を持たない**ため、解決の問題が
発生しない。この計画では触らない。

`dynamic/arc-celestial-bodies.ts` / `dynamic/attractors.ts` / `dynamic/substep-celestial-bodies.ts` /
`dynamic/surface-candidates.ts` / `render/pipeline/sun-occlusion-select.ts` /
`render/pipeline/lighting/planet-light-select.ts` / `render/atmosphere.ts` /
`celestial/planet-distance.ts`

`celestial/point-field.ts` と `celestial/point-field-view.ts` は登録天体ではない点群を持つ別種の
集合なので、同じく対象外。

### 決定2: `PlanetSystem` と `solarSystem()` は正しい形として触らない

`PlanetSystem.moons` は木の内側ノードが自分の成員を持っているだけで、外部の対応表ではない。
`solarSystem()` と `CelestialSystem` は「太陽系」と「一般の星系」の棲み分けであり、
`SOLAR_SYSTEM_BODY_NAMES` / `solarSystemBodyName()` は**星系を組む前**にセーブ一覧の名前を出す
ための静的な引き先(利用は `hud/windows/save-browser.ts:193` の1箇所のみ)。
`CelestialSystem.nameOf()` との二重持ちに見えるが、成立時点が違うので統合しない。

### 決定3: `system-membership.ts` の問い合わせ群は `CelestialSystem` のメソッドへ移す

根拠は CODING-RULE 1.4。全関数が `motions` を外から受け取り、それは `CelestialSystem` の
フィールドである。移せば id 引きは `entitiesById` で O(1) になり、`motionById()` は不要になって
消える。

`NearbySystemTracker` だけは**フレームをまたぐ状態(直前フレームの勝者)を持つ呼び出し側の道具**
なので `CelestialSystem` へは入れず、単独ファイルへ残す。

**覆される場合**: `CelestialSystem` を膨らませたくない(移動後 464 → 約 550 行で CODING-RULE 1.2 の
500 行基準を超える)なら、代わりに **`system-membership.ts` を残したまま、関数の第1引数を
`readonly CelestialMotion[]` から `CelestialSystem` に変える**。`motionById` が消えて id 引きが
O(1) になる効果は同じで、変わるのは手順2だけ(移動ではなく引数の差し替えになり、呼び出し側は
`systemMembersAt(celestialSystem, …)` のままになる)。手順1・3〜6 は影響を受けない。

### 決定4: `celestialBodies: readonly CelestialMotion[]` の引数 48 箇所は一括変換しない

**配列を走査すること自体が目的の引数(重力の総和・最強引力源・遮蔽候補)は配列のままが正しい。**
置き換えるのは次の2種類だけに絞る。

- その中で `id` 引きをしている関数(手順6)。
- `game: Game` と一緒に渡されていて、`game.celestialSystem.celestialMotions` と同一の配列である
  ことが呼び出し側で自明な関数(手順5)。

### 決定5: ラグランジュ点 id の正本は `src/game/celestial/lagrange-id.ts`(新規)

id を作るのは `camera/focus-markers.ts` と `pickable/line-pickables.ts`、解釈するのは HUD・
マップ・航法の 8 ファイル。生成と解釈の両方が依存できる位置は `game/celestial/` であり、
HUD のグループ分けモジュールではない。`physics/lagrange.ts` には置かない — id の命名は
ゲーム側の識別子の規約であって力学ではない(CODING-RULE 1.3)。

## 達成目標

すべて `src/` に対する検索で判定する。

1. `motionById` が **0 件**(`grep -rn "motionById" src`)。
2. `/-l\[1-5\]\$/` の正規表現リテラルが **`lagrange-id.ts` の 1 箇所のみ**
   (`grep -rn -- "-l\[1-5\]" src` の結果がそのファイルだけになる)。
3. ラグランジュ点 id を文字列連結で組んでいる箇所が **0 件**
   (`grep -rn -- '-l\${' src` が空。現在は `focus-markers.ts` 3 件、`line-pickables.ts` 1 件)。
4. `game: Game` と `celestialBodies` を両方受け取るメソッドが **0 件**
   (`grep -rn "game: Game, celestialBodies" src` が空。現在 7 件)。
5. `CelestialSystem` を持てる文脈で天体を `find((x) => x.id === …)` している箇所が **0 件**。
   残ってよいのは `physics/`(層として `CelestialSystem` を知れない)と、`CelestialSystem` が
   まだ存在しない構築時(`solar-system.ts:79` / `stage-debug-alt-system.ts:97`)だけ。
6. `npm run typecheck` と `npm run test`(全層)が通る。
7. マップビューの見た目・選択挙動が変わらない — 天体ラベル、ラグランジュ点ラベル、
   軌道物体一覧の並びと絞り込み、右クリックメニューの項目が変更前と同じ。

## 手順

### 手順 1. ラグランジュ点 id の正本を作る

**目的**: 生成と解釈が別々の場所に散っている状態を畳む。**この時点で挙動は変えない** —
正規表現の意味を変えず、呼び出し側を新モジュールへ向け直すだけ。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/celestial/lagrange-id.ts` | **(新規)** `lagrangeId(parentId, point)` / `isLagrangeId(id)` / `lagrangeParentId(id)` / `lagrangePointOf(id)` を置く。正規表現はこのファイル内に1本だけ持つ |
| `src/game/hud/object-groups.ts:10-24` | `LAGRANGE_ID` / `lagrangeParentId` / `lagrangePoint` を削除し、`lagrange-id.ts` から import する。`:43` の `LAGRANGE_ID.test` を `isLagrangeId` へ |
| `src/game/camera/focus-markers.ts:243,299,354` | `` `${id}-l${n}` `` を `lagrangeId(id, n)` へ |
| `src/game/pickable/line-pickables.ts:63` | `` `body:${secondary}-l${…}` `` を `` `body:${lagrangeId(secondary, …)}` `` へ |
| `src/game/map/visibility-policy.ts:38,123` | 直書きの `/-l[1-5]$/` を `lagrangeParentId` / `isLagrangeId` へ |
| `src/game/nav-target.ts:254,291` | 直書きの `/^(.+)-l([1-5])$/` を `lagrangePointOf` へ |
| `src/game/pickable/map-pickable-menu.ts:40,96` | `LAGRANGE_ID` の import 先を差し替え、`:96` の直書き `match` を `lagrangePointOf` へ |
| `src/game/hud/frame/anchor-zone.ts:10,74-75` | import 先の差し替えと `isLagrangeId` 化 |
| `src/game/hud/panels/physical-object-list-order.ts:1,94,95,200` | 同上。`lagrangePoint` → `lagrangePointOf` |
| `src/game/marker/pick-glyphs.ts:5,40` | 同上 |
| `src/game/pickable/map-context-actions.ts:13,498,643` | 同上 |

**達成条件と検証**

- `grep -rn -- "-l\[1-5\]" src` の結果が `src/game/celestial/lagrange-id.ts` だけ。
- `grep -rn -- '-l\${' src` が空。
- `grep -rn "object-groups" src` に `LAGRANGE_ID` / `lagrangeParentId` / `lagrangePoint` の
  import が残っていない。
- `npm run typecheck` / `npm run test:game`。
- マップビューを開き、地球-月と太陽-地球の L1〜L5 ラベルが変更前と同じ位置・同じ表記で出る。
  ラグランジュ点を右クリックし、メニューに「〜ラグランジュ点」の表記が出る。
  軌道物体一覧の絞り込みで「ラグランジュ点」を選び、点だけが残る。

### 手順 2. 星系への問い合わせを `CelestialSystem` へ移す

**目的**: `motionById()` の毎フレーム再構築を消し、`id → 天体` の引き先を `entitiesById` 一本に
する。**この時点で挙動は変えない** — 判定式はそのまま移す。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/celestial/celestial-system.ts` | 「天体の口」節の後ろに「系の所属」節を作り、`sameSystemIds(focusId)` / `ancestorsOf(focusId)` / `isPositionInFocusedSystem(focusId, position, pivot)` / `systemChainAt(cameraPos, pivot)` / `systemMembersAt(cameraPos, pivot)` をメソッドとして置く。内部の id 引きは `this.find(id)?.motion` を使い、`byId` の引き回しを削る。private ヘルパとして `chainFromNearest` / `membersFromChain` を持つ |
| `src/game/celestial/nearby-system-tracker.ts` | **(新規)** `system-membership.ts` から `NearbySystemTracker` を移す。`chainAt(celestialSystem, cameraPos, pivot)` / `membersAt(…)` として `CelestialSystem` を受け取る |
| `src/game/celestial/system-membership.ts` | **削除。** `CelestialClassLookup` 型は手順3で使わなくなるので一緒に消える |
| `src/game/celestial/celestial-entity/celestial-entity-def.ts:1-2` | 先頭コメントの「(system-membership 等)」を実在するモジュール名へ直す |
| `src/game/creative/orbit-form-fields.ts:1,21` | `sameSystemIds(celestialSystem.celestialMotions, selected)` → `celestialSystem.sameSystemIds(selected)` |
| `src/game/hud/frame/frame-controls.ts:8,104` | `systemMembersAt(this.celestialSystem.celestialMotions, …)` → `this.celestialSystem.systemMembersAt(…)` |
| `src/game/pickable/map-pickables.ts:19,33,97,188,200` | `isPositionInFocusedSystem` をメソッド呼びへ。`NearbySystemTracker` の import 先を差し替え |
| `tests/game/map-visibility.test.ts:11-13` ほか | `isPositionInFocusedSystem` / `systemChainAt` / `systemMembersAt` の呼びを `PARTS.system` のメソッドへ差し替え |

**達成条件と検証**

- `grep -rn "motionById\|system-membership" src tests` が空。
- `npm run typecheck` / `npm run test:game`(`tests/game/map-visibility.test.ts` が通る)。
- マップビューで衛星(例: 月)にフォーカスし、地球周回・月周回の艦だけが残り土星系が消える
  挙動が変更前と同じ。カメラを土星圏へ運び、系のラベルが明滅せずに切り替わる。

### 手順 3. `alwaysFullyVisibleIds` を `CelestialSystem` 引きへ

**目的**: 手順2で消えた `motionById` の最後の利用元を畳み、`CelestialClassLookup` という
「表示クラスを外から注入する」口を無くす。表示クラスの正本は `CelestialEntity.bodyClass` である。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/map/visibility-policy.ts:50-84` | シグネチャを `alwaysFullyVisibleIds(celestialSystem, focusId, nearbyIds, toggles)` へ変え、`byId` を `celestialSystem.find()` に、`bodyClass(id)` を `celestialSystem.find(id)?.bodyClass ?? 'planet'` に置き換える |
| `src/game/map/visibility-policy.ts:110-112` | コンストラクタの呼び出しから `motions` と bodyClass クロージャを外す |
| `tests/game/map-visibility.test.ts:28-51` | `bodyClass` ヘルパを削除し、`alwaysFullyVisibleIds(PARTS.system, …)` を呼ぶ。`visibleBodyIds()` の中の `bodyClass(m.id)` も `PARTS.system.entityOf(m.id).bodyClass` へ |

**達成条件と検証**

- `grep -rn "CelestialClassLookup" src tests` が空。
- `npm run typecheck` / `npm run test:game`。
- **テストの期待値が変わっていないことを確認する** — 差し替え前は運動の分類から引いた
  `celestialClassOfKind`(準惑星・小天体が `planet` に落ちる)、差し替え後は実際の `bodyClass`
  なので、`dwarf` / `smallBody` のトグルが判定に入る。既定トグルではどちらも ON なので結果は
  同じはずだが、**テストのアサーションを1つも書き換えずに通ること**を条件とする。書き換えが
  要るなら決定3の前提が崩れているので、手順を止めてユーザーへ報告する。

### 手順 4. `FrameAnchors` の id 引きを O(1) にする

**目的**: 座標系解決の経路が毎フレーム 98 体を線形走査している。`CelestialSystem` を直接持たせ、
`bodies` の差し込みをやめる。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/frame-anchors.ts:27,41-45,52` | `bodies` フィールドへの毎フレーム差し込みをやめ、コンストラクタで `CelestialSystem` を受け取る。`bodies` getter は `celestialSystem.celestialMotions` を返す(`FrameAnchorSource` の契約は維持 — `map-camera.ts:214-217` が全走査で読む)。`update()` は `bodiesPivot` とフレーム番号だけを進める。`:52` の `find` を `celestialSystem.find(id)?.motion.stateAt(…)` へ |
| `src/game/game.ts:155-159` | `new FrameAnchors(…)` に `celestialSystem` を渡す |
| `src/game/game.ts:330,519-520` | `frameAnchors.update(celestialMotions, displayTime)` の第1引数を落とす |
| `src/physics/attractor.ts:98-110` | `bodyAnchorSource` の 2 回の `find` を、クロージャ生成時に組む `Map` 1 個へ畳む |

**達成条件と検証**

- `grep -n "bodies.find" src/game/frame-anchors.ts src/physics/attractor.ts` が空。
- `npm run typecheck` / `npm run test:game` / `npm run test:physics`。
- マップビューで座標系を「地球回転系」「月回転系」「@navTarget 公転系」へ順に切り替え、
  カメラの向きと軌道線の基準が変更前と同じ。航法ターゲットを外して `@navTarget` が
  解決できない状態にし、猶予のあいだ直前の基準を保つ挙動が変わらない。

### 手順 5. HUD への `celestialBodies` 二重渡しを外す

**目的**: `game` を受け取っている HUD のメソッドが、`game.celestialSystem.celestialMotions` と
同じ配列をもう1つの引数で受け取っている。引数が2つあると「別物かもしれない」と読めてしまう。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/view-hud-controller.ts:11,18,26,31` | `sync(game)` へ。中で `game.celestialSystem.celestialMotions` を引く |
| `src/game/hud/hud.ts:88-90` | `syncOrbitAnalysis(game)` へ |
| `src/game/hud/orbit/orbit-analysis-window.ts:229,459` | `sync(game)` / `resolveApproachTarget(game)` へ。`:463` の `find` は `game.celestialSystem.find(id)?.motion` へ(達成目標5) |
| `src/game/hud/orbit/orbit-panel.ts:56` | `sync(game, hideInOverview)` へ |
| `src/game/hud/panels/target-panel.ts:44` | `sync(game)` へ |
| `src/game/game.ts:518` 周辺 | `celestialBodies` を渡していた呼び出しから引数を外す。ローカル変数 `celestialBodies` は他でも使われているので消さない |

`orbit-analysis-data.ts:126` / `orbit-info.ts:61` / `orbit-projection-tab.ts:32` は `Game` を
受け取らない純関数側なので**そのまま**にする(配列を走査する引数として正しい)。

**達成条件と検証**

- `grep -rn "game: Game, celestialBodies" src` が空。
- `npm run typecheck` / `npm run test:game`。
- 軌道解析ウィンドウを開き、接近タブが航法ターゲット(天体・艦の両方)で従来どおり出る。
  軌道パネル・ターゲットパネルの表示値が変わらない。

### 手順 6. 残りの id 線形検索を `CelestialSystem` 経由へ

**目的**: 達成目標5を満たす。`CelestialSystem` が手元にあるのに配列を線形走査している箇所を潰す。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/celestial/celestial-system.ts:356` | 自分の `entitiesById` を持っているのに `celestialBodies.find` している。`this.find(focusId)?.motion` へ |
| `src/game/nav-target.ts:250` | 直前の行で `celestialSystem.find(id)` を呼んでいるので、その結果を使い回す |
| `src/game/orbit-reference.ts:56` | `celestialSystem.find(this.mode)?.motion` へ |
| `src/game/pickable/map-property-rows.ts:192-193` | `this.celestialSystem.find(…)?.motion` へ |
| `src/game/stages/creative-stage.ts:390` | `this._celestialSystem.motionOf(form.celestialBody)` へ(非 null 断定が消える) |
| `src/game/stages/stage-debug-alt-system.ts:117` | `this._celestialSystem.motionOf(PRIMARY_ID)` へ |
| `src/game/creative/duplicate-form.ts:35,39` | `celestialBodies` に加えて `CelestialSystem` を受け取り `find` を置き換える。呼び出し元は `creative-stage.ts:32` の1箇所のみ |

`src/physics/attractor.ts` / `src/physics/lagrange.ts:106-107` / `src/physics/ephemeris/pack-evaluator.ts:175`
は `physics/` 層で `CelestialSystem` を知れないため**そのまま**。
`src/game/celestial/solar-system/solar-system.ts:79` と `src/game/stages/stage-debug-alt-system.ts:97`
は `CelestialSystem` の構築中なので**そのまま**。
`src/render/pipeline/lighting/planet-light-select.ts:34` は id ではなく `kind` で探しているので対象外。

**達成条件と検証**

- `grep -rn "find((.) => .\.id ===" src/game` の結果が、上記の「そのまま」に挙げた2件だけ。
- `npm run typecheck` / `npm run test`(**全層** — この手順で締めるため)。
- クリエイティブステージで物体を配置し、既存物体の複製フォームが従来どおり近地点/遠地点高度を
  埋める。デバッグ架空星系ステージ(選択画面で `E`)が起動し、自機が `zephyrus` 低軌道に出る。
- マップビューで天体にフォーカスし、太陽遮蔽(食)の見え方が変わらない。

## 見積り

### 作業量

手順ごとの「変更が必要な箇所」の行数から、編集箇所の総数で見積もる。

| 手順 | 編集ファイル | 編集箇所 |
| --- | --- | --- |
| 1 | 11(うち新規 1) | 約 25 |
| 2 | 8(新規 1・削除 1) | 約 15 + 移動 95 行 |
| 3 | 2 | 約 6 |
| 4 | 4 | 約 8 |
| 5 | 6 | 約 12 |
| 6 | 7 | 約 9 |

新規ファイル 2 本(`lagrange-id.ts` 約 35 行、`nearby-system-tracker.ts` 約 45 行)、
削除 1 本(`system-membership.ts` 161 行)。`celestial-system.ts` は 464 → 約 550 行。

### 実行時のコスト削減(手順2)

`map-pickables.ts` は候補1件ごとに `isPositionInFocusedSystem` を呼び、その中で
`motionById(motions)` が 98 体ぶんの `Map` を組み直している。

- 登録天体 98 体(`DEVELOP/SPEC/CELESTIAL.md` 1節)。
- 候補数 = 天体 98 + ラグランジュ点(4系 × 最大5点 = 20)+ 艦・拾得物 ≒ 130 件。
- 130 件 × 98 エントリ = **12,740 回の Map 挿入 / フレーム**、加えて `Map` オブジェクト
  130 個 / フレームの割り当てと GC 圧。
- 手順2 の後はこれが **0** になる(`entitiesById` を引くだけ)。

手順4 の削減は 1 フレームあたり `98 × 約10 回 = 980 回`の比較 → 10 回のハッシュ引き。
桁が2つ小さいので、**手順4 は正しさの統一が目的であって速度が目的ではない。**

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| ラグランジュ点 id の正規表現を1本に畳むとき、`^(.+)-l([1-5])$` (アンカーあり)と `-l[1-5]$` (末尾のみ)を同一視してしまう。前者は親 id が空でないことを要求する | `-l1` という id が親 `''` のラグランジュ点として解決され、天体でない対象が天体扱いになる | 手順1 |
| `nav-target.ts` は「同じ形の名前を持つ船を天体として誤解決しない」ため、副天体が実在する公転天体かを別途確かめている(`:286-293` のコメント)。`lagrangePointOf` へ寄せる際にこの確認を落とす | 艦に `xxx-l1` という名前を付けると天体として解決され、航法ターゲットの法線が誤る | 手順1 |
| `alwaysFullyVisibleIds` の表示クラス取得を `celestialClassOfKind`(運動の分類)から `bodyClass`(編集上の分類)へ変える。両者は準惑星・小天体で食い違う | マップの天体ラベルが出る/出ない条件が静かに変わる。既定トグルでは同じだが、`dwarfName` / `smallBodyName` を切ったときだけ差が出る | 手順3 |
| `FrameAnchors.bodies` を getter 化すると、`update()` を呼ぶ前でも非空を返すようになる。`map-camera.ts:214` は `bodies.length > 0` で初期化前を判定している | 初期化前のフレームで `bodiesPivot = 0` のまま天体を引き、カメラの注視点が 1 フレームだけ飛ぶ | 手順4 |
| `CelestialSystem` は `three/webgpu` を import する。`system-membership.ts` は THREE 非依存で、node のテストが直接読んでいた | メソッドへ移した後、テストが `CelestialSystem` 経由になる。`tests/physics/test-helpers.ts` が既に `solarSystem()` を呼んでいるので通るはずだが、通らなければ決定3を覆して代替案(第1引数を `CelestialSystem` にするだけ)へ切り替える | 手順2 |
| `celestial-system.ts` が 550 行になり、CODING-RULE 1.2 の 500 行基準を超える | 描画同期(`build` / `sync` / `dispose` と private 群、約 200 行)を切り出す別のリファクタリングが要る。**この計画ではやらない** — 集合・検索の統一とは別の問題なので、超えた行数を根拠に手順2を縮めない | 手順2 |
| `map-pickables.ts:188` と `:200` は `??` で前段が未確定のときだけ `isPositionInFocusedSystem` を呼ぶ。メソッド化のついでに呼び出し回数を「減らそう」として条件を畳む | 選べる対象と描かれる対象が別の判定から出るようになり、クリックできるのに見えない天体が生まれる | 手順2 |
| `bodyAnchorSource` の呼び出し 5 箇所のうち 4 箇所は空配列を渡している(`bodyAnchorSource([], t)`)。Map 化しても実質何も速くならない | 手順4 の payoff を過大に見積もる。Map 化の目的は二重 `find` の除去であって速度ではない | 手順4 |
| 手順5 で HUD の引数を落とすとき、`game.celestialSystem.celestialMotions` を呼び出しのたびに引き直す | getter を毎フレーム複数回叩くが、`CelestialSystem.celestialMotions` は構築時に確定した配列を返すだけなので実害はない。**配列を作り直す実装に変えない** | 手順5 |

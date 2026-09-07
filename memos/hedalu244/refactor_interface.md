# 段 C の計画 — 指標を「近傍」へ入れ替え、hub を面で受け切る

測定時点: `ecc730f0`(branch `workspace4`)。比較の基準点は着手前の `e66c32fe`。
以下の数字は `src/` の相対 import を有向グラフに組んで機械的に出したもので、**コードが動けば
古くなる。** 測り直しは `npm run dep-metrics`(`--against <ref>` で ref の木と、`--file <path>`
でファイル単位、`--merge <面>=<実装>` で「面を実装へ畳んだ場合」と比べられる)。

**手順1〜3 は実施済み。** そこで確定した前提:

- 計測は `tools/dep-metrics.mjs` に入った。**以降の手順でこのスクリプトを触らない** —
  途中で実装が変わると、手順どうしの数字が比較できなくなる。
- `CelestialBodies` に `findMotion` / `bodyClassOf` / `starId` / `originId` を足し、
  `CelestialSystem` を型として受けるファイルは **33 → 6**。`ctx2` 平均は **4,400 → 4,099 行**。
- **面の判定は消費者にだけ当たり、生産者には当たらない。** `stage.ts` は
  `createCelestialSystem` が具象を返すので面へ移せない。**「その型を作る側」は具象を知っていて
  よい**(`CODING-RULE` 1.3)。
- **面へ移せるかは、そのファイルが渡す先の一番広い型で決まる。** 自分では1メンバも使わない
  ファイル(`anchor-zone` / 座標系パネル2枚 / `map-view`)が、渡した先の都合で具象に縛られていた。
  **「使っているメンバ」で移せるファイルを数えると外れる** — 手順5〜7 では渡し先から先に潰す。

---

## 目的

段 A(型の置き場所)・段 B(具象型で受けるのをやめる)の効果を**正しい指標で測り直し**、
そのうえで段 C を実施する。

段 A・B の評価に使っていた「強連結成分の大きさ」は、**この規模のコードでは効果を測れない
指標だった。** 153 → 150 という数字を見て「型の工夫で取れるものは取り切った」と結論したが、
これは誤りである。近傍(下記の `ctx`)で測り直すと、段 A・B は**全ファイルの 4 割を改善して
いた。**

| 指標 | `e66c32fe` | `ecc730f0` | 変化 |
| --- | --- | --- | --- |
| 強連結成分(全辺) | 153, 9, 4, 2, 2 | 150, 2, 2, 2 | **-2%** |
| 強連結成分(値の辺) | 22, 3, 2 | 8, 3, 2 | -64% |
| 辺の総数 / うち型のみ | 3,008 / 990 | 3,068 / 1,078 | **+60 / +88** |
| **ctx2 中央値** | 1,323 行 | 908 行 | **-31%** |
| **ctx2 平均** | 5,587 行 | 4,400 行 | **-21%** |
| **ctx2 p90** | 17,906 行 | 14,495 行 | -19% |
| ctx3 中央値 / 平均 | 1,810 / 12,766 | 1,032 / 10,030 | -43% / -21% |
| ctx1 中央値 / 平均 | 548 / 1,147 | 450 / 998 | -18% / -13% |

ファイル単位では **212 個が改善、39 個が悪化(最大 +365 行)、264 個が不変。** 改善の上位は
すべて「塊の内側に居るから効かなかった」と書いていたファイルである:

```
game/pickable/object-pickable.ts        27,163 → 8,387   (-18,776)
game/marker/lagrange-point-marker.ts    18,418 → 5,407   (-13,011)
game/pickable/body-search-text.ts       12,846 → 1,467   (-11,379)
game/dynamic/dynamic-entity/base.ts     33,971 → 22,631  (-11,340)
game/player/player.ts                   35,108 → 24,885  (-10,223)
```

**段 A・B は効いていた。効いていないと読めたのは指標のせいである。**

---

## 決めたこと

### 1. 指標を「強連結成分」から「近傍 `ctx_k`」へ入れ替える

**`ctx_k(f)` = ファイル `f` から import 辺を `k` 歩以内で到達できるファイルの総行数**(`f` 自身は
除く)と定義する。全ファイルの中央値・平均・p90 で見る。

なぜこれか:

- **循環の有無は「読む量」を測っていない。** 150-SCC の中に居るファイルは、塊が解けるまで推移的
  依存が飽和したままなので、内側でどれだけ責務を移しても数字が動かない。上の表で SCC が -2% しか
  動いていないのに ctx2 が -31% 動いたのがその証拠。**塊の中の改善は `k=1,2,3` でしか見えない。**
- **「循環を切るためだけの `import type`」を正しく罰する。** 型のみ辺も 1 辺として数える —
  読む手間は `type` でも値でも変わらないため。実際、段 A・B で辺は +60 本、うち型のみは +88 本
  **増えた。** それでも ctx が下がったのは、増えた辺の行き先が葉だったから。**辺の本数ではなく、
  辺を辿った先の行数で測れば、両者を1つの数字で扱える。**
- `k=1` は「その型を手で追うのに開くファイル」、`k=2` は「その面が何であるかを納得するのに開く
  ファイル」に対応する。`k=∞` は塊の中で飽和するので、**塊から出たかどうかの判定にだけ使う。**

**この指標は手順1でリポジトリへ入れる。** 使い捨てスクリプトのままでは、次に同じ議論をするときに
また作り直すことになり、前後比較が別実装になって数字が比較できなくなる。

### 2. 実装が1つしかない面でも、実装とは別のファイルに置く

段 A・B で作った面を「実装の隣へ畳んだら近傍がどうなるか」を機械的に試した。**全件で悪化した。**

| 畳む案 | 受け手数 | ctx1 | ctx2 | ctx∞ |
| --- | --- | --- | --- | --- |
| `CelestialBodies` → `celestial-system.ts` | 29 | +16,819 | **+147,895** | +196,261 |
| `OrbitingObject` → `dynamic-entity.ts` | 22 | +11,659 | +62,972 | +132,107 |
| `Notifier` → `hud.ts` | 20 | +3,241 | +55,204 | +135,779 |
| `PickCandidate` → `object-pickable.ts` | 4 | +325 | +2,749 | +66,114 |
| `InspectedObject` → `object-pickable.ts` | 3 | +1,481 | +7,288 | **-35** |
| `MapPickable` → `object-pickable.ts` | 1 | +943 | +5,287 | **-32** |
| `pickable-listing` → `listed-object.ts` | 11 | +163 | **-12** | -12 |

**「増える見込みがないなら実装の隣でよいのではないか」への答えは、測ると no。** 面が軽いのは
中身が小さいからではなく、**実装が引いている依存を引かずに書けるから**であって、実装ファイルへ
入れた瞬間その性質は失われる。`Notifier` は 8 行・実装1つ・値 import ゼロだが、20 ファイルを
HUD の DOM 世界から切り離している。**細切れかどうかは行数ではなく、依存の切れ目に置けているかで
判断する。**

ただし表の下 3 行は違う話をしている。`InspectedObject` と `MapPickable` は畳んでも ctx∞ が
動かない(±35 行) — **1〜2 歩の絶縁しか買っていない。** とくに `MapPickable` は、
**引数の型として受けている消費者が 0 である**(唯一の import 元は `object-pickable.ts` で、
`ObjectPickable` を組むためだけに引いている)。`map-picking.ts` は `MapPickable` ではなく
`ObjectPickable` を受けている。

**よって `CODING-RULE.md` 1.12 の判定に4つ目を足す:**

> - **受け手が居るか。** その面を**引数・フィールドの型として受ける消費者**が実際に居るか。
>   union の材料としてしか使われていない面は、面ではなく見出しである。

`pickable-listing.ts`(12 行)は畳んでも ctx が動かない — **どちらでもよいので、動かさない。**
churn だけが残る変更はしない。

### 3. `CelestialMotions` と `CelestialBodies` の平行は解消する

**「2つあるのは過剰ではないか」は当たっている。ただし理由は予想と違う。**

- **`physics/` の内側に `CelestialMotions` の利用者は1つも無い。** 定義されているのが
  `physics/celestial-body.ts` というだけで、消費者は全部 `game/` に居る。**フォルダ境界は
  この2つを分ける根拠になっていない。**
- **消費者 6 のうち 5 が、3 メンバのうち 1 つしか使っていない。**

```
game/dynamic/substep-celestial-bodies.ts   celestialMotions gravityMotions atmosphereMotions
game/dynamic/simulator.ts                  atmosphereMotions (+ substep へそのまま渡す)
game/plan/plan.ts                          celestialMotions
game/targeter.ts                           celestialMotions
game/view/combat-view.ts                   celestialMotions
game/stages/stage-utils/wave-attack.ts     celestialMotions
```

- **1 メンバだけの写しがすでに別に生えている。** `game/dynamic/arc-celestial-bodies.ts` の
  `FutureCelestialBodyProvider = { readonly celestialMotions: readonly CelestialBody[] }` が
  それで、**コード自身が「本当に要る面は 1 メンバ」と投票している。**

決めたこと:

1. **1 メンバしか使わない 4 ファイルと `FutureCelestialBodyProvider` は、面をやめて
   `readonly CelestialBody[]` を直接受ける。** 配列より狭い面は無い。
2. **3 メンバ全部を要るのは `simulator` → `substep` の 1 経路だけ**なので、面自体は残す。ただし
   `CelestialBody` の複数形が2つある状態は解消する — **`FrameCelestialBodies` へ改名し、
   `game/celestial/celestial-bodies.ts` へ移して `CelestialBodies extends FrameCelestialBodies`
   とする。** 「フレームに1組の顔ぶれ」という `substep` 側の呼び名に合わせ、既存の
   `SubstepCelestialBodies` / `ArcCelestialBodies` と語形も揃う(`CODING-RULE` 2.2「天体は
   `celestialBody`」)。ファイルは1つ減る。
3. **ただしこの3つは ctx をほとんど動かさない。** 4 ファイルはどのみち要素型 `CelestialBody` の
   ために `physics/celestial-body.ts` を引き続ける。**これは近傍のための変更ではなく、概念の数を
   減らすための変更である** — そう自覚したうえでやる。

### 4. 段 C の目標を「値の循環を切る」から「近傍を縮める」へ置き換える

残った値循環は 8 / 3 / 2 の3つ。うち 3 と 2 の2つ、および 8 の中の 1 本は**定数と共有ヘルパの
置き場所の問題**で、小さく切れる(手順8)。残る 8 ファイルの相互所有(自機・武装・弾・破片・敵が
互いを `new` している)は**設計の作り替えで、この計画には入れない** — 面では直らないうえ、
`memos/hedalu244/refactor_game.md` が扱っている問題と同じものなので、そちらと一緒に決める。

かわりに近傍をいちばん縮めるのは、**まだ具象クラスで受けられている hub を面で受け切ること。**
機械的に試した結果:

| 施策 | 対象 | ctx1 | ctx2 | ctx∞ | 全体平均 ctx2 |
| --- | --- | --- | --- | --- | --- |
| `CelestialSystem` → `CelestialBodies`(29 ファイル) | 29 | -16,182 | **-152,558** | -262,607 | 4,400 → 4,050 |
| `MarkerSlots` を新設 | 21 | -9,960 | -28,584 | -22,317 | 4,400 → 4,275 |
| `EntityRoster` を新設 | 16 | -6,680 | -44,145 | -32,010 | 4,400 → 4,285 |
| `HudLayers` を新設 | 8 | -1,812 | -29,515 | -86,234 | 4,400 → 4,316 |

`HudLayers` は ctx2 の減りは中位だが、**ctx∞ の全体平均を 24,439 → 21,403(-12%)と最も大きく
動かす** — `Hud` を受けることが、多くのファイルを描画と DOM の世界へ引きずり込んでいる。

---

## 達成目標

全手順の実施後、次が全部満たされていること。

1. **(達成)** `npm run dep-metrics` が走り、ctx1/ctx2/ctx3 の中央値・平均・p90 と、
   指定ファイルの内訳を出す。
2. **(達成)** `CelestialSystem` を**型として**受けているファイルが **33 → 6**
   (`git grep -l "import type { CelestialSystem }" src`)。残る 6 は、星系を作る側
   (`stage.ts`)、見た目の一覧が要る側(`celestial-markers` / `line-pickables` /
   `celestial-entity`)、宣言の全体が要る側(`object-placer-panel`)、それを渡すだけの側
   (`map-view`)。**`object-placer-panel` は `CelestialBodyDef` 全体を要る** —
   面に `defOf` を足すと `celestial-bodies.ts` の ctx1 が 796 → 約 1,770 行に膨れて
   55 ファイル全部が払うので、1ファイルのために足さない。
3. `MarkerManager` を型として受けているファイルが **21 → 7 以下**、`Hud` が **9 → 3 以下**、
   `DynamicSystem` が **16 → 5 以下**。
4. `FutureCelestialBodyProvider` と `CelestialMotions` が `src/` と `tests/` から **0 件**。
5. `MapPickable` を**引数の型として**受けるファイルが **1 以上**(`map-picking.ts`)。
   0 のままなら手順9の判断で `object-pickable.ts` へ畳む。
6. 値の辺だけで見た強連結成分が **8 の1つだけ**(3 と 2 が消える)。
7. **ctx2 の全ファイル平均が 4,400 → 3,900 行以下。** 上表の個別シミュレーションの和は -674 で
   3,726 になるが、施策どうしの重なりを見込んで割り引いた値を目標にする。
8. `npm run typecheck` と `npm run test` が通る。

---

## 手順

### 手順 4. `CelestialMotions` を畳む

**目的** — 「決めたこと 3」の実施。**近傍ではなく概念の数を減らす手順で、ctx はほとんど動かない。**
挙動は変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `physics/celestial-body.ts` | `CelestialMotions` を削除 |
| `game/celestial/celestial-bodies.ts` | `FrameCelestialBodies`(3 メンバ)を定義し、`CelestialBodies extends FrameCelestialBodies` |
| `game/dynamic/simulator.ts` / `substep-celestial-bodies.ts` | `FrameCelestialBodies` を受ける |
| `game/plan/plan.ts` / `game/targeter.ts` / `game/view/combat-view.ts` / `game/stages/stage-utils/wave-attack.ts` | 引数を `readonly CelestialBody[]` へ。呼び出し元で `.celestialMotions` を渡す |
| `game/dynamic/arc-celestial-bodies.ts` | `FutureCelestialBodyProvider` を削除、`readonly CelestialBody[]` を受ける |
| `game/dynamic/predicted-arc.ts` / `dynamic-entity/dynamic-entity.ts` | 同上に追随 |
| `tests/game/predicted-arc.test.ts` / `tests/physics/window-agreement.test.ts` | `earthOnlyProvider` 等を配列へ |

**達成条件と検証** — `npm run typecheck` / `npm run test:game` / `npm run test:physics`。
`git grep -n "CelestialMotions\|FutureCelestialBodyProvider" src tests` が **0 件**。

---

### 手順 5. `MarkerSlots` を新設する

**目的** — `MarkerManager`(377 行、ctx1 1,353)を型として受けている 21 ファイルのうち 15 は、
マーカーを置く・消す・出ているか訊くだけである。**挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `game/marker/marker-slots.ts`(新規) | `set` / `setPosition` / `setDirection` / `shows` / `hide` / `fadeOut` / `remove` の面。引く型は `Vec3` と `ProjectFn` だけなので葉になる |
| `game/marker/marker-manager.ts` | `implements MarkerSlots` |
| 下記 15 ファイル | 型を `MarkerSlots` へ |

`shows` しか使わない 6 ファイル(`celestial-entity.ts` / `ammo-pickup.ts` / `enemy.ts` /
`rcs-fuel-pickup.ts` / `lagrange-point-marker.ts` / `empty-space-pickable.ts`)、
置く系 9 ファイル(`geostationary-overlay.ts` / `base.ts` / `celestial-markers.ts` /
`celestial-sub-labels.ts` / `equator-node-marker-pair.ts` / `lead-markers.ts` /
`plan-display.ts` / `plan-guide.ts` / `player-markers.ts`)。

残す 6(`game.ts` は所有者、`player.ts` は `sync`/`dispose`、`grouped-markers.ts` は内部、
`targeter.ts` / `map-view.ts` は `combatMarkers`、`orbit-point-marker.ts` は `setNodePosition`)。

**達成条件と検証** — `npm run typecheck` / `npm run test:game`。
`git grep -c ": MarkerManager" src` が 7 以下。ctx2 合計 503,349 → 474,765 付近。
**実行時の見た目は変えていないので描画の確認は要らない。**

---

### 手順 6. `HudLayers` を新設する

**目的** — `Hud`(ctx1 3,502 / ctx2 21,861)を受けている 8 ファイルが要るのは、
**DOM の取り付け先と `Notifier` だけ**である。`overlay-layer.ts` と `overlay-manager.ts` は
どちらも import ゼロの葉なので、面は完全な葉になる。**挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `game/hud/hud-layers.ts`(新規) | `layers: OverlayLayers` / `overlayManager: OverlayManager` / `mapRoot: HTMLElement` / `combatRoot: HTMLElement` / `root: HTMLElement` |
| `game/hud/hud.ts` | `implements HudLayers`(既に全部 public) |
| `pickable/orbit-line-windows.ts` / `pickable/part-windows.ts` | `HudLayers` だけで足りる |
| `camera/camera-system.ts` / `pickable/map-picking.ts` / `plan/plan-editor.ts` | `HudLayers` + `Notifier` の2引数へ |
| `stages/stage.ts` | `combatRoot` を `HudLayers` から、`hint`/`toast` を `Notifier` から |

残す 3(`game.ts` は所有者、`object-windows.ts` は `enemiesPanel`/`targetPanel`、
`view-manager.ts` は `setView`)。

**達成条件と検証** — `npm run typecheck` / `npm run test:game`。
`git grep -c ": Hud\b" src` が 3 以下。ctx∞ の全体平均が 24,439 → 21,500 付近まで落ちる。

---

### 手順 7. `EntityRoster` を新設する

**目的** — `DynamicSystem`(ctx2 24,107)を受けている 16 ファイルのうち **11 は `all` しか
使っていない。** 面は `DynamicEntity` を引くので葉にはならないが、ctx2 は大きく減る
(シミュレーションで -44,145)。**挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `game/dynamic/entity-roster.ts`(新規) | `readonly all: readonly DynamicEntity[]` |
| `game/dynamic/dynamic-system.ts` | `implements EntityRoster`(`EntityRegistry` と並ぶ2つ目の面) |
| 下記 11 ファイル | 型を `EntityRoster` へ |

```
dynamic/predictor.ts        hud/panels/enemies-panel.ts   hud/view-badge.ts
lines/entity-line-manager.ts nav-target.ts                pickable/combat-pick.ts
pickable/line-pickables.ts  pickable/object-pickables.ts  pickable/object-windows.ts
targeter.ts                 dynamic/simulator.ts(`cleanup` も要るので要判断)
```

`next-event-time.ts`(`collectionRevision`)、`control-selection.ts`(`controllables`/`remove`)、
`logistics.ts` / `stage.ts`(`add`/`spawnWhenReady` = `EntityRegistry` 側)、`game.ts`(所有者)は
残す。**`stage.ts` と `logistics.ts` は `EntityRegistry` + `EntityRoster` の2面で受けられるか
確かめる** — できるなら `DynamicSystem` の受け手は 3 まで落ちる。

**達成条件と検証** — `npm run typecheck` / `npm run test:game`。
`git grep -c ": DynamicSystem" src` が 5 以下。

---

### 手順 8. 小さい値循環を3つ切る

**目的** — 定数と共有ヘルパが hub 側に置かれているために閉じている輪を切る。
**どれも定数/関数の引っ越しだけで、挙動は変えない。**

**変更が必要な箇所**

| 輪 | ファイル | 何をするか |
| --- | --- | --- |
| `frame-controls ↔ camera-frame-panel / trajectory-frame-panel` | `game/hud/frame/frame-panel.ts`(新規) | `buildPanel` を移す。両パネルと `frame-controls` はここから引く |
| `display-window-manager ↔ predict-panel` | `game/display-window-duration.ts`(新規) | `DisplayDurationKey` / `DisplayPastDurationKey` / `DISPLAY_DURATION_MAX` / `APERIODIC_ARC_DURATION` を移す |
| `player → hud/ammo-status → fire-control` | `game/player/ammo-spec.ts`(新規) | `MAG_ROUNDS` を移す。`ammo-status.ts` は ctx2 5,710 → 0 付近の葉になる |

**達成条件と検証** — `npm run typecheck` / `npm run test:game`。
`npm run dep-metrics` の値の辺の強連結成分が **8 の1つだけ**になる。
`frame-controls.ts` は手順3で `CelestialBodies` へ移っているので、`CelestialSystem` は残らない。

---

### 手順 9. 面の棚卸し — 受け手の居ない面を始末する

**目的** — 「決めたこと 2」の判定4を、いま在る面へ当てる。手順5・6で `MarkerManager` と `Hud` が
軽くなり、`MapPickable` / `InspectedObject` が葉になれる条件が変わっているので、最後に置く。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `DEVELOP/CODING-RULE.md` 1.12 | 判定4「受け手が居るか」を追記 |
| `game/pickable/map-picking.ts` | `ObjectPickable` ではなく `MapPickable` を受ける(`MapPickable` に初めて受け手ができる) |
| `game/pickable/map-pickable.ts` | `shownOnMap(markers: MarkerSlots)` へ(手順5の面) |
| `game/pickable/inspected-object.ts` / `map-pickable.ts` | 残る重い引数型(`ObjectWindows` ctx2 30,966 / `PlanEditor` 16,823 / `ControlSelection` 13,304)を測り直し、**葉になるなら面を割る、ならないなら `object-pickable.ts` へ畳む**。`ControlSelection.current` は `Controllable`(ctx2 16,378)を返すので、`Controllable` を先に狭めない限り葉にはならない — **その場合は畳む** |
| `game/pickable/pickable-listing.ts` | **動かさない**(畳んでも ctx2 が -12 しか動かない) |

**達成条件と検証** — `npm run typecheck` / `npm run test:game`。
`git grep -n "MapPickable" src` に、`object-pickable.ts` 以外の引数型としての用例が 1 件以上ある
(または `map-pickable.ts` が消えている)。`npm run dep-metrics` の ctx2 全体平均が **3,900 以下**。

---

## 見積り

手順ごとの編集箇所を、grep で数えた実数から出す。

| 手順 | 新規 | 編集ファイル | 編集箇所 | 見込む ctx2 全体平均 |
| --- | --- | --- | --- | --- |
| 1〜3(実測) | 1(`tools/`) | 31 | 面 4 メンバ + 定数1個の移動 + 約 60 箇所 | **4,099**(見込み 4,050) |
| 4 | 0(1 減) | 10 + テスト 2 | 約 20 | 4,099(変化なし) |
| 5 | 1 | 16 | 15 ファイル × 2 + 面 7 メンバ | 3,970 |
| 6 | 1 | 7 | 6 ファイル × 2〜3 + 面 5 メンバ | 3,890 |
| 7 | 1 | 12 | 11 ファイル × 2 + 面 1 メンバ | 3,780 |
| 8 | 3 | 8 | 定数・関数 6 個の移動 | 3,780 |
| 9 | 0(0〜2 減) | 4 + 規約 1 | 判断込み | 3,740 |

最終行の 3,740 は、手順1〜3 の実測 4,099 から手順5〜7 の個別シミュレーション(-359)を引いたもの。
**施策どうしで到達先が重なるので実際はこれより悪くなる** — 達成目標は 3,900 に置いてある。

`ctx∞` の全体平均は 24,439 → 21,000 付近(手順6 の -3,036 が支配的)。

---

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `findMotion`(null を返す)と `motionOf`(未登録で例外)の使い分けを取り違える | 未登録 id で例外になっていた箇所が黙って `null` を流し、マーカーや軌道線が**無言で消える** | 手順3。差し替えた 44 箇所を、元が `find(id)?.motion`(null 許容)か `entityOf(id).motion`(例外)かで分けて確認する |
| `bodyClass` / `starId` の追加で `celestial-bodies.ts` が `CelestialEntity` を引く | 面が葉でなくなり、手順2・3 の効果が丸ごと消える | 手順3。`npm run dep-metrics --file src/game/celestial/celestial-bodies.ts` の ctx1 が 900 を超えたら失敗 |
| `MarkerSlots` の `set` / `setPosition` / `setDirection` は引数が 12〜14 個ある。面へ写すと**契約の写し**になり、両方を直す手間だけが増える | `CODING-RULE` 1.12「契約の写しは負債」に抵触 | 手順5。**引数列の整理はこの計画でやらない** — 写しになるのを承知で写し、整理は別途 |
| `Hud` を `HudLayers` + `Notifier` の2引数に割ると、引数が増えただけで近傍が減らない場合がある | 手数の割に効果ゼロ | 手順6。1ファイル直すごとに `dep-metrics --file` で ctx2 を確認し、下がらないファイルは元に戻す |
| `EntityRoster` は `DynamicEntity` を引くので葉にならない | 「葉に置けるか」の判定2 に落ちる面を作ることになる | 手順7。ctx2 が -44,145 動く**見込みだけ**が根拠なので、実測が -20,000 を下回ったら手順ごと取り消す |
| `CelestialMotions` → `FrameCelestialBodies` の改名がテストへ波及 | `npm run test` だけが落ちて `typecheck` は通る | 手順4。`tests/` の 2 ファイルを変更箇所に入れてある |
| ctx を下げること自体が目的化して、受け手の居ない面が増える | 段 A・B と同じ失敗を、別の指標で繰り返す | 手順9。判定4 を規約へ入れてから棚卸しする |
| 手順の途中で `dep-metrics` の実装を直すと、前後の数字が比較できなくなる | 全手順の合否判定が無意味になる | 手順1。**手順2 以降で `tools/dep-metrics.mjs` を触らない** |
| `PowerShell` で `src/` を書き換えると日本語が化け、改行も潰れる | 差分が巨大になり、レビューが不能になる | 全手順。編集は Edit か Python で行う |

---

## 測り方(再現手順)

手順1 で `tools/dep-metrics.mjs` に入れる規則。上の数字はすべてこれと同じ規則で出してある。

- **辺の抽出** — `import (type )?{...} from '相対パス'` と `export ... from '相対パス'` を拾い、
  `.ts` / `/index.ts` へ解決する。節内の識別子が全部 `type` 前置なら型のみ辺とみなすが、
  **`ctx_k` では型のみ辺も 1 辺として数える。**
- **`ctx_k(f)`** — `f` から `k` 歩以内で到達できるファイルの総行数(`f` 自身は除く)。
  全ファイルの中央値・平均・p90 を出す。
- **`k` の使い分け** — `k=1,2,3` は塊の内側の改善が見える。`k=∞` は塊の中で飽和するので、
  **「塊から出たか」の判定にだけ使う。**
- **前後比較は必ず同じ実装で両方を測る。** 片方だけ測ると、新設ファイルぶんの増分を効果と
  読み違える(段 A・B では全ファイル一律 +11 ファイルぶんの増分が出た)。
- **面の判断に使う3つの数字** — 受け手数(`git grep -c ": 型名" src`)、面自身の ctx1、
  「実装の隣へ畳んだとき」の ctx 差分。3つ目は、受け手の import 先を実装ファイルへ張り替えた
  グラフを組んで差を取る。
- 数字は `git rev-parse --short HEAD` を添えて、いつの時点かを必ず明示する。

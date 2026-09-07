# 依存グラフの単純化 — 現況調査と、直し方ごとの規模・効き目

調査時点: `b5f1b4ca`(branch `workspace4`, 2026-09-07)。
以下の数字はすべてこの時点の `src/` を機械的に走査して出したもので、**コードが動けば古くなる。**
再測定の手順は末尾「測り方」に置く。

---

## 0. 結論(先に)

**ObjectPickable は確かに神インターフェイスだが、それは症状であって原因ではない。**
依存グラフを複雑にしているものは3つあり、**効き目と修正規模がまったく違う。**

| # | 原因 | 何が起きているか | 規模 | 効き目 |
| --- | --- | --- | --- | --- |
| A | **型の置き場所が高すぎる** | 葉に置ける小さな型が、巨大 hub の中に同居している | **S**(機械的) | 循環1個が消える。248 ファイルの推移的依存が減る。最大 **427 → 25** |
| B | **具象型で受けている** | 2メンバしか使わないのにクラス全体を型として引く | **M**(契約の書き換え) | 型のみ辺 1035 本の宛先が hub から葉へ。循環 149 → 最良 22 |
| C | **下位が上位を値で import** | `player` → `Hud`、`camera` → `Hud` など層の逆転 | **L**(責務の移動) | 残り 22 ファイルの循環。**インターフェイスでは直らない** |

**A と B は「インターフェイスにすべきか」の話だが、C は違う。** A → B → C の順にやると、C に着手する
時点で残った問題が値依存だけになり、判断がはっきりする。

---

## 1. 現況の数字

```
ts ファイル          522 個 / 77,434 行
import 文           3,316 本(うち `import type` 1,039 本 = 31%)
プロジェクト内の辺   3,045 本(うち型のみ 1,035 本 = 34%)
```

**循環(強連結成分, size > 1)**

| 対象 | 全辺で見る | 値の辺だけで見る |
| --- | --- | --- |
| `src/game/` 本体 | **149** | 22 |
| `src/physics/` | 9 | なし |
| `src/hud/windows/property-window*` | 4 | なし |
| `src/render/protein-ribbon*` | 2 | なし |
| `src/game/protein/protein-asset-*` | 2 | なし |

**この差 149 対 22 が本件の核心。** 149 ファイルの塊のうち **127 ファイルは、型の依存だけで
互いに縛られている。** 値としては一方向にしか依存していないのに、型を引くために逆向きの辺が
立っている。

**ディレクトリ単位でも 42 対が相互 import している**(`game/dynamic` ↔ `game/hud` = 23/19、
`game/dynamic` ↔ `game/stages` = 15/34、`game` ↔ `game/hud` = 10/25、…)。
`src/game/` の下は事実上フラットで、フォルダの境界が依存の境界になっていない。

**149-SCC を解くのに切る必要がある辺は 116 本**(内部 848 辺のうち。近似最小フィードバック辺
集合)。**うち 60 本が型のみ。** 逆流の宛先を数えると:

```
17  src/game/player/player.ts
12  src/game/game.ts
10  src/game/dynamic/dynamic-entity/enemy.ts
 7  src/game/stages/stage.ts
 6  src/game/dynamic/dynamic-system.ts
 5  src/game/dynamic/dynamic-entity/controllable.ts
 4  src/game/pickable/object-pickable.ts
 4  src/game/dynamic/dynamic-entity/dynamic-entity.ts
```

`ObjectPickable` は4位以下。**一番の逆流先は `Player` と `Game`** で、これは
`memos/hedalu244/refactor_game.md` が扱っている問題と同じものの別の断面。

---

## 2. 原因A — 型の置き場所が高すぎる(規模 S)

**症状**: 数行の union / 小さな interface が、20〜70 import を持つ巨大モジュールの中に
同居している。その型を1つ欲しいだけのファイルが、hub 全体を推移的に引く。

### 実例と規模

| 移す型 | いまの家(その家の import 数) | その型「だけ」を引いているファイル | 規模 |
| --- | --- | --- | --- |
| `ProjectFn` / `ScaleFn` | `game/camera/camera-system.ts`(20) | **16** | S |
| `EntityRegistry` / `SpawnGate` | `game/dynamic/dynamic-system.ts`(30) | **14** | S |
| `PropertyRow` ほか窓の型 | `hud/windows/property-window.ts`(7) | **16** | S |
| `MapListSection` | `game/hud/panels/physical-object-list-panel.ts` | **9** | S |
| `ObjectPickerGenre` | `game/hud/object-groups.ts` | **8** | S |
| `CelestialBodyDef` `PlanetDef` `PhaseOffsets` ほか | `physics/celestial-motion.ts`(15, 605行) | 多数(82 importer 中) | S |
| `FormationRole` / `EnemyClass` | `game/dynamic/dynamic-entity/enemy.ts`(42) | 3 | S |
| `PlanExecutionMode` | `game/player/player.ts`(**69**) | 2 | S |

**`CelestialMotion` / `OrbitingMotion` はここに入らない。** abstract class なので「移すだけ」では
済まず、型としての面を抜き出す作業になる(→ 3.6、規模 M)。**physics の 9-SCC を閉じているのは
まさにこの2つ**なので、A を全部やっても physics の循環は残る。

### 効き目(実測)

上の8件(純粋な型だけ)をまとめて葉モジュールへ移した場合を、グラフ上でシミュレートした結果:

```
循環      149,9,4,2,2  →  148,9,2,2      (property-window の 4 が消滅)
推移的依存が減るファイル: 248
最大の効き:
  src/game/pickable/line-pickable.ts                 427 → 25   (-402)
  src/game/celestial/celestial-entity/ring-view.ts   427 → 47   (-380)
  他 16 ファイルが -16 前後、20 ファイルが -13〜-15
```

`line-pickable.ts` は import が4本しかないのに、そのうち1本
(`import type { ProjectFn } from '../camera/camera-system'`)のせいで **`src/` の 8 割**を
推移的に引いている。`ring-view.ts` は `ScaleFn` 1つで同じことになっている。
**この2件だけなら、型2つを 20 行の葉ファイルへ移すだけで済む。**

### 注意

- **import の本数は減らない。** 減るのは向き先(hub → 葉)と推移的依存。
  本数が減るのは原因B・Cのほう。
- `CODING-RULE` 1.2「短すぎるモジュールが多数あること」に触れないよう、**1型1ファイルにしない。**
  概念でまとめる(例: 天体の定義型をまとめて `physics/celestial-body-types.ts` へ)。
  `src/render/tsl-types.ts`(23行・52 importer・import ゼロ)が既にある良い前例。
- `MapListSection` / `ObjectPickerGenre` の行き先は判断が要る。**型としては被選択物が自分について
  申告する分類**なので `game/pickable/` が筋に見えるが、`CODING-RULE` 1.6「定数は概念の所有者が
  持つ」を一覧パネル側に読むこともできる。ここは決めてほしい。

---

## 3. 原因B — 具象型で受けている(規模 M)

**症状**: 呼び出し側が使うのは2〜3メンバなのに、クラス全体を型として受けている。
受けた型が hub なので、hub の import がまるごと推移的に付いてくる。

### 3.1 `CelestialSystem` — 最悪の1件

```
importer                     65 ファイル(うち 62 が型のみ)
そのうち1メンバも触らない     18 ファイル ← 受け取って下へ渡すだけ
残り 47 ファイルの使用メンバ  中央値 2、最大 10(game.ts のみ)
外から使われるメンバの種類  29(所有者しか呼ばないものを除く)
`celestialSystem: CelestialSystem` を取るシグネチャ  118 箇所 / 64 ファイル
```

メンバ別の利用ファイル数:

```
26 celestialMotions   13 nameOf   12 find   10 frames   6 stateAt   6 entityOf
 4 entities   3 star   3 sunDirFrom   3 has   3 bodyParentId ...
```

`build` / `dispose` / `sync` / `serialize` / `setGridVisibility` / `setOrbitGuideSettings` /
`perfCounts` は **`game.ts` しか呼んでいない。**

**`CelestialSystem` 本体は 42 import(THREE・`render/pipeline/*`・`render/stars` を含む)。**
「天体の名前を引きたいだけ」のパネルが、描画パイプラインの型まで推移的に背負っている。

**すでに前例がある。** `physics/celestial-motion.ts` の `CelestialMotions`(3メンバ)は
まさにこの形の narrow interface で、`CelestialSystem implements CelestialMotions` と書かれ、
`simulator.ts` / `substep-celestial-bodies.ts` / `plan.ts` の3つが具象型ではなくこちらを
受けている。**26 ファイルが `celestialMotions` しか使っていないのだから、この既存の口を
広く使うだけで大半が片付く。**

- **規模 M。** 新設は2〜3本(名前を引く面 / 状態を引く面 / 参照系の面)。実装側は
  構造的部分型なので `CelestialSystem` に手を入れる必要はほぼ無い。
  触るのは 118 箇所のシグネチャ(型名の置換のみ)。
- **削減の目安**: `celestial-system.ts` への型のみ辺 62 本が葉へ向き先を変える。
  そのうち **18 本は引数を消せる**(1メンバも触っていない = 下へ渡すためだけに持っている。
  `CODING-RULE` 1.3「受け取って別の誰かへ渡すだけの引数は、置き場所が間違っているサイン」に
  真正面から当たる)。

### 3.2 `Hud` — 一番安い1件

```
importer  31 ファイル
うち 16 ファイルは `hint` か `toast` しか使わない
メンバ別: hint 19 / layers 5 / overlayManager 5 / mapRoot 4 / toast 4 / root 2 / 他は1
```

`player.ts` `fire-control.ts` `camera-system.ts` `focus-camera.ts` `sim-speed-manager.ts`
`throttle.ts` `altitude-alarm.ts` `attached-boosters.ts` `nav-target.ts` `plan-guide.ts`
`logistics.ts` … これらは全部 `this._hud.hint('…')` を呼ぶためだけに `Hud` を**値で** import
している。

- **規模 S〜M。** `hint` / `toast` だけの葉インターフェイス1本(名前は `Notifier` など。
  「集め方」ではなく「何であるか」で呼ぶこと — `CODING-RULE` 1.6)。
- **削減の目安**: 16〜19 本の辺が hud hub から葉へ。**うち `player` `fire-control`
  `camera-system` `focus-camera` `sim-speed-manager` の5本は値の辺**なので、
  値依存の循環(原因C)にも直接効く。**費用対効果が全項目中もっとも良い。**

### 3.3 `Controllable` — `viewer` は `.state` しか読まれていない

```
importer  39 ファイル(うち 38 が型のみ)
1メンバも触らない  17 ファイル
`.state` だけ使う  16 ファイル
`viewer: Controllable | null` を取るシグネチャ  54 箇所 / 19 ファイル
```

**`viewer.` というアクセスは `src/` 全体で 21 箇所あり、その全部が `.state`。**
`Controllable` は `CombatTarget` を継承し、`CombatTarget` は `DynamicEntity` と
`ObjectPickable` を継承する。**つまり「注視者の位置が知りたい」だけの一覧パネルが、
スロットル・射撃管制・ブースター・電源・放熱・空力・警報・計画の型を全部背負っている。**

同一性比較(`viewer === this` / `tgt === viewer`)が9箇所あるので `KinematicState` へ
潰すことはできないが、`{ readonly id: string; readonly state: KinematicState }` 程度の
葉インターフェイスなら同一性比較はそのまま通る(参照比較なので挙動も変わらない)。

- **規模 M。** 葉インターフェイス1本 + 54 箇所の型名置換。
- **削減の目安**: `controllable.ts` への型のみ辺 38 本のうち 33 本前後が葉へ。
  `controllable.ts` 自身の 15 import(うち8本が `player/*`)を背負わなくなる。

### 3.4 `ObjectPickable` — 神インターフェイスの中身

24 メンバ・19 import・importer 30・実装は9クラス(+ 派生 interface `CombatTarget`)。
**各メンバの消費者を数えると、ほぼ全部が「1メンバ = 1モジュール」になっている:**

| 面 | メンバ | 消費者 |
| --- | --- | --- |
| **一覧** | `listSection` `listDetail` `listSearchText` `listCounted` `listPriority` | `hud/panels/physical-object-list-*` のみ |
| **窓** | `menuItems` `runMenu` `propertyRows` `rename` `orbitState` `gone` | `pickable/object-windows.ts` のみ |
| **候補の絞り込み** | `mapVisibility` `hiddenBehindBodies` `onlyInFocusedSystem` | `pickable/object-pickables.ts` のみ |
| **掴む** | `shownOnMap` `onMapSelect` `onMapFocus` `hitBodyByRay` | `pickable/map-picking.ts` / `combat-pick.ts` のみ |
| **選択ウィジェット** | `pickerGenre` | `hud/object-groups.ts` のみ |
| **芯** | `id` `name` `posAt` `glyph` `glyphSvg` | 複数 |

**面ごとに消費者が1つずつという事実が、これが4〜5個の別インターフェイスである証拠。**
分割すれば `object-pickable.ts` の 19 import は面ごとに散り、
1メンバも触らない importer 22 のうち、実装7個を除いた **15 ファイル(候補列を受け取って
下へ渡すだけ)は、芯の3メンバだけを見ればよくなる。**

- **規模 M〜L。** 型の分割自体は M(実装側は同じメンバを持ち続けるので `implements` の行が
  増えるだけ)。ただし**「どの面が誰に渡るか」を決める配線が変わる**ので、
  `view.ts` の `ViewFrame.pickables` の型・`map-picking` / `object-windows` /
  一覧パネルへの受け渡しに手が入る。ここは L 寄り。
- **削減の目安**: `object-pickable.ts` の out 19 → 面ごとに 3〜6。
  逆流辺4本(`→ object-windows` `→ plan-editor` `→ stage(ObjectAuthoring)` `→
  physical-object-list-panel(MapListSection)`)のうち3本が消える。
  ただし **149-SCC 全体への効きは小さい**(単体で 149 → 149、他と併せて数ファイル)。
  **やる理由は循環ではなく、契約の可読性のほう。**

### 3.5 `Game` — HUD パネルが god object を受けている

```
importer  17 ファイル
HUD パネル7枚が `Game` を型として受け、使うのは 1〜5 メンバ
  hud.ts             activeControllable
  orbit-altitude-tab celestialSystem
  map-scale-badge    cameraSystem viewManager
  target-panel       activeControllable celestialSystem targeter
  top-bar            displayWindowManager isPaused simSpeedManager simTime
  vessel-panel       activeControllable activeStage cameraSystem viewManager
  enemies-panel      activeControllable activeStage dynamicSystem targeter
```

**逆流辺 12 本のうち 7 本がこの「パネル → Game」。**

- **規模 M。** ただし直し方は2通りあって、選択が要る:
  1. パネルごとに必要な値を引数で受ける(`CODING-RULE` 1.3「下位が自決できるものは下位が
     決める」・1.6「情報をまとめるためだけの型を作らない」に沿う。**推奨。**)
  2. 読み取り専用の narrow interface を1本立ててパネルに渡す(楽だが、
     `Ctx` 的な寄せ集めに堕ちる危険がある — 1.6 の禁止に触れうる)。
- **削減の目安**: 逆流辺 7 本。`game.ts` は out 50 なので推移的な効きは大きい。

### 3.6 `CelestialMotion` — physics の 9-SCC を閉じている当人

```
importer  63 ファイル
外から使われるメンバ  def 18 / stateAt 16 / positionAt 12 / id 10 / kind 5
                      atmosphereAt 4 / orientationAt 2 / primary 1
```

`physics/celestial-motion.ts` は 605 行の abstract class で、`kepler-orbit` `lagrange`
`satellite-orbit` `celestial-body-def` から**値**を引いている。一方 `eci-transform` `elements`
`frame` `lagrange` はこのクラスを**型としてだけ**引き返している。**これが 9-SCC の正体。**

外から使われるのは実質8メンバで、キャッシュ(`TimeRing`)も合成の実装も外は見ていない。
**8メンバの読み取り面を葉へ抜き出せば循環は解ける。**

- **規模 M。** 抽象クラスから interface を1本抜き、`CelestialMotion` に
  `implements` を付ける。呼び出し側は型名の置換のみ。
- **削減の目安**(実測シミュレーション): **physics の 9-SCC が消滅。**
  A(2節)と併せると `149, 2, 2` — **`src/game/` 以外の循環が全部無くなる。**

### 3.7 その他(同型・小粒)

| hub | importer | 「その型だけ」/「1メンバも触らない」 | 規模 |
| --- | --- | --- | --- |
| `CameraSystem` | 42 | 16 が `ProjectFn`/`ScaleFn` だけ(→ 原因A で片付く) | S |
| `DynamicSystem` | 33 | 14 が `EntityRegistry`/`SpawnGate` だけ(→ 原因A) | S |
| `DynamicEntity` | 40 | 13 が触らない。使う側も `.state` 中心 | M |
| `MarkerManager` | 30 | 9 が触らない。使う側は `shows`/`hide`/`setPosition` 中心 | M |
| `Stage` | 26 | 18 のうち多くは `extends Stage`(正当)。`ObjectAuthoring` の同居が問題 | S |
| `Enemy` | 18 | `save-data.ts` は `FormationRole` だけ(→ 原因A) | S |

---

## 4. 原因C — 下位が上位を値で import(規模 L)

型を全部葉インターフェイスへ追い出しても、**22 ファイルの循環が残る**(理論下限)。
残るのはこの塊:

```
player.ts  fire-control.ts  throttle.ts  belt.ts  altitude-alarm.ts  attached-boosters.ts
hud.ts  hud-root.ts  ammo-status.ts  orbit-panel.ts  enemies-panel.ts  target-panel.ts
top-bar.ts  vessel-panel.ts  help-panel.ts  help-content.ts
enemy.ts  ship.ts  bullet.ts  debris-piece.ts  protein-enemy.ts  sim-speed-manager.ts
```

閉じている辺の実体:

```
[val] player.ts        -> hud/hud.ts        :: Hud            (hint を呼ぶため)
[val] player.ts        -> hud/ammo-status.ts:: fmtAmmoStatus
[val] fire-control.ts  -> hud/hud.ts        :: Hud            (hint を呼ぶため)
[val] hud/ammo-status  -> player/fire-control:: MAG_ROUNDS    (定数1個)
[val] help-content.ts  -> player/fire-control:: MAG_ROUNDS    (定数1個)
[val] vessel-panel.ts  -> hud/ammo-status.ts:: fmtAmmoStatus
[val] enemies-panel.ts -> dynamic-entity/enemy.ts :: isEnemy Enemy
```

- **`Hud` への `hint` 呼び出しは 3.2 の葉インターフェイスで消える**(規模 S)。
  これだけで `player` → `hud` の値の辺が落ちる。
- **`MAG_ROUNDS` は定数の置き場所の問題。** `CODING-RULE` 1.6「定数は概念の所有者が持つ」に
  照らして、弾倉容量の所有者が `fire-control` なのはたぶん正しい。であれば
  **HUD 側が読むための葉ファイルへ弾薬の諸元を切り出す**のが筋(規模 S)。
- 残る `player` ↔ `hud パネル` は**責務の向きの問題**で、インターフェイスでは直らない。
  「パネルが player を読む」だけにする(= player は HUD を知らない)必要がある。
  **規模 L。`refactor_game.md` と同じ論点なので、そちらと合わせて判断すべき。**

そのほか小粒の値循環:

```
display-window-manager.ts   ↔ hud/panels/predict-panel.ts     (定数と型の相互参照。規模 S)
hud/frame/frame-controls.ts ↔ camera-frame-panel / trajectory-frame-panel
                                (`buildPanel` を親から引いている。共有ヘルパを葉へ。規模 S)
```

---

## 5. 「何でもインターフェイスにすべきではない」への答え

**判定は3つ。1と2の両方を満たすなら作る。実装が1つでも作ってよいし、実装が複数でも
満たさないなら作らない。**

1. **narrow になるか。** 実装型の public 面より**はっきり狭い**か。
   `CelestialSystem`(外から使われるだけで 29 メンバ)に対する「名前を引く面」(3メンバ)は満たす。
   `PlanEditor` 全部を写しただけの `IPlanEditor` は満たさない — **契約の写しは負債。**
2. **葉に置けるか。** そのインターフェイスの定義が、hub の型を引かずに書けるか。
   引くなら循環は残るので、**やっただけ無駄になる。**
   `ObjectPickable` を面へ割るときは、面ごとにこれを確かめること
   (窓の面は `MenuItem` / `PropertyRow` を引くので、それらが葉に居ることが前提 = 原因A が先)。
3. (数の話ではないが)**実装が1つでも 1・2 を満たせば価値がある。**
   `CelestialSystem` も `Game` も実装は1つだが、**狭くできるので作る意味がある。**

**インターフェイス以外の道具も既に使えている。** `object-pickable.ts` の
`pickNearest<T>(items, screenPosOf, x, y, r)` は generics で具象型依存を持たず、
`plan-editor` と `targeter` が `ObjectPickable` 以外の要素で使い回している。
**「射影して一番近いものを選ぶ」に被選択物の型は要らない**という判断が正しく効いている例。

---

## 6. `CODING-RULE` 1.12 への影響

現状の条文:

> **不要なクロージャ注入は行わない。** 特定のオブジェクトに影響を及ぼしたいなら、その mutable な
> オブジェクトを直接渡す。

**この条文自体は間違っていない**(クロージャ注入を避ける判断は正しい)が、
**「直接渡す」の型を具象クラスと読むと、いま見ている問題になる。** 同じ 1.12 には既に

> オブジェクトの公開契約と、クラスが実装できる契約には `interface` を使う。

があるので、**両者を繋ぐ一文を足すのが最小の是正**に見える。案:

> **渡すのはオブジェクトそのもので、型は受け手が使う面だけに絞る。** 具象クラスを型として
> 受けると、受け手はそのクラスの依存を全部推移的に背負う。受け手が2〜3メンバしか使わないなら、
> その面だけの `interface` を**葉のモジュール**に置いて、それで受ける。
> 面が実装型の public 面とほぼ同じ広さになるなら、それは契約の写しなので作らない。

**規則の変更はユーザー判断。** ここでは案の提示に留める。

---

## 7. 段取りの提案

**A → B → C の順。**理由は、B の narrow interface が「葉に置けるか」(判定2)を満たすために
A が前提になり、C の判断は A・B を通したあと残った値依存を見てからのほうが正確なため。

| 段 | やること | 規模 | 触るファイル | 効き目 |
| --- | --- | --- | --- | --- |
| A-1 | `ProjectFn`/`ScaleFn` を `game/camera/` の葉へ | S | 17 | `line-pickable` 427→25、`ring-view` 427→47 |
| A-2 | `PropertyRow` ほか窓の型を `hud/windows/` の葉へ | S | 4(循環を切るだけ)/ 20(全 importer を葉へ向ける) | 4-SCC 消滅 |
| A-3 | `EntityRegistry`/`SpawnGate`、`MapListSection`、`ObjectPickerGenre`、`FormationRole`、`PlanExecutionMode`、`CelestialBodyDef` ほか | S | 40 前後 | 推移的依存 248 ファイル減 |
| B-1 | `Hud` の `hint`/`toast` を葉インターフェイスへ | S〜M | 17 | 値の辺5本を含む 16〜19 本 |
| B-2 | `CelestialMotion` の読み取り面(8メンバ)を葉へ | M | 63(型としての利用のみ) | **9-SCC 消滅** |
| B-3 | `Controllable` の `viewer` を葉インターフェイスへ | M | 19(54 箇所) | 型のみ辺 33 本 |
| B-4 | `CelestialSystem` を2〜3の面へ | M | 64(118 箇所) | 型のみ辺 62 本 + 引数 18 本の削除 |
| B-5 | `ObjectPickable` を4〜5の面へ | M〜L | 30 | 循環への効きは小。**契約の可読性のため** |
| B-6 | `Game` を HUD パネルから外す | M | 7 | 逆流辺7本 |
| C-1 | `MAG_ROUNDS` ほか諸元定数を葉へ | S | 3 | 値の辺2本 |
| C-2 | `display-window-manager` ↔ `predict-panel`、`frame-controls` ↔ 各 frame パネル | S | 5 | 値の循環2個 |
| C-3 | `player` ↔ HUD パネルの向きを一方向にする | **L** | 15 前後 | 22-SCC の解消。`refactor_game.md` と同時に判断 |

**到達点の見込み**(グラフ上のシミュレーション):

```
いま                          149, 9, 4, 2, 2
A だけ                        148, 9, 2, 2
A + B-2(CelestialMotion の面)  148, 2, 2      ← src/game/ 以外の循環が消える
A + B(主要 hub の型を葉へ)     121 前後
A + B を徹底(型依存を全部葉へ)  22, 3, 2       ← 型の工夫で到達できる下限
A + B + C                      循環なし
```

**B を全部やっても 121 までしか落ちない**点は先に言っておく価値がある。
**149 → 22 を得るには「主要 hub だけ」では足りず、型依存を面単位で徹底する必要がある。**
逆に言えば、**A(規模 S)だけで 248 ファイルの推移的依存が片付き、B-2 を足せば
`src/game/` 以外の循環が全部消える**ので、
**費用対効果は A が突出して良い。**

---

## 測り方(再現手順)

上の数字は全部、`src/` の相対 import を正規表現で拾って有向グラフを組み、
Tarjan で SCC、Eades-Lin-Smyth の貪欲法で近似最小フィードバック辺集合を出したもの。
`import type` と値 import を区別して数えている。スクリプトは調査用の使い捨てで、
リポジトリには残していない。再測定するなら:

- 辺の抽出: `import (type )?{...} from '相対パス'` を拾い、`.ts` / `/index.ts` へ解決する。
  節内の識別子が全部 `type` 前置なら型のみ辺とみなす。
- hub のメンバ利用率: `名前: 型名` で束縛される変数名を集め、`変数名.メンバ` を数える。
  `extends` / `implements` は「利用0」に出るので、pass-through と読み違えないこと。
- 数字は `git rev-parse --short HEAD` を添えて、いつの時点かを必ず明示する。

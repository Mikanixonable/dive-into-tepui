# game.ts の条件分岐を下位モジュールへ移す

`for` 文の排除は完了した。次は `if`(および三項演算子・`??`・`&&` によるガード)を、
「下位モジュールで決定可能なことは自決させる」原則で減らす。

**原則**: 下位が自決できるようにフラグを持たせる。持たせられないときだけ `Game` に残す。
残す場合はその理由を明文化し、`/refactor-fixed` へ昇格させる。

---

## 1. 現状の棚卸し — game.ts に残る全分岐

545行中、条件分岐は **37箇所**。依存している値で分類すると **6軸** に集約される。

### 軸A: `player: Player | null`(操作対象艦の不在) — 13箇所

| 行 | 分岐 | 形 |
|---|---|---|
| 190 | `if (this.player === null) this.activePlayers.set(ship)` | onShipPlaced コールバック |
| 208-210 | `this.player ? new FloatingOrigin(r, v) : new FloatingOrigin(v3(), v3())` | 暫定値 |
| 259 / 275 | `if (player && playing) { behave } else if (player) { thrust=null; torque=v3() }` | 行動の停止 |
| 286 | `if (player) nanWatchdog.checkPlayer(...)` | 監視 |
| 311 | `if (player && playing) { boardMarks / reclaimDead / checkProximity }` | |
| 333-334 | `const flown = this.player; if (flown && playing)` | 読み直し |
| 358 | `else if (!this._isPaused && this.player)` | 戦闘ポインタ |
| 374 | `this.player ? [this.player.id] : []` | excludedIds |
| 422 | `this.player?.alive ?? false` | canToggleView |
| 435 | `player?.alive ?? false` | viewBadge |
| 439 / 458 / 472 | `player?.state.v ?? v3()` / `player?.state.r ?? v3()` / `?? null` | 既定値の代入 |
| 505 | `if (player) touchControls?.syncModeButtons(...)` | |

### 軸B: `activeStage.isPlaying`(勝敗の決着) — 9箇所

| 行 | 分岐 |
|---|---|
| 256 | `const playing = this.activeStage.isPlaying`(以下すべてこれを読む) |
| 259 / 275 | behave するか、`thrust=null; torque=v3()` を書くか |
| 282 | `if (playing) { activeStage.update / simSpeedManager.update / ワープ抑制 }` |
| 298 | `simDt = dt * (playing ? simSpeed : min(simSpeed, MAX_PHYS_SIM_SPEED))` |
| 303 | `simulator.advance(..., playing && canResolvePhysicalCollisions, playing, ...)` — 同じ値を2引数で渡す |
| 311 | `if (player && playing)` |
| 318 | `if (playing) predictor.update(...)` |
| 334 | `if (flown && playing)` |
| 349 | `if (!this.activeStage.isPlaying) return`(handleMapPointerInput) |
| 414 / 423 | `simSpeedManager.handleInput(input, isPlaying, ...)` / `viewManager.handleInput(input, isPlaying, ...)` — 引数で押し出し |
| 435 / 463 | `viewBadge.sync(..., isPlaying && ...)` / `entities.syncPlayers(..., isPlaying, ...)` |

### 軸C: `_isPaused`(ポーズ) — 5箇所

| 行 | 分岐 |
|---|---|
| 241 | `if (!this._isPaused) this.advanceSimulation(dt)` |
| 350 | `if (this._isPaused && this._hud.modalController.isOpen) return` |
| 358 | `else if (!this._isPaused && this.player)` |
| 463 | `entities.syncPlayers(..., this._isPaused, ...)` — 引数で押し出し |

### 軸D: ビューモード(`editMode` / `overviewMode` / `dock`) — 8箇所

| 行 | 分岐 |
|---|---|
| 265-266 | `mapMode: this.editor.editMode` / `dvEditActive: editMode && selectedNodeIdx !== null` — Game が組み立てている |
| 315 | `if (viewManager.current !== 'dock' && entities.bases.length > 0) docking.checkProximity()` |
| 322 | `cameraSystem.overviewMode ? 'map' : 'combat'` — Predictor の mode |
| 351 / 358 | `if (this.editor.editMode) { マップ } else if (...) { 戦闘 }` |
| 391 | `if (this.cameraSystem.overviewMode) mapPicker.refresh(...)` |
| 454 | `overviewMode ? this.mapPicker.visibilityPolicy : null` |
| 526 | `if (this.viewManager.current === 'dock') return`(render) |
| sync 全域 | `overviewMode` を 10箇所以上へ引数で配る |

### 軸E: 時間加速の閾値 — 3箇所

| 行 | 分岐 |
|---|---|
| 291 | `if (simSpeedManager.simSpeed > C.MAX_PHYS_SIM_SPEED) { suppressAttitudeCommandForWarp(); sfx.setRcs(false) }` — **`can*` 述語規約を迂回した裸の比較** |
| 298 | `Math.min(simSpeed, C.MAX_PHYS_SIM_SPEED)` — 同じ閾値を Game が知っている |
| 303 | `canResolvePhysicalCollisions`(これは規約どおり) |

### 軸F: コンストラクタ内の初期状態分岐 — 5箇所

| 行 | 分岐 |
|---|---|
| 118-123 | `ephemerisConfig === undefined ? new Ephemeris(4引数版) : new Ephemeris(別4引数版)` |
| 127-130 | `initialSave ? { saved: initialSave } : { playerCount: initialPlayerCountFor(launch) }` |
| 172 | `initialSave?.camera?.view ?? (initialPlayer ? 'combat' : 'map')` |
| 181 | `if (TouchControls.isTouchDevice()) this.touchControls = new TouchControls(this.input)` |
| 190 | `(ship) => { if (this.player === null) this.activePlayers.set(ship) }` |

---

## 2. 判断基準 — `if` を2種類に分ける

4軸を調べた結果、`Game` の分岐は**性質の違う2種類**に分かれ、扱いも別だと分かった。

### (a) 判断の合成 — 無条件で移す

複数モジュールの値を組み合わせて**新しい判断を作っている**もの。
`/refactor-fixed` 1節「条件分岐を伴う判断を Game に置かない」に真正面から反する。

- AND / 三項 / `min` — `playing && canResolvePhysicalCollisions`、
  `playing ? simSpeed : min(simSpeed, MAX_PHYS_SIM_SPEED)`、
  `editMode && selectedNodeIdx !== null`
- **他モジュールの内部フィールドへの直書き** — `player.thrust = null; player.torque = v3()`
- **閾値との直接比較** — `simSpeed > C.MAX_PHYS_SIM_SPEED`(`can*` 述語規約の迂回)

### (b) 単純な呼び出し可否 — 受け手が参照を持っているときだけ移す

フラグを1つ読んで呼ぶ/呼ばないを決めるだけのもの。
**受け手が既にその参照を持っているなら二重判定**なので受け手へ寄せる。
持っていないなら `Game` に残す — **持たせると層の逆転(simulation → camera など)が起きる**。

| 受け手 | 参照 | 判定 |
|---|---|---|
| `MapPicker` | `cameraSystem` を保持済み | 移す |
| `Docking` | `viewManager` を保持済み | 移す |
| `Stage` | 自分の `_phase` の所有者 | 既に自決済み(二重判定) |
| `ViewManager` | `Stage` を持たないが**同ファイルに後注入の前例あり** | 移す |
| `Predictor` | simulation 層。`CameraSystem`/`Stage` を持たない | **残す** |
| `Player` | 汎用エンティティ。view 層への参照を一切持たない | **残す** |
| `NanWatchdog` / `Targeter` | `Player | null` を受ければ済む | 引数の型を広げて移す |

### 副次的な指標

**同じ `if` ブロックに、そのフラグに依存しない処理が同居している**箇所は、
ほぼ確実に「相乗り」であり分解できる(`Docking.checkProximity` が `player` を使わないのに
`if (player && playing)` の中にいる、`SimSpeedManager.update` が `isPlaying` を参照しないのに
`if (playing)` の中にいる、など)。

---

## 3. 軸ごとの調査結果と改善案

### 軸A: `player: Player | null`

**判定**: 大半の下位モジュールは既に `Player | null` を受けて自決している。
`Game` が `if (player)` を書いているのは、**受け手が非 null 前提のまま取り残されている3つ**が
原因であって、Game 側の判断ではない。

#### A-0. 確定した扱い方 — 所有者から引ける値は所有者を受け取る

`PlanEditor` / `PlanGuide` へ適用済み。以後の受け手もこの形に倒す。

- **艦を保持する側**(`PlanEditor`)は `private ship: Player | null` を持ち、そこから引く値も
  `get plan(): Plan | null` として `null` を返す。**代役の空インスタンスで非 null に保たない** —
  代役を置くと「本当に艦がいるか」を別の真偽値で持つ形になり、型の上では常に持ち物があるのに
  「持っていない」と言う、名前が嘘になるフラグが生まれる。
- **「出すか」の真偽値引数は、値自身を `T | null` にできるなら潰す**
  (`PlanDisplay.update(plan: Plan | null, …)` — `null` が「出さない」を表すので `show` は要らない)。
- **艦を毎フレーム受け取る側**(`PlanGuide`)は `Player | null` を受け、**艦の持ち物(`plan`)は
  引数で受けずに `player.plan` から引く**。両方を受けると、ある艦と別の艦の計画という
  あってはならない組を渡せる引数の形になる。

#### A-1. null 許容化すれば `Game` の `if` が消えるもの(3メソッド)

| メソッド | 現状 | 直し方 |
|---|---|---|
| `NanWatchdog.checkPlayer` (`nan-watchdog.ts:46`) | `player: Player` | `Player \| null` + 先頭 `if (this.tripped \|\| !player) return;`。**game.ts の3箇所(L260/274/287)に加え `simulator.ts` の4箇所(L87/91/107/118)も素通しにできる** |
| `Targeter.updateBoardMarks` (`targeter.ts:141`) | `player: Player` | `Player \| null` + `if (!player) { this.boardMarks.length = 0; return; }` — 既存の `if (!target)` ガード(L145)と同型 |
| `EnvironmentScene.sync` の `playerPos` (`environment-scene.ts:121`) | `playerPos: Vec3` | `Vec3 \| null`。日照率計算の条件に `playerPos !== null` を足す |

#### A-2. `Docking.checkProximity` は `player` を一切使わない — 相乗りしているだけ

`docking.ts:98` は引数を取らず `this.entities.players` を自走査する。
game.ts L311 の `if (player && playing)` ブロックに入っているのは、
同ブロックの `targeter.updateBoardMarks` の非 null 制約に**相乗りしているだけ**。
A-1 で `updateBoardMarks` を null 許容化すれば、`checkProximity()` は独立して呼べる
(残る条件は `viewManager.current !== 'dock' && bases.length > 0` のみ → 軸Dへ)。

#### A-3. `?? v3()` と `?? null` の使い分け — 前者は「たまたま実害が無い」だけ

- `?? null`(`syncMarkers` L472)は**意味のある null**。`EntityMarker.sync`(`entity-marker.ts:33-44`)が
  `viewerPos ? name + 距離 : name` と分岐しており、`v3()` を渡すと「地球中心からの距離」という
  無意味な数値をラベルに出してしまう。**この形が正しい。**
- `?? v3()`(L439/458 ほか)は、受け手が非 null `Vec3` しか取らないための一時しのぎ。
  座標スケール的に誤発火しないので実害は出ていないが、「該当なし」を表現できていない。
  `EnvironmentScene.sync` が改善の筆頭(A-1)。

#### A-4. `Game` に残すべきもの(委譲先が無い)

| 箇所 | 理由 |
|---|---|
| L259 `player.behave(...)` の呼び出し可否 | `Player` のメソッドなので非 null 必須。「操作艦がいるときだけ行動させる」は Game 固有の判断 |
| L341 `flown.plan.trackAnchor(flown.state)` | `flown` が null だと**引数の式自体が組み立てられない**。防御的分岐ではなく構造的制約 |
| L208-210 `FloatingOrigin` 初期値 | `Game` 自身のフィールドの初期化。委譲先が無い |
| L374 `excludedIds` の配列組み立て | 単なる値変換。下位は `readonly string[]` を要求 |
| L422 `canToggleView` の bool 化 | オプショナルチェーン1行で既に十分 |
| L505 `touchControls?.syncModeButtons` | `TouchControls` は `Player` 型から疎結合に保たれている(プリミティブ3つを受ける)。この設計は妥当なので、null 分岐は呼び出し側に残る |
| L358 `targeter.updateCombatTargeting` | 非 null 必須(軸C/Dと併せて再検討) |

**注**: 実装上のフィールド名は `PlanEditor.ship`(CLAUDE.md の文中表現 `activePlayer` とずれている)。
CLAUDE.md 側の記述を実装に合わせるか、フィールドを改名するかの判断が要る。

### 軸B: `activeStage.isPlaying`(勝敗の決着)

**判定**: 「呼ぶか呼ばないか」の単純ゲートは概ね二重判定。
問題は**判断の合成**(AND・三項・`min`)と、**`Player` の内部状態への直書き**。

#### B-0. `_phase` の書き手は既に `Stage` 自身に閉じている

`stage.ts:84-87`。書き手は `recordEnemyDeath`(L211)/`recordPlayerLost`(L221)/
`stage0.ts` のタイマー(L62)の3箇所のみで、いずれも `Stage`/具象ステージ自身。
`game.ts` は `_phase` に一度も書かない。**正本の所有は既に正しい。**

#### B-1. `Stage.update` は既に自決している(二重判定)

| ステージ | ガード |
|---|---|
| stage0 / stage00 / stage1 / stage2 / stage-debug / -alt-system / -load | 冒頭に `if (!this.isPlaying \|\| !player) return;`(7ステージすべて) |
| creative-stage | ガード無しだが**構造的に不要** — `checkWin()` が常に `false`、`recordPlayerLost` を `hud.hint()` のみに override するので `isPlaying` が生成後ずっと `true` |

`Stage.handleInput`(L128)も `Stage.sync`(L140、そもそも `isPlaying` を見ない)も既に自決済み。
→ **`activeStage.update()` の呼び出しだけを見れば無条件化できる。**
ただし同じ `if (playing)` ブロックに Stage 外の処理(`simSpeedManager.update` / ワープ抑制)が
同居しているので、ブロックごと消せるわけではない(B-3/軸E で分解する)。

#### B-2. `Simulator.advance` の boolean 2引数は畳める

```ts
advance(dt, simDt, player, activeStage, resolveCollision: boolean, doSubstep: boolean, nanWatchdog)
```

- **`doSubstep`(第6)は常に `activeStage.isPlaying` と同値**。`activeStage` は既に第4引数にある。
  → **引数を削除し、内部で `activeStage.isPlaying` を読む。**
- **`resolveCollision`(第5)は `playing && canResolvePhysicalCollisions` の AND**。
  `playing` の部分は上と同じく内部化できる。残る `canResolvePhysicalCollisions` は
  `SimSpeedManager` の getter で、`Simulator` は現在その参照を持たない。

  `contact.ts:134-135` のコメントが既に
  「ワープゲートは呼び出し側(`Simulator.advance`)が判断してから呼ぶ」と書いている。
  **判定主体を `Simulator` に置く設計意図はコード上に既にあるのに、AND だけが `game.ts` に
  漏れ出している** — `/refactor-fixed` 1節に反する典型例。

  > **提案(調査結果からの修正)**: 調査は「コンストラクタに `SimSpeedManager` を注入」を挙げたが、
  > `/refactor-fixed` 7節「毎フレームの呼び出しの中だけで使うなら引数で渡す」に従い、
  > **`activeStage` と並べて `simSpeed: SimSpeedManager` を per-frame 引数で渡す**方がよい。
  > `Stage.update(dt, player, entities, simTime, simSpeed)` が既に同じ形で
  > `SimSpeedManager` を毎フレーム受けており、前例がある。
  > 結果: `advance(dt, simDt, player, activeStage, simSpeed, nanWatchdog)` と boolean 2つが消える。

- **2引数を1つにはできない**: `playing=true` かつ高ワープで
  `doSubstep=true, resolveCollision=false` が実在する(片方向の含意はあるが同値ではない)。

#### B-3. 決着後のワープ上限 `min()` は `SimSpeedManager` の持ち物

`game.ts:298-299` の `dt * (playing ? simSpeed : Math.min(simSpeed, C.MAX_PHYS_SIM_SPEED))` は、
**`Game` が `MAX_PHYS_SIM_SPEED` という閾値を知っている**という点で `can*` 述語規約に反する(軸E参照)。

**直し方**: `SimSpeedManager` に
`effectiveSimSpeed(playing: boolean): number { return playing ? this.simSpeed : Math.min(this.simSpeed, C.MAX_PHYS_SIM_SPEED); }`
を追加。`SimSpeedManager` は「ワープ段と物理相互作用可否の関係」を持つ唯一のモジュールなので、
この上限ロジックの置き場所として既存責務と自然に一致する。

なお **`SimSpeedManager.update(simTime)` は `isPlaying` を一切参照しない**(自動ワープの残り時間から
段を調整するだけ)。`game.ts` が `if (playing)` ブロックに入れているだけ。
`handleInput` の `isPlaying` も `toggleAutoWarpToFirstNode` 内(L99-104)で自決済み。

#### B-4. `player.thrust = null; player.torque = v3()` は既存メソッドの縮小コピー

`game.ts:275-279` の手書き2行は `Player.clearTransientCommands()`(`player.ts:284-290`)の
**縮小コピー**(`throttle.clearTransientState()` と `fire.stopFiring()` を欠く)。
その doc コメント「次のフレームへ持ち越してはならない連続指令を畳む」がまさにこの用途で、
既に `active-player-controller.ts` L37/50/65 と `docking.ts` L129 で使われている。

**直し方**: `player.clearTransientCommands()` に差し替える。
`Player.pause()` は使わない — `Game.isPaused`(全体ポーズ)という別概念に紐づく名前で、
「決着」とは意味が違う。呼ぶタイミング(`!playing` の判定)自体は `Player` が `Stage` を
知らない設計上、`game.ts` に残ってよい。

> `thrust`/`torque` のリセット自体は必須。`ThrustEffects.sync`/`RcsEffects.sync` と
> `Simulator.substep`/`stepAttitudes` は `isPlaying` に関係なく毎フレーム走り、これらを読む。

#### B-5. `ViewManager.handleInput` の `isPlaying` 引数は消せる — 同ファイルに前例がある

`view-manager.ts:132-138` の `isPlaying` 使用は1箇所
(「決着後はどのビューにいても戦闘ビューへ戻す」)。完全に `ViewManager` 自身の責務。

`ViewManager` は `Stage` 参照を持たないが、**これは持たせられないからではない** —
同じファイルに `private docking: Docking | null = null` + `setDocking()`(L27/50-52)という
**後注入の前例が既にある**(`docking.ts:49` で `Docking` 自身が登録する)。
`activeStage` も `viewManager`(L170)より後に `buildStage()`(L187)で作られるので同型。

**直し方**: `game.ts` の `buildStage` 直後に `this.viewManager.setStage(this.activeStage)` を1行
(`mapPicker.setDocking(this.docking)` L199 と同型)。
`handleInput(input, canToggleView)` から `isPlaying` 引数を削る。

#### B-6. `Game` に残すが、**ゲートの必要性そのものに根拠が無い**もの — 要判断

| 箇所 | 状況 |
|---|---|
| L318 `if (playing) predictor.update(...)` | `Predictor.update` は `isPlaying` を引数に持たず本体でも参照しない。**決着後に予測を止める理由を示すコメントがコードにもドキュメントにも無い**。決着後も `Simulator.advance` は走り続け弾・残骸は飛び続けるので、予測だけ止める必然性が確認できない |
| L334 `if (flown && playing)` 内の `guide.update(...)` | 同型。`PlanGuide.update` は `Player \| null` を受けて `if (editMode \|\| !player?.alive) return;` を自前で持つので、残る `flown &&` は同ブロックの `trackAnchor`(A-4)のためだけ。決着後に止める理由の明記が無い(結果画面の直後に無関係な HUD ヒントが出るのを防ぐ、という推測はできるが裏付けなし) |

どちらも「たまたま同じ `if (playing)` ブロックに同居しているだけ」の疑いがある。
**ゲートを外して実害があるかはユーザー判断が要る**(CPU 予算と、決着後の HUD 表示の見え方)。
モジュール側に `isPlaying` を持たせるのは所有者の取り違えなので、
**残すなら理由をコメントに書く / 不要なら外す** のどちらかに倒す。

### 軸D: ビューモード(`editMode` / `overviewMode` / `dock`)

**判定**: フラグの正本と同時性は既に正しい。残っている `if` は
**「参照を既に持っているのに、呼び出し側が代わりにガードしている」二重判定**が原因。

#### D-0. 前提の確認 — 2軸であって4軸ではない

`ViewManager` の状態は `worldView: 'combat' | 'map'` と `isDockOpen: boolean` の**2軸**
(`current` は `isDockOpen ? 'dock' : worldView` の合成にすぎない、`view-manager.ts:24/25/29`)。

`applyChrome()`(`view-manager.ts:108-117`)が唯一の書き込み経路で、
`const map = this.worldView === 'map'` という**単一の真理値**から
HUD クラス / `syncNavballPlacement` / `touchControls.setMapMode` / `cameraSystem.setMapMode` /
`editor.setMapMode` / `displayWindow.forceCurrent = !map` を一括で決める。
`setMapMode` の呼び出し元を grep しても `view-manager.ts` L114-115 の2箇所のみ。

→ `overviewMode ≡ editMode ≡ !forceCurrent` は**たまたまではなく設計上の恒等**。
`dock` は独立軸で、ドック開閉は裏の `worldView` を一切動かさない。
**フラグ分離作業(`/refactor-fixed` 8節)は既に完了しており、追加作業は無い。**

> `/refactor-fixed` 8節の「同時トグルは `MapModeToggler` の責務」は旧クラス名。
> 現在この役目は `ViewManager.applyChrome` が担っている。**スキルの記述を直す必要がある。**

#### D-1. `MapPicker` — 既に `cameraSystem` を保持しており、外側ガードは二重判定

`map-picker.ts:92` に `private readonly cameraSystem: CameraSystem` があり、
**`refresh()` は引数に `overviewMode` を取らず、内部で `this.cameraSystem.overviewMode` を
既に直接読んでいる**(L153/167/172/177/207)。つまり game.ts L391 の外側ガードは重複。

さらに `sync(overviewMode, ...)`(L393)は、同じ値を**引数と自分のフィールドの両方から**得ている。

**直し方**:
- `refresh()` 冒頭に `if (!this.cameraSystem.overviewMode) return;` を置き、game.ts L391 の `if` を削除
- `sync()` の `overviewMode` 引数を削除し、内部で `this.cameraSystem.overviewMode` を読む

#### D-2. `Docking.checkProximity` — 既に `viewManager` を保持している

`docking.ts:33-44` に `private readonly viewManager: ViewManager` があり、
`handleInput`(L55)は既に `this.viewManager.current !== 'dock'` を自前で読んでいる**前例がある**。

- `current !== 'dock'` ガードは**必要な前提**(発進直後の再収容ループ防止)。捨ててはいけない
- `entities.bases.length > 0` は**単なる高速化**。`checkProximity` の中身は `for (const base of bases)` なので 0件なら空ループ

**直し方**: `checkProximity()` 冒頭に `if (this.viewManager.current === 'dock') return;` を置く。
game.ts L315 のガードは丸ごと消える(軸A-2 と合わせて、L311 のブロックからこの行が独立する)。

#### D-3. `dvEditActive` の組み立ては `PlanEditor` の持ち物

game.ts L266 の `this.editor.editMode && this.editor.selectedNodeIdx !== null` は、
**`PlanEditor` が両方とも自前で持っているフィールドの組み合わせ**(`plan-editor.ts:100` と L75-79)。
`Game` がこの式を持つ理由がない。

**直し方**: `PlanEditor` に
`get dvEditActive(): boolean { return this.editMode && this.selectedNodeIdx !== null; }` を追加し、
game.ts は `dvEditActive: this.editor.dvEditActive` を渡すだけにする。

#### D-4. `Game` に残すべきもの

| 箇所 | 理由 |
|---|---|
| L322 `Predictor.update` の `overviewMode ? 'map' : 'combat'` | `Predictor` は simulation 層で `CameraSystem` を持たない(コンストラクタは `entities`/`ephemeris` のみ)。持たせると **simulation 層が camera 層へ依存する向きの逆転**になる。`mode` は「予測対象範囲と予算」という Predictor 自身の語彙であり、`overviewMode` とはたまたま連動しているだけの別概念(`/refactor-fixed` 8節) |
| L265 `Player.behave` の `mapMode` | `Player` は複数インスタンスが並存する汎用エンティティで、`PlanEditor`/`ViewManager`/`CameraSystem` への参照を一切持たない。view 由来の値は「その瞬間の表示文脈」として毎フレーム引数で渡す(`/refactor-fixed` 7節) |
| L351/358 `handleMapPointerInput` の `editMode` 分岐 | `PlanEditor` は `MapPicker`/`NavTarget`/`Targeter` のいずれも持たない。`handleInput` と同型の**優先順位付きディスパッチ**であり、どちらかへ寄せると「持っていない側への参照追加」が要る |
| L526 `render` の dock 早期 return | `renderer`/`scene` は `Game` 自身の資源で `ViewManager` は持たない。持たせると責務が「ビュー選択の正本」から「描画実行の決定」へ肥大する |
| sync 全域の `overviewMode` 引数配布 | 受け手(`EntityManager`/`Targeter`/`NavTarget`/`Stage`/`EnvironmentScene`/`marker/*`)はいずれも camera 層を持たない設計。渡すのが正しい |

#### D-5. 検討の余地(今回は必須でない)

L454 の `overviewMode ? this.mapPicker.visibilityPolicy : null` は、
D-1 で `refresh()` が早期 return するようになれば、`MapPicker` 側が
「マップを見ていないフレームでは `visibilityPolicy` を `null` に戻す」ことで
`this.mapPicker.visibilityPolicy` の素通しにできる。
ただし「前フレームの値が残る」現在の挙動との差を確認してから。

### 軸C: `_isPaused`(ポーズ)— **全件 `Game` に残す**

`/refactor-fixed` 1節が
「`Game` 自身の状態と、それを切り替えるだけのメソッドは配線の一部として残してよい(`isPaused` と
`pause`/`resume`)」と**明示的に例外として許可している**。以下すべてその範囲内。

| 箇所 | 判定と理由 |
|---|---|
| L75-76 / L215-222 `_isPaused` / `pause()` / `resume()` | 残す。分岐も組み立ても持たない単純なセッター |
| L241 `if (!_isPaused) advanceSimulation(dt)` | 残す。**`SimSpeedManager` へ `simSpeed = 0` として寄せるのは筋が悪い** — `SIM_SPEED_LEVELS`(`const.ts:249`)は `[1, 4, 16, ..., 131072]` の離散段で 0 を表現できず、混ぜると `shift()`/`update()` がすべて「0はワープ操作の対象外」の特殊扱いを要する。かつポーズ(時間を進めない)とワープ閾値(進める前提で相互作用の範囲を決める)は別の関心事(`/refactor-fixed` 8節) |
| L350 `_isPaused && modalController.isOpen` | 残す。`Game` 所有の `_isPaused` と `Hud` 所有の `isOpen` を跨ぐ単純な AND。`ModalController` にポーズを教えるのは責務の逆流、AND 1本のために横断モジュールを立てるのも重すぎる。かつ直前行の `if (!isPlaying) return;` と同型の、入力配分責務そのもの |
| L358 `!_isPaused && this.player` | 残す。同上(優先順位付きディスパッチの一部) |
| L463 `syncPlayers(..., _isPaused, ...)` | 残す。`EntityManager` → `Player.syncPlayer` → `RcsEffects.sync` への**単純な中継**(途中に分岐なし)。最終用途は「RCS 噴射煙と SFX の可否」で、`pause()` が畳むのはアクティブ艦の `torque` だけ(`game.ts:218`)なのに対しパッシブ艦は `advanceSimulation` ごと飛ぶので古い `torque` が残りうる。その残存トルクで演出が動かないよう明示的にゲートするのは正しい |

> **ドキュメントのずれ**: CLAUDE.md は `pause()`/`resume()` を「`main.ts` is the only caller」と
> 書いているが、実際は `docking.ts:86/93`(ドック出入り)と `hud/save-browser.ts:67/74` も
> 直接呼んでいる。`DEVELOP/OWNERSHIP.md` の方は正しい。**CLAUDE.md を直す。**

### 軸E: 時間加速の閾値 — **2件は規約違反、1件は冗長**

#### E-1. `simSpeed > C.MAX_PHYS_SIM_SPEED`(L291)は規約違反

`MAX_PHYS_SIM_SPEED` の grep 全件のうち、**比較に使っているのは `sim-speed-manager.ts` の
`can*` 述語5つ(定義元なので当然)と `game.ts` の L291/L299 だけ**
(`player-fire.ts:128` と `hud/dom.ts:990` は HUD 文言への埋め込みで比較ではない)。

CLAUDE.md の規約:
> callers ask these (`can*` predicates) instead of comparing `simSpeed` against
> `MAX_PHYS_SIM_SPEED` themselves.

既存の `canPlayerThrust` を流用するのは意味的にずれる(あれは**並進推力**の可否、
ここは**姿勢制御コマンド = RCS torque** の抑制)。

**直し方**: `SimSpeedManager` に
`get canApplyAttitudeCommand(): boolean { return this.simSpeed <= C.MAX_PHYS_SIM_SPEED; }` を新設し、
`if (!this.simSpeedManager.canApplyAttitudeCommand)` にする。既存の `can` + 対象操作 の命名規則に揃う。

#### E-2. `Math.min(simSpeed, MAX_PHYS_SIM_SPEED)`(L299)

同じ閾値の直接参照。**B-3 の `effectiveSimSpeed(playing)` に畳む**
(真偽値ではなく値のクランプなので `can*` の形には落ちない。B-3 と E-2 は同じ1メソッドで片付く)。

#### E-3. `_sfx.setRcs(false)`(L293)は冗長 — 削除

`entities.suppressAttitudeCommandForWarp()`(`entity-manager.ts:324`)は
全自機の `torque` をゼロ化する(`player.ts:293-295`)。
同じフレームの後段 `sync()` → `syncPlayers` → `syncPlayer` → `rcsEffects.sync` が必ず走り、
`RcsEffects.sync`(`rcs-effects.ts:44-46`)は `torque` から `rotating=false` を導いて
`sfx.setRcs(false)` を**自然に呼ぶ**。つまり L293 は同一フレーム内の結果と重複。

しかも `/refactor-fixed` 18節に反する — `game.ts` という入力元が `_sfx.setRcs` を直接叩いており、
`RcsEffects` の所有権をオーケストレータが横取りしている。

> 他の `sfx.setRcs(false)`(`docking.ts:131`、`active-player-controller.ts:54`)は
> 「アクティブ艦が変わる/消える」ため以後 `rcsEffects.sync` が呼ばれなくなるケースで、
> 明示的停止に正当な理由がある。L293 にはそれが当てはまらない。
>
> **確認事項**: `player === null` のとき `syncPlayer` が走らないが、その場合は
> `ActivePlayerController.setOrNull(null)` が既に `sfx.setRcs(false)` を出しているので問題ない。
> 削除後に高ワープで RCS 音が残らないことを実機で確認する。

### 軸F: コンストラクタ内の初期状態分岐 — **1件だけ移せる、4件は模範例**

| 箇所 | 判定 |
|---|---|
| L118-123 `ephemerisConfig === undefined ? ... : ...` | **移せる(任意)**。`main.ts:241` が `ephemerisConfigFor(launch) === undefined` として**同じ真偽値を既に評価している**(外部暦パックを `await` でロードするか判断するため)。`Ephemeris`(`physics/`)側へは寄せられない(`physics/` は `game/` に依存できない、`/refactor-fixed` 4節)が、`stage-dictionary.ts` に既にある `*For(launch)` 群の隣へ `ephemerisFor(launch, phaseOffsets, absoluteEphemeris): Ephemeris` を新設すれば `game.ts` は1行になる。**ただし `main.ts` 側の判定(非同期ロードの要否という別の関心事)は残るので、重複自体は完全には消えない** |
| L127-130 `initialSave ? {saved} : {playerCount}` | **残す**。`/refactor-fixed` 13節が模範例として挙げている判別共用体そのもの |
| L172 `initialSave?.camera?.view ?? (initialPlayer ? 'combat' : 'map')` | **残す**。21節「起動時の状態は、モードではなく状態から導く」の模範例そのもの |
| L181 `if (TouchControls.isTouchDevice())` | **残す**。null チェックは全体で3箇所(`game.ts:506`、`view-manager.ts:46/113`)の optional chaining のみ。Null Object 化するとコンストラクタが実際に DOM を `document.body` へ追加する副作用を持つため空実装クラス+インターフェースが要り、**現状の1行より複雑になる**。`OWNERSHIP.md` にも意図的な設計として明記済み |
| L190 `onShipPlaced` の `if (this.player === null)` | **残す**。CLAUDE.md が明示的に肯定した配線 |
| L208-210 `floatingOrigin` 暫定値 | **残す**。`Game` 自身のフィールドの初期化で委譲先が無い。理由もコメント済み |

---

## 4. 作業計画

段階ごとに `npm run typecheck` を通す(`/refactor-fixed` 5節: 一度に全部書き換えない)。
`src/physics/` は触らないので `npm run test:physics` は不要。

### Step 1 — 受け手の `Player | null` 許容化(軸A-1)

**挙動を一切変えない、純粋なシグネチャ拡張 + 早期 return。**

1. `NanWatchdog.checkPlayer` → `player: Player | null`、先頭 `if (this.tripped || !player) return;`
   - **game.ts の3箇所(L260/274/287)に加え `simulator.ts` の4箇所(L87/91/107/118)の `if (player)` も消える**
2. `Targeter.updateBoardMarks` → `player: Player | null`、`if (!player) { this.boardMarks.length = 0; return; }`
3. `EnvironmentScene.sync` の `playerPos` → `Vec3 | null`、日照率計算の条件に `playerPos !== null` を足す
   - game.ts の `?? v3()` が `?? null` になる(「艦がいない」を値で表現できるようになる)

### Step 2 — 既存メソッドへの差し替え(軸B-4)

`game.ts:275-279` の手書き2行を `player.clearTransientCommands()` に置換。
`throttle.clearTransientState()` と `fire.stopFiring()` も畳まれるようになるが、
どちらも `behave()` 内でしか読まれない値なので**挙動変化は無い**(むしろ縮小コピーの解消)。

### Step 3 — 二重判定の削除(軸D-1 / D-2 / A-2)

1. `MapPicker.refresh()` 冒頭に `if (!this.cameraSystem.overviewMode) return;` → game.ts L391 の `if` 削除
2. `MapPicker.sync()` の `overviewMode` 引数を削除、内部で `this.cameraSystem.overviewMode` を読む
3. `Docking.checkProximity()` 冒頭に `if (this.viewManager.current === 'dock') return;`
   → game.ts L315 のガード削除。`bases.length > 0` は単なる高速化なので `checkProximity` 内へ移すか捨てる
4. 1〜3 と Step 1 の結果、game.ts L311 の `if (player && playing)` ブロックが**3行それぞれ独立に呼べる**ようになるので分解する

### Step 4 — 判断の合成を所有者へ移す(軸B-2 / B-3 / E-1 / E-3)

1. `SimSpeedManager` に `effectiveSimSpeed(playing: boolean): number` を追加(B-3 + E-2)
2. `SimSpeedManager` に `get canApplyAttitudeCommand(): boolean` を追加(E-1)
3. `game.ts:293` の `_sfx.setRcs(false)` を削除(E-3)
4. `Simulator.advance` のシグネチャを
   `advance(dt, simDt, player, activeStage, simSpeed: SimSpeedManager, nanWatchdog)` に変更(B-2)
   - `doSubstep` → 内部で `activeStage.isPlaying`
   - `resolveCollision` → 内部で `activeStage.isPlaying && simSpeed.canResolvePhysicalCollisions`
   - `SimSpeedManager` は**コンストラクタ注入ではなく per-frame 引数**
     (`/refactor-fixed` 7節。`Stage.update(..., simSpeed)` に前例あり)

### Step 5 — getter の追加(軸D-3)

`PlanEditor` に `get dvEditActive(): boolean { return this.editMode && this.selectedNodeIdx !== null; }`。
game.ts L266 の組み立てが `this.editor.dvEditActive` になる。

### Step 6 — `Stage` の後注入(軸B-5)

`ViewManager` に `private stage: Stage | null = null` + `setStage(stage)` を追加
(`setDocking` と同型、同ファイル内)。`game.ts` の `buildStage` 直後に1行。
`handleInput(input, canToggleView)` から `isPlaying` 引数を削り、内部で `this.stage?.isPlaying ?? true`。

### Step 7(任意) — `ephemerisFor(launch, ...)`(軸F)

`stage-dictionary.ts` の `*For(launch)` 群の隣へ追加。効果は game.ts で6行→1行。
`main.ts` 側の重複判定は残るので、**優先度は低い**。

### Step 8(要ユーザー判断) — 根拠の無いゲート(軸B-6)

`if (playing) predictor.update(...)` と `if (flown && playing) guide.update(...)` の2つ。
コードにもドキュメントにも**決着後に止める理由が書かれていない**。
- 必要 → 理由をコメントに書いて残す
- 不要 → ゲートを外す(受け手はどちらも自前のガードを持っている)

判断材料: 決着後も `Simulator.advance` は走り弾・残骸は飛び続ける。予測を止める必然性は無さそうだが、
CPU 予算と、結果画面の直後に `PlanGuide` の HUD ヒントが出ないかを実機で見る必要がある。

---

## 5. 同じ変更セットで直す文書

`/refactor-fixed` と CLAUDE.md に、コードとずれている記述が2件ある。

1. **`/refactor-fixed` 8節** — 「同時トグルは `MapModeToggler` の責務」は旧クラス名。
   現行は `ViewManager.applyChrome`。
2. **CLAUDE.md `game.ts` の項** — `pause()`/`resume()` を「`main.ts` is the only caller」と書いているが、
   `docking.ts:86/93` と `hud/save-browser.ts:67/74` も直接呼ぶ。`OWNERSHIP.md` の方が正しい。

加えて、この作業で確定した判断は、`for` 文の禁止と同じ性質の横断ルールなので
**`/refactor-fixed` へ反映**する(いずれもユーザーの承認待ち)。

- 本メモ 2節の「判断の合成 / 単純な呼び出し可否」の分け方 → 1節へ。
- 本メモ 3節 A-0 の「所有者から引ける値は所有者を受け取る」(Null Object を作らない・
  値と表示可否の真偽値を分けない・所有者とその持ち物を別々の引数で受けない)。

---

## 6. 見込み

| 軸 | 現状 | 移す | 残す |
|---|---|---|---|
| A `player \| null` | 13 | 3メソッドの null 許容化で **5前後** | 8(`behave` 呼出、`trackAnchor`、`FloatingOrigin` 初期値ほか) |
| B `isPlaying` | 9 | **4**(`Simulator` の boolean 2引数、`min()`、`ViewManager` の引数) | 5(うち2件は Step 8 の判断待ち) |
| C `isPaused` | 5 | **0** | 5(ルールで明示的に許可された例外) |
| D ビューモード | 8 | **3**(`MapPicker` ×2、`Docking`、`dvEditActive`) | 5(層の逆転を避けるため) |
| E ワープ閾値 | 3 | **3**(`canApplyAttitudeCommand`、`effectiveSimSpeed`、`setRcs` 削除) | 0 |
| F コンストラクタ | 5 | **1**(任意) | 4(いずれもルールの模範例) |

**37箇所 → 20箇所前後。** 残るものはすべて
「`Game` 自身の状態」「委譲すると層が逆転する」「ルールが模範例として挙げている形」のいずれかで、
理由を明文化できる。

`for` 文の排除と違い `if` はゼロにはならないし、するべきでもない —
**残った `if` が「なぜ Game にあるのか」を全部言えることがゴール。**

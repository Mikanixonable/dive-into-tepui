# Player.behave のリファクタリング

`PlayerBehaveParams` は `/refactor-fixed` 6節が「唯一残る例外」として名指ししている ctx 引数そのもの。
これを畳むのが目的だが、**引数を並べ直すだけでは意味がない** — 9 フィールドのうち実際に
`behave` の責務に属するのは 3 つで、残りは密結合の付帯物である。付帯物を消して初めて
「ctx をやめる」が成立する。

「操作であるか否か」ではなく、「1フレームに一度呼び出すことで整合できる」が目的。整合性維持責務をPlayerに隠蔽する。updatePassive が残るのは妥当。
マップビュー中の射撃は許してよい。禁じる理由がない。条件をシンプルにする。

判断基準は /refactor と /refactor-fixed

---

## 0. 現状

```ts
// player.ts:65
export type PlayerBehaveParams = {
  readonly dt: number;
  readonly input: Input;
  readonly simSpeed: SimSpeedManager;
  readonly mapMode: boolean;
  readonly dvEditActive: boolean;
  readonly scoreCounter: ScoreCounter;
  readonly simTime: number;
  readonly zoomActive: boolean;
  readonly ephemeris: Ephemeris;
};

// player.ts:217
behave(controllable: boolean, entities: EntityManager, params: PlayerBehaveParams): void
```

組み立ては [game.ts:235-245](src/game/game.ts#L235-L245)、配布は
[entity-manager.ts:294-296](src/game/simulation/entity-manager.ts#L294-L296)
(`ship.behave(ship === activePlayer, this, params)`)。

`behave` が実際にしていることは 4 つ。

| | 内容 | `controllable` に依存するか |
|---|---|---|
| (A) | `updatePassive(dt)` = ベルト物理 + HP 自然回復 | **しない**(全艦・毎フレーム) |
| (B) | `!controllable` なら `clearTransientCommands()` して return | — |
| (C) | エッジキー → トルク → 射撃 → 推力 | する |
| (D) | 手動操作による `'powered'` 自動実行の中断 | する |

**(A) は「操作」ではない。** `behave` に入っているのは、全自機が毎フレーム通る唯一のフックが
`behave` だったからにすぎない。(A) がここに居座っている限り「操作できない艦でも `behave` を呼ぶ」
必要が残り、`controllable` を `input: Input | null` の不在で表す形に到達できない。

---

## 1. 判断の原則

- **中核は `input` と `dt`。** ユーザーの指摘どおり `controllable` は `input: Input | null` の
  不在で表せる(`/refactor-fixed` 21bis「不在は `T | null` で表す」)。
  `entities`(弾の生成先)も、フレームの流れの中でしか使わない参照なので引数で渡す形が正しい
  (`/refactor-fixed` 7節)。
- **真偽値の引数はすべて疑う。** 「なぜその状態を区別するのか」に、`behave` の責務の言葉で
  答えられないものは、置き場所が違う。
- **キーの取り合いは `Input` の調停で表す。** `Input` は既に
  「エッジは先着順で配り、後続のモジュールには見えない」という契約を持っている
  ([input.ts:286-301](src/game/input/input.ts#L286-L301))。ところが `down()` は
  ホールド状態を素通しするので、**ホールドキーだけがこの契約の外にある。**
  `mapMode` / `dvEditActive` はどちらもホールドキーの取り合いであり、
  フラグではなく調停の穴として扱うのが筋。

---

## 2. フィールド別の精査

### 2-1. `dt` — 中核。残す

(A)(C) の両方が読む。ただし §3 の時計問題がぶら下がっている。

### 2-2. `input` — 中核。`Input | null` にして `controllable` を吸収する

**なぜ区別が要るか**: 操作対象でない艦にキー入力を通してはならない。また `takeKeys` は
消費操作なので、非操作艦が先にエッジを食うと操作艦に届かない。

**手立て**: `controllable: boolean` を廃し `input: Input | null` にする。`null` は
「この艦は今フレーム操作されない」を意味し、`behave` の先頭で `clearTransientCommands()` して
return する。前提として (A) を `behave` の外へ出す(§4 step 5)。

**副作用**: なし。`controllable === false` と `input === null` は完全に同値。

### 2-3. `simSpeed: SimSpeedManager` — 2つに割れる。can\* は `input` へ、時計は §3 へ

`behave` の呼び出し木から読まれているのは **3 メンバだけ**:

| メンバ | 読む場所 | 述語 |
|---|---|---|
| `.canPlayerThrust` | [player.ts:239](src/game/player/player.ts#L239), [player-throttle.ts:101](src/game/player/player-throttle.ts#L101) | `simSpeed <= MAX_PHYS_SIM_SPEED` |
| `.canPlayerFire` | [player-fire.ts:129](src/game/player/player-fire.ts#L129) | 同上 |
| `.simSpeed` | [player.ts:225](src/game/player/player.ts#L225) `dt * simSpeed.simSpeed` | — |

**なぜ区別が要るか**: 高ワープでは 1 substep が数十秒になるので、噴射・射撃を通すと
1 ステップで非現実的な Δv/弾数になる。これは正当な制約。

**しかし `canPlayerThrust` / `canPlayerFire` / `canOperatePlayer` は同一の述語**
([sim-speed-manager.ts:38-69](src/game/sim-speed-manager.ts#L38-L69))。しかも
[game.ts:256](src/game/game.ts#L256) が `if (!canOperatePlayer) entities.clearTransientCommands()`
で **同じ判定を behave の後にもう一度** かけている。つまり「ワープが高いから操作できない」は
今3箇所で表現されている。これはユーザーの言う「操作可否は `controllable` に集約したい」に
真正面から当たる。

**手立て**: `EntityManager.updatePlayers` で
`ship.behave(ship === activePlayer && simSpeed.canOperatePlayer ? input : null, ...)` とし、
`canPlayerThrust` / `canPlayerFire` の個別ゲートを消す。
**「操作対象から外れた艦」と「操作できないワープ倍率」は同じ状態**であり、
`SimSpeedManager` 自身のコメントもそう書いている(game.ts:254-255)。

**残る危険 — game.ts:256 は消してよいか**: **消せない。** `PlanExecutor.update` は
`slew`/`armed` 段で `ship.torque` を書く([plan-executor.ts:125](src/game/plan/plan-executor.ts#L125))が、
その経路は `canPlayerThrust` を見ていない(ゲートを見ているのは `burn`/`trim` の
[83](src/game/plan/plan-executor.ts#L83)・[177](src/game/plan/plan-executor.ts#L177)・
[190](src/game/plan/plan-executor.ts#L190)・[207](src/game/plan/plan-executor.ts#L207) のみ)。
`CreativeStage.update` は `behave` より後に走るので、game.ts:256 の畳み込みはこの経路のための
安全網として実際に効いている。

→ **代案**: `PlanExecutor` 側に自決させる(`update` 先頭で `!canPlayerThrust` なら
`stopIfActive` して return)。そうすれば「連続指令を書く主体はそれぞれ自分でゲートする」に統一でき、
game.ts:256 の後追い畳み込みを撤去できる。これは §4 step 6 の一部として扱う。

### 2-4. `mapMode` — 射撃キーの取り合い。**撤廃を推奨(要ユーザー判断)**

**読まれるのは1箇所だけ** ([player.ts:227](src/game/player/player.ts#L227)):

```ts
if (mapMode) this.fire.tickMapMode(dt);
else this.fire.updateFireState(dt, input, ...);
```

`tickMapMode` は `tickReloadTimer(dt)` を呼ぶだけ
([player-fire.ts:156-165](src/game/player/player-fire.ts#L156-L165))。
`updateFireState` も先頭で同じ `tickReloadTimer(dt)` を呼ぶ。
**両者の差は「`input.down(K.fire)` を読むかどうか」ただ1点。**

**なぜ区別が要るのか**: マップビューでは戦闘カメラが無く照準できないから、と推測される。
しかしマップビューでも**並進も回転も実噴射できる**(CLAUDE.md の Controls 節が明記)。
撃てないことだけが特別扱いされている理由は、コードにも文書にも書かれていない。
`Space` は他の操作に割り当てられておらず([key-mapping.ts:44](src/game/input/key-mapping.ts#L44))、
キーの取り合いも起きていない。

**除くとどうなるか**: マップビューで Space を押すと撃てる。弾薬・反動・発砲熱が発生する。
照準できないので命中は期待できないが、**噴射が許されているのに射撃だけ許されない非対称**の方が
説明しづらい。`tickMapMode` は不要になり削除できる。

**代案(制限を残す場合)**: `mapMode` を引数で渡すのではなく、**マップビューの側が射撃キーを
先に取る**。§2-5 と同じ `Input.takeHeld(K.fire)` 機構を使い、`ViewManager.handleInput` で
マップビュー中に射撃キーを主張する。`Player` 側は何も知らなくてよくなる。
ただし「`ViewManager` が銃を知っている」という新しい結合を作る点で、撤廃より劣る。

**もう一つの代案(最小)**: `updateFireState(dt, input: Input | null, ...)` にして
`mapMode ? null : input` を渡す。`tickMapMode` は消えるが `mapMode` の伝播は残るので、
これは中間形にすぎない。

→ **判断待ち**: マップビュー中の射撃を許すか。許すなら `mapMode` は跡形なく消える。

### 2-5. `dvEditActive` — WASDQE の取り合い。`Input` の調停へ移す

**読まれるのは1箇所** ([player.ts:232-236](src/game/player/player.ts#L232-L236))。
真なら `thrust = null; throttle.stopThrust(); return;`。

**なぜ区別が要るか**: WASDQE が**物理的に共有されている**。
`thrustForward`(KeyW)と `dvPrograde`(KeyW)は別エントリだが同じ `code`
([key-mapping.ts:66-74](src/game/input/key-mapping.ts#L66-L74))。これは実在する衝突で、
消すことはできない。**問題は衝突の存在ではなく、調停が3モジュール(`PlanEditor` が公開 →
`Game` が読んで詰める → `Player` が分岐)に散っていること。**

**手立て**: `Input` にホールドキーの先着消費を足す。既存の `takeKey` と同型:

```ts
// 今フレーム key がホールドされていれば、以後この code に対する down() を false にして true を返す。
takeHeld(key: KeyBinding): boolean
```

`down()` は「押されているか」を素通ししているので、現状 **ホールドキーだけが
`Input` の先着順契約の外にある**。`takeHeld` はその穴を塞ぐ一般機構であり、
`/refactor` の「副作用のある関数は成否を boolean で返す程度ならよい」に収まる形
(`takeKey` と同じ)。

**順序**: 主張する側が `Player.behave` より先に走る必要がある。
現状 `PlanEditor.updateEditing` は `handlePointerInput` の末尾
([game.ts:304](src/game/game.ts#L304))、つまり `advanceSimulation`(line 203)より**後**。
これを入力フェーズ(`Game.handleInput` → `editor.handleInput`、line 333)へ移す。
`updateEditing` がしているのは「ホールド入力を Δv に変換する」ことなので、
入力フェーズは本来の居場所でもある。

**移動に伴う挙動差(いずれも許容範囲、要確認)**:
- `applyDv` が使う軌道基底 `path.arrivalStates()` が1フレーム古くなる。
  LEO で基底の回転は 1 フレームあたり ~0.06°、Δv の向きへの影響は無視できる。
- ポーズ中も Δv 編集が効くようになる(`handleInput` は「ポーズ中も効くべき操作」を配る場所)。
  計画の編集はポーズ中にできてよい性質のものなので、むしろ自然。
- 現状 `applyHeldDv` はノード未選択でも `dvHoldTime` を積み上げており
  ([plan-editor.ts:509-518](src/game/plan/plan-editor.ts#L509-L518))、
  ノードを選択した瞬間にランプが最大から始まる。`dvEditActive` でない間は
  early return してホールド時間を 0 に戻すのが正しい。ついでに直る。

**結果**: `PlanEditor.dvEditActive` は private になり、`Game` からも `Player` からも消える。

### 2-6. `scoreCounter` — `activeStage` に統一する

**終端の読みは1行だけ**: [player-fire.ts:277](src/game/player/player-fire.ts#L277)
`scoreCounter.recordShot();`。ここまで `updateFireState` → `fireCycle` → `fireGun` と
3段たらい回しされている。

**なぜ区別が要るか**: 集計は `Stage` の持ち物だから。だが**敵側は同じことを別の作法でやっている**:
[enemy.ts:202](src/game/game-entity/enemy.ts#L202) は `activeStage.scoreCounter.recordHit()`、
つまり `Stage` 参照を受け取って自分で辿っている。`Player` 側だけが
`Game` に事前展開させている。`Player.checkLoss` / `collideWith` / `collideAtRadiator` も
すべて `activeStage: Stage` を受け取っており、**`Player` の中で `scoreCounter` だけが例外。**

**手立て**: `scoreCounter` を `activeStage: Stage` に置き換え、`activeStage.scoreCounter.recordShot()`
とする。引数の本数は変わらないが、**`Player` の対 `Stage` 作法が1つに揃う**のが本題。
`Game` 側の `this.activeStage.scoreCounter` という組み立てが1つ消える。

**代案(却下)**: `Player` が `ScoreCounter` をコンストラクタで持つ。
`EntityManager.restoreFromSave` は `Stage` 生成より前に艦を作るので参照が無く、成立しない。

### 2-7. `simTime` — **導出できる。消す**

`behave` の実行時点(`Simulator.advance` の前)では、生存中の自機について
`this.state.t === simulator.simTime` が常に成り立つ。
`Simulator.substep` が `e.stepActual(dt, …)` で全エンティティの `state.t` を進めた上で
`this.simTime = simTime + dt` を返している
([simulator.ts:190-205](src/game/simulation/simulator.ts#L190-L205))ため。

**しかも現状は同一ファイル内で混在している**:
- [player-fire.ts:291](src/game/player/player-fire.ts#L291) `kinematicState(simTime, …)` (引数)
- [player-fire.ts:313](src/game/player/player-fire.ts#L313) `kinematicState(simTime, …)` (引数)
- [player-fire.ts:334](src/game/player/player-fire.ts#L334) `kinematicState(ship.state.t, …)` (**艦の epoch**)

**除くと何が起きるか**: 何も起きない。むしろ**正しくなる**。弾も薬莢も
`ship.state.r` から砲口位置を組んでいるのだから、対になる時刻は `ship.state.t` でなければならない。
外から渡された `simTime` とずれた瞬間、位置と時刻が食い違う `KinematicState` ができる
(`KinematicState` は「時刻つき状態」であり、両者が別引数で来ること自体が
CLAUDE.md の言う「状態と時刻を食い違ったまま渡せる形」)。

**手立て**: `simTime` を引数から削り、`this.state.t` / `ship.state.t` を読む。

### 2-8. `zoomActive` — **update フェーズにカメラ状態が漏れている。sync 側へ移す**

唯一の用途は [player-fire.ts:339](src/game/player/player-fire.ts#L339):

```ts
zoomActive ? C.ZOOM_MUZZLE_FLASH_SCALE : 1,  // peakOpacity として渡している
```

**なぜ区別が要るか**: ガンサイトズーム中は砲口が至近にあり、フラッシュが画面を覆ってちらつく。
減光そのものは正当な UX 要求。

**何が問題か**: `zoomActive` は `CameraSystem` の表示状態であり、
`/refactor-fixed` 2節が禁じる「`update` が見た目のためにカメラを読む」に当たる。
さらに `spawnFlash` の `peakOpacity` は**その演出固有の値**(ガスパフの 0.3 / 0.4 のように)
であって、カメラ状態で変調する軸ではない — 2つの意味が1引数に潰れている。

**手立て**: `spawnMuzzleFlash` は素の `peakOpacity` を渡し、
`FlashEffect` に「ガンサイト中は減光する」表示属性を持たせて
`FlashEffectManager.syncFlashEffects` で `zoomActive` を掛ける。
フラッシュの寿命は 0.07 s ≈ 4 フレームあるので、**寿命中にズームが切り替わっても追随する**
という点でも sync 側で評価する方が正しい。
`EffectsSystem.sync` は既に `activeCamera` を受け取っており、`Game.sync` から
`cameraSystem.zoomActive` を足すだけで届く。

**代案**: 減光自体をやめる(0.02 はほぼ不可視なので、実質「ズーム中は出さない」に近い)。
ちらつき対策としては劣化なので推奨しない。

### 2-9. `ephemeris` — 引数として残す。ただし**毎フレーム引くのをやめる**

用途は1つ、[player.ts:228](src/game/player/player.ts#L228) の
`ephemeris.sunDirFrom(this.state.r, simTime)`(発砲時の太陽グレアによる散布界拡大)。

**残す理由**: 長寿命の共有サービスへの参照であり、フラグではない。
フレームの流れの中でしか使わないので `/refactor-fixed` 7節どおり引数が正しい形。
`Player.stepEnvironment(dt, ephemeris, simTime)` も同じ作法。

**ただし無駄がある**: `sunDir` は**発砲していないフレームでも全自機ぶん計算されている**。
実際に読むのは `spawnBullet` の中だけ([player-fire.ts:286](src/game/player/player-fire.ts#L286))。
`ephemeris` を `fireGun`/`spawnBullet` まで下ろし、弾を撃つときだけ引く。

---

## 3. 付随して見つかった時計の不整合(別件として切る)

`dt * simSpeed.simSpeed`(= simDt)が `updateTorque` に `attDt` として渡り、2つのものを進めている。

| 進めるもの | 使っている時計 | あるべき時計 |
|---|---|---|
| `rotationHoldTime`([player-throttle.ts:194](src/game/player/player-throttle.ts#L194)) → RCS 出力ランプ | **sim** | **wall**(キーを何秒握ったかという操作感。今は ×4 ワープでランプが4倍速く完了する) |
| RCS 燃料消費([player-throttle.ts:216](src/game/player/player-throttle.ts#L216)) | sim | sim |
| 推進燃料消費([player-throttle.ts:158](src/game/player/player-throttle.ts#L158)) | **wall** | **sim**(推力は simDt ぶん積分されるので、wall で消費すると燃料あたりの Δv がワープ倍率で変わる) |

つまり**両方とも逆になっている**。`stepEnvironment` が
「wall dt から分離し substep 終端の値を使うことで warp 依存を防ぐ」ために存在するのと
同じ理由が、燃料にもそのまま当てはまる。

- `rotationHoldTime` を wall `dt` にすれば、`updateTorque` から sim 時計が消える。
- 燃料消費を simulation clock に寄せると、`behave` から `simSpeed` が完全に消える。
  ただし `consumeFuel` は**残燃料比で推力/角加速度を絞る**返り値を持つので、
  substep へ移すと「指令値」と「実効値」の分離が要る。これは `behave` の整理より重いので、
  **別 todo として切り出す**(§4 step 9)。

暫定案: step 6 の時点では `simSpeed` を落とす代わりに `simDt: number` を明示引数で渡す。
`SimSpeedManager`(6 個の述語を持つオブジェクト)への依存が数値1個になるだけでも、結合は大きく減る。

---

## 4. 改善計画

段階ごとに `npm run typecheck` を通し、挙動差の有無を確認する。
step 1〜4 は互いに独立で、どの順でもよい。

### step 1 — `simTime` を消す
`behave`/`updateFireState`/`fireCycle`/`fireGun`/`spawnBullet`/`dropCasing` の `simTime` 引数を削り、
`ship.state.t` を読む。`spawnMuzzleFlash` が既にそうしているので、ファイル内の作法が揃う。
**リスク**: 低。生存中の自機で `state.t !== simulator.simTime` になる経路が無いことを確認する。

### step 2 — `scoreCounter` → `activeStage`
`Player` の対 `Stage` 作法を `checkLoss`/`collideWith`/`Enemy.attackedByBullet` に揃える。
`Game` 側の `this.activeStage.scoreCounter` の組み立てが消える。
**リスク**: 低。

### step 3 — `zoomActive` を sync 側へ
`FlashEffect` にガンサイト減光の表示属性を足し、`syncFlashEffects` で `zoomActive` を掛ける。
`Game.sync` → `EffectsSystem.sync` に `zoomActive` を渡す。
**リスク**: 低。フラッシュ寿命中のズーム切替に追随するようになるのは改善。

### step 4 — `ephemeris` の `sunDirFrom` を発砲時まで下ろす
`behave` は `ephemeris` を `updateFireState` へそのまま渡し、`spawnBullet` で初めて引く。
**リスク**: 低。毎フレーム全艦ぶんの ephemeris lookup が消える。

### step 5 — `updatePassive` を `behave` の外へ
`EntityManager.updatePlayers` が `ship.updatePassive(dt)` を全艦に呼び、そのあと操作の可否で
`behave` を呼ぶ形にする。**`behave` の責務を「操作」に純化する前提工事**で、これ抜きに
step 6 は成立しない。
**リスク**: 低(呼び出し順は変わらない)。

### step 6 — `controllable` → `input: Input | null`、操作可否をここへ集約
- `EntityManager.updatePlayers(activePlayer, input, simSpeed, …)` が
  `ship === activePlayer && simSpeed.canOperatePlayer ? input : null` を渡す。
- `behave` は `input === null` で `clearTransientCommands()` して return。
- `player.ts:239` の `canPlayerThrust` ゲートと `player-throttle.ts:101` / `player-fire.ts:129` の
  個別ゲートを撤去。
- **同じ変更セットで** `PlanExecutor.update` の先頭に `!canPlayerThrust` の自決ゲートを足し、
  [game.ts:256](src/game/game.ts#L256) の後追い畳み込みを撤去する。
  これをやらないと `slew`/`armed` のトルクが高ワープで積分へ渡る。
- `simSpeed` は §3 の暫定案どおり `simDt: number` に置き換える。

**リスク**: 中。「ワープが高いから操作できない」の表現箇所が 3 → 1 になるので、
高ワープでの噴射・射撃・`'powered'` 実行を実機確認する(`/verify`)。

### step 7 — `Input.takeHeld` 導入、`dvEditActive` 消滅
- `Input` に `takeHeld(key): boolean` を足し、per-frame の claimed code 集合を
  `update()` でクリア。`down()` は claimed な code に false を返す。
- `PlanEditor.updateEditing(dt, input)` を `PlanEditor.handleInput(input, dt)` へ移し、
  `Game.handleInput(dt)` から呼ぶ。`dvEditActive` でない間は early return して
  `dvHoldTime` を 0 に戻す。
- `Player` から `dvEditActive` 分岐を削除。`PlanEditor.dvEditActive` は private へ。

**リスク**: 中。§2-5 に挙げた3つの挙動差(基底の1フレーム遅れ / ポーズ中の編集 /
ランプのリセット)を確認する。

### step 8 — `mapMode` の始末 ※**ユーザー判断が要る**
- (推奨) マップビュー中の射撃制限を撤廃し、`mapMode` と `tickMapMode` を削除する。
  `DEVELOP/SPEC.md` の該当記述も同じ変更セットで直す。
- (制限を残す場合) `ViewManager.handleInput` が `input.takeHeld(K.fire)` で射撃キーを主張する。

### step 9 — 燃料消費の時計を simulation clock へ(別 todo)
§3 のとおり。`consumeFuel` の返り値による出力の絞り込みを substep 側へ移すため、
「指令推力」と「実効推力」の分離が要る。`behave` の整理とは独立に進める。

---

## 5. 到達形

```ts
// 毎フレーム、全ての自機に対して1度だけ呼ぶ。input が null の艦は操作されないので、
// 次フレームへ持ち越してはならない連続指令をここで畳む。
behave(
  input: Input | null,
  dt: number,
  simDt: number,          // step 9 で消える
  entities: EntityManager,
  activeStage: Stage,
  ephemeris: Ephemeris,
): void
```

真偽値の引数は 0 個、`*Params` オブジェクトは無し。残るのは
**入力・時間・生成先・集計先・天体暦** — いずれも `behave` の責務から自然に要求されるもの。
`/refactor-fixed` 6節の「唯一残る `*Ctx`」が無くなる。

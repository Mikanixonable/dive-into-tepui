# 死んだ自機を配列に残す特例をやめる

`activePlayer === null`(操作対象の不在)と `player.alive === false`(艦の死)の二重判定を解消する。
`refactor_game.md` の軸B(`isPlaying`)と軸A(`player | null`)に連鎖する。

---

## 0. 結論

| 提案 | 評価 |
|---|---|
| ① `!alive` の自機を速やかに `players` から除去する | **妥当。実施すべき。** 消えるものが多く、失うものが(下記1-1の理由で)無い |
| ② `ChaseCamera` が `Player` を要求しない | **妥当。しかも `GameEntity` より弱くできる**(位置と姿勢しか要らない) |
| ③ `PlayerDeadBody` を新設する | **反対。** ①②には不要で、独立に見ても3つの規約違反を含む(3節) |

**①②はリファクタリングとして完結し、挙動もほぼ変わらない。** 死亡後の絵を良くしたいなら
それは①②とは独立した**機能追加**として別に判断する(4節)。判断が分かれるのは
「死亡直後に何を見せたいか」だけで、二重判定の解消はそれと無関係に進む。

---

## 1. 事実確認

### 1-1. 死んだ自機は積分されない — 「追従カメラの基準として残す」は成立していない

`GameEntity.stepActual`(`game-entity/game-entity.ts:190-191`)は先頭で自己抑制する。

```ts
  stepActual(dt: number, attractors: readonly Attractor[]): void {
    if (!this.alive) return;
```

したがって **`!alive` になった自機の `state` は ECI に凍結する。** 一方 `destroyEffect()`
(`player/player.ts:441-444` → `vfx/effects-system.ts:115-121`)が撒く破片11個は艦の `v` を
引き継ぐ通常の `DebrisPiece` なので、軌道速度(LEO で約 7.6 km/s)で ECI を進む。
`ChaseCamera` の中心は `this.player.state.r`(`camera/chase-camera.ts:134`)なので、
**凍結した1点にカメラが釘付けになり、爆発も破片も即座にフレーム外へ出る。**

`EntityManager.cleanup`(`simulation/entity-manager.ts:290-292`)のコメントと
`Stage.prunesDeadPlayers`(`stages/stage.ts:55-58`)の

> 喪失艦は撃墜演出・追従カメラの基準として残る

という根拠は、**実装上は果たされていない。** 気付かれていないのは、決着と同時に
`#hud-end`(`hud.layers.system`、全画面 + scrim)が被さるため 3D 側がほとんど見えないからである
(`Stage.recordPlayerLost` が `setPhase('lost')` と同じ行で `showResultScreen` を呼ぶ)。
Creative は `prunesDeadPlayers = true` なのでそもそもこの経路を通らない。

**帰結: ①は「今できていること」を何も壊さない。** 特例が守っているとされてきた挙動は存在しない。

### 1-2. 特例の実体は3箇所だけ

| 箇所 | 内容 |
|---|---|
| `simulation/entity-manager.ts:290-301` | `cleanup()` が `prune(this.players)` **だけ**呼ばない |
| `stages/stage.ts:55-58` / `creative-stage.ts:49-51` | 能力フラグ `prunesDeadPlayers`(既定 false、Creative だけ true) |
| `game.ts:297` | `if (this.activeStage.prunesDeadPlayers) this.activePlayers.reclaimDead();` |

読み手は `game.ts:297` の1箇所のみ。**フラグごと消せる。**

### 1-3. `alive` は現在3つの意味を兼ねている

| 意味 | 書く場所 | 配列にいるか |
|---|---|---|
| (a) 破壊された | `player.ts:351,375,400,424` | **いる**(除去されない) |
| (b) 基地に収容中 | `docking.ts:121`(`parkPlayer` の直前) | いない |
| (c) 新造直後・セーブ復元直後の格納艦 | `docking.ts:145` / `base.ts:91` | いない |

①は (a) を「いない」側へ揃える変更である。(b)(c) は**もともと配列の外**なので機構上は衝突しないが、
「配列の外にいる」ことで既に表現できている状態にわざわざ `alive` を寝かせている二重表現なので、
同じ変更セットで `alive = true` のまま park する形へ直す(`launch()` の `alive = true` も消える)。
`PlayerSaveData`(`save-data.ts:74-88`)には `EnemySaveData` と違って `alive` フィールドが**無い** —
死んだ自機はそもそもセーブで表現できない状態であり、これも (a) が異物である傍証。

---

## 2. ①②で消えるもの

`alive` の参照は `src/` 全体で 137 箇所 / 35 ファイル。うち **「死んだ自機が配列に残っている前提」で
立っているガードは以下**(すべて削除できる)。

### 2-1. 自機固有の `!alive` ガード(削除)

| ファイル:行 | 内容 |
|---|---|
| `docking.ts:103` | `checkProximity()` が毎フレーム死亡艦を弾く |
| `nav-target.ts:164` | `resolveEntity()` の `p.id === id && p.alive` |
| `game-entity/enemy.ts:262` | `Enemy.behave()` の `if (!player.alive) return;` |
| `marker/lead-markers.ts:27` | 死亡中は LEAD マーカー全消し |
| `map-picker.ts:154` | 選択候補から死亡自機を除外 |
| `map-picker.ts:436` | `isTargetGone('player')` の `?.alive ?? false` → `findPlayer(id) === undefined` へ |
| `targeter.ts:281` | `handleTargetContextMenu()` の `if (!player.alive) return;` |
| `stage-utils/logistics.ts:75` | `if (player.alive) this.absorbNearbyAmmo(player);` |
| `simulation/simulator.ts:101` | 死亡艦の `collisionFolds` を接触候補に入れない |
| `simulation/simulator.ts:137` | `adaptiveMaxStep()` から死亡艦を除外 |
| `simulation/contact.ts:157` | `resolveBelt()` の `if (!player.alive)` |
| `simulation/entity-manager.ts:354` | `ship === activePlayer && ship.alive` → `ship === activePlayer` |
| `plan/plan-guide.ts:31,45` | `!player?.alive` → `!player` |
| `plan/plan-executor.ts:25,69,158` | `PlanExecutorShip.alive` ごと不要になる |
| `player/player.ts:182,227,270` | `hpRegen` / `behave` / `stepEnvironment` の早期 return |
| `player/player-throttle.ts:181,188` | `updateTorque(alive)` 引数と `if (!alive) return v3();` |
| `player/thermal.ts:111-112` | `updateAltitudeAlarm(dt, playerAlive, alt)` の第2引数 |
| `player/belt.ts:52,58` / `player-markers.ts:27,77-78` | `sync(alive)` 引数 |

`player.ts` の `collideWith` / `collideAtRadiator` / `checkLoss` 冒頭の `if (!this.alive) return;`
(`360,383,412`)は**残す** — 同一 substep 内で複数の接触が解決されうるので、除去が済むまでの
再入防止として意味がある。

### 2-2. `syncPlayer` の `alive` は「表示されているか」へ意味が変わる(改名)

除去後は `sync` フェーズに死亡艦が到達しないので、`player.ts:492,502,507,511,513` の
`this.alive &&` はすべて落とせる。残る合成条件は `displayState !== null && mapEntityVisible`
(= 未来ゴーストの地平線外 / クラス表示オフ)だけになるので、`ThrustEffects.sync` /
`RcsEffects.sync` / `ReentryEffects.sync` / `Belt.sync` / `PlayerMarkers.sync` の `alive: boolean`
引数は **`visible`(または `present`)へ改名する。** 現在 CLAUDE.md が
「`displayState` が null のときは `alive` を偽にして呼ぶ」と説明している迂回が、そのまま素直な名前になる。

### 2-3. カメラ側(②)

| ファイル:行 | 内容 |
|---|---|
| `camera/chase-camera.ts:22,53,96-99` | `_prevAlive` と、生死の切り替わり瞬間の `reinterpretRot()` — **状態機械ごと消える** |
| `camera/chase-camera.ts:101` | `followNow = camFollowAttitude && player.alive` → `camFollowAttitude && target !== null` |
| `camera/chase-camera.ts:9` | `Player` の import |
| `camera/combat-camera-system.ts:86` | `player?.alive === true && zoomActive` → `player !== null && zoomActive` |

**`ChaseCamera` は `GameEntity` すら要求しなくてよい。** 読んでいるのは `att.q`(3箇所)と
`state.r`(1箇所)だけなので、追従対象を `GameEntity | null` にしてもよいし、
`update(centerR: Vec3, att: Quat | null, ...)` として **`att === null` を「姿勢基準が無い」** と
読ませてもよい。後者なら `camera/` から `game-entity/` への依存が1本消え、
`followNow` の判断が `alive` ではなく「姿勢の基準があるか」という**カメラ自身の語彙**になる
(`/refactor-fixed` 8節「たまたま同時に切り替わるフラグを分離する」に一致)。
どちらを採るかは 5節 Step 1 の判断事項。

### 2-4. `game.ts` から消える合成(`refactor_game.md` 軸B への連鎖)

- `game.ts:396` `const canToggleView = this.player?.alive ?? false;` → `this.player !== null`
- `game.ts:409` `viewBadge.sync(..., isPlaying && (player?.alive ?? false))` → **B-ε がここで決着する**
- `game.ts:297` `if (prunesDeadPlayers)` → 無条件呼び出し(分岐が1つ減る)
- `game.ts:273-276` `else if (player) player.clearTransientCommands();` → 到達しうるのは
  **「決着したが自機は生存」**(勝利後・stage0 timeup)だけになり、**B-α の検討範囲が正確に絞れる**

---

## 3. `PlayerDeadBody` に反対する理由

### 3-1. ①②に必要ない

1-1 のとおり、今の死亡後カメラは既に凍結点を見ている。追従対象を失った `ChaseCamera` は
`viewpoint` を最後の値のまま保持する(`update` 冒頭の早期 return がそのまま効く)ので、
**代役の実体を置かなくても挙動は現状と一致する。** `PlayerDeadBody` は
「今あるもの」を守るためではなく「**今は無い絵**」を新しく作るための提案であり、
リファクタリングの必要条件ではない。

### 3-2. 命名が規約違反

`/refactor-fixed` 11節が **`body` を天体の意味に予約**し、機体側は `ship` で有標にすると決めている
(`CelestialBody` / `bodyDef` / `MapPickKind` の `'body'`)。`PlayerDeadBody` はこの予約語を
機体に対して使う。仮に導入するとしても名前は `ShipWreck`(残骸)等になる。

### 3-3. 生存期間をカメラが決めるのは層の逆転

「視点を外すと `alive = false` になって破棄される」は、**view 層がシミュレーション層の
生存期間を決める**形になる。`refactor_game.md` D-4 が `Predictor` に `CameraSystem` を
持たせない理由として挙げた「simulation → camera の向きの逆転」と同じものが、
今度は生存期間という強い形で入る。加えて、視点を外さない限り生き続けるので寿命に上限が無い。

### 3-4. 何にも参加しない実体は特例そのもの

不可視・操作不能・非衝突・非重力・マーカー無し・予測無し・セーブ対象外 — つまり
「配列に居るが何もしない」実体である。①が消そうとしている特例(**配列に居るが何もしない死亡自機**)と
同型のものを、名前を変えて再導入することになる。

---

## 4. 代案 — 死亡後の絵を良くしたい場合

①②とは独立に判断する。**何もしない(4-A)を既定とし、絵が欲しければ 4-B を採る。**

### 4-A. 何も足さない(挙動保存)

追従対象を失った `ChaseCamera` は最後の `viewpoint` を保持する。現状(凍結)と同じ。
新概念ゼロ。ステージでは即座に結果画面が被さるので、実用上ほぼ現状のまま。

### 4-B-1. 残骸の破片へ引き継ぐ(**推奨**)

**破壊時に既に撒いている `DebrisPiece` の1つを追従対象にする。**

- 破片は**本物の実体**で、積分され、可視で、寿命(再突入・地表到達)も既存の規則そのまま。
  カメラは生存期間に一切関与しない → 3-3 が起きない。
- 新クラス0。②で追従対象を一般化した時点で、**追加実装は「どの破片を渡すか」の配線1本だけ**。
- 「どれを渡すか」の恣意性が気になるなら、`spawnShipDestroyEffect` が
  **相対速度0の破片を1つだけ余分に撒き**、それを返す。艦の位置・速度そのままなので
  カメラは爆発の重心に留まり、破片が四方へ散るのを内側から見る絵になる
  (どれか1つを追うと、その破片だけ画面中央に固定されて他が流れる)。
- 配線: `EffectsSystem.spawnShipDestroyEffect(...)` が `DebrisPiece` を返す →
  `Player.destroyEffect()` の呼び元で保持 → `ActivePlayerController.remove(ship)` が
  「除去する艦がカメラの追従対象だったら、代わりにそれを渡す」。
- 欠点: 破片配列は `addCapped` なので、大量の破片が後から湧くと追従対象が押し出されうる
  (押し出されたら追従対象喪失 = 4-A に落ちる、という穏当な劣化)。

### 4-B-2. カメラ自前の自由落下アンカー(次点)

`CombatCameraSystem` が `DynamicTrajectory` を1本持ち、追従対象を失った瞬間の
`KinematicState` から自由落下させる。`CameraSystem.update` は既に `attractors` を
受け取っている(`game.ts:372`)ので、必要な材料は揃っている。

- 実体ゼロ・決定的・配列に依存しない。姿勢が無いので `camFollowAttitude` は自然に無効。
- 欠点: `camera/` に積分が1つ入る(`Simulator`/`Predictor`/`PlanArc` に次ぐ4つ目)。
  カメラの「立ち位置」は本来カメラの持ち物なので規約違反ではないが、概念は1つ増える。

### 比較

| | 4-A 何もしない | 4-B-1 残骸へ引き継ぎ | 4-B-2 自由落下アンカー | ③ PlayerDeadBody |
|---|---|---|---|---|
| 新しいクラス | 0 | 0 | 0 | 1 |
| 生存期間の決定者 | — | 破片自身(既存規則) | カメラ(自分の持ち物) | **カメラがシミュを殺す** |
| 絵 | 凍結(現状) | 爆発の内側 | 爆発の内側 | 爆発の内側 |
| 決定性 | 高 | 中(配列上限に依存) | 高 | 高 |
| 規約 | ○ | ○ | ○ | 11節・層の逆転に抵触 |

---

## 5. 作業範囲と手順

**段階ごとに `npm run typecheck` を通し、その段階だけで挙動が壊れていないことを確認してから次へ進む。**
Step 1〜3 は独立に価値があり、Step 4 は任意。

### Step 0. `alive` から「収容中」の意味を剥がす(先行、単独で完結)

`docking.ts:121` の `ship.alive = false;` と `:162` の `ship.alive = true;`、`docking.ts:145` /
`base.ts:91` の格納艦生成時の `alive = false` を削除する。これらの艦は `entities.players` の
外にいるので、`alive` を寝かせている読み手は存在しない(`docking.ts:103,135` の
`p.alive` はいずれも配列上の走査なので届かない)。**Step 1 以降の「`!alive` ⇒ 除去」を
一意な規則にするための前提。**

### Step 1. `ChaseCamera` を `Player` から切り離す

- `private player: Player | null` / `setPlayer()` を、追従対象の一般形へ置換。
  - 案(a) `private target: GameEntity | null` / `setTarget()` — 差分最小。
  - 案(b) `update(centerR: Vec3, att: Quat | null, ...)` — `camera/` → `game-entity/` の依存が消える。
    `reinterpretRot` は `att` を引数で受ける。**推奨は (b)**(2-3参照)。
- `_prevAlive` と生死起因の `reinterpretRot` を削除し、**基準の切り替わりは「姿勢基準の有無」で
  判定する**(対象喪失時に一度だけ絶対値へ焼き込む)。
- `CombatCameraSystem.setActivePlayer` → `setChaseTarget`(名前が実態と合う)。
  `update` の `player: Player | null` 引数は**ガンサイト専用として残す** — 照準視点は
  「操作している艦の機首」という別概念なので、追従対象と統合しない(`/refactor-fixed` 8節)。

この段階では挙動は変わらない(渡すのは今までどおり操作対象艦)。

### Step 2. 「操作対象の不在」でマップへ飛ばさない + `[M]` の門を直す

- `ActivePlayerController.setOrNull(null)`(`active-player-controller.ts:55`)の
  `this.viewManager.setView('map')` を削除する。
- **`canToggleView` が両方向を塞いでいるのを直す**(`view-manager.ts:147`)。
  現状 `if (!canToggleView || !input.takeKey(...)) return;` は
  「戦闘→マップ」も塞ぐので、Step 3 の後に *戦闘ビューで艦を失う* と
  **マップへ出られなくなり、Creative では次の艦を配置できなくなる。**
  艦の要否は「マップ→戦闘」の向きにしか無いので、判定は `setView` 側の
  `canEnter('combat', combatAvailable)` に一本化する。
- そのためには `combatAvailable` が `ViewManager` から読める必要がある。
  `setStage`/`setDocking` と同じ後注入で `ActivePlayerController` を渡し、
  `canEnter` が自分で問う形にすると、`game.ts:396,409` の合成が2つとも消える
  (`handleInput(input)` / `selectableViews()` が引数を失う)。
- **B-β と同時に判断が要る。** `canEnter` が本物の `combatAvailable` を見るようになると、
  `view-manager.ts:141-145` の「決着後は戦闘ビューへ戻す」分岐が
  `setView('combat')` に失敗して機能しなくなる。`refactor_game.md` B-β は
  この分岐を「理由が事実として成り立たない」として削除候補にしているので、
  **Step 2 で同時に削除するのが筋。** 残すなら `canEnter` を迂回する口が要る。

### Step 3. `!alive` の自機を速やかに除去する

- `game.ts:297` を無条件呼び出しにし、`Stage.prunesDeadPlayers`(`stage.ts:55-58`、
  `creative-stage.ts:49-51`)を**削除**する。
  - 除去は `EntityManager.cleanup` 側の `prune(this.players)` ではなく
    **`ActivePlayerController.reclaimDead()` に留める。** `prune` は `dispose()` を呼ぶだけで、
    航法ターゲット・マップのプロパティウィンドウ・カメラフォーカス・計画エディタの
    参照掃除と次艦への引き継ぎ(`active-player-controller.ts:59-95`)を通らないため。
  - 結果として除去は **フレーム末(`simulator.advance` 後)** に1回。substep 単位で消える
    他エンティティとの差は残るが、`stepActual`/`checkLoss` が自己抑制するので影響はない。
- `ActivePlayerController.remove()` に **`targeter` の参照掃除を足す。**
  `CombatTarget = Enemy | Player` なので、除去された自機が他艦の
  `targeter.target`/`secondaryTarget` に残りうる(現在 `clearTargets()` は `set()` からしか
  呼ばれない)。`aliveTarget` ゲッターが隠しているだけで、参照は残っている。
- 2-1 / 2-2 の全ガードを削除・改名する。

### Step 4(任意). 死亡後の絵(4-B のどちらか)

4-B-1 なら `EffectsSystem.spawnShipDestroyEffect` の戻り値追加と
`ActivePlayerController.remove` での引き継ぎのみ。Step 1〜3 と完全に分離できる。

### Step 5. 文書

- CLAUDE.md: `Stage.prunesDeadPlayers` の記述削除、`EntityManager.cleanup` の
  「喪失した自機は残る」記述削除、`ChaseCamera`/`CombatCameraSystem` の責務記述更新、
  `ActivePlayerController.setOrNull` の「マップへ戻す」記述削除。
- `DEVELOP/OWNERSHIP.md`(追従カメラの参照)、`DEVELOP/CALLSTACK.md`(`reclaimDead` の条件)、
  `DEVELOP/SPEC.md`(自機喪失時の見え方)。
- `/refactor-fixed` 21節に**「艦の死は他のエンティティと同じく除去であり、操作可否は
  `activePlayer === null` だけで表す」**を追記(能力フラグを1つ消した根拠として)。
- `refactor_game.md`: B-ε 決着、B-α の範囲縮小、B-β を Step 2 と同時判断へ。

---

## 6. 受け入れる挙動変化(ステージモードでの自機喪失時)

いずれも Creative では既に起きている状態(艦0隻)で、`player === null` の経路は
**既に踏み固められている**ため新規リスクは低い。

| 箇所 | 変化 |
|---|---|
| `Stage.syncStatusPanel`(`stage.ts:148-155`) | 装甲/温度/電力パネルが **HP0 表示のまま残る → 消える** |
| `hud/panel.ts` の ORBIT / TARGET | 死亡艦の軌道を出し続ける → 消える |
| `FloatingOrigin` の速度基準(`game.ts:413`) | 凍結艦の `v` → `v3()`。弾の相対速度描画の基準が絶対速度になる |
| `EnvironmentScene.sync`(`game.ts:432`) | 日照率の参照点が失われ照明が減光しなくなる(`refactor_game.md` A-3 の既知の近似の範囲) |
| `Simulator` の弾の距離カリング(`simulator.ts:80,112`) | `player?.state.r ?? v3()` が ECI 原点になり、**残存弾が一斉に消える** |
| ガンサイト `[Z]` | もともと死亡中は無効(`combat-camera-system.ts:86`)。変化なし |
| 追従カメラ | 4-A なら現状と同じ(最後の視点で静止)。4-B なら改善 |

弾の一斉消滅が目に付くようなら、`cleanup` の `playerPos` を `Vec3 | null` にして
`Bullet.checkLoss` 側で「基準が無いなら距離では消さない」と自決させる(`/refactor-fixed` 21bis)。
**これは Step 3 とは独立に直せるので、必要になってから行う。**

---

## 7. 要判断

1. **Step 1 の案(a)/(b)** — `ChaseCamera` が `GameEntity` を持つか、位置と姿勢だけ受けるか。
2. **Step 2 と B-β** — 「決着後は戦闘ビューへ戻す」分岐を同時に消すか、`canEnter` を迂回させるか。
3. **Step 4 をやるか、やるならどちら**(4-B-1 残骸引き継ぎ / 4-B-2 自由落下アンカー)。
   絵の要求が無いなら 4-A のまま据え置いてよい。
4. `Ship.parts` を持つ艦を破壊時に完全 `dispose()` してよいか(現状 Creative では既にそうしている)。

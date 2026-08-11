# 章08: 自艦サブシステム レビュー結果

対象: `src/game/player/`(player.ts / player-throttle.ts / player-fire.ts / thermal.ts /
radiator.ts / power.ts / belt.ts / belt-physics.ts / thrust-effects.ts / rcs-effects.ts /
reentry-effects.ts / player-markers.ts)、`src/game/game-entity/`(ship.ts / parts.ts /
enemy.ts / bullet.ts)、`src/render/ships.ts` / `radiator-hinge.ts`。

## 検証結果
- `npm run typecheck`: pass
- `npm run test:physics`: 対象範囲は attitude.ts の呼び出し元(belt-physics 等)を含むが、
  belt-physics 自体は `physics/` 配下ではなくテストランナーの対象外。今回の指摘は数値バグ
  ではあるがテストで検出される種類ではないため未実行。

## 所見

### [bug] src/game/player/belt-physics.ts:174-176 — ベルトの pitch/yaw クランプ角が入れ替わっている
`advanceOrientationConstraints` で

```ts
const tanMaxPitch = Math.tan((C.MAG_CHAIN_MAX_YAW_DEG * Math.PI) / 180);
const tanMaxYaw = Math.tan((C.MAG_CHAIN_MAX_PITCH_DEG * Math.PI) / 180);
```

と、変数名とそこに代入する定数が入れ替わっている(`tanMaxPitch` に `MAG_CHAIN_MAX_YAW_DEG`
(=15°)、`tanMaxYaw` に `MAG_CHAIN_MAX_PITCH_DEG`(=45°)を詰めている)。この2変数は直後の
`clampDirectionToPrevFrame` 呼び出し(187行)へ

```ts
clamp(local.y, -tanMaxYaw * lx, tanMaxYaw * lx)   // 横ずれ(左右=ヨー)
clamp(local.z, -tanMaxPitch * lx, tanMaxPitch * lx) // 上下ずれ(上下=ピッチ)
```

の順で渡される(`clampDirectionToPrevFrame` 自身のコメントにも「横ずれ Y/X と上下ずれ Z/X」と
明記されている)。結果として実際には
- Y(左右・ヨー)が `MAG_CHAIN_MAX_PITCH_DEG`(45°)でクランプされ
- Z(上下・ピッチ)が `MAG_CHAIN_MAX_YAW_DEG`(15°)でクランプされる

という、`const.ts`(187-189行、ピッチ上限45°=上下方向は大きく曲がってよい/ヨー上限15°=
左右方向はあまり曲がらない、とコメントされている)の意図と左右逆の制約になっている。
belt-physics.ts 冒頭のクラス自体のコメントは「実物のアモベルトの上下左右の曲がりやすさ」を
モデル化する意図なので、見た目上ベルトが左右には過剰に振れ、上下にはほとんど折れない
挙動になっているはず。`test:physics` の対象外(belt-physics.ts は `game/player/` 配下)
なので機械的には検出されない。

修正案: 変数の対応を代入元に合わせて素直に直す(`tanMaxYaw` ← `MAG_CHAIN_MAX_YAW_DEG`、
`tanMaxPitch` ← `MAG_CHAIN_MAX_PITCH_DEG`)だけで、呼び出し側の引数順は変えなくてよい。

### [spec?] CLAUDE.md の radiator.ts 節が現行実装と食い違っている(hitRadius/sideHitBy/RADIATOR_TIP_DISTANCE)
CLAUDE.md の `player.ts` 節(radiator.ts の説明)は「`hitRadius()` interpolates the ship's
bullet-hit radius up to `render/ships.ts`'s `RADIATOR_TIP_DISTANCE`」「`sideHitBy` is pure
geometry」「`RADIATOR_HIT_DAMAGE`」などと記述しているが、これらのシンボル
(`hitRadius`/`sideHitBy`/`RADIATOR_HITTABLE_DEPLOY`/`RADIATOR_TIP_DISTANCE`)は現在
リポジトリ全体を検索しても存在しない(`grep -rn "hitRadius\|sideHitBy\|RADIATOR_TIP_DISTANCE" src`
で0件)。`git log` 上のコミット `5adaedb`(「放熱板を接触の実体にし、被弾判定半径を廃止する」)
で、被弾半径ベースの判定が `RadiatorFold`(接触の実体)へ置き換えられ、現行の `radiator.ts` は
`collisionFolds`/`RadiatorFold.collideWith` → `Player.collideAtRadiator` という別方式になって
いる。CLAUDE.md は「`src/` を変更したら同じ変更セットの中で更新する」ことを自身のルールとして
課しているため、このコミットで更新が漏れたと見える。挙動には影響しないがドキュメントの正確性
の問題として報告する(章08の範囲は `src/` のコードだが、参照ドキュメントの著しい食い違いなので
併記する)。実際のコードパス(`RadiatorFold.contactsWith`/`collideWith` →
`Player.collideAtRadiator` → `applyDamageToParts` 固定パーツ指定)自体には問題は見当たらない。

### 確認したが問題なし(参考記録)
- **parts = HP/性能の単一正**: 全ダメージ経路(`Player.attackedByBullet`/`collideWith`/
  `collideAtRadiator`、`Enemy.attackedByBullet`/`collideWith`)はすべて `Ship.applyDamageToParts`
  または `applyCollisionDamage`(内部で `applyDamageToParts` を呼ぶ)を経由しており、`hp` への
  直接代入は `parts.length === 0` のフォールバック(達しない経路)にしかない。`updateOverallHp`
  の「hull/cockpit 喪失で0」規則はこの1箇所のみで判定され、バイパス経路は無い。
  `refreshFromParts` の呼び忘れは無い(dock 修理・換装は `DockView.syncDockedSnapshot` 経由、
  restore は `Player.restore`/`initDefaultParts` 経由で確認)。`Part.weight` は宣言のみで未読
  (CLAUDE.md 記載どおり、既知)。
- **thermal**: `pendingHeat` は `addGunHeat`/`addImpactHeat` の2箇所でしか加算されず、
  `updateThermal` 内で一度だけ `heatCapacity` で温度へ変換して即 `0` にリセットしている
  (substep 回数に依存しない不変条件は保たれている)。`hullTemp` への書き込みは `updateThermal`
  内の1箇所のみ(`grep` で確認)。`radiator.wear` は `Player.radiatorWear()` が放熱板パーツの
  残HPから毎フレーム導出して `RadiatorSystem.update` へ渡すのみで、`RadiatorSystem` 自身が
  wear を書き換える(=自己修復する)経路は無い。`solarLoad` の偶奇 fold 分割は `foldThetas`
  を `sync()`/`solarLoad()` の両方が共有しており、`Math.abs(dot(...))`(両面が同じ吸収係数)を
  使っている。`power.ts` の `Math.max(0, dot(...))`(裏面は発電しない、片面のみ)との違いは
  ドキュメントどおり意図的な非対称。
- **throttle**: `THRUST_KEYS`/`OPPOSITE_THRUST_KEY`/`THRUST_AXIS_PAIRS` による6キー独立ラッチ、
  `performance.now()` 基準の連打判定、対向キー物理押下中のラッチ解除、対向ペア同時押しでの
  `isThrustKillSwitchActive`(全軸停止 + `updateThrustLatches` 内で全ラッチ・タイムスタンプ
  クリア)は記述どおり実装されている。`Player.behave` は `simSpeed.canPlayerThrust` の条件下
  でのみ `updateThrustLatches(input)` を呼んでおり、ワープ中に押下エッジが消費されない規約も
  守られている。`stopThrust()` は `thrustAccelVec` のみを触り、SFX/プルームには触れない
  (`ThrustEffects.sync`/`RcsEffects.sync` は `ship.thrust`/`ship.torque` を直接読む) —
  `refactor-fixed` の「共有物理フィールドを読む」規約に適合。
- **fire**: `consume()` の `ConsumeResult` 状態機械(`empty`/`normal`/`mag-reload`/
  `barrel-reload`)は素直で、`manualReload()` は成功時のみ `true` を返し
  `Player.handleEdgePress` の `case K.reload.code: return this.fire.manualReload();` が
  実際に成功時だけキーを消費する。ベルト feed のラップは `Belt.update`
  (`targetFeed < this.feed - 0.5` で `shiftBeltNodes()` を呼びつつ `feed` をジャンプさせる)
  で、rounds が `MAG_ROUNDS` へリセットされる瞬間(targetFeed が 1 付近から 0 付近へ飛ぶ)と
  同期している。
- **belt-physics**: 慣性力4項(並進 `-aThrustShip`・オイラー `-α×r`・遠心力 `-ω×(ω×r)`・
  コリオリ `-2ω×v`)の符号は `integrateVerlet` 内のコメントと一致(コリオリの `2/dt` 変換も
  実際の `dt` を使っており、コメントの注記どおり `h` ではなく `dt` を使っている)。
  `BeltSection` プロキシは `collisionSections`(機体座標→ワールド)と
  `applyCollisionSections`(ワールド→機体座標、Verlet 前フレーム位置の再構成込み)が
  互いに逆変換になっており往復は整合している。上記の pitch/yaw 入れ替えバグを除き、
  他の符号・拘束は問題なし。
- **effects の入力規約**: `ThrustEffects`/`RcsEffects` はコメントで明示されているとおり
  `ship.thrust`/`ship.torque`(共有物理フィールド)のみを読み、`PlayerThrottle` 固有の状態
  (thrustVizDir 等、実際には存在しない)には依存していない。`ReentryEffects` はステートレス
  (`qdyn` から毎フレーム強度を導出、`update` メソッドを持たない)。
- **radiator-hinge**(render 新設): `radiator.ts` の `foldLocalPosition`/`sideSign` は
  `RADIATOR_HINGE`(up側の値)を `sign * RADIATOR_HINGE.x` で down 側に反転しており、
  ヒンジ基準座標はコメントどおり。fold のネスト自体は `RadiatorSystem` コンストラクタが
  `shipObj.getObjectByName` で `radiatorUp/DownFold${i}` を辿るのみで、入れ子構造は
  モデル側(export-models.mjs、章の対象外)の責務。`RADIATOR_TIP_DISTANCE` は
  上記のとおり既に存在しない(廃止済み、CLAUDE.md側の指摘として上に記載)。
- **update/sync**: `ThrustEffects`/`RcsEffects`/`ReentryEffects` はいずれも `sync` のみで
  `update` を持たない(経時状態を持たないため)。`Player.syncPlayer` は
  `displayState ?? this.state`(453行)をエフェクト全般へ渡しており、スライダー中の
  VFX 位置がメッシュ本体と一致する規約を満たしている。`effectAlive = this.alive &&
  displayState !== null` により、表示できる状態が無いときは各エフェクトが自分で消える
  (alive=false を渡す)経路も規約どおり。

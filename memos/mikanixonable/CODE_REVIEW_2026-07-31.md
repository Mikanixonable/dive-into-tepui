# コードベース全体レビュー — 修正すべき点の一覧

調査日: 2026-07-31 / 対象: ブランチ `workspace3` HEAD `da67e8f`
調査方法: `DEVELOP/{CALLSTACK,OWNERSHIP}.md` と CLAUDE.md で当たりを付けたのち、
`src/` の主要モジュール(game/ 全域・physics/ 全域・render/ 主要・player/・stages/・plan/・predict/)を読解。
**読み取り専用の静的調査。コードは変更していない。** 実行時の再現確認は行っていないので、
「実機確認」欄が「未」のものは確信度を併記した。

前提: `npm run typecheck` はエラーなし(確認済み)。`TODO`/`FIXME`/`any` の類はほぼ皆無で、
コメント密度・命名規約・責務分割はよく維持されている。以下は**その水準の上で残っている**問題。

既存の `BUG_REPORT.md` / `MEMORY_LEAK.md`(2026-07-26)で指摘された dispose 系リークは、
現在のコードでは修正済みであることを確認した(本書では重複して挙げない)。
`memos/refactoring_plan/refactoring_todo.md` に既出の項目は、**本書で新たに具体的な位置と根拠を
特定できたものだけ**を再掲する(重複箇所には既出と明記した)。

---

## 0. 優先度サマリ

### A. 挙動のバグ(プレイに影響する)

| # | 内容 | 深刻度 | 確信度 | 修正難度 |
|---|---|---|---|---|
| **A1** | トリガーを離しても `wasFiring` が false に戻らない → 姿勢微調整が永続 ON・スピンアップ音が二度と鳴らない | **高** | 高 | 極小 |
| **A2** | 自動ワープ解除に `return` が無く、同フレームで速度段が ×4 に上書きされる | 中 | 高 | 極小 |
| **A3** | 決着後にカメラ更新が止まり、慣性系に取り残される(結果画面の裏で自機が飛び去る) | 中 | 高 | 小 |
| **A4** | 最後の敵が再突入・圏外離脱で消えると**勝利判定が二度と起動しない**(Stage1/2 が詰む) | 中 | 高 | 極小 |
| **A5** | `STAGE0_TIME_LIMIT = 30000`(8時間20分)。選択画面は「2分」、ブリーフィングは「500分」と表示 | 中 | 高 | 極小 |
| **A6** | `PLASMA_BULLET_SPEED` が `800*2/3` のままで `MUZZLE_SPEED=1000` に追従していない | 低 | 高 | 極小 |
| **A7** | `OrbitLine` の `force` が 120ms スロットルに先に潰され、推力中も毎フレーム追従しない | 低 | 高 | 極小 |
| **A8** | 決着後の簡略経路で `cleanup` / NaN 監視が走らない + `×4` がハードコード | 低 | 高 | 小 |
| **A9** | `MarkerManager` がマーカー要素を削除しないため DOM が単調増加(Stage00 で顕著) | 中 | 高 | 中 |
| **A10** | 的通過マークが死亡ターゲット基準で描かれ続ける(`autoTarget` と `aliveTarget` の不一致) | 低 | 高 | 極小 |
| **A11** | 右ドラッグ中にポインタが HUD 要素へ移ると `mouseFiring` が解除されず撃ちっぱなしになり得る | 低 | 中 | 小 |
| **A12** | 補給の再投入が `MAX_AMMO` を超え得る / ▣ マーカーは配列先頭 3 件しか見ない | 低 | 高 | 小 |

### B. 責務・規約の逸脱

| # | 内容 | 深刻度 |
|---|---|---|
| **B1** | `floating-origin.ts` が `'three'` から import(CLAUDE.md が明示的に禁止) | 中 |
| **B2** | `render/environment-scene.ts` が `game/`(const・Player・CameraSystem)に依存 | 中 |
| **B3** | `Targeter.resolveAutoTarget` が update フェーズで THREE カメラ行列を読む(1フレーム遅れ) | 中 |
| **B4** | `Enemy.firePlasma` が update フェーズで `obj.position/quaternion` を書く(しかも毎フレーム上書きされる) | 低 |
| **B5** | `PlayerThrottle.autoAlignTorque` が THREE.Quaternion で姿勢誤差を計算(`attitude.ts` に同等物あり) | 中 |
| **B6** | `PlanEditor.updateEditing` が update フェーズで計画パネルの DOM を書く | 低 |
| **B7** | `Game.pause()` が `simulator.lastSimDt` を外から書き換える | 低 |
| **B8** | `Enemy.behave` が全ステージの交戦距離に `STAGE00_MAX_RANGE` を使う | 低 |
| **B9** | `Stage00` の敵 HP に `STAGE0_ENEMY_HP` を使う | 低 |
| **B10** | `dispose()` が Ship / Ammo / DebrisPiece で三者三様(Ammo は Ship と完全重複) | 低 |

### C. パフォーマンス

| # | 内容 | 影響 |
|---|---|---|
| **C1** | `PlanEditor.nodeArrivings()` がマップモード中**毎フレーム2回**フル RK4 伝播 | **大** |
| **C2** | `Simulator.allEntities()` が毎フレーム3回、全エンティティの配列コピーを作る | 中 |
| **C3** | `HitSystem` がサブステップごとに targets 配列を作り、最大 64 回/フレーム走る | 中 |
| **C4** | `resolveCollisions` が毎フレーム `svgOverlay.innerHTML = ''` + O(n²)×5 反復 | 中 |
| **C5** | `SampledLine.syncGeometry` が bake のたびに `BufferGeometry` を作り直す | 中 |
| **C6** | `OrbitLine` が敵1機ごとに 2048 点バッファ + 専用マテリアル | 中(既出) |
| **C7** | `HudPanels` が 10Hz で `innerHTML` を全書き換え(HP バーの CSS transition が無効化される副作用付き) | 小 |
| **C8** | `PredictSystem` が同じ `sampleAt` を1フレームに3回呼ぶ | 小 |
| **C9** | `Hud.hint()`/`tick()` が毎回 `getElementById` | 小 |

### D. 文書・コメントと実装の乖離

D1〜D9(§4)。**CLAUDE.md が `cameraSystem.mapMode` のままである点(D1)は
`refactoring_todo.md` 冒頭の未完タスクそのもの**で、src 側の改名は既に完了している。

### E. 命名・重複・小さな整理

E1〜E13(§5)。

---

## 1. 挙動のバグ

### A1. 【高】トリガーを離しても `wasFiring` が false に戻らない

**位置**: `src/game/player/player-fire.ts:82-102`

```ts
updateFireState(...): void {
  this.tickReloadTimer(dt);
  const keyHeld = input.down(K.fire) || input.mouseFiring;
  if (!keyHeld) return;          // ← ここで抜けるが wasFiring は true のまま
  ...
}
```

`wasFiring = false` を書くのは `stopFiring()`(ポーズ時のみ)・`tickMapMode()`(マップモード中)・
`initAmmo()` の 3 箇所だけで、**戦闘中にトリガーを離す経路にリセットが無い**。

**影響**:

1. `Player.updateTorque` の `const fine = this.fineAttitude || this.fire.isFiring;`
   (`src/game/player/player.ts:239`)が一度撃つと恒久的に true になり、
   **姿勢制御が `FINE_ATTITUDE_SCALE = 0.5` に固定される**。CLAUDE.md は
   「releasing the trigger restores full authority with no edge-tracking state」と
   明記しているので、仕様に対する明確な違反。
2. `fireCycle` の `justStartedFiring` が二度と true にならず、
   **`sfx.spinUp()` と `SPINUP_TIME` の立ち上がり遅延が初回しか発生しない**
   (CIWS モチーフの演出が実質死んでいる)。
3. HUD の微調整モード表示(`panel.ts` の `fine`)は `player.fineAttitude` を見ているので、
   **表示は OFF なのに実際は微調整が効いている**という食い違いも起きる。

**対処**: `updateFireState` の `!keyHeld` 分岐で `this.wasFiring = false;`(必要なら
`wasEmptyClick = false` も)を立ててから return する。

### A2. 【中】自動ワープ解除に `return` が無い

**位置**: `src/game/sim-speed-manager.ts:91-104`

```ts
update(simTime: number): void {
  if (this.autoWarpUntil === null) return;
  const tRem = this.autoWarpUntil - simTime;
  if (tRem <= C.AUTOWARP_STOP) {
    this.autoWarpUntil = null;
    this._hud.hint('マニューバ実行点に接近 — ...');
    this.levelIdx = 0;          // ← ×1 へ戻したつもり
  }
  let idx = 0;
  for (...) if (SIM_SPEED_LEVELS[i] <= tRem / C.AUTOWARP_MARGIN) idx = i;
  this.levelIdx = idx;          // ← 直後に上書きされる
}
```

解除分岐から抜けずにループへ落ちるため、`levelIdx = 0` は同じフレームで潰される。
`AUTOWARP_STOP = 20`・`AUTOWARP_MARGIN = 4` なので tRem が 16〜20 秒なら
`tRem/4` が 4〜5 → **×4 が選ばれたまま自動ワープが終了する**。
以後 `autoWarpUntil === null` で早期 return するので、×4 のまま固定される。

**対処**: `levelIdx = 0` の直後に `return;` を足す。

### A3. 【中】決着後にカメラ更新が止まる

**位置**: `src/game/game.ts:199-205` と `game.ts:251`

`Game.update` は `!activeStage.isPlaying` で `stepSimulation` だけ回して return するが、
`cameraSystem.update(...)` はその **後ろ** にある。一方 `Game.sync` は止まらないので、
`chaseCamera.sync(fo)` は「凍結された絶対 ECI のカメラ位置」を「進み続ける自機位置」を
原点とする描画フレームへ変換し続ける。結果、**決着の瞬間からカメラが慣性系に取り残され、
自機(残骸)が軌道速度でフレームアウトする**。

現状は結果画面(`#hud-end` は `rgba(6,7,9,0.82)` でほぼ不透明)が覆い隠しているため
目立たないが、意図した挙動ではないはず(「撃墜された自機を見送る」演出も作れない)。

**対処**: `!isPlaying` の簡略経路でも `cameraSystem.update` を呼ぶ(入力は渡さない/
`player.alive=false` 経路の `computeChaseView` に任せる)か、明示的に「決着後の視点」を定義する。

### A4. 【中】最後の敵が自然消滅すると勝利判定が起動しない

**位置**: `src/game/stages/stage.ts:171-186`

```ts
recordEnemyDeath(enemy, simTime, cause = 'killed'): void {
  if (cause !== 'killed') {
    this.scoreCounter.recordEnemyLoss();
    this._hud.hint(...);
    return;                    // ← checkWin() を通らない
  }
  ...
  if (this.checkWin()) { ... }
}
```

`checkWin()` は `totalEnemiesSpawned - kills - losses <= 0` なので、**再突入(`losses`)でも
条件式自体は満たされる**。にもかかわらず判定を起動しないため、
「最後の1機が大気圏に落ちて消えた」ケースで Stage1/Stage2 が終了不能になる。
(`Enemy.checkLoss` は `REENTRY_ALT = 80km` で発火するので、J2 と抗力で徐々に落ちる長時間
ワープ中には現実に起こり得る。)

**対処**: `cause !== 'killed'` の分岐でも `checkWin()` を評価する。
「撃墜数ではなく生存数で勝敗が決まる」ことを条件式が既に表現しているので、
分岐を分ける理由自体が無い(コメントの「勝利判定は起動しない」も見直す)。

### A5. 【中】Stage0 の制限時間が説明と 250 倍ずれている

**位置**: `src/game/const.ts:228` / `src/game/stages/stage0.ts:16,24`

```ts
export const STAGE0_TIME_LIMIT = 30000; // 制限時間 [実秒]
```

- 選択画面の説明 `selectSub`: 「制限時間2分の撃墜数スコアアタック」
- ブリーフィング: `Math.floor(30000 / 60)` → 「制限時間 **500分**」

デバッグ用に伸ばしたまま戻っていない可能性が高い。3 箇所の食い違いを 1 つの値へ揃える
(2 分なら `120`)。`selectSub` 側もリテラルではなく定数から生成すべき(E11 参照)。

### A6. 【低】プラズマ弾速が定数の変更に追従していない

**位置**: `src/game/const.ts:275`

```ts
export const PLASMA_BULLET_SPEED = 800 * 2 / 3; // MUZZLE_SPEED の約 2/3
```

`MUZZLE_SPEED = 1000` なので、コメントどおりなら 666.7 のはずが 533.3 になっている。
`MUZZLE_SPEED * 2 / 3` と書けば二度とずれない。

### A7. 【低】`OrbitLine` の `force` がスロットルに先に潰される

**位置**: `src/render/orbitline.ts:85-89`

```ts
private needsRegen(el, force, focusE?): boolean {
  if (!this.snap) return true;
  const now = performance.now();
  if (now - this.lastRegen < REGEN_MIN_INTERVAL_MS) return false;  // ← force より先
  if (force) return true;
```

ファイル冒頭のコメントは「推力中・ノード編集中は `force=true` で毎フレーム追従させる」と
書いているが、実際は 120ms(≒8Hz)に間引かれる。噴射中に軌道線がカクつく原因になる。
意図がスロットル優先なら**コメントを直す**、コメントが仕様なら `force` 判定を先に置く。

### A8. 【低】決着後の簡略経路の抜け

**位置**: `src/game/game.ts:199-205`

```ts
const simDt = dt * Math.min(this.simSpeedManager.simSpeed, 4);
this.simulator.stepSimulation(dt, simDt, ..., false, false, false);
return;
```

- `4` は `C.MAX_PHYS_SIM_SPEED` のハードコード。定数を参照すべき。
- `simulator.cleanup()` を呼ばないので、決着後は `alive=false` の個体が配列に残り続け、
  再突入した弾・薬莢も回収されない(決着後もワープで時間は進められる)。
- `nanWatchdog` も走らないので、この経路で状態が壊れても検出されない。
- **`isPaused` の判定より前にあるため、決着後はポーズ中でもシミュレーションが進む**。
  ポーズの意味論としては一貫していない。

### A9. 【中】`MarkerManager` がマーカー要素を削除しない

**位置**: `src/game/marker/marker-manager.ts:25,110-113`

`markerDictionary` は `set()` で追加されるだけで、`hide()` は `display:none` にするのみ。
削除 API が存在しない。キーが有限のマーカー(`pro`/`bore`/`mg0..2`/`nd` など)は問題ないが、
**対象ごとに一意なキーを持つもの**は増える一方になる:

- `enemy-<name>` と `enemy-<name>-bearing`(`grouped-markers.ts`)
- `lead-<name>`(`lead-markers.ts`)

Stage00 は敵名が `W<波>-<番号>` で無限に増えるため、**1 機あたり div 3 個 + span 6 個**が
永久に DOM へ残る。数百波では数千要素になり、`resolveCollisions()` が
`markerDictionary.values()` を全走査する(§C4)ため CPU 側も比例して重くなる。

**対処**: `retire()` から呼べる `remove(key)` を追加し、`GroupedMarkers`/`LeadMarkers` は
hide ではなく remove する。既出の「マーカーを DOM でなく canvas で描く」検討
(`refactoring_todo.md`)とは独立に、今の実装のままでも直せる。

### A10. 【低】的通過マークが死亡ターゲット基準で残る

**位置**: `src/game/targeter.ts:56`(記録側)と `targeter.ts:99`(表示側)

記録は `this.aliveTarget`、表示は `this.autoTarget` を見ている。ターゲットが撃破されると
`aliveTarget` は null になるが `autoTarget` は死亡個体を指したままなので、
`syncBoardMarkers` は消滅した敵の凍結位置を基準に ✦ を描き続ける
(`markerManager.setPosition(..., add(target.state.r, m.off), ...)`)。
表示側も `aliveTarget` を見るように揃える。

### A11. 【低】右ドラッグ中に `mouseFiring` が解除されない可能性

**位置**: `src/game/input/input.ts:121-123,167`

右ボタン押下時は `setPointerCapture` していない(左=0 と中=1 だけ捕捉している)ため、
押したままポインタが `pointer-events: auto` の HUD 要素(⚙ ギア `#hud-gear` など)へ入ると
`pointerup` がキャンバスに届かず、`mouseFiring` が true のまま残る。
以後トリガーを押していなくても撃ち続ける。`window` 側の `pointerup`/`blur` で保険を張るか、
button===2 でも capture するのが素直。

### A12. 【低】補給数の上限が投入経路によって守られない

**位置**: `src/game/stages/stage-utils/logistics.ts:98-109,72-83`

- `despawnFarAmmo` の再投入ループは `ammos.length < C.MAX_AMMO` を確認せず、
  デスポーン数と同数を無条件に投入する(`updateLogistics` の定期投入だけが上限を見ている)。
- `Stage00.init` も `MAX_AMMO` 回まわして初期配置する一方、`syncMarkers` は
  `this.ammos[i]`(i < MAX_AMMO)しか見ない。**配列は Simulator 所有で prune により詰められる**
  ため、上限を超えた瞬間だけでなく順序が変わったときも「マーカーの出ない補給」が生じる。

**対処**: マーカーは `ammos.slice(0, MAX_AMMO)` ではなく「生存している ammo を距離順に N 件」など
配列位置に依存しない選び方にし、投入は 1 箇所(`spawnForPlayer` の内側)で上限を守る。

---

## 2. 責務・規約の逸脱

### B1. `floating-origin.ts` が `'three'` から import している

**位置**: `src/game/floating-origin.ts:1`

```ts
import * as THREE from 'three';
```

CLAUDE.md は「Import THREE **only** from `'three/webgpu'`(mixing with `'three'` would
duplicate classes at runtime)」と明記している。**しかも `FloatingOrigin` は
「論理 Vec3 → THREE.Vector3 の唯一の橋渡し」**であり、ここで作られた `Vector3` が
`camera.position.copy()` や `obj.position.copy()` へ渡る。`copy()` は構造的に `.x/.y/.z` を
読むだけなので現状は動くが、規約違反であり、バンドルに three の実体が二重に入る恐れがある。

同じ違反が `src/render/glow-texture.ts:1` にもある(全文検索で該当はこの 2 件のみ)。

### B2. `render/` が `game/` に依存している

**位置**: `src/render/environment-scene.ts:10-13`

```ts
import { CameraSystem } from '../game/camera/camera-system';
import { FloatingOrigin } from '../game/floating-origin';
import * as C from '../game/const';
import { Player } from '../game/player/player';
```

`refactoring_todo.md` の「render/ と physics/ の責務境界の徹底」で
「要検証」とされていた点の具体例。`EnvironmentScene` は
`sync(params)` で `player`(自機位置の日照率算出のため)と `cameraSystem`(overviewMode 判定と
カメラ位置)を丸ごと受け取っており、**必要なのは実際には「自機位置」「広範囲視点か」
「カメラ位置」の 3 値だけ**。値渡しに落とせば `game/` への import は
`FloatingOrigin` 1 つ(これは描画基盤なので `render/` 側へ移してもよい)まで減らせる。

`EnvironmentSyncParams` は CLAUDE.md が認めている「生き残りの ctx」だが、
上記のとおり中身を薄くすれば ctx をやめられる。

### B3. `Targeter.resolveAutoTarget` が update フェーズで THREE カメラを読む

**位置**: `src/game/targeter.ts:199-208`

```ts
const camFwdW = new THREE.Vector3();
activeCamera.getWorldDirection(camFwdW);
```

`updateCombatTargeting` は `Game.update` の末尾から呼ばれる(`game.ts:269`)。
**`THREE.PerspectiveCamera` の行列が更新されるのは `Game.sync` の `cameraSystem.sync()`** なので、
ここで読めるのは**前フレームのカメラ姿勢**。しかも「update は THREE.js オブジェクトに触らない」
という CLAUDE.md の構造ルールに反する。

他の全消費者(マーカー投影・ノード判定・ターゲットのクリック判定)は THREE 非依存の
`ProjectFn` / `camera.position` を使っているのに、ここだけが例外になっている。
`ChaseCamera`/`OverviewCamera` は `position` と `lookTarget` を絶対 ECI で公開しているので、
`norm(sub(lookTarget, position))` で同じ前方向が THREE 抜きで得られる。

### B4. `Enemy.firePlasma` が update フェーズでメッシュを操作する

**位置**: `src/game/orbit-entity/enemy.ts:209-216`

```ts
pb.obj.position.set(r.x, r.y, r.z);           // ← ECI 生値。fo を通していない
const mz = new THREE.Matrix4().lookAt(...);
pb.obj.quaternion.setFromRotationMatrix(mz);
```

- update フェーズで THREE を触っている(B3 と同じルール違反)。
- **`position` に絶対 ECI 座標(6.8e6 級)をそのまま入れている**。フローティングオリジンを
  通していないので、`Bullet.sync` が呼ばれるまでの 1 フレーム分は座標が桁外れになる。
- そもそも `Bullet.sync(fo)` が毎フレーム position と quaternion の両方を
  (速度方向基準で)上書きするので、**この 6 行はすべて無駄**。

`new THREE.Matrix4()` の生成もバースト射撃のたびに走る。単純に削除できる。

### B5. `autoAlignTorque` が THREE.Quaternion で姿勢誤差を計算している

**位置**: `src/game/player/player-throttle.ts:144-163`

`new THREE.Quaternion()` を毎フレーム 3〜4 個生成し、`invert`/`multiply`/`applyQuaternion` で
姿勢誤差を解いている。ところが `physics/attitude.ts` には
`qMul` / `qInvert` / `qRotate` / `qFromAxisAngle` が**すべて揃っている**(THREE 非依存・純関数)。

これは「物理・制御のロジックが描画ライブラリに依存する」典型で、
`refactoring_todo.md` の「physics に THREE 依存を持ち込むべきじゃない」の趣旨に反する
(場所は game/ だが、内容は完全に姿勢制御の数学)。
`attitude.ts` の関数へ置き換えれば毎フレームのオブジェクト生成も消える。

### B6. `PlanEditor.updateEditing` が update フェーズで DOM を書く

**位置**: `src/game/plan/plan-editor.ts:359-402`(`renderPanel` → `planBody.innerHTML`)

`game.ts:266` から `Game.update` の中で呼ばれている。CLAUDE.md の分割規約では
「`sync` builds ... and pushes already-computed logical state into meshes/DOM」なので、
パネル描画は `PlanEditor.sync()` 側に置くのが筋。
(`PlanEditor.sync(mapDist)` は既に毎フレーム呼ばれているので移すだけで済む。)

### B7. `Game.pause()` が `Simulator` の状態を書き換える

**位置**: `src/game/game.ts:180`

```ts
pause(): void { this.simulator.lastSimDt = 0; ... }
```

`DEVELOP/OWNERSHIP.md` は `lastSimDt` の正本を `Simulator` としている。
`Simulator.pause()`(または `notifyPaused()`)を生やして内部で 0 にするか、
そもそも `lastSimDt` の消費者(`effects.sync`)側でポーズを考慮する形にしたい。

### B8 / B9. ステージ固有定数の越境利用

- `src/game/orbit-entity/enemy.ts:154` — 全ステージ共通の敵 AI が
  `C.STAGE00_MAX_RANGE` を交戦距離として使っている。Stage1/2 の敵も
  「Stage00 のデスポーン距離」で射撃可否が決まる。`ENEMY_ENGAGE_RANGE` のような
  AI 用の定数へ切り出すべき。
- `src/game/stages/stage00.ts:281` — Stage00 の敵 HP に `C.STAGE0_ENEMY_HP` を使っている。
  `STAGE00_ENEMY_HP` を定義するか、両者が同じ値であるべき理由を書く。

### B10. `dispose()` の実装が三者三様

- `Ship.dispose`(`entities.ts:122-130`) — マテリアルのみ破棄。`ownsMaterial` を確認しない。
- `Ammo.dispose`(`entities.ts:141-149`) — **`Ship.dispose` と 1 文字も違わない重複実装**。
- `DebrisPiece.dispose`(`entities.ts:197-210`) — `userData.ownsGeometry/ownsMaterial` を確認する。

`cloneIndependent()`(`render/ships.ts:62`)が `ownsMaterial = true` を立てているので
現状はどれも壊れないが、**共有マテリアルを使うテンプレートを一つ足した瞬間に
`Ship`/`Ammo` 経路だけが他個体のリソースを奪う**。
`OrbitEntity` に「フラグを見て破棄する」共通 dispose を一本化し、3 実装を 1 つに畳むべき。

---

## 3. パフォーマンス

### C1. 【大】`nodeArrivings()` が毎フレーム 2 回フル RK4 伝播する

**位置**: `src/game/plan/plan-editor.ts:124-132`。呼び出しは
`updateEditing()`(`:360`, update フェーズ)と `updateGizmo()`(`:333`, sync フェーズ)の 2 箇所。

```ts
for (const node of this.plan.nodes) {
  out.push(propagateState(state, node.t, this.ephemeris));  // ← 数値積分
  state = node;
}
```

`propagateState`(`physics/predict.ts:102`)はキャッシュを持たない素の RK4 ループで、
刻みは `predictStepDt`。LEO(r≈6.8e6)・duration 1 日なら **dt ≈ 8.5 秒**なので、
**ノード 1 個を 1 日先に置いただけで 1 回あたり約 10,000 ステップ**。
1 ステップは RK4 なので加速度評価 4 回、各評価が太陽・月位置の参照を伴う。
これが毎フレーム 2 回 = 約 8 万回の加速度評価/フレーム。

得ている情報は「各ノードの到達速度」= Δv 表示とハンドルラベルだけで、
**同じ区間の予測は `PredictedLine` が既にスロットル付きで計算し `samplesRef()` として
保持している**(`plan-trajectory.ts` 経由でこのクラスからアクセスできる)。

**対処**: (a) `traj.sampleAt(node.t)` で近傍サンプルから到達状態を取る、
(b) 少なくとも `nodeArrivings()` の結果を 1 フレーム内で共有する
(現状は update と sync で別々に計算している)、(c) それでも精度が要るなら
`PlanEditor` 側にも入力変化検出付きのキャッシュを置く。
`refactoring_todo.md` の「predict が本当に延長分だけ計算しているか確認」は
**折れ線側ではなくここが本命**である可能性が高い。

### C2. `Simulator.allEntities()` が毎フレーム 3 回配列を作る

**位置**: `src/game/orbit-entity/simulator.ts:75-83`

スプレッドで新しい配列を作る実装で、呼び出しは
`stepSimulation`(衝突解決時)・`sync`・`NanWatchdog.checkAll` の 3 箇所。
エンティティ数は薬莢 260 + デブリ 160 + 弾 1200 + 敵 → **最大 1600 要素の配列を毎フレーム 3 本**。
用途はすべて「順に走査するだけ」なので、コールバックを取る `forEachEntity(fn)` か
配列の配列を返す形にすれば割り当てをゼロにできる。

### C3. `HitSystem` の当たり判定コスト

**位置**: `src/game/orbit-entity/hit.ts:15-31`

```ts
const targets: (Player | Enemy)[] = [player, ...simulator.enemies];  // 毎サブステップ
```

`checkBulletHits` は**サブステップごと**に呼ばれる(`stepSimulation` のループ内)。
高ワープでは `SUBSTEP_MAX_COUNT = 64` 回/フレームなので、
弾 1000 発 × 敵 30 機 × 64 = 約 200 万回の線分-球判定 + 配列生成 64 回。
`refactoring_todo.md` の「spatial hash 化」の対象だが、その前に
**(a) targets 配列をループ外へ出す、(b) プラズマ弾は敵ループに入る前に弾く、
(c) 命中した弾は `break` する**だけでも数倍効く。

### C4. `resolveCollisions()` の毎フレーム全走査

**位置**: `src/game/marker/marker-manager.ts:115-187`

- `svgOverlay.innerHTML = ''` → 全 SVG 子要素の破棄と再生成を毎フレーム。
- ラベル緩和が O(n²) × 5 反復。
- 位置を `parseFloat(m.root.style.left)` で**DOM の文字列から読み戻している**
  (`set()` で `toFixed(1)` して書いた値をパースし直す)。数値をそのまま保持すればよい。
- A9 の DOM 蓄積により n が単調増加するので、時間とともに悪化する。

`refactoring_todo.md` の「マーカーの表示位置が微妙にずれる」の原因候補として、
この `toFixed(1)` 往復と、ラベル幅の推定 `textLen * 6.5 + 4` が挙がる
(日本語ラベルは全角で幅が倍近く違うので、緩和量の見積もりが実際とずれる)。

### C5. `SampledLine.syncGeometry` が毎回ジオメトリを作り直す

**位置**: `src/render/sampled-line.ts:45-64`

bake のたびに `new Float32Array` + `new THREE.BufferGeometry()` を作り、
古い方を `dispose()` してから差し替えている。`PREDICT_MAX_SAMPLES = 2000` 固定なので、
`OrbitLine` と同じく**確保済みバッファ + `setDrawRange`** にすれば
GPU バッファの生成・破棄が消える。

`refactoring_todo.md` の「`setIndexBuffer` on GPURenderPassEncoder ... が出た」という
再現性の低い WebGPU エラーは、**描画対象に紐づいたジオメトリを dispose して差し替える**
この種の操作が疑わしい(確信度は低い。要実機再現)。

### C6〜C9(要点のみ)

- **C6** `OrbitLine` は敵 1 機ごとにコンストラクタで生成され、`POINT_COUNT = 2048` の
  Float32Array(24KB)と専用 `LineBasicMaterial` を持つ。マップモードでしか描かないのに
  常時確保している。マテリアル共有は `refactoring_todo.md` に既出。
  頂点数もマップの縮尺に対して過剰(2048 点は 4.5e9 m スケールでは 1 点/数千 km)。
- **C7** `HudPanels.setTarget` は 0.1 秒ごとに `body.innerHTML` を全置換する。
  HP バーに書いてある `transition:width 0.2s` は**要素ごと作り直されるので一度も効かない**。
  行単位の `textContent` 更新へ変えれば、割り当ても減り transition も生きる。
- **C8** `PredictSystem.sync` は `syncGhost` → `plannedPlayerLabel` → `panel.setSliderLabel`
  の経路で `traj.sampleAt(t)` を 1 フレームに 3 回呼ぶ。1 回に纏められる。
- **C9** `Hud.hint()` / `Hud.toast()` / `Hud.tick()` が毎回 `document.getElementById`。
  `buildHudDom()` が返す `els` マップに既に入っているので、コンストラクタで保持すべき。

---

## 4. 文書・コメントと実装の乖離

| # | 位置 | 内容 |
|---|---|---|
| **D1** | `CLAUDE.md:114,122` | `CameraSystem` の状態を `mapMode` と書いているが、実装は `overviewMode`。`refactoring_todo.md` 冒頭の「`Map` の乱用をやめ、改名」タスクのうち **src は完了済みで、CLAUDE.md だけが未追随**。`DEVELOP/*.md` は正しい |
| **D2** | `CLAUDE.md`(Architecture の Simulator 節) | 「the `enemies`/`bullets`/`casings`/`debris`/`ammos` arrays (capped, oldest evicted on overflow)」とあるが、**`addEnemy`/`addAmmo` に上限は無い**(`simulator.ts:52,65`)。Stage00 は敵を無限に増やせる |
| **D3** | `src/game/player/player.ts:52` | 「高度420km・傾斜51.6°の円軌道に…」というコメント。実際の `INITIAL_INC_DEG` は **97.0°**(太陽同期相当) |
| **D4** | `src/game/player/player.ts:49` | 「姿勢角微調整モード 射撃立ち上がりで有効化し、立下りで無効化する」— 現在の `fineAttitude` は [V] のトグルで、射撃との合成は `updateTorque` 側。A1 とあわせて書き直しが要る |
| **D5** | `src/render/environment-scene.ts:2,15-20` | 冒頭に「game.ts のゲームプレイ定数(const.ts)には依存しない — 必要な値は呼び出し側から渡す」とあるが、実際は `C.SUN_INTENSITY` 等を直接使う。そのために用意した `EnvironmentLightingParams` はコンストラクタ引数ごとコメントアウトされ、**型だけが宙に浮いたデッドコード**になっている |
| **D6** | `src/game/vfx/effects-system.ts:48-49` | 「以後 fx が独立して動くよう、ここで clone して保持する」とあるが clone していない。Vec3 が不変になった今 clone は不要なので、**コメントが古い**(`vec3.clone()` は存在しない、と CLAUDE.md にある) |
| **D7** | `memos/mikanixonable/REFACTORING_REPORT.md` | 存在しないモジュール(`game/pip-renderer.ts`・`camera/pip-camera.ts`・`marker/pip-overlay.ts`・`stage-utils/wave-manager.ts`)を現況として記載している。PIP は全廃、ウェーブ管理は `stage00.ts` へ内包済み |
| **D8** | `src/physics/attitude.ts:148` | `remaining = Math.min(dt, ATT_MAX_SUB_DT * ATT_MAX_ITERS)` により、**1 回の `stepAttitude` は最大 0.48 秒ぶんしか回らない**。`Simulator.stepAttitudes` は自機に `simDt`(ワープ ×4096 なら 65 秒)を渡すので、高ワープでは姿勢がほぼ凍結する。安定性のための意図的な処置だと思われるが、`DEVELOP/SPEC.md` にも CLAUDE.md にも記載が無い。あわせて、**自機だけ `simDt` 生値・他は `min(simDt, 0.12)`** という非対称(`simulator.ts:178-184`)も理由が書かれていない |
| **D9** | `src/game/const.ts:138` / `simulator.ts:57` | `MAX_BULLETS = 400` だが実際の上限は `addBullet` の `C.MAX_BULLETS * 3` = 1200。定数名が実際の上限を表していない |

---

## 5. 命名・重複・小さな整理

| # | 位置 | 内容 |
|---|---|---|
| **E1** | `simulator.ts:104-112` | `stepSimulation(dt, simDt, player, activeStage, bulletCollision, resolveCollision, doSubstep)` — 末尾 3 つが無名の boolean。呼び出し側(`game.ts:203,233`)が行末コメントで補っている時点で設計が破綻している。`{ mode: 'full' \| 'settled' }` 相当へ畳めるはず(3 つの真偽値は常に同時に切り替わる) |
| **E2** | `plan-editor.ts:196-242` | `handleMapClick` と `handleNodeRightClick` のノード探索ループが完全な重複。`pickNodeAt(mx, my): number \| null` に括れる |
| **E3** | `player.ts:216-224` / `enemy.ts:99-107` | `hitEffect` が両者で同一実装(色・定数まで同じ)。`Ship` 側か `EffectsSystem` 側へ 1 つに |
| **E4** | `stage.ts:11` | `import { ScoreCounter as scoreCounter }` — クラスを小文字始まりへ別名化している。`fields` の型注釈(`stage.ts:48`)も読みにくくなっている |
| **E5** | `marker-manager.ts:116` | `{ m: any; ... }` — 唯一の `any`。`markerDictionary` の値型を型エイリアスにして使えばよい |
| **E6** | `orbitline.ts:136-138` | `hHat: { ...el.hHat }` / `pHat: { ...el.pHat }` — CLAUDE.md が禁じる「`Vec3` をオブジェクトリテラルで作る」に抵触する(ブランドはスプレッドで運良く残るが、規約上は `v3()` 経由)。`Vec3` は不変なので**そもそもコピー不要**で、参照をそのまま持てばよい |
| **E7** | `predict-system.ts:36-42` | `set forceCurrent` の中身がまるごとコメントアウトされたコード。`refactoring_todo.md` の「forceCurrent と同時にスライダーも 0 に」に対応する保留だが、**コードではなく todo 側に置くべき**(コメントアウトは残さない) |
| **E8** | `render/scene.ts:22-27` | `GameScene.resize` を返しているが `main.ts` は使っていない(内部で `addEventListener` 済み)。未使用の公開 API。また `setPixelRatio` が初期化時のみで、ウィンドウ間移動・ズーム時に追従しない |
| **E9** | 各所 | 使われない引数・戻り値: `Player.checkLoss(_dt, _simTime, _activeStage, _playerPos)` は `_playerPos` に **自分自身の `state.r` を渡されている**(`game.ts:245`)。`Targeter.updateCombatTargeting` の戻り値は捨てられている(`game.ts:269`)。`Enemy` コンストラクタの `_hud` は「対で注入する方針」のため受けるだけ(`enemy.ts:39-41`)— 方針自体は `refactoring_todo.md`「引数整理」で見直し対象 |
| **E10** | `game.ts:378-385` | `perfCounts()` に `ammos` が無い。`?perf=1` でエンティティ数を見るときに補給だけ勘定から漏れる |
| **E11** | 各所 | const.ts に無いマジックナンバー: `plan-editor.ts:262` の `/ 200`(px→Δv 換算)、`effects-system.ts:101` の `11`(破片数)と `2.8`(拡散)、`collision.ts:66,88` の `restitution = 0.4` と `0.8`(めり込み補正係数)、`chase-camera.ts:124-125` の `12`/`8000`(距離クランプ)、`stage0.ts:16` の「5km以内」「2分」(定数と二重管理) |
| **E12** | `plan.ts:54-60,82-89` | `addNode`/`retimeNode` が `this._nodes.indexOf(postState)` で**オブジェクト参照一致**に頼って挿入位置を求めている。同一参照の `OrbitState` を 2 度渡すと壊れる。`sortByTime` が返す順序から直接求められる |
| **E13** | `player-fire.ts:182-194` | `manualReload()` は空マガジンフレームを排出しないが、自動の `'barrel-reload'` は排出する(`fireCycle:155-160`)。同じ「バレル交換」で演出が非対称 |

---

## 6. 補足: 既出項目のうち、位置を特定できたもの

`refactoring_todo.md` に列挙済みだが本調査で具体化できたものを対応付けておく。

| todo の項目 | 本書の該当 |
|---|---|
| リネームにドキュメントを合わせる | **D1**(残っているのは CLAUDE.md の 2 箇所のみ) |
| markerManager のメモリリーク懸念 | **A9**(リークは実在。`enemy-*`/`lead-*` キーが増え続ける) |
| マーカーの表示位置が微妙にずれる | **C4**(`toFixed(1)` の DOM 往復とラベル幅推定が候補。全角文字で顕著になるはず) |
| predict が本当に延長分だけ計算しているか | **C1**(折れ線側は入力変化検出付きで妥当。重いのは `nodeArrivings` の無キャッシュ伝播) |
| hit/collision を spatial hash に | **C3**(その前にサブステップ内の定数コストを削るほうが効く) |
| orbitLine のマテリアル再生成 | **C6** |
| render/physics の責務境界 | **B1**(three の import 元)・**B2**(render→game 依存)・**B5**(制御演算が THREE 依存) |
| plan の addNode/removeNode が下流を破棄しない | 未修正を確認(`plan.ts:54-66`)。`retimeNode`/`applyNodeDv` だけが破棄している |
| dt と simDt の混在 | `player-fire.ts` の射撃周期は実時間 `dt`、弾の生成時刻は `simTime`。ワープ ×4 では「実 1 秒に 16 発撃つが、弾の時刻は 4 秒分進む」状態になる |

---

## 7. 着手順の提案

1. **A1 → A2 → A4**(いずれも数行。プレイ体験と進行不能に直結)
2. **A5 / A6 / D3 / D4**(定数とコメントの整合。1 コミットで済む)
3. **C1**(マップモードのフレームレートに最も効く)
4. **A9 + C4**(マーカー機構。DOM 削除 API の追加が本体)
5. **B1 / B3 / B4 / B5**(規約違反の解消。B4 は削除するだけ)
6. **D1 / D7**(文書の追随。`/develop-docs` の手順で)

§5 の E 群は、上記のいずれかを触るついでに同じ変更セットへ入れるのが効率的
(E1 は A8 と、E2 は C1 と、E6 は A7 と同じファイル)。

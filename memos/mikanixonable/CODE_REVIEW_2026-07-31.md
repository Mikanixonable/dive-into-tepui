# コードベース全体レビュー — 修正すべき点の一覧

調査日: 2026-07-31 / 調査時点: ブランチ `workspace3` `da67e8f` / 最終更新: `75e9652` 時点
調査方法: `DEVELOP/{CALLSTACK,OWNERSHIP}.md` と CLAUDE.md で当たりを付けたのち、
`src/` の主要モジュール(game/ 全域・physics/ 全域・render/ 主要・player/・stages/・plan/・predict/)を読解。
**この文書は未解決の項目だけを載せる。直したものは消す。**「実機確認」を経ていない項目には確信度を併記した。

前提: `npm run typecheck` はエラーなし。`TODO`/`FIXME`/`any` の類はほぼ皆無で、
コメント密度・命名規約・責務分割はよく維持されている。以下は**その水準の上で残っている**問題。

既存の `BUG_REPORT.md` / `MEMORY_LEAK.md`(2026-07-26)で指摘された dispose 系リークは、
現在のコードでは修正済みであることを確認した(本書では重複して挙げない)。
`memos/hedalu244/refactoring_plan/refactoring_todo.md` に既出の項目は、**本書で新たに具体的な位置と根拠を
特定できたものだけ**を再掲する(重複箇所には既出と明記した)。

> **A(挙動のバグ)は全 12 件が解消済みなので、章ごと削除した。** 対応コミット:
> A3・A4 `70826c4` / A7・D1〜D6・E7 `86f260b` / A1 `664e4f5` / A2 `609df65` / A10 `d397a4a` /
> A5・A6 `7d9fdb2` / A11 `7078bdb` / A8 `d837287` / A9 `ec3f156` / A12 `75e9652`。
> A7 は実装ではなくコメントの方を実装(120ms スロットル)へ合わせて解決した。
> **残りはいずれも「今すぐ壊れている」ものではなく、設計の逸脱・性能・文書の問題**である。
> B〜E の番号は当時のまま欠番にしてある。

---

## 0. 優先度サマリ

### A. 挙動のバグ

**なし(全件解消)。**

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

### D. 文書と実装の乖離

D7〜D10(§3)。コード中のコメントの乖離は解消済みで、残っているのは
**SPEC.md の棚卸し(D10)**・調査レポートの陳腐化(D7)・未記載の制約(D8)・定数名(D9)。

### E. 命名・重複・小さな整理

E1〜E6, E8〜E13(§4)。

---

## 1. 責務・規約の逸脱

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

**位置**: `src/render/environment-scene.ts` の import 群

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

**位置**: `src/game/targeter.ts` の `resolveAutoTarget`

```ts
const camFwdW = new THREE.Vector3();
activeCamera.getWorldDirection(camFwdW);
```

`updateCombatTargeting` は `Game.update` の末尾から呼ばれる。
**`THREE.PerspectiveCamera` の行列が更新されるのは `Game.sync` の `cameraSystem.sync()`** なので、
ここで読めるのは**前フレームのカメラ姿勢**。しかも「update は THREE.js オブジェクトに触らない」
という CLAUDE.md の構造ルールに反する。

他の全消費者(マーカー投影・ノード判定・ターゲットのクリック判定)は THREE 非依存の
`ProjectFn` / `camera.position` を使っているのに、ここだけが例外になっている。
`ChaseCamera`/`OverviewCamera` は `position` と `lookTarget` を絶対 ECI で公開しているので、
`norm(sub(lookTarget, position))` で同じ前方向が THREE 抜きで得られる。

### B4. `Enemy.firePlasma` が update フェーズでメッシュを操作する

**位置**: `src/game/orbit-entity/enemy.ts` の `firePlasma` 末尾

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

**位置**: `src/game/player/player-throttle.ts` の `autoAlignTorque`

`new THREE.Quaternion()` を毎フレーム 3〜4 個生成し、`invert`/`multiply`/`applyQuaternion` で
姿勢誤差を解いている。ところが `physics/attitude.ts` には
`qMul` / `qInvert` / `qRotate` / `qFromAxisAngle` が**すべて揃っている**(THREE 非依存・純関数)。

これは「物理・制御のロジックが描画ライブラリに依存する」典型で、
`refactoring_todo.md` の「physics に THREE 依存を持ち込むべきじゃない」の趣旨に反する
(場所は game/ だが、内容は完全に姿勢制御の数学)。
`attitude.ts` の関数へ置き換えれば毎フレームのオブジェクト生成も消える。

### B6. `PlanEditor.updateEditing` が update フェーズで DOM を書く

**位置**: `src/game/plan/plan-editor.ts` の `updateEditing` → `renderPanel`

`Game.update` の中から呼ばれている。CLAUDE.md の分割規約では
「`sync` builds ... and pushes already-computed logical state into meshes/DOM」なので、
パネル描画は `PlanEditor.sync()` 側に置くのが筋。
(`PlanEditor.sync(mapDist)` は既に毎フレーム呼ばれているので移すだけで済む。)

### B7. `Game.pause()` が `Simulator` の状態を書き換える

**位置**: `src/game/game.ts` の `pause()`

```ts
pause(): void { this.simulator.lastSimDt = 0; ... }
```

`DEVELOP/OWNERSHIP.md` は `lastSimDt` の正本を `Simulator` としている。
`Simulator.pause()`(または `notifyPaused()`)を生やして内部で 0 にするか、
そもそも `lastSimDt` の消費者(`effects.sync`)側でポーズを考慮する形にしたい。

### B8 / B9. ステージ固有定数の越境利用

- `src/game/orbit-entity/enemy.ts` の `behave` — 全ステージ共通の敵 AI が
  `C.STAGE00_MAX_RANGE` を交戦距離として使っている。Stage1/2 の敵も
  「Stage00 のデスポーン距離」で射撃可否が決まる。`ENEMY_ENGAGE_RANGE` のような
  AI 用の定数へ切り出すべき。
- `src/game/stages/stage00.ts` の `generateWave` — Stage00 の敵 HP に
  `C.STAGE0_ENEMY_HP` を使っている。`STAGE00_ENEMY_HP` を定義するか、
  両者が同じ値であるべき理由を書く。

### B10. `dispose()` の実装が三者三様

- `Ship.dispose`(`entities.ts`) — マテリアルのみ破棄。`ownsMaterial` を確認しない。
- `Ammo.dispose`(`entities.ts`) — **`Ship.dispose` と 1 文字も違わない重複実装**。
- `DebrisPiece.dispose`(`entities.ts`) — `userData.ownsGeometry/ownsMaterial` を確認する。

`cloneIndependent()`(`render/ships.ts`)が `ownsMaterial = true` を立てているので
現状はどれも壊れないが、**共有マテリアルを使うテンプレートを一つ足した瞬間に
`Ship`/`Ammo` 経路だけが他個体のリソースを奪う**。
`OrbitEntity` に「フラグを見て破棄する」共通 dispose を一本化し、3 実装を 1 つに畳むべき。

---

## 2. パフォーマンス

### C1. 【大】`nodeArrivings()` が毎フレーム 2 回フル RK4 伝播する

**位置**: `src/game/plan/plan-editor.ts` の `nodeArrivings()`。呼び出しは
`updateEditing()`(update フェーズ)と `updateGizmo()`(sync フェーズ)の 2 箇所。

```ts
for (const node of this.plan.nodes) {
  out.push(propagateState(state, node.t, this.ephemeris));  // ← 数値積分
  state = node;
}
```

`propagateState`(`physics/predict.ts`)はキャッシュを持たない素の RK4 ループで、
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

**位置**: `src/game/orbit-entity/simulator.ts` の `allEntities()`

スプレッドで新しい配列を作る実装で、呼び出しは
`stepSimulation`(衝突解決時)・`sync`・`NanWatchdog.checkAll` の 3 箇所。
エンティティ数は薬莢 260 + デブリ 160 + 弾 1200 + 敵 → **最大 1600 要素の配列を毎フレーム 3 本**。
用途はすべて「順に走査するだけ」なので、コールバックを取る `forEachEntity(fn)` か
配列の配列を返す形にすれば割り当てをゼロにできる。

### C3. `HitSystem` の当たり判定コスト

**位置**: `src/game/orbit-entity/hit.ts` の `checkBulletHits`

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

**位置**: `src/game/marker/marker-manager.ts` の `resolveCollisions()`

- `svgOverlay.innerHTML = ''` → 全 SVG 子要素の破棄と再生成を毎フレーム。
- ラベル緩和が O(n²) × 5 反復。走査対象は `markerDictionary` の全エントリで、
  表示中かどうかに関わらずまず全部を見る。
- 位置を `parseFloat(m.root.style.left)` で**DOM の文字列から読み戻している**
  (`set()` で `toFixed(1)` して書いた値をパースし直す)。数値をそのまま保持すればよい。

`refactoring_todo.md` の「マーカーの表示位置が微妙にずれる」の原因候補として、
この `toFixed(1)` 往復と、ラベル幅の推定 `textLen * 6.5 + 4` が挙がる
(日本語ラベルは全角で幅が倍近く違うので、緩和量の見積もりが実際とずれる)。

### C5. `SampledLine.syncGeometry` が毎回ジオメトリを作り直す

**位置**: `src/render/sampled-line.ts` の `syncGeometry`

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

## 3. 文書と実装の乖離

| # | 位置 | 内容 |
|---|---|---|
| **D7** | `memos/mikanixonable/REFACTORING_REPORT.md` | 存在しないモジュール(`game/pip-renderer.ts`・`camera/pip-camera.ts`・`marker/pip-overlay.ts`・`stage-utils/wave-manager.ts`)を現況として記載している。PIP は全廃、ウェーブ管理は `stage00.ts` へ内包済み。**日付とコミット範囲を明記した調査記録なので、現況へ直すのではなく「いつ時点の記録か」を先頭で強く断るだけでよい**とも言える — 扱いの方針を決める必要がある |
| **D8** | `src/physics/attitude.ts` の `stepAttitude` | `remaining = Math.min(dt, ATT_MAX_SUB_DT * ATT_MAX_ITERS)` により、**1 回の呼び出しは最大 0.48 秒ぶんしか回らない**。`Simulator.stepAttitudes` は自機に `simDt`(ワープ ×4096 なら 65 秒)を渡すので、高ワープでは姿勢がほぼ凍結する。安定性のための意図的な処置だと思われるが、`DEVELOP/SPEC.md` にも CLAUDE.md にも記載が無い。あわせて、**自機だけ `simDt` 生値・他は `min(simDt, 0.12)`** という非対称(`simulator.ts` の `stepAttitudes`)も理由が書かれていない |
| **D9** | `src/game/const.ts` / `simulator.ts` の `addBullet` | `MAX_BULLETS = 400` だが実際の上限は `C.MAX_BULLETS * 3` = 1200。定数名が実際の上限を表していない |
| **D10** | `DEVELOP/SPEC.md` §14「未実装」 | **実装済みの項目が未実装として残っている**: 薬莢が機体に当たった際の金属音(`sfx.clank`、`onPlayerCasingImpact` 経由で実装済み)、機体形状(寸胴な直方体+四発エンジン+ソーラーパドル+機首の縦二連機関砲 — `assets/models/player.json` は既にこの形)。敵 AI も「受動的で回避・反撃を行わない」とあるが、実際は `Enemy.behave` が見越し射撃で撃ち返す(**回避機動(推進)だけが未実装**なので、記述を分ける必要がある)。同 §6 の Navball も存在しない `src/game/navball.ts` を前提に書かれている(現状は `player/player-markers.ts` の方向マーカーが代替)。SPEC は「意図」の文書で現況と食い違ってよいが、**§14 は現況の申告なので事実と合っている必要がある** |

---

## 4. 命名・重複・小さな整理

| # | 位置 | 内容 |
|---|---|---|
| **E1** | `simulator.ts` の `stepSimulation` | `stepSimulation(dt, simDt, player, activeStage, bulletCollision, resolveCollision, doSubstep)` — 末尾 3 つが無名の boolean。呼び出し側(`game.ts`)が行末コメントで補っている時点で設計が破綻している。`{ mode: 'full' \| 'settled' }` 相当へ畳めるはず(3 つの真偽値は常に同時に切り替わる) |
| **E2** | `plan-editor.ts` の `handleMapClick` / `handleNodeRightClick` | ノード探索ループが完全な重複。`pickNodeAt(mx, my): number \| null` に括れる |
| **E3** | `player.ts` / `enemy.ts` の `hitEffect` | 両者で同一実装(色・定数まで同じ)。`Ship` 側か `EffectsSystem` 側へ 1 つに |
| **E4** | `stage.ts` の import | `import { ScoreCounter as scoreCounter }` — クラスを小文字始まりへ別名化している。フィールドの型注釈も読みにくくなっている |
| **E5** | `marker-manager.ts` の `resolveCollisions` | `{ m: any; ... }` — 唯一の `any`。`markerDictionary` の値型を型エイリアスにして使えばよい |
| **E6** | `orbitline.ts` の `regenerate` | `hHat: { ...el.hHat }` / `pHat: { ...el.pHat }` — CLAUDE.md が禁じる「`Vec3` をオブジェクトリテラルで作る」に抵触する(ブランドはスプレッドで運良く残るが、規約上は `v3()` 経由)。`Vec3` は不変なので**そもそもコピー不要**で、参照をそのまま持てばよい |
| **E8** | `render/scene.ts` | `GameScene.resize` を返しているが `main.ts` は使っていない(内部で `addEventListener` 済み)。未使用の公開 API。また `setPixelRatio` が初期化時のみで、ウィンドウ間移動・ズーム時に追従しない |
| **E9** | 各所 | 使われない引数・戻り値: `Player.checkLoss(_dt, _simTime, _activeStage, _playerPos)` は `_playerPos` に **自分自身の `state.r` を渡されている**(`game.ts`)。`Targeter.updateCombatTargeting` の戻り値は捨てられている。`Enemy` コンストラクタの `_hud` は「対で注入する方針」のため受けるだけ — 方針自体は `refactoring_todo.md`「引数整理」で見直し対象 |
| **E10** | `game.ts` の `perfCounts()` | `ammos` が無い。`?perf=1` でエンティティ数を見るときに補給だけ勘定から漏れる |
| **E11** | 各所 | const.ts に無いマジックナンバー: `plan-editor.ts` の `/ 200`(px→Δv 換算)、`effects-system.ts` の `11`(破片数)と `2.8`(拡散)、`collision.ts` の `restitution = 0.4` と `0.8`(めり込み補正係数)、`chase-camera.ts` の `12`/`8000`(距離クランプ) |
| **E12** | `plan.ts` の `addNode` / `retimeNode` | `this._nodes.indexOf(postState)` で**オブジェクト参照一致**に頼って挿入位置を求めている。同一参照の `OrbitState` を 2 度渡すと壊れる。`sortByTime` が返す順序から直接求められる |
| **E13** | `player-fire.ts` の `manualReload` | 空マガジンフレームを排出しないが、自動の `'barrel-reload'`(`fireCycle`)は排出する。同じ「バレル交換」で演出が非対称 |

---

## 5. 補足: 既出項目のうち、位置を特定できたもの

`refactoring_todo.md` に列挙済みだが本調査で具体化できたものを対応付けておく。

| todo の項目 | 本書の該当 |
|---|---|
| マーカーの表示位置が微妙にずれる | **C4**(`toFixed(1)` の DOM 往復とラベル幅推定が候補。全角文字で顕著になるはず) |
| predict が本当に延長分だけ計算しているか | **C1**(折れ線側は入力変化検出付きで妥当。重いのは `nodeArrivings` の無キャッシュ伝播) |
| hit/collision を spatial hash に | **C3**(その前にサブステップ内の定数コストを削るほうが効く) |
| orbitLine のマテリアル再生成 | **C6** |
| render/physics の責務境界 | **B1**(three の import 元)・**B2**(render→game 依存)・**B5**(制御演算が THREE 依存) |
| plan の addNode/removeNode が下流を破棄しない | 未修正を確認(`plan.ts`)。`retimeNode`/`applyNodeDv` だけが破棄している |
| dt と simDt の混在 | `player-fire.ts` の射撃周期は実時間 `dt`、弾の生成時刻は `simTime`。ワープ ×4 では「実 1 秒に 16 発撃つが、弾の時刻は 4 秒分進む」状態になる |

---

## 6. 着手順の提案

1. **C1**(マップモードのフレームレートに最も効く。E2 も同じファイル)
2. **B1 / B3 / B4 / B5**(規約違反の解消。B4 は削除するだけ、B1 は import 元の付け替えだけ)
3. **C2 / C3**(毎フレームの割り当てとサブステップ内の定数コスト。アルゴリズム変更の前段)
4. **D10**(SPEC §14 の棚卸し。実装済み項目の申告が誤っている)
5. **C4 / C5 / C7**(DOM・GPU バッファの作り直しをやめる)
6. **B10 / E3 / E4 / E5 / E6**(重複と規約違反の掃除。触るファイルのついでに)

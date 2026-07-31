# 全エンティティの過去・将来予測

## 1. 何が問題か

`PredictSystem` の未来スライダー（`sliderT`）が作る `displayTime = simTime + sliderT × 表示期間` を、
現状受け取っているのは3つだけ:

- `EnvironmentScene.sync` — 地球の自転・太陽・月
- `CameraSystem.sync` → `FocusMarkers.syncLabels` — 天体ラベル / ラグランジュ点
- `PredictSystem.syncGhost` — ⬡ ゴースト（**計画軌道上の**予定自機位置）

一方 `Simulator.sync(fo)` を通る敵・補給・弾・デブリと、`Player.syncPlayer` の自機は現在時刻のまま。
スライダーを進めると天体だけが動いて敵は止まる、という不整合になる。

「表示時刻」という概念を持ち込んだ以上、その時刻に存在すべき表示物は**すべて**その時刻の状態で
描かれるべきである。そのためには全エンティティの将来状態が要る。

さらに、**過去の状態列も同じ枠組みで保持したい**。現状 `history` は弾の線分衝突判定のために
1ステップぶんしか保持していないが、最終的には過去軌跡と将来軌道の両方を線として描きたい（§5 Step 5）。
「過去列」と「未来列」は同じ形のデータであり、別々の仕組みで持つ理由がない。

なお**この予測はマップモードの機能ではない**。表示に使うのがいまはマップモードだというだけで、
予測列は視点やモードと無関係に常時維持する（条件分岐を持たない）。

## 2. 方針

毎フレーム全エンティティの数百ステップ先までを引き直すのは無駄が多い。予測軌道は外乱がなければ
その通りに辿るはずのものなので、**各エンティティが未来サンプル列を1本持ち、毎フレーム一定の予算だけ
先端を延ばし、現在時刻より過去になった後端を捨てる。実状態と食い違ったときだけ作り直す**、という
増分更新にする。

そのために、肥大した現 `OrbitEntity` から「時刻付き状態 + その手前のサンプル列 + 自分を1ステップ
進める能力」を切り出す。切り出した先は**過去列にも未来列にも同じものを使う**（§3）。

元メモの記述で事実誤認だった点だけ、先に訂正しておく:

- **「physics/predict が摂動要因を考慮していないのが嘘」** — 正確には `predict.ts` は J2 と月・太陽の
  第三体摂動を既に計算していて、**抵抗（drag）だけ**が意図的に落ちている（`bcInv = 0` 固定）。
  抵抗の寄与は実測で 420km 24時間あたり 3.9 km（§4）なので、たしかに落としたままにはできない。
  やることは「摂動の追加」ではなく「`bcInv` のパラメータ化」。
- **「軌道計画と自機の軌道予測は別物、両方表示する」** — そのとおりだが、計画が空の間は
  `Plan.anchor` が自機に追従するので、`PlanTrajectory` の arc 0（グレー）は既に「自機の自由飛行予測」に
  なっている。両者が別物として見えるのは計画にノードを置いた後だけ。

## 3. 設計の骨格

### 3-1. `OrbitEntity` と `GameEntity`

現 `OrbitEntity`（メッシュ・HP・生死・姿勢・AI を持つゲーム内の物体）を **`GameEntity`** へ改名し、
そこから状態列の部分を新しい **`OrbitEntity`** として切り出す。

```
GameEntity                     ゲーム内の物体。mesh / alive / hp / att / torque / thrust / bcInv /
│                              checkLoss / sync / dispose と、下の2本の整合維持
├── current  : OrbitEntity     いま。state = simTime の状態、history = それ以前のサンプル列
└── predicted: OrbitEntity     未来。state = 予測先端、history = simTime〜先端のサンプル列
                               （predictDuration = 0 のクラスでは null のまま）
```

**この2本が同じクラスなのは偶然ではない。** `OrbitEntity` の `history` は常に「自分の `state` より
古い時刻のサンプル列」であり、`current` ではそれが過去、`predicted` ではそれが「現在〜先端の間」に
なるだけで、構造も操作もまったく同じ。時刻引き（`at(t)`）も、履歴の寿命管理も、1ステップ前進も、
一つの実装で足りる。線として描くときも、`current.history` が過去の線、`predicted.history` が
未来の線になり、`SampledLine` にそのまま渡せる（どちらも `readonly OrbitState[]` 相当）。

`OrbitEntity` は THREE も game も知らない純粋なデータ構造なので `src/physics/orbit-entity.ts` に置く
（`StateQueue` / `Ephemeris` と同じ「純粋だが状態を持つ」枠）。`test:physics` の対象に入るのが実利。
それに伴い `src/game/orbit-entity/` は `src/game/game-entity/` へ改名する（改名は痕跡を残さない）。

フィールド名は `current` / `predicted`（元メモの `currentEntity` / `predictedEntity` だと
`entity.currentEntity.state` と重複感が出るため）。

### 3-2. 種別固有の値は step の引数

`bcInv` / `thrust` / 列の保持方針は `GameEntity` の種別ごとに違い、しかも
**`current` と `predicted` へ整合した値を渡さなければ2本の列が食い違う**。よってこれらを
`OrbitEntity` の初期化時に埋め込まず、毎回の `step` の引数として受け取る。

```ts
step(dt, sunPos, moonPos, bcInv, thrust, sampleInterval, keepDuration): void
```

引数は多いが、場当たり的なオブジェクト引数（`opts` / `ctx`）にはしない（プロジェクト規約）。
**この7引数を整合させることが `GameEntity` の責務**であり、種別ごとの差は既存の継承ツリー
（`Ship` / `Bullet` / `DebrisPiece` / `Ammo`）の中でフィールドを上書きするだけで表現できる。
（副次的な利点として、派生クラスのフィールド初期化子が `super()` の後に走る問題を踏まない。）

- **`sampleInterval` — 列へ積む最小間隔 [s]。時間解像度を落とすのはここ。**
  これが無いと過去列はサブステップ刻みのまま溜まる（ワープ×1 では 1/60 秒刻み =
  1周回ぶんで 33 万点）。`history.newest` から `sampleInterval` 以上離れたときだけ push し、
  それ以外のステップでは列に一切触らない。1ステップが `sampleInterval` を超える高ワープでは
  毎ステップ push になる（それ以上は落としようがない）。
  値は自分の軌道周期から `period / PREDICT_SAMPLES_PER_REV`（§4 の実測に基づき 1周 32 点 =
  LEO で 174 秒間隔、補間誤差 30 m）。**`current` と `predicted` に同じ値を渡す**ので、
  過去の線と未来の線が同じ密度になり、現在時刻の点で連続する。
- `keepDuration` — 保持する時間窓 [s]。`StateQueue.cleanup(maxAge, minCount)` へそのまま渡す。
  `current` には `historyDuration`（過去窓）、`predicted` には `predictDuration` を渡す。
  `cleanup` は「最新サンプルからの相対」で刈るので、`current` では
  「simTime − 過去窓より古いものを捨てる」、`predicted` では
  「先端 − 予測期間 ≒ simTime より古いものを捨てる」になり、**同じ式が両方向に効く**。
  0 なら列を持たない。
- 保持点数は `keepDuration / sampleInterval` で決まる。過去窓 1 周回なら 32 点、
  予測期間 3 時間なら約 62 点（§4 のメモリ見積もりの根拠）。

種別ごとの既定値:

| クラス | `historyDuration`（過去窓） | `predictDuration`（予測期間） |
|---|---|---|
| `Ship`（自機・敵） | 1 周回ぶん | `PREDICT_DURATION` |
| `Ammo`（補給） | 0 | `PREDICT_DURATION` |
| `Bullet` | 0 | 0 |
| `DebrisPiece`（薬莢・破片） | 0 | 0 |
| `BeltSection` | 0 | 0 |

**直前ステップの状態（`prevState`）は列とは別のフィールドで持つ。** 弾の線分衝突判定
（`hit.ts` / `targeter.ts`）が要るのは「直前サブステップの位置」で、これは間引かれた表示用サンプル列
からは取れない（ワープ中は1サンプルが数百秒に相当する）。列は表示のための時系列、`prevState` は
連続衝突判定のための1個前、と用途が別なので分けて持つ。現 `historyLength`（件数）は
`historyDuration`（時間窓）+ `sampleInterval`（解像度）+ `prevState` フィールドへ置き換わり、消える。

### 3-3. 予測は表示時刻の供給から独立している

`GameEntity.predictDuration` は**エンティティ種別ごとの定数**であり、`DisplayTimeManager`
（表示期間・スライダー。Step 0 で `PredictSystem` から切り出す）とは無関係。各エンティティは、
いま表示される可能性があるかどうかに関わらず、自分の `predictDuration` だけに従って勝手に予測を
進める。表示側が司るのは「どの時刻を表示するか」だけで、予測の挙動には一切影響しない。

したがって「スライダーの最大値まで予測が届くように `predictDuration` を決める」といった
連動はしない。スライダーが予測期間より先を指したときは、その時刻の状態が存在しないので
**非表示**になる（恒久対策は §6 の解析ケプラー外挿）。

既定は `PREDICT_DURATION = 3 時間`（LEO で約2周回）。構築コストもメモリも予測期間に比例するが
（§4）、定数1つで振れるので実測しながら決めればよい。

### 3-4. 予測の妥当性を誰が守るか

`current.state` が状態の正本で、`predicted` はそこからの導出物。不変条件は
**「`predicted` の保持区間が `current.state` と整合していること」**。守り方は2つに分ける。

**(a) 距離判定 — 毎フレーム、全対象。**
`predicted.at(simTime)` と `current.state.r` を比べ、`PREDICT_RESET_DIST` を超えていたら破棄する
（二分探索1回ぶんの費用しかかからない）。反動・剛体接触・積分差はすべてこれで拾う。
**`GameEntity.state` の setter が唯一の外部書き換え口である**ことが、この1つの判定で漏れなく
拾える根拠になる（`stepSim` は setter を通さず `current.step(...)` を直接呼ぶ。setter は
「外部からの不連続な差し替え」専用）。

setter で**無条件に**破棄しないのは、得るものがない割に予算を食うから。反動は 1 発
`RECOIL_DV = 0.04 m/s`、発射間隔 `FIRE_INTERVAL = 0.06 s`（毎秒約17発）。無条件破棄だと
毎秒17回 × 540ステップ = 平均150ステップ/フレーム（予算の約30%）を自機が占め続け、
他のエンティティの構築が後回しになる。一方その誤差は 1 発あたり 3 時間で 432 m と閾値未満で、
1マガジン32発ぶん撃てば累積 1.28 m/s ≒ 13.8 km になり距離判定が**1回だけ**作り直す。
これが正しい粒度。

**破棄は破棄だけで、再構築を引き起こさない。** `invalidatePrediction()` は列を捨てるだけ
（そのフレームの費用は 0）。空になった列は次フレーム以降、通常の予算配分の中で伸びる —
`Predictor` から見れば「まだ短い列」と「まだ伸びていない列」は区別されない。したがって
破棄がいくら起きても**フレーム時間は跳ねず、完成が遅れるだけ**である。これは
「なるはやで再計算するが、リソースが足りなければ後回しでよい」という予算配分の契約
（Step 3）そのもので、即時再構築の経路はどこにも無い。

**(b) 明示的な破棄 — 自機の推力だけ。**
`Player.behave` が `thrust` を確定した直後に `invalidatePrediction()` を呼ぶ。噴射は継続的で
Δv も大きく、しかも**プレイヤー自身の操作**なので、結果が即座に反映されないと UX が悪い。
距離判定を待つと数フレーム〜数秒の遅れになるので、ここだけは明示的に落とす。

**これを `thrust` の setter にしないのは意図的。** 将来 `Enemy` が推力を持ったとき、自機と違って
即座にはリセットしない（自機の操作結果は即座に見える必要があるが、他機の予測にその要求はない）
という余地を残すため。早急な一般化をしない原則に基づき、いまは自機の操作経路にだけ置く。
**この理由は実装時にコードコメントとして残すこと。**

### 3-5. 「配列を持つ者」と「配列を更新する者」を分ける

現 `Simulator` は既に2つの責務を持っている（① エンティティ配列の保持・追加・削除、
② 実シミュレーションの更新）。ここに ③ 予測の更新（予算管理を含む）を足すと、後から剥がすのが
難しい塊になる。**先に割ってから足す**（Step 0 / Step 3）。

```
Game
├── EntityManager   ① 全エンティティ配列の保持。追加・上限管理・寿命回収・描画同期。
│                      各所へ参照共有される唯一の窓口
├── Simulator       ② 実シミュレーションの更新。EntityManager の参照を受け取り、
│                      その配列に対して積分・命中・接触・姿勢を回す。Game だけが参照する
└── Predictor       ③ 予測の更新。同じく EntityManager の参照を受け取り、予算の範囲で
                       各エンティティの予測列を伸ばす。Game だけが参照する
```

②と③が同じ形（EntityManager を受け取って配列を更新する）になるのが要点で、`Predictor` を
`Simulator` の内部に置かないのはこのため。現状 `Simulator` を参照している外部モジュール
（各 Stage・`Enemy.behave`・`HitSystem`・`Targeter`・`Logistics`・`EffectsSystem`・`NanWatchdog`）は
**すべて①しか使っていない**ので、機械的に `EntityManager` へ置き換えられる。

## 4. 設計の根拠（実測値）

刻み幅・サンプル間隔・予算は勘で決めず、実測してから決める。以下は `tests/dist` にコンパイルした
`physics/` を node で直接叩いて測った値（420km 円軌道、抵抗+J2+第三体あり、基準は dt=0.25s 積分）。

**積分刻みと位置誤差**

| 刻み | 1周回後 | 24時間後 |
|---|---|---|
| 8.5 s（`predictStepDt` の LEO 値） | 0.000 km | 0.000 km |
| 17 s | 0.000 km | 0.006 km |
| **20 s**（`SUBSTEP_MAX_DT`） | 0.000 km | **0.012 km** |
| 34 s | 0.003 km | 0.148 km |
| 68 s（`predictStepDt` の28日設定値） | 0.050 km | 4.203 km |
| 抵抗を落とした場合（dt=0.25s） | 0.017 km | **3.896 km** |

→ **刻みを 20 s まで粗くしても誤差は 24 時間で 12 m**。一方 **抵抗を落とすと 3.9 km ずれる**。
精度を決めるのは刻みではなく抵抗の有無。予測刻みは
`max(SUBSTEP_MAX_DT, predictStepDt(r, 予測期間))`（LEO で 20 s、遠地点では自動的に粗くなる）でよい。
本体シミュレーション自身のサブステップが最大 20 s なので、**予測が本体より細かい必要はない**という
理屈とも一致する。

**サンプル間隔とエルミート補間誤差**（`StateQueue.at` が使う補間）

| 間隔 | 弧 | エルミート誤差 | 線形補間誤差 |
|---|---|---|---|
| 60 s | 3.9° | 0.4 m | 3.9 km |
| 180 s | 11.6° | 30 m | 35 km |
| 300 s | 19.4° | 232 m | 97 km |
| 600 s | 38.8° | 3.7 km | 385 km |

→ 積分ステップを全部保持する必要はない。**1周あたり 32 点**（LEO で 174 s 間隔）保存すれば
補間誤差は 30 m 程度で、マップ表示でも線描画でも不可視（`sampleInterval` を周期から決める根拠）。

**コスト**（同環境で `stepOrbitRK4` + `envAccel` 1ステップ = **2.7 µs**）。予測期間 3 時間の場合。
以下の「構築」は**総量**であって1フレームで払う量ではない（予算に分割して消化する）:

- 1体ぶんの構築 = 10800/20 = 540 ステップ = 総量 **1.5 ms**
- 予算 500 ステップ/フレーム = **1.4 ms/フレーム**（これがフレーム時間に乗る上限）
- 30体ぶんを 0 から埋めるのに 16k ステップ = **約33フレーム ≒ 0.55 秒**
  （出撃直後と、敵がスポーンした直後に発生する）
- 予算は「1フレームに許すコスト」と「埋まるまでの時間」のトレードオフを決める唯一のつまみ。
  構築の遅延は許容される性質のものなので、フレーム時間を優先して下げてよい
  （200 なら 0.54 ms/フレーム、全体の構築は約 1.4 秒）。
- 維持コスト（予測期間に到達した後、simDt ぶん先端を伸ばすだけ）: ワープ×4096（simDt=68 s）でも
  4 ステップ/体/フレーム、30体で **0.3 ms/フレーム**。ワープ×1 なら1体あたり 1200 フレームに
  1ステップで、ほぼ 0。**常時走らせても戦闘ビューのフレーム時間に影響しない。**
- メモリ: 30体 × 約62点 × 約120 B = **約220 KB**（過去列は1周ぶん32点なので同程度）

構築コストとメモリは予測期間に比例する（1日にすれば8倍 = 構築4.3秒 / 1.8 MB）。維持コストは
予測期間に依存しない。

→ 「1フレームあたりの総ステップ数に上限を置き、体をまたいでラウンドロビンで消化する」という
**グローバル予算**が要る。元メモの「predictDt は simDt の定数倍」では、simDt=1/60 のとき
定数倍を5倍にしても1周回ぶんのリードを作るのに23分かかってしまい、成立しない。

## 5. 実装ステップ

| Step | 主な変更対象 | 完了時点で見えるもの |
|---|---|---|
| 0 | `simulator.ts` 分割 / `predict-system.ts` 分割 | 変化なし（責務の器を用意） |
| 1 | `physics/envaccel.ts` / `physics/predict.ts` / `entities.ts` | 変化なし（重複解消） |
| 2 | `physics/orbit-entity.ts`（新）/ `game/game-entity/`（改名） | 変化なし（土台） |
| 3 | `game-entity.ts` / `Predictor.ts`（新）/ `game.ts` / `player.ts` / `const.ts` | 変化なし（`?perf=1` に費用が出るのみ） |
| 4 | `game-entity.ts` / `entity-manager.ts` / `game.ts` / `player.ts` / `enemy.ts` | **スライダーで敵・補給・自機が将来位置へ動く** |
| 5 | `physics/state-queue.ts` / 線描画モジュール（新） | 過去・未来のデバッグ線 |

各ステップ共通の作業ルール:

- 変更セットには必ず `npm run typecheck` を含める。`src/physics/` を触ったステップは
  `npm run test:physics` も走らせる。
- CLAUDE.md / `DEVELOP/CALLSTACK.md` / `DEVELOP/OWNERSHIP.md` / `DEVELOP/SPEC.md` の更新を
  **同じ変更セットに含める**（`/develop-docs`）。改名は痕跡を残さない（`OrbitEntity` の意味が
  変わるので、文書側の記述も全面的に書き直す）。
- 各ステップ単独で typecheck が通り、ゲームが従来どおり動く状態で終わらせる。

---

### Step 0 — 既存モジュールの責務分割

**目標**: `Simulator` と `PredictSystem` をそれぞれ2つに割り、これから足す予測機能の置き場所を
先に用意する。挙動は一切変えない。

**目的**: どちらも「後から剥がすのが難しくなる」ことの予防。`Simulator` には ③ 予測が乗りかけて
おり（§3-5）、`PredictSystem` は名前がこれから作る予測と衝突する上、責務が2つある。
**足す前に割る。**

#### 0-a. `Simulator` → `EntityManager` + `Simulator`

- **`EntityManager`**（`src/game/orbit-entity/entity-manager.ts`。Game 所有・**公開**）
  - `enemies` / `bullets` / `casings` / `debris` / `ammos` の配列と `all()`（現 `allEntities()`）
  - `addEnemy` / `addBullet` / `addDebris` / `addAmmo` と上限管理（`addCapped`）
  - `cleanup(dt, simTime, activeStage, playerPos)` — `checkLoss` を回して `prune`/`dispose`
  - `sync(fo)` — 配列を舐めて `entity.sync` を呼ぶだけ。アルゴリズムを持たない反復なので
    配列の持ち主に置く
- **`Simulator`**（`src/game/orbit-entity/simulator.ts`。Game 所有・**Game だけが参照**）
  - `simTime` / `lastSimDt`、`HitSystem` / `CollisionPhysics` の所有
  - コンストラクタで `EntityManager`（+ `Ephemeris` / `Sfx`）の参照を受け取る
  - `stepSimulation(...)` — サブステップ分割、太陽・月のサンプル、`entity.stepSim`、
    `hitSystem.checkBulletHits`、`collisionPhysics.resolve`、`stepAttitudes`
- **参照の置き換え**（すべて①しか使っていないので機械的）:
  `hit.ts` / `Enemy.behave` / `Stage` と各ステージ / `stage-dictionary.ts` / `Targeter.markBoardCrossings`
  / `Logistics` / `EffectsSystem` / `NanWatchdog.checkAll`。
  - `NanWatchdog.checkAll` だけは `simTime` も使っているので、引数で受け取る形にする。
  - `Stage` が `Logistics` へ渡している `(ammo) => simulator.addAmmo(ammo)` と、
    `EffectsSystem` が受け取っている `(piece) => simulator.addDebris(piece)` は、
    `EntityManager` の参照を直接渡す形に置き換える（`refactoring_todo.md`「不要なクロージャ注入は
    行わない」に沿って **2本減る**）。

#### 0-b. `PredictSystem` → `DisplayTimeManager` + `PlanDisplay`

- **`DisplayTimeManager`**（`src/game/display-time-manager.ts`。Game 所有）
  - `durationKey` / `durationSec(orbitPeriod)` / `sliderT` / `forceCurrent` /
    `resolveDisplayTime(orbitPeriod, simTime)`
  - 期間ボタンとスライダーの DOM パネル
  - `MapModeToggler` が `forceCurrent` を切り替える先（現状のまま）
- **`PlanDisplay`**（`src/game/plan/plan-display.ts`。**`PlanEditor` 所有**）
  - `PlanTrajectory` の所有と駆動、`trajectoryFrame` とその選択 UI、⬡ ゴーストマーカー
  - `plan-trajectory.ts` / `predicted-line.ts` も `src/game/plan/` へ移し、
    **`src/game/predict/` を消滅させる**（これから作る予測と名前がぶつからないようにする）。
    `predicted-line.ts` は plan 非依存に書かれているが、現時点の consumer は plan だけなので
    共通の置き場は作らない。Step 5 で2つ目の consumer が出たら、そのとき出す。
  - `sync(plan, displayEnd, displayTime, fo, project)` — 表示期間・表示時刻は
    `DisplayTimeManager` から Game 経由で**引数として**受け取る（状態を二重に持たない）
- **副次的に消えるもの**: `PlanEditor` が `predict.traj` を参照共有で受け取っていた配線
  （Game が `PredictSystem` → `PlanEditor` の順に構築しなければならなかった理由）が無くなり、
  `PlanEditor` が `PlanDisplay` を所有する自然な形になる。
- **パネルの分割**: 現 `PredictPanel` の3行のうち、期間とスライダーは `DisplayTimeManager`、
  軌道座標系は `PlanDisplay` の状態なので、パネルも2つに割る
  （OWNERSHIP.md「各パネルは状態の所有者が持ち、自分の状態だけを映す」）。
- **表示ゲート**: 現 `forceCurrent` は「未来表示の禁止」と「計画軌道の非表示」を兼ねている。
  分割後、前者は `DisplayTimeManager.forceCurrent`、後者は `PlanEditor.editMode` から導ける
  （`PlanDisplay` の持ち主が `PlanEditor` なので自然）。状態が1つ減るのでそうする。

**検証**: typecheck。挙動は完全に不変なので、実行時の見え方が変わらないことを確認する
（マップの開閉・ノード編集・スライダー・期間切替を一通り）。

---

### Step 1 — 1ステップ積分関数の共有と `bcInv` のパラメータ化

**目標**: 本体シミュレーションと予測が同じ1ステップ関数を通るようにし、予測側で弾道係数を
指定できるようにする。

**目的**: 現状「中心重力 + `envAccel` + 推力の RK4 1ステップ」が `OrbitEntity.stepSim` と
`physics/predict.ts` の `stepPredict` に別々に書かれている（`refactoring_todo.md`「シミュレーションと
予測器のアルゴリズムの重複」）。ここに3つ目の実装を足す前に1箇所へ寄せる（CLAUDE.md の
「既存側もその呼び出しに置き換えるまでを同じ変更セットで」）。

**実装詳細**:

- `physics/envaccel.ts` に `stepEnvRK4(state, dt, sunPos, moonPos, bcInv, thrust)` を追加する。
  `stepOrbitRK4` + `envAccel` + 推力加算の合成で、返すのは新しい `OrbitState`（純関数）。
  置き場所が `envaccel.ts` なのは `envaccel → orbital` の依存方向を保つため。
- `OrbitEntity.stepSim` の中身をこの呼び出しに置き換える（太陽・月位置は今までどおり
  `Simulator` がサブステップごとに1回サンプルして配る）。
- `physics/predict.ts` の `stepPredict` も同じ関数を呼ぶ形にする。ephemeris を中点時刻で
  サンプルする方針はそのまま（サンプリング方針は呼び出し側の裁量として残す）。
- `stepPredict` / `predictTrajectory` / `propagateState` に `bcInv` 引数を足す。**既定値は 0** に
  して、計画軌道（`PredictedLine`）の挙動は現状のまま変えない。計画予測にも抵抗を入れるかは
  挙動変更を伴う別判断なので §6 に送る。

**検証**: `npm run test:physics`（既存41本）+ `bcInv=0` の `stepEnvRK4` が従来の
`stepOrbitRK4 + envAccel` と一致することを確認するテスト1本。

---

### Step 2 — `OrbitEntity` → `GameEntity` 改名と、新 `OrbitEntity` の切り出し

**目標**: 状態列を保持・前進・時刻引きする単位を独立させ、`GameEntity` がそれを1本
（`current`）持つ形にする。この時点では予測はまだ無く、挙動も一切変わらない。

**目的**: 予測列と履歴列を同じ実装で扱うための土台（§3-1）。同時に、継承ツリーとして肥大している
現 `OrbitEntity` から「状態の整合性維持」という独立した責務を分離する。

**実装詳細**:

- **改名**: `src/game/orbit-entity/` → `src/game/game-entity/`（Step 0 で作った
  `entity-manager.ts` もここへ移る）、`entities.ts` → `game-entity.ts`、
  クラス `OrbitEntity` → `GameEntity`。import の書き換えは全域に及ぶが機械的。
  `game-entity.ts` が 200 行を超えるようなら `DebrisPiece` / `Ammo` / `BeltSection` を別ファイルへ分ける。
- **新 `src/physics/orbit-entity.ts`**:
  ```ts
  class OrbitEntity {
    constructor(state: OrbitState)
    get state(): OrbitState          // 正本
    get prevState(): OrbitState      // 直前ステップの状態(列とは別フィールド)
    get history(): StateQueue        // state より古いサンプル列(間引き済み)
    get elements(): Elements | null  // state からのメモ化。step/reset で破棄

    step(dt, sunPos, moonPos, bcInv, thrust, sampleInterval, keepDuration): void
    reset(state: OrbitState): void   // 不連続な差し替え。同時刻以降のサンプルを捨てる
    at(t: number): OrbitState | null // 保持区間内の任意時刻。history と state をまたいで補間
  }
  ```
  - `step`: `prev = state` → `stepEnvRK4` → **`keepDuration > 0` かつ
    `state.t - history.newest.t >= sampleInterval` のときだけ**旧 state を `history.push` し、
    `history.cleanup(keepDuration, 2)` を呼ぶ → `state` 差し替え（`elements` メモ破棄）。
    `keepDuration = 0` なら列には一切触らない（デブリ・薬莢のコストをゼロに保つ）。
  - `at(t)`: `t > state.t` なら null。`history` が空なら `t === state.t` のときだけ `state`。
    `history.newest` より新しければ `state` との間を `hermiteInterpolate`、それ以前は `history.at(t)`。
    **列と `state` をまたぐ継ぎ目をここに閉じ込める**ので、外から突き合わせる必要がない。
- **`GameEntity` 側**: `readonly current: OrbitEntity` を持ち、
  `state` / `prevState` / `elements` / `history` を転送する（`.state` を読んでいるだけの
  22ファイル109箇所は無改変で済む）。`state` の setter は `current.reset(...)` — つまり
  **外部からの不連続な差し替え専用の口**で、`stepSim` はこれを通さない（§3-4 (a)）。
  `stepSim(dt, sunPos, moonPos)` は `alive` 判定と、自種別の `bcInv` / `thrust` /
  `sampleInterval()` / `historyDuration` を揃えて `current.step(...)` へ渡す
  — **たらい回しではなく「引数を整合させる」責務**なので恒久的に残る。
  - `protected readonly historyDuration = 0`。`Ship` にだけ 1 周回ぶんを与える（§3-2 の表）。
    32 点 = 1体あたり数 KB なので、自機・敵すべてに与えても問題ない。
  - `protected sampleInterval(): number` — `elements?.period / C.PREDICT_SAMPLES_PER_REV`。
    周期が取れない場合（双曲線）は定数へフォールバック。
  - 現 `protected readonly historyLength` は削除（`Ship` / `Bullet` の `= 1` 上書きも消える）。
    `hit.ts` / `targeter.ts` が読む `prevState` は転送 getter で従来どおり。
- 定数: `PREDICT_SAMPLES_PER_REV`（32）、`SHIP_HISTORY_DURATION`（1周回ぶん）。

**検証**: `test:physics` に `OrbitEntity` の新規テスト（`step` が `sampleInterval` どおりに
間引くこと、`keepDuration` で古い側が落ちること、`at` が積分し直した値と補間誤差以内で一致すること、
`reset` が同時刻以降を捨てること、`prevState` が常に直前ステップであること）。
typecheck。挙動は不変なので実行時の見え方が変わらないことを確認する。

---

### Step 3 — 予測列の装着と駆動（`Predictor`）

**目標**: `GameEntity` が2本目の `OrbitEntity`（`predicted`）を持ち、毎フレーム予算内で
先端が伸び、実状態と食い違えば作り直される。表示はまだ変えない。

**目的**: 予測そのものを動かす。予測対象の分岐（元メモ「デブリなどは予測しない。上手いこと分岐して
切る」）は `instanceof` の類にせず、`historyDuration` と同じ形の1フィールドで決める。
予算とラウンドロビンで平すのは、全体を同時に構築すると 30 体で 16k ステップのスパイクになるため（§4）。

**実装詳細 — `game-entity.ts`**:

- `protected readonly predictDuration: number = 0;`（0 = 予測しない）。既定値は §3-2 の表。
  §3-3 のとおり `DisplayTimeManager` とは無関係な**エンティティ種別ごとの定数**。
- `predicted: OrbitEntity | null` — `advancePrediction` が必要になった時点で生成する
  （`predictDuration = 0` なら生成しない）。
- `invalidatePrediction()` — `predicted = null`。**捨てるだけで、再構築はしない**
  （§3-4 末尾）。次フレーム以降、他の列と同じ予算配分の中で伸び直す。
- `advancePrediction(ephemeris, budgetSteps, simTime): number` — null なら `current.state` を種に
  生成。刻みは `max(C.PREDICT_MIN_STEP_DT, predictStepDt(len(r), predictDuration))`、
  上限 `simTime + predictDuration` まで、最大 `budgetSteps` ステップ進めて**消費ステップ数を返す**
  （予算の会計は呼び出し側）。1ステップごとに ephemeris をサンプルして `predicted.step(...)` を
  呼ぶ。`sampleInterval` は `current` と同じ値、`keepDuration` は `predictDuration` を渡す。
  - **推力がかかっている間は伸ばさない**（`thrust !== null` なら即 0 を返す）。自由飛行を前提に
    した予測は噴射中に成立せず、どうせ次フレームに無効化されるので予算を捨てるだけになる。
  - **打ち切り**: 積分中に高度が `REENTRY_ALT` を割った、または非有限値が出たらそこで停止し
    `truncated` フラグを立てる。これが無いと、再突入する敵や NaN が混入した個体が毎フレーム
    予算を食い潰して永久に予測期間へ到達しない。生成時に下ろす。
- `resyncPrediction(simTime, tolerance): boolean` — §3-4 (a) の距離判定。
  `predicted.at(simTime)` と `current.state.r` を比べ、超えていれば（または `at` が null なら）
  `invalidatePrediction()`。

**実装詳細 — `Predictor` と配線**:

- `src/game/game-entity/Predictor.ts` に `Predictor` を新設。**`Game` が直接所有**し、
  `Simulator` と同じパターンで `EntityManager`（+ `Ephemeris`）の参照を受け取って
  その配列に対して更新をかける（§3-5）。持つ状態は**ラウンドロビンのカーソル**だけ。
  責務は**「全ての列をなるはやで伸ばす。ただし1フレームの総ステップ数は予算を超えない
  （超えるぶんは後回しにする）」**の一点。どの列が短いか・なぜ短いか（新規スポーンなのか
  破棄されたのか）は区別しない — 区別しないからこそ、破棄がフレーム時間のスパイクにならない。
- `update(simTime, player)`:
  1. 自機を含む全対象に `resyncPrediction(simTime, C.PREDICT_RESET_DIST)`。
  2. 予算 `C.PREDICT_STEP_BUDGET` を、**自機を先頭に、以降はカーソル位置から順に**
     `advancePrediction` へ配る。消費ステップ数を引き、尽きたらそのフレームは終わり。
     カーソルを次フレームの開始位置として保存する。`truncated` な列は飛ばす。
     （ターゲットや距離による優先度付けはしない — 全体でも 0.55 秒で埋まるので釣り合わない。
     階層化は §6。）
- 呼び出しは `Game.update` の `entities.cleanup(...)` の**後**（死んだ個体を予測しない、
  積分後の実状態と突き合わせる）。**視点・モードによる条件分岐は持たない**（§1）。
- `Player.behave` の `this.thrust = ...` の直後に、推力があれば `invalidatePrediction()`
  （§3-4 (b)。**理由をコメントで残す**）。
- 定数: `PREDICT_DURATION`（3 時間）、`PREDICT_STEP_BUDGET`（500）、
  `PREDICT_MIN_STEP_DT`（= `SUBSTEP_MAX_DT`）、
  `PREDICT_RESET_DIST`（500 m。補間誤差 30 m より十分大きく、実イベントは確実に拾える）。

**検証**: typecheck。`?perf=1` で**戦闘ビューでも**フレーム時間が予算どおり（構築中 +1.5 ms、
維持中はほぼ 0）に収まること、出撃から 1 秒以内に列が埋まること、長時間の連射・被弾・接触で
フレーム時間が跳ねないこと（= 再構築が頻発していないこと）を確認する。

---

### Step 4 — 表示を `displayTime` で統一する

**目標**: スライダーを進めると敵・補給・自機が将来位置へ動く。

**目的**: 本題。ここまでの4ステップは全部この準備。

**実装詳細**:

- `GameEntity.displayState(t): OrbitState | null` — 分岐は2つだけ。
  ```ts
  return t <= this.current.state.t ? this.current.at(t) : (this.predicted?.at(t) ?? null);
  ```
  過去も未来も `OrbitEntity.at` に閉じているので、ここは境界を選ぶだけで済む。
  戦闘ビューは常に `t === state.t` を通るので**挙動が一切変わらない**。
- `GameEntity.sync(fo)` → `sync(fo, displayTime)`。`displayState` が null なら
  `obj.visible = false` にして return。`Bullet.sync` のオーバーライドも同様
  （速度方向を向く実装はそのまま、参照する state を差し替えるだけ）。
- `EntityManager.sync(fo)` → `sync(fo, displayTime)`。`Game.sync` は既に `displayTime` を持っている
  （`displayTimeManager.resolveDisplayTime` の戻り値、`cameraSystem.sync` の直前）ので渡すだけ。
- `Player.syncPlayer` にも渡し、機体メッシュと `PlayerMarkers` の `▷ self` マーカーを
  `displayState` 基準にする（規則を分岐させない。マップでは機体は実質不可視 5 m なので、
  実際に効くのは `▷` だけ）。未来表示中は「自由飛行予測の ▷」と「計画上の ⬡」が同時に出るが、
  これは元メモの「両方表示する」の意図どおり。記号だけで区別できるかは実物を見て判断する。
  - **`FloatingOrigin` は現在の自機状態のまま**にする。fo は f32 精度のための平行移動でしかなく、
    LEO 内の将来位置は ±1.5e7 m に収まるので単精度で破綻しない。fo を将来位置へ動かすと
    戦闘ビューの意味論まで変わる。
- **マーカーも同じ時刻に揃える。** `Enemy.markerItem(isTarget, viewerPos, pos)` に表示位置を
  渡す形にして `Game.sync` が `displayState` から作る。ここを揃えないと「機体は未来位置、
  ◇マーカーは現在位置」で明確に壊れて見える。`displayState` が null の敵はマーカーごと落とす。
- 軌道線（`OrbitLine`）は要素から描く楕円で時刻に依らないので**変更不要**。
- 予測を持たないもの（弾・薬莢・デブリ）は `displayTime > simTime` の間まるごと消える。弾の寿命は
  数秒なので、未来表示の対象にする意味がない。予測期間を超えた領域も同様に消える
  （§3-3。恒久対策は §6）。

**検証**: typecheck。実行時確認を求められたら `/verify`。確認項目: (a) 戦闘ビューの見た目が
完全に不変、(b) マップでスライダーを動かすと敵と補給が軌道上を進む、(c) 予測期間超過で消える、
(d) 自機が噴射したフレームで予測が作り直される。

---

### Step 5 — 過去列・未来列の線描画（デバッグ表示まで）

**目標**: `current.history`（過去軌跡）と `predicted.history`（将来軌道）を線として描ける
インフラを整え、デバッグ表示まで通す。

**目的**: 過去列を保持する動機そのもの（§1）。ここまでで両列は既に `OrbitState` の時系列として
揃っているので、残るのは出口だけ。ただし**表示仕様（何にどう描くか）は未定**なので、
このステップの成果物はデバッグ表示に留める。

**実装詳細**:

- `SampledLine.syncGeometry` は `readonly OrbitState[]` を取るので、`StateQueue` に
  **古い順の配列を返す出口**を1本足せば繋がる（キューは新しい順に保つので順序反転が要る。
  `Deque.at(i)` があるので実装は数行）。`test:physics` の `state-queue.test.ts` に追記する。
- 回転系の問題（どの `Frame` で bake するか）は `SampledLine` が既に解決済み
  （bake = `toFrameState`、un-bake = 毎フレームの剛体回転）。`PlanDisplay.trajectoryFrame` と
  同じ値を渡せばよい。
- 過去線と未来線は現在時刻の点で連続する（§3-2 の `sampleInterval` 共通化）。1本の線として
  描くか色を変えて2本にするかは表示仕様なので、ここでは決めない。
- **「どのエンティティに、どう線を描くか」は仕様としてまだ決まっていない。** 決まっていない以上、
  この段階で作れるのは（作るべきなのは）デバッグ表示までで、本実装は仕様が決まってから。
  したがって `GameEntity` に線を生やさない — `Enemy.orbitLine` のようにエンティティが線を
  所有する形にすると、「全個体が常に自分の線を持つ」という仕様上の決定を先に固定してしまう。
  **描画側のモジュールが「線を描く対象の集合」を毎フレーム受け取る**形にしておけば、対象の変更も
  実装ごとの差し替え・撤去も軽微で済む（当面の既定は自機とターゲット）。
- `PredictedLine`（arc 単位の再利用ユニット、Step 0 で `plan/` へ移動済み）は plan 非依存に
  作ってあるので、「1本の線 + 入力変化検出 + スロットル」が要るならそのまま転用できる。
  その場合は plan と共用の置き場（`src/game/` 直下の描画ユニット等）へ出す。ただし増分更新される
  列に対しては毎フレーム末尾が伸びるだけなので、`SampledLine` を直接使う方が素直な可能性が高い
  — 実装時に比較する。

**検証**: typecheck、`test:physics`。`/verify` で線が出ること、ワープ中もジッタしないこと。

---

## 6. 現時点では実装しない（将来 todo）

- **計画軌道キャッシュの `StateQueue` 化**（元メモ 5 の後半。前半の `planDisplay` 分離は Step 0 で実施）。
  `physics/predict.ts` の `sampleAt`（線形補間）と `StateQueue.at`（エルミート補間）が
  「区間を二分探索して補間する」重複実装になっている点は実在する。ただし計画予測は
  「凍結アンカーからの一括再計算 + スロットル」で増分更新ではないため設計が別物。本件とは
  独立に片付ける。
- **予測期間を超えた領域の解析ケプラー外挿**。`elements` + `trueAnomalyAt` / `positionOnOrbit` が
  既にあり O(1) で任意時刻の位置が出る。J2 の RAAN 回帰（約5°/日）を無視するので1日で数百 km
  ずれるが、「消える」よりは 28 日スライダーの見た目が成立する。精度階層とセットで検討。
- **予測期間の階層化と優先度付け**。`refactoring_todo.md`「predictSystem の拡張」が挙げる
  「自機・ターゲットは高精度で長く、その他は低精度で短く」。`predictDuration` をインスタンス単位の
  可変値にすれば表現できるが、誰が書き込むか（`Targeter` が敵のフィールドを触る）の整理が要る。
  `Predictor` のラウンドロビンに優先度を入れるのも同時に。
- **`Enemy` の推力と予測の関係**。敵が推力を持つようになったとき、自機と同じ即時リセットにするか、
  距離判定に任せるか（§3-4 (b)）。実装が入る時点で決める。
- **乖離時にリセットではなく補正項をかける**（元メモ「実現が困難」）。物理的に正しい補正
  （エンケ法的な差分積分）は実装コストが高く、リセットで足りている限り手を出さない。
- **計画予測（`physics/predict.ts`）にも抵抗を入れるか**。Step 1 で入り口だけ作るが既定は 0。
  入れると 24 時間で 3.9 km 計画がずれる = 現状の計画ツールの挙動が変わるので、UX 判断として別途。
- **未来表示中の HUD の整合**。敵リストパネル・LEAD・的通過マークは現在時刻の `state` を読み続ける。
  距離表示の基準（現在の自機か未来の自機か）を決める必要があり、マーカー位置ほど自明に
  壊れて見えないので後回し。

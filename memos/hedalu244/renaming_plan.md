命名の改善、リファクタリング
Attractor型の変数名がbodyになっている箇所がある。/refactorの「同一概念に複数の名前がある」に該当。

orbitという接頭辞の意味が形骸化している。orbitline、orbitalState、orbitEntityなど。これらに接辞を付けているのにElementsには接辞がないのも変。Trajectoryやdynamicsとの区別もあいまい。
現状、シミュレーションにしても線の描画にしても、明確に区別するべきは、純粋なケプラー解析軌道を表すものか、摂動を考慮した非ケプラー解析軌道であるか、RK4積分を行っている/積分に基づくものかであるから、これに即した命名体系に置換するべきである。

OrbitEntityはトラッキングが責務であり、Dynamicsは積分が責務であることが命名的にも構造的にも分かりづらい。sampled-lineは履歴を表し、orbit-lineが純粋なケプラー軌道を表すことも分かりづらい。これらの命名体系も整理する必要がある。
OrbitStateは単に直交座標系での時刻と位置と速度を表すだけのものであり、軌道の状態を表すものではないはずだ。KineticStateとかでいいのでは？

これらの他に類似する問題がないか、総合的に問題点を洗い出し、置換前後の命名体系の対応表案を `for_agents.md` に書き出してください。


# 命名体系の整理案

`src/` 全体の命名を洗い出した結果と、置換前後の対応表案。まだ**提案**であり、実施していない。

数字は `src` + `tests` + `DEVELOP` + `CLAUDE.md` に対する grep 一致行数(改名コスト目安)。

---

## 1. 新しい命名体系の骨格

現状「軌道」まわりの語が意味を失っている原因は、**性質の違う3つのものに同じ `orbit` を貼っている**こと。
区別すべき軸は以下の3つで、これに語を割り当てる。

| 族 | 意味 | 割り当てる語 |
|---|---|---|
| **A. ケプラー解析軌道** | 二体問題の閉じた解(円錐曲線)。時刻→位置が解析式で決まる | `orbit` / `orbital` |
| **B. 非ケプラー解析軌道** | 解析式だが円錐曲線でない(天体暦と歳差、ラグランジュ点、halo/Lissajous) | `ephemeris` / `libration` |
| **C. 数値積分に基づくもの** | RK4 で前進させた/させる時刻付き状態の列 | `trajectory` / `propagate` |

そして **どの族でもないもの** — 単なる時刻付き位置・速度 — には軌道語を一切使わない。

規則は「`orbit` は A を意味する」の一点。`moonOrbitNormal` のように**どの軌道かが名前に書いてある**
ものは B でも許す(曖昧でないため)。禁止されるのは `OrbitState` / `OrbitEntity` / `stepOrbitRK4` の
ように、**C や無関係なものに `orbit` を貼る**ことと、**A なのに接辞が無い** `Elements`。

---

## 2. 中核データ型

| 現在 | 案 | 理由 |
|---|---|---|
| `OrbitState` (213) | `KinematicState` | t/r/v しか持たず、軌道の情報はゼロ。弾・薬莢・カメラ補間にも使う汎用の運動学量。※`KineticState` は kinetics = 力を扱う分野で、力を含まない r,v には kinematic が正確。短さ優先なら `KineticState` でも可 |
| `orbitState(t,r,v)` (109) | `kinematicState(...)` | |
| `physics/orbital-state.ts` | `physics/kinematic-state.ts` | |
| `RelativeOrbitState` | `FrameRelativeState` | §7 参照 |
| `OrbitStateSaveData` | `KinematicStateSaveData` | |
| `StepState` (`simulation/time-step.ts`) | **削除** | `KinematicState` の r/v だけを写した構造的重複型。引数型を `readonly KinematicState[]` にすれば消える |
| `OrbitalAxes` / `orbitalAxes` / `fromOrbitalAxes` | 据え置き | 状態から定まる**接触軌道**の基底なので A。`orbital` は正しい |
| `altitudeOf(r)` | `earthAltitudeOf(r)` | 中身は `len(r) - R_EARTH` で地球専用なのに名前が汎用。全天体対応の `sunkIntoAnySurface`(§6)と紛れる |

---

## 3. 積分系(C 族)

`OrbitEntity` の責務は「時刻付き状態を1つ保持し、1歩進め、間引いた列を持ち、任意時刻を引く」。
これは**軌跡そのもの**であって entity ではない。`GameEntity` と語が衝突しているうえ、
`PlanArc` がこれを `entity` という名前のフィールドで持っているのは端的に嘘。

| 現在 | 案 | 理由 |
|---|---|---|
| `OrbitEntity` (47) | `Trajectory` | C 族の中心型。`GameEntity` との衝突解消 |
| `physics/orbit-entity.ts` | `physics/trajectory.ts` | |
| `GameEntity.current` (22) | `actualTrajectory` | `current` は「今」を指す語で、過去列を含む列全体の名前として誤り。`predicted` と対にならない |
| `GameEntity.predicted` | `predictedTrajectory` | |
| `GameEntity.stepSim` | `stepActual` | `Simulator.stepSimulation` と語形が同じで粒度が違う。`actualTrajectory` と対にする |
| `GameEntity.stepPrediction` | `stepPredicted` | 同上 |
| `Simulator.stepSimulation` | `advance` | フレーム分をサブステップに割る側。1ステップの `step` と語を分ける |
| `Simulator.simulationSubStep` | `substep` | |
| `PlanArc.entity` | `trajectory` | |
| `PlanArc.samplesRef()` | `samples` (getter) | `Ref` は所有権の話で、返り値の意味を説明していない |
| `PlanArc.sampled` | `line` | 保持しているのは描画線 |
| `stepOrbitRK4` (18) | `stepRK4` | 加速度コールバックを受けるだけの汎用 ODE ステッパで、軌道と無関係 |
| `stepDynamicsRK4` (23) | `propagate` | 全天体重力+J2+抗力+推力の1ステップ。伝播は軌道力学の標準語 |
| `dynamics.ts` の private `accel` | `totalAccel` | `attractorAccel` / `j2Accel` / `dragAccel` の合成であることを名前に出す |
| `physics/dynamics.ts` | `physics/propagation.ts` | 「dynamics = 積分」が名前から読めない(§11-3 も参照) |
| `SampledLine` (17) | `TrajectoryLine` | 「積分点列の線」であることを名前に出し、`OrbitLine`(解析楕円)と名前だけで対比が付く |
| `render/sampled-line.ts` | `render/trajectory-line.ts` | |
| `DebugHistoryLine` | `DebugTrajectoryLine` | 過去列だけでなく予測列も描いている |
| `PREDICT_SAMPLES_PER_REV` | `TRAJECTORY_SAMPLES_PER_REV` | 過去列(history)の間引きにも使われており predict 専用ではない |
| `STEPS_PER_REV` (`plan-arc.ts`=100) | `PLAN_ARC_STEPS_PER_REV` | **同名・別値の module-private 定数が2つある。**片方を読んだ人がもう一方の値だと思い込む |
| `STEPS_PER_REV` (`predictor.ts`=600) | `PREDICT_STEPS_PER_REV` | 同上。両方 `const.ts` へ移すのが望ましい |

### 語の割り当てで潰れるもの

`Trajectory` を C 族の中心型にすると、現在その名を占めている `PlanTrajectory` を動かす必要がある。

| 現在 | 案 |
|---|---|
| `PlanTrajectory` (20) | `PlanPath` (複数 `PlanArc` の合成表示) |
| `PlanDisplay.traj` | `path` |
| `PlanDisplay.trajectoryFrame` | `planFrame` |

UI ラベルの `TRAJECTORY` は人間向け表示なので据え置いてよい。

> 代案: 中心型を `StateTrack`(トラッキングという責務の直訳)にして `PlanTrajectory` を残す手もある。
> ただし `TrackLine` / `actualTrack` は `audio/bgm-tracks.ts` の `BgmTrack` と語が当たる。
> **`Trajectory` を推す** — 衝突ゼロ・軌道力学の標準語・`TrajectoryLine` と `OrbitLine` の対比が明快。

---

## 4. ケプラー解析系(A 族)

| 現在 | 案 | 理由 |
|---|---|---|
| `Elements` (48) | `OrbitElements` | A 族の中心型なのに接辞が無い。`Elements` 単独では何の要素か分からず、`parts.ts` の装備要素とも紛れる |
| `elementsFromState(rel, center)` | `orbitElementsFromState` | |
| `elementsAround(s, body)` (61) | `orbitElementsAround(s, center)` | 第2引数は §6 |
| `GameEntity.elementsAround(body)` | `orbitElementsAround(center)` | |
| `orbitClose` (`plan-guide.ts`) | `orbitElementsClose` | 比べているのは要素であって軌道そのものではない |
| `stateFromElements` | `stateFromOrbitElements` | |
| `orbitPeriodOf` (`plan.ts`) | `arcDurationOf` | 返すのは「1区間の長さ」で、非周期軌道では `APERIODIC_ARC_DURATION` を返す。周期ではない |
| `OrbitLine` | 据え置き | `orbit` を A 専用にすると、この名前は初めて正しくなる |
| `render/orbitline.ts` | `render/orbit-line.ts` | 他が全て kebab-case。`earthcolor.ts` → `earth-color.ts` も同様 |
| `keplerPeriod` / `positionOnOrbit` / `velocityOnOrbit` / `trueAnomalyAt` / `tofBetween` / `timeSincePeriapsis` / `apsisAltitudes` | 据え置き | すでに A 専用語 |

---

## 5. 天体暦・非ケプラー解析系(B 族)

| 現在 | 案 | 理由 |
|---|---|---|
| `sunOrbitRotation` / `sunOrbitRotationAt` | `sunRotatingFrame` / `sunRotatingFrameAt` | 返すのは座標系の姿勢・角速度。`frame.ts` の Frame 値 `'sunRotating'` と名前が一致し、対応が名前だけで付く |
| `moonOrbitRotation` / `moonOrbitRotationAt` | `moonRotatingFrame` / `moonRotatingFrameAt` | 同上 |
| `sunPosition` / `moonPosition`(module 関数) | `sunPositionAt` / `moonPositionAt` | |
| `Ephemeris.sunPosAt` / `moonPosAt` / `moonVelAt` / `sunVelAt` | `sunPositionAt` / `moonPositionAt` / `moonVelocityAt` / `sunVelocityAt` | `Pos`/`Vel` 略記と `Position` の混在。`*At` = 「phase0 を閉じ込めたクラス側」の規約は維持 |
| `collinearFrame` / `CollinearFrame` (`halo.ts`) | `librationFrame` / `LibrationFrame` | `LibrationSystem` / `LibrationPoint` と語が揃う |
| `moonOrbitNormal(At)` / `emLagrangeAt` / `seLagrangeAt` / `sunlitFactor` | 据え置き | どの軌道・どの系かが名前にあり曖昧でない |

---

## 6. `Attractor` の変数名

**`body` は現在4つの意味を持っている。**

1. `Attractor`(`attractor.ts` 全体、`dynamics.ts:75,89`、`orbit-entity.ts:39`、`game-entity.ts:70,80,163`、
   `enemy.ts:200,293`、`bullet.ts:51`、`debris-piece.ts:53`、`player.ts:299`、`entity-manager.ts:114`、
   `hud/panel.ts:69`、`plan.ts:11`、`plan-guide.ts:30,90`、`plan-arc.ts:26`、`ship.ts:276`、`targeter.ts:147,155`)
2. 機体座標系(`radiator.ts` の `bodyNormal` / `bodyOffset`、コメントの「機体座標系」)
3. DOM のパネル本体(`plan-editor.ts` の `bodyState` / `bodyNode` / `bodyArr`、`hud/` 各所)
4. 中心天体の半径(`elements.ts:74` / `creative-stage.ts:241` の `bodyRadius`)

| 現在 | 案 | 理由 |
|---|---|---|
| `body: Attractor` | `attractor` | 型名と一致させる |
| `bodies: readonly Attractor[]` | `attractors` | 同上。`Ephemeris.attractorsAt` は既にこの語 |
| 楕円の中心として渡す `body` (`relativeTo` / `toAbsolute` / `elementsAround`) | `center` | `Elements.center` と一致する。「中心として選ばれた」役割が引数名に出る |
| `bodyRadius` | `centerRadius` | |
| DOM の `bodyState` / `bodyNode` / `bodyArr` | `panelBody` 系 | |
| 機体座標系の `body*` | 据え置き | aerospace 標準の body frame。**`body` はこの意味に限定する** |
| `hitsAnySurface(r, bodies, margin)` (20) | `sunkIntoAnySurface(r, attractors, margin)` | `hit` が (1) 弾の命中 `HitSystem`/`checkBulletHits`/`attacked` (2) 剛体接触 `sweptSphereToi`/`SweptSphereHit` (3) 天体表面到達 の3義。(3) だけ別語にする |

---

## 7. `frame` 語の多重定義

現在 `Frame` は **5つの別物**を指している。

| 現在 | 実体 | 案 |
|---|---|---|
| `Frame` (`physics/frame.ts`, 53) | 表示用座標系 `inertial`/`sunRotating`/`moonRotating` | `ReferenceFrame`(ファイルも `physics/reference-frame.ts`) |
| `ViewFrame` (`physics/projection.ts`, 31) | カメラの視点パラメータ(位置/注視点/up/fov/aspect) | **`Viewpoint`** — 座標系ではない。`camera.view` → `camera.viewpoint`。これだけで「frame」の意味が1つ減る |
| `CollinearFrame` (`halo.ts`) | 共線ラグランジュ点まわりの回転局所系 | `LibrationFrame`(§5) |
| `FrameRotation` (`ephemeris.ts`) | `ReferenceFrame` の姿勢と角速度 | 据え置き |
| 機体座標系 / 描画フレーム(コメント中の「フレーム」) | — | コメント側で「機体座標系」「1フレーム」と書き分ける(`frame` と書かない) |

さらに「何に対して relative か」が名前に無い branded type がある。

| 現在 | 案 |
|---|---|
| `RelativeVec3` (`frame.ts`) | `FrameRelativeVec3` |
| `RelativeOrbitState` (`frame.ts`) | `FrameRelativeState` |
| `relativeTo` (`attractor.ts`, 天体中心相対) | `toCenterRelative` |

`relativeTo`(天体中心相対)と `Relative*`(座標系相対)は別概念なのに同じ語を使っている。

---

## 8. 描画線の3種

改名後は名前だけで族が判別できるようになる。

| クラス | 族 | 描くもの |
|---|---|---|
| `OrbitLine` | A | `OrbitElements` から解析的に生成した楕円 |
| `TrajectoryLine` (旧 `SampledLine`) | C | 積分で得た時刻付き状態列の折れ線 |
| `PlanArc` | C | 計画1区間。`Trajectory` + `TrajectoryLine` を持つ |
| `PlanPath` (旧 `PlanTrajectory`) | C | 複数 `PlanArc` の合成表示 |

---

## 9. 時刻を表す引数名

| 現在 | 案 | 理由 |
|---|---|---|
| `SampledLine.syncTransform(frame, currentTime, ...)` | `unbakeTime` | **同じ値が1つの呼び出し連鎖で3つの名前を持っている**(`currentTime` / `unbakeTime` / 実引数は `simTime`)。役割を表す `unbakeTime` に統一する |
| `PlanArc.sync(..., currentTime, ...)` | `unbakeTime` | |
| `PlanTrajectory.update(..., currentTime)` → `this.unbakeTime` | `unbakeTime` | 引数とフィールドが別名 |
| `simTime` / `displayTime` | 据え置き | 意味が明確に分かれており、混同していない |

---

## 10. その他の類義語の混雑(優先度低・要判断)

**「所有して毎フレーム駆動するもの」の接尾辞が4系統ある。** 漠然とした命名の典型で、
`Manager` と `System` はどちらも中身を説明していない。ただし置換範囲が広く挙動と無関係なので、
**一括改名ではなく「今後 `Manager`/`System` を新設しない」という規則にとどめる案を推す。**

- `*Manager`: `EntityManager` `MarkerManager` `UnlockManager` `SaveManager` `DisplayTimeManager` `SimSpeedManager` `FlashEffectManager` `ViewManager`
- `*System`: `CameraSystem` `CombatCameraSystem` `HitSystem` `EffectsSystem` `PowerSystem` `RadiatorSystem` `ThermalSystem`
- `*Physics`: `CollisionPhysics` `BeltPhysics`
- 動作主体名: `Simulator` `Predictor` `Targeter` `MapPicker` `Docking`

---

## 11. 改名では直らない構造問題(同時に検討)

1. **`StepState` (`simulation/time-step.ts`) は `KinematicState` の部分的な重複型。**
   引数型を `readonly KinematicState[]` にすれば型ごと消える(§2)。
2. **地球の物理定数 `MU_EARTH` / `R_EARTH` / `R_EARTH_EQ` / `SIDEREAL_DAY` が状態ベクトルのモジュールに同居している。**
   `kinematic-state.ts` へ改名すると同居の不自然さが際立つ。天体定数は `attractor.ts` / `ephemeris.ts` 側が自然。
3. **`dynamics.ts` が2責務を持っている** — 汎用 ODE ステッパ(`stepOrbitRK4`)と運動方程式の合成(`accel`/`j2Accel`)。
   「dynamics」が積分に読めない原因はここ。`physics/propagation.ts`(積分)と加速度合成の分離も選択肢。
4. **`STEPS_PER_REV` の同名別値**(§3)。両方 `const.ts` へ。
5. **`PREDICT_SAMPLES_PER_REV` が history にも使われている**(§3)。
6. **`game-entity.ts` の `import { elementsAround as elementsAroundBody }`** — メソッド名と衝突するための別名。
   改名後も衝突は残るので、モジュール関数側かメソッド側のどちらかを更に区別する必要がある。
7. **kebab-case 逸脱**: `render/orbitline.ts` / `render/earthcolor.ts`。

---

## 12. 適用順序の提案

挙動を変えない純粋な改名なので、**族ごとに1変更セット**で区切り、各セットで
`npm run typecheck` + `npm run test:physics` を通す。

1. **§7 `ViewFrame` → `Viewpoint`** — 独立性が高く、`Frame` 語の混雑が一番大きく減る(31箇所)。
2. **§6 `body` → `attractor` / `center`** — 型は変わらず変数名だけ。機械的で安全。
3. **§2 `OrbitState` → `KinematicState`** — 最大(213箇所)だが単純置換。`StepState` の削除も同時に。
4. **§4 `Elements` → `OrbitElements`** — A 族の確定。
5. **§3 `OrbitEntity` → `Trajectory` と `PlanTrajectory` → `PlanPath`** — 名前が入れ替わるので必ず同一セットで。
6. **§5 B 族の `*Orbit*` → `*RotatingFrame*`**、**§7 の残り**、**§9 時刻名**、**§11 の構造問題**。

各セットで守ること(`/refactor` の改名規則):

- 旧名が 0 件になるまで消す。`grep -rn "<旧名>" src tests DEVELOP CLAUDE.md .claude memos`
- 「旧」「former」「(旧 xxx)」の類をコード・文書に書かない。互換エイリアスも残さない。
- `CLAUDE.md` / `DEVELOP/CALLSTACK.md` / `DEVELOP/OWNERSHIP.md` / `DEVELOP/SPEC.md` を同じ変更セットで更新する。
  特に `CLAUDE.md` の Architecture 節と `test:physics` の説明文には旧名が大量に入っている。

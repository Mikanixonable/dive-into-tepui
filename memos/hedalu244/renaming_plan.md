# 命名体系の整理案

`origin/main`(重力源を恒星/惑星/衛星の解析軌道モデルへ再構成した版)をマージした後のコードに対する提案。
まだ**提案**であり、実施していない。

表はすべて `| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |` の4列で統一する。
`現在` の括弧内は `src` + `tests/physics` + `DEVELOP` + `CLAUDE.md` に対する grep 一致行数(改名コスト目安)。

**§13 に「私(hedalu244)が決めること」を集約した。** 先にそこを読んで判断してもらえれば、残りは機械的に進められる。

---

## 1. 語族の骨格

区別すべき軸は3つ。**判定基準は「そのモジュールの実装が何に限定されているか」であり、外部でどう使われているかではない。**

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| (族の語がばらついている) | `orbit` | 解析的に解ける軌道。ケプラー要素、円錐曲線、その基底・周期・近点 | 時刻→位置が閉じた式で決まるもの。`OrbitLine` / `Elements` / `KeplerOrbit` / `localOrbitPeriod` がここ |
| (同上) | `ephemeris` / `celestial` | 太陽系の天体そのもの、およびその位置を時刻から返すサンプラ | `ephemeris` は「時刻→位置を答える仕組み」、`celestial` は「天体という存在」。§6 のとおり**両者は同義ではなく、統一の必要がない** |
| (同上) | `dynamic` | RK4 積分に基づくもの。積分器、積分で伸ばす軌跡、その保持列 | `trajectory`(履歴を持つことを含意)/`propagate`(前進を含意)はいずれも族の全員に当てはまらないので使わない |
| — | (族語を使わない) | どの族にも限定されないモジュール | `SampledLine`(任意の点列を線にするだけ)、`KinematicState`(t/r/v しか持たない)、`stepRK4`(汎用 ODE ステッパ)がここ |

**規則は「`orbit` は解析軌道を意味する」の一点。** `keplerOrbitNormal` のように *どの軌道か* が名前に書いてあるものは
それで曖昧でないので許す。禁止するのは `OrbitState` / `OrbitEntity` / `stepOrbitRK4` のように**解析軌道でないものに
`orbit` を貼る**ことと、**解析軌道なのに接辞が無い** `Elements`。

---

## 2. マージで解決した項目(作業不要・記録のみ)

前版の提案のうち、`origin/main` の再構成で該当箇所そのものが消えたもの。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `Ephemeris.stateOf` / `positionOf` (旧 `sunPosAt`/`moonPosAt`/`moonVelAt`/`sunVelAt`) | 据え置き | id と時刻を渡すと状態が返る統一 API | `Pos`/`Vel` 略記と固有名分岐が消え、天体を増やしても関数が増えない |
| `Ephemeris.orbitRotationAt` / `orbitNormalAt` (旧 `sunOrbitRotation`/`moonOrbitRotation`/`moonOrbitNormal`) | 据え置き(§7 に微修正案) | 公転している天体に固定した回転基準系の姿勢・角速度と軌道面法線 | 太陽/月の固有名分岐が消えた |
| `Ephemeris.lagrangeAt(secondary, t)` (旧 `emLagrangeAt`/`seLagrangeAt`) | 据え置き | 副天体を指定した円制限三体問題のラグランジュ点 | 系ごとの関数が1本に統合された |
| `FramePoint` / `FrameDir` / `FrameOrbitState` (旧 `RelativeVec3`/`RelativeOrbitState`) | `FrameOrbitState` のみ §3 で改名 | 座標系相対の点・方向・状態の branded type | 「何に対して relative か」が名前に入った。点と方向が型で分かれたのも改善 |
| `frameOfAttractor` + `toFrameState` (旧 `relativeTo`/`toAbsolute`) | 据え置き | 天体中心相対への変換を座標系変換に一本化 | `relativeTo`(天体中心相対)と `Relative*`(座標系相対)の語衝突が消えた |
| `PLAN_ARC_STEPS_PER_REV` / `PREDICT_STEPS_PER_REV` (旧 `STEPS_PER_REV` ×2) | 据え置き | 計画弧・予測の1周回あたりステップ数 | 同名別値の module-private 定数が `const.ts` へ移り、名前で区別されるようになった |
| `CELESTIAL_VIEWS[id].name` (旧 `ATTRACTOR_NAMES` の直書き) | §7 に別件あり | 天体の日本語表示名の唯一の定義元 | 表示名の重複定義が解消された |

---

## 3. 中核データ型

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `OrbitState` (219) | `KinematicState` | `{t, r, v}`。時刻付きの位置・速度だけを持つ不変値(`__frame:'inertial'` ブランド付き) | 軌道の情報をゼロ個も持たない。弾・薬莢・カメラ補間にも使う汎用の運動学量で、どの族にも属さない。§13-1 に別案 |
| `orbitState(t,r,v)` (115) | `kinematicState(...)` | 上記を組み立てる唯一の入口 | |
| `physics/orbital-state.ts` | `physics/kinematic-state.ts` | 上記の型 + 高度 + 軌道基底 + エルミート補間 + 地球定数 | 地球定数の同居は §12-2 |
| `FrameOrbitState` (8) | `FrameKinematicState` | 座標系相対の r/v(時刻を持たない) | `OrbitState` と連動。`orbit` が付いている理由が無い |
| `frameOrbitState(r,v)` | `frameKinematicState(...)` | 上記を組み立てる入口 | |
| `StepState` (`simulation/time-step.ts`) | **削除** | `adaptiveSimulationMaxStep` の引数用に r/v だけを写した構造型 | `KinematicState` の部分的な重複型。引数を `readonly KinematicState[]` にすれば型ごと消える(§12-1) |
| `OrbitalAxes` / `orbitalAxes` / `fromOrbitalAxes` (29) | `OrbitAxes` / `orbitAxes` / `fromOrbitAxes` | 状態から定まる接触軌道の基底(pro/nrm/radOut) | 解析軌道の基底なので `orbit` 族で正しいが、`orbital` は族語の二重表記。§13-2 で判断 |
| `PlayerMarkers.syncOrbitalDirections` | `syncOrbitDirections` | 6方向マーカーの配置 | 同上 |
| `altitudeOf(r)` (4) | `earthAltitudeOf(r)` | `len(r) - R_EARTH`。地球専用 | 名前が汎用なのに中身は地球固定。全天体対応の表面判定(§5)と紛れる |

---

## 4. 積分系(`dynamic` 族)

`OrbitEntity` の責務は「時刻付き状態を1つ保持し、1歩進め、間引いた列を持ち、任意時刻を引く」。
これは**軌跡そのもの**であって entity ではなく、`GameEntity` と語が衝突している。
`PlanArc` がこれを `entity` という名前のフィールドで持っているのは端的に嘘。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `OrbitEntity` (45) | `DynamicTrajectory` | 1つの状態 + 間引いた履歴列。`stepDynamicsRK4` で前進し、任意時刻を補間で引ける | 積分に限定された型なので `dynamic` 族。`GameEntity` との語衝突も解消。§13-3 で素の `Trajectory` と比較 |
| `physics/orbit-entity.ts` | `physics/dynamic-trajectory.ts` | 上記 | |
| `GameEntity.current` (22) | `actualTrajectory` | 実際に飛んだ軌跡(過去列 + 現在) | `current` は「今」を指す語で、過去列を含む列全体の名前として誤り。`predicted` と対にならない |
| `GameEntity.predicted` | `predictedTrajectory` | 予測した軌跡(現在 → 予測地平) | 上記と対にする |
| `GameEntity.stepSim` | `stepActual` | 実軌跡を1サブステップ進める | `Simulator.stepSimulation` と語形が同じで粒度が違う |
| `GameEntity.stepPrediction` | `stepPredicted` | 予測軌跡の先端を1ステップ伸ばす | 同上 |
| `Simulator.stepSimulation` | `advance` | 1フレーム分をサブステップに割る側 | 1ステップの `step` と語を分ける |
| `Simulator.simulationSubStep` | `substep` | 1サブステップぶんの全エンティティ更新 | |
| `PlanArc.entity` | `trajectory` | その区間の `DynamicTrajectory` | 保持しているのは軌跡であって entity ではない |
| `PlanArc.samplesRef()` | `samples` (getter) | 積分済みサンプル列 | `Ref` は所有権の話で、返り値の意味を説明していない |
| `PlanArc.sampled` | `line` | 保持している `SampledLine` | 描画線を持っていることを名前に出す |
| `stepOrbitRK4` (18) | `stepStateRK4`(§13-7) | 加速度コールバックを受けるだけの汎用 ODE ステッパ | 軌道と無関係。どの族にも属さないので族語を外す。**素の `stepRK4` は `physics/nbody/integrator.ts` が既に export しているので使えない**(§13-7) |
| `stepDynamicsRK4` (22) | `stepDynamics` | 全天体重力 + J2 + 抗力 + 推力の1ステップ | すでに `dynamic` 族。RK4 は実装手段なので名前から外す(`stepRK4` の方はそれ自体が正体) |
| `dynamics.ts` の private `accel` | `totalAccel` | `attractorAccel` + `j2Accel` + `dragAccel` の合成 | 合成であることを名前に出す |
| `physics/dynamics.ts` | **据え置き** | 上記一式 | 前版の `propagation.ts` 案は撤回。`dynamic` を C 族の語に採るのでこのファイル名が族の中心になる |
| `DebugHistoryLine` (6) | `DebugTrajectoryLine` | 追跡対象の過去列 + 予測列を1本ずつ描くデバッグ表示 | 過去列(history)だけでなく予測列も描いている |
| `PREDICT_SAMPLES_PER_REV` (8) | `TRAJECTORY_SAMPLES_PER_REV` | 履歴・予測どちらの間引き間隔にも使う1周回あたりサンプル数 | `game-entity.ts` の履歴側でも読んでおり predict 専用ではない(§12-4) |

### 語の割り当てで動かす必要があるもの

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `PlanTrajectory` (21) | `PlanPath` | 複数の `PlanArc` を繋いだ計画折れ線の合成表示 | `trajectory` を `DynamicTrajectory` 側に使うため。`PlanArc`/`PlanPath` の対は自然 |
| `plan-trajectory.ts` | `plan-path.ts` | 同上 | |
| `PlanDisplay.traj` | `path` | 上記への参照 | 略記をやめる |
| `PlanDisplay.trajectoryFrame` | `planFrame` | 計画折れ線を描く座標系(カメラの座標系とは独立に選ぶ) | 「計画の座標系」であってカメラの座標系ではないことを名前に出す |

UI ラベルの `TRAJECTORY` は人間向け表示なので据え置いてよい。

---

## 5. 解析軌道系(`orbit` 族)

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `Elements` (52) | `OrbitElements` | 中心天体つきの古典軌道要素(a/e/inc/raan/argp/nu + center) | 族の中心型なのに接辞が無い。`Elements` 単独では何の要素か分からない。`orbital elements` 定訳との兼ね合いは §13-2 |
| `elementsFromState(rel, center)` | `orbitElementsFromState` | 中心相対の状態 → 要素 | |
| `elementsAround(s, body)` (64) | `orbitElementsAround(s, center)` | 絶対 ECI 状態 + 中心天体 → 要素 | 第2引数の名前は §5 |
| `GameEntity.elementsAround(body)` | `orbitElementsAround(center)` | 同上のメモ化版 | モジュール関数との別名衝突は §12-5 |
| `stateFromElements` | `stateFromOrbitElements` | 要素 → 中心相対の状態 | |
| `positionFromElements` | `positionFromOrbitElements` | 要素 → 中心相対の位置 | |
| `orbitClose` (`plan-guide.ts`) | `orbitElementsClose` | 2つの `Elements` が許容差内で一致するか | 比べているのは要素であって軌道そのものではない |
| `OrbitLine` | 据え置き | `Elements` から解析的に生成した楕円の描画 | `orbit` を解析軌道専用にすると、この名前は初めて正しくなる |
| `render/orbitline.ts` | `render/orbit-line.ts` | 同上 | 他が全て kebab-case(§12-6) |
| `localOrbitPeriod` / `keplerPeriod` / `positionOnOrbit` / `velocityOnOrbit` / `trueAnomalyAt` / `tofBetween` / `timeSincePeriapsis` / `apsisAltitudes` / `KeplerOrbit` / `keplerOrbitState` / `keplerOrbitNormal` | 据え置き | 解析軌道の数学そのもの | すでに族の語で正しい |
| `plan.ts` の `orbitPeriodOf` (12) | 据え置き(戻り値は §12-3) | 起点状態を最も強く引く天体まわりの公転周期 | マージで `segmentDurationFrom` が「区間長」を引き取ったので、この関数は本当に周期を返すようになった。前版の `arcDurationOf` 案は撤回 |

---

## 6. 天体・天体暦系(`ephemeris` / `celestial` 族)

### 6-1. `ephemeris` と `celestial` は同義ではない — 統一しない

調査結果として報告する。両者は現状すでに責務で分かれており、「同じものに複数の名前」には当たらない。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `physics/ephemeris.ts` の `Ephemeris` | 据え置き | 「id と時刻を渡すと位置・速度・重力源配列・回転基準系・ラグランジュ点が返る」サンプラ。状態は初期位相のみ | ephemeris = 時刻→位置を答える仕組み。この実装そのもの |
| `physics/solar-system.ts` の `CelestialBodyDef` / `SOLAR_SYSTEM` | §7 で `body` の扱いだけ判断 | 天体の静的事実(μ・半径・軌道モデル)の表 | celestial = 天体という存在。ephemeris とは別の責務 |
| `game/celestial/` | 据え置き | 天体1つぶんの見た目(メッシュ・表示距離圧縮) | 同上 |
| `render/celestial-grid.ts` | 据え置き | 天球の赤道グリッド・黄道グリッド | celestial sphere の定訳どおり |

### 6-2. `lagrange` / `libration` / `collinear` — ここが本当の重複

`lagrange` と `libration` は astrodynamics では完全な同義語で、実際に同じものを指して両方使われている。
一方 `collinear` は**同義語ではなく真の部分集合**で、消してはいけない。

`halo.ts` を読んで確認した根拠:
- `LibrationPoint = 'L1' | 'L2'` であって L4/L5 を含まない。
- `cn(point, ...)` の分母・符号が L1/L2 で場合分けされており、共線点の展開そのもの。
- 面内特性方程式 λ⁴+(c2−2)λ²−(2c2+1)(c2−1)=0 と Richardson の三次振幅拘束は共線点でしか成立しない。
- `collinearFrame` の x̂ が主天体→副天体方向 = **その直線上にいることが基底の定義そのもの**。

したがって「collinear → libration」は情報を落とす改名で、**却下する**。逆に、型名の方が広すぎる。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `CollinearFrame` / `collinearFrame` (12) | 据え置き | 共線ラグランジュ点まわりの回転局所基底と線形化パラメータ | 「同一直線上にある」ことが基底の定義そのもので、代替語がない |
| `LibrationPoint` (14) | `CollinearPoint` | `'L1' \| 'L2'` の union | L4/L5 を含まないので `LagrangePoint` では広すぎる。実際に扱っているのは共線点だけ |
| `ship-placer-panel.ts` の `librationSecondary` / `librationPoint` / `librationOrbitKind` / `LIBRATION_*_ITEMS` / `PlacementMode='libration'` | `lagrange*` / `LAGRANGE_*` / `'lagrange'` | ラグランジュ点まわりの軌道を指定するフォームの各欄 | `lagrange.ts` / `LagrangePoints` / `lagrangeAt` が既に `lagrange` 側で、UI ラベルも「ラグランジュ点」。`libration` は同義語の混雑 |
| `LibrationOrbitKind` | `LagrangeOrbitKind` | `'halo' \| 'lissajous'` | 同上 |
| `lagrange.ts` / `LagrangePoints` / `lagrangePoints` / `Ephemeris.lagrangeAt` | 据え置き | 5点すべてを返す | 統一先 |

---

## 7. `body` の多義

現在 `body` は6つの意味を持っている。うち (1)(3)(4)(5) は改名候補、(2) は据え置き、(6) は §13-4 で判断。

1. **`Attractor` 型の変数名(43箇所)** — `attractor.ts` 全体(`attractorAccel(r, body)` / `strongestAttractor(r, bodies)` / `frameOfAttractor(body)` / `elementsAround(s, body)` / `hitsAnySurface(r, bodies, ...)`)、`dynamics.ts` の `accel(..., bodies, ...)`、`orbit-entity.ts` / `game-entity.ts` / `predictor.ts` / `plan-arc.ts`(`sizingBodies` を含む) / `plan.ts` / `plan-guide.ts` / `plan-display.ts` / `enemy.ts` / `bullet.ts` / `debris-piece.ts` / `player.ts` / `ship.ts`(未使用の `_bodies`) / `entity-manager.ts` / `targeter.ts` / `hud/panel.ts` / `stage00.ts` / `creative-stage.ts` の各引数・ローカル
2. **機体座標系** — `radiator.ts` の `bodyNormal` / `bodyOffset`、`belt-physics.ts` の `prevBodyW` / `aThrustBody`、`player-throttle.ts` の `axisBody`、コメントの「機体座標系」
3. **DOM のパネル本体** — `plan-editor.ts` の `planBody`、`hud/panel.ts` / `hud/dock-view.ts` / `object-list-panel.ts` の `body`、`document.body`
4. **中心天体の半径など天体の属性** — `elements.ts` / `creative-stage.ts` / `creative/placement-validation.ts` の `bodyRadius`
5. **天体を指す UI・種別の語** — `ship-placer-panel.ts` の `ReferenceBody`(= `AttractorId`) / `BODY_ITEMS` / `bodyValue` / `ShipPlacerForm.body`、`map-pick.ts` の `MapPickKind` の `'body'` と `map-picker.ts` の `runBodyShip`
6. **天体そのもの(マージで増えた)** — `solar-system.ts` の `bodyDef` / `CelestialBodyDef`、`game/celestial/` の `CelestialBody` / `EarthBody` / `SunBody` / `PlanetBody`

加えて、未使用の `physics/nbody/` が `Attractor` と無関係な独自の `Body` interface と `bodies` を持っている
(`CLAUDE.md` に「cislunar フェーズ用に温存」と明記された実質デッドコード)。§13-7 と併せて扱う。

**(1) と (6) が同じ変数名で衝突している箇所が実在する:** `game/celestial/environment-scene.ts` の
`private readonly bodies: readonly CelestialBody[]` と `for (const body of this.bodies)` は、
コードベース中で唯一 `bodies`/`body` が `Attractor` ではなく `CelestialBody` を指すファイルになっている。
「同じ名前が別の型を指す」が既に起きている以上、(1) か (6) のどちらかは動かす必要がある。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `body: Attractor` | `attractor` | 重力を及ぼす天体1つ | 型名と一致させる |
| `bodies: readonly Attractor[]` | `attractors` | その時刻の重力源一覧 | 同上。`Ephemeris.attractorsAt` は既にこの語 |
| 楕円の中心として渡す `body` (`elementsAround` / `frameOfAttractor`) | `center` | 軌道要素を取る中心天体 | `Elements.center` と一致する。「中心として選ばれた」役割が引数名に出る |
| `bodyRadius` | `centerRadius` | 中心天体の表面半径 | |
| DOM の `bodyState` / `bodyNode` / `bodyArr` | `panelBody` 系 | パネルの本体要素 | |
| 機体座標系の `body*` | **据え置き** | 機体に固定した座標系 | aerospace 標準の body frame。**`body` 単独はこの意味に限定する** |
| `bodyDef(id)` (32) | `celestialDef(id)` | id から `CelestialBodyDef` を引く | 天体の意味で `body` を単独使用している関数。上の規則に反する |
| `EnvironmentScene.bodies` / `for (const body of ...)` | `celestialBodies` / `celestial` | 見た目クラス `CelestialBody` の配列 | **`bodies` が `Attractor[]` を指す他の全箇所と同じ名前で別の型を指している唯一の箇所。**規則を入れるなら真っ先にここ |
| `ReferenceBody` / `BODY_ITEMS` / `bodyValue` / `ShipPlacerForm.body` | `ReferenceAttractor` / `ATTRACTOR_ITEMS` / `attractorValue` / `.attractor` | 基準天体を id で選ぶ UI | 型の実体は `AttractorId`。型名と一致させる |
| `MapPickKind` の `'body'` / `runBodyShip` | `'celestial'` / `runCelestialShip` | 天体ラベルというピック種別 | `'ship'`/`'player'`/`'base'` と並ぶ種別名なので、天体を指すなら `celestial` が規則どおり |
| `PlanetBody` (7) | `SphereBody` | 「テクスチャ球 + 表示距離圧縮」で済む天体の見た目 | **`new PlanetBody('moon', ...)` と、衛星に対して使われている。** physics 側が `PlanetId`/`SatelliteId` を厳密に分けているのと直接矛盾する(§11-1) |
| `CELESTIAL_VIEWS` | `CELESTIAL_BODIES` | id → {表示名, `CelestialBody` の生成関数} | 値が `CelestialBody` を作るのに record が `VIEWS`。どちらかに揃える(逆向きの案は §13-4) |
| `CelestialBody` / `EarthBody` / `SunBody` (17) | 据え置き(§13-4 次第) | 天体1つぶんの見た目。位置は持たず Ephemeris から毎 sync 引く | `celestial` で必ず修飾されていれば機体の `body` とは衝突しない |

---

## 8. `hit` の多義 — 割り当ての洗い出し

前版の `sunkIntoAnySurface` は直観的でないという指摘を受け、論点として整理し直す。
`hit` は現在**4つの意味**で使われている。

- **(1) 弾丸の命中・被弾** — `HitSystem` / `checkBulletHits` / `hitSomething` / `hitR`(命中点) / `hitEffect` /
  `sideHitBy` / `hitPart` / `hitRadius` / `ScoreCounter.recordHit` / `hits` / `Sfx.hit` / `Sfx.enemyHit` /
  `const.ts` の `RADIATOR_HIT_DAMAGE` `RADIATOR_HITTABLE_DEPLOY` `SELF_HIT_GRACE` `BULLET_HIT_FLASH_*`
  `PLASMA_HIT_FLASH_*` `HIT_FRAG_*` `PLAYER_HIT_DAMAGE` `ENEMY_HIT_DAMAGE` `COLOR_*_HIT_FLASH` /
  `mk-boardhit` / `COLOR_MARKER_BOARDHIT`。語に `hit` を含まない同義の中核は `Ship.attacked`
- **(2) 剛体同士の接触** — `SweptSphereHit` / `collision.ts` の `const hit`。中核は `sweptSphereToi`
- **(3) 天体表面への到達** — `hitsAnySurface`(呼び出しは `game-entity.ts` ×2 / `enemy.ts` / `bullet.ts` /
  `player.ts` / `plan-arc.ts`)
- **(4) 画面上のクリック当たり判定** — `nav-target.ts` / `plan-editor.ts` ×3 / `targeter.ts` ×2 の `const hit`。
  中核は `pickNearest` / `nearestSample`
- **(5) 命中までの時間(派生)** — `enemy.ts` の `timeToHit`

密度でいうと (1) が圧倒的に多く、`const.ts` の定数群だけで十数語ある。
(2)(3)(4) は**いずれも「その意味の中核となる関数自体は `hit` を含んでいない**(`sweptSphereToi` /
`pickNearest`)という共通点があり、`hit` はそこにローカル変数や述語として後から乗っているだけ。
つまり (1) 以外の `hit` は語彙として根を張っておらず、動かすコストが小さい。

**方針の骨格: (1) が `hit` を占有する。** シューティングゲームで `hit` といえば命中であり、
ここを動かすと全体の語感が壊れる。(2)(3)(4) をそれぞれ別語にする。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| (1) の各識別子 | **据え置き** | 弾丸の命中・被弾 | `hit` の本義。ここを動かさないことで残り3つの改名が正当化される |
| `SweptSphereHit` (2) | `SweptSphereContact` | 接触時刻(toi)と接触法線 | 物理エンジンの標準語は contact(contact point / contact normal / contact manifold)。`CollisionPhysics` の語彙とも揃う |
| `collision.ts` の `const hit` | `contact` | 上記の戻り値 | 同上 |
| `sweptSphereToi` (9) | 据え置き | 最初に表面が触れる時刻の割合 | 返す値が toi そのものなので名前は正しい |
| `hitsAnySurface(r, bodies, margin)` (20) | `belowAnySurface(r, attractors, margin)` | 位置がいずれかの天体の半径 + margin より内側にあるか | 実装は距離比較であって「衝突判定」ではない。§13-5 に3案 |
| `nav-target.ts` / `plan-editor.ts` / `targeter.ts` の `const hit` (4) | `picked` | `pickNearest` / `nearestSample` が返した被選択物 | ピッキング結果。`pick*` 関数の戻り値なので `picked` が対になる |
| `enemy.ts` の `timeToHit` (5) | `leadTime` | `solveLeadTime` が返した先読み時間 | 呼んでいる関数と語を揃える。命中「した」わけではなく見越し時間 |
| `Sfx.hit()` / `Sfx.enemyHit()` | `playerHit()` / `enemyHit()` | 自機被弾音 / 敵被弾音 | 対になる2つのうち片方だけ主語が省略されていて、どちらが自機か名前から読めない |

---

## 9. `frame` の多重定義

前版の指摘のうち、アニメーションフレームとの衝突は慣用なので触れない。座標系でないものだけを外す。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `ViewFrame` (27) | `Viewpoint` | カメラの視点パラメータ(位置/注視点/up/fov/aspect) | 座標系ではない。これだけで `frame` の意味が1つ減る |
| `camera.view` (各カメラ) | `camera.viewpoint` | 上記のフィールド | |
| `syncCameraToViewFrame` | `syncCameraToViewpoint` | `Viewpoint` を `THREE.PerspectiveCamera` へ反映 | |
| `lerpViewFrameFov` | `lerpViewpointFov` | fovDeg だけを指数的に近づける | |
| `projectionFromView` | `projectionFromViewpoint` | `Viewpoint` から `ProjectFn` を作る | |
| `Frame` (`physics/frame.ts`) | **据え置き** | 表示用座標系 `{center, rotatingWith}` | 前版の `ReferenceFrame` 案は撤回(§13-8 で最終判断) |
| `FrameTransform` / `FrameRotation` | 据え置き | 座標系の剛体運動 {原点,原点速度,姿勢,角速度} / その回転成分 {姿勢,角速度} | 後者が前者の部分であることは名前から読めないが、置き場所(`kepler-orbit.ts` / `frame.ts`)が違うので実害は小さい |
| 機体座標系 / 描画フレームを指すコメント中の「フレーム」 | — | — | コメント側で「機体座標系」「1フレーム」と書き分ける(`frame` と書かない) |

---

## 10. 族に属さないもの — 族語を付けない

前版で `SampledLine → TrajectoryLine` を提案したが、**撤回する。**

`sampled-line.ts` の実装は `readonly OrbitState[]` を受け取って折れ線にするだけで、その点列が積分由来か
解析由来かを一切問わない(実際に `PlanArc` の積分列と `DebugHistoryLine` の履歴列の両方が入る)。
判定基準を「そのモジュールの実装が何に限定されているか」に置く以上、これは `dynamic` 族ではない。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `SampledLine` (17) | **据え置き** | 任意の時刻付き状態列を、座標系に bake してエルミート細分した1本の折れ線として描く | 点列の由来を問わない汎用基盤。族語を付けると嘘になる |
| `render/sampled-line.ts` | 据え置き | 同上 | |
| `stepRK4`(§4) | — | 加速度コールバックだけを使う汎用 ODE ステッパ | 同じ理由で族語を外す |
| `KinematicState`(§3) | — | t/r/v だけの値 | 同じ理由 |

### 改名後の描画線3種の対比

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `OrbitLine` | 据え置き | `Elements` から解析的に生成した楕円 | 名前だけで「解析軌道」と読める |
| `SampledLine` | 据え置き | 任意の点列の折れ線(由来を問わない) | 名前だけで「点列を線にするだけ」と読める |
| `PlanArc` | 据え置き | 計画1区間。`DynamicTrajectory` + `SampledLine` を持つ | |
| `PlanTrajectory` | `PlanPath` | 複数 `PlanArc` の合成表示 | §4 |

---

## 11. マージで新しく生じた問題

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `PlanetBody` (7) | `SphereBody` | テクスチャ球 + 表示距離圧縮で済む天体の見た目 | **月(衛星)に対して `new PlanetBody('moon', ...)` と使われている。** `PlanetId`/`SatelliteId` を厳密に分けた physics 側と正面から矛盾する。実際の区別軸は「専用の描き分けが要るか否か」であって惑星か衛星かではない |
| `CELESTIAL_VIEWS` | `CELESTIAL_BODIES` | id → {表示名, `CelestialBody` の生成関数} | 生成物の型と record 名が食い違っている(§13-4 に逆向きの案) |
| `bodyDef` (32) | `celestialDef` | id から静的事実を引く | §7 の規則(`body` 単独は機体座標系専用)に反する唯一の関数 |
| `FrameOrbitState` (8) | `FrameKinematicState` | 座標系相対の r/v | §3 と連動 |
| `Ephemeris.orbitRotationAt` | `orbitFrameRotationAt` | その天体の公転軌道に固定した回転基準系の姿勢・角速度 | 現在の名前は「軌道の回転」と読めるが、返すのは座標系の姿勢。`orbitNormalAt`(軌道面法線)は正しいので対にならない。優先度低 |
| `dynamics.ts` 先頭コメントの「ケプラーの二体問題の解析式込み」 | 削除 | — | そのような実装はこのファイルに無い(`elements.ts` にある)。改名ではなくコメントの実装矛盾 |
| `plan.ts` の `DisplayDurationSource` | 据え置き(要判断) | `DisplayTimeManager` の `durationSec` だけを切り出した構造型 | 循環 import を避けるための狭いポートで ctx ではないが、`*Source` という語がこのコードベースに他に無い。優先度低 |

---

## 12. 改名では直らない構造問題(同時に検討)

1. **`StepState` (`simulation/time-step.ts`) は `KinematicState` の部分的な重複型。**
   `adaptiveSimulationMaxStep` の引数を `readonly KinematicState[]` にすれば型ごと消える(§3)。
2. **地球の物理定数 `MU_EARTH` / `R_EARTH` / `R_EARTH_EQ` / `SIDEREAL_DAY` が状態ベクトルのモジュールに同居している。**
   マージ後は `solar-system.ts`(天体レジストリ)が `orbital-state.ts` から `MU_EARTH`/`R_EARTH` を import しており、
   依存が逆を向いている。`kinematic-state.ts` へ改名すると同居の不自然さがさらに際立つ。天体定数の置き場は
   `solar-system.ts` が自然。
3. **`plan.ts` の `orbitPeriodOf` が、周期が求まらないとき `APERIODIC_ARC_DURATION`(区間長の定数)を返す。**
   「周期」を返す関数が周期でない値を返している。`NaN`/`null` を返して、フォールバックは唯一の呼び出し元
   `segmentDurationFrom` 側で当てるのが素直。
4. **`PREDICT_SAMPLES_PER_REV` が履歴(history)の間引きにも使われている**(§4)。
5. **`game-entity.ts` の `import { elementsAround as elementsAroundBody }`** — メソッド名と衝突するための別名。
   §5 の改名後も衝突は残るので、モジュール関数側かメソッド側のどちらかをさらに区別する必要がある。
6. **kebab-case 逸脱**: `render/orbitline.ts` / `render/earthcolor.ts`。
7. **`dynamics.ts` が2責務を持っている** — 汎用 ODE ステッパ(`stepRK4`)と運動方程式の合成(`totalAccel`/`j2Accel`)。
   §4 の改名で名前の上では区別が付くが、モジュール分割まで行うかは別途判断。

---

## 13. 私(hedalu244)が決めること

ここだけ判断してもらえれば、残りは機械的に進められる。

### 13-1. `OrbitState` の新しい名前

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `OrbitState` | `KinematicState`(推奨) | `{t, r, v}` | 力を含まない位置・速度の量なので kinematic が正確(kinetics は力を扱う分野) |
| `OrbitState` | `StateVector` | 同上 | astrodynamics の定訳は state vector。ただし定訳の state vector は時刻を含まないので `t` を持つ点が外れる |
| `OrbitState` | `MotionState` | 同上 | 短く、専門語を要求しない。ただし他分野の語との衝突が広い |

> 補足: 「現 `OrbitState` こそ `DynamicTrajectory` と名付けるべきでは」という指摘について。
> `OrbitState` は `{t, r, v}` 1点で、列も履歴も持っていない。「積分で伸ばす軌跡」に当たるのは `OrbitEntity`
> (`physics/orbit-entity.ts`)の方で、そちらを §4 で `DynamicTrajectory` としている。
> **`OrbitState` を指して言っていたのであれば、この対応を入れ替える必要があるので指摘してほしい。**

### 13-2. `orbit` と `orbital` をどう決着させるか

現状 `orbital` が付いているのは `OrbitalAxes` / `orbitalAxes` / `fromOrbitalAxes` / `syncOrbitalDirections` と
ファイル名 `orbital-state.ts` の5つだけで、**使い分けの意図は無い**(全て `orbit` 族の同じ意味)。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `orbital*` と `orbit*` の混在 | 全て `orbit` に統一(`OrbitAxes` / `OrbitElements`) | 解析軌道に関する語 | 規則が1行で書け、例外の判定が要らない。ただし `orbital elements` / `orbital axes` という定訳から外れる |
| 同上 | 形容詞は `orbital`、名詞連結は `orbit`(`OrbitalElements` / `orbitalAxes` / `OrbitLine`) | 同上 | 英語として自然。ただしどちらを使うかの判定が語感依存になり、規則として弱い |
| 同上 | 原則 `orbit`、定訳のある複合語だけ `orbital` を許し例外を列挙して固定(`OrbitalElements` / `orbitalAxes` の2語のみ) | 同上 | 定訳を守りつつ例外が有限。ただし「例外表を維持する」というコストが残る |

### 13-3. `dynamic` 族の語をどう付けるか

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `OrbitEntity` | `DynamicTrajectory` | 積分で前進する時刻付き状態 + 間引いた履歴列 | 族の語を接頭に出す。`dynamics.ts` / `stepDynamics` と語が揃う |
| `OrbitEntity` | `Trajectory` | 同上 | `PlanTrajectory → PlanPath` の後は衝突しないので接頭辞なしでも一意。短い。ただし族の規則が名前から見えない |

あわせて、`PlanPath` の `path` と `DynamicTrajectory` の `trajectory` が「軌跡」を指す2語として残る点も
併せて判断してほしい(`PlanArc`/`PlanPath` の対を優先するなら現案のまま)。

### 13-4. 天体を `body` のままにするか `Entity` に寄せるか

「天体は `GameEntity` の類語ではないか」という指摘について、現状を調べた結果を先に示す。
**3つは今のところ別物で、`Entity` 一語で括れる状態にはない。**

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `GameEntity` | 据え置き | メッシュ + HP + 姿勢 + 積分軌跡(`DynamicTrajectory`)。重力を及ぼさない | 位置の正本を自分で持つ |
| `Attractor` | 据え置き | μ + 半径 + その時刻の状態。重力を及ぼす | 値であってオブジェクトではない。`Ephemeris` が時刻ごとに作る |
| `CelestialBody`(game 側) | §13-4 の選択肢次第 | メッシュだけ。**位置・速度を一切持たず**、sync のたびに `Ephemeris` から引く | 状態を持たない点で `GameEntity` と決定的に違う |

選択肢:

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `CelestialBody` 系 | **(a) 据え置き + 規則化**(推奨) | 天体の見た目 | 「`body` 単独は機体座標系専用、天体は必ず `celestial` を接頭」という規則だけ足す。改名コスト最小で衝突は消える |
| `CelestialBody` 系 | (b) `CelestialView` / `EarthView` / `SunView` / `SphereView` | 同上 | 「見た目しか持たない」実装に忠実。ただし `ViewId`(combat/map/dock) / `ViewManager` / `DockView` / `Viewpoint` と `View` が既に「画面のモード」を指しており、新しい衝突を作る |
| `CelestialBody` 系 | (c) `CelestialEntity` | 同上 | Step3(小惑星 = 積分軌道 + アトラクター)で `EntityManager` と `Ephemeris` を統合する布石になる。ただし**今は状態を持たないので `Entity` は実装に対して嘘**で、統合を先に済ませないと名前だけが先行する |

推奨は **(a) を今やり、(c) は `better_simulation_todo.md` の Step3(構造の統一)と同じ変更セットで再検討** する。

### 13-5. 天体表面到達(`hitsAnySurface`)の語

実装は `len(r − 天体位置) < 天体半径 + margin`。「衝突判定」ではなく「内側にいるか」の距離比較。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `hitsAnySurface` | `belowAnySurface`(推奨) | 位置がいずれかの天体の表面 + margin より内側か | 「表面より下」は高度の語彙で、margin を再突入高度として渡す実際の使い方と読みが合う |
| `hitsAnySurface` | `insideAnyBody` | 同上 | 実装(半径との距離比較)そのままで最も直訳的。ただし `body` を天体の意味で使うことになり §7 の規則と衝突する |
| `hitsAnySurface` | `reachedAnySurface` | 同上 | 「到達した」= 再突入・地表衝突という結果側を表す。ただし margin > 0 のとき「まだ表面には達していない」ので厳密には嘘 |

### 13-6. `Manager` / `System` / `Physics` 接尾辞

「所有して毎フレーム駆動するもの」の接尾辞が4系統ある。`Manager` と `System` はどちらも中身を説明していない。

- `*Manager`: `EntityManager` `MarkerManager` `UnlockManager` `SaveManager` `DisplayTimeManager` `SimSpeedManager` `FlashEffectManager` `ViewManager`
- `*System`: `CameraSystem` `CombatCameraSystem` `HitSystem` `EffectsSystem` `PowerSystem` `RadiatorSystem` `ThermalSystem`
- `*Physics`: `CollisionPhysics` `BeltPhysics`
- 動作主体名: `Simulator` `Predictor` `Targeter` `MapPicker` `Docking`

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| 4系統の混在 | **一括改名しない。「今後 `Manager`/`System` を新設しない」規則にとどめる**(推奨) | 毎フレーム駆動される所有者 | 置換範囲が広く挙動と無関係。既存を動かす価値が改名コストに見合わない |
| 同上 | 動作主体名(`-er`)へ寄せる | 同上 | 語が説明的になる。ただし `EntityManager` → `EntityHolder` など、うまい名前にならないものが残る |

### 13-7. 未使用の `physics/nbody/` をどうするか

`physics/nbody/` は `CLAUDE.md` に「LEO ゲームでは未使用、cislunar フェーズ用に温存」と明記された実質デッドコードだが、
**名前空間は占有し続けている。** 今回の提案と2箇所でぶつかる。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `nbody/integrator.ts` の `stepRK4` | (下記のいずれか) | `Body[]` を丸ごと1ステップ進める N 体 RK4 | §4 で `stepOrbitRK4` を `stepRK4` にしたいが、この export と衝突する |
| `nbody/bodies.ts` の `Body` / `bodies` | (下記のいずれか) | mass/position/velocity だけの簡易 N 体モデル。`Attractor` とは無関係の別型 | §7 で `body` を機体座標系専用にする規則と衝突する |

選択肢:

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `physics/nbody/` | (a) 削除する | どこからも import されていない試作 | Step2 のマージで重力源モデルが全面的に作り直された今、この試作をそのまま使う見込みは薄い。消せば衝突が2つとも消える |
| `physics/nbody/` | (b) 残したまま `stepOrbitRK4` → `stepStateRK4` にする(推奨) | 同上 | 温存の判断を今変えずに済む。`stepStateRK4` は「状態を1つ進める」で `stepDynamics` とも並ぶ |
| `physics/nbody/` | (c) 残して nbody 側を改名する | 同上 | 使っていないコードのために現役コードの名前を曲げない、という筋は通る。ただしデッドコードに改名コストを払うことになる |

### 13-8. `Frame` 自体は据え置きでよいか

「アニメーションの1フレームと座標系の frame の衝突は慣用で仕方ない」という判断に従い、`Frame` は据え置き案にしている。
`ReferenceFrame` へ改名すると `FrameTransform` / `FramePoint` / `FrameDir` / `FrameOrbitState` / `FrameRotation` /
`FRAMES` / `INERTIAL_FRAME` / `frameTransformAt` まで連鎖するので、判断は先に固めたい。

### 13-9. その他、判断が要りそうな点

- **§12-2 天体定数の置き場**: `MU_EARTH`/`R_EARTH` を `kinematic-state.ts` から `solar-system.ts` へ移すか。
  移すと `orbital-state.ts` は純粋に「状態ベクトルとその幾何」だけになる。
- **§12-3 `orbitPeriodOf` の非周期フォールバック**: `NaN` を返して呼び出し元で当てる形に変えるか。
- **§12-5 `elementsAround` の別名衝突**: モジュール関数とメソッドのどちらを区別するか
  (例: メソッド側を `orbitElementsAroundCached` にする / モジュール関数側を `orbitElementsOf` にする)。
- **§12-7 `dynamics.ts` の分割**: 汎用 ODE ステッパと運動方程式の合成をファイルごと分けるか、名前だけで区別するか。

---

## 14. 適用順序の提案

挙動を変えない純粋な改名なので、**族ごとに1変更セット**で区切り、各セットで
`npm run typecheck` + `npm run test:physics` を通す。

1. **§9 `ViewFrame` → `Viewpoint`** — 独立性が高く、`frame` 語の混雑が一番大きく減る(27箇所)。
2. **§7 `body` → `attractor` / `center`、§11 の `PlanetBody` / `bodyDef`** — 型は変わらず変数名だけ。機械的で安全。
3. **§8 `hit` の4義の分離** — (2)(3)(4)(5) を動かし、(1) は触らない。
4. **§3 `OrbitState` → `KinematicState`** — 最大(219箇所)だが単純置換。`StepState` の削除(§12-1)も同時に。
5. **§5 `Elements` → `OrbitElements`、§3 の `orbital*` → `orbit*`** — `orbit` 族の確定。
6. **§4 `OrbitEntity` → `DynamicTrajectory` と `PlanTrajectory` → `PlanPath`** — 名前が入れ替わるので必ず同一セットで。
7. **§6-2 `libration` → `lagrange`、`LibrationPoint` → `CollinearPoint`。**
8. **§12 の構造問題** — 改名ではないので最後に個別に。

各セットで守ること(`/refactor` の改名規則):

- 旧名が 0 件になるまで消す。`grep -rn "<旧名>" src tests DEVELOP CLAUDE.md .claude memos`(`tests/dist` はビルド出力なので除外)
- 「旧」「former」「(旧 xxx)」の類をコード・文書に書かない。互換エイリアスも残さない。
- `CLAUDE.md` / `DEVELOP/CALLSTACK.md` / `DEVELOP/OWNERSHIP.md` / `DEVELOP/SPEC.md` を同じ変更セットで更新する。
  特に `CLAUDE.md` の Architecture 節と `test:physics` の説明文には旧名が大量に入っている。

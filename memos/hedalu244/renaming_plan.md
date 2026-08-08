# 命名体系の整理案

`origin/main`(重力源を恒星/惑星/衛星の解析軌道モデルへ再構成した版)をマージした後のコードに対する提案。
まだ**提案**であり、実施していない。

表はすべて `| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |` の4列で統一する。
`現在` の括弧内は `src` + `tests/physics` + `DEVELOP` + `CLAUDE.md` に対する grep 一致行数(改名コスト目安)。

**判断はすべて済んでいる。** 各節の「案」欄が確定内容で、あとは §13 の順序で機械的に進められる。

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

### 1-1. `orbit` と `orbital` — `orbit` に統一し、例外は `OrbitalElements` の1語だけ

`orbital` は `orbit` の形容詞形であって別の語ではなく、意味の使い分けも無い。

- **`orbital` への統一は不可能。** `orbit` が名詞そのもの/前置詞の目的語になっている用法が約90箇所あり、
  そこは `orbital` にすると英語として成立しない: `KeplerOrbit`(+`keplerOrbitState`/`Rotation`/`Normal`/`Of`)、
  `PlanetOrbit` / `SatelliteOrbit` / `moonOrbit`、`positionOnOrbit` / `velocityOnOrbit`。
- **`orbit` への統一で定訳から外れるのは `orbital elements` の1語だけ。** 現存する `orbital*` 識別子は
  `orbitalAxes` / `fromOrbitalAxes` / `OrbitalAxes` / `syncOrbitalDirections` の4つで、この基底の定訳は
  RTN / LVLH 系であって "orbital axes" ではない。逆に定訳が `orbital` 側にある `orbital period` /
  `orbital plane` は、既に `localOrbitPeriod` / `orbitPlaneBasis` と `orbit` 側で書かれている。

したがって**語形は `orbit` に統一**し、`OrbitalElements`(§5)だけを定訳のための例外として固定する。
例外が1語なら列挙して覚えられるので、判定は要らない。

**あわせて `Axes` / `Directions` の重複も解消する。** `syncOrbitalDirections` は `orbitAxes` が返す3軸を
± に展開して6個のマーカーを置く関数で、`Axes` と `Directions` は同じ基底を指す2語。`syncOrbitAxes` に寄せる
(所有クラスが `PlayerMarkers` で兄弟が `syncBoresight` なので、`Marker` 接尾辞は付けない)。
なお `elements.ts` の module-private `orbitPlaneBasis` は近点方向 `pHat`/`qHat` の**近点基底**(perifocal)で、
`orbitAxes` の pro/nrm/radOut とは別の基底 — 類義語ではないので据え置く。

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
| `OrbitState` (219) | `KinematicState` | `{t, r, v}`。時刻付きの位置・速度だけを持つ不変値(`__frame:'inertial'` ブランド付き) | 軌道の情報をゼロ個も持たない。弾・薬莢・カメラ補間にも使う汎用の運動学量で、どの族にも属さない。力を含まない位置・速度の量なので kinematic が正確(kinetics は力を扱う分野) |
| `orbitState(t,r,v)` (115) | `kinematicState(...)` | 上記を組み立てる唯一の入口 | |
| `physics/orbital-state.ts` | `physics/kinematic-state.ts` | 上記の型 + 軌道基底 + エルミート補間 | 地球定数と `earthAltitudeOf` は `solar-system.ts` へ移すので(§12-2)、残るのは状態ベクトルとその幾何だけになる |
| `FrameOrbitState` (8) | `FrameKinematicState` | 座標系相対の r/v(時刻を持たない) | `OrbitState` と連動。`orbit` が付いている理由が無い |
| `frameOrbitState(r,v)` | `frameKinematicState(...)` | 上記を組み立てる入口 | |
| `StepState` (`simulation/time-step.ts`) | **削除** | `adaptiveSimulationMaxStep` の引数用に r/v だけを写した構造型 | `KinematicState` の部分的な重複型。引数を `readonly KinematicState[]` にすれば型ごと消える(§12-1) |
| `OrbitalAxes` / `orbitalAxes` / `fromOrbitalAxes` (29) | `OrbitAxes` / `orbitAxes` / `fromOrbitAxes` | 状態から定まる接触軌道の基底(pro/nrm/radOut) | 解析軌道の基底なので `orbit` 族で正しいが、語形は `orbit` に統一する(§1-1)。この基底の定訳は RTN / LVLH 系で "orbital axes" ではないので、例外にする理由が無い |
| `PlayerMarkers.syncOrbitalDirections` | `syncOrbitAxes` | `orbitAxes` の3軸を ± に展開した6方向マーカーの配置 | 語形の統一に加えて、`Axes` と `Directions` が同じ基底を指す2語になっているのを解消する(§1-1) |
| `altitudeOf(r)` (4) | `earthAltitudeOf(r)`、置き場は `solar-system.ts` へ | `len(r) - R_EARTH`。地球専用 | 名前が汎用なのに中身は地球固定。全天体対応の表面判定(§8)と紛れる。`R_EARTH` と同じ場所に置く(§12-2) |

---

## 4. 積分系(`dynamic` 族)

`OrbitEntity` の責務は「時刻付き状態を1つ保持し、1歩進め、間引いた列を持ち、任意時刻を引く」。
これは**軌跡そのもの**であって entity ではなく、`GameEntity` と語が衝突している。
`PlanArc` がこれを `entity` という名前のフィールドで持っているのは端的に嘘。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `OrbitEntity` (45) | `DynamicTrajectory` | 1つの状態 + 間引いた履歴列。`stepDynamicsRK4` で前進し、任意時刻を補間で引ける | 積分に限定された型なので `dynamic` 族。`GameEntity` との語衝突も解消。**実装が `stepDynamicsRK4` を呼んでいる**以上、族語を外した素の `Trajectory` にはできない(記録だけをする実装になれば `Trajectory` でよい) |
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
| `stepOrbitRK4` (18) | `stepRK4` | 加速度コールバックを受けるだけの汎用 ODE ステッパ | 軌道と無関係。どの族にも属さないので族語を外す。同名を export していた `physics/nbody/integrator.ts` は削除する(§12-8)ので、素の `stepRK4` が使える |
| `stepDynamicsRK4` (22) | `stepDynamics` | 全天体重力 + J2 + 抗力 + 推力の1ステップ | すでに `dynamic` 族。RK4 は実装手段なので名前から外す(`stepRK4` の方はそれ自体が正体) |
| `dynamics.ts` の private `accel` | `totalAccel` | `attractorAccel` + `j2Accel` + `dragAccel` の合成 | 合成であることを名前に出す |
| `physics/dynamics.ts` | **据え置き** | 上記一式 | 前版の `propagation.ts` 案は撤回。`dynamic` を C 族の語に採るのでこのファイル名が族の中心になる |
| `DebugHistoryLine` (6) | `DebugTrajectoryLine` | 追跡対象の過去列 + 予測列を1本ずつ描くデバッグ表示 | 過去列(history)だけでなく予測列も描いている |
| `PREDICT_SAMPLES_PER_REV` (8) | `TRAJECTORY_SAMPLES_PER_REV` | 履歴・予測どちらの間引き間隔にも使う1周回あたりサンプル数 | `game-entity.ts` の履歴側でも読んでおり predict 専用ではない(§12-4) |

### 計画側は `path`、積分側は `trajectory` に分ける

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `PlanTrajectory` (21) | `PlanPath` | 複数の `PlanArc` を繋いだ計画折れ線の合成表示 | `trajectory` を `DynamicTrajectory` 側に使うため。`PlanArc`/`PlanPath` の対は自然 |
| `plan-trajectory.ts` | `plan-path.ts` | 同上 | |
| `PlanDisplay.traj` | `path` | 上記への参照 | 略記をやめる |
| `PlanDisplay.trajectoryFrame` | `planFrame` | 計画折れ線を描く座標系(カメラの座標系とは独立に選ぶ) | 「計画の座標系」であってカメラの座標系ではないことを名前に出す |

改名後に `path`(計画した経路)と `trajectory`(積分した軌跡)が「軌跡」を指す2語として残るが、
**この2つは概念として大きく違うので共存して問題ない** — 語の分割がそのまま概念の区別になっている。

UI ラベルの `TRAJECTORY` は人間向け表示なので据え置いてよい。

---

## 5. 解析軌道系(`orbit` 族)

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `Elements` (52) | `OrbitalElements` | 中心天体つきの古典軌道要素(a/e/inc/raan/argp/nu + center) | 族の中心型なのに接辞が無い。`Elements` 単独では何の要素か分からない。`orbit` 統一の唯一の例外で、定訳 `orbital elements` を採る(§1-1) |
| `elementsFromState(rel, center)` | `orbitalElementsFromState` | 中心相対の状態 → 要素 | |
| `elementsAround(s, body)` (64) | `orbitalElementsOf(s, center)` | 絶対 ECI 状態 + 中心天体 → 要素 | 第2引数の名前は §7。メソッド側と名前を分けて別名 import をなくす(§12-5) |
| `GameEntity.elementsAround(body)` | `orbitalElementsAround(center)` | 同上のメモ化版 | モジュール関数が `orbitalElementsOf` になるので衝突しない(§12-5) |
| `stateFromElements` | `stateFromOrbitalElements` | 要素 → 中心相対の状態 | |
| `positionFromElements` | `positionFromOrbitalElements` | 要素 → 中心相対の位置 | |
| `orbitClose` (`plan-guide.ts`) | `orbitalElementsClose` | 2つの `OrbitalElements` が許容差内で一致するか | 比べているのは要素であって軌道そのものではない |
| `OrbitLine` | 据え置き | `Elements` から解析的に生成した楕円の描画 | `orbit` を解析軌道専用にすると、この名前は初めて正しくなる |
| `render/orbitline.ts` | `render/orbit-line.ts` | 同上 | 他が全て kebab-case(§12-6) |
| `localOrbitPeriod` / `keplerPeriod` / `positionOnOrbit` / `velocityOnOrbit` / `trueAnomalyAt` / `tofBetween` / `timeSincePeriapsis` / `apsisAltitudes` / `KeplerOrbit` / `keplerOrbitState` / `keplerOrbitNormal` | 据え置き | 解析軌道の数学そのもの | すでに族の語で正しい |
| `plan.ts` の `orbitPeriodOf` (12) | 据え置き(非周期のとき `NaN` を返すよう変更、§12-3) | 起点状態を最も強く引く天体まわりの公転周期 | マージで `segmentDurationFrom` が「区間長」を引き取ったので、この関数は本当に周期を返すようになった。前版の `arcDurationOf` 案は撤回 |

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

現在 `body` は6つの意味を持っている。**規則は「無標の `body` は天体の意味に残し、機体座標系の方を
`ship` で有標にする」の1点。** 天文・物理シミュレーションで無標の `body` が機体座標系に奪われるのは苦しく、
避けるべきは機体の側。機体には既に `Ship` 型があり、機体座標系を考えるのは `Ship` の継承先
(`Player` / `Enemy`)だけなので、そちらを有標にしても意味が狭まらない。

加えて **`Attractor` 型の変数は型名と一致させて `attractor` / `attractors` にする。** これは
「天体」の語を避ける話ではなく、その値が重力源という役割で渡されていることを名前に出す話。

したがって改名するのは (1)(2)(3)(4) と (5) のうち `AttractorId` を持つもの、据え置きは (6) と
(5) のピック種別。

1. **`Attractor` 型の変数名(43箇所)** — `attractor.ts` 全体(`attractorAccel(r, body)` / `strongestAttractor(r, bodies)` / `frameOfAttractor(body)` / `elementsAround(s, body)` / `hitsAnySurface(r, bodies, ...)`)、`dynamics.ts` の `accel(..., bodies, ...)`、`orbit-entity.ts` / `game-entity.ts` / `predictor.ts` / `plan-arc.ts`(`sizingBodies` を含む) / `plan.ts` / `plan-guide.ts` / `plan-display.ts` / `enemy.ts` / `bullet.ts` / `debris-piece.ts` / `player.ts` / `ship.ts`(未使用の `_bodies`) / `entity-manager.ts` / `targeter.ts` / `hud/panel.ts` / `stage00.ts` / `creative-stage.ts` の各引数・ローカル
2. **機体座標系** — `radiator.ts` の `bodyNormal` / `bodyOffset`、`belt-physics.ts` の `prevBodyW` / `aThrustBody`、`player-throttle.ts` の `axisBody`、コメントの「機体座標系」
3. **DOM のパネル本体** — `plan-editor.ts` の `planBody`、`hud/panel.ts` / `hud/dock-view.ts` / `object-list-panel.ts` の `body`、`document.body`
4. **中心天体の半径など天体の属性** — `elements.ts` / `creative-stage.ts` / `creative/placement-validation.ts` の `bodyRadius`
5. **天体を指す UI・種別の語** — `ship-placer-panel.ts` の `ReferenceBody`(= `AttractorId`) / `BODY_ITEMS` / `bodyValue` / `ShipPlacerForm.body`、`map-pick.ts` の `MapPickKind` の `'body'` と `map-picker.ts` の `runBodyShip`
6. **天体そのもの(マージで増えた)** — `solar-system.ts` の `bodyDef` / `CelestialBodyDef`、`game/celestial/` の `CelestialBody` / `EarthBody` / `SunBody` / `PlanetBody`

未使用の `physics/nbody/` が `Attractor` と無関係な独自の `Body` interface と `bodies` を持っているが、
これは削除する(§12-8)ので規則の対象外。

**(1) と (6) が同じ変数名で衝突している箇所が実在する:** `game/celestial/environment-scene.ts` の
`private readonly bodies: readonly CelestialBody[]` と `for (const body of this.bodies)` は、
コードベース中で唯一 `bodies`/`body` が `Attractor` ではなく `CelestialBody` を指すファイルになっている。
(1) を `attractors` へ動かせば `bodies` が `Attractor[]` を指す箇所は0件になり、この衝突は消える。

**残る懸念は剛体一般(デブリ・薬莢)の body frame。** 姿勢積分は `physics/attitude.ts` が全エンティティに
対して行っており、そこでの機体固定座標系は `Ship` に限らない。ただし現在この意味の識別子は
`game/player/` の5つだけで、`physics/attitude.ts` は `body` を識別子に使っていないので、`ship` への
改名と衝突しない。physics/ 側で剛体固定座標系に名前が要るようになったら、そのとき別途決める
(機体限定ではないので `ship` は使えない)。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `body: Attractor` | `attractor` | 重力を及ぼす天体1つ | 型名と一致させる。渡している役割(重力源)が名前に出る |
| `bodies: readonly Attractor[]` | `attractors` | その時刻の重力源一覧 | 同上。`Ephemeris.attractorsAt` は既にこの語。**これで `bodies` が `Attractor[]` を指す箇所が0件になる** |
| 楕円の中心として渡す `body` (`elementsAround` / `frameOfAttractor`) | `center` | 軌道要素を取る中心天体 | `Elements.center` と一致する。「中心として選ばれた」役割が引数名に出る |
| `bodyRadius` | `centerRadius` | 中心天体の表面半径 | |
| DOM の `bodyState` / `bodyNode` / `bodyArr` | `panelBody` 系 | パネルの本体要素 | |
| 機体座標系の `bodyNormal` / `bodyOffset` / `prevBodyW` / `aThrustBody` / `axisBody` | `shipNormal` / `shipOffset` / `prevShipW` / `aThrustShip` / `axisShip` | 機体に固定した座標系 | 無標の `body` を天体に残すため、機体側を有標にする。該当5識別子はすべて `game/player/` にあり、機体座標系を考えるのは `Ship` の継承先だけなので `ship` で意味が狭まらない |
| `bodyDef(id)` (32) | **据え置き** | id から `CelestialBodyDef` を引く | 無標の `body` は天体の意味なので規則どおり |
| `EnvironmentScene.bodies` / `for (const body of ...)` | **据え置き** | 見た目クラス `CelestialBody` の配列 | `Attractor[]` 側が `attractors` になるので、同名で別の型を指す状態が解消される |
| `ReferenceBody` / `BODY_ITEMS` / `bodyValue` / `ShipPlacerForm.body` | `ReferenceAttractor` / `ATTRACTOR_ITEMS` / `attractorValue` / `.attractor` | 基準天体を id で選ぶ UI | 型の実体は `AttractorId`。天体の語を避けるためではなく、型名と一致させるための改名 |
| `MapPickKind` の `'body'` / `runBodyShip` | **据え置き** | 天体ラベルというピック種別 | `'ship'` と並ぶ種別名として、無標の `body` = 天体で読める |
| `PlanetBody` (7) | `SphereBody` | 「テクスチャ球 + 表示距離圧縮」で済む天体の見た目 | **`new PlanetBody('moon', ...)` と、衛星に対して使われている。** physics 側が `PlanetId`/`SatelliteId` を厳密に分けているのと直接矛盾する(§11-1) |
| `CELESTIAL_VIEWS` | `CELESTIAL_BODIES` | id → {表示名, `CelestialBody` の生成関数} | 値が `CelestialBody` を作るのに record が `VIEWS`。クラス側を `*Body` で据え置くので、record 名をそちらに揃える |
| `CelestialBody` / `EarthBody` / `SunBody` (17) | **据え置き** | 天体1つぶんの見た目。位置は持たず Ephemeris から毎 sync 引く | 機体座標系が `ship` へ退くので、`body` を天体の意味で使うこれらは規則どおり(§7-1) |

### 7-1. 天体を `Entity` に寄せない理由

「天体は `GameEntity` の類語ではないか」という点について、**3つは今のところ別物で、`Entity` 一語で括れる
状態にはない。** 位置の正本を誰が持つかが違う。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `GameEntity` | 据え置き | メッシュ + HP + 姿勢 + 積分軌跡(`DynamicTrajectory`)。重力を及ぼさない | 位置の正本を自分で持つ |
| `Attractor` | 据え置き | μ + 半径 + その時刻の状態。重力を及ぼす | 値であってオブジェクトではない。`Ephemeris` が時刻ごとに作る |
| `CelestialBody`(game 側) | 据え置き | メッシュだけ。**位置・速度を一切持たず**、sync のたびに `Ephemeris` から引く | 状態を持たない点で `GameEntity` と決定的に違う |

したがって `CelestialEntity` は**今は実装に対して嘘**になる。`CelestialView` 系へ寄せる案も
`ViewId`(combat/map/dock) / `ViewManager` / `DockView` / `Viewpoint` の `View` と新しい衝突を作るので採らない。
上の規則(機体座標系を `ship` へ、`Attractor` 変数を `attractor` へ)だけで `body` の衝突は消えるので、それで足りる。

`Entity` へ寄せるかは `better_simulation_todo.md` の Step3(積分軌道の物体と解析軌道の天体を統一的に扱う
枠組み)を済ませた時点で再検討する — 統一が済めば `CelestialBody` は状態を持つようになり、そのとき初めて
`Entity` が実装に合う。名前だけ先に動かすことはしない。

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

**`hit` と `collision` の使い分けそのものは今回動かさない。** (実体)弾との接触・剛体同士の接触・
天体との接触は現状それぞれ別の実装だが、`feature_todo.md`「衝突判定の統一化」のとおり将来ひとつの
実装へ統合する予定で、統合すれば語の割り当ても変わる。実装より先に名前だけ動かさない。

**今回行うのは `hitsAnySurface` の改名1件のみ。** `Any` が嘘であること(任意の面ではなく、
天体を中心とした球面の内側かどうかの判定)は統合を待つ理由がないので先に直す。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `hitsAnySurface(r, bodies, margin)` (20) | `hitCelestialBody(r, attractors, margin)` | 位置がいずれかの天体の半径 + margin より内側にあるか | `Any` が嘘。判定対象は任意の面ではなく天体を中心とした球面。`celestial body` は天体の定訳。`CelestialSphere` は天球(`render/celestial-grid.ts`)の定訳で意味が正反対になるため採らない |
| (1) の各識別子 | **保留** | 弾丸の命中・被弾 | 接触判定の統合まで動かさない |
| `SweptSphereHit` (2) / `collision.ts` の `const hit` | **保留** | 接触時刻(toi)と接触法線 / その戻り値 | 同上 |
| `sweptSphereToi` (9) | 据え置き | 最初に表面が触れる時刻の割合 | 返す値が toi そのものなので名前は正しい |
| `nav-target.ts` / `plan-editor.ts` / `targeter.ts` の `const hit` (4) | **保留** | `pickNearest` / `nearestSample` が返した被選択物 | 接触の語ではないが、`hit` 全体を1度に見直したいので同時に判断する |
| `enemy.ts` の `timeToHit` (5) | **保留** | `solveLeadTime` が返した先読み時間 | 同上 |
| `Sfx.hit()` / `Sfx.enemyHit()` | **保留** | 自機被弾音 / 敵被弾音 | 同上 |

---

## 9. `frame` の多重定義

アニメーションの1フレームと紛れるのは**単体の `Frame` だけ**なので、そこだけを直す。
座標系でないもの(`ViewFrame`)を `frame` 語から外し、座標系そのものである `Frame` は `ReferenceFrame` にする。
`Frame*` の派生名は接頭辞が付いている時点で曖昧でないので、連鎖させない。

| 現在 | 案 | 今の実装で表しているもの | 提案の理由 |
|---|---|---|---|
| `ViewFrame` (27) | `Viewpoint` | カメラの視点パラメータ(位置/注視点/up/fov/aspect) | 座標系ではない。これだけで `frame` の意味が1つ減る |
| `camera.view` (各カメラ) | `camera.viewpoint` | 上記のフィールド | |
| `syncCameraToViewFrame` | `syncCameraToViewpoint` | `Viewpoint` を `THREE.PerspectiveCamera` へ反映 | |
| `lerpViewFrameFov` | `lerpViewpointFov` | fovDeg だけを指数的に近づける | |
| `projectionFromView` | `projectionFromViewpoint` | `Viewpoint` から `ProjectFn` を作る | |
| `Frame` (`physics/frame.ts`) (49) | `ReferenceFrame` | 表示用座標系 `{center, rotatingWith}` | アニメーションの1フレームと紛れるのは単体の `Frame` だけ。定訳の `reference frame` を採る |
| `FrameTransform` / `FrameRotation` / `FramePoint` / `FrameDir` / `FRAMES` / `INERTIAL_FRAME` / `frameTransformAt` | 据え置き | 座標系の剛体運動とその回転成分、座標系相対の点・方向、座標系の一覧 | **`Frame` の改名を連鎖させない。** `Frame` が接頭辞として付いている限り1フレームとは読めず、曖昧でない。`FrameTransform`/`FrameRotation` は後者が前者の部分であることが名前から読めないが、置き場所(`kepler-orbit.ts` / `frame.ts`)が違うので実害は小さい |
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
| `CELESTIAL_VIEWS` | `CELESTIAL_BODIES` | id → {表示名, `CelestialBody` の生成関数} | 生成物の型と record 名が食い違っている。クラス側は `*Body` で据え置くので record を揃える(§7-1) |
| `FrameOrbitState` (8) | `FrameKinematicState` | 座標系相対の r/v | §3 と連動 |
| `Ephemeris.orbitRotationAt` | `orbitFrameRotationAt` | その天体の公転軌道に固定した回転基準系の姿勢・角速度 | 現在の名前は「軌道の回転」と読めるが、返すのは座標系の姿勢。`orbitNormalAt`(軌道面法線)は正しいので対にならない。優先度低 |
| `dynamics.ts` 先頭コメントの「ケプラーの二体問題の解析式込み」 | 削除 | — | そのような実装はこのファイルに無い(`elements.ts` にある)。改名ではなくコメントの実装矛盾 |
| `plan.ts` の `DisplayDurationSource` | **据え置き** | `DisplayTimeManager` の `durationSec` だけを切り出した構造型 | `*Source` という語がこのコードベースに他に無いが、問題は構造の側(循環 import を避けるための狭いポート)にあり、改名では解決しない |

---

## 12. 改名では直らない構造問題(同時に検討)

1. **`StepState` (`simulation/time-step.ts`) は `KinematicState` の部分的な重複型。**
   `adaptiveSimulationMaxStep` の引数を `readonly KinematicState[]` にすれば型ごと消える(§3)。
2. **地球の物理定数 `MU_EARTH` / `R_EARTH` / `R_EARTH_EQ` / `SIDEREAL_DAY` を `solar-system.ts` へ移す。**
   現在は状態ベクトルのモジュールに同居していて、天体レジストリである `solar-system.ts` の側が
   `orbital-state.ts` から import している — 依存が逆を向いている。移せば `kinematic-state.ts`(§3)は
   純粋に「状態ベクトルとその幾何」だけになる。
   **`earthAltitudeOf`(§3)も一緒に移す。** `R_EARTH` を読む唯一の関数なので、これだけ残すと
   `kinematic-state.ts` → `solar-system.ts` → `attractor.ts` → `kinematic-state.ts` の循環 import になる
   (`attractor.ts` は `OrbitState` を、`solar-system.ts` は `AttractorId` を import している)。
   src 側の呼び出しは `player.ts` の1箇所だけなので移動コストは小さい。
3. **`plan.ts` の `orbitPeriodOf` は、周期が求まらないとき `NaN` を返す。**
   現在は `APERIODIC_ARC_DURATION`(区間長の定数)を返していて、「周期」を返す関数が周期でない値を返している。
   呼び出しは同じ `plan.ts` の `segmentDurationFrom` 1箇所だけで、その先の `DisplayTimeManager.durationSec` が
   既に `isFinite(referencePeriod) && referencePeriod > 0` で同じフォールバックを持っている — 現状は
   フォールバックが2箇所に重複している。`NaN` を返せば重複が消え、フォールバックは `durationSec` の1箇所に集まる。
4. **`PREDICT_SAMPLES_PER_REV` が履歴(history)の間引きにも使われている**(§4)。
5. **`game-entity.ts` の `import { elementsAround as elementsAroundBody }`** — メソッド名と衝突するための別名。
   モジュール関数側を `orbitalElementsOf`、メソッド側を `orbitalElementsAround` にして名前を分ける(§5)。
   衝突が消えるので別名 import そのものが要らなくなる。
6. **kebab-case 逸脱**: `render/orbitline.ts` / `render/earthcolor.ts`。
7. **`dynamics.ts` は分割しない。** 汎用 ODE ステッパ(`stepRK4`)と運動方程式の合成(`totalAccel`/`j2Accel`)の
   2責務が同居しているが、§4 の改名で名前の上の区別が付くので、ファイル分割まではしない。
8. **`physics/nbody/` を削除する。** `bodies.ts` / `integrator.ts` / `physics.worker.ts` / `README.md` の4ファイルで、
   `src` のどこからも import されていない(唯一の grep 一致は `plan-editor.ts` の `planbody` という別語)。
   Step2 のマージで重力源モデルが全面的に作り直された今、この試作をそのまま使う見込みはない。
   削除で `stepRK4`(§4)の名前衝突が消えるので、**§4 の改名より先に行う。**`Attractor` と無関係な
   `Body`/`bodies` も一緒に消える。
   `CLAUDE.md` の該当箇所(冒頭の N-body worker の記述、`src/physics/nbody/...` の項、Not yet implemented の
   「full N-body cislunar phase」)と `DEVELOP/SPEC.md` の「N体ワーカーは温存」の記述も同じ変更セットで消す。

---

## 13. 適用順序の提案

挙動を変えない純粋な改名なので、**族ごとに1変更セット**で区切り、各セットで
`npm run typecheck` + `npm run test:physics` を通す。

0. **§12-8 `physics/nbody/` の削除** — 改名ではないが、`stepRK4` と `Body`/`bodies` の名前衝突が消えるので最初に行う。
1. **§9 `ViewFrame` → `Viewpoint`、`Frame` → `ReferenceFrame`** — 独立性が高く、`frame` 語の混雑が一番大きく減る(27 + 49箇所)。
   `Frame*` の派生名は動かさないので、`ViewFrame` の置換と干渉しない。
2. **§7 `body` → `attractor` / `center` / `ship`、§11 の `PlanetBody`** — 型は変わらず変数名だけ。機械的で安全。
3. **§8 `hitsAnySurface` → `hitCelestialBody`** — §8 の残りは接触判定の統合まで保留なので、この1件だけ。
4. **§3 `OrbitState` → `KinematicState`** — 最大(219箇所)だが単純置換。`StepState` の削除(§12-1)も同時に。
5. **§5 `Elements` → `OrbitalElements`、§3 の `orbitalAxes` 系 → `orbitAxes` 系(`syncOrbitalDirections` → `syncOrbitAxes` を含む)** — `orbit` 族の語形の確定。
6. **§4 `OrbitEntity` → `DynamicTrajectory` と `PlanTrajectory` → `PlanPath`** — 名前が入れ替わるので必ず同一セットで。
7. **§6-2 `libration` → `lagrange`、`LibrationPoint` → `CollinearPoint`。**
8. **§12 の構造問題** — 改名ではないので最後に個別に。

各セットで守ること(`/refactor` の改名規則):

- 旧名が 0 件になるまで消す。`grep -rn "<旧名>" src tests DEVELOP CLAUDE.md .claude memos`(`tests/dist` はビルド出力なので除外)
- 「旧」「former」「(旧 xxx)」の類をコード・文書に書かない。互換エイリアスも残さない。
- `CLAUDE.md` / `DEVELOP/CALLSTACK.md` / `DEVELOP/OWNERSHIP.md` / `DEVELOP/SPEC.md` を同じ変更セットで更新する。
  特に `CLAUDE.md` の Architecture 節と `test:physics` の説明文には旧名が大量に入っている。

最後に

- ケプラー軌道を表す接辞orbit/orbital、積分軌道を表す接辞dynamic、ケプラー軌道より厳密だが解析的近似ではあるephemeris系の使い分けを恒久ルールとして/refactor-fixedに追記。それ以外のルールについては、今回解消すれば今後は生じにくい逸脱であったか、今回は明確な結論が出ず据え置きの部分を残した問題であるから、/refactor-fixedには追記しない。
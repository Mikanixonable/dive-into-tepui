# 座標は誰が持ち、どこで変換されるのか

**争点A〜E は決着し、2 の形まで実施済み。残っているのは4節の保留3件だけ。**
`refactor_orbit_ephemeris.md` の論点2(キャッシュの持ち主)はここへ引き継いだ。

---

## 0. 方針

- **天体1体が持つのは「自分がどこにいるか」であって、他天体との関係ではない。** 原点は
  **太陽系重心**へ揃える(衛星は主天体相対のまま)。
- **ECI は game 側の都合。** `DynamicSystem` が ECI を採るのは数値精度のため —
  f64 の絶対分解能(`r × 2⁻⁵²`)は日心距離 1.5e11 m で **33 µm**、地心距離 6.8e6 m で
  **1.5 nm** と4桁以上違う。physics/celestial にこの都合を持ち込まない。
- **分担は「個体は `CelestialEntity`、集合は `CelestialSystem`」。** 1体ぶんの ECI 変換は
  個体、変換した結果を集めて配列にするのは系。変換と収集は別の操作。
- **全天体が自分の位置をキャッシュしてよい。** ECI が要るときは「その天体の値」と
  「ECI 原点天体の値」を組み合わせる。**組み合わせるのは変換側の仕事で、天体側ではない。**

---

## 1. いま誰が何の座標を持っているか

**`da3e5724` 時点のコードから引いたスナップショットであり、正本ではない。** 食い違ったら
コードを信じる。

| 持ち主 | 値 | 原点 | キャッシュ |
| --- | --- | --- | --- |
| `StarMotion` | 恒星の位置・速度 | 太陽系重心 | `analyticCache`(`celestial-motion.ts:183`) |
| `PlanetMotion` | 惑星本体の位置・速度 | 太陽系重心 | `analyticCache`(`:380`) |
| `SatelliteMotion` | 惑星相対の位置・速度 | 主天体相対 | `relCache`(`:452`) |
| `SatelliteMotion` | 自分の絶対位置(`:476`) | 太陽系重心 | 無し(**実測で hit 0**。4節下段) |
| `PlanetSystem` | 系の重心の位置・速度 | 主星相対 | `starRelCache`(`planet-system.ts:16`) |
| `PlanetSystem` | 系の重心の絶対位置(`:33`) | 太陽系重心 | 無し(主星の値 + 上の二体解) |
| `EciTransform` | **ECI 原点天体の一式** | 太陽系重心 | `originCache`(`eci-transform.ts:24`) |
| `CelestialEntity` | **自分の ECI 瞬間値**(`CelestialBody`) | ECI | `eciCache`(`celestial-entity.ts:53`) |
| `CelestialSystem` | 天体の集合 | ECI | `allCache`(`celestial-system.ts:88`) |
| `DynamicEntity` | 機体の状態 | ECI | — |
| `FrameAnchors` | 1フレームぶんの天体配列 | ECI | フレーム単位 + 文字列キーの1件メモ(→ 4節) |
| `FloatingOrigin` | 描画原点 | ECI | フレーム単位 |

**向きの量は原点に依らない。** 自転軸・軌道法線・2次重力場の極・大気の共回転軸・姿勢
クォータニオンは、どれも軸だけで決まるので**原点変換の対象ではない**。変換が要るのは
位置と速度、そして加速度だけ。

### 位置が組み上がる順

依存は一方向に流れる。**恒星の重心相対位置は各系の「主星相対」の二体解(1)だけから組むので、
自分の絶対位置を経由せず循環しない。**

1. `PlanetSystem.starRelStateAt` — 系の重心の二体解(主星相対)。主星の位置を経由しない。
2. `StarMotion.analyticStateAt` — 全系の 1 を −Σ(μ_i/μ_total)·r_i で畳んだ、恒星の重心相対位置。
   μ = 0 の系は二体解を解く前に抜ける。
3. `PlanetSystem.analyticStateAt` — 2 + 1。
4. `PlanetMotion.analyticStateAt` — 3 − Σ(μ_衛星/μ_系)·r_衛星(惑星相対)。
5. `SatelliteMotion.analyticStateAt` — 4 + 惑星相対。

### ECI までの2段

```
CelestialEntity.bodyAt(t)                          ← 1体ぶんの ECI 瞬間値。eciCache でメモ化
└─ EciTransform.celestialBodyAt(t, motion)         ← stage 1。平行移動だけ
   ├─ CelestialMotion.analyticStateAt / packedStateAt  (天体の絶対位置)
   └─ EciTransform.originStateAt                    ← ECI 原点天体の一式。originCache。
                                                     供給源を揃える不変条件はここに閉じる

ReferenceFrames.transformAt(frame, t, source)      ← stage 2。その時刻の原点・q・ω を組む
└─ EciTransform.stateAt(t, motion)                 (基準天体の ECI 値)
```

値そのものの変換は、組み上がった `FrameTransform` を受け取る `frame.ts` の純関数群
(`toFrameState` / `toFramePoint` / `toFrameDir` …)が行う。

**供給源(解析暦 / 暦パック)は `FrameTag` が型で守る。** `toEci<F>` が同じ `F` 同士しか
受け付けないので、「パックの天体 + 解析の原点」は型エラーになる。`'primaryRel'` が供給源を
持たないのは意図した設計 — 「絶対 − 絶対は供給源を揃える」が守るべき不変条件であって、
「絶対 + 相対は混ぜてよい」(パックの惑星本体へ解析の相対軌道を足す合成が、そのために要る)。

### キャッシュの実測(太陽系98体)

積分パスは `SubstepCelestialBodies.reset` と `Simulator.atmosphereBodies` の引き方を200
サブステップぶん、表示パスは1フレームぶんの sync を60フレームぶん再現したもの。

| キャッシュ | 積分パス | 表示パス |
| --- | --- | --- |
| `EciTransform.originCache` | **98.8%** | **99.5%** |
| `PlanetMotion.analyticCache` ほか | 86.9% | 91.1% |
| `CelestialEntity.eciCache` | 1.2% | **66.6%** |
| `SatelliteMotion.relCache` | 63.8% | 66.2% |
| `CelestialSystem.allCache` | 0% | 66.7% |

`allCache` が積分パスで当たらないのは、1サブステップにつき1回・毎回違う t で引かれるため。
表示パスでは同じ表示時刻を何度も引くので当たる。

---

## 2. 決着した判断

| | 決めたこと | 理由 |
| --- | --- | --- |
| **A** | 共有の原点は太陽系重心。タグは原点ではなく**供給源**で切る(`'analytic'` / `'packed'`) | 厳密な日心を必要とする天体は1つも無かった。一方 `toEci<F>` が実際に守っていたのは「解析暦とパックを混ぜない」という供給源の不変条件で、タグの名前がそれと食い違っていた |
| **B** | `CelestialBody` は型引数化しない。代わりに**ファクトリ `kinematicState()` の既定を外す** | `CelestialBody` は「ECI 化した `CelestialEntity` のスナップショット」で、原点を選べる型にする意味がない。事故が起きるのは組み立て時なので、そこだけ明示させる。型注釈側の `KinematicState` は ECI の短縮形として残る |
| **C-1** | stage 1 と stage 2 は**別モジュール**にし、直列接続で表す | 平行移動 / 剛体運動、供給源を揃える義務の有無、時刻を持つ / 持たない、と非対称。1つにまとめると危険な組み合わせが型に現れなくなる |
| **C-2** | `ReferenceFrames` は **game/celestial** に置く | `motionsById` は星系の登録天体の索引で、`CelestialSystem` と同じ層に属する。`frame.ts`(渡された `FrameTransform` で変換するだけの純関数群)は physics に残る |
| **D** | 変換器の正本は `CelestialSystem`、1体ぶんの ECI キャッシュは `CelestialEntity`。配り方は参照を結ぶ形 | ECI 変換後を知る必要があるので `CelestialMotion` は落ち、集合化の前である必要があるので `CelestialSystem` は落ちる。ECI 値を引くのは個体の内側の深い場所なので、引数で配ると全経路へ引数を通すことになる |
| **E** | `KinematicState<F>` の `r` / `v` を `FramedVec3<F>` で branded にする | `Vec3` 自体の型引数化は src の 133 ファイル・800 箇所に波及し、位置でない用途(向き・軸・角速度)と混ざるので採らない。`.r` / `.v` の口だけ塞げば済んだ(型検査に出たのは src 全体で6件) |

**`FramedVec3` を素の `Vec3` から作る道具は置かない。** 札の付いた値は `KinematicState` から
取り出したものだけ、という不変条件をそのまま保つため。アフィン和(位置 ± 変位 = 位置)の
途中は素の `Vec3` で書き、名乗り直すのは `kinematicState` を通す。そのぶん `sub(a.r, b.r)` の
ような素のベクトル演算は供給源の違いを見ない — 塞いだのは「札の付いた値を、別の原点を
宣言した場所へ渡せてしまう」漏れ口のほう。

---

## 3. 変換が要る境界

| 境界 | 何から何へ | なぜ |
| --- | --- | --- |
| `EciTransform`(stage 1) | 太陽系重心 → ECI | f64 の絶対分解能(33 µm → 1.5 nm) |
| `FloatingOrigin`(scene) | ECI → 描画原点 | f32 の桁落ち回避 |
| `ReferenceFrames` / `frame.ts`(stage 2) | ECI → 参照フレーム相対 | 表示上の座標系 |
| `icrfToGameEci`(`packed-absolute-ephemeris.ts:52`) | ICRF 軸 → ゲーム固定軸 | 軸の統一(原点変換とは別) |

**この4つ以外に座標変換は無い。**`da3e5724` 時点で `toEci`(`kinematic-state.ts`)を呼ぶのは
`eci-transform.ts` の1モジュールだけ、`icrfToGameEci` を呼ぶのは暦パックの復号だけ。

---

## 4. 保留(別作業)

### `FrameAnchors` の文字列キー

`FrameAnchors.attractorOf`(`src/game/frame-anchors.ts:52-59`)はフレーム番号・id・時刻を
繋いだ**文字列キー**で直近1件を憶える — 毎フレーム走る経路に文字列生成が入っている。
**まず実測**し、効いていてなお重いならもっといい持ち方を探して差し替える。効いていなければ消す。

### なぜ `CelestialBody`(スナップショット)が要るのか

争点B は「スナップショットである」ことを前提に型の守り方を決めただけで、**そもそも凍結した
値を配る必要があるのか**は別の問い。ここから疑うと変更が大規模になるので、別作業にする。

いま凍結している理由(コードから):

- **積分の各段で暦を引き直さないため。** `attractorAccel`(`celestial-body.ts:78`)と
  `dynamics.ts:131` は、スナップショットの `state.t` と `accel` から
  `celestialBodyPositionAt` で**その段の時刻へ2次外挿**する。凍結をやめると
  「天体数 × RK4 の段数」だけ暦の評価が走る。
- **1サブステップぶん配るため。** `SubstepCelestialBodies.reset`
  (`substep-celestial-bodies.ts:21`)が重力源・表面・大気の3組を区間の中で1組だけ組み、
  多数の個体がそれを共有する。

つまりスナップショットは「1時刻で凍結し、近傍時刻へ安く外挿できる形」であって、
**天体1体が自分で答えられること**とは別の要求。疑うなら、この2つの要求を別の形で
満たせるかから始める。

### `SatelliteMotion` の絶対位置にキャッシュを置くか(**実測: 置かない**)

当初は「変換器が引く回数が増えるので畳む」と見ていたが、試しに `TimeRing` を置いて測ると
**積分パス 18000 ミス / 表示パス 3000 ミスで hit 0**。`EciTransform` はこれを
(天体, t)あたりちょうど1回しか引かないので、置けば純粋な足枷になる。**再検討するなら、
引き方が変わって同じ t が複数回来るようになったときだけ。**

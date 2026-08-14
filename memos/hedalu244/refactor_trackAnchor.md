# ノードの無い計画の起点をどこから出すか(残件)

`Plan` の内部は `{ anchor, nodes } | null` で、`null` ⟺ ノード0件を `Plan` 自身が保つ。
ノードが1件も無いあいだの起点は `Plan.anchorOr(fallback)` が借り先を受け取って解決し、
`PlanEditor.displayedPlan` が `plan.displayData(ship.state)` として毎フレーム渡す。

残っているのは、**その借りた起点から積分する1区間を自機の予測軌道へ差し替えるか**という判断。

---

## 1. いま「ノードの無い計画」が何をしているか

`PlanEditor.displayedPlan` が起点として自機の現在状態を渡し、`PlanPath` がそこから1区間だけ積分する。
その区間は**描かれない**(`PlanDisplay.sync` が `path.setVisible(nodeCount > 0)`)。
用途は3つだけ:

- **クリック判定** — `PlanPath.nearestSample` はメッシュではなく `arcs[i].samples` を走査するので、
  非表示でも当たる。1件目のノードを置く導線。
- **アプシスアイコン ◇** — `apsisIconsOf` はノード数を見ずに `path.finalSegment()` を読む。
  ◇ は右クリックして「ここにノードを追加」できる被選択物でもあるので、これも導線。
- **ルーラー目盛** — `tickIconsOf` が `path.timeRange()` を読む。

## 2. これは自機の予測軌道の二重計算では

`GameEntity.predictedTrajectory` と同じもの(噴射なしでこの先どこへ行くか)を、別の積分器で
2度目に計算している。期間も一致する — `Predictor` の horizon は `DisplayWindow.duration`、
`segmentDurationFrom` は `displayDuration.durationSec(起点の公転周期)` で、`'orbit'` では
どちらも自機の1周、固定プリセットではどちらも同じ定数。

しかも**実線で描かれているのは予測軌道のほう**(`GameEntity.trajectoryLine`)。
つまり ◇ と目盛は、いま「描かれていない線」の上に載っていて、「描かれている線」とは
別の積分結果を指している。

## 3. 性能面(実測前の見積り)

`PLAN_ARC_MAX_SAMPLES = 2000` / `PLAN_ARC_STEPS_PER_REV = 100` / `PLAN_ARC_MAX_STEPS = 20000` より:

| 表示期間 | サンプル間隔 = 区間長/2000 | 作り直しの間隔 | 1回の積分 step 数 |
|---|---|---|---|
| 1周(LEO ≈ 5580 s) | ≈ 2.8 s | 2.8 sim-s ごと | 100 |
| 28日(2.42e6 s) | ≈ 1210 s | 1210 sim-s ごと | 20000(上限に当たる) |

**×131072 ワープ + 28日表示では 1210 sim-s が1フレーム未満で過ぎるので、毎フレーム
20000 step を積み直している。** 予測軌道側なら `Predictor` の予算制で頭打ちになるので、
**性能面ではこちらが本命。** 着手前に `PerfMeter` の「計画軌道」グループ
(`planArcs`/`planSteps`)で実測しておくこと。

## 4. 難所

1. **アプシス検出の移設(これが本体)。** ◇ は `PlanArc` が積分中の step ペアから
   `apsisCrossing` で拾っている。`GameEntity.stepPredicted` にはその仕掛けが無く、
   間引き済みの `samples` を後から走査する方法は CLAUDE.md が明示的に否定している
   (衝突コースで偽の近地点を拾う)。**「予測軌道を流用する」の実体は
   「アプシス検出を予測軌道側へ移すこと」**であって、区間の差し替えではない。
   ◇ を出さない選択は取れない — §1 のとおり ◇ はノードを置く導線そのものだから。
2. **ノードを置ける範囲を予測の伸び具合に任せてはいけない。** 置ける範囲は
   `segmentDurationFrom(ship.state, …)` で決まるべきで、予測がどこまで伸びたかに
   左右されてはならない。いまの `PlanArc` はコンストラクタで終端まで同期積分するので
   範囲が安定しているが、`Predictor` は予算制で少しずつ伸びるため、素直に繋ぐと
   置ける範囲がフレームごとに揺れる。`nearestSample` に渡す `TimeRange` を明示的に
   クランプすれば済む。
3. `PlanPath` が `PlanArc` 前提で組まれている(`samples`/`at`/`end`/`endState`/`impactPoint`/
   `periapsisPoint`/`apoapsisPoint`/`lastSteps` を要求する)ので、区間の抽象を1枚挟む必要がある。

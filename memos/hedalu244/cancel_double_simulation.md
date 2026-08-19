# 二重積分の解消 — 実シミュレーションが予測列を消費する

実行時に同じ物体の同じ時間帯を **2回積分している**(`Simulator.substep` → `GameEntity.stepActual` と、
`Predictor` → `PredictedArc.step`)。摂動系は初期値鋭敏なので、刻み幅も重力窓も違う2本の積分は
必ず離れていき、`GameEntity.discardPredictionIfDiverged` が予測列を破棄して作り直す。作り直しは
起点が動いた状態から再積分するので、長い表示期間ほど遠端の形が大きく変わり、**予測線が暴れて見える**。

修正の骨格は **predictorが計算済みの場合には、simulatorは新たに積分をせず、予測済みの曲線から時刻を引く** こと。

これを実装すると同時に、これにより壊れうるものを修正し、不要になるものを削除する必要がある。
本文書はその実装計画である。

---

# 第0章 この文書の扱い方

- 段は着手順。ある段を実施したら、その段の手順を削除し、確定した契約・定数は第2章と第5章へ移す。
- 見積りには導出式を併記する。実測が得られたら実測値で置き換える。
- 他文書・過去版・会話への参照を置かない。必要な事実は本文へ埋め込む。

---

# 第1章 現状の問題構造

## 1-1. 2本の積分の刻み幅は最初から揃っていない

| | 刻み幅の規則 | LEO(周期 5580s)での値 |
|---|---|---|
| 実シミュレーション | `maxStep = max(SUBSTEP_MAX_DT, simDt/SUBSTEP_MAX_COUNT)`、再突入域は `REENTRY_SUBSTEP_MAX_DT` | ×1: フレームの simDt(≒1/60s) / 最高ワープ: 2184.5/64 = **34.1s** |
| 予測弧 | `max(ARC_MIN_STEP_DT, min(span, approachDt, max(period/ARC_STEPS_PER_REV, span/ARC_MAX_STEPS)))` | 1周回表示: **40s** / 28日表示: **121s** |

つまり **予測は常に実シミュレーションより粗い**。しかも `span/ARC_MAX_STEPS` の項があるため、
**表示期間を 1周回から 28日へ変えると予測の刻みが 40s → 121s へ 3倍粗くなる**。乖離の大きさが表示設定で変わる。

RK4 の1歩あたり位置誤差は円軌道で ≒ `r(nΔt)^5/120`(n = 平均運動)。LEO で
Δt=20s → 3.3e-4 m/歩、Δt=121s → 2.7 m/歩。1周回(46歩)で 124m、しかも along-track 誤差は
周回数に対して二次で伸びる。`PREDICT_RESET_DIST = 500m` は数周回で必ず跨がれる。

## 1-2. 保持列の間引きも表示期間の関数で、状態の値としては粗すぎる

`trajectorySampleInterval(period, keepDuration) = max(period/TRAJECTORY_SAMPLES_PER_REV, keepDuration/ARC_MAX_SAMPLES)`。
三次エルミート補間の誤差を円軌道で解析評価すると(区間中点の動径誤差、θ = ωh):

| サンプル間隔 h | θ [rad] | 位置誤差 | 速度誤差 |
|---|---|---|---|
| 20s(実シミュレーションの刻み上限) | 0.0225 | 4.5 mm | 0.7 mm/s |
| 40s | 0.045 | 7.3 cm | 5.6 mm/s |
| 174s(= period/32、1周回表示) | 0.196 | **20〜26 m** | 0.46 m/s |
| 1210s(= 28日/2000) | 1.36 | **59 km** | 154 m/s |

174s の 26m は、変更前に置かれていた実測由来の定数 `PREDICT_SAMPLE_ERROR = 30`(3-4 で削除する)と
一致する。つまりこの見積り式は実測で較正済みで、以降の表の値はそのまま信用してよい。

消費した状態は読み出しであって、そこから積分し直すわけではないので **補間誤差は蓄積しない**。
それでも 1210s 間隔の 59km / 154m/s は HUD の高度・速度にそのまま出るので、
**間引きが表示期間で決まる項は消費される弧から外す**必要がある。

## 1-3. 予測の伸長速度と時間送りの競合

interactive 枠 = `ARC_STEP_BUDGET × ARC_INTERACTIVE_RATIO` = 150歩/フレーム。

| 刻み | 伸長 [sim-s/フレーム] | 最高ワープの消費 2184.5 [sim-s/フレーム] に対する余裕 |
|---|---|---|
| 40s(現状) | 6000 | 2.75× |
| 34.1s(最高ワープでの実シミュレーション刻み上限) | 5115 | 2.34× |
| 20s(通常ワープでの実シミュレーション刻み上限) | 3000 | 1.37× |

**予測を細かくすると、そのぶん伸長が遅くなり追い抜かれやすくなる**。
ただし、実シミュレーションの刻み規則をそのまま採ると `simDt/SUBSTEP_MAX_COUNT` の項が
**ワープに比例して刻みを粗くしてくれる**ので、「予測の刻み下限をワープ倍率へ連動させる」対策は
規則を揃えるだけで自動的に手に入る。専用の下限定数は要らない。

---

# 第2章 変更後の契約

修正の骨格は **predictorが計算済みの場合には、simulatorは新たに積分をせず、予測済みの曲線から時刻を引く** こと。

1. **実シミュレーションが積分しない条件は一本だけ** —
   *その物体の予測列が、そのサブステップ終端の時刻を既に持っているか*。
   ビュー・ワープ帯・高度・線を出しているかで分岐しない。予測列が届いていなければ積分する。
2. **ある時間帯の物体の状態を決める積分は、常にちょうど1本。**
   実シミュレーションが1歩でも積分した時点で、その物体の弧を無効化する
   (積分した弧はもはや現実を表さない)。不連続な上書き(`state` セッタ)と
   噴射(`thrust !== null`)でも同じく無効化する。
3. **唯一の例外は `mu !== 0` の物体。** 重力を及ぼす実体どうしの相互作用は
   `Simulator.substep` が組む共有窓の対称性に依存しており、弧を個別に伸ばすとそれが崩れる。
   よってこの種別だけは消費せず、常に実シミュレーションが積分する(= 1. の例外)。
   その予測列は **状態を決めない**(線と、他者の未来重力源としてのみ読まれる)ので、
   乖離しても 2. は破れない。放置すると線が実体から離れていくだけなので、
   **完成した弧を一定時間後に作り直す**という最小限の措置だけを置く(3-4)。
4. **予測の精度は表示期間に依存しない。** 刻みからも間引きからも表示期間由来の項を外す。
   ホライズンに比例して歩数と保持件数が増えるが、予測は予算管理されているので
   フレームが詰まるのではなく完成までの遅延が延びるだけ。誤差由来の作り直しが無くなるので、
   その遅延は容認する。
5. **落ちても壊れない。** 予測が届かなければ実シミュレーションが積分する = 現状とまったく同じ挙動。

---

# 第3章 見落としやすい副作用(洗い出しと決着)

## 3-1. 消費した状態が外部の書き込みを握り潰す(**要対処**)
弧を真値にすると、`e.state = ...` で書いた値は次のサブステップの消費で上書きされ、
**反動も衝突も無かったことになる**。
→ `GameEntity` の `state` セッタで必ず `invalidatePrediction()` を呼ぶ。これは選択ではなく正しさの要件。
書き込み箇所: `contact.ts:271`(剛体接触)、`player-fire.ts:250`(反動)、`docking.ts:122/191/283`、
`creative-stage.ts:361`(瞬間移動)。`belt-physics.ts` / `radiator.ts` / `flash-effect-manager.ts` の
書き込みは予測しない種別なので無害(呼んでも no-op)。

**副作用の副作用**: 射撃するたびに反動で弧が捨てられる。現状は乖離が `PREDICT_RESET_DIST` を
超えないので生き残っていた。射撃・噴射は ×4 以下でしか成立せず、問題が見えているのは高ワープ帯なので
実害は小さい。仕様として受け入れる(操作中の予測は暫定)。

なお噴射については、`Player.behave` / `Base.behave` が `thrust !== null` のときに既に
`invalidatePrediction()` を呼んでいるので、消費側に噴射の分岐は要らない —
弧が無くなれば 2. の一本の条件だけで自然に積分へ落ちる。

## 3-2. 表示期間が物理を変える(**要対処**)
`span/ARC_MAX_STEPS`(刻み)と `keepDuration/ARC_MAX_SAMPLES`(間引き)は表示期間の関数。
弧が真値になると **PREDICT パネルの選択で自艦の実際の軌道と HUD の読みが変わる**(1-1 / 1-2)。
→ 消費される弧では両方の項を使わない(第2章 4.)。代償は歩数と保持件数がホライズンに比例することで、
その見積りは 5-1 / 5-2 に置く。

## 3-3. 再突入域の細分化(**対処しない**)
実シミュレーションは 200km 以下で刻みを 1s へ落とす(`adaptiveSimulationMaxStep`)。弧にはこの規則がない。
弧の `stepDt` の接近項は動径接近率基準なので、高度 200km で降下率 1m/s だと 10万秒を返し効かない。
→ **弧側へ高度上限を入れない。** 再突入域でも一本の条件のまま消費する。
理由: 加熱・動圧は `Player.stepEnvironment` が **サブステップごとに読み値から積む** ので、
実シミュレーション側の細分化が残っている限り熱の積分粒度は落ちない。粗くなるのは軌道(抵抗による減衰)だけで、
その差は存続の判定を左右しない。

## 3-4. 重力を持つ実体の対称性(**今回の適用外・最小限の措置だけ置く**)
`Simulator.substep` はサブステップごとに重力窓を1つだけ組み、全エンティティで共有する
(そうしないと A→B と B→A が処理順で食い違い、運動量が保存しない)。弧は個体ごとに別々の時刻・
別々の予算で伸びるので、2つの小惑星を両方消費するとこの対称性が保証されない。
→ `mu !== 0` は消費しない(第2章 3.)。該当するのは `Asteroid` だけで、
`mu !== 0` かつ予測を持つ種別が今後増える見込みもない。

**乖離判定の一式は削除する** — `discardPredictionIfDiverged` / `divergenceTolerance` /
`DIVERGENCE_TOLERANCE_MAX_ORBIT_RATIO` / `PREDICT_RESET_DIST` / `PREDICT_SAMPLE_ERROR` /
`Predictor.discarded` / `PerfCounts.predictDiscarded` とその行。
この一式が複雑なのは「間引きが粗い列では正しい列まで乖離に見える」問題を許容量の側で吸収していたからで、
状態を決めない線の鮮度を保つだけならその精密さは要らない。

代わりに置くのは **完成した弧の期限切れ作り直し** だけ:

```
// Predictor.update 内、!e.consumesPrediction の物体に対して
const arc = e.predictedArc;
if (arc !== null && !arc.needsGrowth && simTime - arc.state0.t > C.ARC_REANCHOR_INTERVAL) {
  e.invalidatePrediction();
}
```

距離の比較も `at(simTime)` の二分探索も許容量の計算も持たない。
`!arc.needsGrowth`(= 伸び切っている)を条件に含めるのが要で、これがあるおかげで
**伸長中の弧は絶対に作り直されない** — 予算不足で完成しない弧を毎期限ごとに捨てて振り出しに戻す、
という最悪の振る舞いが定数の値によらず起きなくなる。`ARC_REANCHOR_INTERVAL` が決めるのは
「完成した線がどれだけ古びてよいか」だけになり、調整の失敗が事故にならない。

## 3-5. 弧の重力窓と実シミュレーションの重力窓が違う
`ArcBodies`(成員判定 + 期限つき再訪)と `classifyAttractors`/`attractorsNearInto`(27近傍グリッド)は
別の基準で天体を絞る。消費と積分を行き来すると加速度が微小に飛ぶ。状態は連続なので実害は小さいが、
**両者が `GRAVITY_NEGLIGIBLE_ACCEL` の範囲で一致していること**は検証項目に入れる。

## 3-6. 追い抜き(**致命的ではない**)
予算不足で先端が `simTime` に追い抜かれても、条件が「その時刻を持っているか」の一本なので
その物体はその歩から積分へ落ちるだけ。壊れない。
ただし追い抜かれた弧は無効化されて作り直しになるため、毎フレーム作っては捨てるスラッシングは避けたい。
→ 段3(任意)で、消費中の物体へ `ceil(simDt / dt)` 歩(最高ワープなら 2184.5/34.1 = 64歩)を
先に確保する追随枠を入れる。段1の時点では入れない。

## 3-7. 保持窓の左端が消費点を割る
`DynamicTrajectory.step` は `cleanup(keepDuration, 2)` を **先端基準** で行う。
`keepDuration = requiredEnd - retainFrom` かつ `retainFrom = simTime` なので、先端が要求終端に達すると
最古の保持サンプルがちょうど `simTime` 付近になり、`at(simTime)` の補間区間が消える瀬戸際。
→ `retainFrom` を `simTime - ARC_RETAIN_MARGIN` にする。
予測線は `syncGeometry(this.predicted, simTime, ...)` と下端が `simTime` なので過去側は描かれず、
余分に保持しても見た目に影響はない。余裕は大きめでよい。

## 3-8. 表示の焼き直しコスト(**受け入れる**)
`TrajectoryLine.syncGeometry` は保持サンプル全件に `frameTransformAt`/`toFrameState` を掛ける。
3-2 で間引きの表示期間依存を外すと、28日表示で保持件数が約 2000 → 約 14,400 件(5-2)になり、
焼き直しが約7倍になる。**そのまま受け入れる**(表示用に間引いた別配列は作らない)。

## 3-9. 確認して問題なかったもの
- `prevState`: 消費でも「1サブステップ前の状態」を更新する限り、掃引 TOI(`contact.ts`)・
  的板通過(`targeter.ts`)・`checkLoss` の `reachedBody` はそのまま成り立つ。
- サブステップ幅は据え置きなので、姿勢積分・`stepEnvironment`・接触解決の粒度は変わらない。
  ×1 での当たり判定は 1/60s 刻みのまま。
- 弧の刻みは実シミュレーションの刻み **上限** と揃える。フレーム幅で更に細かくなっていた ×1 の刻み
  (1/60s)には合わせない。20s の RK4 は LEO で 1周回あたり 0.09m なので、真値としての精度は充分。
- `FutureAttractors` は `displayState` 経由で読む。消費すると実体と予測が同一曲線になるので、
  むしろ整合が取れる。`revision` の畳み込みは変更不要。
- セーブ/ロードは弧を保存しない。復帰直後は積分にフォールバックし、弧が伸びたら消費へ移る。
- `stepActual` の呼び出し元は `Simulator` だけ(2箇所)。差し込み口は狭い。
- 戦闘ビューでは自艦の弧が伸びない(`hasFutureReader` が対象から外す)が、これは分岐を足す理由にならない。
  弧が無ければ条件が偽になり積分へ落ちるだけで、契約はビューに依らず一本のまま。

---

# 第4章 実装計画

## 段0. 計測の足場(先に入れる)
- `PerfCounts` に `simFollowed`(消費したサブステップ×個体の延べ数)・`simIntegrated`(積分した方)・
  `arcLead`(操作艦の `tip - simTime` [s])を足し、`perf-meter.ts` の `RATE_COUNTS` と行表へ追加。
  `arcLead` は水準値なのでレート集計に入れない。
- 現象の再現手順を確定させる: 高ワープ + 長い表示期間で `predictDiscarded` が毎フレーム立つことを確認する。
- 変更前の `update内訳` の `予測` / `積分` の ms を記録する(段2の予算判断の材料)。

## 段1. 消費経路の導入(本体)

**`physics/dynamic-trajectory.ts`**
- `follow(state, sampleInterval, keepDuration)` を足す。`step` と同じ保持方針
  (`newestGap >= sampleInterval` なら `cleanup`、でなければ `discardNewest`)で、
  積分の代わりに外から与えられた状態を先端にする。`prevState` を更新し、`_samplesCache` を無効化する。
  `_extrapolationCenter` は触らない(過去列には不要)。

**`game/game-entity/game-entity.ts`**
- `set state` に `this.invalidatePrediction()` を足す(3-1)。
- `consumesPrediction` を足す(= `mu === 0`)。第2章 3. の例外を表す静的な性質で、
  ビュー・ワープ・高度といったフレームごとの状態は入れない(第2章 1.)。
- `followPredicted(t, attractors): boolean` を足す。`_predictedArc?.trajectory.at(t)` が非 null なら
  その状態で `actual.follow(...)` して true、でなければ false。
  間引き間隔・保持窓は `stepActual` と同じ `sampleInterval(...)` / `historyDuration`。
- `discardPredictionIfDiverged` / `divergenceTolerance` /
  `DIVERGENCE_TOLERANCE_MAX_ORBIT_RATIO` を削除する(3-4)。

**`game/simulation/simulator.ts`**
- `substep` のループを
  「`e.consumesPrediction && e.followPredicted(t)` が真なら次へ、
  でなければ `e.stepActual(...)` の後、`e.consumesPrediction` なら `e.invalidatePrediction()`」へ変える。
  `t` はそのサブステップの終端時刻。
- 消費/積分の延べ数を段0のカウンタへ積む。

**`game/simulation/predicted-arc.ts`**
- コンストラクタに `consumable: boolean` を足す(消費管理の実体の弧は true、
  計画の弧と `mu !== 0` の弧は false)。`consumable` のとき:
  - 刻み: `dt = min(approachDt, simulationMaxStep)`。`simulationMaxStep` は
    `max(SUBSTEP_MAX_DT, simDt/SUBSTEP_MAX_COUNT)` を所有者(`Predictor`)が毎フレーム弧へ書く。
    `ARC_MIN_STEP_DT` / `ARC_STEPS_PER_REV` / `ARC_MAX_STEPS` は使わない
    (`consumable === false` の弧では従来どおり)。
  - 間引き: 先端が消費前線から `ARC_FINE_STEPS` 歩ぶん以内なら **毎歩保持**、
    それ以遠は `period/TRAJECTORY_SAMPLES_PER_REV`。
    `keepDuration/ARC_MAX_SAMPLES` の項は使わない(3-2)。
- `retainFrom` は `simTime - ARC_RETAIN_MARGIN`(3-7)。

**`game/simulation/predictor.ts`**
- 乖離判定のループを、3-4 の期限切れ作り直し(`!e.consumesPrediction` の物体のみ)へ置き換える。
  `discarded` カウンタも落とす。
- 毎フレーム `simulationMaxStep` を消費対象の弧へ書く。
- 伸長対象の決め方(`hasFutureReader`)・予算配分は段1では変えない。

**`src/const.ts` / `src/perf-meter.ts`**
- `PREDICT_RESET_DIST` / `PREDICT_SAMPLE_ERROR` とその導出コメントを削除し、
  `ARC_REANCHOR_INTERVAL` を足す。
- `PerfCounts.predictDiscarded` と `pred-discard` 行を削除する。

**`tests/perf/`**
- `common.ts` が `PREDICT_RESET_DIST` / `PREDICT_SAMPLE_ERROR` /
  `DIVERGENCE_TOLERANCE_MAX_ORBIT_RATIO` と乖離許容量の式を複製して合否基準にしている
  (`exp7-arc-body-list.ts` も同じ基準を出力する)。許容量という概念自体が無くなるので、
  合否基準を「実シミュレーションの積分に対する位置誤差」の直接比較へ据え直す。
  `npm run` には繋がっていない実験用ハーネスなので段1の完了条件には入れないが、
  基準を残したまま放置しない。

## 段2. 定数の再調整
- `ARC_STEP_BUDGET` 300 → 600 を候補に、段0の実測と `arcLead` を見て決める。
  刻みが 40s → 20s になり歩数が倍必要になる一方、実シミュレーション側の `orbitSteps` は
  消費したぶん減るので、正味の増分は測ってから決める。
- `ARC_FINE_STEPS` は 512 を初期値にする(×1 で 512×20s = 2.8 実時間ぶん、
  最高ワープで 512×34.1s = 8フレームぶん)。高ワープでは接触も射撃も無いので、
  消費し切って `period/32` 側へ落ちてよい。
- `ARC_RETAIN_MARGIN` は 300s を初期値にする(3-7。過去側は描かれないので大きめでよい)。
- `ARC_REANCHOR_INTERVAL` は 600s(sim 時間)を初期値にする。伸び切った弧しか対象にならないので
  短すぎても事故にならず、`Asteroid` の線が実体から離れて見えるようなら縮める(3-4)。

## 段3(任意). 追随枠とサブステップの切り
- 消費中の物体へ `ceil(simDt / dt)` 歩を先に確保してから、残りを現行の interactive 枠 /
  背景ラウンドロビンへ配る(3-6)。
- 先端時刻を `GameEntity.nextSimulationEventTime` として返し、サブステップを先端で切る
  (`entityEventTime` のキャッシュは先端が前進する方向にしか動かないので、
  古い値を持っていても「早めに切る」だけで安全)。

## 保留. 重力を持つ実体の消費
3-4 の対称性をどう保証するかが未解決。共有窓を弧側にも作るか、対称性を諦めるかの判断が要る。
解決すれば例外規則(第2章 3.)と `ARC_REANCHOR_INTERVAL` がまるごと消え、条件は本当に一本になる。

---

# 第5章 見積り

## 5-1. 歩数とホライズン到達までの遅延(28日表示、LEO、interactive 枠 150歩/フレーム)

| | 刻み | 総歩数 | 到達フレーム数 | 60fps での実時間 |
|---|---|---|---|---|
| 現状 | 121s | 20,000 | 133 | 2.2s |
| 変更後(×1) | 20s | 120,960 | 806 | 13.4s |
| 変更後(最高ワープ) | 34.1s | 70,950 | 473 | 7.9s(消費ぶん差し引き前) |

誤差由来の作り直しが無くなるので、この遅延は一度だけ払えばよい。

## 5-2. 保持件数と焼き直し(28日表示、LEO、`ARC_FINE_STEPS = 512`)

先頭 512件(毎歩、512×20s = 10,240s)+ 残り (2,419,200 − 10,240)/174 ≒ 13,845件 = **約 14,400件**。
現状の `ARC_MAX_SAMPLES = 2000` に対して約7倍(3-8 で受け入れ済み)。
既定の1周回表示(5580s)では 5580 < 10,240 なので全域が毎歩保持になり **279件**(現状 32件)。

---

# 第6章 検証

- `npm run typecheck` は毎回。
- `npm run test:physics`:
  - `dynamic-trajectory.test.ts` へ `follow` の追加(保持方針が `step` と一致すること・`prevState` の前進・
    `samplesOldestFirst` のメモ無効化)。
  - `predicted-arc.ts` は DOM 非依存なので `tsconfig.test.json` で直接コンパイルできる。
    `consumable` の刻みが `simulationMaxStep` を超えないこと・
    **刻みと間引きが `requiredEnd` を変えても変わらないこと**(3-2 の回帰)を固定する。
  - 3-5 の確認: 同じ位置・同じ時刻で `ArcBodies.resolve().gravity` と
    `attractorsNearInto(classifyAttractors(...))` が与える加速度の差が `GRAVITY_NEGLIGIBLE_ACCEL` 以下。
- 実行時(`/verify`):
  - 高ワープ + 28日表示で自艦の予測線が跳ねないこと(段0 で記録した変更前の `predictDiscarded` の
    立ち方と見比べる。カウンタ自体は段1で無くなる)。
  - `Asteroid` を置いた状態で、その予測線が実体から目に見えて離れないこと(3-4 の措置の確認)。
  - 表示期間を 1周回 ⇄ 28日 で切り替えても自艦の高度・速度の読みが跳ねないこと(3-2 の回帰)。
  - ×1 で射撃・接触が従来どおり当たること。
  - 再突入で自艦が失われるまでの挙動が変更前後で一致すること(3-3 の確認)。
  - `arcLead` が負へ張り付く場面(高ワープ・多対象)で、フレーム時間が跳ねず積分へ落ちるだけであること。

---

# 第7章 変更後に文書へ書くこと

`src/` を触るので同じ変更セットで更新する。
- `CLAUDE.md`: `Simulator` / `Predictor` / `PredictedArc` / `GameEntity` の責務記述を、
  「消費」と「明示的無効化」の契約へ書き換える。乖離判定(`discardPredictionIfDiverged` /
  `divergenceTolerance` / `PREDICT_RESET_DIST` / `PREDICT_SAMPLE_ERROR`)の記述は長いので、
  取りこぼさず削除する。`mu !== 0` が唯一の例外であることと、その期限切れ作り直しを書く。
- `DEVELOP/CALLSTACK.md`: `substep` 内の分岐(消費/積分)と、乖離判定が消えたこと。
- `DEVELOP/OWNERSHIP.md`: 「ある時間帯の状態を決める積分は1本だけ」を正本の所在として明記する。
- `DEVELOP/SPEC.md`: 表示期間の選択が物理へ影響しないこと。

# 計画軌道と予測の積分を1つにまとめる — 実現可能性の評価と実装計画

対象コード: `origin/workspace4` (acfee89d)。
`improve_plan_predict_performance_v6.md` の提案 A(ノード0本の計画区間を自機の予測列で答える)は
実装済み・未測定の状態を出発点とする。

---

## 0. 結論

**実現可能。ただし「重複実装の削除」で得られる性能は小さく、実際の利得は
(a) スパイクの消滅、(b) 天体窓の解決回数の削減、(c) 定数の半減 の3つに集中する。**

v6 Ch.2 の実測が前提を決めている: **予測1歩のコストの 98.5% は天体窓の構築**
(`stepDynamics` 2.76µs に対し窓構築 176–283µs)。したがって

- 積分ループ本体を1本にまとめても、**それ自体は速くならない**。
- `PlanArc` は1歩あたり窓を 2回解決(mid と end。start は前歩の end と一致してキャッシュに当たる)、
  `Predictor` は 1回。**統一して1回に揃えれば計画側の1歩が約半分になる**
  (v5 実測の「予測 0.19ms/歩 vs 計画 0.61ms/歩、3.2倍」の主因はここで、
  種別に固有の性質ではない)。
- 逆に刻み幅の規則を予測側へ揃えると、**計画側のステップ数は LEO で 2.8倍・GEO で 6倍に増える**
  (後述 §5-1)。ここが最大の性能リスクで、per-step の半減と相殺してなお増える可能性がある。

よって本計画は **リファクタリング(重複削除・低次元化)を主目的、性能改善を副次目的** として扱い、
性能については「スパイクを潰し、窓解決を減らし、定数を1組にして測り直せる状態にする」ことを
目標にする。純粋な高速化は v6 の B-1b / C-1 が担当であり、本作業とは直交する。

---

## 1. 過去に4回棄却されている — その理由が今も生きているかの再評価

これが本作業で最初に片付けるべき論点。`predict_todo.md` / `refactor_trackAnchor.md` /
`improve_plan_predict_performance_v2〜v5` が同じ統合案を繰り返し棄却している。
棄却理由を1つずつ現在のコードに突き合わせる。

### 1-1. 「無効化の条件が正反対」(v4/v5)

> 予測は「実状態から乖離したら破棄して伸ばし直す」列、計画は「凍結したアンカーから決まる」列。

**解消済み(というより、最初から積分器の外にある)。**
`discardPredictionIfDiverged` は `GameEntity` のメソッド、`represents` は `PlanPath` の判断で、
どちらも**積分ループの中には無い**。統合対象は「起点から終端まで刻んで、極値と到達点を溜める」
部分だけであり、無効化はこれまでどおり所有者(`GameEntity` / `PlanPath`)に残る。
**分岐は増えない。** ユーザーの指摘「Nodeは動かないので乖離判定に引っかからない」も同じ結論で、
そもそも Node 側には乖離判定を呼ぶ主体がいない。

### 1-2. 「許容誤差の意味が4桁違う(予測=500m / 計画=9,200km)」(v5 D-1)

**失効している。** 計画側の 9,200km は `PlanArc` が持っていた**起点追従(trackAnchor)の
ドリフト閾値**であり、`origin/workspace4` の 6d11732d「refactor: PlanArc から起点追従の仕組みを
取り除く」で削除済み。現在の `represents` は

```ts
return state0 === this._state0;   // 参照同一性のみ
```

で、**位置の許容誤差を1つも持たない**。統一すべき「2つの許容誤差」は存在しない。

### 1-3. 「1歩のコストが 3.2倍違う」(v5 D-1)

**統合の理由であって障害ではない。** v5 P-9 が「計画の1歩は窓構築+衝突候補の組み立てが約96%、
到達判定そのものは 2.4%」と測っており、v6 Ch.8 が「1サブステップが 64体の重力窓と 101体の
全天体窓を別々に建てている」と続けている。**差の出所は今回消す重複そのもの。**

### 1-4. 「戦闘ビューは近くを高精度、編集モードは遠くを長期間。1本のチューニングでは両立しない」(v2/refactor_trackAnchor)

**main のマージで失効する。** v6 §1-1 の監査どおり、`main`(および `workspace6` の a6a3dcf6
「feat: 戦闘ビューの自機の軌道を解析楕円で描く」)以後、**戦闘ビューの予測列には読者が1人も
いない**。「近くを高精度」という要求の主体が消えている。

→ **本作業は main(または workspace6)のマージを前提とする。** workspace4 単独で進めると、
この棄却理由だけが生き残ったまま設計することになる。

### 1-5. 「打ち切り方針が仕様レベルで違う」

これは**唯一、今も生きている**。`DEVELOP/SPEC.md` は計画側について

> ステップ幅を無理に粗くして即座に描き切らせることはしていない——粗すぎる刻みでは数値積分が
> 発散し、実際には起きない軌道を描いてしまうため。

と書き、予測側については

> 予測が表示期間の終端まで届いていないあいだは、…ケプラー外挿で表示期間の終端まで線を継ぎ、
> 途切れずに1本の折れ線として見える。

と書いている。つまり **計画は「粗くしない・届かなければ途切れる」、予測は「粗くする
(`horizon / PREDICT_MAX_STEPS` の刻み下限)+ 足りない先はケプラー外挿」**。真逆。

**解決案(§5-4 で詳述)**: 予測側の方針に揃えたうえで、**計画側にもケプラー外挿の尾を与える**。
すると SPEC の「粗すぎる刻みで捏造しない」という要請は、
「積分が届いていない部分は積分ではなく二体外挿として描く」という形で満たされる。
これは v6 に残る未決事項 **A-7**(28日表示で dt=121s・13,500km 誤差 vs dt=20s・120,960ステップ)を
**1つの方針に集約する**(2つの方針を別々に決める必要が無くなる)。A-7 そのものの答えは
本作業では出さない — 出す必要が無くなるのが利得。

### 1-6. 「再実装するなら計画側に独立した予算配分を持たせる形になる」(predict_todo.md)

ここだけユーザーの今回の指示と食い違う。**共有予算を推す理由**:

- 独立予算にすると「計画の予算」「予測の予算」の2つを別々に釣り合わせる必要があり、
  今回の目的「チューニングパラメーターの低次元化」に逆行する。
- 計画区間と予測列は**同じ天体窓を奪い合う**(同じプロバイダのキャッシュを共有する)ので、
  片方だけ増やすともう片方のキャッシュヒット率が落ちる。予算が別だと、この相互作用を
  2つのノブで探ることになる。
- 優先度は「予算を分ける」ではなく「配る順序」で表現できる(§6)。

---

## 2. 現状の突き合わせ

| 観点 | `Predictor.advanceBudget` + `GameEntity.stepPredicted` | `PlanArc.integrateTo` |
|---|---|---|
| 起点 | `predicted?.state ?? entity.state`(遅延生成、実状態から) | `state0`(生成時に凍結) |
| 終端 | `simTime + horizon`(毎フレーム前進、意図的に追い越す) | `end`(最後の1歩を clamp して**ちょうど着地**) |
| 刻み幅 | `min(horizon, max(MIN_STEP_DT, kepler/STEPS_PER_REV, horizon/MAX_STEPS))` | `min(localOrbitPeriod/STEPS_PER_REV, 接近時間×0.5)` を `end` で clamp |
| 接近項 | **無い** | ある(`APPROACH_STEP_SAFETY`) |
| 刻み下限 | `PREDICT_MIN_STEP_DT = 20` | **無い** |
| 長期間の扱い | 刻みを粗くする(`horizon/PREDICT_MAX_STEPS`) | **打ち切る**(`PLAN_ARC_MAX_STEPS`/呼び出し) |
| 重力源 | `predictedAttractorsAt` を中点で1回(中心天体窓は前歩から持ち越し) | `provider.at()` を start/mid/end で3回(start は前歩の end と一致) |
| 衝突体 | 重力源と同じ配列(`mu≠0`、空間グリッドで絞済み) | 別集合(`mu=0` の表示天体 + `predictedAsPlanCollider` の entity、**絞らない**) |
| 到達判定 | `reachedBody`(天体は1スナップショットで静止扱い) | `containingBody`(離散)+ `findImpact`(天体位置を start→end で線形補間) |
| 焼失 | `burnUpBody(REENTRY_ALT)` | `burnUpBody(REENTRY_ALT)` ← 同じ |
| 極値 | `ApsisTrack`(中心は `extrapolationCenter`) | `ApsisTrack`(中心は `apsisCenter`、末尾区間のみ) |
| サンプル間隔 | `max(period/TRAJECTORY_SAMPLES_PER_REV, keepDuration/PREDICT_MAX_SAMPLES)` | `duration / PLAN_ARC_MAX_SAMPLES`(平坦) |
| 保持窓 | `horizon` | `duration = end - state0.t` |
| bcInv / srp | entity ごとの値 | `C.SHIP_BCINV` / `C.SHIP_SRP_COEFF` を直書き |
| ケプラー外挿の中心 | 渡す(`TrajectoryLine` が尾を描ける) | **渡さない**(尾が描けない) |
| 予算 | フレーム予算・ラウンドロビン | 呼び出しごとの上限のみ(生成時は同期一括) |

「片方にしかない機能」は太字の6箇所 — 接近項・刻み下限・長期方針・衝突体集合・到達判定の精度・
外挿の尾。ユーザーの見立てどおり、**そのほとんどは本質的に両方に必要**。

---

## 3. 統一後の構造

### 3-1. 中核クラス `PredictedArc`

`game/simulation/predicted-arc.ts`(現在の `game/plan/predicted-arc.ts` の薄いラッパは削除し、
名前を引き継ぐ。代替名 `IntegratedArc`)。

```ts
// 起点状態から要求終端まで前向きに積分し、極値と到達点を溜める1本の弧。
// 誰の弧か(実体の予測列か、計画の1区間か)は知らない。無効化の判断も持たない —
// 作り直すかどうかは所有者(GameEntity / PlanPath)が決める。
export class PredictedArc {
  constructor(
    state0: KinematicState,
    sources: FutureAttractorProvider,
    opts: { bcInv: number; srpCoeff: number; apsisCenter: Attractor | null },
  );

  readonly state0: KinematicState;      // 生成時に凍結。以後動かない
  requiredEnd: number;                  // 所有者が毎フレーム書く(絶対時刻)
  retainFrom: number;                   // 保持窓の左端。所有者が毎フレーム書く

  get trajectory(): DynamicTrajectory;
  get tip(): KinematicState;
  get truncated(): boolean;
  get impact(): BodyImpact | null;
  get apsides(): ApsisTrack | null;
  get needsGrowth(): boolean;           // !truncated && tip.t < requiredEnd

  step(): boolean;                      // 1歩だけ伸ばす。伸ばせなければ false
}
```

**`requiredEnd` / `retainFrom` を可変フィールドにするのが要**。ユーザーの言う
「horizon が end に一般化される」はこの2フィールドで表現される:

- 実体の予測列: `requiredEnd = simTime + horizon`(毎フレーム前進)、`retainFrom = simTime`
- 計画の区間: `requiredEnd = segment.end`(固定)、`retainFrom = state0.t`

`retainFrom` を分けているのは、`keepDuration = requiredEnd - retainFrom` を分岐なしで
両方に効かせるため。予測列で `requiredEnd - state0.t` を使うと、`state0.t` が生成時刻に
固定されたまま `simTime` が進むので保持窓が無限に伸びる(現在は `horizon` 固定で正しい)。

### 3-2. 起点側のインターフェイスは不要

ユーザーの案は「`GameEntity` と `Node` に共通インターフェイスを揃える」だが、
**揃えるものが `KinematicState` 1つしか無いので、インターフェイスを作らずに
`state0: KinematicState` を受け取るだけでよい。**

- `Node` は不変の `KinematicState` そのもの。
- `GameEntity` が余計に持っているのは「実状態と乖離したら捨てる」という方針だけで、
  それは `discardPredictionIfDiverged` として既に積分器の外にある。

→ **`ArcOrigin` のような抽象は作らない。**(`/refactor` の「早急な一般化」に該当する)

### 3-3. `GameEntity` の変化

`stepPredicted` / `_predictedApsides` / `_predictedImpact` / `truncated` / 有限チェック /
到達判定 が丸ごと `PredictedArc` へ移る。残るのは

```ts
private _predictedArc: PredictedArc | null = null;
get predicted(): DynamicTrajectory | null      { return this._predictedArc?.trajectory ?? null; }
get predictedApsides(): ApsisTrack | null      { return this._predictedArc?.apsides ?? null; }
get predictedImpact(): BodyImpact | null       { return this._predictedArc?.impact ?? null; }
get predictionTruncated(): boolean             { return this._predictedArc?.truncated ?? false; }
ensurePredictedArc(sources, requiredEnd, retainFrom): PredictedArc | null;  // predictsFuture のときだけ
invalidatePrediction(): void;                  // 変わらず
discardPredictionIfDiverged(...): boolean;     // 変わらず
```

既存の読者(`PredictedArc` ラッパ、`plan-attractors.ts` の `predictionCoverage`、
`TrajectoryLine`、`displayState`)は getter 経由なので**呼び出し側は無変更**。
`game-entity.ts` は 87行前後縮む。

### 3-4. `PlanArc` は消える

`PlanArc` が持っていたもののうち

- 積分・到達・極値 → `PredictedArc` へ
- `represents()` → `PlanPath` の判断なので `PlanPath` へ移す(所有者の責務)
- `samples` の end クリップ・`at()`・`endState()` → `arc-range.ts` の関数 + `PlanPath` 側で範囲を持つ
- `setEnd()` → `arc.requiredEnd = end` の代入

`game/plan/predicted-arc.ts`(ラッパ)も消える。`PlanPath.arcs` は
`{ arc: PredictedArc; from: number; to: number }` の配列になり、
**ノードが0本のときは自機の `PredictedArc` をそのまま借りる**(v6 提案 A の性質を維持)。
`instanceof` 判定が2箇所とも消える。

### 3-5. 天体窓プロバイダの統一

`game/plan/plan-attractors.ts` → `game/simulation/future-attractors.ts` へ移し、
`PlanAttractors` → `FutureAttractors` に改名(もう計画専用ではない)。
`predictedAttractorsAt` は削除し、`Predictor` もこのプロバイダを読む。

**これが性能上いちばん効く変更**: 同じ未来時刻の天体位置を、いま2つの別経路
(`predictedAttractorsAt` はキャッシュ無し、`PlanAttractors` は4スロット)で解いている。

`revision` の簡約も同時に行える。現在は `planEnd` を使った4値の
`predictionCoverage`(`NO_PREDICTION` / `SHORT` / `COVERS_PLAN` / `TRUNCATED`)だが、
`resolveAt` は既に `e.displayState(t, ephemeris)` を呼んでおり、**先端より先はケプラー外挿で
答えられる**。したがって集合の出入りを決めるのは
`{ 予測が無い, 打ち切られている, 外挿の中心を持たない }` の3条件だけで、
`planEnd` との比較は要らない。

→ `PlanEditor.lastPlanEnd`(前フレームの終端を読む)と
`unresolvedPlanEndTick`(未解決時に毎回別 revision を返す仕掛け)が**両方消える**。

**注意**: 先端が伸びるにつれ外挿値そのものは変わるが、これは現在も
`SHORT` のまま revision が動かないことで既に許容している陳腐化と同じ。悪化しない。

---

## 4. 予算管理の一般化

### 4-1. 対象

`Predictor.update` は「弧の列」を受け取る形になる。所有者から**毎フレーム引く**(pull)。
登録制にすると生存期間の管理が要るので採らない。

```ts
predictor.update(simTime, horizon, {
  interactive: [...planPath.arcs(), activeShipArc],   // 操作中のものを先に
  background: entityArcs,                             // マップビューのみ
});
```

### 4-2. 配り方

現在の `PREDICT_PLAYER_BUDGET_RATIO`(自機に最大50%)を、そのまま2層に一般化する。

1. `interactive` に `BUDGET × ARC_INTERACTIVE_RATIO` を上限として**区間順(早い順)に**配る。
   早い順にするのは、線が自機側から外へ伸びていくように見えるため
   (ノードは凍結された絶対状態なので、区間どうしに依存関係は無く、順序は見た目だけの問題)。
2. 残り(`interactive` の使い残しを含む)を `background` にラウンドロビン。
   `PREDICT_MIN_ENTITY_STEPS` の下限はそのまま。

`background` が空(=戦闘ビュー)なら `interactive` が全額を取る。
**これで v6 の B-0(戦闘ビューの予測を止める)が構造的に含まれる** —
戦闘ビューでは `background` を渡さないだけでよく、専用の分岐も
`PREDICT_COMBAT_STEP_BUDGET` という別定数も要らない。

### 4-3. 「終わった弧」の判定

`needsGrowth = !truncated && tip.t < requiredEnd`。

- 終端が前進する弧(予測列)は、追い越して止まるので `simTime` が追いつくまで何もしない
  (現在の挙動と同じ)。
- 終端が固定の弧(ノード区間)は、一度追い越したら以後永久に何もしない。

`PlanArc.setEnd` にあった「サンプル間隔未満の差なら継ぎ足さない」しきい値は**不要になる**
(追い越しが同じ役割を果たす)。定数が1つ減る。

### 4-4. 消さなければならない打ち切り規則

`PlanArc.integrateTo` の末尾:

```ts
if (steps >= C.PLAN_ARC_MAX_STEPS && sampleInterval > 0
  && trajectory.state.t - tipAtStart < sampleInterval) this.truncated = true;
```

これは「1回の呼び出しで上限まで回したのに先端がサンプル1つぶんも進まない=刻みが潰れている」
という判定。**共有予算のもとでは、正常な弧が1フレームに数歩しか貰えないのが普通なので誤爆する。**
削除し、刻み潰れの検出は既にある `dt <= 1e-9` の分岐(最寄り天体への衝突として記録)に一本化する。

---

## 5. 統一する規則の設計判断

### 5-1. 刻み幅 — **最大の性能リスク**

統一形:

```
naturalDt   = keplerPeriod(|r - center|, center.mu) / ARC_STEPS_PER_REV
coarseFloor = max(ARC_MIN_STEP_DT, span / ARC_MAX_STEPS)      // span = requiredEnd - retainFrom
dt = max(naturalDt, coarseFloor)
dt = min(dt, approachDt)                                       // 天体接近は何より優先
dt = min(dt, span)                                             // 1歩で窓を飛び越えさせない
```

`approachDt` は `PlanArc` の接近項をそのまま持ち込む(`clearance / closingSpeed × ARC_APPROACH_SAFETY`)。
**これは予測側の純増**で、月フライバイなど「最強天体が地球のまま数万秒刻みで月の脇を通る」
経路の積分がまともになる。

**コストの見積り**(`ARC_STEPS_PER_REV` を予測側の 600 に揃えた場合):

| 軌道 | 周期 | 計画 現在(100/周) | 統一後(600/周, 下限20s) | 倍率 |
|---|---|---|---|---|
| LEO 420km | 5,580s | 55.8s → 100歩/周 | 9.3s → **20s** → 279歩/周 | 2.8× |
| GEO | 86,164s | 862s → 100歩/周 | 144s → 600歩/周 | 6.0× |
| 低月周回 | 7,066s | 70.7s → 100歩/周 | 11.8s → **20s** → 353歩/周 | 3.5× |

`ARC_STEPS_PER_REV` を計画側の 100 に揃えることは**できない**:
低月周回で 70.7s 刻みになり、`PREDICT_MIN_STEP_DT` のコメントが根拠にしている
「20s で既に 419m 誤差(中心天体が ECI 中を動くぶんの dt² 誤差)」が
`(70.7/20)² ≈ 12.5` 倍に膨らんで ~5.2km、`PREDICT_RESET_DIST = 500` を超えて
**月周回の予測が永久破棄ループに入る**。下限 20s に届かせるには
`ARC_STEPS_PER_REV ≥ 7066/20 ≈ 353` が必要。

→ **推奨: `ARC_STEPS_PER_REV = 600` で統一して着手し、per-step コストの半減
(窓 2回 → 1回)と相殺した結果を測って詰める。** 相殺しきれない場合の逃げ道は
`ARC_STEPS_PER_REV` を 400 程度まで下げること(月の下限条件は満たす)。
計画側は GEO 以遠で精度が 6倍良くなる — 噴射の狙いを付ける線なので、これは
「コストが増えただけ」ではない。

`const.ts` の `PREDICT_STEPS_PER_REV` のコメントが
「細かくすれば届く先が近くなるだけで、折れ線の誤差は間引き補間が支配している」
と書いているのは**予測の見た目**の話であり、計画側の到達状態(Δv 表示)には当てはまらない。
混同しないこと。

### 5-2. サンプル間隔・保持窓

予測側に揃える:

```
sampleInterval = max(localOrbitPeriod / TRAJECTORY_SAMPLES_PER_REV, keepDuration / ARC_MAX_SAMPLES)
keepDuration   = requiredEnd - retainFrom
```

計画側の平坦な `duration / PLAN_ARC_MAX_SAMPLES` より細かくなる場面がある(短い区間)。
`PLAN_ARC_MAX_SAMPLES` と `PREDICT_MAX_SAMPLES` は**どちらも 2000 で既に一致**しているので、
統一に伴う値の選択は不要。

`PlanPath` の `represents` が使う `decimation`(要求した間引き下限の最も粗い値)は
**そのまま残す**。実際に積まれた間隔(`DynamicTrajectory.sampleInterval`)は刻み幅にも
下から縛られるので、要求下限と比べると縮めようのない粗さを理由に毎フレーム作り直すことになる
— `plan-arc.ts` の既存コメントが警告しているとおり。

### 5-3. 衝突体集合と到達判定 — 計画側に揃える

- **集合**: プロバイダの `collision`(`mu=0` の表示天体を含む全天体 + `predictedAsPlanCollider` の entity)。
  実体の予測列にとっては純増で、「予測線が小天体をすり抜ける」が直る。
- **判定**: `findImpact`(天体位置を start→end で線形補間する掃引)+ ステップ先頭の
  `containingBody`。`reachedBody`(天体を静止扱い)より正しい。

**コストの懸念と対策**: `collision` は 101体規模で、これを毎歩・全個体でなめると
予測側のコストが跳ねる(現在は空間グリッドで絞った ~20体)。

対策 — **接近項の計算と衝突候補の絞り込みを1つのループに融合する**:

`stepDt` は既に全 collision body について `clearance = |r - r_body| - radius` を計算している。
一方 `dt ≤ approachDt = ARC_APPROACH_SAFETY × clearance / closingSpeed` かつ
`ARC_APPROACH_SAFETY = 0.5 < 1` なので、**接近項を守る限り1歩で表面に到達できる天体は
原理的に存在しない**(1歩で詰められる距離は clearance の半分以下)。
掃引判定は「プロバイダの start と end で集合が変わった」等の取りこぼしに対する安全網であり、
候補は同じループで得た `clearance / closingSpeed` が dt に近い天体だけに絞れる。

これで掃引テストは毎歩 0〜2体になり、clearance のループ 101回だけが残る。
それでも重いなら、プロバイダ側で `collision` にも空間分類を持たせる(時刻スロットごとに1回、
償却される)。**どちらを採るかは §11 の測定後に決める。**

なお、接近項があるおかげで到達点は「clearance が幾何級数的に潰れて `dt ≤ 1e-9` になった地点」
= 実質表面上、として求まる。掃引が求める交差点と精度は同等。

### 5-4. 終端の扱い — **追い越しに統一し、ケプラー外挿の尾を計画にも与える**

ユーザーの提起した論点。**追い越しに統一する**ことを推す。

- 予算管理のもとでは「最後の1歩を end に clamp する」は特別扱いが増えるだけで、
  clamp を残しても消しても予算的には等価。
- clamp を消すと `at(end)` が補間になり、`arrivalStates()`(ノード到着状態=Δv 表示の元)に
  補間誤差が入る。ただしその誤差は保持サンプル1区間ぶんの三次エルミート補間誤差で、
  **描かれている折れ線が既にどこでも負っている誤差と同じ大きさ**。
  §5-1 で刻みが 2.8〜6倍細かくなるので、現在より小さくなる。
- 見返りに、終端まわりの分岐と `setEnd` のしきい値が消える。

**そして計画側の弧にも `extrapolationCenter` を渡す。** これが本設計でいちばん効く副産物:

`TrajectoryLine.syncGeometry` は `trajectory.extrapolationCenter` が非 null なら
先端の先をケプラー外挿で継ぐ。計画の弧は今これを渡していないので尾が描けないが、
渡せば**予算で少しずつ伸びている途中の区間でも、線は終端まで繋がって見える**。

→ §10 の最大のリスク(「ノードを置いても線が即座に描かれず、じわじわ伸びる」)が
**構造的に消える**。しかも「積分が届いていない先は二体外挿である」という描き分けは
予測側で既に仕様化されている挙動(SPEC.md)なので、新しい概念を持ち込まない。

同時に §1-5 の仕様衝突も解ける: 計画側は「粗くして捏造しない」を保ったまま
「終端まで届く」を満たせる。

**残る判断**: `arc.at(t)` を `extrapolatedAt` にフォールバックさせるか。
させると、まだ伸びていない区間のノード到着状態(=Δv 表示)が
二体外挿の値で先に出て、予算が届くにつれ精度が上がる。
させないと今と同じく「届くまで表示できない」。
**推奨は させる** — 現状の「28日表示で区間が打ち切られると Δv が永久に出ない」より良い。
ただし表示値が数フレームかけて動くので、UI 上の見え方は要確認。

### 5-5. `bcInv` / `srpCoeff`

`PlanArc` は `C.SHIP_BCINV` / `C.SHIP_SRP_COEFF` を直書きしている。
弧の構築引数にすれば、計画側は所有艦の値を渡せる(現在は艦の種類を問わず自機の定数)。
実体の予測列は自分の値を渡す。分岐なしで両立し、正しくなる。

---

## 6. 定数の統合表

| 統一後 | 統合元 | 初期値 | 備考 |
|---|---|---|---|
| `ARC_STEPS_PER_REV` | `PLAN_ARC_STEPS_PER_REV`(100) / `PREDICT_STEPS_PER_REV`(600) | **600** | §5-1。下げるなら 400 まで |
| `ARC_MIN_STEP_DT` | `PREDICT_MIN_STEP_DT`(20) / 計画側なし | 20 | 低月周回が根拠 |
| `ARC_MAX_STEPS` | `PREDICT_MAX_STEPS`(20000) | 20000 | **刻みを粗くする側の意味だけを残す**。`PLAN_ARC_MAX_STEPS`(呼び出しごとの打ち切り)は共有予算に置き換わって消滅 |
| `ARC_MAX_SAMPLES` | `PLAN_ARC_MAX_SAMPLES` / `PREDICT_MAX_SAMPLES`(どちらも 2000) | 2000 | 値が既に一致 |
| `ARC_APPROACH_SAFETY` | `plan-arc.ts` の `APPROACH_STEP_SAFETY`(0.5) | 0.5 | `const.ts` へ移す |
| `ARC_STEP_BUDGET` | `PREDICT_STEP_BUDGET`(500) | 要再導出 | §11。`PREDICT_COMBAT_STEP_BUDGET`(128)は §4-2 で消滅 |
| `ARC_INTERACTIVE_RATIO` | `PREDICT_PLAYER_BUDGET_RATIO`(0.5) | 0.5 | 意味が「自機」→「操作対象+計画」に広がる |
| `ARC_MIN_ENTITY_STEPS` | `PREDICT_MIN_ENTITY_STEPS`(16) | 16 | 変更なし |
| — | `PLAN_ARC_MAX_SAMPLE_COARSENING`(8) | 8 | `PlanPath.represents` へ移動、名前は据え置き |

**正味 5定数減**(`PLAN_ARC_STEPS_PER_REV` / `PLAN_ARC_MAX_STEPS` / `PLAN_ARC_MAX_SAMPLES` /
`PREDICT_COMBAT_STEP_BUDGET` / `setEnd` のしきい値)。
`PLAN_ARC_DASH_PX` / `_GAP_PX` / `_OPACITY` は描画側なので対象外。

---

## 7. フレーム順序の変更(必須)

現在:

```
Game.update:
  handleInput
  if (!paused && isPlaying) advanceSimulation:      ← predictor.update はこの中
      ... simulator.advance / entities.cleanup ...
      displayWindowManager.resolve
      predictor.update(simTime, player, duration, mode)
  displayWindowManager.resolve
  environment.update
  editor.update(displayWindow)                      ← ここで PlanArc が積分される
  ...
```

弧が予算で伸びるためには **「弧の生成・破棄・`requiredEnd` の確定」が予算パスより先** で
なければならない。加えて、`predictor.update` が `advanceSimulation` の中にあると
**ポーズ中とステージ決着後に計画の弧が伸びなくなる**(今は `editor.update` が無条件に走るので
ポーズ中でも計画を編集・表示できる)。これは明確な退行。

統一後:

```
Game.update:
  handleInput
  if (!paused && isPlaying) advanceSimulation:      ← predictor.update をここから出す
      ... simulator.advance / entities.cleanup ...
      displayWindowManager.resolve
  displayWindowManager.resolve
  environment.update
  editor.update(displayWindow)      ← 区間列の確定と弧の生成/破棄/requiredEnd 代入のみ(積分しない)
  predictor.update(...)             ← 全弧に予算を配る(無条件)
  targeter.updateEquatorNodes / entities.updateBaseEquatorNodes
  cameraSystem.update
  mapPickables.refresh
```

副作用として **ポーズ中も予測が伸びる**ようになる。`simTime` が止まっているので乖離は起きず、
止まっている間に予測が完成するだけ。害は無く、ポーズ解除直後の見え方はむしろ良くなる。

**要修正**: `PlanPath.update` は末尾で `this.final = { …finalArc.samples, periapsisPoint(), … }` を
組み立てている。予算パスの**前**にこれを組むと1フレーム古い値になるので、
`finalSegment()` を遅延評価(呼ばれた時に getter から組む)に変える。読者は
`PlanDisplay.apsisIconsOf` と `PlanEditor.updateEquatorNodes` で、どちらも `sync` 側なので問題ない。

`FrameSections` の `SECTION.plan` / `SECTION.predict` の境界も引き直す
(積分は `predict` 側に一本化され、`plan` は区間列の組み立てだけになる)。
**この境界変更は測定の連続性を壊すので、v6 の測定表と突き合わせるときに注意する。**

---

## 8. 段階実装計画

各フェーズ末で `npm run typecheck` が通り、`npm run test:physics` が通ること。
`src/physics/` を触るのは Phase 1 と Phase 3 のみ。

### Phase 0 — 前提を揃える(コード変更なし〜マージのみ)

- **`main`(または `workspace6`)をマージする。** §1-4 の棄却理由の失効と、
  `curve.ts` の頂点予算 16384→4096 が入る。これ抜きで測ると v6 の見積りと突き合わない。
- v6 提案 A の効果を測る(別セッションのベースライン)。A の効果が見えないまま
  次を積むと、どの変更の効果か切り分けられなくなる。

### Phase 1 — 純粋関数を `physics/` へ切り出す

重複していない小さな部品を先に共有可能な形にする。ここは挙動不変。

- `physics/arc-step.ts`(新規): 刻み幅の決定を純関数化する。
  `arcStepDt(state, gravity, collision, span, tuning)` — `tuning` は
  `{ stepsPerRev, minStepDt, maxSteps, approachSafety }` を受け取る引数オブジェクト
  (`game/const.ts` を `physics/` から読まないため)。
  ついでに `nearestByClearance` と接近項をここへ。
- `physics/attractor.ts` の `reachedBody` と `plan-arc.ts` の `findImpact` を
  **1つの関数に統合**する(天体位置を start→end で補間する側に揃える。
  `reachedBody` の呼び出し側は `prev`/`next` の天体窓が同じなら現在と同一の結果になる)。
- `tests/physics/arc-step.test.ts` を足す: 接近項が「1歩で表面へ到達しない」を保証すること、
  刻み下限と粗化床の合成、span で頭打ちになること。
- `tests/physics/` の `reachedBody` 既存テストを統合後の関数へ移す。

**Phase 1 単独で `PlanArc` と `stepPredicted` の両方が新しい関数を呼ぶようにするが、
定数はまだ別々に渡す**(挙動不変を保つため)。

### Phase 2 — 天体窓プロバイダを1つにする

- `game/plan/plan-attractors.ts` → `game/simulation/future-attractors.ts`、
  `PlanAttractors` → `FutureAttractors`、`PlanSourcesAt` → `FutureSourcesAt`、
  `PlanAttractorProvider` → `FutureAttractorProvider`。旧名は全文検索で 0件にする。
- `revision` から `planEnd` 依存を外す(§3-5)。
  `PlanEditor.lastPlanEnd` と `unresolvedPlanEndTick` を削除。
- `game/simulation/attractors.ts` の `predictedAttractorsAt` を削除し、
  `Predictor.advanceBudget` をプロバイダ経由にする。
- 所有を `Game` へ上げる(現在は `PlanEditor` が持っている)。`Predictor` と `PlanEditor` の
  両方が参照で共有する。`resolve(...)` の呼び出しも `Game.update` の1箇所へ。
- `HELD_SLOTS = 4` は「1歩3回・端が次歩の始点」を前提にしていた値。
  §5-4 で1歩あたりの解決が減り、代わりに多個体が交互に引くので**スロット数の再検討が要る**
  (弧ごとに境界窓をフィールドで持ち越す設計にすれば、スロット数への依存が下がる — 下記)。
- **弧の境界窓の持ち越し**: `Predictor.advanceBudget` の `centerWindow`(局所変数)を
  弧のフィールドへ移す。予算スライスをまたいで保持され、ラウンドロビンでスロットが
  追い出されても効く。

**このフェーズだけで測る価値がある**(窓の二重解決の解消 = v6 Ch.2 の 98.5% に直接効く)。

### Phase 3 — 弧クラスを1つにする(重複削除の本体)

- `game/simulation/predicted-arc.ts` に統一 `PredictedArc` を作る。
  `PlanArc.integrateTo` と `GameEntity.stepPredicted` の合流。
  この時点では **`opts` で 2組のチューニングを受け取れるようにしておく**(挙動不変を保つ)。
- `GameEntity` を §3-3 の形に(`stepPredicted` 削除)。
- `PlanPath` を §3-4 の形に(`PlanArc` / `game/plan/predicted-arc.ts` 削除、
  `represents` を `PlanPath` へ、`instanceof` 2箇所を削除)。
- `arc-range.ts` を `game/simulation/` へ移す。
- `typecheck` + 目視で「挙動が変わっていない」ことを確認してからコミット。

### Phase 4 — チューニングを1組にする(挙動が変わる)

- §6 の定数統合を実施。`ARC_*` を `const.ts` に置き、旧名を削除。
- 刻み幅・サンプル間隔・衝突体集合・到達判定を §5 のとおり統一。
- 終端の clamp を外す(追い越しに統一)。
- **ここで初めて挙動が変わる。** 測定して §5-1 のコスト増が相殺されているか確認し、
  `ARC_STEPS_PER_REV` を詰める。

### Phase 5 — 予算管理へ載せる

- `Predictor.update` を §4 の2層に。`mode` 引数を `interactive`/`background` の
  2リストに置き換える。
- §7 のフレーム順序変更。`PlanPath.finalSegment()` を遅延評価に。
- `PlanArc` 由来の呼び出しごと打ち切り規則を削除(§4-4)。
- `PlanPath.lastSteps` / `lastRebuiltArcs` の集計を `Predictor.perfCounts()` 側へ移し、
  `planSteps` / `planArcs` の意味を維持する(負荷確認ウィンドウの行を壊さない)。
- `FrameSections` の `SECTION.plan` / `SECTION.predict` の境界を引き直す。

### Phase 6 — 外挿の尾と仕上げ

- 計画側の弧に `extrapolationCenter` を渡す(§5-4)。
- `arc.at(t)` の `extrapolatedAt` フォールバックを入れるか決める(§5-4 の残る判断)。
- `CLAUDE.md` / `DEVELOP/CALLSTACK.md` / `DEVELOP/OWNERSHIP.md` / `DEVELOP/SPEC.md` を更新
  (`/develop-docs`)。SPEC は §1-5 の「粗くしない/外挿で継ぐ」の一本化を反映する。
- `/comment-cleanup` を通す。
- `memos/hedalu244/predict_todo.md` を削除(この計画が答えになる)。
  `improve_plan_predict_performance_v6.md` の D-1 / 提案A の記述を現状に合わせる。

---

## 9. 命名

| 対象 | 案 | 理由 |
|---|---|---|
| 統一クラス | `PredictedArc`(`game/simulation/predicted-arc.ts`) | 既存語彙。計画の1区間も「そのノードから先どこへ行くかの予測」なので読みが合う。代替 `IntegratedArc` |
| プロバイダ | `FutureAttractors` / `FutureAttractorProvider` / `FutureSourcesAt` | 計画専用でなくなるため。「未来時刻の重力源と衝突体」を素直に言う |
| 予算管理 | `Predictor` のまま | 扱うものが増えても「未来を予測する」責務は変わらない。`ArcBudget` は「予算だけ」に見えて実態と合わない |
| 刻み幅の純関数 | `arcStepDt`(`physics/arc-step.ts`) | |

`PlanArc` / `PlanAttractors` / `predictedAttractorsAt` / `PLAN_ARC_*` /
`PREDICT_STEPS_PER_REV` 等の旧名は**全文検索して 0件**にする(互換エイリアスを残さない)。

---

## 10. 挙動が変わる点とリスク

| # | 変わること | 影響 | 緩和 |
|---|---|---|---|
| R-1 | ノード配置・Δv ドラッグで線が即座に描き切られず、予算ぶんずつ伸びる | 大 | **§5-4 のケプラー外挿の尾で構造的に消える。**尾が入るまで(Phase 5→6 の間)は一時的に見える |
| R-2 | 計画のステップ数が LEO 2.8倍 / GEO 6倍 | 大 | per-step の半減で相殺。足りなければ `ARC_STEPS_PER_REV` を 400 まで下げる(§5-1) |
| R-3 | `arrivalStates()`(Δv 表示)が補間値になる | 中 | 刻みが細かくなるぶん誤差は現在より小さい。Δv は m/s 表示 |
| R-4 | 実体の予測列が `mu=0` の天体や `predictedAsPlanCollider` の entity で止まるようになる | 中 | **修正**。予測線が小天体をすり抜けなくなる |
| R-5 | 予測に接近項が入り、天体近傍でステップ数が増える | 中 | 積分の正しさとの引き換え。月フライバイの予測がまともになる |
| R-6 | ポーズ中も予測が伸びる | 小 | 害なし。ポーズ解除直後の見え方が良くなる |
| R-7 | `SECTION.plan` / `SECTION.predict` の意味が変わる | 小(測定) | v6 の測定表と突き合わせるときに明示 |
| R-8 | 戦闘ビューで entity の予測が走らなくなる(B-0 が含まれる) | 小 | main マージ後は読者が居ない(v6 §1-1)。**マージ前に入れると戦闘ビューの自機線が消える** |
| R-9 | `HELD_SLOTS = 4` の前提が崩れ、キャッシュヒット率が落ちうる | 中 | 弧ごとに境界窓をフィールドで持ち越す(Phase 2)。それでも足りなければスロット増 |
| R-10 | `FutureAttractors.at()` が返す配列/Map を弧がフレームをまたいで持つ | 中 | プロバイダは `revision` 変化時に held を捨てるだけで**中身を書き換えない**ことを確認済み。弧側も読むだけ。コメントで契約を明示する |
| R-11 | `ARC_STEP_BUDGET = 500` が 1フレームに収まらない | 中 | 現状既に収まっていない(500歩 × 0.19〜0.61ms)。§11 で ms から再導出する |

**依存順序の警告**: R-8 のため **Phase 0 のマージを飛ばして Phase 5 に到達してはいけない。**

---

## 11. 測定計画

v5/v6 の測定条件(`stage1-map`、8条件×5ラウンド、`?perf=1`)をそのまま使う。
以下の3点を各フェーズ後に取る。

1. `update` / `計画` / `予測` / `積分` の ms(`FrameSections`)
2. `plan-steps` / `predictor-steps`(avg と max の両方 — **avg ≒ max は
   「毎フレーム作り直している」の指標**、v4 2-1 と同じ読み方)
3. **per-step コスト**(ms ÷ steps)。統合の効果はここに最も素直に出る。
   目標: 計画側 0.61 → 予測側 0.19 に近づくこと。

**ノブの再導出**: `ARC_STEP_BUDGET` は「歩数」ではなく
「1フレームに使ってよい ms」から逆算する(= 目標ms ÷ 実測 per-step コスト)。
時間ベースの打ち切りにはしない — フレームレート依存で非決定的になり、
セーブ/リプレイの再現性を壊すため。

**測るべき固有条件**(既存条件に追加):
- ノードを1本置いた直後の1フレーム(スパイクの有無)
- Δv アームをドラッグし続けている間(R-1 の見え方)
- 28日プリセット × ×1(v5 P-1 の 1,242ms 退行が再現するか)

---

## 12. やらないこと

- **`Simulator` の積分器との統合**。同時性(全 entity が同じ瞬間の同じ配列を読む)が
  問題構造を別物にしている。ユーザー指示どおり範囲外。
- **A-7 の答えを出すこと**(長期表示で「粗くして 13,500km 誤差」か
  「細かくして 120,960 歩」か)。統合によって**方針が1つになる**のが利得で、
  値そのものは Phase 4 の測定後に別途決める。
- **`ArcOrigin` のような起点抽象**(§3-2)。揃えるものが `KinematicState` 1つしかない。
- **v6 の B-1 / B-1b / C-1 / C-2**。本作業と直交する。ただし C-1
  (entity ごとの「効く天体」キャッシュ)は本作業でプロバイダが1本化された後のほうが
  入れやすくなる — **本作業を先に済ませることを推す**。
- **予測と計画で予算を分けること**(`predict_todo.md` の旧判断)。§1-6 の理由で共有にする。

---

## 13. 未確認事項(着手前に潰す)

1. `FutureAttractors.at()` の返す `readonly Attractor[]` / `ReadonlyMap` を
   **フレームをまたいで保持しても安全か**(Ephemeris のリングキャッシュ由来の配列が
   同じ `t` で同一参照を返す契約に依存している)。R-10。
2. `tsconfig.test.json` が `game/const.ts` を引けるか
   — `physics/arc-step.ts` を引数オブジェクト方式にする理由が「引けないから」なのか
   「`physics/` にゲームバランスを置かない規則だから」なのか。**後者だけでも十分な理由**なので
   設計は変わらないが、テストの置き場に影響する。
3. `PLAN_ARC_MAX_STEPS = 20000` に実際に到達する条件が
   ゲーム中に発生するか(発生しないなら R-2 のコスト増の評価が変わる)。
4. v6 提案 A の実測値(別セッション)。本計画の見積りは全て A の効果が
   v6 の予想どおり出ている前提で書いている。

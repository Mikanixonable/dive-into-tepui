# 計画軌道と予測の積分統一 — 実装計画

対象コード: `origin/workspace4`(f5cabf2f)。ノード0本の計画区間を自機の予測列で答える統合
(`plan/predicted-arc.ts`、v6 提案 A)は実装済み・実測済み(v6 §3-0)を出発点とする。
本セッションではコードに着手せず、実測も行わない(ベースライン測定は別セッション)。

---

## 0. 目的と結論

**実現可能。** 必要な継ぎ目はすべて現行コードに確認済み(§4 に逐一挙げる)。

目的は優先順に:

1. **重複実装の削減** — `PlanArc.integrateTo` と `Predictor.advanceBudget` +
   `GameEntity.stepPredicted` は「凍結起点から要求終端まで RK4 で刻み、極値と到達点を溜める」
   同じ積分→衝突検出器の二重実装。1本にする。
2. **計画の積分を予測の予算管理へ入れる** — 現在ノードを置いたフレームで `PlanArc` の
   コンストラクタが同期一括積分し(28日プリセットの末尾区間で秒級のスパイク)、以後は
   `setEnd` の継ぎ足し。予算管理に入れて、フレームあたり上限つきの漸進成長へ分散する。
3. **チューニングの低次元化** — 刻み幅・サンプル間隔・衝突判定・打ち切りの規則を1組にし、
   定数を統合する。長期表示の遠端精度(v6 A-7)は「予測と計画で別々に決める2問」から
   「1つのノブ」になる。

性能の純増は副次目的。v6 Ch.2 の実測どおり1歩のコストの 98.5% は天体窓であり、ループを
1本にしても物理は速くならない — 効くのは (a) スパイクの消滅、(b) 計画側の窓解決 2回/歩 →
1回/歩、(c) 統一後の1箇所に v6 C-1(近傍天体リスト)を差し込める形になること。

`Simulator` の積分器は対象外(全エンティティが同一時刻の同一配列を読む同時性があり、
問題構造が別物)。

---

## 1. 設計上の確定判断

### 1-1. 定数は最初から1組(初期値 = 予測側の現行値)

予測線と計画線はどちらもマップビューで見る表示物になった — 戦闘ビューの自機軌道は解析楕円で
描く方針が main 側で既に決定・実装されている(a6a3dcf6)。両者の要求精度は、長さのオーダーの
面でも対象軌道の種類の面でも同一であり、共通の定数で表現できるし、そうすべきである。

- 刻み幅・サンプル間隔・打ち切りの規則を予測側の形に揃え、定数値も予測側の現行値で入れる。
  値のチューニングは統一後に測って行う(§12)。
- **main のマージは前提にしない。** main 側の変化は「戦闘ビューで予測線を表示しなくなった」
  という表示の有無・表示用インターフェイス・要求精度の話であり、積分器の問題構造には関係が
  ない。workspace4 上でも初期値=予測側現行値なので、戦闘ビューの見え方は本作業で変わらない。
  マージ後に戦闘ビューの読者が減れば、予算の作業集合(§6-1)を縮めるだけで対応できる。
- 計画側のステップ数増(LEO 204→279歩/周、GEO 100→599歩/周)は許容して着手する。
  計画の積分はノードを置いた直後にしか走らず、全体パフォーマンスへの影響は軽微。しかも
  1歩あたりの窓解決が半減する(§5-4)ので、LEO ではむしろ1周あたりのコストが下がる。

### 1-2. 計画の弧はケプラー外挿の尾を持たない

`PlanArc` の役割は**次のノードへ繋ぐこと**であり、外挿の暫定値の上にノードを置くと次のノードと
繋がらなくなる。計画の弧は積分が済んだ範囲だけを描き、ノードの設置・ドラッグも積分済みの
範囲に限る。

この制限に追加のゲートは要らない — ノード操作の入口は全て「保持サンプルへの画面最近傍探索」
(`PlanPath.nearestSample`)か「保持区間への補間」(`sampleAt`、届かなければヒント)であり、
**クリック候補=積分済みサンプル**という既存の UI 構造がそのまま制限になっている。上位レイヤー
(PlanEditor)側の追加作業は「まだ伸びていない」を「打ち切られた」と同じ絵(線がそこで
終わる・Δv 表示が出ない)で見せることだけで、これも既存の truncated 表示がそのまま使える。

一方**実体の予測列の外挿の尾は現状維持**(SPEC 化済みの挙動)。統一弧クラスは外挿可否を
生成時のフラグで持ち、実体の弧は許可・計画の弧は禁止にする。`TrajectoryLine.syncGeometry` は
`trajectory.extrapolationCenter` が null なら先端で線を止めるので、表示側の変更は不要。

### 1-3. 終端は「追い越して、読みでクリップ」に統一

予測は先端が `simTime + horizon` を意図的に一歩追い越して止まる(毎フレーム逃げる終端への
追従を数フレームぶん省くため)。計画は現在、最後の1歩を `end` へ clamp してちょうど着地させて
いる。**追い越しへ統一する**:

- `arc-range.ts` のクリップ機構(`stateAt` / `clipSamplesTo` / `withinEnd`)が既にあり、
  追い越したぶんは読みで切れる。`at(end)` は保持サンプル間の三次エルミート補間になるが、
  その誤差は描かれている折れ線がどこでも負っている補間誤差と同じ量で、刻みが細かくなるぶん
  現状より小さい。
- clamp を消すと、`setEnd` の「サンプル間隔未満の差なら継ぎ足さない」しきい値も不要になる
  (追い越し自体が同じヒステリシスの役割を果たす)。
- 予算管理下では「最後の1歩だけ特別に clamp する」は分岐が増えるだけで利得がない。

---

## 2. 過去の棄却理由の再評価

同種の統合案は `predict_todo.md` / `refactor_trackAnchor.md` /
`improve_plan_predict_performance_v2〜v5` で繰り返し棄却されている。理由を現在のコードに
突き合わせる。

| 棄却理由 | 現在 |
|---|---|
| 「無効化の条件が正反対」(予測=乖離で破棄、計画=凍結起点)(v4/v5) | **最初から積分器の外にある。** `discardPredictionIfDiverged` は `GameEntity`、`represents` は `PlanPath` の判断で、統合対象の積分ループには入らない。無効化は所有者に残る。ノードは動かないので乖離判定の主体もいない |
| 「許容誤差の意味が4桁違う(500m vs 9,200km)」(v5 D-1) | **失効。** 9,200km は起点追従(trackAnchor)のドリフト閾値で、6d11732d で機構ごと削除済み。現在の `represents` は `state0 === this._state0` の参照同一性のみで、位置の許容誤差を持たない |
| 「1歩のコストが 3.2倍違う」(v5 D-1) | **統合の理由であって障害ではない。** 差の主因は窓解決 2回/歩 vs 1回/歩と候補集合の組み直し(v5 P-9: 窓+候補で約96%)で、今回消す重複そのもの |
| 「戦闘ビューは近くを高精度、編集モードは遠くを長期間。1本のチューニングは無理」(v2) | **失効。** 戦闘ビューの自機軌道は解析楕円で描く方針が決定済み(§1-1)。予測線・計画線はともにマップビューの表示物で、要求精度は同一 |
| 「打ち切り方針が仕様レベルで違う」(SPEC: 計画=粗くせず途切れる、予測=粗くして外挿で継ぐ) | **本計画で解消する。** 刻みの規則は1本(粗化項込み)へ統一し、遠端精度は A-7 の1ノブに集約。外挿の尾だけは非対称のまま(§1-2 — 計画は次のノードへ繋ぐ責務があるので外挿を許さない)。SPEC は §10 Phase 5 で書き換える |
| 「再実装するなら計画側に独立予算を持たせる形」(predict_todo.md) | **共有予算にする。** 独立予算は2つのノブを別々に釣り合わせることになり低次元化に逆行する。計画と予測は同じ天体窓プロバイダを奪い合うので、予算を分けると相互作用を2ノブで探ることになる。優先度は予算の分割ではなく配る順序で表す(§6-2) |

---

## 3. 現状の突き合わせ

| 観点 | `Predictor.advanceBudget` + `GameEntity.stepPredicted` | `PlanArc.integrateTo` |
|---|---|---|
| 起点 | `predicted?.state ?? entity.state`(遅延生成) | `state0`(生成時に凍結) |
| 終端 | `simTime + horizon`(毎フレーム前進、追い越して止まる) | `end`(最後の1歩を clamp して着地) |
| 刻み幅 | `min(horizon, max(MIN_STEP_DT, kepler周期/600, horizon/MAX_STEPS))` | `min(局所周期/100, 接近時間×0.5)` を `end` で clamp |
| 接近項 | **無い** | ある(`APPROACH_STEP_SAFETY = 0.5`、相対速さ基準) |
| 刻み下限 | `PREDICT_MIN_STEP_DT = 20` | **無い**(dt が幾何級数的に潰れうる → 潰れ検出あり) |
| 長期間 | 刻みを粗くする(`horizon / PREDICT_MAX_STEPS`) | 粗くしない + `PLAN_ARC_MAX_STEPS`/呼び出し |
| 窓の解決 | 中点で1回/歩(中心天体窓は前歩から持ち越し) | start/mid/end の3時刻/歩(start は前歩の end とキャッシュ一致 → 実質2回/歩) |
| 衝突体 | 重力源と同じ配列(`mu≠0`、空間グリッド絞り済み ≈15体) | 別集合(`mu=0` 表示天体を含む全101体 + `predictedAsPlanCollider`) |
| 到達判定 | `reachedBody`(掃引+内包フォールバック、天体は1スナップショット) | ステップ先頭の `containingBody` + `findImpact`(天体位置を start→end 線形補間) |
| 焼失 | `burnUpBody(REENTRY_ALT)` | 同じ |
| 極値 | `ApsisTrack`(中心 = 初回の外挿中心天体) | `ApsisTrack`(中心 = `buildSegments` が選ぶ、末尾区間のみ) |
| サンプル間隔 | `max(局所周期/32, horizon/2000)` | `duration / 2000`(平坦) |
| bcInv / srp | entity 自身の値 | `C.SHIP_BCINV` / `C.SHIP_SRP_COEFF` 直書き |
| 外挿の尾 | `extrapolationCenter` を渡す(線が先端の先を継げる) | 渡さない |
| 予算 | フレーム予算・ラウンドロビン | 生成時は同期一括、以後 20000歩/呼び出し |

片方にしかない機能(接近項・刻み下限・粗化項・全天体衝突集合・掃引の精度・外挿の尾)は、
外挿の尾(§1-2 で計画側に禁止)を除きすべて両方に必要な機能として統一する。

---

## 4. 統一後の構造

### 4-1. 中核クラス: 統一 `PredictedArc`(`game/simulation/predicted-arc.ts`)

「凍結起点から要求終端へ向けて、呼ばれるたびに1歩だけ伸びる積分弧」。誰の弧か(実体の
予測列か、計画の1区間か)は知らず、無効化の判断も持たない。

```ts
export class PredictedArc {
  constructor(
    state0: KinematicState,
    sources: FutureAttractorProvider,        // §4-2
    opts: {
      bcInv: number; srpCoeff: number;
      excludeId?: AttractorId;               // 重力源から自分を除く(mu≠0 の entity)
      keplerTail: boolean;                   // 先端の先の二体外挿を許すか(実体=真、計画=偽)
      trackApsides: boolean;                 // 近地点/遠地点を溜めるか(計画の中間区間だけ偽)
    },
  );

  readonly state0: KinematicState;           // 凍結。以後動かない
  requiredEnd: number;                       // 所有者が毎フレーム書く(絶対時刻)
  retainFrom: number;                        // 保持窓の左端。所有者が毎フレーム書く
  readonly sourceRevision: number;           // 生成時の provider.revision

  get trajectory(): DynamicTrajectory;
  get truncated(): boolean;
  get impact(): BodyImpact | null;
  get apsides(): ApsisTrack | null;
  get apsisCenter(): Attractor | null;
  get needsGrowth(): boolean;                // !truncated && trajectory.state.t < requiredEnd
  get decimation(): number;                  // 要求した間引き下限の最粗値(represents 用)

  step(): boolean;                           // 1歩伸ばす。伸ばせなければ false
  represents(state0, end, sourceRevision): boolean;  // 計画側の使い回し判定(§4-4)
}
```

- `requiredEnd` / `retainFrom` の2つの可変フィールドが「horizon の end への一般化」の全て:
  - 実体の予測列: `requiredEnd = simTime + horizon`(毎フレーム前進)、`retainFrom = simTime`
  - 計画の区間:   `requiredEnd = segment.end`(ノードで固定)、`retainFrom = state0.t`
  - `keepDuration = requiredEnd - retainFrom` が保持窓・サンプル間隔・粗化項の分母を分岐なしで
    両対応にする(予測列で `state0.t` 起点にすると保持窓が生成時刻からの経過で無限に伸びる)。
- `step()` の中身が統合の本体: 刻み幅の決定(§5-1)→ 中点1回の窓解決(§4-2)→
  `DynamicTrajectory.step`(既存の物理はそのまま)→ 有限チェック → 掃引到達+焼失(§5-2)→
  `ApsisTrack.observe`。刻み幅の決定・窓解決・打ち切りが弧の中へ入り、`Predictor` は
  「予算がある限り `needsGrowth` な弧の `step()` を呼ぶ」だけになる。
- **中心天体窓の持ち越しはフィールド化する**: `advanceBudget` のローカル変数だった
  `centerWindow`(刻み幅と外挿中心の解決に使う前歩の中点窓)を弧のフィールドにする。
  予算スライスやフレームをまたいで持ち越され、最初の1歩の追加の窓解決も消える。
  半歩〜1フレーム古い窓が決めるのは刻み幅(RK4 が鈍感)と外挿中心(元から1歩古い)だけ。
- `ApsisTrack` の中心と外挿中心はどちらも「先端位置で最も強く引く**解析天体**」を初回 step で
  解決する(動的重力源が最強なら `ephemeris.gravityAttractorsAt` から選び直す — 現在の
  `Predictor` と同じ規則)。`buildSegments` が末尾区間のために毎フレーム選んでいた
  `apsisCenter` はこれに吸収され、`Segment` から消える。
- **起点側のインターフェイスは作らない。** 揃えるものは `KinematicState` 1つ(ノードは不変の
  `KinematicState` そのもの、実体は生成時の `entity.state`)なので、`state0` を受け取るだけで
  よい。`ArcOrigin` のような抽象は「早急な一般化」にあたる。ノードが動かないことの特別扱いも
  不要 — ノード起点の弧には乖離判定を呼ぶ主体がそもそもいない。

### 4-2. 窓プロバイダの統一: `FutureAttractors`(`game/simulation/future-attractors.ts`)

`plan/plan-attractors.ts` の `PlanAttractors` を改名・移動し、`predictedAttractorsAt` を削除して
予測側もこれを読む。`at(t)` は解析天体の窓(`Ephemeris.attractorsAt(t)`、101体)を1回だけ引き、
衝突体(全数 + `predictedAsPlanCollider` な entity)と重力源(`mu≠0` + 動的重力源)を同じ窓
から組む — この構造は現行のまま。revision の畳み込み(計画の編集・除外集合・各 entity の
予測の届き具合)も現行のまま。

変わる点:

- **1歩の窓解決は中点1回に統一される**ので、`HELD_SLOTS = 4` の時刻スロットキャッシュは
  消費者を失う(各歩の中点時刻は毎回一意で、start/end を引く者がいなくなる)。スロット機構は
  削除し、`at(t)` は毎回組む。同一フレーム内で同じ t を引く経路が残るかは実装時に確認し、
  残るなら1〜2スロットだけ残す(§14-1)。
- 返り値の配列・Map を**弧がフレームをまたいで保持する**(持ち越し窓)。プロバイダは返した
  配列を書き換えない契約(既存コメントに明文化済み)なのでそのまま成立するが、revision が
  動いた後の持ち越し窓は1歩だけ古い内容で刻み幅を決めることになる。許容(上記のとおり
  鈍感な量にしか使わない)し、契約をコメントへ書く。
- 所有は `Game` へ移す(`PlanEditor` と `Predictor` の両方が参照で共有し、`Predictor` の
  コンストラクタが先に走るため)。`resolve(...)` の呼び出しは入力(除外集合・plan.revision・
  planEnd)を知っている `PlanEditor.update` に残す。

### 4-3. `GameEntity` の変化

`stepPredicted` / `_predicted` / `_predictedApsides` / `_predictedImpact` / `truncated` /
有限チェック / 到達判定 / `sampleInterval` の予測側呼び出しが統一弧へ移る。残るのは:

```ts
private _predictedArc: PredictedArc | null = null;
get predicted(): DynamicTrajectory | null   { return this._predictedArc?.trajectory ?? null; }
get predictedApsides(): ApsisTrack | null   { return this._predictedArc?.apsides ?? null; }
get predictedImpact(): BodyImpact | null    { return this._predictedArc?.impact ?? null; }
get predictionTruncated(): boolean          { return this._predictedArc?.truncated ?? false; }
ensurePredictedArc(sources): PredictedArc | null;  // predictsFuture のときだけ遅延生成
invalidatePrediction(): void;               // _predictedArc = null
discardPredictionIfDiverged(...): boolean;  // 変わらず(divergenceTolerance ごと)
displayState(t, ephemeris?): ...            // 変わらず(getter 経由なので)
```

読者(`displayState` / `TrajectoryLine` / `DisplayWindowManager.predictionCoverageRatio` /
`FutureAttractors` の coverage)はすべて getter 経由なので無変更。
`sampleInterval` の式(`max(局所周期/TRAJECTORY_SAMPLES_PER_REV, keepDuration/MAX_SAMPLES)`)は
実軌道の履歴(`stepActual`)と統一弧の両方が使うので、小さな共有関数として
`game/simulation/` 側へ出し、両者が同じ1実装を呼ぶ。

### 4-4. `PlanPath` の変化

- 区間は `{ source: PredictedArc; from: number; to: number; owned: boolean }` の列になる。
  `owned` が真の区間は `PlanPath` が生成・破棄・`requiredEnd` 代入まで持つ。ノードを1つも
  持たない唯一の区間は自機の `ensurePredictedArc` の弧をそのまま借りる(`owned` 偽 —
  `requiredEnd` を書かず、破棄もしない)。`instanceof` 判定2箇所は `owned` に置き換わる。
- 読みは全て `arc-range.ts` の既存関数で `[from, to]` にクリップする(`stateAt` /
  `clipSamplesTo` / `withinEnd`)。`plan/predicted-arc.ts`(実体の予測列を区間として読む薄い
  ラッパ)はこの形に吸収されて消える。借りた弧の `apsides.dropBefore(from)` も区間組み立て時に
  `PlanPath` が呼ぶ(現在ラッパのコンストラクタが呼んでいるものと同じ)。
  `FinalSegment.samples` の参照同一性の契約は、クリップ結果の `(元配列, to)` メモ化を
  `PlanPath` 側の小さなヘルパとして残すことで維持する。
- `represents(state0, end, sourceRevision)` の判定は現行と同じ3条件(revision 完全一致、
  間引き下限の粗さ比較 `ARC_MAX_SAMPLE_COARSENING`、`state0` の参照同一性)。`apsisCenterId` の
  比較は消える(中心の解決が弧の中へ移ったため — §4-1)。**弧の作り直しはもう同期積分を
  伴わない**(空の弧を作るだけ)ので、作り直しのコストは「積分済みの中身を捨てて予算で
  伸ばし直す」ことに変わる。
- `setEnd` は `arc.requiredEnd = seg.end` の代入になる。伸ばすかどうかは予算パスの
  `needsGrowth` が判断する。

### 4-5. 消えるもの

| 消えるもの | 行き先 |
|---|---|
| `PlanArc`(クラス全体) | 統一 `PredictedArc` + `PlanPath` の区間レコード |
| `plan/predicted-arc.ts`(ラッパ) | `PlanPath` の `{source, from, to}` + `arc-range.ts` |
| `findImpact` / `containingBody` 前置 / `nearestByClearance` / dt潰れ検出 | `reachedBody` 1本(§5-2) |
| `stepDt`(plan-arc 内) / `advanceBudget` の刻み幅式 | 統一の刻み幅式(§5-1) |
| `predictedAttractorsAt` | `FutureAttractors.at` |
| `HELD_SLOTS` スロットキャッシュ | 削除(§4-2) |
| `PLAN_ARC_MAX_STEPS`(呼び出しごと打ち切り) | フレーム予算そのもの(§6-3) |
| `setEnd` の継ぎ足ししきい値 | 追い越しへの統一(§1-3) |
| `GameEntity.stepPredicted` ほか予測列の実装本体 | 統一 `PredictedArc` |
| `buildSegments` の `apsisCenter` 選択 | 弧の初回 step の解決(§4-1) |

---

## 5. 統一する規則

### 5-1. 刻み幅 — 接近項は動径接近率でなければ合成できない

統一形(`span = requiredEnd - retainFrom`):

```
naturalDt   = keplerPeriod(|tip.r - center.r|, center.mu) / ARC_STEPS_PER_REV   // 600
coarseFloor = span / ARC_MAX_STEPS                                              // 20000
approachDt  = min over 衝突体 of (clearance / radialClosingRate) × ARC_APPROACH_SAFETY
              // radialClosingRate = -dot(rel_r, rel_v)/|rel_r|。接近中(> 0)の天体だけ
dt = max(ARC_MIN_STEP_DT, min(span, approachDt, max(naturalDt, coarseFloor)))   // MIN = 20
```

- 軌道項は予測側の形(既に解決済みの `center` から `keplerPeriod` — `localOrbitPeriod` の
  再 `strongestAttractor` を払わない)。粗化項・下限・span 上限も予測側のまま。
- 接近項は計画側からの持ち込みで、**予測側の純増**(月フライバイ等、最強天体が地球のまま
  月の脇を数万秒刻みで通る経路の積分がまともになる)。ただし**現行の相対速さ
  (`|v_rel|`)基準のままでは粗化項と衝突する**: 円軌道の LEO でも `|v_rel|` は 7.66 km/s
  なので接近項が 27.4 s を返し、28日プリセットの粗化項 121 s を `min` で上書きして、予測の
  歩数が現状の 4.4 倍(2.42e6/121 ≈ 20,000 → /27.4 ≈ 88,000歩)に跳ねる。動径方向の
  接近率にすれば円軌道で接近項は消えて(接近していないのだから正しい)、現行予測の
  121 s がそのまま保たれる。衝突コースでは動径成分が支配的なので収束はそのまま、歩の中の
  弧のふくらみは掃引判定(`sweptHermiteSphereToi`)が Hermite で見ているので取りこぼさない
  (v6 C-3b と同じ論拠)。
- 刻み下限 20 s は接近項の幾何級数的な潰れ(Zeno)を殺す: clearance がどれだけ縮んでも
  dt は 20 s を下回らないため、衝突コースは必ず有限歩で表面を跨ぎ、掃引判定が交差点を
  補間で求める。**現行計画側の「dt ≤ 1e-9 になったら最寄り天体への衝突として記録」という
  潰れ検出パスは丸ごと不要になる。**

代表値(1周 = 1軌道周期あたりの歩数):

| 軌道 | 現行予測 | 現行計画 | 統一後 |
|---|---|---|---|
| LEO 420km(1周プリセット) | 279歩(20s床) | 204歩(接近項27.4s) | 279歩(20s床) |
| LEO(28日プリセット) | 20,000歩/全期間(121s) | — | 同左(接近項が消えるため維持) |
| GEO | 599歩(144s) | 100歩(862s) | 599歩 |
| 低月周回 | 353歩(20s床) | — | 353歩 |

### 5-2. 衝突・焼失判定 — `reachedBody` に一本化、対象は全天体+衝突体 entity

- **判定機構は予測側の `reachedBody`**(`physics/attractor.ts`、テスト済み): 掃引
  (`sweptHermiteSphereToi`)+ 開始時内包・零区間の離散フォールバック。計画側の
  `findImpact`(天体位置の start→end 線形補間)と `containingBody` 前置は削除する。
  1スナップショット(中点)に据えた天体との差は、接近項が効く近傍では1歩の間の天体移動 ≪
  半径であり、掃引区間に対して中点は終点より偏りが小さい(v6 第8章と同じ論拠)。
- **対象集合は計画側の `collision`**(`mu=0` の表示天体を含む全解析天体 +
  `predictedAsPlanCollider` な生存 entity)。実体の予測列にとって純増で、「予測線が質量未測定の
  小天体や小惑星をすり抜ける」が直る。掃引そのもののコストは約49ns/体(v6 §3-0)なので
  101体でも ~5µs/歩 — 窓(~300µs)に対して誤差。接近項の clearance ループも同じ集合を
  なめるが同オーダー。
- 焼失(`burnUpBody(r, collision, REENTRY_ALT)`)は両者とも同じなのでそのまま。

### 5-3. サンプル間隔・保持窓

予測側に揃える: `sampleInterval = max(局所周期 / TRAJECTORY_SAMPLES_PER_REV,
keepDuration / ARC_MAX_SAMPLES)`、`keepDuration = requiredEnd - retainFrom`。
計画側の平坦な `duration/2000` より短い区間で細かくなる(クリック候補が増える方向)。
`PLAN_ARC_MAX_SAMPLES` と `PREDICT_MAX_SAMPLES` はどちらも 2000 で既に一致。

### 5-4. 1歩のコストモデル(v1-T4 の node 実測に基づく導出。実測は別セッション)

| | 現行 | 統一後 |
|---|---|---|
| 予測1歩 | `gravityAttractorsAt`(64) 176.68 + 分類 15.09 + 近傍 0.53 + 物理 2.76 ≈ **195µs**(ゲーム実測 0.19ms/歩) | `attractorsAt`(101) 283.37 + 分類 15.09 + 掃引101体 ~5 + 物理 2.76 ≈ **306µs**(+57%) |
| 計画1歩 | 窓2回 + 候補集合の組み直し ≈ **0.61ms/歩**(v5 実測) | 同 **306µs**(−50%) |

- 予測側の +57% は「`mu=0` 天体と衝突体 entity を相手にした到達判定」の対価で、統一の
  意図的なコスト。これを取り返すのは v6 C-1(近傍天体リスト)の役割で、統一後はプロバイダ
  1箇所に差し込むだけで予測・計画の両方に効く形になる — C-1 より本作業を先にやる理由。
- 計画側の −50% は窓の二重解決と候補集合組み直し(v5 P-9 の約96%)の解消。
- LEO 1周ぶんの計画積分: 現行 204歩 × 0.61ms ≈ 124ms(1フレームのスパイク)→
  統一後 279歩 × ~0.31ms ≈ 86ms を予算で数フレームに分散。
- 28日プリセットの末尾区間: ~20,000歩 × ~0.31ms ≈ 6.2s 相当が、予算(§6)により
  1フレーム上限つきの漸進成長になる(例: 250歩/フレームなら ~80フレーム)。

---

## 6. 予算管理の一般化

### 6-1. 作業集合 — 所有者から毎フレーム引く(pull)

`Predictor.update` は弧の列を受け取る。登録制は弧の生存期間管理が増えるので採らない。

```ts
predictor.update(simTime, player, horizon, budget, planArcs);
//  planArcs: PlanPath が owned な弧を返す(borrowed = 自機の弧は含めない。実体側で数える)
//  budget:   Game がビューに応じて渡す(ARC_STEP_BUDGET / ARC_COMBAT_STEP_BUDGET)
```

- 乖離判定は**ビューに依らず全予測対象**に毎フレーム行う(1体につき二分探索1回で安価)。
  現行の戦闘ビューは操作艦しか判定しておらず、他個体の古い予測列が凍結されたまま
  `FutureAttractors` に読まれ続ける — この歪みも同時に直る。
- 成長の対象(実体側): マップビュー = 全予測対象。戦闘ビュー = 操作艦 +
  `predictedAsGravitySource || predictedAsPlanCollider` な個体。計画線は戦闘ビューでも
  描かれるので、その重力源・衝突体の予測は戦闘ビューでも伸ばす必要がある(通常ステージでは
  該当0体なのでコストも0)。main のマージで操作艦の読者が消えたら、この集合から操作艦を
  外すだけでよい。
- 計画側: `planArcs` は常に渡す(計画線は両ビューで描かれる)。

### 6-2. 配り方 — 現行の「自機優先+ラウンドロビン」の2層をそのまま一般化

1. **interactive**: 操作艦の弧 → 計画の弧(時刻順)。上限 `budget × ARC_INTERACTIVE_RATIO`
   (=0.5、現行 `PREDICT_PLAYER_BUDGET_RATIO` の一般化)。時刻順にするのは線が自機側から
   外へ伸びて見えるため(ノードは凍結状態なので区間間に計算上の依存は無く、順序は見た目
   だけの問題)。background が空なら interactive が全額を取る(現行の「他に誰もいなければ
   自機が全額」と同じ)。
2. **background**: 残額(interactive の使い残し込み)を他の実体へラウンドロビン。1体の
   取り分は残額の均等割りに `ARC_MIN_ITEM_STEPS`(=16)の下限 — 現行と同じ。

上限比が要るのも現行と同じ理由: 計画の弧は重力源・衝突体として他の実体の予測を読む
(プロバイダ経由)ので、編集直後の計画に全額を食わせると、計画の形自体が依存する予測の
成長が止まる。

### 6-3. 「終わった弧」と打ち切り規則の整理

- `needsGrowth = !truncated && tip.t < requiredEnd`。終端が前進する弧(実体)は追い越して
  止まり `simTime` が追いつくまで無消費、固定の弧(計画)は一度追い越したら以後無消費。
- `PLAN_ARC_MAX_STEPS` の「1回の呼び出しで上限に達し、かつ先端がサンプル1つぶんも進まなければ
  truncated」という潰れ検出は削除する。共有予算下では正常な弧が1フレームに数歩しか貰えない
  のが普通で誤爆するし、潰れの原因(接近項の幾何級数的収束)自体が刻み下限で消えている
  (§5-1)。打ち切りは「非有限」「到達」「焼失」の3つだけになる。

### 6-4. 負荷計の帰属

- `planSteps`(積分step)は `Predictor` が計画の弧ぶんを別枠で数えて答える。
  `predictorSteps` は実体ぶん。`planArcs`(再生成区間)は `PlanPath.lastRebuiltArcs` のまま。
  負荷確認ウィンドウの行の意味を保つ。
- `FrameSections` の `SECTION.plan` は区間列の組み立てと表示物の導出だけに、`SECTION.predict`
  が全ての積分成長(計画の弧を含む)になる。**測定の連続性が切れるので、過去の測定表と
  突き合わせるときは明示する。**

---

## 7. フレーム順序

現在 `predictor.update` は `advanceSimulation` の中にあり、ポーズ中とステージ決着後は呼ばれ
ない。一方 `editor.update`(いまの計画積分の駆動元)は無条件に走るので、ポーズ中・決着後も
計画を編集・表示できる。積分を予算パスへ移すなら、**予算パスも無条件でなければ退行する**
(ポーズはメニューを開いたまま計画を練る、決着後は結果画面の下で飛び続ける、どちらも実際の
利用形)。

```
Game.update:
  handleInput
  if (!paused && isPlaying) advanceSimulation   ← predictor.update をここから出す
  displayWindow = displayWindowManager.resolve(...)
  environment.update
  [SECTION.plan]    editor.update(displayWindow)   ← 区間列の確定・弧の生成/破棄/requiredEnd 代入
                                                      (積分しない)。provider.resolve もここ
  [SECTION.predict] predictor.update(...)          ← 全弧へ予算を配る(無条件)
  targeter.updateEquatorNodes / entities.updateBaseEquatorNodes
  cameraSystem.update
  mapPickables.refresh
  handlePointerInput
```

- 副作用として**ポーズ中も実体の予測が伸びる**。`simTime` が止まっているので乖離は起きず、
  止まっている間に予測が完成するだけ。害はなく、ポーズ解除直後の見え方はむしろ良い。
- `editor.update` 内で導出される表示物(アプシスアイコン・ゴースト・目盛・赤道交点)は
  そのフレームの成長**前**の弧を読む — 成長中だけ1フレーム遅れる。成長中に新しく見つかる
  極値が1フレーム遅れて現れるだけで、定常状態では差が無いので許容する(遅延評価への
  組み替えはしない — 消費者ごとに鮮度が食い違う方が悪い)。
- 乖離判定は積分後の実状態と突き合わせる必要があるが、新しい位置は `advanceSimulation` の
  後なので満たされる。

---

## 8. 定数の統合表

| 統一後 | 統合元 | 初期値 | 備考 |
|---|---|---|---|
| `ARC_STEPS_PER_REV` | `PREDICT_STEPS_PER_REV`(600)/ `PLAN_ARC_STEPS_PER_REV`(100) | **600** | 予測側の現行値。チューニングは統一後(§12) |
| `ARC_MIN_STEP_DT` | `PREDICT_MIN_STEP_DT`(20) | 20 | 低月周回の精度が根拠(既存コメントを引き継ぐ) |
| `ARC_MAX_STEPS` | `PREDICT_MAX_STEPS`(20000) | 20000 | 粗化項の分母。`PLAN_ARC_MAX_STEPS`(呼び出し打ち切り)は消滅 |
| `ARC_MAX_SAMPLES` | `PREDICT_MAX_SAMPLES` / `PLAN_ARC_MAX_SAMPLES`(共に2000) | 2000 | 値は既に一致 |
| `ARC_MAX_SAMPLE_COARSENING` | `PLAN_ARC_MAX_SAMPLE_COARSENING`(8) | 8 | `represents` 用。名前だけ揃える |
| `ARC_APPROACH_SAFETY` | plan-arc モジュール内 `APPROACH_STEP_SAFETY`(0.5) | 0.5 | `const.ts` へ移す。基準は動径接近率(§5-1) |
| `ARC_STEP_BUDGET` | `PREDICT_STEP_BUDGET`(500) | 500 | 統一後の per-step コストで ms から再導出(§12) |
| `ARC_COMBAT_STEP_BUDGET` | `PREDICT_COMBAT_STEP_BUDGET`(128) | 128 | main マージで戦闘ビューの読者が減れば縮小・削除の候補 |
| `ARC_INTERACTIVE_RATIO` | `PREDICT_PLAYER_BUDGET_RATIO`(0.5) | 0.5 | 意味が「自機」→「操作艦+計画」へ広がる |
| `ARC_MIN_ITEM_STEPS` | `PREDICT_MIN_ENTITY_STEPS`(16) | 16 | background の下限。変更なし |

削除: `PLAN_ARC_STEPS_PER_REV` / `PLAN_ARC_MAX_STEPS` / `PLAN_ARC_MAX_SAMPLES` /
`setEnd` のしきい値。`PREDICT_RESET_DIST` / `PREDICT_SAMPLE_ERROR` /
`TRAJECTORY_SAMPLES_PER_REV` は乖離判定・履歴と共有の値なので名前を変えない。
`PLAN_ARC_DASH_PX` / `_GAP_PX` / `_OPACITY` は描画側で対象外。
**正味: 定数4個減、刻み規則が2本→1本。**

---

## 9. 命名

| 対象 | 名 | 理由 |
|---|---|---|
| 統一弧クラス | `PredictedArc`(`game/simulation/predicted-arc.ts`) | 既存語彙。計画の1区間も「そのノードから先の自由伝播の予測」なので読みが合う。現 `plan/predicted-arc.ts`(ラッパ)は §4-4 で消えるので衝突しない |
| プロバイダ | `FutureAttractors` / `FutureSourcesAt` / `FutureAttractorProvider`(`game/simulation/future-attractors.ts`) | 計画専用でなくなる。「未来時刻の重力源と衝突体」を素直に言う |
| 予算管理 | `Predictor` のまま | 扱う弧が増えても「未来を予測する」責務は同じ |

旧名(`PlanArc` / `PlanAttractors` / `PlanSourcesAt` / `PlanAttractorProvider` /
`predictedAttractorsAt` / `stepPredicted` / `PLAN_ARC_*` / `PREDICT_STEPS_PER_REV` 等)は
**全文検索して 0件**にする。互換エイリアスは残さない。

---

## 10. 段階実装計画

各フェーズ末で `npm run typecheck` を通す。`src/physics/` には一切触れない
(`DynamicTrajectory` / `reachedBody` / `arc-range` 相当の機構は全て既存のまま使う)ので、
`npm run test:physics` は原則不要 — 最終フェーズで1回だけ保険に回す。
各フェーズはそれぞれ1コミットが通る粒度。

### Phase 1 — プロバイダの一本化(挙動不変、コストのみ変わる)

- `plan/plan-attractors.ts` → `game/simulation/future-attractors.ts` へ移動・改名(§9)。
- 所有を `Game` へ移し、`PlanEditor` と `Predictor` に参照で渡す。`resolve(...)` の呼び出しは
  `PlanEditor.update` のまま。
- `predictedAttractorsAt` を削除し、`Predictor.advanceBudget` の窓解決2箇所を
  `provider.at(t)` の `gravity` / `classified` 読みに置き換える。
- 挙動は不変(予測の重力源集合は同じ)。1歩の窓が 64体→101体になるコスト変化だけが入る。

### Phase 2 — 統一弧クラスを作り、実体側を載せ替える(実体の挙動が変わる)

- `game/simulation/predicted-arc.ts` に統一 `PredictedArc`(§4-1)。刻み幅(§5-1、動径基準の
  接近項込み)・掃引到達(§5-2、衝突体集合込み)・サンプル間隔(§5-3)・持ち越し窓を実装。
- `const.ts` に `ARC_*` を置き、`PREDICT_STEPS_PER_REV` 等を改名(§8)。
- `GameEntity` を §4-3 の形に(`stepPredicted` 削除)。`Predictor.advanceBudget` は
  `needsGrowth` / `step()` のループになる。
- ここで実体の予測の挙動が変わる: 接近項の追加、`mu=0` 天体・衝突体 entity での終端。
  変化は §11 の一覧のとおり。

### Phase 3 — `predictor.update` を `advanceSimulation` の外へ(小さく独立)

- §7 の位置へ移し、無条件で呼ぶ。乖離判定を全予測対象に広げ、成長対象の集合を §6-1 の
  規則にする(`mode` 引数は廃止し、Game が予算と実体集合の選別を渡す)。
- ポーズ中・決着後に実体の予測が伸びるようになる(それだけ)。

### Phase 4 — 計画側を載せ替える(スパイクが消える)

- `PlanPath` を §4-4 の形に(区間レコード化、`PlanArc` / `plan/predicted-arc.ts` 削除、
  クリップ読みへの置き換え、`represents` の3条件化、`buildSegments` の `apsisCenter` 削除)。
- `PlanPath.growableArcs()` を `Game` 経由で `predictor.update` へ渡し、§6-2 の interactive /
  background 配分を入れる。`PLAN_ARC_MAX_STEPS` と `setEnd` しきい値を削除。
- 負荷計の帰属を §6-4 のとおり付け替える。
- ここで計画の挙動が変わる: ノード設置・Δv 編集後、線は1フレームで描き切られず予算ぶんずつ
  伸びる。終端は追い越し+クリップ読み。刻みは統一規則。

### Phase 5 — 文書と後始末

- `/develop-docs`: CLAUDE.md(`Predictor` / `plan/` / `GameEntity` / `game.ts` のフレーム順 /
  定数)、`DEVELOP/CALLSTACK.md`(update 順序)、`DEVELOP/OWNERSHIP.md`(弧とプロバイダの
  所有)、`DEVELOP/SPEC.md` — 計画側の「ステップ幅を無理に粗くしない・届かなければ途切れる」
  の記述を「予測と共通の刻み規則(粗化項込み)。計画の線は積分済み範囲だけを描き、外挿では
  継がない。ノードは積分済み範囲にのみ置ける。編集直後の線は数フレームかけて伸びる」へ
  書き換える。
- `/comment-cleanup` を変更ファイルに通す。旧名の全文検索 0件を確認する。
- `npm run test:physics` を保険に1回。
- `predict_todo.md` の「計画側に独立予算」の旧判断はこの計画で置き換わる — 完了時に整理する。

---

## 11. 挙動が変わる点とリスク

| # | 変わること | 評価 | 対処 |
|---|---|---|---|
| R-1 | ノード設置・Δv 編集後、計画線が予算ぶんずつ伸びる(スパイクの分散 — 意図した変化)。伸び切るまでノード追加・Δv 表示はその範囲に限られる | 意図 | 編集 UI は保持サンプル基準なので構造的に安全(§1-2)。28日級の末尾区間は伸び切りに ~80フレーム(§5-4) — 見え方は実装後に確認(§14-2) |
| R-2 | `represents` 不一致(編集・revision 変化)で弧を作り直すと、積分済みの中身も捨てて伸ばし直しになる | 小 | 予測列の乖離破棄と同じ UX。破棄は無料で、次フレームから予算で再成長 |
| R-3 | ノード到着状態(Δv 表示)が clamp 着地から補間読みになる | 小 | 誤差は折れ線の補間誤差と同量で、刻みが細かくなるぶん現状より小さい |
| R-4 | 計画の刻みが 100→600歩/周(コストは窓半減と相殺、LEO では純減。GEO では純増) | 中 | 弧の積分は編集直後だけ。実測後に `ARC_STEPS_PER_REV` を1箇所で詰める |
| R-5 | 予測1歩の窓が 64→101体(+57%/歩) | 中 | `mu=0` 天体・衝突体での終端の対価。v6 C-1 がプロバイダ1箇所で両者から取り返す(§5-4) |
| R-6 | 実体の予測線が `mu=0` 天体・小惑星で止まるようになる | 修正 | すり抜けの解消 |
| R-7 | 予測に接近項が入り、天体近傍で歩数が増える | 小 | 動径基準なので円軌道では効かない(§5-1)。フライバイの積分がまともになる対価 |
| R-8 | 到達判定の天体位置が start→end 補間から中点スナップショットへ | 小 | 接近項の効く近傍では1歩の天体移動 ≪ 半径。掃引区間に対して中点は偏りが小さい |
| R-9 | ポーズ中・決着後も予測が伸びる | 小 | 害なし。ポーズ解除直後の見え方が良くなる |
| R-10 | 成長中、アプシスアイコン等の表示物が1フレーム遅れる | 小 | 定常状態では差なし(§7) |
| R-11 | `SECTION.plan` / `SECTION.predict`、`planSteps` の意味が変わる | 測定 | 過去の測定表と突き合わせるとき明示(§6-4) |
| R-12 | 弧が provider の配列をフレームをまたいで保持する | 中 | provider は返した配列を書き換えない契約(既存)。コメントで明文化(§4-2、§14-1) |

---

## 12. 測定(実装後、別セッションの条件を引き継ぐ)

v5/v6 の測定条件(`stage1-map`、`?perf=1`、ラウンド中央値、ms より離散カウンタを主指標)を
そのまま使う。各フェーズ後に:

1. `計画` / `予測` / `積分` の ms と `plan-steps` / `pred-steps`(avg ≒ max は「毎フレーム
   作り直し」の兆候 — 従来どおりの読み方)。
2. **per-step コスト(ms ÷ steps)** — 統合の効果が最も素直に出る。目標: 計画側 0.61 →
   予測側なみ(~0.3)。予測側の +57%(§5-4)が実測でどの程度かもここで見る。
3. 固有条件: ノードを1本置いた直後の数フレーム(スパイク→漸進成長)、Δv アームのドラッグ中、
   28日プリセット × ×1(旧 v5 P-1 条件)。

**ノブの再導出**: `ARC_STEP_BUDGET` は「1フレームに使ってよい ms ÷ 実測 per-step コスト」で
決め直す。時間ベースの打ち切りにはしない(フレームレート依存で非決定になり、再現性を壊す)。
`ARC_STEPS_PER_REV` / `ARC_MAX_STEPS`(= A-7 の遠端精度)もここで詰める — 統一により
1箇所の変更が両方の線に効く。

---

## 13. やらないこと

- **`Simulator` の積分器との統合** — 同時性が問題構造を別物にしている。範囲外。
- **計画の弧へのケプラー外挿の尾** — §1-2。次のノードへ繋ぐ責務と両立しない。
- **A-7 の値決め**(遠端精度をいくらで買うか)— 統合でノブが1つになるのが本作業の利得で、
  値は §12 の実測後に決める。
- **`ArcOrigin` のような起点抽象** — 揃えるものが `KinematicState` 1つしかない(§4-1)。
- **予測と計画の独立予算** — §2 の最終行。
- **v6 の B-1 / B-1b / B-2 / C-1** — 直交する。ただし C-1 は本作業でプロバイダが1本化された
  後のほうが入れやすい(1箇所に差し込めば両方に効く)ので、本作業を先に済ませる。

---

## 14. 未確認事項(着手前〜実装中に潰す)

1. **プロバイダの配列のフレーム跨ぎ保持**(持ち越し窓、R-12): `FutureAttractors.at()` が
   返す配列と、その元になる `Ephemeris` のリングキャッシュ配列が、生成後に書き換えられない
   ことの再確認(コメント上は契約済み。リングの追い出しは差し替えであり破壊ではないはず)。
   併せて、スロットキャッシュ削除後に同一フレーム内で同じ t を引く経路が残っていないかを
   確認する(残っていれば1〜2スロットだけ戻す)。
　　→　正直、現時点ではどうすべきか確定できない。実装しながら、最適な方法を考える。また、Ephemerisキャッシュのヒット率自体悪い可能性があるので、ここの構造は丸ごと変わる可能性がある。いずれにせよ、キャッシュの整合性維持はEphemeris側に隠蔽されるべき責務であるため、外側からはキャッシュが正しい前提で使うべき。

2. **28日級の末尾区間の成長の見え方**: ~80フレームかけて伸びる線が編集感覚として許容か。
   許容できなければ interactive 側の配分やノブで調整する(構造は変えない)。
   → 許容できる
3. **v5 P-1 の未解明**(×1・28日で毎フレーム ~2,000歩しか回らず 20,000 上限に届かなかった):
   旧経路の消滅で追う必要はなくなるが、現行計画側のコストモデルに未解明が残っていたことは
   §5-4 の見積りの不確かさとして踏まえる。
   本件実装後に対策。
4. **別セッションのベースライン実測**: 本計画の見積り(§5-4、§11)は v1〜v6 の node 実測と
   モデルに乗っている。統一前後の比較はそのベースラインに対して取る。
　　本件実装後に対策。
# 予測と実シミュレーションの統合 — 達成確認と後処理

`e8a3fe7` から `0eae0b41`(workspace4)までの一連の変更について、**当初の目的が漏れなく
達成されているか**を当て、**残っている整理の余地**を洗い出す。

この文書は判断のための材料であって、仕様でも設計でもない。決まったことは
`DEVELOP/SPEC/` へ、現状はコードへ書く。

---

# 第0章 この文書の扱い方

- 第1章は**経緯の要約**。**役目を終えた計画は全部削除したので、経緯の残る場所はこの章と
  git の履歴だけである**(1-4 に commit 範囲を置いた)。**この章だけは「何をやったか」の
  記録であり、他章と役割が違う。**
- 第2章は**達成確認**。目的の出どころは当初の計画と、そこから分かれた4つの計画の達成目標。
  当てた根拠を添える。引用した目標は当てるのに要るぶんをここへ写してあるので、
  削除した計画を引き直さなくても読める。
- 第3章・第4章は**コードから引いたスナップショット**。判断材料であって正本ではない。
- 第5章は**提案**。まだ決定ではない。第2章で「達成済み」と判定したものの周辺に残った
  残骸・非対称・検証の穴だけを挙げる。新機能は含めない。

---

# 第1章 経緯の要約

## 1-1. 発端 — 予測が飛行そのものになった

**「ある時間帯の状態を決める積分は、常にちょうど1本だけ存在する」**という規則が入り、
引力だけで飛ぶ物体は、その時刻が既に予測として伸びていれば実シミュレーションがその予測を
そのまま辿るようになった(`GameEntity.followPredicted`)。

この時点で、**予測の誤差は線の見た目の問題ではなく、実際の飛行そのものの誤差**になった。
ところが `Simulator` と `Predictor` は「同じ物体を1歩進める」処理を別々に持っており、
天体の窓・接触の判定・刻みの規則・大気の扱いが揃っていなかった。**本質的に違う物理を
積んでいる2本が、1本の飛行の前半と後半を分担している**状態を解消する必要があった。

## 1-2. 揃えないと決めたもの

両者の役割の違いは2点しかなく、**そこから出ている差は揃えてはならない**。

| | 実シミュレーション | 予測 |
|---|---|---|
| **同時性** | 生存する全個体を同じ1つの瞬間で同時に進める。だから絞り込みを substep に1つ組んで全個体で使い回せるし、個体どうしの接触も解ける | 選ばれた少数の弧を1本ずつ、それぞれ別の先端時刻で伸ばす。共通の瞬間が無い |
| **刻みの決まり方** | 毎フレーム `simTime + simDt` へ必ず到達しなければならない | 追い越されない範囲で伸びればよい。予算で切って足りなければ遅れる |

**目指したのは対称性ではない。** 吸収するのはこの2点に由来しない差だけで、それを全部
吸収しても両者は同じ形にならない。

## 1-3. 着陸機能が範囲を広げた

天体への着陸を後から実装できる基盤にするには、天体との接触が**剛体接触として**解決され、
接触の帰結が多態(`collideWith`)だけで決まっている必要がある。ところが当時の天体接触は
3箇所で判定されており、しかもそのうち2箇所は「大気での焼失」と同じ `margin` という数値へ
混ざっていた。**焼失(連続量の状態)と衝突(離散事象)を分ける**ために `atmosphere` の
一般化まで範囲が広がった。

## 1-4. 5つの計画に分かれて実施した

かつての計画ファイルはすべて `memos/hedalu244/` に置かれていた。**`unite_sphere_contact.md`
以外は役目を終えたので削除してある** — 中身を読み直すなら、下の commit 範囲から git で引く。

| 計画 | 範囲 | commit 範囲 |
|---|---|---|
| `remove_asteroid.md` | `Asteroid` 型と「重力を及ぼす `GameEntity`」の基盤を全廃 | `b505d7fe` 〜 `960498c1` |
| `fix_atmosphere.md` | 大気を天体のパラメータにし、焼失と衝突を分ける | `a88e2329` 〜 `febb162a` |
| `sphere_contact_interface.md` | 判定器の I/F — 始点の内外と跨ぎの向きを返す。天体を区間の間に動かす。`margin` 削除 | `58a006bc` 〜 `3d642946` |
| **`unite_sphere_contact.md`(残す)** | 解法の決着(実測して「常に三次」)。`SweptMode` 削除。**8章が 2-4 の未決事項の判断材料** | `6dbd7c63` 〜 `e6838031` |
| `unite_predict_simulation.md` v1→v2→v3 | 呼び出し経路の統一。時間加速と物理の切り離し、天体側の絞り込み、質量とダメージの分離 | `064b2762` 〜 `f68be2c3` |

途中で `116d3b9f`(掃引の入口を1つにする)と `7f658b2e`(弾の地表到達を点判定から掃引へ)が
先行して入っている。v1 の段2 に相当する部分で、計画の分割より前に片付いた。

**以降、削除した計画を指すときは v1 / v2 / v3(`unite_predict_simulation.md` の各版)と略す。**
添えた節番号はその版のもので、上の commit 範囲から git で引ける。ただし**引かなくても読めるよう、
判断に要る中身はこの文書へ写してある。**

## 1-5. 各計画が何を変えたか(要約)

**Asteroid 廃止。** 重力源も表面を持つ相手も `Attractor` だけになった。`GameEntity` は `mu` を
持たず、個体どうしが相互作用する経路は剛体接触だけになった。弧が引く候補から動的個体が消え、
「天体暦で引けるか」「表面到達の相手か」という候補ごとの区別が恒真・恒偽へ潰れた。
`predictedAsPlanCollider` / `consumesPrediction` / `mergeAttractors` / `excludeId` も
一緒に消えた。

**大気のパラメータ化。** `atmosphere.ts` から固有名詞が消え、大気の有無・密度モデル・基準
楕円体・自転が天体ごとのパラメータになった。高度は真球の平均半径ではなく基準楕円体から測る
(緯度による密度の 45 倍のずれが消えた)。焼失は高度ではなく**耐えられる大気密度の上限**で
判定するようになり、`PLAYER_MIN_ALT` / `DEBRIS_REENTRY_ALT` は削除された。
**弧は焼失を判定しない**と決めた — 姿勢も熱の蓄積も運んでいないので原理的に当てられず、
当てられない量を近似で埋めると実体側と値を揃え続ける保守が発生するため。

**判定器の I/F と解法。** 戻り値が `{ startsInside, crossing }` になり、`containingBody` に
よる点判定のフォールバックが不要になった。天体は区間の間ちゃんと動く(`attractorStateAt`)。
`margin` は仕様の側にも余地が無いので消えた。解法は3つ(弦・二次・三次)を実測で比べ、
**棄却経路の費用が弦の 2〜3 倍にしかならない**ことを根拠に**常に三次**へ決着した。

**呼び出し経路の統一(v3)。** ここが本体。

- **時間加速が物理を変えるのをやめた。** `surfaceBodies` の 101↔65 切り替えと
  `passiveWarpLod` を廃止し、残した倍率ゲートは「物体どうしの接触を解くか」1つだけ。
- **天体を相手にする絞り込みを実シミュレーション側へ入れた**(`surface-candidates.ts`)。
  2段構えで、1段目は substep に1回・天体数に比例するが個体数には比例しない。実測で
  1段目を通る天体は平均 1.00 体/substep。掃引呼び出しは 300 万回 → 5,661 回へ落ちた。
- **天体接触を接触経路へ一本化した。** `checkLoss` から表面到達が消え、天体接触は倍率にも
  種別にも `collides` にも依らず全生存個体が参加する。天体は反作用を受けないので個体ごとに
  独立に解け、解決順序の大域ループも件数の上限も要らない。
- **不動であることを質量 ∞ で表すのをやめた。** 解析天体は質量を持たず、接触解決の入口を
  「双方が動く」と「相手が不動」へ分けた。ゲームオブジェクトの質量は 0(試験粒子)から
  ∞(基地)まで通る。薬莢・破片・弾薬ピックアップは質量 0 になり、触れた相手の予測弧が
  捨てられなくなった。
- **ダメージの根拠を力積から接近速度と相手種別へ移した。** `impulse` は `Contact` からも
  `CollisionResponse` からも消えた。しきい値は逆算元の 50 / 500 m/s へ戻った。
- **弾・破片のまとめ積分を廃した**(最後の `f68be2c3`)。廃止の理由は費用ではなく、1歩が
  最高倍率で約9時間 = 低軌道 6 周回になり、その区間を三次曲線で表すと制御点が実際の軌道
  から飛び出して偽陽性と偽陰性の両方が出るという**物理的な誤り**。

---

# 第2章 現状報告 — 達成確認

**`0eae0b41` 時点。** `npm run typecheck` 通過、`npm run test:physics` 459/459 通過。

## 2-1. 当初の目的(v1 由来)

| 目的 | 判定 | 根拠 |
|---|---|---|
| **Simulator と Predictor が本質的に違う物理を積んでいる状態の解消** | **達成** | RK4(`stepDynamics`)・掃引の幾何(`sweptSphereContact`)・刻みの規則(`simulationMaxStep` / `reentryAwareMaxStep`)・間引きの式(`trajectorySampleInterval`)を両者が共有。残る差は窓の**探し方**と結末の出力先だけで、どちらも 1-2 の役割の違いに由来する |
| **Asteroid の廃止 / GameEntity は接触以外で影響を及ぼさない** | **達成** | `Asteroid` `asteroid` の一致 0 件。`GameEntity` に `mu` が無く、重力窓は `Ephemeris` からしか出ない |
| **Predict と Simulation で積分する重力場が食い違いうる状況の是正** | **達成(測定済み)** | `gravity-window-agreement.test.ts` 4件。実測の最大差 5.87e-9 m/s²(許容量 1e-8 の 0.587 倍)。式は動かしていない |
| **大気の一般化(地球ハードコードの解消)** | **達成** | `atmosphere.ts` に `earth` / `EARTH` が 0 件。`AtmosphereDef` は基準楕円体・自転・層を自分で持つ |
| **剛体接触と大気を別物として区別** | **達成** | 焼失は `burnUpBody`(密度の点判定)、衝突は `sweptSphereContact`(掃引)。相手も(大気天体 / 全天体)、死因も(`'burnup'` / `'collision'`)、パラメータも別 |
| **着陸機能の基盤** | **達成(基盤のみ)** | `Contact` は `t` / `point` / `normal` / `selfState` / `otherState` を運ぶ。`impulse` は落としたので、材料は撃力へ潰す前の状態と法線だけになった。着陸そのものは未実装(意図どおり) |
| **掃引衝突判定の呼び出し口と実装の一元化** | **達成** | 掃引の幾何は `sphere-contact.ts` 1箇所。入口は `sweptSphereContact` 1つで解法の引数は無い |
| **Simulator と時間加速度の密結合の解消** | **ほぼ達成**(5-1 A-6) | `passiveWarpLod` 0 件、`surfaceBodies` の切り替え無し。残るゲートは `canResolvePhysicalCollisions` 1つで、SPEC が根拠を明記している |
| **Simulator が内部で種別判断していたのを廃止** | **一部残**(5-1 A-7 / A-8) | 積分(`substep`)は `entities.all()` を種別で分けずに回す。ただし `stepAttitudes` と `adaptiveMaxStep` は種別ごとのコレクションを名指ししたまま |
| **SpatialGrid の利用拡大・計算量削減** | **達成** | 天体側は `SurfaceCandidates` の2段絞り込み(グリッドではなく境界体積 — 天体半径が7桁ちがうため一様グリッドを使わない、と v3 4-3 で決めた)。個体側は従来どおり 27 近傍 |
| **Simulator と Predict で共通化すべき挙動の外部化** | **達成** | 上記のとおり。**「式は1本、引数は呼び出し側」**の形が保たれている |

## 2-2. 期待された現状 — 物体の2分類

> 解析的な天体は mu を持ち質量を持たない / GameEntity は質量を持ち重力を持たない

**達成。**

- `Attractor` に質量のフィールドは無い。`invMass: 0` の綴りが `src/` に 0 件。
  天体との接触は `resolveFixedSphereCollision` を通り、**質量を引数に取らない**。
- `GameEntity` に `mu` は無い。`isAttractor(target)` が `'mu' in target` で判定できるのは
  この非対称そのもの(ただし 5-2 B-4)。
- 質量は 0(薬莢・破片・欠片・弾薬)・正(弾・艦・敵)・∞(基地)を取り、
  `collision-response.test.ts` が 0×正 / 0×0 / 0×天体 / 双方不動の4通りを固定している。
- 基地の不動は `Base.contactMass = Infinity` で表され、**天体の不動とは別の機構**のまま
  同じ分配の式を通る。`contact.ts` に「基地は動かさない」の直書きは無い。

## 2-3. v3 の達成目標 20 件

| # | 目標 | 判定 |
|---|---|---|
| 1 | 天体接触の判定が1経路 | **OK** — `checkLoss` 系に `reachedBody` 0 件。残る読み手は `PredictedArc.checkSurfaceReach` だけ |
| 2 | 喪失理由がワープ倍率に依らない | **OK** — `lossReason(other)` が相手の種別だけで決まる。倍率を見る枝が無い |
| 3 | ×4 超でも天体をすり抜けない | **OK(構造として)** — `resolveSurfaceContacts` は倍率ゲートの外で毎 substep 走る。実行時確認は 5-3 C-3 |
| 4 | `mu = 0` の天体にも表面判定が効く | **OK** — `surfaceBodies()` = `attractorsAt`(登録天体の全数) |
| 5 | `collides` は個体どうしだけを支配 | **OK** — 天体側の参加条件は `alive && attachedTo === null && 有限` |
| 6 | 物理が `simSpeed` で変わらない | **OK** — ゲートは1つ、SPEC 記載どおり |
| 7 | 同じペアを同じ substep で2回判定しない | **OK** — 掃引が走るのは `resolveSurfaceContact` の1回だけ |
| 8 | 掃引呼び出しが天体数に比例しない | **OK** — 実測 300 万 → 5,661 回/フレーム(3.3 %) |
| 9 | フレーム時間が着手前より改善 | **OK** — 871.9 ms → 355.6 ms(2.45 倍速い) |
| 10 | ダメージが質量に依らない | **OK** — `impulse` が `src/` に 0 件。`contactDamageSpeed` は接近速度 × 種別の重み |
| 11 | 質量 0 で非有限値が出ない | **OK** — テスト4件 |
| 12 | 解析天体の質量が現れない | **OK** — `invMass: 0` 0 件 |
| 13 | 重み 0 が判定から外れていない | **OK** — 参加条件は `contactMass >= 0`。重みが掛かるのは `contactDamageSpeed` の1箇所だけ |
| 14 | 薬莢・破片が艦の予測を捨てさせない | **OK(構造として)** — 質量 0 + `replaceIfMoved` / 天体側の同等ガード。実行時確認は 5-3 C-3 |
| 15 | 再突入細分化の2定数が1箇所 | **OK** — `reentryAwareMaxStep` の内側だけ |
| 16 | 表面を持つ天体の窓の定義が1箇所 | **OK** — `Simulator.surfaceBodies()` |
| 17 | 重力窓の差が許容量以下 | **OK** — 実測 5.87e-9 |
| 18 | `Contact` の情報が減っていない | **OK(型として)** — 5フィールドとも健在。`impulse` だけが意図どおり消えた |
| 19 | 否定形の種別判定が残っていない | **OK** — 天体かどうかを問う4箇所すべてが `isAttractor` |
| 20 | `passiveWarpLod` の判断が記録されている | **OK** — v3 第11章。廃止、根拠は費用ではなく物理的な誤り |

## 2-4. 未決・保留として残っているもの

| 項目 | いまの状態 |
|---|---|
| 掃引をほぼ直線の区間で弦へ落とす分岐 | **保留のまま。`SPEC/ORBIT.md`「未確定の案」に記載済み。** 判断材料(分岐基準の妥当性・過小評価 2.3×・半径和の母集団)は `unite_sphere_contact.md` 5章・8章に、実測は `tests/perf/exp10` `exp11` にある。`linearSphereContact` / 二次 / `sweptSagitta` はそのための余地として残してある |
| `base-collision.ts` のワープ倍率 LOD | **到達不能のまま据え置き**(v3 で明示的にそう決めた)。基地の仕様が固まるまで触らない |
| 相対速度ゼロで天体の内側に湧いた個体 | **塞いでいない。** 着陸(接地したまま留まる状態)を実装するときに同じ穴をまとめて塞ぐ |
| 静止接触の安定化 | `SPEC/ORBIT.md`「未確定の案」に記載済み |

---

# 第3章 呼び出し経路(`/callstack`)

**`0eae0b41` 時点のコードから引いたスナップショットであり、正本ではない。** 食い違ったら
コードを信じる。

## 3-1. 実シミュレーション

```
Simulator.advance(dt, simDt, player, activeStage, simSpeed, nanWatchdog)
                       …… Game.advanceSimulation から毎フレーム1回(ポーズ中・決着後は呼ばない)
├─ simSpeed.canResolvePhysicalCollisions   ← 残った唯一の倍率ゲート。simSpeed ≤ ×4 で true
├─〔substep ループ〕                       …… targetTime に届くまで。最大 SUBSTEP_MAX_COUNT(64)回
│  ├─ Simulator.adaptiveMaxStep(simDt)
│  │  ├─ Ephemeris.atmosphereAttractorsAt(simTime)            (大気天体の窓 — 既定 1 体)
│  │  └─ time-step.ts  reentryAwareMaxStep(生存する艦・敵の状態列, 大気天体,
│  │        simulationMaxStep(simDt, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT))
│  │        ← 境界高度と細分化刻みの2定数は関数の内側。対象集合だけが呼び出し側
│  ├─ Simulator.nextEventTime(activeStage)
│  │  ├─ Stage.nextSimulationEventTime
│  │  └─ Simulator.entityEventTime → GameEntity.nextSimulationEventTime
│  │        …… 顔ぶれの世代が変わったときだけ全走査。種別で外すものはもう無い
│  ├─ time-step.ts  simulationStepDuration(simTime, targetTime, maxStep, eventTime)
│  ├─ Ephemeris.gravityAttractorsAt(substep 中点)              (重力窓 — mu≠0 の 65 体)
│  ├─ Ephemeris.atmosphereAttractorsAt(substep 中点)
│  ├─ Simulator.substep(subDt, sources, atmosphereSources)
│  │  ├─ attractors.ts  classifyAttractors(sources)  ← substep に1回だけ組み、全個体で共有
│  │  └─〔全個体〕                                   …… 種別で分けない
│  │     ├─ attractors.ts  attractorsNearInto(e.state.r, classified, out)
│  │     ├─ GameEntity.followPredicted(t, near)  …… 弧が t を持てば積分せず先端を差し替える
│  │     └─ GameEntity.stepActual(dt, near, nearestAtmosphereBody(e.state.r, atmosphereSources))
│  │        └─ DynamicTrajectory.step → dynamics.ts  stepDynamics   ← RK4。**弧と共有**
│  ├─ Simulator.stepAttitudes(subDt) → attitude.ts  stepAttitude
│  │        (players / enemies / bases / casings / debris / ammoPickups を種別ごとに列挙)
│  ├─ Simulator.surfaceBodies() = Ephemeris.attractorsAt(simTime)
│  │        ← 表面を持つ天体の窓。登録天体の全数 101。**倍率で切り替えない**
│  ├─ Player.stepEnvironment(subDt, ephemeris, simTime, surfaceBodies)
│  │        (熱・電力・放熱板。**恒星の取り出し・日照率の遮蔽体・最寄りの大気天体に同じ窓**)
│  ├─ ContactPhysics.resolveSurfaceContacts(simTime, entities.all(), surfaceBodies, activeStage)
│  │        …… 倍率にも種別にも collides にも依らず毎 substep。物体どうしより先に解く
│  │  ├─ ContactPhysics.collectSurfaceParticipants  ← alive && attachedTo === null && 有限
│  │  │        (接触代理 = ベルトの節点・放熱板の折りは参加しない)
│  │  ├─ ContactPhysics.collectAttractors           ← 位置・速度・半径が有限
│  │  ├─ SurfaceCandidates.reset(参加者, 天体)       ← 1段目。substep に1回。天体数に比例、
│  │  │  └─ attractor.ts  attractorStateAt(body, 区間の両端)   個体数には比例しない
│  │  └─〔参加者ごと〕ContactPhysics.resolveSurfaceContact
│  │     ├─ SurfaceCandidates.into(e, out)          ← 2段目。実測で平均 1.00 体/substep
│  │     ├─ GameEntity.contactsWith(body, simTime)  ← 天体は拒めないので片側だけ問う
│  │     ├─ contact.ts  computeAttractorResponse
│  │     │  └─ collision-response.ts  resolveFixedSphereCollision  ← **質量を引数に取らない**
│  │     ├─ e.state = …                             …… 位置も速度も動いていなければ書き戻さない
│  │     │                                             (書き戻しは予測弧を捨てる)
│  │     └─ GameEntity.collideWith(body, contact, stage)  …… bounced のときだけ
│  ├─〔resolveCollision のときだけ〕放熱板の折りを参加者リストへ合流
│  │  └─ ContactPhysics.resolveSubstep(simTime, 個体+折り, activeStage)
│  │     ├─ ContactPhysics.collectParticipants  ← alive && collides && 有限(contactMass ≥ 0)
│  │     └─ ContactPhysics.resolveInOrder
│  │        ├─ contact.ts  contactCellSize(all, working)   (個体側のセル一辺)
│  │        ├─ SpatialGrid.reset / .insert                 (**個体だけを載せる**)
│  │        ├─ ContactPhysics.collectCandidates → GameEntity.contactsWith(両側)
│  │        │  └─ contact.ts  computeEntityResponse
│  │        │     ├─ Base.testSphereCollision → distributeSphereContact  (基地は BVH/OBB)
│  │        │     └─ collision-response.ts  resolveSphereCollision
│  │        └─〔TOI 昇順に最大 CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP(8)件〕
│  │           ├─ ContactPhysics.earliestContact  ← dirty な候補だけ引き直す
│  │           └─ ContactPhysics.applyCandidate → GameEntity.collideWith ×2
│  ├─ Stage.applySimulationEvents(simTime)
│  └─ EntityManager.cleanup(subDt, simTime, activeStage, playerPos, surfaceBodies)
│     ├─〔全生存個体〕GameEntity / Player / Bullet / Enemy / DebrisPiece  checkLoss
│     │        ← **表面到達はもう見ない。**焼失と種別固有の条件だけ
│     │  ├─ atmosphere.ts  burnUpBody(state.r, surfaceBodies, burnUpDensity)
│     │  └─(Player)ThermalSystem.updateAltitudeAlarm → nearestAtmosphereBody(surfaceBodies)
│     └─ EntityManager.prune → GameEntity.dispose
└─ ContactPhysics.resolveBelt(dt, simTime, player, entities.all(), activeStage)
         …… simSpeed ≤ ×4 かつ自機生存。フレームに1回。**天体を相手にしない**
```

各フェーズの境目で `NanWatchdog.checkPlayer` が呼ばれる(軌道積分・姿勢積分・天体接触・
接触・ベルトの5点)。

## 3-2. 予測

```
Predictor.update(simTime, simDt, player, horizon, canDisplayFuture, planArcs)
                       …… Game.update から毎フレーム1回(**ポーズ中・決着後も呼ぶ**)
├─ time-step.ts  simulationMaxStep(simDt, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT)
│                                   ← 消費される弧へ渡す刻み上限。実シミュレーションと同じ式
├─〔全個体〕GameEntity.predictsFuture / .predicted / .predictionTruncated   (集計のみ)
├─〔操作艦〕Predictor.advanceBudget
├─〔計画の弧(時刻順)〕Predictor.grow    …… interactive 枠が尽きるまで
└─〔他の個体(ラウンドロビン)〕Predictor.advanceBudget
   ├─ GameEntity.ensurePredictedArc(futureAttractors) → new PredictedArc
   │        ← GameEntity.state への書き込みが invalidatePrediction を呼ぶので、
   │           状態を差し替えられた個体はここで作り直しになる
   └─ Predictor.grow → PredictedArc.step()          …… 残予算ぶん繰り返す
      ├─ ArcBodies.resolve(tip.t, tip, 0)  …… 最初の1歩だけ。以後は前歩の中点窓を持ち越す
      │  └─ FutureAttractors.bodyAt → Ephemeris.attractorAt
      │        ← 成員 + 期限の来た候補だけを引く。**これが弧側の絞り込み**
      ├─ attractor.ts  strongestAttractor(tip.r, held.gravity) → elements.ts  keplerPeriod
      ├─ PredictedArc.stepDt(tip, span, period, held.collision)
      │  └─ time-step.ts  reentryAwareMaxStep([tip], held.collision, this.simulationMaxStep)
      │                                  …… consumable な弧だけ。**3-1 と同じ関数**
      ├─ predicted-arc.ts  trajectorySampleInterval(period, span)
      ├─ ArcBodies.resolve(tip.t + dt/2, tip, dt)     ← この歩の重力窓・衝突窓
      ├─ DynamicTrajectory.step → dynamics.ts  stepDynamics   ← RK4。**実シミュレーションと共有**
      ├─ ApsisTrack.observe(tip, 新しい先端)
      └─ PredictedArc.checkSurfaceReach(tip, mid.collision)
         └─ attractor.ts  reachedBody(prev, next, mid.collision)
               ← **弧の唯一の打ち切り条件**(非有限値の検出を除く)。焼失は判定しない
```

**木に載らない例外:**

- `Enemy.checkLoss` は焼失と撃破記録だけ。表面到達は接触経路が受ける(他の種別も同じ)。
- `RadiatorFold` / `BeltSection` は `EntityManager` に載らないので `cleanup` を通らない。
  天体接触の参加者からも外れる(`attachedTo !== null`)。`RadiatorFold` だけが ×4 以下の
  毎 substep に `Player.collisionFolds` で個体どうしの参加者リストへ合流する。
- `Predictor.update` は `Simulator.advance` より**後**に走る(`Game.update` の並び)。

## 3-3. 2本の木から読めること

1. **底は完全に共有されている。** RK4・掃引の幾何・刻みの式・間引きの式。
2. **分かれているのは窓の探し方と結末だけ。** 実シミュレーションは
   `classifyAttractors`(重力)と `SurfaceCandidates`(表面)の2つ、弧は `ArcBodies` 1つ。
   どちらも 1-2 の同時性から出ている正当な差。
3. **`surfaceBodies` は表面判定専用の窓ではない。** 熱・電力の恒星の取り出しと日照率の
   遮蔽体、焼失の大気天体探しにも同じ配列が渡る(5-1 A-1 / 5-2 B-3)。
4. **接触は予測を捨てる経路でもある**が、位置も速度も動いていない当事者は書き戻さない
   ガードが両方の経路に入っている。

---

# 第4章 逆向きの依存(`/inv-callstack`)

**`0eae0b41` 時点のスナップショット。**

## 4-1. 重力 RK4 積分

```
dynamics.ts  stepDynamics(state, dt, attractors, atmosphereBody, bcInv, srpCoeff, thrust)
      ← 全天体重力 + 2次重力場 + 大気抵抗 + 太陽輻射圧 + 推力の唯一の合成箇所
└─ dynamic-trajectory.ts  DynamicTrajectory.step(dt, attractors, atmosphereBody, bcInv,
                              srpCoeff, thrust, sampleInterval, keepDuration, extrapolationCenter)
   │     ← 積分そのものは持たず、保持列(間引き・保持窓・prevState)を足すだけ
   ├─ game-entity.ts  GameEntity.stepActual(dt, attractors, atmosphereBody)
   │  └─ simulator.ts  Simulator.substep …… 毎 substep、全生存個体。**種別で分けない**
   │        (弧が同じ時刻を持っていれば followPredicted が先に効き、ここへ来ない)
   └─ predicted-arc.ts  PredictedArc.step()
      └─ predictor.ts  Predictor.grow …… 実体の弧も計画の弧も同じ1本を通る
            (実体は ensurePredictedArc 経由、計画は PlanPath が持つ弧を PlanEditor が渡す)

呼び出し元は src/ にこの2本だけ。tests/perf/(common・exp3・exp5・exp12・
sphere-contact-sweeps)は stepDynamics を直接叩くが、production の経路ではない。
走査範囲: src/ tests/ tools/
```

**`totalAccel` の中で日照率を引く相手は、呼び出し側が渡した `attractors` そのもの**である
(SRP の遮蔽体)。実シミュレーションは絞り込んだ近傍重力窓を、弧は成員の重力窓を渡している
ので、遮蔽体の顔ぶれは経路によって違う(5-2 B-3)。

## 4-2. 剛体接触ソルバー(掃引の幾何)

```
sphere-contact.ts  sweptSphereContact(aStart, aEnd, bStart, bEnd, radiusSum)
      ← 掃引の幾何はここだけ。常に三次。解法を選ぶ引数は無い。戻り値は
        { startsInside, crossing } で、null は「入力が非有限で判定できない」だけを意味する
├─ collision-response.ts  sphereContactGeometry(a, b, prevA?, prevB?)
│  │     ← 掃引が空振りしたら区間終端の重なり押し戻し(toi=1)へ落とす
│  ├─ collision-response.ts  resolveSphereCollision   (個体 × 個体。双方が逆質量を持つ)
│  │  └─ contact.ts  computeEntityResponse
│  │     └─ ContactPhysics.collectCandidates / .earliestContact
│  │        ├─ ContactPhysics.resolveSubstep …… simSpeed ≤ ×4、毎 substep
│  │        └─ ContactPhysics.resolveBelt ……… simSpeed ≤ ×4 かつ自機生存、フレームに1回
│  └─ collision-response.ts  resolveFixedSphereCollision   (個体 × 天体。**質量を取らない**)
│     └─ contact.ts  computeAttractorResponse
│        └─ ContactPhysics.resolveSurfaceContact
│              …… **倍率にも種別にも依らず毎 substep、全生存個体。**
│                 SurfaceCandidates を通った天体だけ(実測 平均 1.00 体/substep)
└─ attractor.ts  reachedBody(prev, next, bodies)
   │     ← 幾何を持たず、窓を回して最小 TOI の1体を選ぶだけ。半径和は**天体の半径のみ**
   │        (弧は大きさを持たない点として扱う — SPEC/ORBIT.md「天体表面への到達判定」)
   └─ predicted-arc.ts  PredictedArc.checkSurfaceReach …… 弧の1歩ごと。ArcBodies の成員だけ
```

図の外:

- **`checkLoss` 系からの呼び出しは 0 件。** `c5c46dd6` で表面到達が接触経路へ移った。
- **基地を当事者に含む個体どうしの接触は掃引を通らない。** `computeEntityResponse` が
  `Base.testSphereCollision`(BVH / OBB)で幾何を出し、`distributeSphereContact` で分配
  だけ共有する。
- `linearSphereContact` / `curveSphereContact` の二次 / `sweptSagitta` … src/ からの
  呼び出しは 0 件。精度を落として費用を買うときの余地として残してある(モジュール冒頭の
  コメントに理由)。tests/perf/exp10・exp11 だけが直接叩く。
- 走査範囲: src/ tests/ tools/

---

# 第5章 提案 — 残っている整理の余地

**どれも決定ではない。** 「これは残骸か、意図した形か」を一緒に判断するための一覧。

## 5-1. 責務が抜かれた残骸・たらい回し・命名

### A-2. `ContactTarget` が宣言だけで、生の union が 12 箇所(**推す**)

`contact-target.ts` は `ContactTarget = GameEntity | Attractor` を定義しているが、
使っているのは `contact-damage.ts` だけ。`collideWith` / `contactsWith` / `lossReason` /
`collideAtRadiator` の署名は `GameEntity | Attractor` を直書きしている(12 箇所)。
**union に名前を付けた意味が出ていない。** 置換だけで済む。

### A-4. `contact.ts` の分割(**実施済み**)

**クラスごと割った。** 426 行の `simulation/contact.ts` と `ContactPhysics` は消え、
ファイル名と export するクラス名が一致する形になった。

| 置き場所 | 中身 | 行数 |
|---|---|---|
| `game-entity/contact.ts` | `Contact`(接触1件の記述)と `closingSpeed` | 19 |
| `game-entity/contact-target.ts` | `ContactTarget` / `isAttractor`(A-3 で移動済み) | 11 |
| `simulation/contact-participant.ts` | `isFiniteParticipant` / `contactTime` — 両方の解決器が同じ規則で読まねばならない、参加者の区間 | 22 |
| `simulation/surface-contact-physics.ts` | `SurfaceContactPhysics` — 天体表面との接触 | 103 |
| `simulation/entity-contact-physics.ts` | `EntityContactPhysics` — 物体どうしの接触(substep とベルト) | 253 |
| `simulation/entity-contact-response.ts` | `entityContactResponse` — 接触ペア1組の反発の計算 | 56 |

**共有していた6つの行き先**: `Contact` と `closingSpeed` は受け手側の語彙なので
`game-entity/` へ。`RESTITUTION` は `C.CONTACT_RESTITUTION`(ゲームの調整値なので
`game/const.ts`)へ。`sameVec` は `physics/vec3.ts` へ(値が動いたかを見る一致判定は
ベクトルの語彙)。`isFiniteParticipant` と `contactTime` は共有モジュールへ。

**副次の解消**: `participantScratch` の暗黙の共有は、クラスが分かれた時点で消えた。
また `Base` への依存は `entity-contact-response.ts` に閉じ、解決器の側は当たり形状の
種別を見なくなった。

**残った逸脱**: `entity-contact-physics.ts` は 253 行で 200 行基準を超えている。中身は
「候補の列挙 → TOI 昇順の解決 → 一括の書き戻し」という1本の手順で、これ以上割ると
作業集合(`working` / `changed` / グリッド)を跨いで渡すだけになるため、割っていない。

### A-7. `Simulator.stepAttitudes` の種別ごとの列挙(**実施済み**)

`GameEntity` に `hasAttitude`(既定 `true`、`Bullet` だけが `false`)を置き、
`stepAttitudes` は `entities.all()` を1本回して `alive && hasAttitude` で弾くだけに
なった。6種別の列挙と `alive` 検査の不揃いは消え、`Simulator` から姿勢についての
種別の名指しが無くなった。

**挙動が変わった点が1つある**: 死んだ自機の姿勢が積分されなくなった(以前は
`players` だけ `alive` 検査が無かった)。他の種別に揃えた結果であり、
`ActivePlayerController.reclaimDead` が回収するまでの間だけ効く。

### A-8. `Simulator.adaptiveMaxStep` が `players` / `enemies` を名指ししている

再突入域の細分化の対象を「生存する艦と敵」に限るのは**ゲーム側の判断**で、SPEC にも
明記されている(艦以外は失われる精度がプレイを変えない)。それ自体は正しいが、判断が
`Simulator` の中で種別のコレクションを名指しする形で書かれている。`GameEntity` 側の
属性(「この個体の喪失の精度がプレイに効くか」)にすると、Simulator から種別が消える。

### A-10. `base-collision.ts` の LOD 分岐(**据え置きを確認するだけ**)

`warpLevel` は `Base.raycast` / `Base.testSphereCollision` の既定引数 `1` としてしか渡らず、
LOD1 / LOD2 は到達不能。v3 が「基地の仕様が固まるまで触らない」と決めたので、**今回は
そのままでよい。** ただしこれは「倍率で近似そのものを変える」規則違反が到達不能なだけで
残っている状態なので、**基地の作業に着手するときの先頭項目**として覚えておく。

### A-11. `Player.collideWith` と `Player.collideAtRadiator` がほぼ同型

差は「ダメージの割り振り先が無作為か `side` のパーツ固定か」と、放熱板の破壊エフェクトの
有無だけ。11 行 × 2。共通化するかは「今後も使う可能性があるか」で決める話なので、
**判断を仰ぐ項目**。

## 5-2. 二重実装・非対称の残り

### B-1. 「区間内で最初に触れる天体を1体選ぶ」ループが2箇所

`attractor.ts  reachedBody` と `ContactPhysics.resolveSurfaceContact` が、同じ問いに
同じ形のループを書いている(窓を回し、掃引を掛け、最小 TOI を選ぶ)。違うのは
**返すもの**だけ — 前者は補間した到達状態(弧の打ち切り用)、後者は反発の結果
(実体の状態と `collideWith` 用)。

- 半径和も違う(前者は天体の半径のみ、後者は個体の半径 + 天体の半径)。これは SPEC に
  明記された意図的な差だが、`reachedBody` の側にその旨のコメントが無い。
- **共通化すべきかは自明でない。** ループは 10 行程度で、返すものが違えば分けたほうが
  読める、という判断もありうる。ただし「同じ問いが2箇所」は v1 が正そうとした構図
  そのものなので、**意識的に「分けたまま」と決めるべき項目**だと思う。

### B-4. `isAttractor` が構造的型付けに依存していて、それを守るものが無い

```ts
export function isAttractor(target: ContactTarget): target is Attractor {
  return 'mu' in target;
}
```

正しさは「`GameEntity` は `mu` を持たない」に完全に依存している。これは
`remove_asteroid.md` が確立した不変条件だが、**`GameEntity` に `mu` という名前の
フィールドが生えた瞬間、型検査を通ったまま全部の天体判定が反転する**(喪失文言・死因・
ダメージの重み・基底の `collideWith`)。

- 最小の対策: `tests/physics/` に「`GameEntity` のインスタンスで `'mu' in` が偽である」
  ことを固定する1件を置く。
- より強い対策: `Attractor` に判別用のフィールドを足す。ただし `physics/` の型に
  `game/` の都合を持ち込むことになるので、**推さない。**

## 5-3. 検証の穴

### C-1. 絞り込みの正しさを守るテスト(**結果**)

`tests/physics/surface-candidates.test.ts` を置いた。3件とも `npm run ci` を通る。

| 件 | 何を固定するか |
|---|---|
| 無作為な配置 | 3,200 件(到達 304 件 / 未到達 2,896 件)で、絞り込んだ窓と総当たりの窓で `reachedBody` の答えが一致する。半数は始点と終点がほぼ重なる往復にしてある — 弦の長さでは覆えない膨らみを持つ配置を必ず含めるため |
| 弦から離れる曲線 | 弦は表面から 650m 離れたまま素通りするのに曲線は潜り込む配置で、その天体を落とさない |
| 触れようのない天体 | 遠方の7体が1段目で落ち、`SurfaceCandidates.count` が 1 になる(全部通す実装では上2件が通ってしまうので、実際に落としていることも見る) |

**変異検査で効くことを確かめてある**: `chordDeviationBound` を 0 に潰すと上2件が落ちる。

`SurfaceCandidates.count` の読み手が exp12 だけだった件も、3件目が読むことで解消した。

### C-2. 天体接触の解決そのものの回帰テスト(**結果: 置けなかった。ただし仕様違反を1件見つけた**)

**置けなかった理由 — テストの実行形態からこの層へ届かない。**
`tests/physics/` は `tsconfig.test.json`(`lib: ["ES2022"]`、`module: CommonJS`、
`moduleResolution: node`)でコンパイルして node で走らせる。`SurfaceContactPhysics` は
`GameEntity` と `Stage` を型として参照するだけだが、tsc はその2つのファイルとその推移閉包を
プログラムへ引き込む — つまり `render/` `hud/` `audio/` まで到達する。

- `lib` に `DOM`/`WebWorker` を足すと、今度は `three/tsl` が `moduleResolution: node` で解決
  できず、`render/celestial-surface.ts` に本物の型エラーが出る(本体は `bundler` 解決)。
  テストのビルド時間も 8.3s → 16.9s へ倍増した。
- 型だけを構造的に受け取る形へ寄せても解けない。参加者の契約には `ContactTarget`
  (= `GameEntity | Attractor`)と `Stage` が現れるので、どちらを辿っても同じ推移閉包に戻る。
- 実行時は問題ない(`GameEntity` の import は型専用なので JS からは消えるし、`three` は
  `geometry.test.ts` が示すとおり node で読める)。**詰まっているのはコンパイルの側だけ。**

→ ここへテストを置くには、node で走る CommonJS のテストとは別に **bundler 解決でゲーム層を
コンパイルする実行形態**を用意するか、`collideWith` の契約から `Stage` と `GameEntity` を
外すかのどちらかが要る。どちらもこの節の範囲を超える。

**見つけた仕様違反 — 剛体接触のダメージが常に 0 になっていた(修正済み)。**
`closingSpeed`(`game-entity/contact.ts`)は
`max(0, -dot(selfState.v - otherState.v, normal))` を返していた。`normal` は self → other 向きで、
接近している状態とは `(v_self - v_other)·n > 0` のことなので、**接近しているときに 0 を返し、
離反しているときに正を返していた**(自身のコメント「離反していれば 0」と逆)。
`collideWith` は反発が起きたときにしか呼ばれない = 必ず接近している瞬間なので、
`contactDamageSpeed` は常に 0 で、`Ship.applyCollisionDamage` は
`COLLISION_DAMAGE_MIN_CLOSING_SPEED = 50` を割って必ず `false` を返していた。
`SPEC/COMBAT.md`「剛体接触によるダメージ」に真正面から反する状態で、`contactDamageWeight`・
`ATTRACTOR_DAMAGE_WEIGHT`・`COLLISION_DAMAGE_*` と Player / Enemy の接触ダメージ経路が
まるごと死んでいた。**符号を正して、いずれも生きている。**

**この節が置けなかったテストのうち、法線の向きの取り決めだけは置けた。**
`game-entity/contact.ts` は `kinematic-state` と `vec3` しか import しないので、`GameEntity` の
推移閉包に触れずに `tests/physics/` から叩ける。`tests/physics/contact.test.ts` に4件:

- `closingSpeed` が接触法線方向の相対速度であること・離反していれば 0 であること
- `resolveSphereCollision` が `bounced` を立てた反発から解決器と同じ形で記述を組むと、
  両当事者の見る接近速度が正で一致すること(物体どうし)
- `resolveFixedSphereCollision` でも同じこと(天体表面)

後半2件が要点で、**法線の向きの取り決めは記述を組む側(`simulation/`)と法線を決める側
(`physics/collision-response.ts`)に跨がっており、片方だけを読んでも符号は確かめられない。**
符号を元へ戻すと4件とも落ちることを確かめてある。

### C-3. 実行時確認(**結果: 1回通した。2項目は実施、3項目は駆動できず**)

ヘッドレス Chrome + CDP で本番ビルドを起動して観測した(`97489262` 時点)。

**まず `npm run smoke:browser` はこの環境では通らない。** 原因は退行ではなく環境で、
ヘッドレスのソフトウェア WebGPU では 60 フレーム完走に **約 82 秒**かかるのに、
このツールの待ち時間は 30 秒に固定されている。**着手前の `18a67e55` でも同じところで
同じように落ちる**ことを確認済み。待ち時間を伸ばした自前の CDP セッションでは
`?stage=1` も `?stage=debug-load` も **例外 0 件**で起動する。

| 項目 | 結果 |
|---|---|
| ×131072 で天体の近傍を通過する軌道が誤って消えないこと | **実施。** `?stage=debug-load` を ×131072 へ上げて 60 秒回した。自機は残り(`players 1`)、高度は 412 km から 197 km まで落ちたが失われていない。破片は 500 → 290 体へ減っており、再突入による喪失の経路自体は働いている |
| 高倍率での実行時例外 | **実施。** 上の 60 秒間、`Runtime.exceptionThrown` も `console.error` も 0 件。1フレームに substep 2,697 回・軌道積分 785,495 回という極端な負荷を通してもクラッシュしない |
| 着陸基盤の確認(`Player.collideWith` だけを書き換えて低速接触を作る) | **駆動できなかった。** 天体表面への低速タッチダウンをキーボード入力だけで作れない。起動に 82 秒かかるので試行錯誤も現実的でない |
| 喪失理由がワープ倍率に依らないこと(×1 と ×131072 の突き合わせ) | **駆動できなかった。** ×1 で喪失が起きるまで待てない(上の観測でも ×131072 で 60 秒かけて破片が減り始める規模) |
| 段8 の前後で外殻温度・バッテリー残量が変わらないこと | **比較そのものが成立しない。** 「段8 の前後」は既に過ぎた commit 境界であり、いま再現できない。加えて `Game.behave` が実 dt で進む以上、同じ経過時間での温度・残量はラン間で一致しないので、数値の突き合わせは元から成り立たない |

→ 残った3項目は、**実行時に観測する前に「その状況をどう作るか」を用意しなければならない**
種類のもので、`/verify` の手順(キー入力で駆動する)の射程の外にある。当てるなら、
その状況を作るステージか、状態を直接置ける口が要る。

## 5-4. 未決事項の置き場所

**掃引を弦へ落とす分岐は、`SPEC/ORBIT.md`「未確定の案」へ移した。** 判断材料
(分岐基準の妥当性・過小評価 2.3×・半径和の母集団)は `unite_sphere_contact.md` 5章・8章に
残り、`sphere-contact.ts` の「消してはならない」は ORBIT.md を存在理由として参照する。

同じ理由で、5-2 B-3(遮蔽体の窓)と 5-1 A-10(基地の LOD)も、決めないなら
「未確定の案」へ移す候補。メモは消える前提の文書で、実際この一連の作業でも計画は消してきた。

## 5-5. 性能について — いまの姿勢の確認

最終形のフレーム時間は `?stage=debug-load` + ×131072 で **355.6 ms(3 fps)**。
着手前 871.9 ms に対して 2.45 倍速いが、段7 直後の 162.7 ms からは戻っている。
内訳は 軌道積分 187.9 / 姿勢 32.6 / 接触 51.8 ms。

**接触はもう主因ではない**(絞り込みが効いた)。いま支配的なのは破片 500 体 × 64 substep の
RK4 そのもので、これは `f68be2c3` が**物理的な正しさのために**払うと決めた費用である。

→ 次に性能を取り戻すなら、手を入れる先は判定器の精度(`unite_sphere_contact.md` 8章)
ではなく**個体数**の側になる(v2 1-3-3 の「倍率を上げた時点で弾・破片をまとめて消す」)。
**着手すべきかどうかは、この文書の範囲外。** ただし精度を落とす調整に手を出す前に
この順序を確認しておきたい — 8章の選択肢は「呼び出し回数を減らしてもなお費用が残ったとき」
という前提付きで残されており、いまの内訳はその前提を満たしていない。

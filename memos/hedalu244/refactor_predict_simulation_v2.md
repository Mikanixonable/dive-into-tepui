# 予測と実シミュレーションの統合 — 残りの4論点と、その計画

`e8a3fe7` から `9bc15122`(workspace4)までの一連の変更について、**当初の目的が漏れなく
達成されているか**を当て、**残った4つの論点をどう片付けるか**を決める。

この文書は判断のための材料と計画であって、仕様でも設計でもない。決まったことは
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
- 第5章〜第7章が**この文書の本体 — 論点の計画**。各章は単体で読んで着手できるように
  書いてある。
- 第8章は**未テスト** — 実行時にも回帰テストにも当てられていないものの一覧。

## 着手順

依存があるので、この順に着手する。

| 順 | 章 | 何をするか | 状態 |
|---|---|---|---|
| 1 | 第5章(論点1) | 表面到達の判定を1本にする | **実施済み** |
| 2 | 第6章(論点2) | 天体と個体で接触の口を分け、型を改名する | **実施済み**(`94e9d248` / `06cd8928`) |
| 3 | 第7章(論点3) | SPEC から精度と性能を追い出し、そのうえで2つの実測を通す | **実施済み**(`092e303c` / `cb33d590` / `92787cbe`) |

**第7章は SPEC の掃除(7-1)を先に、実測(7-2 / 7-3)を後にして、3件とも実施した。**
「性能のために判定を抜く」「性能のために刻みを変える」は実装の裁量であって確定仕様ではない、と
決めたので、消してよいかどうかは実測の結論に依らなかった。実測は2件とも「いまの実装のままに
する」で決着したが、**残す根拠は SPEC が書いていたものとは別だった** — 7-2 は判定の意味では
なく費用、7-3 は熱の一次積分ではなく RK4 の破綻である。

**天体の内側の重力を有限にする論点(旧・論点4)は、この変更セットから外した。** 表面より内側の
挙動が日常的に効くのは着陸を実装したときなので、静止接触の設計と同じ文書で決める —
`memos/hedalu244/design_landing_simulation.md`。

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

そのあとの後始末が `18a67e55` 〜 `9bc15122` で、この間に大気窓の分離(`da80b592`)・
`resolveEntityContacts` への改名(`35d600e9`)・`Simulator` から `SimSpeedManager` への依存の
除去(`4bea800f`)・姿勢積分の種別名指しの解消(`ba6334da`)・`contact.ts` のクラス分割
(`5b16338f`)・遮蔽体の窓の分離(`3c2ef456`)・絞り込みと窓一致のテスト追加
(`a96d25b0` `ddf5194a`)・接近速度の符号の修正(`f1e055e7`)が入った。

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
- **弾・破片のまとめ積分を廃した**(`f68be2c3`)。廃止の理由は費用ではなく、1歩が
  最高倍率で約9時間 = 低軌道 6 周回になり、その区間を三次曲線で表すと制御点が実際の軌道
  から飛び出して偽陽性と偽陰性の両方が出るという**物理的な誤り**。

---

# 第2章 現状報告 — 達成確認

**`9bc15122` 時点。** `npm run typecheck` 通過、`npm run test:physics` 通過。

## 2-1. 当初の目的(v1 由来)

| 目的 | 判定 | 根拠 |
|---|---|---|
| **Simulator と Predictor が本質的に違う物理を積んでいる状態の解消** | **達成** | RK4(`stepDynamics`)・掃引の幾何(`sweptSphereContact`)・刻みの規則(`simulationMaxStep` / `atmosphericMaxStep`)・間引きの式(`trajectorySampleInterval`)を両者が共有。残る差は窓の**探し方**と結末の出力先だけで、どちらも 1-2 の役割の違いに由来する |
| **Asteroid の廃止 / GameEntity は接触以外で影響を及ぼさない** | **達成** | `Asteroid` `asteroid` の一致 0 件。`GameEntity` に `mu` が無く、重力窓は `Ephemeris` からしか出ない |
| **Predict と Simulation で積分する重力場が食い違いうる状況の是正** | **達成(測定済み)** | `window-agreement.test.ts`。実測の最大差 5.87e-9 m/s²(許容量 1e-8 の 0.587 倍)。式は動かしていない |
| **大気の一般化(地球ハードコードの解消)** | **達成** | `atmosphere.ts` に `earth` / `EARTH` が 0 件。`AtmosphereDef` は基準楕円体・自転・層を自分で持つ |
| **剛体接触と大気を別物として区別** | **達成** | 焼失は `burnUpBody`(密度の点判定)、衝突は `sweptSphereContact`(掃引)。相手も(大気天体 / 全天体)、死因も、パラメータも別。焼失へ渡す窓は表面窓から大気窓へ分離済み |
| **着陸機能の基盤** | **達成(基盤のみ)** | `Contact` は `t` / `point` / `normal` / `selfState` / `otherState` を運ぶ。`impulse` を落としたので、材料は撃力へ潰す前の状態と法線だけになった。着陸そのものは未実装(意図どおり)。ただし**いま着地させると刻み幅に比例した接近速度が毎 substep 入る** — `memos/hedalu244/design_landing_simulation.md` |
| **掃引衝突判定の呼び出し口と実装の一元化** | **達成** | 掃引の幾何は `sphere-contact.ts` 1箇所。入口は `sweptSphereContact` 1つで解法の引数は無い |
| **Simulator と時間加速度の密結合の解消** | **達成** | `Simulator` は `SimSpeedManager` を知らず、`canResolveEntityContacts` を真偽値で受け取るだけ。倍率ゲートそのものの是非は**第7章 7-2** |
| **Simulator が内部で種別判断していたのを廃止** | **達成** | 積分(`substep`)も姿勢(`stepAttitudes`)も `entities.all()` を種別で分けずに回す。最後まで残っていた `adaptiveMaxStep` の `players` / `enemies` の名指しは、個体の属性 `doPreciseReentry` へ移り、関数自体が消えた(**第7章 7-3**)|
| **SpatialGrid の利用拡大・計算量削減** | **達成** | 天体側は `SurfaceCandidates` の2段絞り込み(グリッドではなく境界体積 — 天体半径が7桁ちがうため一様グリッドを使わない、と v3 4-3 で決めた)。個体側は従来どおり 27 近傍 |
| **Simulator と Predict で共通化すべき挙動の外部化** | **達成** | 上記のとおり。**「式は1本、引数は呼び出し側」**の形が保たれている |

## 2-2. 期待された現状 — 物体の2分類

> 解析的な天体は mu を持ち質量を持たない / GameEntity は質量を持ち重力を持たない

**達成。**

- `Attractor` に質量のフィールドは無い。`invMass: 0` の綴りが `src/` に 0 件。
  天体との接触は `resolveFixedSphereCollision` を通り、**質量を引数に取らない**。
- `GameEntity` に `mu` は無い。`isAttractor(target)` が `'mu' in target` で判定できるのは
  この非対称そのもの(ただし**第6章**)。
- 質量は 0(薬莢・破片・欠片・弾薬)・正(弾・艦・敵)・∞(基地)を取り、
  `collision-response.test.ts` が 0×正 / 0×0 / 0×天体 / 双方不動の4通りを固定している。
- 基地の不動は `Base.contactMass = Infinity` で表され、**天体の不動とは別の機構**のまま
  同じ分配の式を通る。当たり形状の吸収は `entity-contact-response.ts` に閉じている。

## 2-3. v3 の達成目標 20 件

| # | 目標 | 判定 |
|---|---|---|
| 1 | 天体接触の判定が1経路 | **OK** — `checkLoss` 系に `reachedBody` 0 件。残る読み手は `PredictedArc.checkSurfaceReach` だけ(**第5章がこれを畳む**) |
| 2 | 喪失理由がワープ倍率に依らない | **OK** — `lossReason(other)` が相手の種別だけで決まる。倍率を見る枝が無い |
| 3 | ×4 超でも天体をすり抜けない | **OK(構造として)** — `resolveSurfaceContacts` は倍率ゲートの外で毎 substep 走る |
| 4 | `mu = 0` の天体にも表面判定が効く | **OK** — `surfaceBodies()` = `attractorsAt`(登録天体の全数) |
| 5 | `collides` は個体どうしだけを支配 | **OK** — 天体側の参加条件は `alive && attachedTo === null && 有限` |
| 6 | 物理が `simSpeed` で変わらない | **OK** — ゲートは1つ、SPEC 記載どおり(その記載の是非は第7章) |
| 7 | 同じペアを同じ substep で2回判定しない | **OK** — 掃引が走るのは `resolveOne` の1回だけ |
| 8 | 掃引呼び出しが天体数に比例しない | **OK** — 実測 300 万 → 5,661 回/フレーム(3.3 %) |
| 9 | フレーム時間が着手前より改善 | **OK** — 871.9 ms → 355.6 ms(2.45 倍速い) |
| 10 | ダメージが質量に依らない | **OK** — `impulse` が `src/` に 0 件。`contactDamageSpeed` は接近速度 × 種別の重み |
| 11 | 質量 0 で非有限値が出ない | **OK** — テスト4件 |
| 12 | 解析天体の質量が現れない | **OK** — `invMass: 0` 0 件 |
| 13 | 重み 0 が判定から外れていない | **OK** — 参加条件は `contactMass >= 0`。重みが掛かるのは `contactDamageSpeed` の1箇所だけ |
| 14 | 薬莢・破片が艦の予測を捨てさせない | **OK(構造として)** — 質量 0 + `replaceIfMoved` / 天体側の同等ガード |
| 15 | 大気の刻みを決める定数が1箇所 | **OK** — `DRAG_STEP_MAX_SPEED_LOSS` / `DRAG_STEP_MAX_SCALE_HEIGHTS` の2つが `const.ts`、式は `atmosphericMaxStep` の内側だけ。対象集合は個体の `doPreciseReentry`(第7章 7-3)|
| 16 | 表面を持つ天体の窓の定義が1箇所 | **OK** — `Simulator.surfaceBodies()` |
| 17 | 重力窓の差が許容量以下 | **OK** — 実測 5.87e-9 |
| 18 | `Contact` の情報が減っていない | **OK(型として)** — 5フィールドとも健在。`impulse` だけが意図どおり消えた |
| 19 | 否定形の種別判定が残っていない | **OK** — 天体かどうかを問う4箇所すべてが `isAttractor`(そもそも問わない形にするのが第6章) |
| 20 | `passiveWarpLod` の判断が記録されている | **OK** — v3 第11章。廃止、根拠は費用ではなく物理的な誤り |

## 2-4. 未決・保留として残っているもの(4論点の外)

| 項目 | いまの状態 |
|---|---|
| 掃引をほぼ直線の区間で弦へ落とす分岐 | **保留のまま。`SPEC/ORBIT.md`「未確定の案」に記載済み。** 判断材料(分岐基準の妥当性・過小評価 2.3×・半径和の母集団)は `unite_sphere_contact.md` 5章・8章に、実測は `tests/perf/exp10` `exp11` にある。`linearSphereContact` / 二次 / `sweptSagitta` はそのための余地として残してある |
| `base-collision.ts` のワープ倍率 LOD | **到達不能のまま据え置き**(v3 で明示的にそう決めた)。`warpLevel` は `Base.raycast` / `Base.testSphereCollision` の既定引数 `1` としてしか渡らず LOD1 / LOD2 へ入らないが、「倍率で近似そのものを変える」規則違反はコードに残っている。基地の仕様が固まっていないので触らず、**基地の作業に着手するときの先頭項目**とする |
| `Player.collideWith` と `Player.collideAtRadiator` の重複 | **残したまま。** 差は割り振り先(無作為 / `side` のパーツ固定)と放熱板の破壊エフェクトの有無だけで、11 行 × 2。放熱板とベルトの局所シミュレーションが未完成で、共通化の形はそちらの仕様が決まってから決まるため、そちらの作業でまとめて扱う。**ただし第6章で `collideWith` を天体用と個体用へ割るとき、この2つも同じ割り方をすることになる** |
| 静止接触の安定化 | `SPEC/ORBIT.md`「未確定の案」に記載済み。**具体的な帰結の実測と、その数値を同節へ足すことは `memos/hedalu244/design_landing_simulation.md` が受け持つ** |

---

# 第3章 呼び出し経路(`/callstack`)

**`269cc8ba` 時点のコードから引いたスナップショットであり、正本ではない。** 食い違ったら
コードを信じる。

## 3-1. 実シミュレーション

```
Simulator.advance(dt, simDt, player, activeStage, canResolveEntityContacts, nanWatchdog)
                       …… Game.advanceSimulation から毎フレーム1回(ポーズ中・決着後は呼ばない)
├─〔substep ループ〕                       …… targetTime に届くまで
│  ├─ time-step.ts  simulationMaxStep(simDt, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT)
│  │        ← **大域の上限はこれだけ。**大気は substep を縮めない(第7章 7-3)
│  ├─ Simulator.nextEventTime(activeStage)
│  │  ├─ Stage.nextSimulationEventTime
│  │  └─ Simulator.entityEventTime → GameEntity.nextSimulationEventTime
│  │        …… 顔ぶれの世代(collectionRevision)が変わったときだけ全走査
│  ├─ time-step.ts  simulationStepDuration(simTime, targetTime, maxStep, eventTime)
│  ├─ Ephemeris.gravityAttractorsAt(substep 中点)              (重力窓 — mu≠0 の 65 体)
│  ├─ Simulator.surfaceBodies() = Ephemeris.celestialBodiesAt(**substep 開始時刻**)
│  │        ← 遮蔽体にも天体接触にも使う**唯一の窓**。登録天体の全数。倍率で切り替えない
│  ├─ Ephemeris.atmosphereCelestialBodiesAt(substep 中点)       (大気窓 — 既定 1 体)
│  ├─ Simulator.substep(subDt, 重力窓, 遮蔽体, 大気窓, activeStage)
│  │  ├─ attractors.ts  classifyAttractors(重力窓)  ← substep に1回だけ組み、全個体で共有
│  │  └─〔全個体〕                                   …… 種別で分けない
│  │     ├─ attractors.ts  attractorsNearInto(e.state.r, classified, out)
│  │     ├─ GameEntity.followPredicted(t, near)  …… 弧が t を持てば積分せず先端を差し替える
│  │     ├─〔e.doPreciseReentry のときだけ〕
│  │     │     time-step.ts  atmosphericMaxStep(e.state, e.bcInv, 大気窓)
│  │     │        ← 抗力の逆時定数と大気のスケールハイトから決まる、この個体の上限
│  │     ├─〔上限 ≥ subDt〕GameEntity.stepActual(subDt, near, 遮蔽体, 最寄りの大気天体)
│  │     │     …… 1歩で進み、coarseEntitiesScratch へ集める
│  │     └─〔上限 < subDt〕Simulator.stepPrecise(e, subDt, 上限, near, 遮蔽体, …)
│  │           …… 区間を等分し、**1歩ごとに**次の3つを回す。ephemeris・分類・近傍は
│  │              外側のものをそのまま使う(天体位置は各段の時刻へ2次外挿される)
│  │        ├─ GameEntity.stepActual(内側の刻み, …)
│  │        ├─ GameEntity.stepEnvironment(内側の刻み, ephemeris, e.state.t, 遮蔽体)
│  │        └─ SurfaceContactPhysics.resolveSurfaceContacts([e], 遮蔽体, stage)
│  │
│  │        stepActual → DynamicTrajectory.step → dynamics.ts  stepDynamics  ← RK4。**弧と共有**
│  ├─ Simulator.stepAttitudes(subDt) → attitude.ts  stepAttitude
│  │        …… entities.all() を1本回し alive && hasAttitude だけ通す。種別の名指しは無い
│  ├─〔coarseEntitiesScratch の各個体〕GameEntity.stepEnvironment(subDt, …)
│  │        ← 既定は何もしない仮想メソッド。Player だけが override する
│  │           (熱・電力・放熱板。恒星の取り出し・日照率の遮蔽体・最寄りの大気天体に同じ窓)
│  │  └─ ThermalSystem.updateThermal(dtSub, r, v, 最寄りの大気天体, ship)
│  │        ← **外殻温度も動圧も、区間終端の1点をサンプルした一次積分**(第7章 7-3)
│  ├─ SurfaceContactPhysics.resolveSurfaceContacts(coarseEntitiesScratch, 遮蔽体, stage)
│  │        …… 倍率にも種別にも collides にも依らず毎 substep。物体どうしより先に解く。
│  │           **細分した個体は内側で解決済みなので参加しない**(二重に解くと反発が二度当たる)
│  │  ├─ .collectParticipants     ← alive && attachedTo === null && isFiniteParticipant
│  │  ├─ .collectCelestialBodies  ← 位置・速度・半径が有限
│  │  ├─ SurfaceCandidates.reset(参加者, 天体)  ← 1段目。substep に1回。天体数に比例し、
│  │  │  └─ celestial-body.ts  celestialBodyStateAt(body, 区間の両端)  個体数には比例しない
│  │  └─〔参加者ごと〕SurfaceContactPhysics.resolveOne
│  │     ├─ SurfaceCandidates.into(e, out)      ← 2段目。実測で平均 1.00 体/substep
│  │     ├─ surface-contact.ts  firstSurfaceContact(e.prevState, e.state, e.radius, candidates)
│  │     │        ← 第5章で1本になった表面到達。弧(checkSurfaceReach)と**共有**
│  │     ├─ collision-response.ts  distributeFixedContact  ← 質量を引数に取らない
│  │     ├─ e.state = …  …… 位置も速度も動いていなければ書き戻さない(書き戻しは弧を捨てる)
│  │     └─ GameEntity.collideWithCelestialBody(body, contact, stage)
│  ├─〔canResolveEntityContacts のときだけ〕                     …… ×4 以下(第7章 7-2)
│  │  ├─ 放熱板の折り(Player.collisionFolds)を参加者リストへ合流
│  │  └─ EntityContactPhysics.resolveEntityContacts(simTime, 個体+折り, stage)
│  │     ├─ .collectParticipants  ← alive && collides && isFiniteParticipant
│  │     └─ .resolveInOrder
│  │        ├─ entity-contact-physics.ts  contactCellSize(all, working)  (個体側のセル一辺)
│  │        ├─ SpatialGrid.reset / .insert                 (**個体だけを載せる**)
│  │        ├─ .collectCandidates → GameEntity.contactsWith(両側)
│  │        │  └─ entity-contact-response.ts  entityContactResponse
│  │        │     ├─ Base.testSphereCollision → distributeSphereContact  (基地は BVH/OBB)
│  │        │     └─ collision-response.ts  resolveSphereCollision
│  │        └─〔TOI 昇順に最大 CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP(8)件〕
│  │           ├─ .earliestContact  ← dirty な候補だけ引き直す
│  │           └─ .applyCandidate → GameEntity.collideWith ×2
│  ├─ Stage.applySimulationEvents(simTime)
│  └─ EntityManager.cleanup(subDt, simTime, activeStage, playerPos, 大気窓)
│     ├─〔全個体〕GameEntity / Player / Bullet / Enemy / DebrisPiece  checkLoss
│     │        ← **表面到達はもう見ない。**焼失と種別固有の条件だけ
│     │  ├─ atmosphere.ts  burnUpBody(state.r, 大気窓, burnUpDensity)
│     │  └─(Player)ThermalSystem.updateAltitudeAlarm → nearestAtmosphereBody(大気窓)
│     └─ EntityManager.prune → GameEntity.dispose
└─〔canResolveEntityContacts かつ自機生存〕
   └─ EntityContactPhysics.resolveBelt(dt, simTime, player, entities.all(), stage)
         …… フレームに1回、**実 dt** で解く。天体を相手にしない
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
      │  └─ FutureCelestialBodyProvider.celestialBodyAt → Ephemeris.celestialBodyAt
      │        ← 成員 + 期限の来た候補だけを引く。**これが弧側の絞り込み**
      ├─ celestial-body.ts  strongestAttractor(tip.r, held.gravity) → elements.ts  keplerPeriod
      ├─ PredictedArc.stepDt(tip, span, period, held.collision)
      │  └─ time-step.ts  atmosphericMaxStep(tip, this.bcInv, held.collision)
      │        ← **3-1 と同じ関数。**consumable な弧は simulationMaxStep・接近項と併せた最小、
      │           consumable でない弧は下限 ARC_MIN_STEP_DT の**外側**から掛かる
      │           (下限は接近項の Zeno を断つためのもので、抗力を積めない幅まで
      │            刻みを広げる権利は持たない)
      ├─ predicted-arc.ts  trajectorySampleInterval(period, span)
      ├─ ArcBodies.resolve(tip.t + dt/2, tip, dt)     ← この歩の重力窓・衝突窓
      ├─ DynamicTrajectory.step → dynamics.ts  stepDynamics   ← RK4。**実シミュレーションと共有**
      │        (遮蔽体には mid.collision を渡す — 弧が幾何の相手として追っている窓)
      ├─ ApsisTrack.observe(tip, 新しい先端)
      └─ PredictedArc.checkSurfaceReach(tip, mid.collision)
         └─ surface-contact.ts  firstSurfaceContact(prev, next, this.radius, mid.collision)
               ← **弧の唯一の打ち切り条件**(非有限値の検出を除く)。焼失は判定しない。
                  第5章で実シミュレーションと1本になった
```

**木に載らない例外:**

- `Enemy.checkLoss` は焼失と撃破記録だけ。表面到達は接触経路が受ける(他の種別も同じ)。
- `RadiatorFold` / `BeltSection` は `EntityManager` に載らないので `cleanup` を通らない。
  天体接触の参加者からも外れる(`attachedTo !== null`)。`RadiatorFold` だけが ×4 以下の
  毎 substep に `Player.collisionFolds` で個体どうしの参加者リストへ合流する。
- `Predictor.update` は `Simulator.advance` より**後**に走る(`Game.update` の並びで、
  `advanceSimulation` の呼び出しが先)。

## 3-3. 2本の木から読めること

1. **底は完全に共有されている。** RK4・掃引の幾何・刻みの式・間引きの式。
2. **分かれているのは窓の探し方と結末だけ。** 実シミュレーションは
   `classifyAttractors`(重力)と `SurfaceCandidates`(表面)の2つ、弧は `ArcBodies` 1つ。
   どちらも 1-2 の同時性から出ている正当な差。
3. **遮蔽体の窓は重力窓から切り離された**(`3c2ef456`)。実シミュレーションは登録天体の全数を、
   弧は自分の衝突窓を渡す。顔ぶれは経路によって違うが、どちらも「幾何の窓」であって
   「重力の窓」ではない — 絞り込んだ重力窓を遮蔽体に流用していた頃の混線は解けている。
4. **接触は予測を捨てる経路でもある**が、位置も速度も動いていない当事者は書き戻さない
   ガードが両方の経路に入っている。
5. **外殻温度と動圧は RK4 で積まれていない。** `updateThermal` は区間終端の1点で密度と
   対気速度をサンプルし、`dtSub` を掛けて温度へ足す一次積分で、動圧に至っては積分ですらなく
   終端の点値。ただし**細分が支えているのはここではなく RK4 の側**だった(第7章 7-3)。
6. **刻みの階層が2段になった。** 大域 substep は全個体に共通で、時間送りとイベントだけから
   決まる。濃い大気が要求する細かい刻みはその内側に閉じ、要求した個体だけが分割される。
   相互作用(物体どうしの接触・重力窓の組み立て)は大域 substep の境界にしか現れないので、
   「同じ瞬間の位置関係で計算される」は保たれる。

---

# 第4章 逆向きの依存(`/inv-callstack`)

**`269cc8ba` 時点のスナップショット。** 走査範囲はいずれも `src/` `tests/` `tools/`。

## 4-1. 重力 RK4 積分

```
dynamics.ts  stepDynamics(state, dt, attractors, occluders, atmosphereBody, bcInv, srpCoeff, thrust)
      ← 全天体重力 + 2次重力場 + 大気抵抗 + 太陽輻射圧 + 推力の唯一の合成箇所
└─ dynamic-trajectory.ts  DynamicTrajectory.step(dt, celestialBodies, occluders, atmosphereBody,
                              bcInv, srpCoeff, thrust, sampleInterval, keepDuration,
                              extrapolationCenter)
   │     ← 積分そのものは持たず、保持列(間引き・保持窓・prevState)を足すだけ
   ├─ game-entity.ts  GameEntity.stepActual(dt, celestialBodies, occluders, atmosphereBody)
   │  ├─ simulator.ts  Simulator.substep    …… 大域 substep で1歩。**種別で分けない**
   │  │     (弧が同じ時刻を持っていれば followPredicted が先に効き、ここへ来ない)
   │  └─ simulator.ts  Simulator.stepPrecise …… doPreciseReentry かつ大気が大域より短い刻みを
   │        要求した個体だけ、大域 substep の内側で繰り返し呼ぶ
   └─ predicted-arc.ts  PredictedArc.step()
      └─ predictor.ts  Predictor.grow …… 実体の弧も計画の弧も同じ1本を通る
            (実体は ensurePredictedArc 経由、計画は PlanPath が持つ弧を PlanEditor が渡す)

呼び出し元は src/ にこの3本だけ。tests/perf(common・exp3・exp5・exp12・exp14・exp15・
sphere-contact-sweeps)と tests/physics(dynamics・dynamic-trajectory・kepler-extrapolation・
n-body・window-agreement)は stepDynamics を直接叩くが、production の経路ではない。
```

**`stepDynamics` は刻みの妥当性を検査しないが、抗力が対気速度を反転することは許さない。**
剛い抗力に対して広すぎる刻みを渡せば答えは正確でなくなるが、発散はしない(第7章 7-3)。
刻みを縛るのは呼び出し側の3本で、そのうち `Simulator.substep` と `PredictedArc.stepDt` が
`atmosphericMaxStep` を通す。`Simulator.stepPrecise` は既に縛られた刻みを受け取る。

**`totalAccel` が日照率を引く相手は、呼び出し側が渡した `occluders`** である(SRP の遮蔽体)。
重力窓とは別の引数になったので、絞り込んだ重力窓が遮蔽に化ける経路はもう無い。

## 4-2. 剛体接触ソルバー(掃引の幾何)

```
sphere-contact.ts  sweptSphereContact(aStart, aEnd, bStart, bEnd, radiusSum)
      ← 掃引の幾何はここだけ。常に三次。解法を選ぶ引数は無い。戻り値は
        { startsInside, crossing } で、null は「入力が非有限で判定できない」だけを意味する
├─ collision-response.ts  sphereContactGeometry(a, b, prevA?, prevB?)
│  │     ← 掃引が空振りしたら区間終端の重なり押し戻し(toi=1)へ落とす
│  ├─ collision-response.ts  resolveSphereCollision   (個体 × 個体。双方が逆質量を持つ)
│  │  └─ entity-contact-response.ts  entityContactResponse
│  │     └─ EntityContactPhysics.collectCandidates / .earliestContact
│  │        ├─ EntityContactPhysics.resolveEntityContacts …… ×4 以下、毎 substep
│  │        └─ EntityContactPhysics.resolveBelt …………………… ×4 以下 かつ自機生存、フレームに1回
│  └─ collision-response.ts  distributeFixedContact   (個体 × 天体。**質量を取らない**)
│     └─ SurfaceContactPhysics.resolveOne
└─ surface-contact.ts  firstSurfaceContact(prev, next, radius, bodies)
   │     ← 幾何を持たず、窓を回して最小 TOI の1体を選ぶだけ。**第5章で1本になった**ので、
   │        半径和は個体 + 天体で、実シミュレーションと弧が同じ答えを返す
   ├─ SurfaceContactPhysics.resolveOne
   │  └─ SurfaceContactPhysics.resolveSurfaceContacts
   │     ├─ simulator.ts  Simulator.advance    …… 大域 substep ごと、coarseEntitiesScratch
   │     └─ simulator.ts  Simulator.stepPrecise …… 細分した個体の**内側の1歩ごと、その1体だけ**
   └─ predicted-arc.ts  PredictedArc.checkSurfaceReach …… 弧の1歩ごと。ArcBodies の成員だけ

firstSurfaceContact は tests/physics/surface-contact.test.ts・surface-candidates.test.ts
(絞り込みの答えを総当たりと突き合わせる正本)・tests/perf/exp12 からも直接呼ばれる。
```

**天体接触の呼び出し元が2つに増えたことが、細分の唯一の構造的な代償である。** 同じ個体を
両方から解くと反発が二度当たるので、`substep` は1歩で進めた個体だけを
`coarseEntitiesScratch` へ集め、細分した個体を外側の解決から外している。

図の外:

- **`checkLoss` 系からの呼び出しは 0 件。** `c5c46dd6` で表面到達が接触経路へ移った。
- **基地を当事者に含む個体どうしの接触は掃引を通らない。** `entityContactResponse` が
  `Base.testSphereCollision`(BVH / OBB)で幾何を出し、`distributeSphereContact` で分配
  だけ共有する。
- `linearSphereContact` / `curveSphereContact` の二次 / `sweptSagitta` … src/ からの
  呼び出しは 0 件。精度を落として費用を買うときの余地として残してある(モジュール冒頭の
  コメントが `SPEC/ORBIT.md`「未確定の案」を存在理由として参照する)。
  tests/perf/exp10・exp11 だけが直接叩く。

## 4-3. この2本から読めること

第5章に着手した時点では、`sweptSphereContact` の下に**「窓を回して最初に触れる1体を選ぶ」
ループが2つ**ぶら下がっていた — `reachedBody` と `SurfaceContactPhysics.resolveOne`。問いは
同じで、違うのは返すもの(補間した到達状態 / 反発の結果)と半径和(天体の半径だけ / 個体 +
天体)だけだった。**第5章がこれを `firstSurfaceContact` の1本にした。**

残っている非対称は刻みの側にある。RK4 も表面到達も実シミュレーションと弧で共有されているが、
**刻みを縛る責任は呼び出し側3本に分散している** — `Simulator.substep` と
`PredictedArc.stepDt` がそれぞれ `atmosphericMaxStep` を通し、`Simulator.stepPrecise` は
縛られた刻みを受け取るだけ。`stepDynamics` 自身は渡された刻みを疑わず、抗力が対気速度を
反転しないことだけを守る。

---

# 第5章 論点1 — 表面到達の二重実装を1本にする

## 5-1. 目的

**「区間 [prev, next] を渡る球が、窓の中のどの天体に最初に触れるか」という問いに答える
コードが2箇所にある。**

- `attractor.ts  reachedBody` — 弧の打ち切り用。窓を回し、掃引を掛け、最小 TOI の1体を選び、
  到達状態を補間して返す。半径和は**天体の半径のみ**。
- `SurfaceContactPhysics.resolveOne` — 実体の反発用。窓を回し、掃引(を内側に含む
  `resolveFixedSphereCollision`)を掛け、最小 TOI の1体を選び、反発の結果を返す。
  半径和は**個体の半径 + 天体の半径**。

同じ問いに同じ形のループが2本あり、しかも**答えが食い違いうる**。半径和の差は
`SPEC/ORBIT.md` が「予測軌道の線は大きさを持たない点として扱う」と明記しているので現状は
仕様違反ではないが、この非対称を維持する理由は無い — 線が点であることと、線が表す物体が
点であることは別で、実体が触れるのに弧が触れないなら弧は実体を予測していない。

**修正後に期待される状態**: 窓から1体を選ぶループは1本だけ存在し、半径和は両者で同じ
「個体の半径 + 天体の半径」になる。弧の打ち切りと実体の反発は、その1本が返した
「どの天体に、区間内のどこで」を別々に解釈するだけになる。

## 5-2. 前提 — SPEC は更新済み(`cc168a43`)

`DEVELOP/SPEC/ORBIT.md`「天体表面への到達判定」は、いまこうなっている:

> **触れ合ったとみなす距離は、天体の表面半径に判定される物体自身の半径を足したものである。**
> 予測軌道の判定も同じで、その軌道を辿る物体の半径を足す。

計画では2文目を削除するだけのつもりだったが、削除だけだと「予測軌道の線」が
「判定される物体」に当たるかどうかが読み取れない(線は物体ではない)。例外を消すのではなく、
予測軌道にも同じ規則が及ぶと肯定形で書く形にした。

## 5-3. 変更が必要な箇所

**残るのは `tests/physics/attractor.test.ts` へ半径和のテストを 1 件足すことだけ**（ステップ 7）。それ以外は済んでいる — `physics/surface-contact.ts` の新設、
`SurfaceContactPhysics.resolveOne` と `PredictedArc.checkSurfaceReach` の繋ぎ替え、
`reachedBody` / `resolveFixedSphereCollision` / `attractor.ts` の `BodyImpact` の削除、
テストと exp12 の追随。

**置き場所を計画から変えた。** `firstSurfaceContact` は `attractor.ts` ではなく新設の
`physics/surface-contact.ts` に置いた — `CODING-RULE 1.3`「接触判定は重力の関心事ではない/
重力のモジュールは何が何を引くかにだけ答え、何が何に触れたかには一切答えない」。
`reachedBody` がそこに居たこと自体が規約違反で、統合先を同じ場所へ作ると違反を引き継ぐ。
`attractor.ts` は `sphere-contact` / `collision-response` のどちらも import しなくなった。

**引数オブジェクトは作らなかった。** `PredictedArc` のコンストラクタは 7 引数になったが、
`CODING-RULE 1.11`「雑多な値をまとめた引数オブジェクトを作らない」に従い、
`radius` を `bcInv` / `srpCoeff` の隣へ素の引数として置いた。

## 5-4. 達成目標 — 全件当てた

| # | 目標 | 判定 |
|---|---|---|
| 1 | 「窓を回して最小 TOI の1体を選ぶ」ループが `src/` に1本だけ | **OK** — `surface-contact.ts` の中だけ。`entity-contact-physics.ts` の最小 TOI は天体の窓ではなく個体のペア列を見ており、別の問い |
| 1b | `attractor.ts` が接触に答えていない | **OK** — `sphere-contact` / `collision-response` の import が 0 件(`CODING-RULE 1.3`) |
| 2 | `reachedBody` の綴りが 0 件 | **OK** — `src/` `tests/` `tools/` で 0 件 |
| 3 | 弧と実体の半径和が同じ式 | **OK** — 呼び出しは 2 箇所だけで、`e.radius` と `this.radius` を同じ引数へ渡す。分岐は無い |
| 4 | `resolveFixedSphereCollision` が 0 件で、掃引を二度掛けない | **OK** — 選んだときの `geometry` をそのまま `distributeFixedContact` へ渡す |
| 5 | `typecheck` と `test:physics` が通る | **OK** — 472/472 |
| 6 | 半径和が効いていることを固定するテスト | **OK** — 置き場所は `surface-contact.test.ts`(関数の移動に合わせた)。天体中心から 503 m を掛す経路で、半径 0 なら null・半径 10 m なら到達を同時に見る。物体の半径を無視する実装へ戻すと落ちることを確認済み |
| 7 | ×131072 で 60 秒回して例外 0 件、自機と破片が残る | **OK** — 下記 |

**実行時確認の結果**(`?stage=debug-load&perf=1`、ヘッドレス Chrome + CDP、起動に 105.7 s):

| 項目 | 結果 |
|---|---|
| 例外 / `console.error` | **0 件**(60 秒間) |
| 個体 | 自機 1 体が残り、破片は 500 → 295。再突入で失われる経路は働いており、消えすぎてもいない |
| 弧 | 伸長が毎フレーム 27 歩、解決天体 162 体/フレーム、**先端余裕 5,530 s** — `checkSurfaceReach` が回っていて、弧が誤って打ち切られていない |
| 積分 | substep 64/フレーム、軌道積分 18,917 歩/フレーム、重力源 65 体 |

**マップビューへ入れないと弧は伸びない**(戦闘ビューだけでは予測線の消費者がいないので
`steps` が 0 のままになる)。弧側を駆動したい実行時確認では、起動後に `M` を一度押すこと。
またこの負荷では 1 フレーム 0.5～1 s かかるので、**キー入力は固定待ちで連打しても取りこぼされる** —
ワープ段の読み値を見ながら 1 回ずつ送る。

## 5-6. 見積り

- **実装**: 書き換えは 5 ファイル・約 120 行。テストの追随は 30 箇所ほどの機械的な置換。
- **実シミュレーション側の費用**: 変化なし。掃引の呼び出し回数(実測 5,661 回/フレーム)も
  1回あたりの式も同じで、`resolveFixedSphereCollision` の内側で起きていた
  `sphereContactGeometry` 呼び出しが呼び出し側へ出るだけ。
- **弧側の費用**: 1歩・1天体あたり、掃引が空振りしたときの距離2乗の比較が1回増える
  (減算3 + 乗算3 + 比較1 ≈ 5 ns)。1フレームの弧の歩数は `ARC_STEP_BUDGET` = 600 が上限で、
  `ArcBodies` の成員数を n とすると **600 × n × 5 ns = 3n µs/フレーム**。
  同じ場所で走る掃引は実測 145.6 ns/回なので、**600 × n × 145.6 ns = 87n µs** に対して
  **3.4 %**。n = 5 でも 15 µs で、フレーム全体(実測 355.6 ms)に対して 0.004 %。
- **半径和が変わることによる答えの変化**: 自機の半径は 2.6 m、地球の半径は 6.37×10⁶ m なので、
  到達判定の閾値は **4×10⁻⁷ 倍**しか動かない。**この変更は精度のためではなく、
  規則を1本にするためのもの**である。

## 5-7. リスクと落とし穴 — 全件当てた

| リスク | 当てた結果 |
|---|---|
| 表面ちょうどに置かれた個体の弧が毎フレーム打ち切られる | **見立てた機序は誤りだったが、現象は別の道で実在する。** 下の詳細を見ること |
| 重なりフォールバックが弧にも効き、打ち切りの条件が広がる | **実害無し。** 「表面に触れない近傍通過は検出しない」は通る。広がるのは「三次曲線が跨ぎを見逃したが、区間終端では沈んでいる」場合だけで、それは天体を貫いて伸び続ける旧挙動より正しい。実行時も先端余裕 5,530 s で伸びている |
| `alreadyInside` の到達状態が `prev` から区間終端へ変わる | **意図どおり。** 移したテストは `toi === 1` を固定する形へ書き換えた。どちらも天体の内側なので表示は変わらない |
| `separation` 枝と `pushOut` 枝の場合分けを落とす | **回避。** 割る前に `collision-response.test.ts` の 2 件が両方の枝を通っていることを確かめた(prev 無し = 重なり、prev あり = 掃引)。両方とも通っている |
| `PredictedArc` の `radius` を渡し忘れる | **回避。** 既定値を持たせなかったので、渡し忘れは `typecheck` で落ちる。実際 15 箇所すべてが型検査で洗い出された |
| 絞り込みの回帰テストが何も守らなくなる | **回避。** `chordDeviationBound` を 0 へ潰すと 2 件が落ちることを、置き換え後に確かめた |

### 表面に静止した個体の弧 — 見立てを実測で訂正する

計画は「半径和ちょうどの距離になると `startsInside` が真になるので必ず打ち切られる」と見ていたが、
**これは誤り**だった。実測(月、半径 2.6 m の個体):

| 中心間距離 | 弧1歩 |
|---|---|
| 半径和ちょうど | 打ち切られない |
| 半径和 + 1 nm | 打ち切られない |
| 半径和 − 1 mm | 打ち切られる |

半径和ちょうどは重なり判定が `distSq < minD²` の厳密不等号なので拾わない — ちょうどなら弧は伸びる。

**ただし現象自体は別の道で起きる。** 静止接触の押し戻しは重なりフォールバックを通り、
めり込みの 80 %(`OVERLAP_RELAXATION`)しか解消しないので、置かれる先は常に半径和の**内側**になる
(実測で 22.5 m 内側)。だから着地した個体の弧はやはり打ち切られる。

**これは本章の変更が作った退行ではない** — 静止接触の収束先は天体半径そのものよりも内側なので、
半径和を使わない旧実装でも同じく打ち切られていた。
**静止接触の安定化(`SPEC/ORBIT.md`「未確定の案」と `memos/hedalu244/design_landing_simulation.md`)と
同じ根で、そちらでまとめて解く。**


---

# 第6章 論点2 — 天体を相手にする接触の型と名前

## 6-1. 目的(その1)— union で受けるのをやめ、口を分ける

`ContactTarget = GameEntity | Attractor` は `contact-target.ts` で定義されているが、その名前を
使っているのは `contact-damage.ts` だけで、`collideWith` / `contactsWith` / `collideAtRadiator` /
`lossReason` の署名は生の `GameEntity | Attractor` を **13 箇所**で直書きしている。
union に名前を付けた意味が出ていない。

**だが、名前を付け直すのではなく union をやめる方が良い。** 根拠は3つ:

1. **`GameEntity` と `Attractor` はもう直交した2集団である。** `Asteroid` が居た頃は
   「`GameEntity` かつ `Attractor`」が存在したので、接触の相手を1つの型で受ける意味があった。
   いまは重なりが空で、**どちらであるかは呼び出し元の経路で既に決まっている** —
   `SurfaceContactPhysics.resolveOne` は必ず `Attractor` を、`EntityContactPhysics.applyCandidate`
   は必ず `GameEntity` を渡す。渡す側が知っていることを、受け取った側が `isAttractor` で
   問い直している。
2. **実装が受け取った union をほぼ使っていない。** `contactsWith` の実装のうち引数を見るのは
   `Bullet` `RadiatorFold` `BeltSection` の3つだけで、**`Attractor` を渡されたときに false を
   返す実装は1つも無い**(`Bullet` は弾・敵味方の判定で、`RadiatorFold` / `BeltSection` は
   吊り元との判定で、どれも `Attractor` に対しては素通り)。しかも後者2つは
   `attachedTo !== null` なので天体接触の参加者にすらならない。
   **つまり天体側の `contactsWith` 呼び出しは、恒真の問い合わせである。**
3. **`isAttractor` の正しさを守るものが無い。** 判定は `'mu' in target` で、`GameEntity` に
   `mu` という名前のフィールドが生えた瞬間、型検査を通ったまま全部の天体判定が反転する
   (喪失文言・死因・ダメージの重み・基底の `collideWith`)。**口を分ければ、この判定自体が
   消えて守るものが要らなくなる** — テストで不変条件を固定するより強い。

### 変更後の形

| いま | 変更後 |
|---|---|
| `contactsWith(other: GameEntity \| Attractor, simTime): boolean` | `contactsWith(other: GameEntity, simTime): boolean`(個体どうし専用)。天体側は問い合わせを**やめる** |
| `collideWith(other: GameEntity \| Attractor, contact, stage): void` | `collideWithEntity(other: GameEntity, contact, stage): void` と `collideWithCelestialBody(body: CelestialBody, contact, stage): void` の2つ。**無標の `collideWith` は残さない** — 片方だけ無標だと、どちらの相手を指すのかが名前から決まらない |
| `collideAtRadiator(side, other: GameEntity \| Attractor, …)` | 同じく `collideAtRadiatorWithEntity` / `collideAtRadiatorWithCelestialBody` の2つへ割る(2-4 の `Player.collideWith` 重複と同じ割り方になる) |
| `lossReason(other)` の `isAttractor` 分岐 | 2つの呼び出し側がそれぞれの文言を直接渡す |
| `contactDamageSpeed(other: ContactTarget, contact)` | 天体側は `closingSpeed(contact)`(`ATTRACTOR_DAMAGE_WEIGHT` は 1 なので重み自体が消える)、個体側は `closingSpeed(contact) * other.contactDamageWeight` |
| `contact-target.ts`(`ContactTarget` / `isAttractor`) | 削除 |

`Enemy` と `Player` は「ダメージを当てる → HP が残れば音とパフ → 尽きたら喪失を記録」という
尾を2つの口で共有することになるので、**その尾を private メソッドへ括り出す**(喪失の文言と
撃破の記録種別だけを引数に取る)。括り出したあとの `collideWithEntity` / `collideWithCelestialBody` は
それぞれ4〜5行になる。

### 天体側で `contactsWith` を呼ばなくなることの意味

`SurfaceContactPhysics.resolveOne` から `e.contactsWith(body, simTime)` が消える。
**これは挙動を変えない**(上記2 のとおり恒真)。`SPEC/ORBIT.md`「天体との接触」は
「生存している物体はすべて参加し、物体どうしの接触判定を持つかどうかにも依らない」と
既に書いてあり、**個体の側が天体を拒める余地はそもそも仕様に無い**。仕様の変更は不要。

## 6-2. 目的(その2)— `Attractor` という名前をやめ、`CelestialBody` にする

`Asteroid` が消えたことで、`Attractor` は**解析天体のある瞬間のスナップショット**と1対1に
対応するようになった。ところが:

- **名前が「重力源」を主張しているのに、`mu = 0` を容認している。** 既定レジストリ 101 体の
  うち **36 体が `mu = 0`** で、`attractorsAt` はそれを全部返す。表面接触・遮蔽・中心天体の
  解決・積分刻みの決定は、どれも重力とは無関係にこの窓を読む。
- **`CODING-RULE 2.2` は「重力源としての値は `attractor`」と決めている。**
  つまり現状の `Attractor` 型と `attractorsAt` は、リポジトリ自身の命名規則に違反している。

**改名する。ただし全部ではない** — 重力の文脈で `attractor` を名乗っているものは正しいので
残す。

### 改名先は `CelestialBody` — 無標の `body` にはしない

`CODING-RULE 2.2` は元は「`body` は天体の意味に残す」と書いていた。これは `Asteroid` 廃止前に
「無標の `body` を機体座標系に取られると苦しい」という文脈で決めた暫定であって、積極的な推奨では
なかった。**いまの語彙では、無標の `body` は天体・機体・剛体のどれにも読める。** 今後 `rigidBody`
が要るようになれば衝突もする。よって**単体の `body` を接辞にせず、`CelestialBody` を原則とする**
— `CelestialBodyId` / `celestialBodiesAt` / `celestialBodyAt`。狭いスコープのローカル変数だけは
無標の `body` でよい。この決定は `CODING-RULE 2.2` 側へ反映済み。

| 改名する | しない(重力の文脈で正しい) |
|---|---|
| 型 `Attractor` → `CelestialBody` | `attractorAccel` |
| `AttractorId` → `CelestialBodyId`(`OrbitingId` はそのまま) | `strongestAttractor` |
| `Ephemeris.attractorsAt` → `celestialBodiesAt` | `gravityAttractorsAt` |
| `Ephemeris.attractorAt` → `celestialBodyAt` | `classifyAttractors` / `attractorsNearInto` / `ClassifiedAttractors` |
| `attractorStateAt` / `attractorPositionAt` → `celestialBodyStateAt` / `celestialBodyPositionAt` | `GRAVITY_ALWAYS_COUNT` / `GRAVITY_NEGLIGIBLE_ACCEL` |
| `frameOfAttractor` → `frameOfCelestialBody` | |
| `atmosphereAttractorsAt` → `atmosphereCelestialBodiesAt` | |
| creative の `ReferenceAttractor` → `ReferenceCelestialBody` | |
| `FutureAttractorProvider` / `FutureAttractors` → `FutureCelestialBodyProvider` / `FutureCelestialBodies` | |
| `FutureAttractorProvider.bodyAt` → `celestialBodyAt` | |

**既にある無標の `body` のうち、この章で直すのは `FutureAttractorProvider.bodyAt` だけ** —
`Ephemeris.celestialBodyAt` へそのまま委譲する同じ呼び出しなので、名前が割れると「類義語の混雑」
そのものになる。`ArcBodies` / `ArcBodyWindow` / `FutureBodyCandidate` / `bodyDef` /
`BodyClass` / `body-visibility.ts` も無標の `body` を接辞にしているが、`Attractor` の改名とは
別の面なので**この章では触らない**(別途片付ける)。

**セーブデータの形式は変わらない** — 直列化されるキーは `centerBodyId` と `phaseOffsets` で、
`AttractorId` は型としてしか現れない。

## 6-3. 「フィールドを分割する意味が薄れたのでは」への回答 — **分割は維持する**

`CelestialBodyDef`(静的事実 + 軌道)と `Attractor`(時刻 t のスナップショット)を1つに
畳む案は**採らない**。8 フィールドのうち **4 つが時刻依存**だからである。

| フィールド | 由来 |
|---|---|
| `id` / `mu` / `radius` / `isStar` | `CelestialBodyDef` からそのまま(静的) |
| `state` | `Ephemeris.stateOf(id, t)`(時刻依存) |
| `accel` | `Ephemeris.eciAccelOf(id, t)`(時刻依存) |
| `degree2` | `degree2At(def, t)` — 自転軸 `pole` が時刻で回る(時刻依存) |
| `atmosphere` | `atmosphereAt(def, t)` — 同上(時刻依存) |

`{ def, state, accel }` の形にしても静的なのは 4 つだけで、全消費者に `.def.` の一段が増える
だけになる。**「同じ概念に二つの名前がある」のではなく、「同じ天体の、時刻を持たない記述と
持つ記述」であって、両方が要る。** 直すべきなのは名前だけである。

## 6-4. 実施時に決めたこと

- **`Player.collideAtRadiatorWithCelestialBody` は作らなかった。** 接触代理(`RadiatorFold`)は
  `attachedTo` を持つので `collectParticipants` を通らず、天体接触に参加しない
  (`SPEC/ORBIT.md`「艦に取り付いた局所の接触代理は参加しない」)。口を分けたことで
  「経路が無い」ことが型に出たので、書けば到達しないコードになる。
- **`Player` の共通の尾(`damagedByContact`)は破壊エフェクトを含む。** 落とし穴の表は
  「尾に含めず `collideAtRadiator` 側に残す」としていたが、エフェクトは
  `applyCollisionDamage` と HP 判定の**間**にあるので、外へ出すと呼び出し順が変わる。
  代わりに `side` を尾の引数に取り、`side !== null` のときだけ出す形にした。
- `resolveSurfaceContacts` から `simTime` 引数を外した(`contactsWith` の呼び出しが消えて
  使わなくなった)。
- **改名先の `CelestialBody` は、見た目側の `CelestialBody`(`src/game/celestial/`)と
  衝突した。** 同ディレクトリの `RingView` / `PointFieldView` に倣い、見た目側を
  `CelestialView` / `Earth`・`Sphere`・`Point`・`SunView` へ寄せ、レジストリ項の
  `CelestialView` は `CelestialViewDef`、`CELESTIAL_BODIES` は `CELESTIAL_VIEWS` にした。
- `src/physics/attractor.ts` → `celestial-body.ts`。`src/game/simulation/attractors.ts` は
  重力源の分類そのものなので**名前を変えていない**。

## 6-5. 達成目標 — 8 件中 7 件を当てた

1. `ContactTarget` と `isAttractor` の綴りが `src/` に **0 件**。
2. `GameEntity | Attractor` / `Attractor | GameEntity` の綴りが **0 件**。
3. 天体との接触経路に `instanceof` も `'mu' in` も現れない。
4. 型 `Attractor` の綴りが 0 件で、`CelestialBody` になっている。`attractor` を名乗って
   残るのは重力の計算(`attractorAccel` / `strongestAttractor` / `gravityAttractorsAt` /
   `classifyAttractors` / `attractorsNearInto`)だけである。
5. 改名で新しく作った識別子に、無標の `body` を接辞に持つものが1つも無い。
6. `DEVELOP/CODING-RULE.md` 2.2 の「`celestialBody` / `ship` / `attractor`」節が、改名後の
   実態と一致している(規則の側は先に直してあるので、変えるのは**コードだけ**。規則を弱めない)。
7. `npm run typecheck` と `npm run test:physics` が通る。
8. セーブの読み込みが壊れていない(既存スロットのロード)。

1〜7 は当てた(1〜5 は grep が 0 件、7 は `typecheck` と `test:physics` 472/472、
加えて `npm run build` が通ることで webpack 側の解決も確かめた)。

**8 だけ残っている。** この環境ではブラウザを駆動できない(9-3)ので、静的にしか
確かめていない — `SAVE_VERSION` は変わらず、`save-data.ts` の差分は型注釈2行だけ、
直列化されるキーも値も変わらない。**実機でスロットを1回ロードすること。**

## 6-6. 実測

- **6-1**: 13 ファイル、+92 / −105 行(`contact-target.ts` の削除を含む)。
- **6-2**: 130 ファイル、+1039 / −1038 行。うち9ファイルはファイル名の変更。
- **費用への影響**: 0(判定の削除も改名も、実行時の分岐を増やさない)。

## 6-7. リスクと落とし穴 — 当てた結果

| リスク | 影響 | 当てた結果 |
|---|---|---|
| 天体側の `contactsWith` を消したことで、将来「この個体は天体をすり抜ける」を書けなくなる | 仕様上そういう個体は無い(`SPEC/ORBIT.md`「生存している物体はすべて参加し」)が、**必要になったら口を戻すことになる** | **踏んでいない。** 仕様は変わっていない。露見するのは仕様が変わったときで、そのとき口を戻す |
| `Player` の尾を括り出すときに、放熱板側だけにある破壊エフェクトを落とす | 放熱板が壊れても演出が出ない。**静かに消える** | **踏んでいない。** `radiatorBreakEffect` は `damagedByContact` の中に残っており、`applyCollisionDamage` と HP 判定の間という元の位置も保っている(6-4) |
| `Enemy` の撃破記録の種別(`'collision'` / `'killed'`)を口ごとに固定するとき、逆に付ける | ステージのスコアと撃破ログが入れ替わる。**型では捕まらない** | **踏んでいない。** `collideWithCelestialBody` → `'collision'`、`collideWithEntity` → `'killed'` |
| 改名で `attractor` を名乗るべきものまで `CelestialBody` にする | 重力の文脈が薄まり、`CODING-RULE 2.2` を今度は逆向きに破る | **踏んでいない。** `attractorAccel` 23 / `strongestAttractor` 75 / `gravityAttractorsAt` 52 / `classifyAttractors` 23 / `attractorsNearInto` 23 が改名前と同数で残っている |
| 置換で `Attractor` → `Body` の短い綴りを作ってしまう | 無標の `body` が増え、`CODING-RULE 2.2` の新しい規則を破ったまま残る | **踏んでいない。** `BodyId` / `bodiesAt` / `bodyAt` / `bodyStateAt` / `bodyPositionAt` / `frameOfBody` はいずれも 0 件 |
| `AttractorId` → `CelestialBodyId` がセーブの型注釈に触れる | 型名だけが変わり形式は同じなので実害は無いが、`SAVE_VERSION` を上げたくなる誘惑が出る | **踏んでいない。** `SAVE_VERSION` は差分に無い |

**この章で片付けなかった無標の `body`**(`Attractor` の改名とは別の面):
`ArcBodies` / `ArcBodyWindow` / `FutureBodyCandidate`、`bodyDef`、`BodyClass` /
`BodyClassToggles`、`body-visibility.ts`、セーブのキー `centerBodyId`(形式なので変えられない)。

---

# 第7章 論点3 — 精度と性能のために入った密結合

**この章は「まず仕様から手段を追い出し、そのうえで測って決める」。** 精度と性能のために
物理の規則を曲げている箇所が2つあり、どちらも曲げるに足る根拠が実測で残っていない。
ただし**曲げてよいかどうかは実装の裁量であって、仕様が決めることではない** — だから
SPEC の掃除が先で、実測はそのあとに来る。

## 着手順(この章の中)

| 順 | 節 | 何をするか |
|---|---|---|
| 1 | 7-1 | SPEC から精度と性能を追い出す |
| 2 | 7-2 | 物体どうしの接触を ×4 超で解かないことを測る |
| 3 | 7-3 | 大気の中の刻みを測り、細分の置き場所を決める |

**7-1 は実測を待たない。** 実測の結論がどちらへ転んでも SPEC の書きぶりが変わらないからで、
そこが変わったときに書き換わるのはコードだけである。ゲートを残すと決めても、刻みを細かいまま
にすると決めても、それは**確定した仕様ではなく、性能の都合で今後も動きうる保留**として扱う。

## 7-1. SPEC から精度と性能を追い出す

### 目的

`SPEC/README.md`「書き方の規則」は既にこう書いている:

> **達成した精度・刻み幅を書かない。** 書くのは「どういう状況で、何が正しく見えていなければ
> ならないか」だけである。

**この規則が守られていない。** そして規則の言い方が狭すぎる — 「達成した」精度だけでなく、
**手段としての精度と性能の判断そのものを仕様に書いてはいけない。** 軽量化のために判定を抜く、
アドホックに刻みを変える、といった判断は実装側の問題で、仕様が言うべきなのは
「表示とゲームプレイの側から見て何が正しく見えていなければならないか」だけである。

### 決めたこと — 性能のために諦めたものを、確定仕様に埋め込まない

「高い倍率では物体どうしがすり抜ける」も「再突入域では刻みを細かくする」も、**目指した
振舞いではなく、費用のために諦めた(あるいは費用を払って選んだ)結果**である。境界の倍率も、
そもそも諦めるかどうかも、性能の都合で今後も動く。確定仕様へ書き込むと、性能を調整する
たびに仕様が嘘になる。

→ **本文からは削除し、`ORBIT.md`「未確定の案」へ置く。** 7-2 / 7-3 の実測で「今は残す」と
決めても、この扱いは変わらない — 残す判断もまた性能の判断だからである。

**確定仕様として残るのは、諦めていない側の帰結だけ**:

- 天体の表面への接触は倍率に依らず解決される(艦・敵機・弾・デブリのどれも天体をすり抜けない)。
- 機体を失うかどうかと、その文言は、倍率に依らない。
- ワープを上げたことが軌道の変化として見えてはならない。

### やった結果(`092e303c`)

`README.md` の規則を広げ、`ORBIT.md` / `GAME.md` / `CONTROLS.md` / `FLIGHT.md` /
`COMBAT.md` / `AUDIO.md` から手段としての刻み幅・省略・計算量を削った。
`CELESTIAL.md` 2.2 と `MAP.md` の精度の記述は**残した** — どちらもプレイヤーが画面で見る
帰結を述べていて、実装の裁量ではない。

**削除した記述と、代わりに残した帰結**(達成目標 3 の突き合わせ):

| 削除したもの | 残した帰結 | 置き場所 |
|---|---|---|
| 重力環境をサブステップ中間時刻で一度だけ評価すること | 同じサブステップの中で相互作用するものは同じ瞬間の位置関係で計算される | `ORBIT.md` 時間刻み |
| 幅と本数の上限、計算コストが倍率に比例しないこと | 倍率をどれだけ上げても1フレームの計算が終わらなくなることはない | 同上 |
| 本数の上限が刻みを広げること(数値的な限界) | 最高倍率の地球低軌道では数値誤差由来の軌道減衰が生じる | `ORBIT.md` 数値的な限界 |
| 再突入域の細分化(境界高度 200 km・基準面・対象を艦に限る理由・上限に優先すること) | ワープを上げたせいで艦が焼ける時期が早まってはならない / 機体を失う理由と文言は倍率に依らない | `ORBIT.md`・`GAME.md`・`FLIGHT.md` |
| 物体どうしの接触が ×4 超で解かれないこと(6ファイル7箇所) | **本文には残さない**(下の「決めたこと」のとおり) | `ORBIT.md`「未確定の案」に1件 |
| 天体表面への接触はどの倍率でも働く、という対比の文(ゲートと同居していたもの) | 天体表面への接触は倍率に依らず解決され、何も天体をすり抜けない | `ORBIT.md` 天体との接触・`GAME.md`・`COMBAT.md`・`CONTROLS.md` |

表に無かった1件も直した: `ORBIT.md`「未来予測」の「再突入高度での細分化にも同じように従う」は、
細分化を消したことで宙に浮くので削除した。予測の刻みが実シミュレーションと同じ規則で決まる、
という肝心の不変条件は残っている。

### 達成目標 — 全件当てた

1. `SPEC/README.md` の規則が「精度と性能は仕様化しない」の形になっている — **達成**。
2. `SPEC/` の本文に手段としての刻み幅・省略・計算量の記述が残っていない — **達成**。
   残る「刻み」の語は、サブステップが在ること・接触の解決順・予測が同じ規則で刻むこと・
   「刻み幅と間引きの粗さは実装時に決める」という裁量の宣言だけで、値も省略もない。
3. 削除した記述の観測できる帰結が残っている — **達成**(上の表)。
4. 「高い倍率では物体どうしがすり抜ける」が本文に無く、「未確定の案」に1件だけある — **達成**。

## 7-2. 物体どうしの接触を ×4 超で解かないこと(`canResolvePhysicalCollisions`)

### 何が問題か

`SimSpeedManager.canResolvePhysicalCollisions`(`simSpeed <= MAX_PHYS_SIM_SPEED` = ×4)が、
`EntityContactPhysics.resolveEntityContacts` と `resolveBelt` の両方を止めている。
ゲートの根拠は、7-1 で SPEC から外すまでこう書かれていた:

> 相手の状態も積分で決まるため、サブステップの幅がそれだけ広いと接触判定そのものに
> 意味がなくなる。

**この根拠は測られていない。** そして疑わしい点が3つある。

1. **弾・破片のまとめ積分を廃したとき(`f68be2c3`)に確立した基準は「1歩が周回の何倍にも
   なると三次曲線が軌道から外れる」だった。** ×131072 の substep 幅は
   `max(SUBSTEP_MAX_DT, simDt / SUBSTEP_MAX_COUNT)` で決まり、60 fps なら
   `max(20, 2184.5/64)` = **34.1 s**、フレーム時間が上限 0.1 s に張り付く低 fps でも
   `max(20, 13107/64)` = **204.8 s**。低軌道の周期 5,400 s に対して **1/158 周〜1/26 周**に
   すぎない。廃止の根拠になった「1歩で 6 周回」とは2桁ちがう。同じ基準で判断するなら、
   この幅の三次曲線は軌道から外れていない。
2. **ゲートが覆う2つは根拠が違う。** `resolveBelt` は実 dt でフレームに1回解く艦のローカル
   物理で、substep 幅に依存しない。上の根拠はベルトには当てはまらない
   (艦の操作自体が ×4 超で効かないので実害は無いが、根拠と対象が一致していない)。
3. **絞り込みが効いていれば、外しても重くならない可能性がある。**
   `contactCellSize` は参加者集合の**平均変位を差し引いた**相対到達量でセル一辺を決めるので、
   同じ軌道に固まっている集団では倍率を上げても一辺が伸びない。実測(exp12、×131072、
   自機 + 破片 500 体)で一辺は **752.6 m**。ばらけた集団なら伸びるはずで、
   **どちらになるかは母集団しだい** — そこが測る対象。


### 実測した結果(`tests/perf/exp13-entity-contact-warp.ts`、`092e303c` 時点)

母集団は `collides = true` の個体だけで組み直した。**同一軌道に密集**(自機1 + 敵機3 +
薬莢260 + 放熱板の折り12 + ベルトの節18 = 294 体)と、**高度と傾斜角がばらけた集団**
(同じ内訳に飛翔中の弾 400 を足し、敵機を高度 ±50 km・別の傾斜へ移した 694 体)の2つ。
費用はグリッド構築・27近傍の列挙・`resolveSphereCollision` の合計で、反発の書き戻しと
TOI 順の再評価は含まない(接触が実際に起きた件数はそれとは別に数えた)。

| 倍率 | substep 幅 [s] | substep/フレーム | 密集: セル一辺 [m] / 候補ペア/substep / 費用 [ms] | ばらけ: セル一辺 [m] / 候補ペア/substep / 費用 [ms] |
|---|---|---|---|---|
| ×1 | 0.02 | 1 | 360.3 / 41,760 / **7.1** | 361.5 / 920 / 1.1 |
| ×4 | 0.07 | 1 | 361.3 / 41,760 / **8.0** | 366.0 / 978 / 0.8 |
| ×64 | 1.07 | 1 | 380.9 / 41,760 / 6.5 | 2,173 / 12,660 / 3.3 |
| ×1,024 | 17.07 | 1 | 693.9 / 41,760 / 7.3 | 34,769 / 216,880 / 43.1 |
| ×4,096 | 20.00 | 4 | 751.3 / 41,762 / 27.9 | 40,744 / 147,330 / 103.1 |
| ×16,384 | 20.00 | 14 | 751.3 / 41,778 / 87.5 | 43,665 / 77,840 / 197.5 |
| ×65,536 | 20.00 | 55 | 1,071 / 35,061 / 302.8 | 74,182 / 49,085 / 451.7 |
| ×131,072 | 34.13 | 64 | 4,642 / 37,194 / **383.9** | 275,195 / 51,677 / **540.8** |

三次曲線の乖離(R\* − 真の最接近距離。真値 10 m、`exp11` と同じ二分探索):

| 倍率 | substep 幅 [s] | 薬莢 3 m/s | 敵機 200 m/s | 弾 1,000 m/s |
|---|---|---|---|---|
| ×1,024 | 17.07 | −0.0 µm | −139 µm | −3.5 mm |
| ×16,384 | 20.00 | −0.1 µm | −360 µm | −9.0 mm |
| ×131,072 | 34.13 | −2.0 µm | −8.9 mm | −220 mm |

### 決めたこと — ゲートは残す。ただし SPEC が書いていた根拠は誤りだった

- **「サブステップの幅が広いと接触判定に意味がなくなる」は成り立たない。** 最高ワープの
  34.1 s の1歩でも、掃引の三次曲線は真の最接近距離を **22 cm**(相対 1,000 m/s)以内で
  当てる。低速の相手なら µm 単位である。**判定の意味は失われていない。**
- **外せないのは費用のため。** 最高ワープの1フレームは密集で 384 ms、ばらけで 541 ms —
  16.7 ms の予算の 20〜30 倍。「費用がフレーム時間の数 % に収まる」は外れたので、
  計画の決め方どおり**ゲートは残す。**
- SPEC は 7-1 のままでよい。ゲートは**確定仕様ではなく「未確定の案」**にあり、
  性能が変われば動く。**残す判断も性能の判断である。**

### 測って分かった、ゲートとは別の2つ

1. **費用が増え始めるのは ×4,096 から** — そこで初めて substep が2本以上になる。
   ×4 と ×1,024 の費用は同じ(密集で 7〜8 ms、1 substep のまま)。**いまのゲートの位置
   ×4 は、費用が跳ねる場所とは3桁ずれている。** 帯域を上げるかどうかはゲームの判断なので、
   ここでは動かさない。
2. **セル一辺は参加者全体で1つなので、半径の大きい参加者が1体いるだけで絞り込みが死ぬ。**
   敵機の接触半径 180 m がセル一辺を 360 m へ固定し、その中に収まる薬莢の群れ(200 m)は
   1セルへ落ちる — 密集の削減比が全倍率で **1.0×**(総当たりと同じ)なのはこれである。
   **これは高ワープの問題ではなく、×1 で既に起きている**(7.1 ms/フレーム)。
   グリッドの一辺を参加者ごとの到達量から決める余地はあるが、この論点の外なので触らない。

## 7-3. 大気の中の刻みと、その細分の置き場所

### 何が問題だったか

刻みを決めていたのは `reentryAwareMaxStep` で、規則は「大気天体の基準楕円体から 200 km 以下なら
刻み 1 s」という**高度の代理**だった。抵抗の強さそのものを見ていないので、3方向に外れていた。

1. **高い側では過剰。** 高度 200 km の抗力の逆時定数は 1×10⁻⁹ s⁻¹ で、20 s 刻みでも十分安定
   なのに 1 s へ落とす。60〜200 km の帯で substep が 20 倍要る。
2. **低い側では不足。** 1 s でも ρ·s > 1697 kg·m⁻²·s⁻¹ を超えれば破綻する。
3. **境界で刻みが 0 へ潰れる。** 境界までの猶予をそのまま刻みにしていたので、200 km へ漸近する
   幾何級数(Zeno)になる。実測で 1×10⁻³ s 未満が4回連続、最小 1.49×10⁻⁸ s。
   `advance` は `subDt <= 1e-9` しか空回り扱いしないので、**この4歩は接触解決まで実行される。**

そして刻みの上書きは**全個体で共有**だったので、艦が高度 200 km を割った瞬間、最高ワープの
1フレームが 13,107 substep を要求し、破片 500 体もその刻みに付き合わされていた。

### 発散の原因 — 大気抵抗ただ1つ、壊れ方は2つ

`tests/perf/exp15-reentry-divergence.ts` の表1・表2(`269cc8ba` 時点)。

**力を1つずつ落とすと、抗力を切ったときだけ完走する。** 刻み 20 s の降下で、全力なら対気速さの
最大が 9.7×10⁷ km/s へ飛ぶが、`bcInv = 0` にすると 8.00 km/s・最低高度 42.3 km で完走する。
2次重力場を落としても太陽輻射圧を落としても発散は変わらない。

**(A) 抗力の剛性。** λ = ½·ρ·s·bcInv [1/s] が抗力の逆時定数。陽的 RK4 が y' = −λy に対して
安定なのは λ·dt ≲ 2.78 まで。刻み 34.13 s では高度 22.8 km で **λ·dt = 4.12** となり、段ごとの
抗力が 1.7×10² → 3.9×10² → 3.6×10³ → **3.0×10⁷ m/s²** と増幅して1歩で壊れる。抗力が速さの
2乗に比例するため、正のフィードバックが掛かって振動ではなく暴走になる。

**(B) 段の外挿が地面を突き抜ける。** RK4 の k3 は `r0 + (v0 + a1·dt/2)·dt/2` で、**重力だけで**
動径方向に g·dt²/4 沈む。刻み 204.8 s ではこれが 99.6 km になり、

| 段 | 高度 | \|抗力\| [m/s²] |
|---|---|---|
| k1 | 91.5 km | 2.2×10⁻¹ |
| k2 | 99.8 km | 4.8×10⁻² |
| k3 | **0.1 km** | 1.0×10⁵ |
| k4 | **−7.0 km** | **8.9×10¹¹** |

この歩の **λ·dt は 0.006** — 剛性は全く問題ない。`atmosphericDensity` が高度を 0 で頭打ちに
するので海面密度 1.225 kg/m³ が返り、そこへ軌道速度を掛けた抗力が k4 に入る。

**片方だけでは足りない。** 軌道の族6本で、剛性だけを縛ると **6/6 発散**、沈み込みだけを縛っても
**6/6 発散**。両方掛けて **0/6** になる。(この 6/6 は後述のガードを入れる前の測定。ガードを
入れると発散そのものが起きなくなるので、いまの exp15 は「発散したか」ではなく
「**段の比が 1 を超えたか**」を測っている。)

### 発散の条件は「反転」— 段の抗力が、その段の対気速度を1歩で奪い切ること

上の (A) と (B) は、**同じ1つの signature で現れる。** 段 k の抗力が dt のあいだに奪う速度
|a_drag|·dt を、その段の対気速さ |v_air| と比べた比が 1 を超えると、その段は対気速度を消し切って
**押し返している。** 抗力は対気速度を減らすだけで反転させられないので、これは物理的にありえない。
そこから先は抗力が速さの2乗に比例するぶん段どうしが増幅し合い、1歩で暴走する。

最初に比が 1 を超えた歩を、刻みごとに並べると:

| 刻み | その歩の高度 | k1 の比(= λ·dt) | 各段の 高度/比 |
|---|---|---|---|
| 204.8 s | 91.5 km | **0.006** | k1 91.5km/6.3e-3  k2 99.8km/1.4e-3  **k3 0.1km/2.9e+3**  k4 −7.0km/4.3e+2 |
| 34.13 s | 42.3 km | 0.649 | k1 42.3km/6.5e-1  k2 36.8km/9.7e-1  **k3 35.7km/1.1e+0**  k4 32.1km/9.7e-1 |
| 20 s | 22.6 km | 0.879 | k1 22.6km/8.8e-1  k2 20.0km/8.6e-1  **k3 20.2km/1.0e+0**  k4 17.6km/8.1e-1 |

(A) は k1 の比が 1 に近づいて k3 が跨ぐ形、(B) は **k1 の比が 0.006 でも k3 が 2.9×10³ へ跳ぶ**形。
どちらも「どこかの段が比 1 を超える」ことに変わりはない。

### 決めたこと(0)— 抗力が対気速度を反転できないことを、積分器に守らせる

`dragAccel` が `dt` を受け取り、`a = k·v_air` の係数を **|k| ≤ 1/dt** で頭打ちにする。
「抗力は対気速度を減らすだけで反転させない」という物理そのもので、式としては1行。

- **刻み規則が効いているところでは一度も発動しない。** 軌道の族6本すべてで、段の比の最大は
  **0.558〜0.560** — 頭打ちの 1 に届かない。**答えを一切変えない安全網**である。
- **発動するのは、刻みがその物体の抗力に対して既に広すぎるときだけ。** そこで得られる軌道は
  正確ではない(刻み 204.8 s 固定なら動圧が 14,803 kPa)。**不正確な答えと発散した答えの
  どちらを返すかの選択で、後者を選ばない**というだけのこと。`SPEC/ORBIT.md`「数値的な限界」に
  書いた。
- **これが破片・薬莢の欠陥を直す。** 高度 200 km から刻み 204.8 s で降ろすと、ガード無しでは
  200 歩を回しても焼失せず動径 6.25×10⁶ km(地球–月距離の 10 倍)まで飛んでいく。
  ガードありでは **3 歩で高度 48.7 km において焼失する**(対気速さ 5.30 km/s)。
  `doPreciseReentry = false` が宣言しているのは「低い精度で失われてよい」ことなので、
  48.7 km で消えるのは仕様の範囲内である。

### ガードを入れたあと、2つの上限のどちらが効いているか

**訂正が要る。** ガードを入れると「片方だけでは足りない」は成り立たなくなった。

| 上限 | 段の比の最大 | 外殻温度の誤差(6本) |
|---|---|---|
| 両方(本体の定数) | 0.558〜0.560 | +0.6 〜 +1.7% |
| 沈み込みだけ(剛性を外す) | **4.9** | +0.6 〜 +1.7%(両方と同じ) |
| 剛性だけ(沈み込みを外す) | 16 〜 3.0×10³ | **+83.6 〜 +7,065%** |

**沈み込みの上限だけでも、答えは合う。** ただしその答えは毎歩ガードに助けられている(比の最大
4.9 = 頭打ちが 5 回ぶん働いている)。**剛性の上限を残すのは、ガードを一度も踏ませないため**で、
「有界であること」ではなく「積分が妥当であること」を保つ側に倒している。剛性の上限を外して
得られる歩数の節約は 6〜18%(413/55 で 103 → 84 歩、GTO で 363 → 343 歩)で、その代償に
見合わない。

### 熱・動圧は RK4 の下流で、逆流しない

`updateThermal` は `state.r` / `state.v` を読んで `hullTemp` と `qdyn` を書くだけで、状態を
書き戻さない。`Simulator` の中でも軌道積分の**後**に呼ばれる。唯一の間接経路は「熱で艦が死ぬ →
細分の対象から外れる → 刻みが広がる」で、向きは「壊れた熱が RK4 を壊す」ではなく逆。

**7-3 の冒頭に書いていた「細分が支えているのは熱の一次積分の側だ」という読みは、exp14 で一度
覆り(熱だけなら 10 s でも同じ答え)、exp15 で原因まで特定された — 支えていたのは RK4 の側で、
壊していたのは抗力だった。**

### 決めたこと(1)— 刻みを物理量から決める

`reentryAwareMaxStep` を捨て、`atmosphericMaxStep(state, bcInv, atmosphereBodies)` に置き換えた。
上限は2つで、小さいほうを採る。

```
剛性  : dt ≤ DRAG_STEP_MAX_SPEED_LOSS / λ          λ = ½·ρ·s·bcInv
沈み込み: 降下率·dt + ½·g·dt² ≤ N·H を dt について解いた有理化形
          N = DRAG_STEP_MAX_SCALE_HEIGHTS、H = そのときのスケールハイト
```

有理化するのは g → 0(遠方・薄い大気)で 0 除算にならないため。しきい値が無いので Zeno も消えた。
`atmosphericScaleHeight` を `physics/atmosphere.ts` へ足し、層走査を `atmosphericDensity` と
共通化している。

**定数を縛るのは安定性ではなく精度だった。** 発散しない上限は ratio=N=1.5 あたりにあるが、

| 定数 | 413/55 km | 413/−200 km | GTO 再突入 | 破綻 |
|---|---|---|---|---|
| ratio=N=0.5(採用) | +0.6% | +1.7% | **+1.5%** | — |
| ratio=N=1 | +0.7% | +3.7% | **+7.6%** | — |
| ratio=N=2 | ★発散 | ★発散 | +6.0% | 2/6 |

(外殻温度の最大の、刻み 0.25 s の基準に対する誤差)

限界 1,300 K に対して +7.6% は艦の生死を変える。ratio=N=2 は近地点 0 km で動圧が
**35.6 kPa** になり、限界 35 kPa を超えて**艦が誤って空力破壊と判定される。**
採用値では動圧の誤差は −1.3 〜 +0.0% に収まる。

### 決めたこと(2)— 細分をサブステップの外へ出さない

刻みを正しく縛るだけでは、**目的(高い時間加速で低費用)を達成できない。** 刻みが全個体で共有
されている限り、艦が要求する細かさに他の 500 体が付き合わされる。

**陰的化(A 安定・L 安定)は解にならない。** 陰的 Euler と陰的中点則を実装して測ると、発散は確かに
消える(20〜204.8 s のすべてで完走)。しかし精度の壁が **68 s** にあり、陰的中点則の 102.4 s は
外殻温度 +38% / 動圧 +318%、204.8 s は動圧 8,648 kPa(限界 35 kPa)で艦が誤って破壊される。
基準軌道から読んだ「1歩で失う対気速度の割合」は 20 s で 0.42、68 s で 0.67、**204.8 s で 0.97** —
一段法では解けない。費用も、陰的中点則 68 s は自機1体につき 911 回の f 評価 + 125 回の Newton
(各 6×6 の LU)で、陽的 + 刻み制限の 412 回より**高い**。利得は 100%「他の 500 個体を艦の刻みに
付き合わせない」ことに由来しており、それは細分を大域から切り離せば直接得られる。

そこで **大域サブステップは据え置き、要求した個体だけがその内側で分割する** 形にした
(`Simulator.stepPrecise`)。内側の1歩ごとに、積分・熱・天体接触の3つを回す。

- **熱を内側で回さないと**、204.8 s サンプルの外殻温度が 761 K のところ 2,156 K になり、
  生き延びるはずの艦が焼失と判定される。
- **天体接触を内側で解かないと**、地表へ達した後も内側ループが積み続け、地面の下
  (密度は海面値で頭打ち)で状態が壊れる。
- **同じ個体を外側の天体接触にも渡すと**、反発が二度当たる。`resolveOne` は解決後に `e.state` を
  接触点へ書き戻すので、同じ区間を再判定すると再び接触が見つかる。1歩で進めた個体だけを
  `coarseEntitiesScratch` へ集めている。

**内側では ephemeris を一切組み直さない。** これが成立条件で、組み直すと細分の意味が消える
(内側1歩あたり 543 + 626 + 29 µs、3,671 歩で 4.4 s)。根拠:

- `celestialBodyPositionAt` が `r + v·s + ½·accel·s²` の2次外挿を段ごとに行っており、
  ±102.4 s まで伸ばしたときの**重力寄与の相対誤差は全 65 体で ≤ 1.1×10⁻⁹**(月 9.3×10⁻¹⁰、
  最悪はメティスの 1.1×10⁻⁹)。しかも ±102.4 s は新しい負荷ではない — 再突入していない
  最高ワープでは大域 substep が既に 204.8 s。
- 重力源の名簿は固定(t=0 / 204.8 / 13107 で同一)。
- `classifyAttractors` のしきい値もセル一辺も `mu` だけから決まる。
- `attractorsNearInto` のセル一辺 1.2×10⁷ km に対し、艦は 1 substep で 1,618 km しか動かない
  (**7,400 分の1**)。さらに27近傍で ±1 セルの余裕がある。

### 費用(実測)

substep ごとの固定費 1,225 µs(`gravityAttractorsAt` 543 + `celestialBodiesAt` 626 +
`atmosphereCelestialBodiesAt` 26 + `classifyAttractors` 29)。個体ごとは
`attractorsNearInto` + `nearestAtmosphereBody` で 0.9 µs、`stepDynamics` が自機 18.6 µs
(SRP の遮蔽走査 65 体を段ごとに含む)・破片 5.1 µs。

最高ワープ・低fps(simDt = 13,107 s)、自機1 + 破片500 の1フレーム:

| 案 | 大域 substep | 合計 |
|---|---|---|
| 再突入なし | 64 | 275 ms |
| 旧規則(200 km 以下 1 s) | 13,108 | **56,241 ms** |
| 刻み制限だけ(60〜200 km) | 656 | 2,815 ms |
| 刻み制限だけ(大気の底) | 3,735 | 16,025 ms |
| 陰的(精度限界 68 s) | 193 | 828 ms |
| **細分を大域から切り離す(採用)** | **64** | **347 ms** |

exp15 の表4で、高度 300 km から 5 km まで**どこでも大域 substep が 64 歩**であることを確認して
いる。細分する個体だけが 252〜2,718 歩を要求する。

### `doPreciseReentry` — 対象は個体の属性が決める

旧 `lossPrecisionMatters`(「大気の中で失われる時刻と条件の精度がプレイの結果を変えるか」)を
改名した。細分の対象を決めているのは「喪失の精度」ではなく「濃い大気の中を抗力が要求する刻みで
積むか」なので、名前を要求そのものへ寄せた。

**全個体へ広げてはいない。** `atmosphericMaxStep` は `nearestAtmosphereBody` + 層走査(最大 28
層)+ `exp` + `sqrt` を含み、1個体あたり約 0.3 µs。全個体(約 700 体)で 210 µs/substep、
655 substep/フレームで **137 ms/フレーム**になり、費用を下げる目的と正面から衝突する。

### 残った問題

**1. 破片・薬莢の軌道は、粗いままである。** 発散して残り続ける欠陥はガードで直ったが、
`doPreciseReentry = false` の個体は依然として大域サブステップの刻みで積まれる。焼失する高度は
刻みしだいで下振れする(高度 95 km 相当の密度で消えるはずが、刻み 204.8 s では 48.7 km で
検出される)。**これは意図した割り切りで**、`doPreciseReentry` が false であることは
「いつどれだけの精度で失われるかは結果を変えない」という宣言そのものである。

**2. 艦自身の歩数は減っていない。** 最高ワープの1フレームで最悪 2,718 歩を要求し、その分だけ
フレームが伸びる。`SPEC/ORBIT.md`「未確定の案」の「高いタイムワープ中に再突入する艦を『待たない』
こと」は**残る** — ただし他の物体を巻き込まなくなったので、問われているのは艦1体の歩数だけになった。

**3. 破綻の境界は6本の軌道でしか測っていない。** 近地点 −200 / 0 / 55 / 60 / 80 km、遠地点
413 km / 2,000 km / GTO。他の天体の大気(金星・火星・タイタン)では測っていない。

## 7-4. かかった手間(見積りと実際)

- **7-1**: SPEC 8 ファイルを見て 7 ファイルを直した(見積り 30〜40 行 → 実際 24 行の差分)。
  表に無かった1件(予測の刻みが再突入細分化に従う、という記述)を掃除中に見つけた。
- **exp13**(7-2): 327 行。母集団の組み立てが見積りより重かった — `collides = true` の
  個体を種別ごとに半径と質量つきで置き直す必要があり、そこだけで 60 行ある。
- **exp14**(7-3 の第1回): 190 行。熱と動圧の複製は 18 行で済んだが、**破綻の境界を挟むために
  刻みを 8 通りへ増やした**(見積りは 4 通り)。ここで「壊れているのは RK4 の側だ」まで分かった。
- **exp15**(7-3 の第2回): 210 行。表を4つ持つ。壊れた歩で RK4 の4段を再現する `stageProbe` が
  35 行、軌道の族6本の較正が 60 行。
- **捨てた案の実測**: 陰的 Euler と陰的中点則を Newton + 数値ヤコビアン + 6×6 ガウス消去で
  組んで測った(スクラッチ 110 行、commit していない)。**発散は消えるが精度の壁が 68 s に
  あり、費用も陽的 + 刻み制限より高い**と分かったので捨てた。組まずに理屈で捨てていたら、
  「陰的なら 204.8 s で積める」という誤った前提が残っていた。
- **是正の実装**: 刻み規則の差し替え(`atmosphericScaleHeight` 8 行 + `atmosphericMaxStep`
  25 行 + 定数2つ)と、細分をサブステップの内側へ閉じる `Simulator` の組み替え(`substep` の
  分岐と `stepPrecise` で +40 行、`adaptiveMaxStep` −13 行)。呼び出し側は
  `predicted-arc` 6 行・`game-entity` 系 4 ファイル。テストは `time-step.test.ts` を値の固定
  から不変条件へ全面差し替え(95 行)。

## 7-5. リスクと落とし穴 — 当てた結果

| リスク | 影響 | 当てた結果 |
|---|---|---|
| SPEC から性能の記述を消すとき、**帰結まで一緒に消す** | 「天体はすり抜けない」「艦が焼ける時期が早まらない」はプレイヤーが見る事実で、消してはいけない。ゲートの記述と同じ行・同じ節に同居している | **踏みかけた。** `GAME.md` `COMBAT.md` `CONTROLS.md` `FLIGHT.md` はどれもゲートと帰結が同じ文にあり、7-1 の突き合わせ表で1行ずつ確認して帰結だけを残した |
| 「未確定の案」へ移した項が、そのまま忘れられる | 高倍率ですり抜けることの是非が誰にも問われなくなる | **踏んでいない。** 直後の 7-2 がその項を読み直し、**残す**という結論を出した。項は残る |
| exp13 の母集団を `collides = false` の破片で組む | 候補ペアが 0 件になり、「外しても軽い」という**誤った結論**が出る。exp12 は実際にこの状態で 0 件を出している | **踏んでいない。** 母集団を組み直し、参加者数(294 / 694)と候補ペア数を毎行に出した。0 件の行は無い |
| exp14 で複製した熱の式が原本とずれる | 刻み感度の結論そのものが無意味になる | **踏んでいない。** 4式をファイル冒頭のコメントへ引用し、定数は `game/const` から import した。0.25 s と 1 s が一致することで、複製の側の収束も確かめている |
| 7-3 の本命案(熱だけ内側細分)を入れたとき、`qdyn` の点サンプルを直さない | 動圧のピークだけ見逃しが残る | **該当しなくなった。** 本命案そのものを実測で捨てた。exp14 の内側細分は `qdyn` の最大を取っており、それでも 34.13 s 固定と同じ答えしか出ない |
| 細分した個体を、外側の天体接触にも渡す | 反発が二度当たる。`resolveOne` は解決後に `e.state` を接触点へ書き戻すので、同じ区間を再判定すると再び接触が見つかる | **踏んでいない。** `substep` が1歩で進めた個体だけを `coarseEntitiesScratch` へ集め、外側はその顔ぶれにだけ環境と天体接触を解く |
| 内側の刻みで熱を回さない | 外殻温度が 761 K のところ 2,156 K になり、**生き延びるはずの艦が焼失と判定される** | **踏んでいない。** `stepPrecise` が内側の1歩ごとに `stepEnvironment` を呼ぶ。exp15 の較正表で基準との差が +0.6〜+1.7% に収まっている |
| 内側で ephemeris を組み直すのが安全だと思って組み直す | 内側1歩あたり 1,198 µs が乗り、3,671 歩で 4.4 s になって細分の意味が消える | **踏んでいない。** 2次外挿の相対誤差(≤1.1×10⁻⁹)と、名簿・分類・近傍がサブステップ内で変わらないことを先に測ってから引き継いだ |
| 定数を安定性の境界だけで決める | ratio=N=1 は発散しないが GTO 再突入の外殻温度が +7.6%。限界 1,300 K に対して生死を変える | **踏んでいない。** 較正表に基準(刻み 0.25 s)との比を必ず出し、精度で 0.5 を選んだ |
| ゲートを外したあと、×131072 で薬莢・破片が艦を押す | `replaceIfMoved` の書き戻しが弧を捨てる経路 | **該当しなくなった。** ゲートは外さない |
| SPEC から根拠を消しすぎて、次に触る人が同じ議論を再発明する | 「なぜ ×4 なのか」が誰にも分からなくなる | **踏んでいない。** 根拠は memos/ とこの文書に残した。**しかも実測で、SPEC が書いていた根拠は誤りだったと分かった** — 消して正解だった |

**新しく見つかった落とし穴**(この章の外へ持ち出すもの):

- **接触グリッドのセル一辺は参加者全体で1つ**なので、半径 180 m の敵機が1体いるだけで
  薬莢の群れの絞り込みが死ぬ(削減比 1.0×)。**×1 で既に起きている**(7-2)。
- **軌道の族6本(近地点 −200 / 0 / 55 / 60 / 80 km)で測り直した**(7-3、exp15)。他の天体の
  大気(金星・火星・タイタン)では測っていない。
- **刻みを縛る責任は呼び出し側3本に分散していて、`doPreciseReentry = false` の個体(破片・
  薬莢)はどこからも縛られない。** 発散しないことは `dragAccel` の頭打ちが保証するが、
  焼失する高度は刻みしだいで下振れする(7-3 の「決めたこと(0)」)。

---

# 第8章 未テスト — 確かめられていないこと

**この章は「やり残し」ではなく「当てられていない」の一覧。** どれも構造としては正しいと
判断したが、実行時にも回帰テストにも当たっていない。

## 8-1. 天体接触の解決そのものの回帰テストが置けない

`tests/physics/` は `tsconfig.test.json`(`lib: ["ES2022"]`、`module: CommonJS`、
`moduleResolution: node`)でコンパイルして node で走らせる。`SurfaceContactPhysics` は
`GameEntity` と `Stage` を**型として**参照するだけだが、tsc はその2つのファイルとその推移閉包を
プログラムへ引き込む — `render/` `hud/` `audio/` まで到達する。

- `lib` に `DOM` / `WebWorker` を足すと、今度は `three/tsl` が `moduleResolution: node` で解決
  できず `render/celestial-surface.ts` に本物の型エラーが出る(本体は `bundler` 解決)。
  テストのビルド時間も 8.3 s → 16.9 s へ倍増する。
- 型だけを構造的に受け取る形へ寄せても解けない。参加者の契約には接触の相手と `Stage` が
  現れるので、どちらを辿っても同じ推移閉包に戻る。
- 実行時は問題ない(型専用 import は JS から消えるし、`three` は `geometry.test.ts` が示す
  とおり node で読める)。**詰まっているのはコンパイルの側だけ。**

**届くには2択**: node で走る CommonJS のテストとは別に **bundler 解決でゲーム層をコンパイル
する実行形態**を用意するか、`collideWithEntity` / `collideWithCelestialBody` の契約から
`Stage` と `GameEntity` を外すか。第6章で口を割ったときに契約の形も見たが、`Stage`
(撃破の記録先)はどちらの口からも外せなかった。

いま置けているのは、推移閉包に触れない層だけ:
`tests/physics/contact.test.ts` の4件(法線の向きの取り決め — 記述を組む側と法線を決める側に
跨がるので片方だけを読んでも符号は確かめられない)と、
`tests/physics/surface-candidates.test.ts` の3件(絞り込みが答えを変えないこと)。

## 8-2. 実行時に駆動できていないもの

`?stage=1` も `?stage=debug-load` も、待ち時間を伸ばした自前の CDP セッションでは
**例外 0 件**で起動する。そのうえで駆動できていないのが次の3つ。

| 項目 | なぜ駆動できないか |
|---|---|
| 着陸基盤の確認(低速タッチダウン) | 天体表面への低速接触をキーボード入力だけで作れない。起動に 82 秒かかるので試行錯誤も現実的でない。**`memos/hedalu244/design_landing_simulation.md` が、少なくとも「着地したら高ワープで死ぬ」ことを机上で確定させた** |
| 喪失理由がワープ倍率に依らないこと(×1 と ×131072 の突き合わせ) | ×1 で喪失が起きるまで待てない(×131072 で 60 秒かけて破片が減り始める規模) |
| 第5章を入れたあとの、弧が表面で切れること | 上と同じ。表面すれすれの軌道を入力だけで作れない |

**共通の欠けているもの**: どれも「実行時に観測する前に、その状況をどう作るか」を用意しなければ
ならない種類で、`/verify` の手順(キー入力で駆動する)の射程の外にある。
当てるなら**その状況を作るステージか、状態を直接置ける口**が要る。
`debug-load` と同じ形の隠しステージ(月面すれすれに艦を置く / 天体の内側に破片を置く)を
1つ足すのが、いちばん安く済む。

## 8-3. `npm run smoke:browser` がこの環境で完走しない

**退行ではなく環境。** ヘッドレスのソフトウェア WebGPU では 60 フレーム完走に**約 82 秒**
かかるのに、このツールの待ち時間は 30 秒に固定されている。
着手前の `18a67e55` でも同じところで同じように落ちることを確認済み。
`npm run ci` はこれを含むので、この環境では `ci` を最後まで通せない。
**待ち時間を環境変数か引数で伸ばせるようにするのが最小の是正。**

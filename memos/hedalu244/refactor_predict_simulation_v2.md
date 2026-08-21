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
- 第5章〜第8章が**この文書の本体 — 4つの論点の計画**。各章は単体で読んで着手できるように
  書いてある。
- 第9章は**未テスト** — 実行時にも回帰テストにも当てられていないものの一覧。

## 着手順

依存があるので、この順に着手する。

| 順 | 章 | 何をするか | その位置に置く理由 |
|---|---|---|---|
| 1 | 第5章(論点1) | 表面到達の判定を1本にする | 最優先。第8章が変える押し戻しの帰結は、この判定を通って弧へ出る |
| 2 | 第8章(論点4) | 天体の内側の重力を有限にする | 第5章が作る「半径和で判定する弧」の上で挙動を確かめたい |
| 3 | 第6章(論点2) | 天体と個体で接触の口を分け、型を改名する | 第5章が `resolveOne` の中身を組み替えるので、後に置いて衝突を避ける |
| 4 | 第7章(論点3) | 2つの実測を通し、結果に応じて仕様と実装を直す | 実測の結論が出るまで SPEC の掃除ができない |

**第7章の SPEC 掃除(7-3)は、7-1 と 7-2 の実測が終わるまで着手しない** — 「性能のために
判定を抜く」「性能のために刻みを変える」記述を消してよいかどうかが、実測の結論そのものだから。

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
| **Simulator と Predictor が本質的に違う物理を積んでいる状態の解消** | **達成** | RK4(`stepDynamics`)・掃引の幾何(`sweptSphereContact`)・刻みの規則(`simulationMaxStep` / `reentryAwareMaxStep`)・間引きの式(`trajectorySampleInterval`)を両者が共有。残る差は窓の**探し方**と結末の出力先だけで、どちらも 1-2 の役割の違いに由来する |
| **Asteroid の廃止 / GameEntity は接触以外で影響を及ぼさない** | **達成** | `Asteroid` `asteroid` の一致 0 件。`GameEntity` に `mu` が無く、重力窓は `Ephemeris` からしか出ない |
| **Predict と Simulation で積分する重力場が食い違いうる状況の是正** | **達成(測定済み)** | `window-agreement.test.ts`。実測の最大差 5.87e-9 m/s²(許容量 1e-8 の 0.587 倍)。式は動かしていない |
| **大気の一般化(地球ハードコードの解消)** | **達成** | `atmosphere.ts` に `earth` / `EARTH` が 0 件。`AtmosphereDef` は基準楕円体・自転・層を自分で持つ |
| **剛体接触と大気を別物として区別** | **達成** | 焼失は `burnUpBody`(密度の点判定)、衝突は `sweptSphereContact`(掃引)。相手も(大気天体 / 全天体)、死因も、パラメータも別。焼失へ渡す窓は表面窓から大気窓へ分離済み |
| **着陸機能の基盤** | **達成(基盤のみ)** | `Contact` は `t` / `point` / `normal` / `selfState` / `otherState` を運ぶ。`impulse` を落としたので、材料は撃力へ潰す前の状態と法線だけになった。着陸そのものは未実装(意図どおり)。ただし**いま着地させると刻み幅に比例した接近速度が毎 substep 入る** — 第8章 8-2 |
| **掃引衝突判定の呼び出し口と実装の一元化** | **達成** | 掃引の幾何は `sphere-contact.ts` 1箇所。入口は `sweptSphereContact` 1つで解法の引数は無い |
| **Simulator と時間加速度の密結合の解消** | **達成** | `Simulator` は `SimSpeedManager` を知らず、`canResolveEntityContacts` を真偽値で受け取るだけ。倍率ゲートそのものの是非は**第7章 7-1** |
| **Simulator が内部で種別判断していたのを廃止** | **一部残** | 積分(`substep`)も姿勢(`stepAttitudes`)も `entities.all()` を種別で分けずに回す。残るのは `adaptiveMaxStep` が `players` / `enemies` を名指ししている1箇所だけ — **第7章 7-2** |
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
| 15 | 再突入細分化の2定数が1箇所 | **OK** — `reentryAwareMaxStep` の内側だけ。ただし**対象集合の決め方**は第7章 7-2 |
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
| 静止接触の安定化 | `SPEC/ORBIT.md`「未確定の案」に記載済み。**第8章 8-2 が具体的な帰結を実測したので、その数値を同節へ足す** |

---

# 第3章 呼び出し経路(`/callstack`)

**`9bc15122` 時点のコードから引いたスナップショットであり、正本ではない。** 食い違ったら
コードを信じる。

## 3-1. 実シミュレーション

```
Simulator.advance(dt, simDt, player, activeStage, canResolveEntityContacts, nanWatchdog)
                       …… Game.advanceSimulation から毎フレーム1回(ポーズ中・決着後は呼ばない)
├─〔substep ループ〕                       …… targetTime に届くまで。歩数そのものに上限は無い
│  ├─ Simulator.adaptiveMaxStep(simDt)
│  │  ├─ Ephemeris.atmosphereAttractorsAt(simTime)            (大気天体の窓 — 既定 1 体)
│  │  └─ time-step.ts  reentryAwareMaxStep(生存する艦・敵の状態列, 大気天体,
│  │        simulationMaxStep(simDt, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT))
│  │        ← 境界高度と細分化刻みの2定数は関数の内側。**対象集合だけが呼び出し側**(第7章 7-2)
│  ├─ Simulator.nextEventTime(activeStage)
│  │  ├─ Stage.nextSimulationEventTime
│  │  └─ Simulator.entityEventTime → GameEntity.nextSimulationEventTime
│  │        …… 顔ぶれの世代(collectionRevision)が変わったときだけ全走査
│  ├─ time-step.ts  simulationStepDuration(simTime, targetTime, maxStep, eventTime)
│  ├─ Ephemeris.gravityAttractorsAt(substep 中点)              (重力窓 — mu≠0 の 65 体)
│  ├─ Simulator.surfaceBodies() = Ephemeris.attractorsAt(**substep 開始時刻**)
│  │        ← 遮蔽体として渡す窓。遮蔽の幾何は区間内の天体の移動にほぼ左右されないので
│  │           中点で組み直さず、前 substep 終端の窓をそのまま使い回す
│  ├─ Ephemeris.atmosphereAttractorsAt(substep 中点)
│  ├─ Simulator.substep(subDt, 重力窓, 遮蔽体, 大気窓)
│  │  ├─ attractors.ts  classifyAttractors(重力窓)  ← substep に1回だけ組み、全個体で共有
│  │  └─〔全個体〕                                   …… 種別で分けない
│  │     ├─ attractors.ts  attractorsNearInto(e.state.r, classified, out)
│  │     ├─ GameEntity.followPredicted(t, near)  …… 弧が t を持てば積分せず先端を差し替える
│  │     └─ GameEntity.stepActual(dt, near, 遮蔽体, nearestAtmosphereBody(e.state.r, 大気窓))
│  │        └─ DynamicTrajectory.step → dynamics.ts  stepDynamics   ← RK4。**弧と共有**
│  ├─ Simulator.stepAttitudes(subDt) → attitude.ts  stepAttitude
│  │        …… entities.all() を1本回し alive && hasAttitude だけ通す。種別の名指しは無い
│  ├─ Simulator.surfaceBodies() = Ephemeris.attractorsAt(**substep 終端時刻**)
│  │        ← 表面接触と自機の環境が読む窓。登録天体の全数 101。**倍率で切り替えない**
│  ├─〔全 Player〕Player.stepEnvironment(subDt, ephemeris, simTime, surfaceBodies)
│  │        (熱・電力・放熱板。恒星の取り出し・日照率の遮蔽体・最寄りの大気天体に同じ窓)
│  │  └─ ThermalSystem.updateThermal(dtSub, r, v, 最寄りの大気天体, ship)
│  │        ← **外殻温度も動圧も、区間終端の1点をサンプルした一次積分**(第7章 7-2 の要点)
│  ├─ SurfaceContactPhysics.resolveSurfaceContacts(simTime, entities.all(), surfaceBodies, stage)
│  │        …… 倍率にも種別にも collides にも依らず毎 substep。物体どうしより先に解く
│  │  ├─ .collectParticipants  ← alive && attachedTo === null && isFiniteParticipant
│  │  ├─ .collectAttractors    ← 位置・速度・半径が有限
│  │  ├─ SurfaceCandidates.reset(参加者, 天体)  ← 1段目。substep に1回。天体数に比例し、
│  │  │  └─ attractor.ts  attractorStateAt(body, 区間の両端)   個体数には比例しない
│  │  └─〔参加者ごと〕SurfaceContactPhysics.resolveOne
│  │     ├─ SurfaceCandidates.into(e, out)      ← 2段目。実測で平均 1.00 体/substep
│  │     ├─ GameEntity.contactsWith(body, simTime)
│  │     │        ← **天体を拒む実装は1つも無い**(第6章 6-1)
│  │     ├─ surface-contact-physics.ts  computeResponse
│  │     │  └─ collision-response.ts  resolveFixedSphereCollision  ← 質量を引数に取らない
│  │     ├─ e.state = …  …… 位置も速度も動いていなければ書き戻さない(書き戻しは弧を捨てる)
│  │     └─ GameEntity.collideWith(body, contact, stage)  …… bounced のときだけ(第8章)
│  ├─〔canResolveEntityContacts のときだけ〕                     …… ×4 以下(第7章 7-1)
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
      │  └─ FutureAttractors.bodyAt → Ephemeris.attractorAt
      │        ← 成員 + 期限の来た候補だけを引く。**これが弧側の絞り込み**
      ├─ attractor.ts  strongestAttractor(tip.r, held.gravity) → elements.ts  keplerPeriod
      ├─ PredictedArc.stepDt(tip, span, period, held.collision)
      │  └─ time-step.ts  reentryAwareMaxStep([tip], held.collision, this.simulationMaxStep)
      │                                  …… consumable な弧だけ。**3-1 と同じ関数**
      ├─ predicted-arc.ts  trajectorySampleInterval(period, span)
      ├─ ArcBodies.resolve(tip.t + dt/2, tip, dt)     ← この歩の重力窓・衝突窓
      ├─ DynamicTrajectory.step → dynamics.ts  stepDynamics   ← RK4。**実シミュレーションと共有**
      │        (遮蔽体には mid.collision を渡す — 弧が幾何の相手として追っている窓)
      ├─ ApsisTrack.observe(tip, 新しい先端)
      └─ PredictedArc.checkSurfaceReach(tip, mid.collision)
         └─ attractor.ts  reachedBody(prev, next, mid.collision)
               ← **弧の唯一の打ち切り条件**(非有限値の検出を除く)。焼失は判定しない。
                  半径和は**天体の半径のみ** — ここが第5章の対象
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
5. **外殻温度と動圧は RK4 で積まれていない。** `updateThermal` は substep 終端の1点で
   密度と対気速度をサンプルし、`dtSub` を掛けて温度へ足す一次積分で、動圧に至っては
   積分ですらなく終端の点値。**再突入域の刻み細分化が支えているのはここ**(第7章 7-2)。

---

# 第4章 逆向きの依存(`/inv-callstack`)

**`9bc15122` 時点のスナップショット。** 走査範囲はいずれも `src/` `tests/` `tools/`。

## 4-1. 重力 RK4 積分

```
dynamics.ts  stepDynamics(state, dt, attractors, occluders, atmosphereBody, bcInv, srpCoeff, thrust)
      ← 全天体重力 + 2次重力場 + 大気抵抗 + 太陽輻射圧 + 推力の唯一の合成箇所
└─ dynamic-trajectory.ts  DynamicTrajectory.step(dt, attractors, occluders, atmosphereBody,
                              bcInv, srpCoeff, thrust, sampleInterval, keepDuration,
                              extrapolationCenter)
   │     ← 積分そのものは持たず、保持列(間引き・保持窓・prevState)を足すだけ
   ├─ game-entity.ts  GameEntity.stepActual(dt, attractors, occluders, atmosphereBody)
   │  └─ simulator.ts  Simulator.substep …… 毎 substep、全生存個体。**種別で分けない**
   │        (弧が同じ時刻を持っていれば followPredicted が先に効き、ここへ来ない)
   └─ predicted-arc.ts  PredictedArc.step()
      └─ predictor.ts  Predictor.grow …… 実体の弧も計画の弧も同じ1本を通る
            (実体は ensurePredictedArc 経由、計画は PlanPath が持つ弧を PlanEditor が渡す)

呼び出し元は src/ にこの2本だけ。tests/perf(common・exp3・exp5・exp12・
sphere-contact-sweeps)と tests/physics(dynamics・dynamic-trajectory・kepler-extrapolation・
n-body・window-agreement)は stepDynamics を直接叩くが、production の経路ではない。
```

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
│  └─ collision-response.ts  resolveFixedSphereCollision   (個体 × 天体。**質量を取らない**)
│     └─ surface-contact-physics.ts  computeResponse
│        └─ SurfaceContactPhysics.resolveOne
│              …… **倍率にも種別にも依らず毎 substep、全生存個体。**
│                 SurfaceCandidates を通った天体だけ(実測 平均 1.00 体/substep)
└─ attractor.ts  reachedBody(prev, next, bodies)
   │     ← 幾何を持たず、窓を回して最小 TOI の1体を選ぶだけ。半径和は**天体の半径のみ**
   │        (弧は大きさを持たない点として扱う — SPEC/ORBIT.md「天体表面への到達判定」)
   └─ predicted-arc.ts  PredictedArc.checkSurfaceReach …… 弧の1歩ごと。ArcBodies の成員だけ

reachedBody は tests/physics/attractor.test.ts(9件)・tests/physics/surface-candidates.test.ts
(絞り込みの答えを総当たりと突き合わせる正本)・tests/perf/exp12 からも直接呼ばれる。
```

図の外:

- **`checkLoss` 系からの呼び出しは 0 件。** `c5c46dd6` で表面到達が接触経路へ移った。
- **基地を当事者に含む個体どうしの接触は掃引を通らない。** `entityContactResponse` が
  `Base.testSphereCollision`(BVH / OBB)で幾何を出し、`distributeSphereContact` で分配
  だけ共有する。
- `linearSphereContact` / `curveSphereContact` の二次 / `sweptSagitta` … src/ からの
  呼び出しは 0 件。精度を落として費用を買うときの余地として残してある(モジュール冒頭の
  コメントが `SPEC/ORBIT.md`「未確定の案」を存在理由として参照する)。
  tests/perf/exp10・exp11 だけが直接叩く。

## 4-3. この2本から読める、第5章の対象

`sweptSphereContact` の下には**「窓を回して最初に触れる1体を選ぶ」ループが2つ**ぶら下がって
いる — `reachedBody` と `SurfaceContactPhysics.resolveOne`。問いは同じで、違うのは返すもの
(補間した到達状態 / 反発の結果)と半径和(天体の半径だけ / 個体 + 天体)だけ。第5章がこれを
1本にする。

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

**これは本章の変更が作った退行ではない** — 第8章 8-2 の実測では静止接触の収束先が
天体半径そのものよりも内側なので、半径和を使わない旧実装でも同じく打ち切られていた。
**静止接触の安定化(第8章 8-2 と `SPEC/ORBIT.md`「未確定の案」)と同じ根で、そちらでまとめて解く。**


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
| `collideWith(other: GameEntity \| Attractor, contact, stage): void` | `collideWith(other: GameEntity, contact, stage): void` と `collideWithBody(body: Attractor, contact, stage): void` の2つ |
| `collideAtRadiator(side, other: GameEntity \| Attractor, …)` | 同じく2つへ割る(2-4 の `Player.collideWith` 重複と同じ割り方になる) |
| `lossReason(other)` の `isAttractor` 分岐 | 2つの呼び出し側がそれぞれの文言を直接渡す |
| `contactDamageSpeed(other: ContactTarget, contact)` | 天体側は `closingSpeed(contact)`(`ATTRACTOR_DAMAGE_WEIGHT` は 1 なので重み自体が消える)、個体側は `closingSpeed(contact) * other.contactDamageWeight` |
| `contact-target.ts`(`ContactTarget` / `isAttractor`) | 削除 |

`Enemy` と `Player` は「ダメージを当てる → HP が残れば音とパフ → 尽きたら喪失を記録」という
尾を2つの口で共有することになるので、**その尾を private メソッドへ括り出す**(喪失の文言と
撃破の記録種別だけを引数に取る)。括り出したあとの `collideWith` / `collideWithBody` は
それぞれ4〜5行になる。

### 天体側で `contactsWith` を呼ばなくなることの意味

`SurfaceContactPhysics.resolveOne` から `e.contactsWith(body, simTime)` が消える。
**これは挙動を変えない**(上記2 のとおり恒真)。`SPEC/ORBIT.md`「天体との接触」は
「生存している物体はすべて参加し、物体どうしの接触判定を持つかどうかにも依らない」と
既に書いてあり、**個体の側が天体を拒める余地はそもそも仕様に無い**。仕様の変更は不要。

## 6-2. 目的(その2)— `Attractor` という名前をやめる

`Asteroid` が消えたことで、`Attractor` は**解析天体のある瞬間のスナップショット**と1対1に
対応するようになった。ところが:

- **名前が「重力源」を主張しているのに、`mu = 0` を容認している。** 既定レジストリ 101 体の
  うち **36 体が `mu = 0`** で、`attractorsAt` はそれを全部返す。表面接触・遮蔽・中心天体の
  解決・積分刻みの決定は、どれも重力とは無関係にこの窓を読む。
- **`CODING-RULE 2.2`「`body` / `ship` / `attractor`」が既にこう決めている** —
  「`body` は天体の意味に残す」「**重力源としての値は `attractor`**」。
  つまり現状の `Attractor` 型と `attractorsAt` は、リポジトリ自身の命名規則に違反している。

**改名する。ただし全部ではない** — 重力の文脈で `attractor` を名乗っているものは正しいので
残す。

| 改名する | しない(重力の文脈で正しい) |
|---|---|
| 型 `Attractor` → `CelestialBody` | `attractorAccel` |
| `AttractorId` → `BodyId`(`OrbitingId` はそのまま) | `strongestAttractor` |
| `Ephemeris.attractorsAt` → `bodiesAt` | `gravityAttractorsAt` |
| `Ephemeris.attractorAt` → `bodyAt` | `classifyAttractors` / `attractorsNearInto` / `ClassifiedAttractors` |
| `attractorStateAt` / `attractorPositionAt` → `bodyStateAt` / `bodyPositionAt` | `GRAVITY_ALWAYS_COUNT` / `GRAVITY_NEGLIGIBLE_ACCEL` |
| `frameOfAttractor` → `frameOfBody` | `FutureAttractorProvider` / `FutureAttractors`(弧が引く天体一式なので `FutureBodies` へ改名する方が一貫するが、判断は実施時) |
| `atmosphereAttractorsAt` → `atmosphereBodiesAt` | |
| creative の `ReferenceAttractor` → `ReferenceBody` | |

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

## 6-4. 変更が必要な箇所

**6-1(口を分ける)**

| ファイル | 何をするか |
|---|---|
| `src/game/game-entity/contact-target.ts` | 削除 |
| `src/game/game-entity/contact-damage.ts` | 天体用と個体用へ割る。`ATTRACTOR_DAMAGE_WEIGHT` は消える |
| `src/game/game-entity/game-entity.ts` | `contactsWith` の引数を `GameEntity` へ。`collideWith` を割り、既定の `collideWithBody` が `alive = false` |
| `src/game/game-entity/bullet.ts` | `contactsWith` の `other instanceof GameEntity` 分岐が要らなくなる。`collideWithBody` も `alive = false` |
| `src/game/game-entity/debris-piece.ts` / `enemy.ts` | `collideWith` / `collideWithBody` へ。`Enemy` は撃破記録の種別が口ごとに固定される(`isAttractor` の分岐が消える) |
| `src/game/player/player.ts` | `collideWith` / `collideWithBody` / `collideAtRadiator` / `collideAtRadiatorWithBody` の4つ。共通の尾を private へ。`lossReason` 関数は消え、文言が口ごとの直書きになる |
| `src/game/player/radiator.ts` / `belt-physics.ts` | `contactsWith` の引数型。`RadiatorFold` は `collideWithBody` も owner へ委ねる |
| `src/game/simulation/surface-contact-physics.ts` | `contactsWith` の呼び出しを削除、`collideWith` → `collideWithBody` |
| `src/game/simulation/entity-contact-physics.ts` | 変更なし(型が狭まるだけ) |

**6-2(改名)**: `Attractor` の綴りは `src/` `tests/` `tools/` に **797 箇所 / 119 ファイル**。
上の表の対応で機械的に置換し、`typecheck` で取りこぼしを拾う。

## 6-5. 達成目標

1. `ContactTarget` と `isAttractor` の綴りが `src/` に **0 件**。
2. `GameEntity | Attractor` / `Attractor | GameEntity` の綴りが **0 件**。
3. 天体との接触経路に `instanceof` も `'mu' in` も現れない。
4. 型 `Attractor` の綴りが 0 件で、`CelestialBody` になっている。`attractor` を名乗って
   残るのは重力の計算(`attractorAccel` / `strongestAttractor` / `gravityAttractorsAt` /
   `classifyAttractors` / `attractorsNearInto`)だけである。
5. `DEVELOP/CODING-RULE.md` 2.2 の「`body` / `ship` / `attractor`」節が、改名後の実態と
   一致している(規則の側は既に正しいので、変えるのは**コードだけ**。規則を弱めない)。
6. `npm run typecheck` と `npm run test:physics` が通る。
7. セーブの読み込みが壊れていない(既存スロットのロード)。

## 6-6. 手順

| # | ステップ | 完了条件 |
|---|---|---|
| 1 | `contactDamageSpeed` を天体用と個体用へ割る | `test:physics` 通過 |
| 2 | `GameEntity` / `Bullet` / `DebrisPiece` / `Enemy` の `collideWith` を割る | 同上 |
| 3 | `Player` の尾を private へ括り出し、`collideWith` / `collideAtRadiator` を各2つへ割る | 同上 |
| 4 | `SurfaceContactPhysics.resolveOne` を `collideWithBody` へ繋ぎ替え、`contactsWith` の呼び出しを削除 | 同上。天体接触の挙動が変わっていない(exp12 の到達件数) |
| 5 | `contactsWith` の引数型を `GameEntity` へ狭め、`contact-target.ts` を削除 | 綴りが 0 件 |
| 6 | 型と関数の改名(6-2 の表)を機械的に適用 | `typecheck` 通過。`git diff --stat` が識別子だけの差分 |
| 7 | セーブスロットのロードを1回通す | 例外なくロードできる |

**ステップ 1〜5 と 6 は別 commit にする** — 6 は 119 ファイルに触るので、混ぜると
1〜5 のレビューができなくなる。

## 6-7. 見積り

- **6-1**: 9 ファイル、実質の書き換えは 100 行程度。`Player` の尾の括り出しが
  11 行 × 4 → 11 行 + 4〜5 行 × 4 で、正味 20 行ほど減る。
- **6-2**: 797 箇所の機械的置換。`sed` で通し、`typecheck` を1回通せば終わる。
  **`npm run export-assets` を走らせないこと** — アセットの識別子が振り直されて
  差分が膨らむ。
- **費用への影響**: 0。`isAttractor`(`'mu' in`)の呼び出しは接触1件あたり1回で、
  接触自体が稀なので消しても測れる差にならない。改名は実行時に影響しない。

## 6-8. リスクと落とし穴

| リスク | 影響 | それが露見する場所 |
|---|---|---|
| 天体側の `contactsWith` を消したことで、将来「この個体は天体をすり抜ける」を書けなくなる | 仕様上そういう個体は無い(`SPEC/ORBIT.md`「生存している物体はすべて参加し」)が、**必要になったら口を戻すことになる** | 仕様が変わったとき。いま余地として残すと、恒真の問い合わせが毎 substep 走り続ける |
| `Player` の尾を括り出すときに、放熱板側だけにある破壊エフェクトを落とす | 放熱板が壊れても演出が出ない。**静かに消える** | 括り出す尾に破壊エフェクトを含めず、`collideAtRadiator` 側に残す。2-4 の重複が「11 行 × 2」であることの内訳がこれ |
| `Enemy` の撃破記録の種別(`'collision'` / `'killed'`)を口ごとに固定するとき、逆に付ける | ステージのスコアと撃破ログが入れ替わる。**型では捕まらない** | 天体 → `'collision'`、個体 → `'killed'`。`isAttractor(other) ? 'collision' : 'killed'` の対応をそのまま移す |
| 改名で `attractor` を名乗るべきものまで `body` にする | 重力の文脈が `body` に薄まり、`CODING-RULE 2.2` を今度は逆向きに破る | 6-2 の右列(改名しないもの)を、置換の前に grep で確定させてから走らせる |
| `AttractorId` → `BodyId` がセーブの型注釈に触れる | 型名だけが変わり形式は同じなので実害は無いが、`SAVE_VERSION` を上げたくなる誘惑が出る | **上げない。** 直列化されるキーも値も変わらない |

---

# 第7章 論点3 — 精度と性能のために入った密結合

**この章の2件は「直す」ではなく「測って決める」。** どちらも「性能と精度のために物理の
規則を曲げている」疑いがあり、曲げるに足る根拠が実測で残っていない。

## 7-1. 物体どうしの接触を ×4 超で解かないこと(`canResolvePhysicalCollisions`)

### 何が問題か

`SimSpeedManager.canResolvePhysicalCollisions`(`simSpeed <= MAX_PHYS_SIM_SPEED` = ×4)が、
`EntityContactPhysics.resolveEntityContacts` と `resolveBelt` の両方を止めている。
`SPEC/ORBIT.md` と `SPEC/GAME.md` が根拠をこう書いている:

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

### 測ること

`tests/perf/` に新しい実験を1本置く(仮に exp13)。exp12 と同じ debug-load 相当の
1フレームを組み、**倍率を ×1 から ×131072 まで振って**次を出す。

| 出す値 | なぜ要るか |
|---|---|
| `contactCellSize` が返すセル一辺 [m] | 絞り込みが倍率で壊れるかどうかが、ここに全部出る |
| 27 近傍から集まる候補ペア数 | 総当たり `n(n−1)/2` に対する削減比 |
| 候補ペアを `resolveSphereCollision` に通した所要 [ms/フレーム] | ゲートを外したときに増える費用そのもの |
| 同じ倍率の substep 幅における、三次曲線と真値の乖離(exp11 と同じ R\* の測り方) | 「判定に意味がなくなる」が本当かどうか |

**exp12 をそのまま拡張してはいけない落とし穴が1つある。** debug-load の破片は
`kind: 'fragment'` で `collides = false`・質量 0 なので、**個体どうしの接触の参加者にならない**
(exp12 の測定でも候補ペアは 0 件で、501 体を載せた場合の仮定値が出ているだけ)。
実際の参加者は艦・敵機・弾・薬莢・展開した放熱板・ベルトの節なので、**測る母集団は
`collides = true` の個体で組み直す**必要がある。ばらけ方の異なる2つ(同一軌道に密集 /
高度と傾斜角がばらけた集団)を両方測る。

### 決め方

- **セル一辺が倍率でほとんど伸びず、費用がフレーム時間の数 % に収まり、かつ乖離が
  `unite_sphere_contact.md` 4章の許容内**なら、**ゲートを外す。**
  `MAX_PHYS_SIM_SPEED` は自機の操作の可否だけを支配するようになる。
- **どれか1つでも外れるなら、ゲートは残す。** ただし SPEC に書く根拠を実測の文言へ
  差し替える(7-3)。

## 7-2. 再突入域の刻み細分化(`reentryAwareMaxStep`)

### コードから分かったこと(測る前に、前提が1つ崩れている)

**「RK4 は刻み幅に関わらず高精度だから細分化は要らないのでは」という見立ては、
細分化が支えている量には当てはまらない。**

`ThermalSystem.updateThermal` は substep 終端の1点で大気密度 ρ と対気速さ s をサンプルし、

- 動圧 `qdyn = 0.5 ρ s²` を**その点値のまま**保持し、
- よどみ点熱流束 `q̇ = k √(ρ/Rn) s³` に `dtSub` を掛けて外殻温度へ足す

という**一次(矩形)積分**を行っている。`checkThermalLimits` はこの `qdyn`(点値)と
`hullTemp`(一次積分)をしきい値と比べて艦の生死を決める。RK4 で積まれているのは
位置と速度だけで、**生死を決める量は一次精度である。**

したがって細分化の是非は「RK4 の刻み感度」ではなく、**「一次積分と点サンプルで生死を
決めてよい幅はどこまでか」**の問題になる。刻みが 200 s なら近地点通過そのものを1歩で
跨ぎ、動圧のピークを**サンプルしないまま**通過しうる。

### それでも疑わしいこと(実在する)

1. **循環依存。** 刻みが物体の位置を決めるはずなのに、物体の位置(高度)が刻みを決めている。
2. **費用が暴発する。** `reentryAwareMaxStep` の返り値は `simulationMaxStep`(=
   `SUBSTEP_MAX_COUNT` の効き)を**上書きする**ので、艦が高度 200 km を割った瞬間、
   ×131072 の1フレームは `simDt / REENTRY_SUBSTEP_MAX_DT` = **13,107 substep** を要求する。
   しかも刻みは**全個体で共有**なので、破片 500 体も同じ刻みで積まれる。
   実測の軌道積分は 0.239 µs/歩(C-3 の観測、187.9 ms ÷ 785,495 歩)なので、
   **0.239 µs × 501 体 × 13,107 歩 = 1,570 ms/フレーム**。
   `SPEC/ORBIT.md`「未確定の案」に「高いタイムワープ中に再突入する艦を『待たない』こと」
   として既に記録がある問題の、数値としての姿がこれである。
3. **対象集合が `players` / `enemies` の名指しで `Simulator` の中にある**(A-8 の元の指摘)。
   「この個体の喪失の精度がプレイに効くか」は個体側の属性であって、`Simulator` が
   コレクションを名指しして決めることではない。

### 測ること

`tests/perf/` に新しい実験を1本置く(仮に exp14)。再突入する艦の軌道を、
細分化あり(1 s)と細分化なし(20 s / 34.1 s / 204.8 s)で積み、次を並べる。

| 出す値 | 判定 |
|---|---|
| `hullTemp` の履歴と最大値 | 一次積分の刻み感度そのもの |
| `qdyn` の最大値(サンプルされた点値の最大) | 粗い刻みがピークを跨いで見逃すか |
| `MAX_HULL_TEMP` / `MAX_DYN_PRESSURE` を超えた時刻 | **生死と、その時刻が刻みで変わるか** |
| 近地点高度・軌道の形 | 位置・速度側(RK4)の刻み感度 |

`ThermalSystem` は `Hud` を import するので `tests/perf` の tsconfig ではコンパイルできない。
**熱と動圧の積分式は実験側へ複製する**(exp12 が `contactCellSize` を複製しているのと同じ
理由・同じやり方)。複製した式が原本と一致していることを、複製元の行を引いて明記する。

### 決め方

3つに分かれる。**「細分化を廃止する / しない」の二択ではない。**

- **一次積分の刻み感度が小さいなら**、細分化を廃止できる。
- **大きいなら(その公算が高い)**、細分化そのものは要る。ただし**手段が刻みである必要は無い** —
  熱と動圧の積分だけを substep の内側で細分する(位置と速度は粗い刻みのまま進める)なら、
  **費用は艦1体ぶんにしか掛からず、破片 500 体を巻き込まない。** 上の 1,570 ms が、
  熱の1歩を軌道積分の1歩と同じ 0.239 µs と見積もった**上限**でも
  0.239 µs × 1 体 × 13,107 歩 = **3.1 ms** に落ちる(熱の1歩は RK4 の1歩より
  はるかに安いので、実際はこれより小さい)。循環依存も、全個体共有の刻みも消える。
  **これが本命の是正案。**
- どちらの場合も、**対象集合の名指しは `GameEntity` 側の属性へ移す** — 細分化が残るなら
  「この個体の喪失の精度がプレイに効くか」、熱の内側細分になるなら「熱シミュレーションを
  持つか」。どちらも `Simulator` から種別の名指しが消える。

## 7-3. SPEC から精度と性能を追い出す(**7-1 と 7-2 のあと**)

### 目的

`SPEC/README.md`「書き方の規則」は既にこう書いている:

> **達成した精度・刻み幅を書かない。** 書くのは「どういう状況で、何が正しく見えていなければ
> ならないか」だけである。

**この規則が守られていない。** そして規則の言い方が狭すぎる — 「達成した」精度だけでなく、
**手段としての精度と性能の判断そのものを仕様に書いてはいけない。** 軽量化のために判定を抜く、
アドホックに刻みを変える、といった判断は実装側の問題で、仕様が言うべきなのは
「表示とゲームプレイの側から見て何が正しく見えていなければならないか」だけである。

### やること

1. `SPEC/README.md` の当該箇所を**「精度と性能は仕様化しない」**へ広げる。書いてよいのは
   観測できる帰結だけで、それを満たす刻み・許容量・アルゴリズム・どの判定を省くかは
   実装の裁量である、と明記する。
2. その規則で `SPEC/` 全体を掃く。**現時点で当たっている箇所**:

| ファイル | 箇所 | どうするか |
|---|---|---|
| `ORBIT.md`「時間刻みとタイムワープ」 | 「サブステップの幅にも本数にも上限がある…計算コストが時間加速倍率に際限なく比例することはない」 | 削除。観測できる帰結(「倍率をどれだけ上げてもフレームが止まらない」)だけを残す |
| `ORBIT.md` 同節 | 「各サブステップの重力環境は中間時刻において一度だけ評価し…」 | 削除。ただし**同じ区間内で相互作用するものは必ず同じ瞬間の位置関係で計算される**という不変条件は残す(これは精度ではなく整合性) |
| `ORBIT.md` 同節 | 再突入域の細分化の3項(境界高度 200 km、対象を艦に限る理由、細分化が上限に優先すること) | **7-2 の結論で決まる。** 手段が刻みでなくなるなら全部削除し、「再突入する艦が失われるかどうかは時間加速倍率によらず同じでなければならない」だけを残す |
| `ORBIT.md` / `GAME.md` / `FLIGHT.md` / `CONTROLS.md` | 「物体どうしの剛体接触は倍率が一定以上で解かれない」とその根拠(4箇所) | **7-1 の結論で決まる。** ゲートを外すなら全部削除。残すなら、根拠(「判定に意味がなくなる」)を落として**観測できる帰結だけ**にする(高倍率では物体どうしがすり抜ける、というのはプレイヤーが見る事実なので仕様に要る) |
| `CELESTIAL.md` 2.2「高精度暦データ」 | 「単一のデータでは長期にわたる精度を保てないため」 | **残す。** どの時代でどの天体が正しく見えるかはゲームの内容そのもので、実装の裁量ではない |
| `MAP.md` 「表示期間を長くするほど位置精度は落ち…」 | | **残す。** プレイヤーが画面で見る帰結を述べている |

3. `SPEC/ORBIT.md`「未確定の案」から、7-1 / 7-2 の結論で不要になった項を消す
   (「高いタイムワープ中に再突入する艦を『待たない』こと」は、7-2 で手段が変われば消える)。

### 達成目標

1. `SPEC/README.md` の規則が「精度と性能は仕様化しない」の形になっている。
2. 上の表の各行が処理済みで、`SPEC/` に**手段としての刻み幅・省略・計算量の記述が残っていない**。
3. 削除した記述が語っていた**観測できる帰結**が、どこかに残っている
   (削除ではなく置き換えになっている行を、1行ずつ突き合わせる)。

## 7-4. 見積り

- **exp13**: exp12 の骨格(暦・積分・タイムライン生成)を流用できるので、新規は
  母集団の組み立てと narrow phase の計測で 150 行ほど。実行は exp12 と同じ桁(数分)。
- **exp14**: 熱と動圧の式の複製が 30 行、掃引が 4 通り × 数分。
- **7-3**: SPEC 6 ファイル、20〜30 行の書き換え。
- **是正の実装**(7-2 の本命案を採る場合): 熱・動圧の内側細分は `stepEnvironment` の中に
  閉じるので `Player` / `ThermalSystem` の 2 ファイル、40 行程度。
  `Simulator.adaptiveMaxStep` は丸ごと消える。

## 7-5. リスクと落とし穴

| リスク | 影響 | それが露見する場所 |
|---|---|---|
| exp13 の母集団を `collides = false` の破片で組む | 候補ペアが 0 件になり、「外しても軽い」という**誤った結論**が出る。exp12 は実際にこの状態で 0 件を出している | 実験の出力に参加者数を必ず併記する。0 件なら測定失敗として扱う |
| exp14 で複製した熱の式が原本とずれる | 刻み感度の結論そのものが無意味になる | 複製元の行番号ではなく**式**を引用してコメントに残し、`SG_CONST` などの定数は `game/const` から import する |
| 7-2 の本命案(熱だけ内側細分)を入れたとき、`qdyn` の点サンプルを直さない | 動圧のピークだけ見逃しが残り、`MAX_DYN_PRESSURE` の判定が刻み依存のままになる。**温度だけ直って安心する** | 内側細分のループで `qdyn` の**最大値**を取ること。終端の点値を残さない |
| ゲートを外したあと、×131072 で薬莢・破片が艦を押す | 質量 0 なので押されないはずだが、`replaceIfMoved` の書き戻しが弧を捨てる経路は残る | v3 の達成目標 14 と同じ確認。破片の中を高倍率で通過して、艦の予測線が消えないこと |
| SPEC から根拠を消しすぎて、次に触る人が同じ議論を再発明する | 「なぜ ×4 なのか」が誰にも分からなくなる | **根拠は memos/ とこの文書に残す。** SPEC に書くのは帰結だけ、という分担そのものが 7-3 の目的である |

---

# 第8章 論点4 — 天体の内側に湧いた個体

## 8-1. 実測した現状 — 押し戻しは効いている。壊れているのは押し戻す前である

**「相対速度ゼロで天体の内側に湧いた個体を、表面まで押し戻せばよい」は正しい。
それが素直にできない理由は、押し戻しが走る前に重力積分が終わっているからである。**

`Simulator` の substep は「軌道積分 → 姿勢 → 環境 → 天体接触」の順で走る。ところが
`attractorAccel` は距離 d に対して μ/d² を返し、**天体の表面より内側でも点質量のまま**である
(`d² < 1 m²` のときだけ寄与ゼロにする発散よけがあるだけ)。`degree2Accel` はさらに悪く、
1/d⁵ で発散する(`r² < 1 m²` のガードのみ)。

月(半径 1,737.4 km、μ = 4.9028×10¹² m³/s²)の**中心から 100 km** に静止した個体を、
実際の `stepDynamics` と `resolveFixedSphereCollision` で substep を回して測った:

| substep | 積分後 \|r\| | 積分後 \|v\| | 解決後 \|r\| | bounced |
|---|---|---|---|---|
| 1 | 91.2 km | **4,341,928 m/s** | 1,408 km | false(離反中) |
| 2 | 88,247 km | 4,341,920 m/s | — | 接触なし |
| 3〜 | 175,085 km … | 4,341,920 m/s | — | 接触なし |

**1歩(20 s)の積分で光速の 1.4 % を得て、月系から射出される。** 押し戻しは1回だけ効くが、
その時点で速度は外向きなので離反扱いになり、以後は二度と接触しない。
**表面まで押し戻す機構は正しく動いていて、押し戻す前の積分が壊れている。**

**表面直下 10 km**(発散が効かない領域)では、押し戻しは期待どおりに効く — 6〜9 substep で
表面へ収束する。ただし収束先は静止接触のリミットサイクルで、8-2 の問題へ繋がる。

**中心ちょうど**は押し戻せない。`sphereContactGeometry` の重なりフォールバックは
`distSq > 0` を要求し(法線が定まらないため)、`null` を返してその個体は中心に留まる。
実際に到達しうる経路は無い(creative の配置検証は近点高度 ≥ 0 を要求する)ので、
**塞ぐのではなく「法線が定まらないので押し戻せない」ことをコメントで明示する**にとどめる。

## 8-2. 静止接触の帰結(実測)— 着地は高ワープで死ぬ

表面へ収束したあとは、重力で沈む → 押し戻す、のリミットサイクルに落ちる。
接近速度は**刻み幅に比例する**:

| 天体 / 刻み | 毎 substep の接近速度 |
|---|---|
| 月 / 20 s(`SUBSTEP_MAX_DT`) | 23.2 m/s |
| 月 / 204.8 s(×131072 相当) | 238 m/s |

`COLLISION_DAMAGE_MIN_CLOSING_SPEED` は 50 m/s なので、**月面に着地した艦は ×1〜×4 では
無傷だが、ワープを上げると毎 substep 238 m/s の接触ダメージを受けて死ぬ。**
これは `SPEC/ORBIT.md`「未確定の案」の「静止接触の安定化」そのもので、**着陸を実装するときに
必ず解かねばならない。** この数値を同節へ足す。

**「めり込んだまま静止している個体」と「着地している個体」は、いまの材料では区別できない**
(どちらも `startsInside`)。だから「沈んでいる個体を接触として扱う」ことは静止接触の
安定化と切り離せない。**本章はそこへは踏み込まない。**

**もう1つ、同じ根から出る帰結がある(第5章の実施中に実測)。** 押し戻しは重なりフォールバックを
通り、めり込みの 80 %(`OVERLAP_RELAXATION`)しか解消しないので、置かれる先は常に接触距離の
**内側**になる(月・半径 2.6 m の個体で 22.5 m 内側)。表面判定は内側を「触れている」と答えるので、
**着地した個体の予測弧は毎歩打ち切られ、予測線が点になる。** 接触距離ちょうどに置かれるなら
弧は伸びる(重なり判定は厳密不等号なので拾わない)ことは確認済みなので、**押し戻しを
接触距離ちょうどまで解消するようにすれば、この帰結だけは消える。** 静止接触の安定化を設計する
ときの選択肢の1つとして持っておく。

## 8-3. 目的

**天体の表面より内側で、重力を有限にする。** これは物理的な正しさの問題であって、
ゲームバランスでも性能でもない。一様球の内部場は

- a = −μ·r/R³ (r < R) — 中心でゼロ、表面で μ/R² に**連続に繋がる**

であり、外側の点質量と1本の分岐で書ける。2次の重力場(J2・C22)は天体の**外側でしか
定義されない**球面調和展開なので、基準半径の内側では加えない。

これを入れると、内側に湧いた個体は暴れずに押し戻しへ乗る。実測(同じ 100 km の配置、
内部場を入れたもの):

| substep | 積分後 \|v\| | 解決後 \|r\| |
|---|---|---|
| 1 | 1.87 m/s | 1,410 km |
| 2 | 25.6 m/s | 1,672 km |
| 3 | 21.0 m/s | 1,724 km |
| … | … | … |
| 7 | 23.2 m/s | 1,737.35 km(表面) |

**7 substep で表面に載り、その間の最大接近速度は 25.6 m/s** — 接触ダメージのしきい値
50 m/s を下回るので、**個体は壊れずに表面へ出る。** これが「適切なかたち」である。

## 8-4. 先に SPEC を更新する

`DEVELOP/SPEC/ORBIT.md`「多体重力」へ2項を足す。

- 天体の表面より内側では、重力は中心からの距離に**比例して弱まり、中心でゼロになる**
  (一様な密度の球の内部場)。表面ではその外側の値と連続に繋がる。点として扱う限り
  外側でしか成り立たない逆二乗を内側まで延ばすと、中心の近くで発散し、
  そこに置かれたものが物理的にありえない速度で射出される。
- 天体の扁平さ・非対称さによる2次の重力場は、天体の外側でのみ定義される。
  基準半径より内側では加えない。

**これが着手の最初のステップ**で、これ単体で1 commit にする。

## 8-5. 変更が必要な箇所

| ファイル | 何をするか |
|---|---|
| `DEVELOP/SPEC/ORBIT.md` | 8-4 の2項を「多体重力」「2次の重力場」へ追記 |
| `src/physics/attractor.ts` | `attractorAccel` の直達項を「d ≥ radius なら μ/d³·d、内側なら μ/R³·d」へ。既存の `d² ≥ 1` という**単位を持った魔法の閾値が消える**(発散よけが物理の式に置き換わる)。ECI 原点補正項も同じ規則にする |
| `src/physics/dynamics.ts` | `degree2Accel` のガードを `r² < 1` から `r² < refRadius²` へ |
| `src/physics/collision-response.ts` | 重なりフォールバックの `distSq > 0` に、「中心が一致すると法線が定まらないので押し戻さない」とコメントを足す |
| `DEVELOP/SPEC/ORBIT.md`「未確定の案」 | 静止接触の項へ 8-2 の数値(刻み幅に比例した接近速度、月 20 s で 23 m/s / 204.8 s で 238 m/s)を1行足す |
| `tests/physics/dynamics.test.ts` | 内部場の回帰テスト。表面での連続性(内外から近づけた値が一致)、中心でゼロ、内側で 2 次項が 0 |
| `tests/physics/attractor.test.ts` | 内側に静止した個体が発散しないこと(1歩の速度が有限で小さい) |

## 8-6. 達成目標

1. `attractorAccel` と `degree2Accel` に、**単位を持った魔法の閾値(`1`)が残っていない**。
2. 月の中心から 100 km に静止した個体が、20 s の刻み7歩以内に表面へ載り、
   その間の最大接近速度が `COLLISION_DAMAGE_MIN_CLOSING_SPEED`(50 m/s)を下回る。
   **これを回帰テストで固定する。**
3. 表面の内側と外側から極限を取った加速度が、表面で一致する(相対誤差 1e-12 以内)。
4. 天体の外側での加速度が**まったく変わっていない** — `window-agreement.test.ts` の
   最大差 5.87e-9 m/s² が動かない。
5. `npm run typecheck` と `npm run test:physics` が通る。
6. `SPEC/ORBIT.md`「未確定の案」の静止接触の項に、8-2 の実測値が入っている。

## 8-7. 手順

| # | ステップ | 完了条件 |
|---|---|---|
| 1 | `SPEC/ORBIT.md` へ 8-4 の2項を追記 | 本文に内部場の規則がある |
| 2 | `degree2Accel` のガードを `refRadius` へ | `test:physics` 通過。外側の値が不変 |
| 3 | `attractorAccel` に内部場の枝を入れる | 同上。8-6 の 3・4 が満たされる |
| 4 | 8-6 の 2 のテストを足す | 内部場を外すと落ちる |
| 5 | `collision-response.ts` のコメント、`SPEC` 未確定の案への追記 | — |

## 8-8. 見積り

- **実装**: `attractorAccel` の分岐が 4 行、`degree2Accel` が 1 行、コメントが 3 行。
- **費用**: `attractorAccel` は**最も熱い経路**(全個体 × 全重力源 × RK4 の 4 段)にある。
  いまの `d2 >= 1` が `d2 >= radius * radius` になるので、**天体1体・1段あたり乗算が1つ増える**。
  同じ関数が既に平方根と除算を2組ずつ持っているので相対的には小さいはずだが、
  **これは見積りであって実測ではない** — 変更前後で `tests/perf/exp3-gravity-cost.ts` を
  走らせ、`stepDynamics` の1歩あたり時間が動かないことを確かめる。動くようなら
  `radius * radius` を `Attractor` のフィールドとして持たせる(`Ephemeris.attractorAt` が
  組むときに1回だけ掛ける)。
- **答えの変化**: 天体の外側では**ビット単位で同じ**(分岐の条件が `d² ≥ 1` から
  `d² ≥ R²` へ変わるだけで、外側では同じ枝を通り同じ式を評価する)。

## 8-9. リスクと落とし穴

| リスク | 影響 | それが露見する場所 |
|---|---|---|
| `strongestAttractor` が内部場で答えを変える | 天体の内側にいる個体の「中心天体」が変わり、軌道要素の表示・弧の刻み幅・外挿の中心が変わる。**天体の外にいる限り一切変わらない**ので気付きにくい | 内側にいる個体の弧の挙動。内部場では中心へ近づくほど弱くなるので、深くにいる個体は別の天体を中心と答えうる |
| ECI 原点補正項に内部場を入れ忘れる | 地球以外の天体が地球の中心を含む…という配置は既定レジストリに無いので実害は出ないが、規則が半分だけ適用された状態が残る | 両方の項に同じ規則を入れること。片方だけ直すと、次に読む人が意図を読めない |
| `degree2Accel` のガードを `refRadius` にすると、月の基準半径 1,738.0 km と表面半径 1,737.4 km の 0.6 km の隙間で 2 次項が急に消える | 表面ちょうどを飛ぶ個体の加速度に、0.6 km の幅で不連続が出る。大きさは J2 項そのもの(月で ~10⁻⁴ m/s² 相当) | 表面すれすれの軌道。**基準半径と表面半径は別の量である**(SPEC/ORBIT.md が明記)ことを踏まえ、切り替えは基準半径で行う — 展開が定義されないのは基準半径の内側だから |
| 内部場を入れたことで「天体の中を通り抜ける軌道」が計算できてしまい、それが正しい挙動に見える | 実際には表面接触が毎 substep 押し戻すので通り抜けられないが、**弧(予測)は接触の押し戻しを持たない**ので、線だけが天体の中を通る | 第5章で弧が半径和で打ち切られるようになるので、弧は表面で切れる。**第5章を先に入れる理由がこれ** |
| 8-2 のリミットサイクルを「直った」と誤認する | 内部場は湧いた瞬間の射出を止めるだけで、静止接触は直さない。高ワープの着地は依然として死ぬ | 8-6 の 2 は「表面へ載るまで」を測る。載ったあとの挙動は測らない — そこは着陸の作業の範囲 |

---

# 第9章 未テスト — 確かめられていないこと

**この章は「やり残し」ではなく「当てられていない」の一覧。** どれも構造としては正しいと
判断したが、実行時にも回帰テストにも当たっていない。

## 9-1. 天体接触の解決そのものの回帰テストが置けない

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
する実行形態**を用意するか、`collideWith` の契約から `Stage` と `GameEntity` を外すか。
**第6章が `collideWith` を割るので、そのとき契約の形をもう一度見ること** — ただし `Stage`
(撃破の記録先)は外せる見込みが薄い。

いま置けているのは、推移閉包に触れない層だけ:
`tests/physics/contact.test.ts` の4件(法線の向きの取り決め — 記述を組む側と法線を決める側に
跨がるので片方だけを読んでも符号は確かめられない)と、
`tests/physics/surface-candidates.test.ts` の3件(絞り込みが答えを変えないこと)。

## 9-2. 実行時に駆動できていないもの

`?stage=1` も `?stage=debug-load` も、待ち時間を伸ばした自前の CDP セッションでは
**例外 0 件**で起動する。そのうえで駆動できていないのが次の3つ。

| 項目 | なぜ駆動できないか |
|---|---|
| 着陸基盤の確認(低速タッチダウン) | 天体表面への低速接触をキーボード入力だけで作れない。起動に 82 秒かかるので試行錯誤も現実的でない。**第8章 8-2 で、少なくとも「着地したら高ワープで死ぬ」ことは机上で確定した** |
| 喪失理由がワープ倍率に依らないこと(×1 と ×131072 の突き合わせ) | ×1 で喪失が起きるまで待てない(×131072 で 60 秒かけて破片が減り始める規模) |
| 第5章・第8章を入れたあとの、弧が表面で切れること | 上と同じ。表面すれすれの軌道を入力だけで作れない |

**共通の欠けているもの**: どれも「実行時に観測する前に、その状況をどう作るか」を用意しなければ
ならない種類で、`/verify` の手順(キー入力で駆動する)の射程の外にある。
当てるなら**その状況を作るステージか、状態を直接置ける口**が要る。
`debug-load` と同じ形の隠しステージ(月面すれすれに艦を置く / 天体の内側に破片を置く)を
1つ足すのが、いちばん安く済む。

## 9-3. `npm run smoke:browser` がこの環境で完走しない

**退行ではなく環境。** ヘッドレスのソフトウェア WebGPU では 60 フレーム完走に**約 82 秒**
かかるのに、このツールの待ち時間は 30 秒に固定されている。
着手前の `18a67e55` でも同じところで同じように落ちることを確認済み。
`npm run ci` はこれを含むので、この環境では `ci` を最後まで通せない。
**待ち時間を環境変数か引数で伸ばせるようにするのが最小の是正。**

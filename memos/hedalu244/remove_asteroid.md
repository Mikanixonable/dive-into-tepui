# Asteroid 型と「重力を及ぼす GameEntity」の基盤を全廃する

## 目的

`GameEntity` が他の `GameEntity` へ重力を及ぼすことをやめる。廃止後は、**`Simulator` でも
`Predictor` でも、時刻から解析的に位置が求まる天体暦上の天体だけが、重力・2次重力場・大気に
よって `GameEntity` へ作用する。** 天体暦の天体は解析式で位置が決まるので反作用を受けない。
`GameEntity` どうしが相互作用する経路は、剛体接触だけになる。

### なぜやるか

- **重力を及ぼす個体は、予測が原理的に正確になりえない。** 予測は選ばれた少数の弧を1本ずつ、
  それぞれ別の先端時刻で伸ばす。共通の瞬間が無いので、引き合う個体どうしの相互作用は解けない。
  現状はその個体をケプラー外挿した位置で代用して他の弧を積分しており、**体積の大きい個体が
  ケプラー軌道から外れた三体問題的な運動をしている場面で、予測が大きく破綻する。**
- **予測に要求される正確さが上がった。** 予測列の状態を実シミュレーションがそのまま消費する
  ようになったため、予測の誤差はもはや線の見た目の問題ではなく、実際の飛行そのものの誤差になる。
- **衝突による不連続な影響は廃止の対象ではない。** これは連続的な軌道変更ではなく、弧の打ち切り
  として表現されている。ただし廃止後、予測の弧が表面到達の相手にする `GameEntity` は
  1つも存在しなくなるため、その機構(`predictedAsPlanCollider`)自体も削除する。

### 副次的に得られるもの

予測が引く天体の候補が天体暦の天体だけになる。その結果、
「天体暦で位置を引けるか」(`analytic`)「表面到達の相手か」(`collision`)という候補ごとの区別が
どちらも恒真・恒偽に潰れ、弧が引く窓から `gravity` と `analyticGravity` の二重管理が消える。
`Simulator` と `Predictor` の積分対象が近づく。

---

## 達成目標

全ステップ実施後、次がすべて満たされていること。

1. `grep -rn "Asteroid\|asteroid" src/ --include=*.ts` の一致が、点群
   (`celestial/point-field.ts`・`point-field-view.ts`)の**自身の説明**を除いて 0 件。
   点群側にある「`game-entity/asteroid.ts` の `Asteroid` とは別物」という対比も消えていること。
2. `src/game/game-entity/` と `src/game/simulation/` に、`GameEntity` の `mu` を読む箇所が
   0 件。`GameEntity` を `Attractor` として渡す箇所が 0 件。
3. `EntityManager` に `attractors()` と `asteroids` が存在しない。
4. `physics/attractor.ts` の `Attractor` を作るのは `Ephemeris` と
   `celestial/environment-scene.ts`(表示専用の疑似天体)だけである。
5. `ArcBodyWindow` が `gravity` / `analyticGravity` の2本を持たない。
6. `FutureAttractorProvider.bodyAt` の戻り値型に `null` が含まれない。
7. `npm run typecheck` と `npm run test:physics` が通る。
8. `DEVELOP/SPEC/ORBIT.md` と `DEVELOP/SPEC/COMBAT.md` に、重力を及ぼす小惑星の記述が残っていない。
9. 通常ステージと高負荷デバッグステージ(タイトルで `L`)の両方で、負荷確認ウィンドウの
   `gravitySources` が **64 で一定**(天体暦の重力天体数)になる。現状は高負荷ステージで 364。
10. PREDICT パネルの予測線と、軌道計画の折れ線が従来どおり描かれ、計画のノードを編集すると
    その場で引き直される。
11. **廃止された識別子が 1 件も残っていない。** `Asteroid` / `addAsteroid` / `MAX_ASTEROIDS` /
    `DEBUG_LOAD_ASTEROID_*` / `ARC_REANCHOR_INTERVAL` / `setGravitatingMass` /
    `predictedAsGravitySource` / `predictedAsPlanCollider` / `consumesPrediction` /
    `mergeAttractors` / `analyticGravity` / `excludeId` / `predictionCoverage` を
    `src/` `tests/` `tools/` `DEVELOP/` に全文検索して 0 件。
12. **廃止したものの経緯がコードにも仕様書にも残っていない。** 「かつて」「以前は」「もともと」
    「旧」「〜だった」「〜は廃止した」「名残」「互換」で `src/` と `DEVELOP/` を検索し、
    今回の廃止を指すものが 0 件。**経緯を残す場所は git の履歴だけである。**
13. **限定句を消した跡へ、責務外の言い直しが書き足されていない。** 今回の変更で触れた
    コメント・仕様に「例外なく」「すべての」「常に〜される」を含む文を足していないこと。
    足す必要を感じたら、それは消すだけで足りるものを言い直している。

---

## 変更が必要な箇所

### Asteroid 型と生成側

| ファイル | 内容 |
| --- | --- |
| `src/game/game-entity/asteroid.ts` | 全削除(39行) |
| `src/render/ships.ts` | `buildAsteroidMesh`(434行付近)を削除。`displaceVertices` は他の3箇所が使うので残す |
| `src/game/const.ts` | `ASTEROID_TEST_MASS` / `ASTEROID_TEST_RADIUS` / `MAX_ASTEROIDS` / `DEBUG_LOAD_ASTEROID_*`(6本)と、それぞれの節見出し・コメント |
| `src/game/stages/stage-debug.ts` | 目視確認用に3体を配置する箇所と `Asteroid` の import |
| `src/game/stages/stage-debug-load.ts` | 小惑星の配置ループ。**ステージ自体は破片のみで存続させる** |
| `src/game/simulation/entity-manager.ts` | `asteroids` 配列・`addAsteroid`・`rebuildCachesIfNeeded` の合流・`cleanup` の `prune`・`disposeAll`・`perfCounts` |
| `src/perf-meter.ts` | `PerfCounts.asteroids` と `ent-asteroids` 行 |
| `src/game/celestial/point-field.ts`<br>`src/game/celestial/point-field-view.ts` | 冒頭の「`asteroid.ts` の `Asteroid` とは別物」という対比コメント |
| `src/physics/solar-system.ts` | `GRAVITATIONAL_CONSTANT` の宣言(15行付近)と、ハウメアの衛星の定義(1225行付近)にある「`Asteroid` エンティティと同じ手法」という対比。**定数そのものはレジストリが使い続けるので残す** |

### GameEntity が重力源であることの配線

| ファイル | 内容 |
| --- | --- |
| `src/game/game-entity/game-entity.ts` | `mu` / `degree2` / `isStar` / `accel` / `setGravitatingMass` / `predictedAsGravitySource` / `consumesPrediction` を削除。`hasFutureReader` から重力源の項を落とす。`stepActual` は常に `invalidatePrediction`、`ensurePredictedArc` は `consumable` に真、`excludeId` に未指定を渡す |
| `src/game/simulation/entity-manager.ts` | `cachedAttractors` と `attractors()` |
| `src/game/simulation/attractors.ts` | `mergeAttractors`(恒等になる)、`attractorsAt` の `EntityManager` 引数、`attractorsNearInto` の `excludeId` と詰め直し |
| `src/game/simulation/simulator.ts` | `substep` の `selfId` 分岐と `e.consumesPrediction &&` 分岐。`surfaceBodies` のコメント |
| `src/game/display-window-manager.ts` | `attractorsAt` が `Ephemeris` へ委譲するだけになる |
| `src/game/simulation/predictor.ts` | 消費されない弧の再アンカー分岐(`!e.consumesPrediction` の枝)。冒頭コメントの「引き合う小惑星どうし」 |
| `src/game/const.ts` | `ARC_REANCHOR_INTERVAL`。`ARC_MAX_STEPS` / `ARC_MIN_STEP_DT` のコメントにある「mu ≠ 0 の実体の予測」 |
| `src/game/simulation/predicted-arc.ts`<br>`src/game/simulation/arc-bodies.ts` | `excludeId` の経路一式、`heaviestGravityId` の除外引数 |

### 予測が引く天体が天体暦だけになることの波及

| ファイル | 内容 |
| --- | --- |
| `src/game/game-entity/game-entity.ts` | `predictedAsPlanCollider` |
| `src/game/simulation/future-attractors.ts` | 動的個体の経路一式 — `bodyAt` の `displayState` 分岐、候補への合流、`excluded` 集合、`predictionCoverage` と `NO_PREDICTION`/`PREDICTION_*`、`sameIds`、`unresolvedPlanEndTick`。160行 → 約40行 |
| `src/game/plan/plan-editor.ts` | `excludedIds`(716行付近)と `resolve` の引数 |
| `src/game/simulation/arc-bodies.ts` | `FutureBodyCandidate` の `analytic` / `collision` フィールド、`ArcBodyWindow.analyticGravity`、`resolve` の `body === null` 分岐、`slackTime` の `collision` 分岐 |
| `src/game/simulation/predicted-arc.ts` | `rawCenter` と `analyticCenter` の統合 |

### 仕様書

| ファイル | 節 |
| --- | --- |
| `DEVELOP/SPEC/ORBIT.md` | 「多体重力」(相互重力・真の多体問題)、「天体表面への到達判定」(小惑星は対象外)、「剛体接触」(小惑星も対等に反発)、「未来予測」(消費経路の限定・小惑星の予測を外挿して重力源に使う)、「数値的な限界」 |
| `DEVELOP/SPEC/COMBAT.md` | 「剛体接触によるダメージ」の当事者列挙 |

### 変更しないもの(確認済み)

- `tests/physics/n-body.test.ts` — 合成した `Attractor` で多体重力そのものを検査する。多体重力は
  天体暦の天体として残るので、この試験は残す。
- `src/physics/` の実装 — `Attractor` / `mu` / 多体重力は天体暦側の仕組みとして残る。
  `GRAVITATIONAL_CONSTANT` もレジストリが使い続ける。**触るのは `Asteroid` を引き合いに出した
  コメント2箇所だけ。**
- セーブデータ — 小惑星は保存対象に入っていない。互換性の影響はない。
- `ContactPhysics` — 剛体接触の当事者から1種別が減るだけで、機構は変わらない。

---

## 手順

### Step 1 — Asteroid 型と生成側を削除する

`asteroid.ts`・`buildAsteroidMesh`・小惑星関連の定数・2つのデバッグステージの配置・
`EntityManager` の `asteroids` 配列・`perf-meter` のカウンタ・点群側の対比コメントを削除する。

高負荷デバッグステージは**破片のみのステージとして存続させる。** ラベル・`selectSub`・
`briefingHtml`・冒頭コメントから「小惑星」「万有引力計算の高負荷」を落とし、
**多数のエンティティを積分する負荷を再現するステージ**として書き直す。破片の数
(`DEBUG_LOAD_DEBRIS_COUNT` = 500)は変えない。

このステップの後も `GameEntity.mu` 等の配線は残るが、**`mu ≠ 0` の個体を作る手段が
1つも無くなる。**

**完了条件**: 達成目標 1 を満たす。`npm run typecheck` が通る。

---

### Step 2 — GameEntity から重力源の属性を落とす

`mu` / `degree2` / `isStar` / `accel` / `setGravitatingMass` / `predictedAsGravitySource` /
`consumesPrediction` を削除し、それを読んでいた側を畳む。

- `EntityManager.attractors()` と `cachedAttractors` を削除する。
- `attractors.ts` の `mergeAttractors` を削除し、`attractorsAt` を天体暦への委譲だけにする。
  `attractorsNearInto` から `excludeId` と詰め直しの走査を落とす。
- `display-window-manager.ts` の `attractorsAt` は `Ephemeris` の戻り値をそのまま返す。
  **`Ephemeris` の配列はキャッシュの共有参照なので、読み取り専用である旨をこの場に書く。**
- `Simulator.substep` から `selfId` と `consumesPrediction` の分岐を落とし、全個体が
  「予測列がその時刻を持てば従い、無ければ積分する」だけになるようにする。
  `surfaceBodies` のコメントから、動的重力源が相手に加わるという記述を削除する。
- `Predictor` から消費されない弧の再アンカー分岐を落とし、`ARC_REANCHOR_INTERVAL` を削除する。
  冒頭コメントの二重性の説明から「引き合う小惑星どうし」を落とす。`Simulator` 冒頭の
  同じ記述も落とす。
- `PredictedArc` / `ArcBodies` の `excludeId` と、`heaviestGravityId` の除外引数を削除する。

**完了条件**: 達成目標 2・3・4 を満たす。`npm run typecheck` が通る。

---

### Step 3 — 予測の衝突相手から GameEntity を外す

`predictedAsPlanCollider` を削除し、`FutureAttractors` から動的個体の経路を落とす。

- `hasFutureReader` は「未来ゴーストとして描くか」と「予測線を持つか」の2つだけになる。
- `FutureAttractors` の候補は天体暦のレジストリからのみ組む。`bodyAt` は
  `Ephemeris.attractorAt` への委譲になり、**`null` を返さなくなる。**
- 予測の届き具合を畳み込む世代値の仕組み(`predictionCoverage` と 32bit 畳み込み)を削除する。
  残る入力は計画の編集だけなので、`resolve` は計画の世代値だけを受け取る。
  `planEnd` と `excludedEntityIds` の引数、`plan-editor.ts` の `excludedIds` も削除する。
- `ArcBodies.resolve` の `body === null` の枝を削除する。

**完了条件**: 達成目標 6 を満たす。`npm run typecheck` が通る。計画のノードを編集したときに
折れ線が引き直されることを実機で確認する(達成目標 10)。

---

### Step 4 — 候補が解析天体だけになったことを弧へ通す

`FutureBodyCandidate` から `analytic` と `collision` を削除する。天体暦の天体はすべて位置を
解析的に引けて、すべて表面到達の相手になるので、どちらも恒真になる。

- `ArcBodyWindow` から `analyticGravity` を削除する。残る `gravity` は
  `mu ≠ 0` の解析天体だけなので、これがそのまま外挿・近地点/遠地点の中心を選ぶ母集団になる。
- `PredictedArc.step` の `rawCenter` と `analyticCenter` を1つに統合する。
- `heaviestGravityId` から `analytic` の判定を落とす。
- `slackTime` の `collision` による分岐を落とす。

**完了条件**: 達成目標 5 を満たす。`npm run typecheck` と `npm run test:physics` が通る。
PREDICT パネルの予測線が、地球圏・月圏・惑星間のいずれでも従来どおり描かれる。

---

### Step 5 — 弧の作り直しを命じる責務の置き場所を決める(要判断)

**このステップは Step 4 まで終えた時点で判断する。着手前に決め打ちしない。**

Step 3 の後、`FutureAttractorProvider.revision` は計画の世代値をそのまま通すだけになり、
`candidateRevision` は最初の1回以降変化しなくなる。この時点で `FutureAttractors` に残る責務は
「天体暦を弧の引ける形へ見せる」ことだけで、計画の世代値を持つ理由が無い。

選択肢は2つ。

- **A: `revision` を `FutureAttractorProvider` から外す。** 弧を作り直すかどうかは
  `plan-path.ts` が計画の世代値を直接見て決める。`PredictedArc.represents` から
  `sourceRevision` 引数が消え、`ArcBodies` は候補を構築時に1度だけ組む。
  `FutureAttractors` は天体暦のアダプタだけになり、`Ephemeris` 自身が
  `FutureAttractorProvider` を満たせるなら module ごと消える。
- **B: 現状の形を維持する。** `FutureAttractors` が計画の世代値を預かり続ける。

**A を採るときの確認事項**: `PredictedArc.represents` は起点状態の同一参照でも判定している。
計画のノードを編集したとき、区間の起点状態が新しいオブジェクトに差し替わるかどうかを
`plan-path.ts` 側で確かめる。**差し替わるなら世代値は冗長だが、艦の実状態を起点にする先頭区間は
毎フレーム同じ参照を返しうるので、そこだけ別の判定が要る可能性がある。**

**完了条件**: A・B のどちらを採るかを決め、採った側を実装し終える。B を採る場合は、
`FutureAttractors` が計画の世代値を持つ理由をコメントに書く。

---

### Step 6 — 残骸を一掃する

**この計画は引き算しかしない。引き算の失敗は「動かない」ではなく「動くが、消したはずのものの
形が残る」という形で出る。** 型検査は消し残した定数・コメント・空洞化した抽象を一切
指摘しないので、**最後に明示的な掃除のステップを置く。**

#### 6-1. 廃止した識別子の全文検索

達成目標 11 の識別子を1つずつ検索し、0 件を確認する。`src/` だけでなく `tests/` `tools/`
`DEVELOP/` も対象にする。`docs/` はビルド成果物なので対象外。

`tests/perf/common.ts` と `tests/perf/exp3-gravity-cost.ts` には、`entities.attractors()` が
空配列であることを前提にした説明コメントがある。**前提そのものが消えるので、コメントを直す。**

#### 6-2. 歴史的経緯と、限定を消した反動で生じる責務外言及の排除

達成目標 12 の語で `src/` と `DEVELOP/` を検索する。**今回消したものを説明するために書かれた
記述は、コメントでも仕様書でも 1 行残らず消す**(`CODING-RULE.md` 1.10・3.3-5)。
「以前は小惑星も重力源だった」「重力を及ぼす個体はもう存在しない」のような否定形の説明
(3.3-2)は、いずれも読み手に存在しないものを想像させるだけで、現在のコードの理解には何も足さない。

**この計画で特に出やすいのは、限定句を消した跡へ「では何が該当するのか」を書き足してしまう
誤り。** 限定が外れたなら**消すだけで足りる** — 残った本文が例外なく成り立つようになることが、
限定を消したことの意味そのものである。書き足した文は、たいてい書き手の責務外を語る
(3.3-3「誰が使うか」・3.3-4「現状どのように使われているか」)。

- **予測の仕様に「誰が予測を消費するか」を書かない。** 予測を辿るか自分で積分するかを決めるのは
  実シミュレーション側の責務。予測が負うのは要求精度だけ。
- **`PredictedArc` のコメントに「実シミュレーションが必ず引く」と書かない。** 弧は
  `consumable` として要求精度の指定を受け取るだけで、引かれるかどうかは知らない。
- **`Simulator` のコメントに「予測を持たない種別」を列挙しない。** 分岐は「予測列がその時刻を
  持つか」だけを見る。

**もう1つ出やすいのは、削除した分岐の片側だけが残った説明。** 二者択一を説明していたコメントから
片方を消すと、残った側が「なぜそう書くのか」を説明しない断片になる。次の3箇所は元が二者択一なので、
消すのではなく**書き直す**:

- `Simulator` と `Predictor` の冒頭にある、両者の二重性を説明したコメント。**「同時性」の項が
  挙げる理由から相互重力が消え、剛体接触だけが残る。** 残った理由だけで筋が通るように書き直す。
- `Simulator.surfaceBodies` の、ワープ帯によって相手にする天体が変わる理由。
- `const.ts` の `ARC_STEPS_PER_REV` / `ARC_MAX_STEPS` / `ARC_MIN_STEP_DT` にある
  「消費されない弧(計画の区間・mu ≠ 0 の実体の予測)」という括弧書き。**消費されない弧は
  計画の区間だけになる。**

#### 6-3. 空洞化した抽象の点検

`DEVELOP/CODING-RULE.md` を基準に、`git diff --stat` が挙げたファイルと、そこから1段だけ
辿れる範囲を点検する(`/refactor` の手順)。**引き算のあとに特有の逸脱**を重点的に見る。

- **責務が無くなったモジュール・関数。** 引数を1つ受けて別の関数へ渡すだけになったもの、
  分岐が1本になった関数、要素が1つだけの型。
- **意味を失った引数と戻り値。** 常に同じ値しか渡らない引数、`null` を返さなくなった戻り値型、
  真偽値のうち片方しか取らないフラグ。
- **1箇所からしか呼ばれなくなった関数。** 呼び出し元へ畳めないかを見る。
- **旧名の残骸**(`CODING-RULE.md` 1.10)。廃止に伴って意味が変わった名前が、古い意味の
  ままになっていないか。特に `attractors` — `GameEntity` を指さなくなったのに、
  変数名・引数名がその含みを残していないか。

続けて `/comment-cleanup` の手順 A・B を、この変更で触れたファイルへ通す。過剰・不足の
**件数を作業前後で記録する。**

#### 6-4. 仕上げ

`npm run ci` を通す。

**完了条件**: 達成目標 11・12・13 を満たす。`npm run ci` が通る。6-3 で見つけて直したものと、
見つけたが直さなかったもの(とその理由)を、`CODING-RULE.md` の節番号つきで報告する。

---

## 見積り

### 削除規模

現行の行数から導く。

| 対象 | 導出 | 削除見込み |
| --- | --- | --- |
| `asteroid.ts` | ファイル全体 | 39行 |
| `future-attractors.ts` | 160行のうち、動的個体の経路と世代値の畳み込みが本体 | 約120行 |
| `arc-bodies.ts` | 156行のうち `analytic`/`collision`/`excludeId`/null 分岐 | 約35行 |
| `attractors.ts` | 108行のうち `mergeAttractors` と `excludeId` の詰め直し | 約25行 |
| `game-entity.ts` | 属性7つとその説明コメント | 約25行 |
| `const.ts` | 定数9本と節見出し | 約20行 |
| `ships.ts` | `buildAsteroidMesh` | 約17行 |
| その他8ファイル | 分岐・配列・カウンタ | 約70行 |
| **合計** | | **約350行** |

### 重力源の絞り込みの費用

天体暦のレジストリは全100天体、うち `mu ≠ 0` が 64 天体(残り36は表示専用)。

- **通常ステージ**: 変化なし。`attractorsAt` は現在も 64 体を返す。
- **高負荷デバッグステージ**: `attractorsAt` が 64 + 300 = 364 体 → 64 体。
  `classifyAttractors` は `mu` の全ソートに支配されるので、比較回数は
  364 × log₂364 ≈ 364 × 8.5 ≈ 3,100 → 64 × 6 = 384 で **約 1/8**。
  これはサブステップごとに1回払う費用で、最高ワープでは1フレーム 64 サブステップまで走る。
- **弧の候補走査**: 候補は 100 + 動的個体 → 100 で固定。`ArcBodies.syncCandidates` は
  候補の顔ぶれが変わるたびに `watches` を組み直していたが、**実行中1回だけ**になる。

### 検証

`npm run typecheck` が全参照を洗い出すので、Step 2〜4 の探索は grep 1回と typecheck の反復で
閉じる。`src/physics/` の実装には触れないので `npm run test:physics` は Step 4 の
最後に1回だけでよい。

**ただし型検査が担保するのは「壊れていないこと」だけで、「残っていないこと」は担保しない。**
消し残した定数・コメント・空洞化した関数はすべて型検査を通る。Step 6 の検索と点検は、
Step 1〜5 を丁寧にやったかに関わらず**必ず通す。** 対象は達成目標 11 の識別子13個と
達成目標 12 の語8個の、計21回の全文検索。

---

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `display-window-manager.attractorsAt` が `Ephemeris` のキャッシュ配列をそのまま返すようになる。`mergeAttractors` が新しい配列を作っていたぶんの防護が消える | 呼び出し側がこの配列を書き換えると**同一時刻の全問い合わせが壊れる**。書き換えは型では止まらない | 天体の位置が飛ぶ・軌道線が壊れる。マップビューで天体を表示したまま時間を送ったとき |
| `Predictor` の再アンカー分岐を消すとき、`ARC_REANCHOR_INTERVAL` を消し忘れる | 参照されない定数が残る。害はないが、後から「なぜ弧を張り直さないのか」を再検討させる | `grep -rn "REANCHOR" src/` |
| `ArcBodies.resolve` の `body === null` の枝を消すとき、`nextVisitT` の更新も一緒に消してしまう | 天体が一覧から落ちたまま再訪されず、**予測線が天体の重力を無視する**。線は破綻せず滑らかなまま間違う | 月・惑星の近くを通る予測線が、実際の飛行と食い違う。PREDICT の線と実軌道の乖離 |
| `rawCenter` と `analyticCenter` を統合するとき、母集団を `collision` 側の一覧と取り違える | ケプラー外挿と近地点/遠地点の中心が `mu = 0` の表示天体になりうる。`keplerPeriod(_, 0)` は非有限を返す | 予測線の先端が飛ぶ。近地点/遠地点マーカーが消える・別天体基準になる |
| `hasFutureReader` から重力源の項を落とすとき、`predictedLine !== null` の項まで巻き添えにする | 予測線を持つだけの個体が伸長対象から外れ、**線が伸びなくなる** | 敵機・補給・基地の予測線が現在位置で止まる |
| Step 3 で計画の世代値まで削ってしまう | 計画のノードを編集しても弧が作り直されず、**古い折れ線が残り続ける** | 計画パネルで Δv を変えても線が動かない |
| `EntityManager.attractors()` を消すとき、`rebuildCachesIfNeeded` の他のキャッシュ再構築を巻き添えにする | `all()` / `otherEntities()` が古い顔ぶれを返す | 新しく生成した弾・破片が積分されない。撃っても弾が飛ばない |
| 高負荷デバッグステージから小惑星だけを抜いて、`randomOffset` と `DEBUG_LOAD_PLACEMENT_MIN_DIST` の使い手が破片だけになる | `DEBUG_LOAD_ASTEROID_MAX_DIST` を消すとき、破片側の `DEBUG_LOAD_DEBRIS_MAX_DIST` まで消す | ステージ起動時に破片が自機と同じ位置に湧く、または `NaN` で消える |
| 限定句を消した跡へ「では何が該当するのか」を書き足す | 書き足した文は書き手の責務外を語る(`CODING-RULE.md` 3.3-3/3.3-4)。**しかも事実として間違えやすい** — 限定が外れた範囲を、限定を消した側は正確には知らない | SPEC の「未来予測」節、`PredictedArc` と `Simulator` のコメント。**「例外なく〜する」と書いた文はすべて疑う** |
| 二者択一を説明していたコメントから片方だけを消し、残った側をそのままにする | 「なぜそう書くのか」を説明しない断片が残る。**次に読む者は、消えた側を推測して存在しない機構を想像する** | `Simulator` / `Predictor` 冒頭の二重性の説明、`const.ts` の弧の刻みに関する括弧書き |
| 引数・戻り値が意味を失ったまま残る(常に同じ値しか渡らない引数、`null` を返さなくなった戻り値型) | 呼び出し側が存在しない場合に備え続ける。**その分岐は二度と実行されないので、壊れていることに誰も気づけない** | `bodyAt` の戻り値型、`PredictedArc` の `consumable`、`ArcBodies` の候補構築 |
| `attractors` という名前が `GameEntity` を含まなくなったのに、変数名・引数名にその含みが残る | 名前が実体と食い違い、以後の変更が誤った前提で行われる | `EntityManager` を引数に取っていた箇所の周辺、`display-window-manager` |
| `Simulator.surfaceBodies` の分岐が残る | 剛体接触を解決しないワープ帯では、再突入判定の相手が重力窓の64体に限られ、表示専用の36天体への到達を落とす。**これは現状も同じで挙動は変わらないが、その理由を述べたコメントが嘘になる** | コメントと実装の突き合わせ。SPEC の「対象は登録されている全ての天体」との食い違い |

### 却下した案

- **`predictedAsPlanCollider` を利用者ゼロのまま残す。** 予測の弧が `GameEntity` の表面へ
  到達して打ち切られる経路を、将来のために残す案。**残す限り `FutureAttractors` の動的個体経路
  (未来状態の参照・候補の合流・除外集合・予測の届き具合の畳み込み)が丸ごと維持されるため、
  この計画の簡略化がほとんど得られない。** 必要になった時点で、そのとき要る形で作り直す。

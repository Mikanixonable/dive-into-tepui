# 段 6 の未決事項と判断材料
プロンプト
```
コードも文書も編集せず、調査と私への報告だけしてください。

restructure-architexture.mdの段6の未決事項について、私が判断したい部分もあるので、未決事項それぞれについて、なぜその時までに決めないといけないか（現状維持ではどのような不都合が出るか）、選択肢は何か、それぞれの選択肢のメリット（とデメリット）、採用した場合のownershipやcallstackがどうなるか教えてください。

また、明示的に未決とはされていない点ですが、計画の1075行目、「規則が View を読む」「幾何は `physics/protein-site-geometry.ts` にある」についてだが、physicsやviewにdynamic-entityの実体の幾何が直で置かれているのはいまいちよくないと思っている。（依存方向的には正しいかもしれないが、意味論的にはphysicsはdynamicのゲーム固有値を持ち込まないでほしいと思っている。利用者の依存方向的に可能ならdynamic/に置く（定数を利用者の隣に置く）か、importできない外部から読み必要がある場合はdynamicでもphysicsでもない共通正本ファイル（例えばgame-geometry/などフォルダ名で）に出すか。どうしてもphysicsに置くなら私が我慢して意味理解を変えるが……。いずれにせよ、流儀が揃っていないのは問題）
```

コードも文書も編集していません。調べたのは `46697f93` に、手順 5-3 の未 commit の作業ツリー(`game-presentation.ts`・`src/run/`)を足した状態です。行番号もこの時点のものです。

段 6 で「ここで決める」と明記されている未決事項は3件です。これとは別に、計画上は決まったことになっているが実は未決のものが1件あります。ご指摘の 1075 行目のタンパク質の件がそれで、置き場の問題より前に SPEC の判断が要ります。

---

## 1. 実体を運動の所有者とみなすか(手順 6-1、K6 保留3)

### なぜ 6-1 までに決めるか
- 6-1 で 2.2 の `entity`/`motion` の節を書き直します。いまの文面は「Entity は Motion を所有する」と「推力・質量は Motion が所有」の両方を言っています。このため、実体が `motion.thrust =` と書くことが R3「他人のフィールドへ代入しない」に反するのかどうか、文面から決まりません。決めないまま書くと、食い違った規則が main に入ります。
- 6-3 の条件付きの行(+60 分)が入るかどうかも、この答えで決まります。
- 現状のままにした場合の不都合:
  - `mass` の書き方が2つある。自機は命令 `rebuildMassAndInertia`([player-motion.ts:226](src/game/player/player-motion.ts#L226)、`921661d5` で直したもの)。分離ブースターは部品が直に代入している([detached-booster-motion.ts:36](src/game/dynamic/dynamic-entity/detached-booster-motion.ts#L36))。
  - `thrust` は setter で、代入すると予測弧を捨てる副作用があります([dynamic-motion.ts:242](src/game/dynamic/dynamic-motion.ts#L242))。見た目は代入でも中身は命令です。自機はそれを知らずに `invalidatePrediction()` をもう一度呼んでいます([player.ts:279](src/game/player/player.ts#L279))。
  - フィールドへの代入は `check:boundaries` の対象外なので、機械的には捕まりません。

### 事実: 誰が書いているか
| 値 | 書く者 |
| --- | --- |
| `thrust` | Player・Base・分離ブースターの behavior |
| `torque` | Player([player.ts:287,469](src/game/player/player.ts#L287))、Base([base.ts:153,164](src/game/dynamic/dynamic-entity/base.ts#L153)) |
| `mass` | 自機は自分の命令で、分離ブースターは behavior が代入。後者は `BoosterStack.totalMass` の写しで、計算で求まる値を状態として持っています |
| `alive` | Motion 自身・反応・Player に加えて、**実体の外から** `DynamicSystem.enforceCaps`([dynamic-system.ts:182](src/game/dynamic/dynamic-system.ts#L182))、Logistics([logistics.ts:190](src/game/stages/stage-utils/logistics.ts#L190) ほか3か所)、メニューの削除([enemy-inspection.ts:109](src/game/pickable/enemy-inspection.ts#L109)) |

計画の行は `thrust`/`mass` だけを挙げていますが、同じ形の `torque` が漏れています(`base.ts:153` はそもそも torque の行です)。

### いまの流れ(Motion の構造はどちらの選択肢でも変わりません)
```
DynamicSystem.update(active, controls, operable, dt, simDt, …)
├─ updateThrusts ……………………………… 生存中の全個体
│  └─ DynamicMotion.updateCommands(simDt)
│     └─ DetachedBoosterBehavior.updateCommands   ← 部品が self.mass・self.thrust へ代入
├─ updateControllables ……………………… 生存中の自機・基地
│  └─ Player / Base.updateControls(PilotCommandFrame)
│        motion.torque = throttle.updateTorque(…)
│        motion.thrust = throttle.updateThrustState(…)
├─ behaveAll
└─ Simulator.advance   ← thrust・torque・mass を読んで積分
```

### 選択肢
- **A. みなす。** R3 の「所有者」を「所有の木(実体とその部品)」と読むことを 2.2 に書きます。
  - 利点: コードの変更はゼロで、計画から 60 分減ります。流れも上の図のままです。
  - 欠点: R3 が「木の中なら代入してよい」に弱まります。木の境界は型に現れず、TS の `private` でも守れません。`mass` の2流儀は、両方とも合法になるだけで残ります。
- **B. みなさない。** 書き手を Motion に限ります。
  - `thrust`・`torque` を private にして、命令 `applyControl(thrust, torque)` を置きます。`setThrust` という名前は段1の禁止パターン([check-boundaries.mjs:107](tools/check-boundaries.mjs#L107))に当たるので使えません。
  - 分離ブースターの `mass` は、`bcInv`・`contactMass` と同じ既存の形で behavior の hook から引く導出値にします([dynamic-motion.ts:231-239](src/game/dynamic/dynamic-motion.ts#L231-L239))。状態が1つ減ります。
  - 実施後の流れ:
    ```
    ├─ updateThrusts → DynamicMotion.updateCommands
    │     this._thrust = behavior.updateCommands(this, simDt)   ← 値を返させ、代入は Motion がする
    ├─ updateControllables → Player / Base.updateControls
    │     motion.applyControl(thrust, torque)                   ← 命令
    ```
  - 利点: R3 の字面どおりになり、型検査が守ります。`mass` の書き方が1つに揃い、いまの 2.2 の「推力は Motion が所有」とそのまま整合します。
  - 欠点: 作業が 60 分強増えます(torque も入れるため)。

**推奨は B です。** ただし、どちらを選んでも、上の表の実体の外からの `alive` の書き込みと `CreativeStage` の `ship.motion.state =`([creative-stage.ts:241](src/game/stages/creative-stage.ts#L241))は R3 違反として残ります。計画のどの手順にも載っていないので、拾う場所を決める必要があります。

---

## 2. `dynamic-presenter.ts`・`entity-lifecycle.ts` の採否(手順 6-3、K5)

### 事実
- どちらもいまも参照は0本です(mikanixonable さんの `d53314ef`)。
- `DynamicPresenter` は `present(state)`・`remove(id)` の形です。id を鍵にして、モデルから表示へ押し込みます。これは K1-4 で退けた「id の対応表」「モデルが表示物の寿命を持つ」形そのものです。さらに `EntityPresentationState` は `DynamicRenderSource` と id・状態・姿勢・生存が重なる3つ目の型です(R9)。
- `EntityLifecyclePort` の中身(追加・待ち行列・死亡・除去)は、いまある `EntityRegistry`・`EntityRoster` がすでに持っています。R6 の突き合わせ役に要る顔ぶれと改版番号も `EntityRoster` にあります。

### なぜ 6-3 までに決めるか
- 6-3 で本物の突き合わせ役を作ります。残しておくと「表示担当への口」が2つ並びます。後から来た人が未配線のほうを本来の設計と読んで配線すると、R6 と逆向き(id を鍵にして、モデルが押す)の経路ができます。
- 名前も混同しやすいです。既存の表示の導出は `*-presenter` という名前です(`flash-presenter`・`nav-target-presenter` など)。
- 6-3 で除去時に View を捨てなくなるので、`entity-lifecycle` のコメント「除去と所有資源の解放」が嘘になります。
- import は合法なので、検査は拾いません。決めない限り、いつまでも残ります。

### 選択肢
- **(a) 両方消す(作者の合意の上で)。** 実施後の持ち方と流れ:
  ```
  GamePresentation
  └─ 突き合わせ役(dynamic の族に1つ)
     ├─ InstancedPools              ← DynamicSystem から移る
     └─ Map<DynamicEntity, 表示担当>  ← 鍵は実体の同一性
        └─ 表示担当(種別ごと、クラス辞書で引く) └─ View
  Game └─ DynamicSystem(Registry・Roster のまま。View もプールも持たない)

  突き合わせ役.sync(frame)
  ├─ collectionRevision が前回と違えば、新しい実体に表示担当を作り(View の new はここ)、
  │  消えた実体の表示担当を1度だけ dispose する
  ├─ InstancedPools.beginFrame()
  ├─ 表示担当.sync(frame) ………… 全表示担当
  └─ InstancedPools.endFrame()
  ```
- **(b) `DynamicPresenter` という名前だけ残し、中身を R6 の形に書き直す。** 持ち方と流れは (a) と同じです。ただし中身は全部書き直しで、置き場もモデル層の `game/dynamic/` から表示の導出へ移す必要があります。「採用」とは名ばかりです。
- **(c) `entity-lifecycle` を採り、`markDead` を置く。** 1 で残る「実体の外からの `alive` の書き込み」を1つの入口へ集められます。欠点は、Registry と重複すること、内部の手順 `processPendingSpawns` が公開面に出ること、そして `alive` の書き手が Motion と DynamicSystem に割れることです。R6 には不要なので、やるなら 1 の続きとして別に設計するほうが筋です。

**推奨は (a) です。** あなたが決めることになるのは、作者への確認をどうするかです(K5 には「消すときは作者の合意を得る」とあります)。

---

## 3. `entity-inspection.ts` の採否(手順 6-4、K5)

### 事実
- `EntityInspectionAction` は `MenuAction`([menu-actions.ts:5-20](src/game/hud/windows/menu-actions.ts#L5-L20))と15語がまったく同じです。メニュー項目とプロパティ行の型も、hud の型の写しです。狙いは「実体に hud の型を import させない」ことでした。
- 現状は2流儀です。
  - Enemy・Player は、`pickable/` の `EnemyInspection`・`PlayerInspection` を自分で作って持っています([enemy.ts:89](src/game/dynamic/dynamic-entity/enemy.ts#L89)、[player.ts:104](src/game/player/player.ts#L104))。
  - Base・Pickup は `ObjectPickable` を自分で実装しています。
- いまのメニューの流れ:
  ```
  ObjectWindows(DOM イベント)
  └─ CommandQueue.submit(() => target.runMenu(act, selection, authoring, planEditor))
     └─ EnemyInspection.runMenu …… 次の進行の位相の先頭
        ├─ 'delete'    → source.motion.alive = false            ← 実体の外からの代入
        └─ 'duplicate' → authoring.openObjectPlacerForDuplicate  ← 進行の位相で UI を開く
  ```

### なぜ 6-4 までに決めるか
- 6-4 は「メニューとプロパティ行を表示担当へ移す」「実体へ届く命令を進行の語彙だけにする」を行います。`entity-inspection.ts` は同じ問いへの別の答えです。
- 決めずに進めると、契約が3本並びます。加えて、同じ意味の語の列が2層にある R9 違反も残ります。
- 表示担当は hud を import してよいので、この型を作った動機そのものが 6-4 で消えます。

### 選択肢
- **(a) 消す。** 表示担当が `InspectedObject` を直接実装します。
  ```
  表示担当.runMenu(act)
  ├─ 進行に効く act → CommandQueue.submit(() => 所有者.命令())
  └─ UI の act(複製・配置)→ その場で窓を開く(R5-4)
  ```
  実体は `inspection`・`objectPickable`・`menuItems` を持たなくなり、2流儀も消えます。
- **(b) 語彙だけ採る。** 進行に効くものだけ(activate・deployPart・delete など)に絞った命令の union にします。ただし R3 は「命令はメソッド」としているので、メソッドと union の2流儀になります。命令をデータとして持つ理由も、いまはありません(列はクロージャを受けています)。
- **(c) 全部採る。** 実体が表示の文言や書式を作り続けることになり、R6 に反します。

**推奨は (a) です。** 作者との合意の点は 2 と同じです。

---

## 4. 1075 行目のタンパク質の部位 — 置き場より前に、SPEC の判断が要ります

### 事実
- 規則が読んでいるのは「表示中に揺らいでいる部位の位置」です。
  - 銃口: [protein-enemy.ts:172](src/game/dynamic/dynamic-entity/protein-enemy.ts#L172)
  - 被弾した部位の選択: [protein-enemy.ts:189-193](src/game/dynamic/dynamic-entity/protein-enemy.ts#L189-L193)
- その揺らぎは、直前の View の同期が次の3つから求めたものです([protein-enemy-view.ts:138-155](src/render/dynamic/dynamic-entity/protein-enemy-view.ts#L138-L155))。
  - **表示時刻**
  - **カメラから見た大きさで決まる細かさ**。遠くて最も粗い段階では静止構造になります。
  - **揺らぎ表示の設定**
- その結果、部位の半径に入ったかの判定([protein-combat-state.ts:233](src/game/protein/protein-combat-state.ts#L233))が、ズーム・時刻スライダーの位置・描画設定で変わります。これは R4「進行は視点を読まない」の違反で、K3 と同じ種類の問題です。
- コメントと実装も食い違っています。[protein-enemy.ts:168](src/game/dynamic/dynamic-entity/protein-enemy.ts#L168) は「銃口は静止座標で取り、揺らぎは乗せない」と書いていますが、実装は揺らぎを乗せています。
- SPEC の中でも割れています。
  - [PROTEIN.md:60-63](DEVELOP/SPEC/PROTEIN.md#L60-L63): 発射位置も揺らぎに追従し、マーカー・発射位置・命中部位の判定は同じ時点の位置を使う。
  - [PROTEIN.md:4](DEVELOP/SPEC/PROTEIN.md#L4)・[66-68](DEVELOP/SPEC/PROTEIN.md#L66-L68): 揺らぎは命中判定を変えず、表示を切っても変わらない。
- 計画の「規則は `physics/protein-site-geometry.ts` を直に使う」は、揺らぎの量をどこから得るかを書いていません。規則は揺らぎを計算できないので、この書き方だと実際には静止位置に切り替えることになります。それは挙動と SPEC の変更なのに、判断として記録されていません。

### 選択肢(先に `/modify-feature` で SPEC を決める)
- **(i) 規則は静止構造を使い、揺らぎは表示だけにする。**
  - SPEC の 60-63 行を書き換えます。コードのコメントはすでにこの考え方です。
  - 静止位置の計算は `closestSite` がすでに持っています([protein-combat-state.ts:225-227](src/game/protein/protein-combat-state.ts#L225-L227))。規則に要る幾何は、位置と姿勢による変換だけになります。
  - 見た目では、近くで見たときに弾の出る位置とマーカーが揺らぎの分だけずれえます。
- **(ii) 揺らぎを「敵とシミュレーション時刻だけで決まる」関数にして、規則も使う。**
  - 揺らぎの計算の仕組みを `render/` から出す作業が加わります。
  - 発射や被弾のたびに揺らぎを計算するので、その分の負荷が進行の側にかかります。
  - 表示は遠くで粗くなるので、「同じ位置」が成り立つのは近くで見たときだけです。
- 現状維持は、6-2 の検査(モデル層から render の値の import を禁じる)を通らないので取れません。

---

## 5. 実体の幾何の置き場 — 流儀は5通りに割れています

| 形 | 例 | 読み手 |
| --- | --- | --- |
| **A.** `physics/` の寸法定数(import 0本) | `player-shape.ts`・`booster-stage-shape.ts` | game/player、render、`tools/model-builder`(TS のまま読むので import を持てない) |
| **B.** `physics/` の実体専用の変換関数 | `protein-site-geometry.ts`(math を import) | render 2本、テスト1本 |
| **C.** 焼き込みアセット `src/assets/models/*.json`(層の表で定義層) | `base.json`・`baseCollision.json` | render 多数、game は `base-collision.ts` |
| **D.** game/ の定数を View のコンストラクタへ渡す | `ENEMY_MODEL_SCALE`・`BELT_MAX_VISIBLE` | — |
| **E.** game/ に手で写した数値 | 金属敵の半径([metal-enemy.ts:11-18](src/game/dynamic/dynamic-entity/metal-enemy.ts#L11-L18)、render のテストで照合)、薬莢の円柱([casing-collision.ts:12-14](src/game/dynamic/dynamic-entity/casing-collision.ts#L12-L14))、`BOOSTER_COLLISION_RADIUS = 4.2`(段の長さ 8m から手計算) | — |

### 規則との関係
- いまの CODING-RULE「`physics/` に物理でないものを持ち込まない」が除いているのは調整値と歪めだけです。厳密な幾何は `physics/` に置いてよいと読めるので、A・B は現行の規則では合法です。
- 一方、計画の最終形の R2 の表は `physics/` = 「法則・暦・時刻系」、`game/` = 「ゲーム内容の定義も持つ」としています。**あなたの意味の捉え方は計画の最終形と一致します。** 計画自身も K2 でこれを「定義層」と呼びながら、時刻層の `physics/` に置いたままで食い違っています。

### 「利用者の隣」に置けるか(render は game/ を import できない制約の下で)
- **A は置けます。** import を1本も持たず class も無いモジュールは、どこにあっても定義層として扱われます(R2、[check-boundaries.mjs:274-280](tools/check-boundaries.mjs#L274-L280))。`game/player/` へ移しても、render と tools はそのまま読め、検査も通ります。render が game/ の語彙を読む前例として `ViewMode` があります。
- **B は、(i) なら置けます。** 規則は静止位置の変換だけで足り、マーカーの位置は表示担当が View の出力から組めます。render から変換関数への import が消えるので、`game/protein/` に置けます。**(ii) なら置けません。** 規則と render の両方が揺らぎと変換を読むので、あなたの言う中立のフォルダが要ります。
- **E** は、A か C の正本から導く形へ直すべき重複です。

### 流儀の案
- **X(利用者の隣)**: 実体の寸法と形状は game/ の所有者の隣に置き、装置や tools が読むものは import 0本にする。
  - 利点: 新しいフォルダが要らない。「定数は概念の所有者が持つ」(1.6)とも計画の最終表とも一致する。
  - 欠点: import 0本の例外に頼る。(ii) を選ぶと成り立たない。
- **Y(中立のフォルダ)**: `src/assets/` と同じく、層の表で定義層にした形状の正本フォルダを新設する。
  - 利点: math を import する関数も置け、(ii) でも成り立つ。
  - 欠点: 使う場所から離れる。入れてよいものの基準を決めないと、雑多な定数置き場になる。
- **Z(physics/ に据え置き)**: `physics/` の意味の捉え方を変え、計画の最終表の文面も直す。

**私の推奨は、SPEC で (i) を選び、流儀は X に揃えることです。** 計画のいまの手順には A・E を動かす手順がありません。入れるなら 8-5(型の置き場を所有者へ揃える)が自然で、B は 6-3 で扱います。

---

### あなたに決めていただきたいこと
1. 実体を運動の所有者とみなすか(A か B)。あわせて、実体の外からの `alive` の書き込みをどの手順で拾うか。
2. 未配線の3ファイルを消すかどうかと、作者への確認をどう取るか。
3. タンパク質の部位の SPEC を (i) と (ii) のどちらにするか。
4. 幾何の流儀を X・Y・Z のどれにするか。

このほか、6-4 の引数の見直しや 6-5 の creative の宣言も中身は未確定ですが、実施のときに決められる範囲で、あなたの判断は要らないと見ています。

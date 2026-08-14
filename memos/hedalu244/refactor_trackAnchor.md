# `Plan.trackAnchor` の置き場と、anchor / node のモデル(未着手)

cf856b1 「計画アンカーの追随を PlanGuide.update の内部へ移す」の是正。

**行き先は `Plan` の内部を `data: {anchor, nodes} | null` にすること。**
`data !== null` ⟺ `nodes.length >= 1` を `Plan` 自身が守り、
`trackAnchor` も「凍結されていない anchor」も無くなる。
`Player.plan` は非 null の `Plan` のまま(`Player` に計画操作のメソッドは足さない)。
そこへ**4段階**で寄せる(§5)。

---

## 1. 観察の確認

前提はコード上そのとおりだった。順に裏を取る。

### 1-1. 空の計画の唯一の用途は、編集モードのクリック判定(と、そこから派生するアイコン)

- `PlanEditor.visiblePlan`(plan-editor.ts:808-811)は `editMode || nodes.length > 0` のときだけ
  計画を出す。編集モード ≡ マップビュー(`ViewManager.applyChrome` → `setMapMode`)。
- 空の計画の折れ線メッシュは**描かれない** — `PlanDisplay.sync`(plan-display.ts:116)が
  `path.setVisible(nodes.length > 0)`。ゴーストも出ない(`ghostAt` が `nodes.length === 0` で null)。
- それでも `path.sync` は毎フレーム呼ばれる。その理由は plan-display.ts:113-115 のコメントが
  自分で書いている — 「画面判定に使う project を毎フレーム更新しておかないと、クリック当たり
  判定が古い視点のまま行われてしまう」。
- クリック判定は `PlanPath.nearestSample` がメッシュではなく `arcs[i].samples` を走査する
  (plan-path.ts:256-270)ので、非表示でも当たる。

つまり **「ノードが空の計画」は、不可視の積分結果を1本だけ持ち、そこにクリック判定を
与えるためだけに存在している。** 指摘どおり。

補足が1点。**副産物としてアプシスアイコンとルーラー目盛も出ている。**
`apsisIconsOf`/`tickIconsOf`(plan-display.ts:189, 245)はノード数を見ずに
`path.finalSegment()`/`timeRange()` を読むので、空の計画でも自機の現在軌道の Pe/Ap ◇ と
暦目盛が出る。しかも ◇ は右クリックして「ここにノードを追加」できる被選択物
(`PlanDisplay.apsisMarkers` → `MapPicker`)なので、**ノードを1件も持たない状態から
ノードを置く主要な導線のひとつ**でもある。消してはいけない。

### 1-2. anchor は1つのフィールドで別種の2つを表している

| ノードの有無 | `_anchor` の中身 | 性質 |
|---|---|---|
| 1件以上 | 最初のノードを置いた瞬間の自機状態、または消化後の実到達状態 | 自機から引けない履歴データ。セーブ対象 |
| 0件 | `player.state` の毎フレームのコピー | 完全な導出値。情報量ゼロ |

後者は CLAUDE.md「悪いデータ構造」の
**「軽微な計算で求まるものをステートとして持っている」+「複数箇所が一定の整合性を保つことが
要求される」** に真正面から当たる。その整合性維持を毎フレームの `trackAnchor` 呼び出しに
外注しているから、「誰が呼ぶか」が問題になる。**呼び先を替えても漏れは残る。**

### 1-3. anchor を nodes 配列へ入れる案の棄却は妥当

挙げられた理由(描画されない/追随する/スラストではない)に加えて、コード上の非対称も揃っている:

- `buildSegments`(plan-path.ts:323-339)で node は「区間の終端 **かつ** 次区間の起点」だが、
  anchor は起点にしかならない。
- `PlanPath.arrivalStates()` は `nodeCount` 本しか返さない(anchor に到達状態は無い)。
- `PlanArc.represents` の `tracksLiveAnchor`(plan-arc.ts:204-215)は、anchor 起点の区間だけが
  毎フレーム起点を動かすことを前提にした専用の緩和判定。node 起点の区間には無い性質。

`nodeTimeRange` が `nodes[idx-1] ?? _anchor` と両者を「直前の状態」として同一視しているのは
**読みの統一**であって、格納の統一ではない。分けたままでよい。

---

## 2. いま実際に壊れているもの

置き場の議論とは別に、現行の「毎フレーム維持」から構造上こうなる、という点を2つ。
(いずれも実機では未確認。コードから言えることだけ書く。)

### 2-1. 非アクティブ艦の anchor は永久に初期値のまま

`trackAnchor` を呼ぶのは `PlanGuide.update`(plan-guide.ts:47)だけで、その引数は
`Game.player` = **アクティブ艦だけ**。CREATIVE で配置した非アクティブ艦の空の計画は、
`_anchor` が初期値 `kinematicState(0, v3(), v3())`(plan.ts:40)のまま残る。

その艦を操作対象にすると、`activePlayers.set` はポインタ処理(`Game.handlePointerInput`、
update の末尾)で走るので、次フレームの `guide.update` が追いつくまでの **1フレームだけ**
`buildSegments` は ECI 原点・速度ゼロの起点から `PlanArc` を組む。起点が地球内部なので
即 truncate されるが、その区間から `apsisIconsOf`/`impactIconsOf` が偽の ◇ / ✕ を出す。

**段階3(§5)で消える** — 起点が `ship.state` になり、古くなる余地が無くなる。

### 2-2. 呼び出し順の制約が2つの関数の間に生まれている

- `guide.update` は `advanceSimulation` の中(game.ts:279)、`editor.update` は
  その外(game.ts:220)。**ポーズ中は `advanceSimulation` ごと飛ぶので `trackAnchor` も止まる**
  が、`editor.update` は走り続ける。いまは simTime も止まるので実害は出ないが、
  「止めてよい更新」と「止めてはいけない整合性維持」が同じ関数に同居している。
- コミットが足したコメント「ノードの消化より後に置く」(plan-guide.ts:46)は、
  `consumeNodesUpTo` と `trackAnchor` の順序制約をコメントで守っている。
- `Player` のセーブ復元にも同型の順序トリックがある — 「trackAnchor はノードが空の間しか
  効かないため、ノード復元より先に呼ぶ必要がある」(player.ts:141)。
  **前版で「セーブが論点になる」と書いたのはこれが理由**だった — `trackAnchor` が復元経路の
  入口も兼ねていたので、消すなら代わりの入口が要る、というだけの話。§3-4 で消える。

---

## 3. `Plan` の新しい形

### 3-1. 中身

```ts
// 起点と、それに続く1件以上のノード。片方だけでは意味を持たないので1つの値にまとめる —
// ノードが尽きた計画は起点も持たない(空の計画の起点は自機そのものなので、計画側に持たせると
// 自機との整合性維持がそのまま漏れになる)。
interface PlanData {
  anchor: KinematicState;
  nodes: KinematicState[];   // 常に1件以上
}

export class Plan {
  // null ⟺ ノードが1件も無い。この対応を保つのは Plan 自身の責務。
  private data: PlanData | null = null;
  // data の外に置く: 空 ↔ 非空 をまたいでも単調に増えなければならない
  // (planSourceRevision がキャッシュ鍵に畳み込むので、作り直しで 0 に戻ると衝突する)。
  private _revision = 0;
}
```

**「凍結済みかつノード0件」という存在してはいけない値が、型から消える。**
前案(所有者参照を持って `_anchor ?? owner.state` を返す)では、その禁止が
`removeNode`/`clear`/`consumeNodesUpTo` の3箇所の作法にしか無かった。

### 3-2. メソッドごとの規則

| メソッド | 変更 |
|---|---|
| `get isEmpty(): boolean` | 新設。`data === null` |
| `get nodes()` | `data?.nodes ?? EMPTY`(モジュール定数の空配列。毎回新しい配列を返すと `PlanPath` 側の参照比較が効かない) |
| `get data()` | 新設。`{anchor, nodes}` の読み取り専用ビュー、または null。`anchor` を単体で公開すると読み手が `!` を書くことになるので、対で出す |
| `addNode(postState, from)` | **`from: KinematicState` を追加。**「計画がまだ無いときに起点として凍結する状態」= 自機の現在状態。既に `data` があれば使わない。時刻判定は `(this.data?.anchor ?? from).t` に対して行うので、判定式は1本のまま |
| `removeNode(idx)` | `idx === 0` なら `data = null` |
| `clear()` | `data = null` |
| `consumeNodesUpTo(t, actualState)` | 残りが0件なら `data = null`(`actualState` は捨てる — 空の計画に自前の起点は無い)。残れば `data = {anchor: actualState, nodes: 残り}` |
| `nodeTimeRange(idx, …)` | 戻り値を `TimeRange | null` へ。`data` が無ければ null(呼び出しは既存ノードのドラッグからだけなので、実際には常に非 null) |
| `replaceNode` / `applyNodeDv` / `firstNode` | `data` が無ければ null / undefined |
| `trackAnchor` | **削除** |
| `constructor(data?)` | `PlanData | null` を受け、`nodes.length === 0` なら `null` へ正規化する。**この正規化が、ノードが空の古いセーブをそのまま受けられる理由**でもある |

`Player` 側は `readonly plan = new Plan();` のまま。**計画操作のメソッドは1つも生えない** —
`Plan` を消したり作ったりするのは `Plan` 自身の中で完結する。

### 3-3. 外部の呼び出しがどうなるか

`plan.nodes` を読むだけの箇所(`PlanExecutor`・`CreativeStage`・`ViewManager`・`PlanGuide`)は
**無改修**。`nodes` は空配列を返すし、`firstNode()` は `undefined` を返す。

改修が要るのは3箇所だけ:

- `PlanEditor` の `addNode` 呼び出し2箇所(`handleMapClick` plan-editor.ts:339、
  `addNodeAt` plan-editor.ts:375)→ 第2引数に `ship.state` を渡す。
  段階2で `ship` が手元にあるので追加の配線は要らない。
- `PlanEditor.syncPanel`(plan-editor.ts:702)の `?? plan.anchor` → `?? ship.state`。
- `PlanEditor.dragNodeToNearestSample`(plan-editor.ts:419)の `nodeTimeRange(...)` が
  `null` を返しうるので `?? undefined`。

### 3-4. セーブは論点にならない

`PlayerSaveData.plan` は既に **`PlanSaveData | null`**(save-data.ts:82)、読み側も既に
`if (saved.plan)`(player.ts:139)。**型の変更は不要。**

- `serialize`: `const d = this.plan.data;` → `plan: d ? {anchor: …, nodes: d.nodes.map(…)} : null`
- 復元: `new Plan(saved.plan ? {anchor: …, nodes: …} : null)`
  (`PlanSaveData` は `{anchor, nodes}` で、`PlanData` と 1:1)

player.ts:141 の順序トリックのコメントごと消える。`plan.ts` から `save-data.ts` を
import してはいけない点(`game-entity/parts` 経由で THREE を引くので `test:physics` が壊れる)は
変わらないが、`Plan` のコンストラクタが受けるのは `PlanData` であって `PlanSaveData` ではないので、
`Player` 側で変換すればよく、依存は増えない。

---

## 4. 空の計画の表示・当たり判定をどこから出すか

`Plan` が空を表現できなくなるので、§1-1 の1本の区間の出所を決める必要がある。

### 4-1. いま採る形: `PlanPath`/`PlanDisplay` は `Plan` ではなく `(start, nodes)` を受ける

`buildSegments`(plan-path.ts:323-339)が必要としているのは `Plan` オブジェクトではなく
**起点1つとノード列だけ**。そこを引数にすれば、空の `Plan` を作らずに済む。

```ts
// PlanEditor.update — 起点をここ1箇所で解決する
this.planDisplay.update(ship.plan.data?.anchor ?? ship.state, ship.plan.nodes, displayWindow, provider);
```

- `PlanPath.update(plan, …)` → `update(start: KinematicState, nodes: readonly KinematicState[], …)`。
- `PlanDisplay.update(plan | null, …)` も同じ。フレームをまたいで持っている `this.plan` 参照
  (`nodes.length` を読むためだけの可変参照)は `nodeCount: number` で足りる。
- `PlanArc` は**無改修**。`tracksLiveAnchor` は `nodes.length === 0` のままで意味が変わらない。

**「凍結されていない anchor」は、どこにも保存されず、この1行で毎フレーム解決される導出値になる。**

### 4-2. 再積分のコストは「増えない」— ただし現状でも軽くはない

いま `trackAnchor(player.state)` は **`player.state` をそのまま(同一参照で)代入**している。
段階3 で渡すのも同じ `ship.state` なので、`PlanArc.represents` の
`state0 === this.state0` 判定にかかる値は**ビット単位で同じ**。作り直しの頻度は変わらない。

そのうえで現状の見積り(`PLAN_ARC_MAX_SAMPLES = 2000`、`PLAN_ARC_STEPS_PER_REV = 100`、
`PLAN_ARC_MAX_STEPS = 20000`):

| 表示期間 | サンプル間隔 = 区間長/2000 | 作り直しの間隔 | 1回の積分 step 数 |
|---|---|---|---|
| 1周(LEO ≈ 5580 s) | ≈ 2.8 s | 2.8 sim-s ごと | 100 |
| 28日(2.42e6 s) | ≈ 1210 s | 1210 sim-s ごと | 20000(上限に当たる) |

**×131072 ワープ + 28日表示では 1210 sim-s が1フレーム未満で過ぎるので、
毎フレーム 20000 step を積み直している。** これは今日そうなっているという話であって、
この変更で悪化も改善もしない。`PerfMeter` の「計画軌道」グループ(`planArcs`/`planSteps`)で
実測できるので、**着手前に一度ここを読んでおくとよい**(§7 の判断材料にもなる)。

### 4-3. §7(予測軌道の流用)を先にやる選択

「そもそも空の計画の区間は自機の予測軌道の二重計算では」という §7 を先に片付ければ、
4-1 の1行すら要らなくなる。ただし §7 には独立した難所があり(**アプシス検出**、§7 参照)、
段階3 の前提にするには重い。**4-1 を挟んでおけば、§7 は「その1行が指す先を差し替える」
という形で後から独立に入れられる**ので、順序は 4-1 が先でよい。

---

## 5. 手順

**段階1・2は単独で意味があり、悪化リスクが小さい。**

### 段階1 — `trackAnchor` の呼び出しを `PlanEditor` へ移す

cf856b1 の直接の取り消し。`PlanGuide` から anchor の話を剥がす。

- `PlanGuide.update` を `if (!player || editMode) return;` の素直な早期リターンに戻し、
  末尾の `plan.trackAnchor(player.state)` と順序コメント(plan-guide.ts:46-47)、
  クラス冒頭コメントの「計画が空の間のアンカー追従」を削除。
- `PlanEditor.update` の先頭で `ship?.plan.trackAnchor(ship.state)`。
  呼ぶ順は変わらない(`guide.update` が先に走って消化し、`editor.update` が追随する)。
- 文書: `DEVELOP/CALLSTACK.md:294` の位置を移す。CLAUDE.md の `PlanGuide` 記述から
  `trackAnchor` を落とす。

この段階では §2-1・§2-2 は残る。**責務の持ち主を正すだけ。**

### 段階2 — `PlanEditor.plan === null` から「艦不在」の意味を剥がす

`get plan(): Plan | null`(plan-editor.ts:95)はいま「艦がいない」だけを意味している。
段階3 で `ship.state` が要る箇所が増えるので、先に艦を前面へ出しておく。

- `private get ship(): Player | null { return this.activePlayers.current; }` を足し、
  `const plan = this.plan; if (!plan) return;` の形をすべて
  `const ship = this.ship; if (!ship) return;` + `ship.plan` へ書き換える。
  対象は `selectedNodeIdx` の getter/setter、`deleteNode`、`handleInput`、`clearPlanByKey`、
  `pickNodeAt`、`handleMapClick`、`isEmptyNode`、`removeSelectedIfEmpty`、`addNodeAt`、
  `dragNodeToNearestSample`、`rebuildDraggedNode`、`applyDv`、`setNodeDvLocal`、`nodeDv`、
  `update`、`sync`、`visiblePlan`、`onMapClosed` のおよそ20箇所。
  `handleMapPointer`(plan-editor.ts:274)だけは既に `activePlayers.current === null` を見ている。

純粋な書き換えで、振る舞いは1つも変わらない。

### 段階3 — `PlanPath`/`PlanDisplay` を `(start, nodes)` にする

§4-1。`PlanEditor` が `plan.anchor` と `plan.nodes` を渡すだけなので、**振る舞いは変わらない。**
ここで一度切って良い。`visiblePlan` は「艦がいて、かつ `editMode || nodes.length > 0`」の判定へ。

### 段階4 — `Plan` を `data | null` にする

§3 の全部。`trackAnchor` 削除、`addNode` に第2引数、`nodeTimeRange` を nullable、
コンストラクタで復元、`Player.serialize`/復元、`PlanEditor` の3箇所(§3-3)。

テスト:
- `tests/physics/plan.test.ts` — `new Plan(); plan.trackAnchor(state);` の2箇所を
  `new Plan({anchor: state, nodes: [node]})` へ。`nodeTimeRange(0, …)` を見るテストなので
  ノードが1件要る。**期待値の意味は変わる**(いまは「空の計画の起点=state から1周」、
  変更後は「凍結された起点 state から1周」)が、`nodeTimeRange(0)` は
  `nodes[-1] ?? anchor` = anchor を見るので**数値は同じ**。
- `tests/physics/plan-executor.test.ts` — `ship.plan.trackAnchor(ship.state)` 9箇所を削除し、
  直後の `addNode(x)` を `addNode(x, ship.state)` へ。`makeShip()` の
  `plan: new Plan()` は**そのまま**(参照の循環も2段組みも起きない)。

文書: `DEVELOP/CALLSTACK.md`(294 行、497/505-507 行の `tracksLiveAnchor` 説明)、
`DEVELOP/OWNERSHIP.md:287`(`Plan` の持ち主行)、CLAUDE.md の plan.ts / plan-guide.ts 記述。

各段階で `npm run typecheck` と **`npm run test:physics`**(`plan.ts` はテスト対象)。

---

## 6. 採らない案

- **(a) 呼び出し元を `PlanEditor` に移すだけで終わりにする** — 段階1として通るが終点にしない。
  毎フレームの整合性維持が残り、§2-1・§2-2 も残る。
- **(b) anchor を `nodes[0]` にする** — §1-3。棄却に同意。
- **(c) `Player.plan: Plan | null` にする** — 前版で推していた案。**採らない。**
  `Plan` を消しうる操作(`removeNode`/`clear`/`consumeNodesUpTo`)の呼び出し側が
  フィールドへ `null` を代入できなければならず、`Player` に4つの窓口を生やす形になる。
  `PlanEditor → Player → Plan` のたらい回しが1段増え、既にメソッドの多い `Player` が更に太る。
  **`data | null` は同じ不変条件を `Plan` の内側だけで達成する。**
- **(d) `Plan` が所有者(自機)への参照を持ち、`anchor` を `_anchor ?? owner.state` で返す**
  — 「凍結済みかつノード0件」が型に残り、禁止が3メソッドの作法に依存する。
  参照が循環し、`plan-executor.test.ts` の `makeShip()` が2段組みになる。
- **(e) 編集モードの間だけローカルに `Plan` を生成** — 最初のノードを置いた瞬間に艦へ
  昇格させる必要があり、同じものの表現が2つになる。§4-1 は「オブジェクトを作らず
  `(start, nodes)` を渡す」ので、この案の狙いを副作用なしに達成している。

---

## 7. その先: 空の計画の区間は、自機の予測軌道の重複では?

§1-1 の「空の計画が持つ不可視の1区間」は、**自機が既に持っている
`GameEntity.predictedTrajectory` と同じもの**を、別の積分器で2度目に計算している。

- どちらも「噴射なしでこの先どこへ行くか」。
- **期間も一致する。** `Predictor.update` の horizon は `DisplayWindow.duration`、
  `segmentDurationFrom` は `displayDuration.durationSec(その状態の公転周期)`。
  `'orbit'` プリセットではどちらも自機の1周、固定プリセットではどちらも同じ定数。
- 予測軌道のほうは**実線で描かれている**(`GameEntity.trajectoryLine`)。つまり
  空の計画の ◇ と目盛は、いま「描かれていない線」の上に載っていて、
  「描かれている線」とは別の積分結果を指している。
- §4-2 の「×131072 + 28日で毎フレーム 20000 step」は、予測軌道側なら
  `Predictor` の予算制で頭打ちになる。**性能面でも本命はこちら。**

一方、**難所は2つある。**

1. **アプシス検出の移設(これが本体)。** ◇ は `PlanArc` が積分中の step ペアから
   `apsisCrossing` で拾っている(plan-arc.ts)。`GameEntity.stepPredicted` にはその仕掛けが無く、
   間引き済みの `samples` を後から走査する方法は CLAUDE.md が明示的に否定している
   (衝突コースで偽の近地点を拾う)。**「予測軌道を流用する」の実体は
   「アプシス検出を予測軌道側へ移す」**であって、区間の差し替えではない。
   ◇ を出さない選択は取れない — §1-1 のとおり、◇ はノードを置く導線そのものだから。
2. **ノードを置ける範囲を予測の伸び具合に任せてはいけない。** 指摘のとおり。
   ただし「一周以上先に置けない」ではなく、**「置ける範囲が
   `segmentDurationFrom(ship.state, …)` で決まり、予測がどこまで伸びたかに左右されない」**
   と読むのが正確。今日の `PlanArc` はコンストラクタで終端まで同期積分するので範囲が安定して
   いるが、`Predictor` は予算制で少しずつ伸びるため、素直に繋ぐと置ける範囲がフレームごとに
   揺れる。`nearestSample` に渡す `TimeRange` を明示的にクランプすれば済む。

`PlanPath` が `PlanArc` 前提で組まれている点(`samples`/`at`/`end`/`endState`/`impactPoint`/
`periapsisPoint`/`apoapsisPoint`/`lastSteps` を要求する)も、区間の抽象を1枚挟む必要がある。
**段階4 とは別件**として扱う。

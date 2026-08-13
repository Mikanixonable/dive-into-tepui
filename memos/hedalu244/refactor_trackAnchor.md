# `Plan.trackAnchor` の置き場と、anchor / node のモデル(未着手)

cf856b1 「計画アンカーの追随を PlanGuide.update の内部へ移す」の是正。
結論から言うと **`trackAnchor` の呼び出し元を替えるのではなく、`trackAnchor` 自体を消す。**

---

## 1. 観察の確認

指摘の前提はコード上そのとおりだった。順に裏を取る。

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

ただし1点だけ補足がある。**副産物としてアプシスアイコンとルーラー目盛も出ている。**
`apsisIconsOf`/`tickIconsOf`(plan-display.ts:189, 245)はノード数を見ずに
`path.finalSegment()`/`timeRange()` を読むので、空の計画でも自機の現在軌道の Pe/Ap ◇ と
暦目盛が出る。これは偶然というより実用的な帰結で(◇ を右クリックして「ここにノードを追加」
できる)、消してはいけない。

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

**参照注入(§3)にすると、この状態自体が存在しなくなる** — 艦がいる限り anchor は常に正しい。

### 2-2. 呼び出し順の制約が2つの関数の間に生まれている

- `guide.update` は `advanceSimulation` の中(game.ts:279)、`editor.update` は
  その外(game.ts:220)。**ポーズ中は `advanceSimulation` ごと飛ぶので `trackAnchor` も止まる**
  が、`editor.update` は走り続ける。いまは simTime も止まるので実害は出ないが、
  「止めてよい更新」と「止めてはいけない整合性維持」が同じ関数に同居している。
- コミットが足したコメント「ノードの消化より後に置く」(plan-guide.ts:46)は、
  `consumeNodesUpTo` と `trackAnchor` の順序制約をコメントで守っている。
- `Player` のセーブ復元にも同型の順序トリックがある — 「trackAnchor はノードが空の間しか
  効かないため、ノード復元より先に呼ぶ必要がある」(player.ts:141)。

**これらの順序制約は全部、§3 で消える。**

---

## 3. 是正案(推奨): anchor を「凍結されていれば凍結値、されていなければ自機の現在状態」にする

### 3-1. 不変条件

> **`_anchor !== null` ⟺ `_nodes.length > 0`**

これは新しい規則ではなく、**いまの振る舞いをそのまま状態として言い直したもの**。
`trackAnchor` が「ノードが無い間だけ効く」ため、ノードが尽きた計画の凍結値は
次フレームに必ず上書きされる = 事実上捨てられている。

### 3-2. 形

`plan.ts` は `tsconfig.test.json` の `include` に直接載っている(DOM/THREE を引けない)ので、
`plan-executor.ts` の `PlanExecutorShip` と同じ手で、必要な部分だけの構造的インターフェースを
**このファイル内に**置く(import を1つも増やさない)。

```ts
// 起点を凍結していない間、計画の起点として読む自機。
export interface PlanOwner {
  readonly state: KinematicState;
}

export class Plan {
  private _nodes: KinematicState[] = [];
  // ノードを置いた時点で凍結される。ノードが1件も無い間は凍結しておらず null。
  private _anchor: KinematicState | null = null;

  constructor(private readonly owner: PlanOwner) {}

  // 計画の起点状態。凍結前は自機の現在状態そのもの。
  get anchor(): KinematicState { return this._anchor ?? this.owner.state; }

  // 起点を凍結済みか(= 自機を追わない起点を持っているか)。
  get anchorFrozen(): boolean { return this._anchor !== null; }
}
```

- **`anchor` ゲッターの signature は変わらない。** `buildSegments`(plan-path.ts:325)、
  `nodeTimeRange`(plan.ts:124)、`syncPanel`(plan-editor.ts:702)は無改修。
- `addNode`: 空のときだけ `_anchor = this.owner.state` を凍結してから追加。
  下限判定 `postState.t <= this.anchor.t` はそのまま(いまも anchor は毎フレーム
  `player.state` なので、判定値は同一)。
- `removeNode` / `clear` / `consumeNodesUpTo`: ノード列が空になったら `_anchor = null`。
  private ヘルパ1つに寄せて、3箇所が個別に忘れられないようにする。
- **`trackAnchor` は削除。**

`Player` 側は `readonly plan = new Plan(this);`(player.ts:79 の1文字追加)。
`Player` は構造的に `PlanOwner` を満たすのでキャスト不要。フィールド初期化子で `this` を
渡すのは、`Plan` のコンストラクタが `owner.state` を**読まない**ので安全。

### 3-3. なぜ参照注入か(引数スレッディングでなく)

`anchor` の読み手は `buildSegments`(PlanPath 経由)・`nodeTimeRange`・`addNode`・`syncPanel`
の4箇所ある。全部に自機状態を引き回すと、「Plan は自機を知らない」という**見かけ上の**
独立性のために4本の signature が汚れ、さらに `PlanEditor` 側と `Plan` 側が起点について
別々の答えを持ちうる状態が生まれる。実際には `Plan` は `Player` が所有し `Player` の寿命の
中でしか存在しないので、そもそも独立していない。`/refactor-fixed` が禁じているのは
クロージャ注入で、参照注入は推奨されている側。

### 3-4. セーブ

`save-data.ts` は `game-entity/parts` / `game-entity/enemy` を import しており THREE を引くので、
**`plan.ts` から import してはいけない**(`test:physics` のコンパイルが壊れる)。
`serialize` は `Player` に置いたまま、`Plan` 側は `anchorFrozen` と(必要なら)
`frozenAnchor: KinematicState | null` を公開して、`Player.serialize` が

- ノードが空 → `plan` フィールドごと保存しない(`saved.plan` は既に optional、player.ts:139)
- ノードがある → 従来どおり `anchor` + `nodes`

とする。復元側は `PlanSaveData.anchor` を先に凍結してからノードを積む必要があるので、
`trackAnchor` の代わりに **明示的な復元入口**を1つ用意する。CLAUDE.md の
「セーブを持つクラスは saved を**コンストラクタ引数**で受ける」に合わせるなら
`new Plan(owner, saved?)`。`Player` は `plan` をフィールド初期化子ではなく
コンストラクタ本体で `this.plan = new Plan(this, saved?.plan)` と組む
(`readonly plan: Plan;` の宣言だけ残す)。復元時も §3-1 の不変条件は `Plan` 自身が守る
(ノードが空なら渡された anchor は無視する)ので、古いセーブとの互換も自動的に取れる。

### 3-5. PlanGuide が元に戻る

```ts
update(player: Player | null, simTime: number, editMode: boolean, attractors: readonly Attractor[]): void {
  if (!player || editMode) return;
  ...
}
```

素直な早期リターンに戻り、コミットが足した順序コメントも消える(**順序制約自体が無くなる**)。
クラス冒頭のコメントから「計画が空の間のアンカー追従」も削る。

### 3-6. 影響範囲

| ファイル | 変更 |
|---|---|
| `src/game/plan/plan.ts` | `PlanOwner` 追加、`_anchor` を nullable、`anchor`/`anchorFrozen`、`trackAnchor` 削除、空になったら null に戻す private ヘルパ、復元入口 |
| `src/game/player/player.ts` | `new Plan(this, saved?.plan)`、復元の順序トリック削除、`serialize` は空なら plan を出さない |
| `src/game/save-data.ts` | `PlanSaveData` はそのままでよい(空の計画を保存しないので `anchor` は常に凍結値) |
| `src/game/plan/plan-guide.ts` | `trackAnchor` 呼び出し削除、早期リターンへ、冒頭コメント修正 |
| `src/game/plan/plan-path.ts` | `tracksLiveAnchor` を `plan.nodes.length === 0` から `!plan.anchorFrozen` へ(意味は同じだが、判定したい性質そのものを読む) |
| `tests/physics/plan.test.ts` | `new Plan()` + `trackAnchor(state)` → `new Plan({ state })` の2箇所 |
| `tests/physics/plan-executor.test.ts` | `makeShip()` を2段組みへ(§3-7)。各テストの `ship.plan.trackAnchor(ship.state)` 9箇所を削除 |
| `DEVELOP/CALLSTACK.md` | 294行の `player.plan.trackAnchor(...)` を削除。497/505-507 行の `tracksLiveAnchor` の説明を言い換え |
| `DEVELOP/OWNERSHIP.md` | 287行の `Plan` の行に「起点は凍結前は自機を読む」を反映 |
| `CLAUDE.md` | plan.ts / plan-guide.ts の記述から `trackAnchor` を削除 |

検証は `npm run typecheck` と **`npm run test:physics`**(`plan.ts` はテスト対象)。

### 3-7. この案の唯一の代償

`tests/physics/plan-executor.test.ts` の `makeShip()` はオブジェクトリテラル1発で
`state` と `plan: new Plan()` を同時に書いているので(plan-executor.test.ts:14-28)、
参照が循環して2段組みになる:

```ts
function makeShip(): PlanExecutorShip {
  const ship = { state: kinematicState(0, v3(1e7, 0, 0), v3(0, 7000, 0)), /* ... */ } as PlanExecutorShip;
  // 計画は起点として自機を読むので、艦を組んでから差し込む。
  (ship as { plan: Plan }).plan = new Plan(ship);
  return ship;
}
```

テストヘルパ1箇所の一度きりのコストで、本番コードには波及しない。
これが気になるなら §4 の代替案(e)。

---

## 4. 採らない案

- **(a) 呼び出し元を `PlanEditor` に移すだけ(最小案)** — 毎フレームの整合性維持は残り、
  §2-1 の非アクティブ艦の問題も残る(`PlanEditor` もアクティブ艦しか見ない)。
  「漏れた責務の持ち主を替える」だけで漏れは塞がらない。
- **(b) anchor を `nodes[0]` にする** — §1-3。棄却に同意。
- **(c) 空の計画を `Player.plan: Plan | null` にする** — 迷っていた案。採らない。
  - 「誰が null に戻すか」を消化側3箇所(`PlanGuide.notifyAchieved` / `PlanExecutor.finish` /
    `CreativeStage.applySimulationEvents`)に負わせることになる。いま `consumeNodesUpTo` が
    1関数で守っている不変条件が、呼び出し側3箇所の作法へ散る。
  - `ship.plan.firstNode()` を無条件で呼べていた箇所(plan-executor.ts:78/167/212、
    creative-stage.ts:325/339)が全部 `?.` になる。
  - `PlanEditor.plan` の `null` は既に「**艦がいない**」を意味している(plan-editor.ts:95)。
    ここに「艦はいるが計画が無い」を重ねると、`if (!plan) return` が何を弾いているのか
    読めなくなる。
  - **感じていた「ぎこちなさ」の原因は空の `Plan` の存在ではなく、それが *凍結されていない
    anchor を保持していること* だった。** §3 でそこが消えるので、`Plan` を null にする理由も消える。
    「ノードが0件の計画」は「マニューバの予定が無い」という真っ当な値で、`Player` が
    恒久的に1つ持っていて構わない。
- **(d) 編集モードを開いている間だけローカルに `Plan` を生成** — 最初のノードを置いた瞬間に
  艦へ昇格させる必要があり、同じものの表現が2つになる。また `PlanArc.represents` は
  `plan.revision` と `state0` の参照同一性でキャッシュを効かせている(plan-arc.ts:208-214)ので、
  毎フレーム作り直すオブジェクトとは相性が悪い。
- **(e) 参照でなく引数で渡す(`anchorFrom(live)` / `addNode(post, live)` / `nodeTimeRange(idx, live, ...)`)**
  — §3 と等価な効果は得られる。`PlanDisplay.update` / `PlanPath.update` / `buildSegments` の
  3本にも起点を通すことになるが、「この区間はここから始まる」が隠れた読みでなく引数になる、
  という利点はある。**§3 が嫌なら次点。**§5 に進むなら、どちらも同じだけきれいに剥がせる。

---

## 5. その先(この変更では触らない): 空の計画の区間は、自機の予測軌道の重複では?

§1-1 で確かめた「空の計画が持つ不可視の1区間」は、**自機が既に持っている
`GameEntity.predictedTrajectory` と同じもの**を、別の積分器で2度目に計算している。

- どちらも「噴射なしでこの先どこへ行くか」。
- 期間もほぼ一致する。`Predictor.update` の horizon は `DisplayWindow.duration`、
  `segmentDurationFrom` は `displayDuration.durationSec(その状態の公転周期)` で、
  `'orbit'` プリセットでは同じ「1周」に落ちる。
- 予測軌道のほうは**実線で描かれている**(`GameEntity.trajectoryLine`)。つまり
  空の計画のアプシス ◇ と目盛は、いま「描かれていない線」の上に載っていて、
  「描かれている線」とは別の積分結果を指している。

素直に考えると、**ノードが1件も無い間のクリック判定・◇・目盛は、自機自身の予測軌道の上で
やるべき**で、そうすれば `Plan` に「凍結されていない anchor」という概念自体が要らなくなる
(`anchor: KinematicState` が非 null に戻り、`PlanOwner` も消える)。

ただし未検証の懸念がいくつかある:

- `Predictor` は予算制で少しずつ伸びる。`PlanArc` はコンストラクタで同期的に終端まで
  積分する。**配置直後の艦では、予測がまだ届いていない遠方に1件目のノードを置けなくなる。**
- `PlanPath` の表示座標 bake/un-bake・遮蔽・tie-break は `PlanArc` 前提で組まれている。
  予測軌道を「区間」として受けられる形に一般化する必要がある。
- ◇ の検出は `PlanArc` が積分中の step ペアから拾っている(`apsisCrossing`)。
  予測軌道側には同じ拾い方が無い。

規模が違うので**この変更セットではやらない**。ただ、`trackAnchor` を消したあとに残る
`PlanOwner` は、この方向へ進むときちょうど削除される1個の依存なので、
向かう先として覚えておく価値はある。

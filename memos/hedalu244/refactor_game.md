# game.ts のリファクタリング

目標は3つ。**モジュール疎結合・`game.ts` からのロジック排除・可読性。**

---

## 0. 判断の原則

**下位が自決できるようにフラグを持たせ、呼び出しガード不要で呼べるようにする。**
ただし**下位が責務外のことまで気にしてガードするのは責務分割の失敗**なので、それが避けがたい
ときだけ `Game` に残す。残すなら理由を言えること。

`if`(三項・`??`・`&&` を含む)は3種類に分けて扱う。

### (a) 判断の合成 — 無条件で移す

複数モジュールの値を組み合わせて**新しい判断を作っている**もの、および**他モジュールが読む値を
組み立てている**もの。`/refactor-fixed` 1節に真正面から反する。

### (b) 単純な呼び出し可否 — 受け手へ寄せる

フラグを1つ読んで呼ぶ/呼ばないを決めるだけのもの。**受け手が判定に要る値を毎フレーム引数で
受け取れるなら、受け手の先頭で早期 return させる**(`/refactor-fixed` 21bis)。
受け手が参照ごと持つのは、**フレームの流れの外**(DOM イベント)で使う場合だけ
(`/refactor-fixed` 7節) — 保持させると層の逆転(simulation → camera など)を招く。

### (c) 決着(`isPlaying`)による分岐は、まず存在意義を疑う

`/refactor-fixed` 21節のとおり、**一般形は「自機0..n隻・勝敗なし」で、攻略ステージのほうが
その特殊化**。決着後という極めて特殊な場面のためだけに立っている分岐は、移す前に消せないか見る。

---

## 1. ユーザー判断待ち

### 1-1. 決着後、自機は動くが敵は止まる非対称

自機側の `isPlaying` ゲート(`behave`・RCS 演出・ポインタ配分)は撤廃済みで、決着後も操縦できる。
一方、**各具象ステージの `update` は自分で `if (!this.isPlaying || !player) return;` を持ったまま**
なので、決着後は敵が行動せず補給も湧かない。結果として「自機だけ動き、世界は止まる」状態になる。

判断が要る: この非対称を許容するか、具象ステージ側の自決ガードも外して世界ごと動かし続けるか。

- 外す場合、`Stage.update` の中で `isPlaying` を見ているのは敵の行動・補給・タイマー・波の生成で、
  これらが決着後も走ると stage00 は無限に波を出し続ける。ステージごとに意味が違うので、
  一括で外せる類ではなく1ステージずつ判断することになる。
- 許容する場合、`isPlaying` は「ステージの進行を止める」意味に純化され、
  `Game` 側には一切現れないという整理になる(現状がすでにその形)。

### 1-2. `DisplayWindowManager.resolve` が1フレームに3回

`update` 冒頭・`advanceSimulation` の積分後・`sync` 冒頭の3箇所で `resolve(simTime, player)` を
呼び、`Game` が「いつ確定させるか」を決めている。クラス側は
`(simTime, player, player.state の同一性, revision)` でキャッシュしているので、
**`Simulator` と `ActivePlayerController` の参照を持てば `current` を遅延ゲッターにでき、
3つの `resolve` 呼び出しは丸ごと消える。**

ただし CLAUDE.md は「参照を持たず引数で受け取る」ことを意図的な設計として明記している。
参照2つはどちらも既に他モジュール(`PlanEditor` など)が持っているものなので、
層の逆転にはならない。

---

## 2. 未着手

### 2-1. 下位へ寄せられるもの

| 箇所 | 移し先と方法 | 依存 |
|---|---|---|
| `sync` の `overviewMode ? mapPicker.visibilityPolicy : null` | `MapPicker.refresh` は `!overviewMode` で早期 return するが、`_visibilityPolicy` を**前フレームの値のまま残す**。return の前に `null` を代入すれば、`Game` は `mapPicker.visibilityPolicy` を素通しできる | なし |
| `render` の `if (viewManager.current === 'dock')` | `Game` が `ViewId` のリテラルと比較しているのが判断。`ViewManager` に `rendersWorld: boolean` を持たせて `if (!viewManager.rendersWorld) return;` にする | なし |
| `advanceSimulation` の `if (player) player.plan.trackAnchor(player.state)` | 直前の `guide.update(player, ...)` は既に `Player \| null` を受けて自決している。「毎フレーム計画を飛行中の艦に追随させる」は `PlanGuide` の責務そのものなので、`trackAnchor` をその中の末尾へ移す。`if` と「trackAnchor より前に置く」という順序コメントの両方が消え、順序が内部で保証される | なし |
| `handleInput` の `simSpeedManager.handleInput(input, isPlaying, editMode, plan?.firstNode(), simTime)` | 引数4つの中継。`[N]`(次ノードへ自動ワープ)は計画編集の操作で、`PlanEditor` は `simSpeedManager` も `plan` も `editMode` も既に持っている。`PlanEditor.handleInput` へ移せば `simSpeedManager.handleInput(input)` は `,`/`.` だけになる。**`Game` に残る最後の `isPlaying` 参照でもある** — 1-1 の判断次第でこの引数自体が消える | 1-1 の判断 |
| `handlePointerInput` の `if (editor.editMode)` / `else` | 各受け手(`MapPicker` の4メソッド・`PlanEditor.handleMapPointer`・`NavTarget.updateCombatBasePicking`・`Targeter.updateCombatTargeting`)が `overviewMode` を毎フレーム引数で受けて自決。`if/else` が消え、呼ぶ順序だけが残る。**`MapPicker` だけは `game` 経由で自力到達できてしまうが、それは使わない(2-2)** | 2-2 |

### 2-2. `MapPicker` と `Docking` が `Game` そのものを保持している — 逆流

`src/game/` 配下で `Game` 型を import しているのは `map-picker.ts` / `docking.ts` /
`hud/panel.ts` の3つ。このうち `HudPanels` は `/refactor-fixed` 12節が明示的に許した例外
(条件は「**全情報を集約表示することそのものに価値があり、表示専用であること**」)。
残る2つは条件を満たしていない。

- **`MapPicker`** … `game` 経由で `frameControls` / `player` / `activePlayers` / `activeStage` /
  `cameraSystem` / `simTime` の6つへ到達(21箇所)。`activePlayers.set/remove` も
  `frameControls.setFocus` も `authoring.openShipPlacer` も呼ぶので**表示専用ではない**。
  しかも `cameraSystem` は**コンストラクタ引数として直接も保持している**のに、
  配置UIを開く箇所だけ `this.game.cameraSystem` 経由で読んでおり、同じものへの経路が2つある。
- **`Docking`** … `game` 経由で `pause()` / `resume()` / `isPaused` / `player` /
  `activePlayers` / `activeStage` へ到達。**このうち `pause`/`resume`/`isPaused` だけは正当** —
  それらは `/refactor-fixed` 1節が `Game` に置くことを認めた `Game` 自身の状態なので、
  到達するには `Game` を持つしかない。残り3つは直接参照にできる。

この逆流があるせいで「ガードを `MapPicker` へ寄せる」が技術的には常に可能に見えてしまうが、
それは**逆流を深めるだけで疎結合にはならない**。2-1 のポインタ配分も、`game` 経由ではなく
毎フレーム引数で受ける形にする。**2-1 のポインタ配分より先に着手するのが望ましい。**

**提案: `game: Game` を、実際に使っている参照へ分解する。**
`player` は `activePlayers.current`、`simTime` は既に引数で受け取っている
`displayWindow.simTime` / `sync(simTime, ...)` から引ける。`MapPicker` は `game` を丸ごと落とせ、
`Docking` は `pause`/`resume`/`isPaused` のためだけに残る(**それが正当な唯一の理由**であることを
コメントに書く)。`game.ts` の行数は減らないが、**`Game` を「ほぼ誰も参照しないオーケストレータ」に
保つ**ための残作業。

---

## 3. `Game` に残すもの(理由を言えること)

残った `if` を判断するための基準表。**論点ありの2件は判断待ち**、それ以外は理由が言える。

| 箇所 | 理由 |
|---|---|
| `_isPaused` / `pause()` / `resume()` / `if (!_isPaused) advanceSimulation(dt)` | `/refactor-fixed` 1節が明示的に許した例外。ポーズを `SimSpeedManager` の `simSpeed = 0` へ寄せるのは筋が悪い(`SIM_SPEED_LEVELS` は離散段で 0 を表現できず、ポーズと相互作用の閾値は別の関心事 — 8節) |
| `_isPaused && hud.modalController.isOpen` | `Game` 所有の `_isPaused` と `Hud` 所有の `isOpen` を跨ぐ単純な AND。**論点あり**: 全画面のモーダルが自分でポインタを消費すれば、この AND 自体が要らなくなる。ポーズ経路は「設定パネル/一覧を開いた(=モーダル)」か「ドック」しかないので、両者の実効差を確認する価値はある |
| `Predictor.update(..., overviewMode ? 'map' : 'combat')` | `Predictor` は simulation 層。`CameraSystem` を持たせると層の逆転。`mode` は「予測対象範囲と予算」という `Predictor` 自身の語彙で、`overviewMode` とはたまたま連動しているだけの別概念(8節) |
| `Player.behave` の `mapMode` / `dvEditActive` | `Player` は複数並存する汎用エンティティで、view 層への参照を一切持たない。view 由来の値は毎フレーム引数で渡す(7節) |
| `player?.state.v ?? v3()`(`FloatingOrigin` の速度基準) | ゼロが「基準なし」の単位元として意味を持つ(位置の `?? null` とは別、21bis) |
| `player?.state.r ?? null`(`syncMarkers` / `applyVisibility` の viewerPos) | **意味のある null**。`EntityMarker.sync` は有無でラベルを変える |
| `if (player) touchControls?.syncModeButtons(...)` | `TouchControls` は `Player` 型から疎結合に保たれている(プリミティブ3つを受ける)ので自決できない。**論点あり**: 艦がいないときに前の艦のモード表示が凍結して残る。本来は仮想パッドごと畳むべきで、それは `ViewManager.applyChrome` の側の話 |
| `initialSave ? {saved} : {…}` 系の判別共用体 | `/refactor-fixed` 13節の模範例そのもの |
| `initialSave?.camera?.view` → `ViewManager` へ | 21節「起動時の状態は、モードではなく状態から導く」の模範例 |
| `TouchControls.isTouchDevice() ? … : null` | Null Object 化するとコンストラクタが DOM を `document.body` へ足す副作用を持つため空実装クラス+インターフェースが要り、現状の1行より複雑になる |

---

## 4. 進め方

| Step | 内容 | 節 | 依存 |
|---|---|---|---|
| A | `MapPicker.refresh` の早期 return で `_visibilityPolicy = null` → `sync` の三項を消す | 2-1 | なし |
| B | `render` を `viewManager.rendersWorld` へ | 2-1 | なし |
| C | `trackAnchor` を `PlanGuide.update` の末尾へ | 2-1 | なし |
| D | `MapPicker` / `Docking` の `game: Game` を実参照へ分解 | 2-2 | なし |
| E | ポインタ配分の受け手に `overviewMode` を渡して自決させ、`handlePointerInput` を平坦化 | 2-1 | D |
| F | `[N]`(次ノードへ自動ワープ)を `PlanEditor.handleInput` へ | 2-1 | 1-1 の判断 |

`for` 文と違い `if` はゼロにはならないし、するべきでもない —
**残った `if` が「なぜ `Game` にあるのか」を全部言えることがゴール。**

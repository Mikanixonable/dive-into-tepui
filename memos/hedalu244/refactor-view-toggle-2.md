# ビュー分離の第二段階 — ビュー専用コードの下ろしと ViewManager の再設計

作業ブランチ `refactor-view-toggle`。コード計測はすべて **0b5ec0c4** 時点。

## 目的

第一段階でフレーム処理は CombatView / MapView へ割れたが、**モジュールの生成・保持と入力・遷移の
責務はまだ Game と ViewManager に残っている。** 現状の問題:

1. **受け手の自ゲートが2箇所残っている。** PlanGuide は `editMode`(= マップビュー)で、
   DockingGuide は `viewManager.isCombatView` で毎フレーム自分をゲートしており、第一段階が
   消したはずの「呼び先が自分のビューを確認する」形が残存している。
2. **PlanEditor(720行)にビュー分岐が同居している。** `editMode` による分岐が 6箇所
   (handleInput ×2・dvEditActive・handleMapPointer・sync・displayedPlan)あり、
   [N]/[Del] のビュー別挙動がこの分岐の中に埋まっている — 第一段階の手順1で復旧した回帰
   (ff17e7ee)は、まさにこの構造が生んだもの。
3. **ビュー専用モジュールを Game が生成・保持している。** editor / guide / dockingGuide /
   combatView / mapView が Game のフィールドで、Game の import は 56 行・フィールドは約 30 個
   に達している。
4. **ViewManager が遷移の中身(enterMap / leaveMap)を自分で持つ**ため、editor と mapActions
   に依存している。「そのビューに入れるか」「入るとき・出るときに何をするか」はビュー固有の
   知識なのに、ViewManager に集約されている。

修正後に期待される状態: ビュー固有の生成・保持・遷移フック・キー入力は CombatView / MapView が
持ち、ViewManager は「どのビューか」の正本と2ビューの保持・遷移の駆動だけを持ち、Game は共通
フレーム処理と配線だけになる。`editMode` という語彙が src/ から消える。

## 決めたこと

覆すときは、右端の手順が変わる。

| # | 決定 | 根拠 | 覆すと変わる手順 |
| --- | --- | --- | --- |
| D1 | ViewManager の再設計は**両案の合成**: 遷移フック(canEnter / onEnter / onLeave)は各ビューの実装へ下ろし、**2ビューのインスタンスは ViewManager が保持**して `activeView` を出す | 「フックを下ろすだけ」だと ViewManager に editor / mapActions 依存が残る。「保持だけ下ろす」だと遷移の中身が ViewManager に残る。合成すると依存が使用箇所へ寄り、Game のフィールド2つと activeView getter が消え、ドッキング等の**強制遷移でも後始末が漏れない**(setView が常にフックを通る) | 手順1以降すべて |
| D2 | PlanEditor は**丸ごとは下ろさない**。共有部(計画折れ線の駆動・growableArcs・操作艦の赤道交点)を **PlanTrajectory** として抽出して Game 常駐、残る編集部(ギズモ・パネル・ポインタ・Δv)を MapView 保持へ | 計画折れ線は戦闘ビューでも描く(計画どおりに機体を動かすのは戦闘ビュー)、predictor は両ビューで growableArcs を読む。**丸ごと MapView 案は再提案しない** — 戦闘の [N]/[Del]/折れ線が死ぬ。第一段階で一度死んだ回帰そのもの | 手順3 |
| D3 | [N]/[Del] の戦闘側挙動(計画全破棄・直近ノードへの自動ワープ)は **CombatView が直接持つ**(plan / simSpeedManager / hud を触る十数行)。編集側([Del]=選択ノード削除・WASDQE Δv)は PlanEditor に残り MapView.handleInput から呼ぶ | 目的は editMode 分岐の削除。戦闘側を editor のメソッドとして残すと CombatView→(マップ専用の)editor という逆向き依存になる | 手順3 |
| D4 | PlanGuide.update は advanceSimulation 内から **CombatView.update へ移す**。ポーズ中・決着後も呼ばれるようになるが、simTime が進まない限り消化(consumeNodesUpTo)も通知も冪等 | 厳密に「積分した時だけ」を保つにはビューに積分フェーズのフックを1本足すことになり、利用者1つのための口は過大 | 手順4 |
| D5 | chrome(hud.setWorldView / touch / panel-shell / displayWindow.forceCurrent)は **ViewManager.applyChrome に残す** | ビュー id を対称に配るだけの配線で、ビュー固有の判断を含まない。「同一ビューへの setView でも chrome は揃う」保証も1箇所で保てる | 手順1 |
| D6 | Docking の viewManager 依存は **`setView: (view: WorldView) => void` 閉包**に置き換える | 生成順の循環(docking→ViewManager→CombatView→DockingGuide→docking)を断つ。CameraSystem の view 閉包と同型の既存パターン | 手順1 |
| D7 | interface 名は **WorldViewFrame のまま**とし、遷移フックを含む旨をコメントへ書く | 素直な名は WorldView だが id 型(`'combat' \| 'map'`)が既に約40出現で流通しており、入れ替え改名は churn が大きい | 手順1(改名のみ) |
| D8 | mapPickables / mapActions / frameControls / navball / displayWindowManager は**下ろさない**(両ビューが読む・書く・開く)。linePickables だけ保持を MapView へ移し、combat 側の毎フレーム clear()(mapPickables 含む)は **MapView.onLeave の1回**に置き換える | mapPickables は cameraSystem.update・viewBadge・sync の可視性ポリシーが両ビューで読むため Game 常駐。clear は「マップで組んだものを出るとき壊す」が意味の実体 | 手順5 |

## 達成目標

1. game.ts に `editor` / `guide` / `dockingGuide` / `combatView` / `mapView` のフィールドと
   `activeView` getter が無い(game.ts 内 grep で 0件)。
2. `grep -rn "editMode" src/` が **0件**(現在 plan-editor 10・plan-guide 4・game 2)。
3. `grep -n "viewManager" src/game/docking/docking-guide.ts` が **0件**。
4. view-manager.ts に `PlanEditor` / `MapContextActions` の import が無い。
5. `grep -rn "setControlledBaseProvider" src/` が **0件**。
6. game.ts 内の `isMapView` が **0件**(現在 2件: editor 閉包・activeView getter)。
7. 各手順で `npm run typecheck`(ヒープ拡大)と `npm run test:game` が通る。
8. 挙動不変の実機確認(手順6のヘッドレスバッチ): 戦闘 [N] hint・マップ編集一式
   (ノード配置→ドラッグ→Δv→右クリックメニュー)・[M]往復・ドッキングガイドが戦闘のみ表示・
   戦闘右クリック→フォーカス移動、いずれも実行時例外 0。
9. **第一段階から引き継ぐ手動確認**(ユーザーの実機。本計画の確認と併せて消化する):
   戦闘 [Del] 破棄 hint / 戦闘右クリック→「フォーカスを移動」/ ドラッグ・ズームの操作感
   (感度 0.0015)/ マップで機体へ 12 m ズーム+[G] / 切替・リセット・再ロードで視点が
   跳ばない / 撃破時に視点が留まる / 旧セーブのロード。

## 手順

### 手順1. ViewManager がビューを保持し、遷移フックを各ビューへ下ろす

**目的**: 遷移の可否・支度・後始末をビュー自身の知識にし、ViewManager から editor / mapActions
依存を消す。Game から combatView / mapView フィールドと activeView getter を消す。
**この時点で挙動は変えない。**

新しい契約:

```ts
// world-view.ts — フレーム処理+遷移フックの口
export interface WorldViewFrame {
  canEnter(): boolean;          // このビューへ遷移できるか
  onEnter(): void;              // 入るときの支度(実遷移時のみ。構築時の初期ビューでは呼ばない)
  onLeave(): void;              // 出るときの後始末(実遷移時のみ)
  handlePointer(simTime: number): void;
  update(displayWindow: DisplayWindow): void;
  syncLabels(): void;
  syncPanels(displayWindow: DisplayWindow): void;
}

// view-manager.ts
constructor(
  hud: Hud, touchControls: TouchControls | null, displayWindow: DisplayWindowManager,
  activePlayers: ActiveControllableController,
  views: Record<WorldView, WorldViewFrame>, requestedView?: WorldView,
)
get activeView(): WorldViewFrame
```

| ファイル | 何をするか |
| --- | --- |
| src/game/world-view.ts | canEnter / onEnter / onLeave を追加、コメントを「フレーム処理+遷移フック」へ |
| src/game/view-manager.ts | ctor を上記へ。editor / mapActions / Base import 削除。enterMap/leaveMap を prev.onLeave() / next.onEnter() へ置換。canEnter(v) → views[v].canEnter()。[M] ヒントの nodeCount は `activePlayers.currentControllable?.plan.nodes.length` から。setControlledBaseProvider 削除。activeView getter 新設 |
| src/game/combat-view.ts | `player` 閉包を `activePlayers: ActiveControllableController` に置換(current が同値)。canEnter = `current !== null \|\| controlledBase !== null`。onEnter / onLeave は空実装 |
| src/game/map-view.ts | `player` 閉包を同様に置換。canEnter = true。onEnter = `editor.selectedNodeIdx = null`。onLeave = editor.onMapClosed + editor.closeMenu + mapActions.close |
| src/game/game.ts:248-275 | 生成順を「combatView / mapView → viewManager」に並べ替え、フィールド combatView / mapView と activeView getter(:330-332)を削除して `viewManager.activeView` 参照へ。setControlledBaseProvider 呼び出し削除 |
| src/game/docking/docking.ts:76,276,331 | ctor の `viewManager: ViewManager` を `setView: (view: WorldView) => void` に置換(D6)。game.ts から `(v) => this.viewManager.setView(v)` を渡す |

**達成条件と検証**: `npm run typecheck`・`npm run test:game`。grep: 達成目標4・5が0件。
`npm run dev` で creative がマップ開始・攻略ステージが戦闘開始になること、[M] 往復と
「操作できる艦または基地がいません」(艦なし creative で [M])を確認。

### 手順2. DockingGuide を CombatView へ下ろす

**目的**: `isCombatView` の自ゲート(docking-guide.ts:72)を削除し、生成・保持・dispose を
CombatView へ移す。**この時点で挙動は変えない**(マップでは onLeave の hide で消える)。

```ts
// world-view.ts — 追加・変更
syncPanels(displayWindow: DisplayWindow, fo: FloatingOrigin): void;  // fo を追加
dispose(): void;                                                     // 追加
// docking-guide.ts
constructor(scene, markerManager, entities, docking)  // viewManager を削除
hide(): void  // root 非表示+マーカー hide(現 early-return 部の抽出)
// view-manager.ts
dispose(): void  // 両ビューの dispose を呼ぶ
```

| ファイル | 何をするか |
| --- | --- |
| src/game/world-view.ts | syncPanels へ fo 追加、dispose 追加 |
| src/game/docking/docking-guide.ts | viewManager 依存と combat ゲート削除、hide() 新設 |
| src/game/combat-view.ts | dockingGuide を ctor で受けて保持。syncPanels で dockingGuide.sync(player, fo, project)。onLeave で hide()。dispose で dockingGuide.dispose() |
| src/game/map-view.ts | syncPanels 署名追随。dispose は空実装(手順3で埋まる) |
| src/game/game.ts | dockingGuide フィールド削除、生成を views の前(docking の後)へ移動、sync():588 の呼び出し削除、dispose は viewManager.dispose() 経由へ(構築の逆順を保って並べ直す) |

**達成条件と検証**: typecheck・test:game。達成目標3が0件。実機目視は手順6のバッチで:
戦闘で他艦/基地へ 300 m 以内に接近してガイド表示 → [M] でマップに切り替えてガイドが消える。

### 手順3. PlanEditor を分割する — 共有の PlanTrajectory と、マップ専用の編集部

**目的**: editMode 分岐 6箇所を経路分けで消す。折れ線駆動(両ビュー共通)を PlanTrajectory へ
抽出して Game 常駐、編集部を MapView 保持へ、[N]/[Del] の戦闘側挙動を CombatView へ(D2・D3)。
**この時点で挙動は変えない。**

```ts
// plan/plan-trajectory.ts(新規)— 操作対象の計画折れ線表示の駆動(両ビュー共通)
export class PlanTrajectory {
  readonly planDisplay: PlanDisplay;   // path / apsisMarkers の読み口
  constructor(scene: THREE.Scene, markerManager: MarkerManager, celestialSystem: CelestialSystem,
    displayDuration: DisplayDurationSource, activePlayers: ActivePlayerController);
  // displayedPlan 規則: ノードのある計画は常に、空の計画はマップビュー(編集中)だけ描く
  update(displayWindow: DisplayWindow, frameAnchors: FrameAnchorSource, view: WorldView): void;
  sync(cameraSystem: CameraSystem, fo: FloatingOrigin): void;
  growableArcs(): readonly PredictedArc[];
  perfCounts(): Pick<PerfCounts, 'planArcs'>;
  dispose(): void;
}

// world-view.ts — 追加(ポーズ判定より前・オーバーレイゲート後、viewManager.handleInput の次)
handleInput(input: Input, dt: number): void;

// plan-editor.ts — 残る public(編集専用)。ctor から scene 以外の表示系と isMapView 閉包が消え、
// planTrajectory(path 参照)が入る
handleInput(input: Input, dt: number): void;   // [Del]=選択ノード削除 + WASDQE/ラッチ Δv
handleMapPointer(input: Input): void;
sync(cameraSystem: CameraSystem, simTime: number, fo: FloatingOrigin): void;  // ギズモ+パネルのみ
update(): void;  // 操作対象切替時のメニュー畳み(MapView.update から)
```

| ファイル | 何をするか |
| --- | --- |
| src/game/plan/plan-trajectory.ts | (新規)planDisplay 生成、旧 update():641-664(折れ線・操作艦の赤道交点)、旧 sync() の折れ線半分、displayedPlan:698-703(editMode → view 引数)、growableArcs、perfCounts、dispose(planDisplay) |
| src/game/plan/plan-editor.ts | 上記を削除(−約170行)。editMode getter・isMapView 閉包削除、dvEditActive は selectedNodeIdx のみに、handleInput から戦闘分岐(:193-195・clearPlanByKey の !editMode 側)削除、handleMapPointer / sync のゲート削除(構造的にマップからしか呼ばれない) |
| src/game/combat-view.ts | handleInput 実装: [Del] → `plan.clear()` + cancelAutoWarp + hint「マニューバ計画を破棄」、[N] → `simSpeedManager.toggleAutoWarpToFirstNode(plan?.firstNode(), simTime)`。ctor に simSpeedManager・hud を追加(plan は activePlayers から) |
| src/game/map-view.ts | handleInput 実装: editor.handleInput(input, dt)。update に editor.update() を追加。syncPanels に editor.sync(...)。dispose に editor.dispose()。editor は ctor で受けて保持 |
| src/game/game.ts | editor フィールド削除(ローカル生成 → mapActions と MapView へ配線)、planTrajectory フィールド追加。update:358 → planTrajectory.update(..., view)、predictor:365 → planTrajectory.growableArcs()、handleInput:489 → `viewManager.activeView.handleInput(input, dt)`、sync:572 → planTrajectory.sync、perfCounts:608 追随 |
| src/game/pickable/map-pickables.ts:47,104 | ctor の PlanEditor → PlanTrajectory(apsisMarkers の読み先) |
| src/game/dynamic/predictor.ts:160・sim-speed-manager.ts:4 | コメントの参照先を追随 |

handleInput の位置と入力消費の前提: [M] でビューが替わった同フレームは**新ビュー側**の
handleInput が走る(旧実装で editMode を切替後に読むのと同値)。WASDQE の takeHeld は
マップの編集時だけが触り、戦闘の操艦キーには手を出さない(旧 dvEditActive ゲートの構造化)。

**達成条件と検証**: typecheck・test:game。達成目標2が0件。ヘッドレス(手順6バッチと同項目を
この時点で一度回す): マップでノード配置→Δv→[Del]、[M]→戦闘で [N] hint(「ノードへ自動ワープ
開始」)と [Del] hint(「マニューバ計画を破棄」)、戦闘で確定計画の折れ線が見えること。

### 手順4. PlanGuide を CombatView へ下ろす

**目的**: editMode の自ゲートを削除し、生成・保持・呼び出しを CombatView へ移す(D4)。
呼び出しタイミングが advanceSimulation 内→ update フェーズに変わる以外、**挙動は変えない。**

| ファイル | 何をするか |
| --- | --- |
| src/game/plan/plan-guide.ts | update / sync から editMode 引数と player ゲート内の editMode 判定を削除 |
| src/game/combat-view.ts | guide を ctor で受けて保持(celestialSystem 依存を追加)。update() で guide.update(player, displayWindow.simTime, celestialMotions)、syncPanels で guide.sync(player, displayWindow.simTime, project, planTrajectory.planDisplay.path) |
| src/game/game.ts | guide フィールド・生成・advanceSimulation:452-457・sync:586 を削除 |

**達成条件と検証**: typecheck・test:game。grep: `editMode` 0件(達成目標2の完了はここ)。
実機は手順6バッチ: ノード実行接近で「マニューバ実行点に接近」hint と NODE/BURN マーカー、
ポーズ→[M]往復で余計な hint が出ないこと。

### 手順5. linePickables の保持を MapView へ、毎フレーム clear を onLeave へ

**目的**: 戦闘側が毎フレーム空にしている2つ(mapPickables.clear / linePickables.clear)を
「マップを出るとき1回」に置き換え、linePickables のフィールドを MapView へ移す(D8)。
初期状態は両者とも空なので、**挙動は変えない。**

| ファイル | 何をするか |
| --- | --- |
| src/game/map-view.ts | onLeave に mapPickables.clear() + linePickables.clear() を追加 |
| src/game/combat-view.ts | update の mapPickables.clear、syncPanels の linePickables.clear と両依存を削除 |
| src/game/game.ts | linePickables フィールドをローカル生成へ(mapActions と MapView へ配線のみ) |

**達成条件と検証**: typecheck・test:game。grep: combat-view.ts に
`mapPickables\|linePickables` 0件。実機は手順6バッチ: 戦闘で右クリック→「フォーカスを移動」、
viewBadge のフォーカス名表示が空欄にならないこと。

### 手順6. 最終検証と掃除

**目的**: 焼け残りコメント(「呼ぶ位置と順序は Game が持つ」等の記述が新構造と矛盾しないか)の
点検と、達成目標の一括判定。コード変更は原則なし。

- grep 一式: 達成目標1〜6。
- typecheck・test:game(この計画は src/game/ のみに触る)。
- ヘッドレス実機バッチ(dev サーバ + CDP): creative でマップ編集一式(ノード配置→ドラッグ→
  Δv→右クリックメニュー→[Del])→ 配置 → [M] → 戦闘で [N]/[Del] hint・確定計画の折れ線・
  ドッキング接近ガイド → [M] 往復でガイド・編集 UI が残らない → 実行時例外 0。
- ユーザーへ、達成目標9の引き継ぎ手動確認 7項目を提示して終了。

## 見積り

規模は編集箇所数で出す(導出: 本文の grep 実測)。

| 手順 | 規模 | 導出 |
| --- | --- | --- |
| 1 | 6ファイル・±170行 | view-manager 全面書き直し ~150行 + フック 3×2ビュー + game 配線・docking 閉包 |
| 2 | 5ファイル・±45行 | ゲート削除 ~10 + hide 抽出 ~10 + combat-view +15 + game −8 + 署名 2 |
| 3 | 8ファイル・−170/+~90行 + 配線 ~60行 | plan-editor の共有部実測(update/sync 折れ線・displayedPlan・growableArcs・perfCounts ≒ 120行)+ editMode 分岐 6箇所 + game 呼び出し 6箇所 |
| 4 | 3ファイル・±30行 | 呼び出し2箇所の移動 + 引数削除 4箇所 |
| 5 | 3ファイル・±20行 | clear 2箇所 + 依存 2本 + フィールド 1 |
| 6 | 0ファイル(コメント微修正のみ) | — |

検証コスト: typecheck は毎回ヒープ拡大が要る(既知)。ヘッドレス実機は手順3と手順6の2回。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 生成順の循環を閉包で断ち損ねる / 初期ビュー判定(canEnter)が艦の初期配置より前に走る | 起動時 TypeError / 攻略ステージがマップで開始する | 手順1(creative=マップ・攻略=戦闘の起動確認) |
| onEnter/onLeave が [M] 以外の遷移(ドッキングの強制 setView・操作対象喪失)で漏れる | 編集 UI・メニューが開いたまま残る | 手順1・手順6(ドッキング遷移込みのバッチ) |
| dockingGuide の hide 漏れ | マップに戦闘用の3D軸線・リングが残る | 手順2(手順6バッチの [M] 切替目視) |
| syncPanels(fo) の順序前提(cameraSystem.sync の後)を崩す | ガイド・ギズモが1フレーム古い描画原点で震える | 手順2・3(目視) |
| [N]/[Del] の per-view 再配線ミス(第一段階で死んだ回帰の再来) | 戦闘の自動ワープ・計画破棄が死ぬ | 手順3(ヘッドレスで両 hint を確認) |
| displayedPlan の view 規則の反転・取り違え | 戦闘で確定計画の折れ線が消える / マップで空計画の線が出ない | 手順3(両ビューで折れ線目視) |
| WASDQE の入力消費がビューを跨ぐ | 戦闘の操艦が Δv 編集に食われる(またはその逆) | 手順3(戦闘で操艦・マップで Δv 編集) |
| guide.update のポーズ中実行で通知・ノード消化が漏れ出す | ポーズ中に hint が出る / ノードが黙って消える | 手順4(ポーズ→[M]往復) |
| clear の onLeave 化で戦闘中の候補・可視性ポリシーが stale になる | 戦闘右クリックの候補に古いアプシス等が出る / viewBadge の名前が狂う | 手順5(戦闘右クリックと viewBadge 目視) |
| mapPickables の参照差し替え漏れ(apsisMarkers) | マップでアプシスマーカーを右クリックできない | 手順3(マップでアプシス右クリック) |
| dispose の順序崩れ・二重 dispose | リトライ・ステージ選択の再入で例外 | 手順2以降(ステージ再入を手順6バッチに含める) |
| typecheck の OOM | 検証が回らない | 全手順(ヒープ拡大して実行) |

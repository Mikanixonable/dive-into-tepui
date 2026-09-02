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

## 実施済みの前提(後続手順が依存する確定事項)

- 手順1 実施済み(30eede63 + レビュー反映 de8a80f1)。WorldViewFrame は
  canEnter/onEnter/onLeave を持ち、ViewManager が `views: Record<WorldView, WorldViewFrame>` を
  保持して `activeView` を出す。onEnter は**構築時の初期ビューでも呼ばれる**。
  `setView(next): boolean` は遷移の成否を返す。ビュー選択メニューは `selectableViews()` のみ
  (ラベルは view-badge 側の VIEW_LABELS)。
- **Docking は既に views より先に生成されている**(レビュー反映で前倒し済み)。手順2 で
  dockingGuide を移すときの生成順の並べ替えは dockingGuide だけでよい。
- セーブ由来 `camera.view` は ViewManager ctor で検証してから使う(不正値は 'combat' 扱い)。
- 手順2 実施済み(dff7c6d7)。DockingGuide は CombatView が保持し、syncPanels(displayWindow, fo)
  で同期・onLeave で hide()・dispose は ViewManager 経由。
- 手順3 実施済み(a30b91af)。PlanTrajectory(plan/plan-trajectory.ts)が計画折れ線・赤道交点・
  growableArcs(view)・planArcs を持ち Game が駆動。PlanEditor は編集専用で MapView が保持。
  WorldViewFrame.handleInput(input, dt, simTime) で [Del]/[N] は CombatView、Δv 編集は MapView。
  ヘッドレスでノード配置→Δv→確定→[N]/[X] の一連を確認済み(実行時例外 0)。

## 実施結果(全手順完了)

達成目標の判定:

| # | 目標 | 判定 |
| --- | --- | --- |
| 1 | game.ts のビュー専用フィールド 0 | **達成**(残るのは構築ローカルのみ) |
| 2 | editMode 0件 | **達成**(grep 0) |
| 3 | docking-guide の viewManager 0件 | **達成**(grep 0) |
| 4 | view-manager の editor/mapActions import 0 | **達成**(grep 0) |
| 5 | setControlledBaseProvider 0件 | **達成**(grep 0) |
| 6 | game.ts の isMapView 0件 | **達成**(grep 0) |
| 7 | typecheck / test:game を各手順で | **達成**(161件、最終回は test:render 18件も) |
| 8 | ヘッドレス実機 | **達成**: stage1=戦闘開始・[M]往復、creative=マップ開始・[M]拒否 hint、[N]無ノード hint→ノード配置→W で Δv→[M] 確定 hint→戦闘 NODE マーカー→[N] 自動ワープ→[X] 破棄、全て例外 0 |
| 9 | 引き継ぎ手動確認 | **ユーザーへ提示**(下記) |

手順6 の判定: WorldView 型は world-view.ts へ**移した**(4777291e、importer 26ファイル追随)。
焼け残りコメントは map-view ヘッダのみで、修正済み。

ヘッドレスで演出できず**ユーザーの実機確認に残した項目**(第一段階からの引き継ぎ7項目+今回分):
戦闘 [Del]=[X] 破棄 hint(ヘッドレスでは確認済み・念のため)/ 戦闘右クリック→「フォーカスを移動」/
ドラッグ・ズームの操作感(0.0015)/ マップで機体へ 12 m ズーム+[G] / 切替・リセット・再ロードで
視点が跳ばない / 撃破時に視点が留まる / 旧セーブのロード / ドッキング接近ガイドの表示と
[M]でマップへ出た際の消灯 / ドッキング・発進による強制ビュー遷移 / ポーズ中の [M] 往復で
余計な hint が出ないこと。

レビューで見つかった**既存の問題**(本計画では触っていない):
1. 基地操作中に戦闘ビューへ入ると、タッチのモードボタンと戦闘右クリックが player=null で
   早期 return し、直前の艦の表示のまま凍結する(combat-view.ts の syncPanels/handlePointer)。
2. マップの未来表示パネルは activePlayers.current を渡すため、基地操作中は表示窓の解決対象
   (activeControllableEntity=基地)と食い違う(map-view.ts syncPanels)。

## 見積り

規模は編集箇所数で出す(導出: 本文の grep 実測)。

| 手順 | 規模 | 導出 |
| --- | --- | --- |
| 1(実施済み) | 実測: 6ファイル −89/+84 行 + レビュー反映 7ファイル −66/+40 行 | commit 30eede63 / de8a80f1 |
| 2(実施済み) | 実測: 6ファイル −27/+44 行 | commit dff7c6d7 |
| 3(実施済み) | 実測: 9ファイル −145/+192 行 | commit a30b91af |
| 4(実施済み) | 実測: 3ファイル −27/+30 行 | commit 8768561c |
| 5(実施済み) | 実測: 3ファイル −13/+12 行 | commit c2b347ab |
| 6(実施済み) | 実測: 29ファイル −30/+32 行(WorldView 型移設) | commit 4777291e |

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

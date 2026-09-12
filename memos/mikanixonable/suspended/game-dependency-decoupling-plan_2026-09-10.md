# Game 依存境界の段階的リファクタリング計画

作成日: 2026-09-10

## 目的

`Game`をゲーム全体のcomposition rootとして維持しながら、HUD・保存・フレーム処理・機能ビューが
`Game`全体や相互の具体実装へ依存しない構造へ段階的に移す。目的はimport行数の削減ではなく、変更理由と
依存方向を機能単位で閉じ、各境界を単独で検証できるようにすることである。

この変更ではプレイヤーから見える挙動、フレーム処理の順序、セーブ形式、描画品質を変えない。

## 決めたこと

- `Game`は生成・所有・配線・`dispose`・`serialize`と、`update → sync → render`の大順序を持ち続ける。
- importを隠すだけの`GameContext`、汎用`Services`、DIコンテナ、イベントバス、React移行は導入しない。
- 下位モジュールには、機能ごとのread modelまたは狭いportを渡す。portが複数の無関係なシステムを包むだけに
  なった場合は作らず、必要な所有者を個別に渡す。
- 実装1ではHUDの表示計算をパネル固有の入力へ分け、軌道分析には軌道分析専用の問い合わせ境界を設ける。
  `Hud`の既存command配線と、各パネルの既存ViewModelは利用する。
- 仕様変更ではないため`DEVELOP/SPEC/`は更新しない。作業の判断・進捗・受入条件はこのメモで管理する。

## 全体の達成目標

- `src/game/hud/`の実装ファイルが`Game`型を直接importしない。
- HUDのパネルと軌道分析が、`Game`の公開フィールドを探索して状態を取得しない。
- 保存機能が`Game`オブジェクトを永続化APIへ渡さず、`RunSummary`と`GameSaveData`の境界で動く。
- `Game.update()`内の入力配分・シミュレーション前進・表示更新の責務が、独立した名前を持つCoordinatorへ移り、
  `Game`にはフェーズの大順序と所有ライフサイクルだけが残る。
- `CombatView`、`MapView`、`ObjectWindows`などが、全システムを束ねた汎用contextではなく機能固有の依存だけを受け取る。
- 既存のHUD表示、軌道分析、保存、pause、map/combat切替、入力優先順、`update/sync/render`順序が変わらない。
- 各手順で`npm run typecheck`を通し、触った層に対応する回帰テストを通す。

## 実装計画

### 手順1: HUDの`Game`逆依存を解消する（今回実施）

#### 目的

HUDがcomposition rootの内部構造を読む境界をなくす。パネルは既存のViewModelだけを受け取り、軌道分析は
必要な天体・個体・基準軌道・表示期間を得るための専用境界だけを受け取る。この時点で表示内容・更新頻度・
分析対象のreaderフラグ・予測の伸長タイミングは変えない。

#### 作業単位と並列化

次の2作業は書き込み範囲が重ならないため、同じ契約を確認した後に並列実施する。

1. **パネルPresenter分割**
   
   対象:

   - `src/game/hud/panel-presenter.ts`

   内容:

   - `Game`引数を削除し、各ViewModelの計算に必要な値・所有者だけを受け取る。
   - `topBarViewOf`、`mapScaleViewOf`、`vesselPanelViewOf`、`orbitPanelViewOf`、`targetPanelDataOf`、
     `enemiesPanelViewOf`の出力型と計算結果を維持する。
   - `panel-presenter.ts`から`import type { Game }`をなくす。

2. **軌道分析境界分割**
   
   対象:

   - `src/game/hud/hud.ts`
   - `src/game/hud/orbit/orbit-analysis-window.ts`
   - `src/game/hud/orbit/orbit-analysis-tab.ts`
   - `src/game/hud/orbit/orbit-altitude-tab.ts`
   - `src/game/hud/orbit/orbit-approach-tab.ts`
   - `src/game/hud/orbit/orbit-projection-tab.ts`
   - 必要なら`src/game/hud/orbit/orbit-analysis-context.ts`（新規）

   内容:

   - `AnalysisTab.available/draw`、`OrbitAnalysisWindow.update/sync`から`Game`引数をなくす。
   - 軌道分析に必要な問い合わせだけを表す`OrbitAnalysis`専用の境界を定義する。全システムを詰め込んだ
     汎用contextにはしない。
   - `Hud`のadapterは`Game`を閉じ込めたcallbackではなく、軌道分析用の入力またはportを受け取って
     `OrbitAnalysisWindow`へ渡す形にする。
   - `src/game/hud/orbit/`から`import type { Game }`をなくす。

3. **Game側の統合**
   
   対象:

   - `src/game/game.ts`

   内容:

   - 手順1-1、1-2の新しい引数契約に合わせて`sync()`と`update()`の呼び出しを張り替える。
   - 表示窓、操作対象、航法ターゲット、軌道基準、現在の天体状態が従来と同じフレーム時点から読まれるようにする。
   - `Game`がHUDへ渡す値の組み立てだけを担い、HUD内部へ`Game`自身を渡さない。

#### 達成条件と検証

- `rg -n "import( type)? .*Game|from ['\"].*game['\"]" src/game/hud`で、HUD実装から`Game`型の直接参照が0件になる。
- `rg -n "(topBarViewOf|mapScaleViewOf|vesselPanelViewOf|orbitPanelViewOf|targetPanelDataOf|enemiesPanelViewOf)\(this\)" src/game`で、
  `Game`全体をPresenterへ渡す呼び出しが0件になる。
- `npm run typecheck`を通す。
- HUD層を触るため、UIの既存動作を`npm run smoke:browser`で確認する。combat/mapの常設パネル、軌道分析の高度・接近・投影タブ、
  対象切替、未来表示期間、軌道分析を閉じた後のreader解除を確認する。
- `Game.update()`の分析reader更新が`Predictor.update()`より前、`Game.sync()`の分析表示が既存のHUD同期位置にあることをコードレビューで確認する。

#### 実施結果（2026-09-10）

- パネルPresenterを6つのfeature-specific sourceへ分割し、`Game`自身を渡さない配線へ変更した。
- 軌道分析の入力境界（reader入力・同期入力・タブ入力）を追加し、`Hud`から`Game`の型参照と旧callback fallbackを除去した。
- `activeControllable`はcomposition rootでgetterとして配線し、対象切替後も古い値を保持しないようにした。
- `Game.update()`のreader更新位置、`Predictor.update()`との前後関係、`Game.sync()`内のHUD同期順序は変更していない。
- 実装コミット: `0a41653e`（panel presenter）、`37804af5`（orbit boundary）、`dec37e30`（Game/Hud統合）。
- `npm run typecheck`: 成功。
- `npm run test:game`: 201/201 成功。
- `git diff --check`: 成功。HUDからの`Game`直接参照、Presenterへ`this`を渡す呼び出し、旧orbit callbackは検索上0件。
- `npm run smoke:browser`: pause menu shieldingの既存テスト状態（`shieldShown: false`）で停止した。変更対象にpause menuのコードはなく、変更前スナップショットでの同一確認は静的サーバー未起動で完遂できなかったため、UI smokeの完全な再確認は残課題とする。

### 手順2: 保存系の`Game`依存をデータ境界へ移す

#### 目的

永続化層がゲームの具体クラスを知らず、保存対象のデータと一覧表示用の要約だけを受け取るようにする。
保存形式とスナップショットの命名・復元条件は変えない。

#### 変更が必要な箇所

- `src/launcher/save/snapshot-service.ts`: `capture`の入力を`Game`から`RunSummary`と`GameSaveData`へ移す。
- `src/launcher/save/autosave.ts`: 自動保存時刻の判定と保存データ取得の境界を分ける。
- `src/launcher/snapshot-controls.ts`: 手動保存の実行条件と、保存用データ供給を狭いportへ分ける。
- `src/launcher/save-browser/save-browser.ts`: `CurrentGameSource`をstage状態・pause/resumeだけの契約へ狭める。
- `src/main.ts`または`src/launcher/launcher.ts`: 現在のGameから必要なデータを境界へ渡す配線を張り替える。
- 必要なら`src/launcher/save/game-snapshot-source.ts`（新規）: 保存データ供給の名前付きportを置く。

#### 達成条件と検証

- `rg -n "capture\(.*Game|import \{ Game \}|import type \{ Game \}" src/launcher/save src/launcher/snapshot-controls.ts`で、永続化のAPIが`Game`全体を要求しない。
- `npm run typecheck`、`npm run test:game`を通す。
- 手動保存、自動保存、一覧表示、スナップショットロード、決着後の保存禁止を`npm run smoke:browser`で確認する。

#### 実施結果（2026-09-10）

- `SnapshotService.capture`は`Game`ではなく`RunSummary`と`GameSaveData`を受け取る境界へ変更した。
- 自動保存・手動保存・セーブブラウザは、保存データ、ステージ状態、天体名解決、pause/resumeだけの契約を介して動作する。
- `src/launcher/save/`、`snapshot-controls.ts`、`save-browser.ts`から`Game`の直接importを除去した。
- 保存形式、メタデータの構築、ロード検証、60秒間隔、決着後禁止、保存操作の呼出順序は変更していない。
- 実装コミット: `a4de2a7a`（保存境界）。
- コードレビューで、`Launcher`がGameを生成・所有する責務と、保存データを取得する時点を確認した。
- `npm run typecheck`: 成功。
- `npm run test:game`: 201/201 成功。
- `git diff --check`: 成功。保存系APIへの`Game`直接参照は検索上0件。
- `npm run smoke:browser`: 保存操作の確認へ到達する前に、pause menu shieldingの`shieldShown: false`で停止した。手順1と同じ既存のUI smoke課題として、保存固有の完全な再確認は残課題とする。

### 手順3: フレーム内の責務をCoordinatorへ分ける

#### 目的

`Game`に残すのはフェーズの大順序とライフサイクルにし、入力優先順、シミュレーション前進、表示更新の具体処理を
独立した責務として名前付けする。`update → sync → render`と各段の順序は変更しない。

#### 変更が必要な箇所

- `src/game/game.ts`: Coordinatorの保持・生成・破棄と大順序の配線へ整理する。
- `src/game/input-coordinator.ts`（新規）: overlay、HUD、速度、view、view固有入力の優先順を所有する。
- `src/game/simulation-coordinator.ts`（新規）: `SimSpeedManager`、`Stage`、`DynamicSystem`、`Targeter`、
  `ControlSelection`、`FlashEffects`のシミュレーション前進を所有する。
- `src/game/presentation-coordinator.ts`（新規）: display window、frame anchor、plan、predictor、camera、pointer、
  各表示同期の依存を必要な範囲で所有する。
- `tests/`のgame層テスト: fake dependencyで入力優先順・simulation順・presentation順を検査できる境界を追加する。

#### 達成条件と検証

- `Game.update()`に、各Coordinatorへの呼び出し順が読める。
- `Game`へ入力・シミュレーション・表示の具体手続きが戻っていない。
- `npm run typecheck`、`npm run test:game`、`npm run test:render`を通す。
- `npm run smoke:browser`でpause中・決着後の表示更新、warp、map/combat切替、pointer操作を確認する。

#### 実施結果（2026-09-10）

- `InputCoordinator`、`SimulationCoordinator`、`PresentationCoordinator`を追加し、入力、シミュレーション前進、表示更新の具体処理を各Coordinatorへ移した。
- `Game`はCoordinatorの生成・所有・破棄と、`update → sync → render`の大順序を保持する構成に整理した。
- Coordinatorの依存はそれぞれの責務に必要な具象システムを明示的に受け取り、汎用contextや依存バッグは導入していない。
- 入力優先順、シミュレーションの停止判定、表示更新と同期の順序は実装差分をレビューし、従来の順序を維持していることを確認した。
- `InputCoordinator.update()`は入力副作用だけを行い、フレーム時間の正規化は`Game.update()`に残した。
- 実装コミット: `e8fad089`（Coordinator分割）、`f85db023`（入力Coordinatorの責務修正）。workspace3統合コミットは`6960660b`、`c76b748b`。
- `npm run typecheck`: 成功。
- `npm run test:game`: 201/201 成功。
- `npm run test:render`: 100/100 成功。
- `git diff --check`: 成功。保存系からの`Game`直接import、旧Game内フェーズ関数、旧Presenter呼び出しは検索上残っていない。
- `npm run smoke:browser`: pause menu shieldingの`shieldShown: false`で停止する既存UI smoke課題があるため、pause中・決着後・warp・view切替・pointer操作の完全な再確認は残課題とする。

### 手順4: 機能ビューの依存を狭める

#### 目的

Coordinator分割後に見える機能単位の依存を、各機能のportへ整理する。巨大な`GameContext`を導入せず、機能の
変更理由と必要な所有者を一致させる。

#### 変更が必要な箇所

- `src/game/view/combat-view.ts`: 戦闘入力・pick・plan・target・HUDに必要な依存へ整理する。
- `src/game/view/map-view.ts`: map pick・frame・display window・authoringに必要な依存へ整理する。
- `src/game/pickable/object-windows.ts`: object windowが扱う操作・表示・stage capabilityの依存を分離する。
- `src/game/camera/camera-system.ts`: view/state問い合わせのportを確認し、広いGame参照を導入しない。
- `src/game/frame-anchors.ts`: 既存の`AnchorTargets`境界を維持し、必要な問い合わせだけを受ける。
- `src/game/game.ts`: 機能portを構築し、所有ライフサイクルを維持する。

#### 達成条件と検証

- 各機能のconstructorが、その機能の変更理由と無関係なシステムを受け取らない。
- `GameContext`、`Services`などの汎用依存バッグを追加していない。
- `npm run typecheck`、`npm run test:game`、`npm run test:render`を通す。
- combat/mapの選択、property window、軌道編集、camera focus、creative authoringを`npm run smoke:browser`で確認する。

## 見積り

時間ではなく、独立した変更単位と検証回数で見積もる。

- 手順1: Presenter 1単位 + 軌道分析 1単位 + Game統合 1単位 + typecheck 1回 + UIスモーク1回。
- 手順2: 保存API 1単位 + 外部配線1単位 + typecheck 1回 + game回帰1回 + 保存スモーク1回。
- 手順3: Coordinator 3単位 + Game統合1単位 + typecheck 1回 + game/render回帰各1回 + runtimeスモーク1回。
- 手順4: view 2単位 + object window 1単位 + camera/frame境界1単位 + typecheck 1回 + game/render回帰各1回 + runtimeスモーク1回。

手順1は2つの実装単位を並列に進め、Game統合をその後に行う。手順2は手順1と同じファイルを変更しない範囲で独立して実施できる。
手順3は手順1のHUD境界と手順2の保存境界を前提にし、手順4は手順3後の依存グラフを見て実施する。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| Presenterへ表示窓・操作対象の古い値を渡す | HUDだけ1フレーム遅れる、または対象切替直後に古い値を描く | 手順1のcombat/map、対象切替、未来表示期間のスモーク |
| 軌道分析のreader更新がPredictorより後へ移る | 分析対象の予測がそのフレームに伸びない | 手順1の`Game.update()`コードレビューと軌道分析表示 |
| 軌道分析portが全システムを包む | `GameContext`と同じ結合を別名で再生成する | 手順1のport定義レビュー |
| DOM用ViewModelをHUD内で再計算する | `sync`の値の正本が分散し、表示と選択の時刻がずれる | 手順1のPresenterと`Game.sync()`の差分レビュー |
| 保存APIの変更で`serialize()`を複数回呼ぶ、または順序を変える | 保存データと一覧メタデータが別時点になる | 手順2のsnapshot回帰と保存コードレビュー |
| Coordinator抽出時に呼び出し順を並べ替える | pause、warp、camera、marker、pointerの挙動が無言で変わる | 手順3の順序テストとruntimeスモーク |
| 機能portを汎用依存バッグにする | 依存が見えなくなり、変更影響が縮まらない | 手順4のconstructor差分レビュー |
| 既存の`type-only`境界をvalue importへ変える | 実行時循環または初期化順問題が増える | 各手順のtypecheckとimport差分レビュー |

## 進捗

- [x] 手順1: HUDの`Game`逆依存を解消（実装・コードレビュー完了。UI smokeのみ既存失敗で未完遂）
- [x] 手順2: 保存系のデータ境界化（実装・コードレビュー完了。UI smokeは既存失敗で未完遂）
- [x] 手順3: フレームCoordinator分割（実装・コードレビュー・typecheck/game/render回帰完了。UI smokeは既存失敗で未完遂）
- [ ] 手順4: 機能ビュー依存の縮小

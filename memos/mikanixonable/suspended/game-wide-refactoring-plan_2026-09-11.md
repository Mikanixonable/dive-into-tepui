# ゲーム基盤リファクタリング計画

作成日: 2026-09-11
計画の基準コミット: `dc6e0c75`

## 目的

`src/game` をゲーム1ランの状態とルールを所有する層として保ち、HUD、入力、描画、保存、ラン遷移が
ゲーム全体の具象クラスへ依存しない構造へ移行する。対象は次の6領域である。

- ゲーム・HUD・描画層の依存境界
- `Game` のフレーム処理とオーケストレーション
- 動的エンティティのゲーム状態と表示・UI責務
- 生入力、アクション、ゲームコマンドの境界
- Launcher、セーブ、ランライフサイクルの境界
- ファイル構成、テスト構成、依存境界の自動検査

この計画は、雲・気候モデルと雲描画の分離を対象にしない。`src/render/cloud/`、雲専用の大気・影経路、
雲生成の視覚モデルはこの計画では変更しない。

## 現行コードでの進捗（2026-09-12）

入力router、game action/command、entity lifecycleの契約ファイルは存在するが、Gameへの統合と既存利用箇所の
移行は未完了。HUDの`Game`直接参照、Game本体のフレーム処理集中、entityのUI/effect依存も残っているため、
この計画は継続する。

優先順位を再整理した残タスクは[残タスク一覧](./remaining-tasks_2026-09-12.md)を参照する。

## 決めたこと

- プレイヤーから見える挙動、物理計算、描画結果、入力優先順位、`update → sync → render` の順序を変えない。
- 既存セーブデータの読み込み互換性と保存形式を変えない。保存形式を変更する必要が出た場合は、リファクタリングを中断して仕様変更として扱う。
- `src/main.ts` はcomposition rootと`requestAnimationFrame`の駆動を保持する。
- `src/game/game.ts` は1ランのcomposition rootとして、サブシステムの生成・所有・`dispose`・`serialize`と大きなフレーム順序を保持する。
- `Game`の依存を隠すだけの`GameContext`、汎用`Services`、DIコンテナ、アプリケーション全体のイベントバスは作らない。
- 新しい境界は機能固有のread model、port、commandにする。複数の無関係な依存を寄せ集める型は作らない。
- 新しいCoordinatorやadapterは、独自の状態・順序・問い合わせ・資源所有のいずれかを持つ場合だけ作る。1メソッドを別ファイルへ転送するだけのwrapperは作らない。
- `Player`、`Base`、`Enemy`を一つの汎用エンティティ型へ一般化しない。個別のゲーム調整値と挙動は各具象型に残す。
- `DEVELOP/SPEC/` は更新しない。挙動の変更が必要になった箇所は、この計画の対象外として切り出す。
- 各実装単位は、型検査と該当層の回帰テストが通る状態でコミットする。

## 達成目標

- `src/game/hud/` が `src/game/game.ts` の`Game`型を直接importしない。
- `src/render/` のうち `src/render/cloud/` を除くコードが `src/game/` をimportしない。
- `Game.update()`、`Game.sync()`、`Game.render()`に残る処理が、所有・配線・フェーズ順序の決定として説明できる。
- `Player`、`Base`、`Enemy`がDOM、PropertyWindow、ContextMenu、ObjectPickableの表示構築を直接実装しない。
- gameplayコードが`Input.takeKey()`と`Input.takeKeys()`で入力エッジを奪い合う箇所が0件になる。オーバーレイの入力優先順位は、明示的なルーターで同じ挙動を保つ。
- `Launcher`がセーブサービスへ`Game`インスタンスを渡さず、明示されたセーブデータとラン要約だけを渡す。
- 新しいファイル構成が、ランタイム、ゲーム入力、ゲーム表示、エンティティ検査、保存、共通UIをディレクトリ名から判別できる。
- 依存境界検査をCIで実行でき、禁止されたimport方向が追加されたときに失敗する。
- `npm run typecheck`、変更層の回帰テスト、必要なブラウザスモークが全て通る。

## 手順

### 1. ゲーム・HUD・描画の依存境界を固定する

#### 目的

HUDが`Game`の公開フィールドを探索せず、描画層がゲーム固有の型を直接参照しない境界を作る。既存の表示値、
入力処理、軌道分析、タンパク質表示、地球表面表示の結果は変えない。

#### 変更が必要な箇所

| ファイル | 変更内容 |
| --- | --- |
| `src/game/hud/hud.ts` | `updateAnalysisReaders(game: Game)` と `syncPanels(view, game: Game)` の`Game`依存を除き、機能固有の入力型を受け取る。 |
| `src/game/hud/orbit/orbit-analysis-window.ts` | `Game`からの探索をやめ、軌道分析のread modelまたはportだけを読む。 |
| `src/game/hud/orbit/orbit-analysis-tab.ts` | タブの可用性判定と描画に必要な値を専用入力型へ移す。 |
| `src/game/hud/orbit/orbit-altitude-tab.ts` | 高度分析用の入力境界を受け取る。 |
| `src/game/hud/orbit/orbit-approach-tab.ts` | 接近分析用の入力境界を受け取る。 |
| `src/game/hud/orbit/orbit-projection-tab.ts` | 投影分析用の入力境界を受け取る。 |
| `src/game/hud/panels/*.ts` | 各パネルへ渡す値を機能固有のview modelにする。全パネルを一つのcontextへまとめない。 |
| `src/game/game.ts` | `Game`の状態からHUD用read modelを組み立て、HUDへ渡す。HUDへ`this`を渡さない。 |
| `src/render/protein-ribbon-color.ts` | `src/game/protein/protein-display.ts`の型を描画契約へ移す。 |
| `src/render/protein-atom-view.ts` | `ProteinDisplayAsset`のゲーム層依存を描画契約へ移す。 |
| `src/render/protein-enemy-ship.ts` | タンパク質表示設定の入力を描画契約へ移す。 |
| `src/render/protein-silhouette-view.ts` | シルエット表示設定の入力を描画契約へ移す。 |
| `src/render/protein-ribbon.ts` | アセット定義、モーション定義、色モードの入力を描画契約へ移す。 |
| `src/render/earth-surface.ts` | 地球表面ソースの型をゲーム層から描画側の契約へ移す。 |
| `src/game/protein/protein-display.ts` | ゲーム側の表示設定を描画契約へ変換するadapterを置く。 |
| `src/game/protein/protein-display-asset.ts` | ゲーム側アセットと描画側アセット入力の変換を置く。 |
| `src/game/protein/protein-schema.ts` | 描画モジュールが直接参照しないよう、ゲーム・アセット側の型と描画契約を分離する。 |
| `src/game/celestial/solar-system/earth-surface-source.ts` | 描画側が使用するEarth surface contractの実装側にする。 |
| `src/render/protein-display-contract.ts`（新規） | タンパク質描画が必要とする最小の型だけを定義する。 |
| `src/render/earth-surface-contract.ts`（新規） | 地球表面描画が必要とするソース契約だけを定義する。 |
| `tools/check-boundaries.mjs`（新規） | `src/render/`から`src/game/`へのimportを雲除外で検査し、`src/game/hud/`から`src/game/game.ts`へのimportを検査する。 |

#### 実装方法

1. `Game`の状態を直接読む箇所を、パネルごとの必要値へ書き下す。
2. 軌道分析だけは、表示窓、対象状態、軌道要素、予測列、基準天体を一括するのではなく、分析機能が実際に問い合わせる操作だけをportとして定義する。
3. `Game`側で既存の時刻・対象・基準系を解決し、HUDへ同一フレームの値を渡す。
4. タンパク質と地球表面の描画入力を`render`側の最小契約へ移し、ゲーム側がadapterを実装する。
5. 雲以外の`render -> game`依存をなくし、雲関連の依存はこの計画では変更しない。

#### 達成条件と検証

- `rg -n "from .*game/game|import type .*Game" src/game/hud` の結果が0件になる。
- `rg -n "from .*game/" src/render --glob '!cloud/**'` の結果が0件になる。
- `tools/check-boundaries.mjs` が禁止方向を検出した場合に終了コード1を返す。
- `npm run typecheck`、`npm run test:game`、`npm run test:render`を通す。
- `npm run smoke:browser`で、combat/mapのHUD、軌道分析3タブ、対象切替、表示窓変更、タンパク質敵表示、地球表面表示を確認する。

### 2. `Game`のフレーム処理を明示的なフェーズへ分ける

#### 目的

`Game`に集中している入力、シミュレーション、表示状態確定、カメラ、同期処理を、フェーズごとの名前付きCoordinatorへ移す。
`Game`はライフサイクルとフェーズ順序の所有者として残し、フレーム処理の順序と時刻軸を変えない。

#### 変更が必要な箇所

| ファイル | 変更内容 |
| --- | --- |
| `src/game/game.ts` | `update`、`sync`、`render`から具体処理をCoordinatorへ移し、所有・配線・大順序だけを残す。 |
| `src/game/dynamic/dynamic-system.ts` | シミュレーション前進と表示同期の呼び出し元を新しいフェーズ契約へ合わせる。 |
| `src/game/display-window-manager.ts` | 表示時刻・過去/未来窓の確定を表示フェーズの入力として明示する。 |
| `src/game/frame-anchors.ts` | 表示時刻の注入契約を表示フェーズへ移す。 |
| `src/game/camera/camera-system.ts` | カメラ更新と同期の入力を`DisplayFrame`または同等の明示型へ合わせる。 |
| `src/game/view/view-manager.ts` | 現在ビューの更新・入力・同期をフェーズCoordinatorから呼べる契約にする。 |
| `src/game/runtime/game-input-phase.ts`（新規） | 入力更新、オーバーレイ入力、ゲーム入力の配分を所有する。 |
| `src/game/runtime/simulation-phase.ts`（新規） | ステージ、指令決定、シミュレーション、エフェクトの順序を所有する。 |
| `src/game/runtime/display-phase.ts`（新規） | 表示窓、履歴要求、予測、赤道交点、カメラ、ビュー更新の順序を所有する。 |
| `src/game/runtime/presentation-phase.ts`（新規） | 天体、動的エンティティ、HUD、マーカー、軌道線を同期する順序を所有する。 |
| `src/game/runtime/frame-state.ts`（新規） | シミュレーション時刻、表示時刻、現在ビュー、表示窓など同一フレームの値を明示する。 |

#### 実装方法

- `Game.create`、constructor、`dispose`、`serialize`は`Game`に残す。
- `Game.update()`は、入力フェーズ、シミュレーションフェーズ、表示フェーズをこの順に呼ぶ。
- `Game.sync()`は、カメラ同期、天体・動的エンティティ・HUD同期、マーカー解決をプレゼンテーションフェーズへ渡す。
- `Game.render()`は`RenderPipeline.render()`の呼び出しだけを残す。
- `DisplayWindow`、`FrameAnchors`、`activeControllable`、`visibilityPolicy`は、必要なCoordinatorへ個別に渡す。全サブシステムを含むcontextは作らない。

#### 達成条件と検証

- `src/game/game.ts`の`update`、`sync`、`render`がCoordinator呼び出しとフェーズ順序だけになる。
- `Game.update()`で`SimulationPhase`が`DisplayPhase`より前に実行されることをテストで固定する。
- シミュレーション時刻と表示時刻を同じ変数名で混用する箇所を新規Coordinator内に作らない。
- `npm run typecheck`、`npm run test:game`、`npm run test:render`を通す。
- `npm run smoke:browser`で、ポーズ中、決着後、タイムワープ中、combat/map切替中の表示更新を確認する。

### 3. 動的エンティティのゲーム状態と表示・UI責務を分離する

#### 目的

`Player`、`Base`、`Enemy`が、物理状態・戦闘反応・セーブ・マーカー・一覧・プロパティウィンドウ・メニュー・VFX・音声を一つの具象クラスで実装する状態を解消する。
プレイヤーと敵の個別調整値は統合せず、表示用adapterだけを分離する。

#### 変更が必要な箇所

| ファイル | 変更内容 |
| --- | --- |
| `src/game/player/player.ts` | `ObjectPickable`、`PropertyWindow`、`ContextMenu`、一覧表示の実装を外し、ゲーム状態・操作・反応・セーブを保持する。 |
| `src/game/dynamic/dynamic-entity/base.ts` | 基地の表示一覧・プロパティ・メニュー責務を外し、操作とゲーム状態を保持する。 |
| `src/game/dynamic/dynamic-entity/enemy.ts` | 敵の表示一覧・プロパティ・メニュー責務を外し、AI・戦闘反応・セーブを保持する。 |
| `src/game/player/player-effects.ts`（新規） | Playerが必要とする音声・通知・VFXの最小portを定義する。 |
| `src/game/dynamic/dynamic-entity/base-effects.ts`（新規） | Baseが必要とする通知・音声の最小portを定義する。 |
| `src/game/dynamic/dynamic-entity/enemy-effects.ts`（新規） | Enemyが必要とする音声・VFXの最小portを定義する。 |
| `src/game/dynamic/dynamic-entity/dynamic-entity.ts` | Motion/Viewの寿命束ねと識別だけを保持し、UI用の具象知識を追加しない。 |
| `src/game/dynamic/dynamic-entity/base-view.ts` | 描画資源の同期・破棄に限定する。 |
| `src/game/dynamic/dynamic-entity/enemy-motion.ts` | 物理・AIに必要な状態だけを保持する。 |
| `src/game/player/player-view.ts` | Playerの描画資源と同期だけを保持する。 |
| `src/game/pickable/object-pickable.ts` | エンティティ本体から独立した表示・操作対象契約へ整理する。 |
| `src/game/pickable/object-windows.ts` | エンティティから表示情報を問い合わせるadapterを使う。 |
| `src/game/pickable/orbit-rows.ts` | 軌道情報の表示計算を検査adapter側へ移す。 |
| `src/game/pickable/pickable-listing.ts` | 一覧表示用の契約を定義する。 |
| `src/game/pickable/part-windows.ts` | 部品の表示情報をゲーム本体の具象型から分離する。 |
| `src/game/marker/*.ts` | マーカー入力をエンティティ本体のUIメソッドではなく、表示adapterから受ける。 |
| `src/game/dynamic/dynamic-system.ts` | entity登録・削除・spawn待ち・シミュレーション・表示同期を別責務へ分ける。 |
| `src/game/dynamic/entity-registry.ts` | 登録・検索・削除の最小契約を維持する。 |
| `src/game/dynamic/simulator.ts` | 数値積分、接触、サブステップだけを所有する。 |
| `src/game/pickable/entity-inspection.ts`（新規） | エンティティの一覧・検査・メニューを表示側へ提供する最小契約を定義する。 |
| `src/game/pickable/player-inspection.ts`（新規） | Player固有の一覧・プロパティ・メニューを実装する。 |
| `src/game/pickable/base-inspection.ts`（新規） | Base固有の一覧・プロパティ・メニューを実装する。 |
| `src/game/pickable/enemy-inspection.ts`（新規） | Enemy固有の一覧・プロパティ・メニューを実装する。 |
| `src/game/dynamic/entity-lifecycle.ts`（新規） | 登録、削除、spawn待ち、上限、reclaimを所有する。 |
| `src/game/dynamic/dynamic-presenter.ts`（新規） | DynamicEntityから表示入力を作り、View・線・マーカーへ同期する。 |

#### 実装方法

- `Player`、`Base`、`Enemy`からDOM型、`PropertyRow`、`MenuItem`、`PropertyWindowOpener`、`ObjectPickable`を段階的に除去する。
- `Notifier`、`WorldSfx`、`FlashEffects`の具象型をエンティティへ注入せず、Player、Base、Enemyごとの狭いeffects portへ変換する。共通の`EntityServices`型は作らない。
- `EntityInspection`は、個体を丸ごと渡す汎用contextではなく、名前・軌道・HP・操作可能性など検査画面が必要とする問い合わせを定義する。
- `DynamicSystem`は既存の公開契約を壊さず、内部で`EntityLifecycle`、`Simulator`、`DynamicPresenter`へ処理を委譲する。
- 接触の帰結、ダメージ、音声、消滅は当事者のゲーム責務に残し、表示adapterへ移さない。

#### 達成条件と検証

- `rg -n "PropertyRow|MenuItem|PropertyWindow|ObjectPickable|ContextMenu" src/game/player/player.ts src/game/dynamic/dynamic-entity/base.ts src/game/dynamic/dynamic-entity/enemy.ts` の結果が0件になる。
- `rg -n "Notifier|WorldSfx|FlashEffects" src/game/player/player.ts src/game/dynamic/dynamic-entity/base.ts src/game/dynamic/dynamic-entity/enemy.ts` の結果が0件になる。
- `Player`、`Base`、`Enemy`がDOM要素を生成しない。
- `DynamicSystem`がentity lifecycleとsimulationの両方を公開APIとして混在させず、各責務の所有者がコードから判別できる。
- `npm run typecheck`、`npm run test:game`、`npm run test:render`を通す。
- combat/mapの対象選択、右クリックメニュー、プロパティウィンドウ、敵一覧、Playerのセーブ・復元をブラウザスモークで確認する。

### 4. 生入力、アクション、ゲームコマンドを分離する

#### 目的

`Input.takeKey()`と`Input.takeKeys()`の呼び出し順に依存した暗黙の入力優先順位を、明示的な入力ルーターとコマンドへ置き換える。キーボード、ポインタ、タッチ、オーバーレイ、ゲームプレイの挙動は維持する。

#### 変更が必要な箇所

| ファイル | 変更内容 |
| --- | --- |
| `src/input/input.ts` | DOMイベントの収集とフレーム単位のimmutableな入力snapshotを提供する。ゲームやHUDの型をimportしない。 |
| `src/input/key-mapping.ts` | 生キーとアクションの対応を定義する。 |
| `src/game/game.ts` | `Input`の消費順序を`GameInputRouter`へ移す。 |
| `src/game/camera/camera-system.ts` | カメラ操作をsnapshotまたはカメラ用commandから読む。 |
| `src/game/view/combat-view.ts` | combat専用commandの受付へ移す。 |
| `src/game/view/map-view.ts` | map専用commandの受付へ移す。 |
| `src/game/plan/plan-editor.ts` | Δv編集・計画破棄の入力をcommandへ移す。 |
| `src/game/player/player.ts` | 操作・射撃の入力をcommandまたはcontrollable用actionへ移す。 |
| `src/game/player/fire-control.ts` | 発砲入力の判定をaction境界へ移す。 |
| `src/game/player/throttle.ts` | スロットル入力の判定をaction境界へ移す。 |
| `src/game/dynamic/dynamic-entity/base.ts` | 基地操作の入力をcontrollable用actionへ移す。 |
| `src/game/dynamic/dynamic-system.ts` | active controllableへcommandを渡す。 |
| `src/game/dynamic/sim-speed-manager.ts` | ワープ変更commandを受ける。 |
| `src/game/targeter.ts` | ターゲット切替commandを受ける。 |
| `src/game/hud/touch-controls.ts` | 仮想キーをraw inputへ変換し、ゲームロジックへ直接侵入しない。 |
| `src/hud/overlay-manager.ts`、`src/hud/windows/pause-menu.ts` | オーバーレイが入力を先取りする契約を維持する。 |
| `src/game/input/game-input-router.ts`（新規） | オーバーレイ、Launcher、ゲームビュー、プレイヤーの優先順位を明示する。 |
| `src/game/input/game-actions.ts`（新規） | ゲームが読むアクション状態を定義する。 |
| `src/game/input/game-commands.ts`（新規） | 1回限りの操作を表すcommand型を定義する。 |

#### 実装方法

- `Input.update()`は押下・解放・ポインタ移動・ホイールを収集し、同じフレームに全読者が参照できるsnapshotを生成する。
- オーバーレイのショートカット、pause、Launcherのrestart、ビュー切替、計画編集、機体操作の優先順位を`GameInputRouter`に記述する。
- 連続入力はaction状態、一度だけ処理する入力はcommandとして扱う。
- 移行中だけ旧`takeKey` APIをadapterから使い、全利用箇所が新APIへ移った時点で旧APIを削除する。

#### 達成条件と検証

- `rg -n "takeKey\(|takeKeys\(" src/game src/launcher src/hud` の結果が、raw input adapter以外で0件になる。
- `Input`が`src/game`、`src/hud`、`src/launcher`をimportしない。
- `GameInputRouter`のテストで、pause、overlay shortcut、restart、view切替、fire、time warpの優先順位を固定する。
- `npm run typecheck`、`npm run test:game`を通す。
- `npm run smoke:browser`で、キーボード、右ドラッグ、ホイール、タッチ操作、オーバーレイ表示中の入力遮断を確認する。

### 5. Launcher、保存、ランライフサイクルを状態機械として分離する

#### 目的

タイトル選択、Game生成、Game破棄、セーブ復元、スロット切替、結果表示、再出撃を明示的なラン状態として管理する。非同期遷移の二重実行と、セーブ層への`Game`具象依存をなくす。

#### 変更が必要な箇所

| ファイル | 変更内容 |
| --- | --- |
| `src/launcher/launcher.ts` | `game`と`transitioning`の組み合わせをラン状態機械へ移し、タイトル・ロード・プレイ・結果の遷移だけを管理する。 |
| `src/launcher/stage-select.ts` | ステージ選択を状態遷移の入力として返す。 |
| `src/launcher/result-screen.ts` | 結果表示と再出撃・タイトル復帰のcommandを分離する。 |
| `src/launcher/snapshot-controls.ts` | 保存操作の受付と保存データ供給を分離する。 |
| `src/launcher/save-browser/save-browser.ts` | 現在ランの要約・pause/resume・load操作だけを受ける契約にする。 |
| `src/launcher/save/snapshot-service.ts` | `Game`ではなく`GameSaveData`、`RunSummary`、snapshot metadataを扱う。 |
| `src/launcher/save/autosave.ts` | 保存タイミング判定とデータ取得を分離する。 |
| `src/launcher/save/save-slots.ts` | スロットの永続化とラン状態の記録を分離する。 |
| `src/launcher/save/save-store.ts` | localStorageのI/Oだけを所有する。 |
| `src/game/run-summary.ts` | ラン要約の入力を専用read modelへ整理する。 |
| `src/game/save/save-data.ts` | ゲーム内セーブ形式の正本を保持し、Launcherの遷移ロジックを入れない。 |
| `src/launcher/run-state.ts`（新規） | `title`、`loading`、`playing`、`result`、`failed`を表す。 |
| `src/launcher/run-lifecycle.ts`（新規） | Gameの生成・破棄・遷移中の再入防止を所有する。 |
| `src/launcher/save/game-snapshot-source.ts`（新規） | 保存に必要な`GameSaveData`と`RunSummary`だけを供給する。 |
| `tests/launcher/run-lifecycle.test.ts`（新規） | 非同期遷移、二重起動、再出撃、スロット切替を検証する。 |

#### 実装方法

- `Launcher`は`RunState`を1つだけ正本として持ち、状態から許可される操作を判定する。
- `RunLifecycle`はGame生成の失敗時に旧Gameを残さず、ロード中にrestartやslot switchを受け付けない。
- `SnapshotService`へは`Game`を渡さず、`Game.serialize()`の結果と`runSummary(game)`の結果をcomposition rootで渡す。
- `SAVE_VERSION`と既存のlegacy migrationは変更しない。

#### 達成条件と検証

- `src/launcher/save/` と `src/launcher/save-browser/` が`Game`をimportしない。
- `rg -n "transitioning|game: Game|capture\(.*Game" src/launcher/save src/launcher/save-browser`で、保存層の具象Game依存が0件になる。
- `tests/launcher/run-lifecycle.test.ts`で、title→loading→playing、playing→result、result→loading、loading失敗、二重遷移を検証する。
- `npm run typecheck`、`npm run test:game`を通す。
- 既存セーブ、legacy save、手動snapshot、自動snapshot、slot switch、再出撃をブラウザスモークで確認する。

### 7. ファイル構成、テスト構成、依存境界検査を整備する

#### 目的

責務分離後のファイル配置を固定し、今後の機能追加で依存境界が再び崩れることを自動検出する。大きなファイルを行数だけで分割せず、責務の名前がディレクトリから読める構成にする。

#### 変更が必要な箇所

| ファイルまたはディレクトリ | 変更内容 |
| --- | --- |
| `src/game/runtime/`（新規） | GameのフェーズCoordinatorとframe stateを配置する。 |
| `src/game/input/`（新規） | action、command、ゲーム入力ルーターを配置する。 |
| `src/game/pickable/` | entity inspection adapterを配置し、エンティティ本体からUI実装を外す。 |
| `src/game/hud/` | ゲーム固有の表示Presenterとread modelを配置する。共通DOM部品は`src/hud/`に置く。 |
| `src/launcher/` | ラン状態、ライフサイクル、保存I/O、タイトル・結果の責務を分ける。 |
| `src/render/` | 雲を除く描画入力契約をゲーム型から分離する。雲構造は変更しない。 |
| `tests/run.ts` | `launcher`、`input`、`hud`のテストグループを選択できるようにする。 |
| `tests/launcher/`（新規） | ラン遷移と保存境界のテストを配置する。 |
| `tests/input/`（新規） | action、command、入力優先順位のテストを配置する。 |
| `tests/hud/`（新規） | read modelと表示境界のテストを配置する。 |
| `package.json` | `test:launcher`、`test:input`、`test:hud`を追加する。 |
| `tools/check-boundaries.mjs` | forbidden import、旧API、生成ファイルの参照方向を検査する。 |
| `tools/dep-metrics.mjs` | リファクタリング前後の依存近傍を比較できる状態を維持する。 |
| `scratch/` | 再利用する実験だけを`tools/experiments/`へ移し、不要な実験は削除候補として明示する。 |
| `src/**/*.generated.ts` | 生成元スクリプト、生成物、手編集禁止をファイル先頭コメントと検査で明示する。 |
| `docs/`、`tests/dist/`、`.render-lab/`、`.cloud-lab/` | 生成物をソース変更と混ぜず、既存のignoreと生成手順を維持する。 |

#### 実装方法

- 新しいディレクトリは責務が複数のファイルで成立した場合だけ作る。1つの関数を移すためだけの薄いフォルダは作らない。
- 500行超のファイルは、独立した責務がある場合だけ分割する。手続き的なモデルビルダーや生成データは行数だけで分割しない。
- テストランナーへlauncher/input/hud層を追加し、対象層だけを実行できるようにする。
- `check-boundaries.mjs`を`npm run ci`へ追加し、禁止import・旧入力API・保存層のGame依存を継続的に検査する。
- `src/assets`のランタイムアセット、`assets-src`の入力データ、生成TypeScript、`docs`の配信物を混同しない配置とする。

#### 達成条件と検証

- `npm run dep-metrics`で、`src/game/game.ts`のctx2近傍行数とファイル数が基準コミットより減少する。
- `npm run check:boundaries`が成功し、禁止方向のテストfixtureを与えた場合に失敗する。
- `npm run typecheck`、`npm run test:math`、`npm run test:physics`、`npm run test:game`、`npm run test:render`、新設するlauncher/input/hudテストを通す。
- `npm run build`で`docs/`への本番ビルドが成功する。
- `git diff --check`が成功し、生成物・実験ファイル・既存の未追跡メモがリファクタリング差分へ混入していない。

## 見積り

時間は実装後に実測へ置き換える。初期見積りは、変更対象の依存境界、Coordinator、adapter、テストを単位にした概算である。

| 作業 | 導出式 | 概算 |
| --- | --- | ---: |
| ゲーム・HUD・描画境界 | 10境界群 × 0.5時間 + 統合検証2時間 | 7時間 |
| Gameフェーズ分割 | 4 Coordinator × 1.5時間 + 時刻・順序テスト3時間 | 9時間 |
| エンティティ表示責務 | 3エンティティadapter × 2時間 + DynamicSystem整理4時間 + 回帰3時間 | 13時間 |
| 入力command化 | 7主要入力経路 × 1時間 + 移行・優先順位テスト5時間 | 12時間 |
| Launcher・保存境界 | 3ラン状態群 × 1.5時間 + snapshot回帰4時間 | 8.5時間 |
| 構成・検査・テスト基盤 | 4テスト層 × 1時間 + 境界検査3時間 + 整理3時間 | 10時間 |
| 合計 | 7 + 9 + 13 + 12 + 8.5 + 10 | 59.5時間 |

各作業は独立コミット可能な大きさへ保ち、1回の実装で全作業を混ぜない。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 | 対策 |
| --- | --- | --- | --- |
| HUDへ渡す値の時刻が1フレームずれる | HUD、軌道分析、予測表示が不一致になる | ゲーム・HUD境界、`npm run smoke:browser` | `DisplayFrame`の生成時点を固定し、reader更新とpredictor更新の順序をテストする |
| `GameContext`の代わりに別名の巨大contextが生まれる | 依存グラフと変更範囲が改善しない | 新規portとCoordinator | 各portの利用者を1機能へ限定し、不要な値を含めない |
| PlayerとEnemyを共通化しすぎる | 射撃・損傷・バランス調整が同時変更される | エンティティadapter設計 | 表示契約だけを共有し、ゲーム挙動は各具象型へ残す |
| `Input`のedge消費順序が変わる | pause、fire、restart、計画編集が同じキーを奪う | 入力ルーターの優先順位テスト | 旧APIとの比較テストを作り、command生成順を固定する |
| Game破棄中に非同期ロードが完了する | 古いランが新しいランへ資源やcallbackを書き込む | Launcherのロード失敗・slot switch | `RunLifecycle`に世代番号またはキャンセル境界を持たせる |
| `dispose`順序が変わる | GPU、DOM、イベントリスナー、音声が残る | `Game.dispose`、再出撃スモーク | 所有者が生成・破棄を持ち、既存の逆順をテストする |
| Entity effects portの変換漏れ | 撃破音、通知、VFXだけが消える | Player/Base/Enemyの接触・撃破テスト | 旧具象型の呼び出しをport実装へ1対1で対応させ、各当事者の回帰テストを追加する |
| 雲関連の対象外ファイルを同時に変更する | 視覚回帰と責務境界の混線が起きる | `git diff -- src/render/cloud` | 雲関連を対象外とし、雲関連の差分が0件であることを確認する |
| 生成物やユーザー作業中のメモをcommitする | 意図しないデータ変更が残る | `git status`、`git diff --cached` | `git add`対象を計画書と実装対象へ限定する |

## レビューで追加したタスク

計画の自己レビューで、当初の「アプリケーション境界のテストを追加する」という記述だけでは、既存の4層テストランナーから実行できないことが分かった。次のタスクを追加する。

- `tests/run.ts`へ`launcher`、`input`、`hud`の実行グループを追加する。
- `package.json`へ`test:launcher`、`test:input`、`test:hud`を追加する。
- `tsconfig.test.json`へ新しいテストディレクトリを含める。
- `tools/check-boundaries.mjs`へ禁止方向を検査するfixtureまたは一時入力を追加し、検査自身が壊れていないことをテストする。
- `Game`フェーズ分割前に、入力優先順位、表示時刻、セーブ復元、dispose順序を固定するcharacterization testを追加する。
- 新規Coordinatorとentity inspection adapterが単なる委譲wrapperになっていないことを、各実装コミットのレビュー条件へ追加する。

この追加により、リファクタリング後に「型検査だけは通るが、Launcher・入力・HUDの境界が壊れている」状態を検出できる。

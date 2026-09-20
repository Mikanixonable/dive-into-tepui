# 船体建造 UI 完成実装計画

作成日: 2026-09-19  
実装の現在基準コミット: `884e6720c`  
状態: 実装・変更層検証完了（実機確認未実施）

## 目的

既存の `ShipConstruction`、船体建造パネル、ゴースト描画、船体構造操作を、実際のゲーム画面から
開始・操作できる状態へ接続する。仕様上の建造モードとして、次の一連の操作を完成条件とする。

1. 操作対象の船体から健全な建造ドックを選び、戦闘ビューで建造を開始できる。
2. 建造中はシミュレーションと表示時刻を現在へ固定し、カメラ操作と建造操作だけを受け付ける。
3. モジュールカタログから部品と取り付け位置を選び、候補ゴーストをクリック／タップして配置できる。
4. 自由端から末尾部品を撤去できる。
5. ESC または建造終了で編集だけを閉じ、途中の船体を保持できる。
6. 船体破棄は確認後だけ実行し、操縦不能な物資として分離する場合も確認を要求する。

## 現状確認

- `src/game/ship/ship-construction.ts` に開始、候補計算、追加、撤去、破棄、ゴースト同期、パネル同期がある。
- `src/game/hud/panels/ship-construction-panel.ts` と `src/game/hud/hud-root.ts` に操作パネルの器がある。
- `src/render/dynamic/ship/ship-ghost-view.ts` と `dock-snap-guide-view.ts` に候補描画がある。
- `src/game/pickable/module-windows.ts` に建造ドックの「船体を建造」操作がある。
- ただし、`GamePresentation` に `ShipConstruction` と `ModuleWindows` の実体生成がなく、建造開始までの UI 経路が未接続である。
- `ShipConstruction.handlePointer()`、`ShipConstruction.sync()` はゲームループから呼ばれていない。
- `gameInputMode()` は存在するが、建造中の実入力ルーティングには接続されていない。
- 現在の `finish()` は建造枝を `launchConstruction()` で分離するが、仕様上の「建造終了」は編集を閉じるだけである。
- パネルは現在左レールに構築されているが、UI仕様では右レールが正本である。

## 実装手順

### 1. 実行時の生成・ライフサイクル配線

対象:

- `src/game/game-presentation.ts`
- 必要に応じて `src/game/pickable/object-windows.ts`
- 必要に応じて `src/game/pickable/module-windows.ts`

実施内容:

- `Hud` の `shipConstructionPanel`、`OverlayManager`、`DisplayWindowManager`、`EntityRegistry`、`Notifier` を使って `ShipConstruction` を composition root で生成する。
- `ModuleWindows` を生成し、`ShipConstruction` と操作対象選択、entity registry、戦闘ビュー切り替え関数を渡す。
- `ObjectWindows` からモジュール窓を開くための narrow port を追加する。`ObjectWindows` が `ModuleWindows` の具体実装へ依存し続けないよう、必要ならモジュール関連項目の callback 契約を切り出す。
- ラン終了時は `ModuleWindows.close()`、`ShipConstruction.dispose()` の順で確実に片付ける。
- 建造開始時の `focusDock` callback を `CameraSystem` の戦闘ビュー用フォーカス命令へ接続する。

完了条件:

- `ShipConstruction` と `ModuleWindows` が1ランにつき1個だけ生成される。
- ラン終了後にゴースト、ガイド、パネル、モジュール窓、オーバーレイが残らない。
- 型検査で循環依存や port の不整合がない。

### 2. 建造開始までの UI 経路

対象:

- `src/game/pickable/ship-inspection.ts`
- `src/game/pickable/object-windows.ts`
- `src/game/pickable/module-windows.ts`
- `src/hud/windows/property-window-related-items.ts`

実施内容:

- 操作対象の艦プロパティ窓に搭載モジュール一覧を表示する。
- 各モジュール行から `ModuleWindows.open(ship, moduleId, clientX, clientY)` を呼べるようにする。
- モジュール窓の内容を毎フレーム再生成し、ドックの状態を `empty` / `building` / `connected` に合わせて「船体を建造」「建造を再開」「接続船体を修理」「切り離し」を出し分ける。
- マップビューのプロパティ窓から建造を始めた場合も、`enterCombatView()` を通して戦闘ビューへ切り替える。
- 非操作対象艦のモジュールを誤って建造操作へ使えないよう、仕様上の操作対象・player所属条件を確認する。

完了条件:

- 戦闘ビュー、マップビュー、タッチ操作のいずれからも、健全で空いている建造ドックの開始項目へ到達できる。
- 破損ドック、接続済みドック、操縦不能な船体の不正開始が通知で拒否される。
- 建造開始後は開始元のモジュール窓と建造パネルの状態が矛盾しない。

### 3. 毎フレーム同期と入力優先順位

対象:

- `src/game/game-presentation.ts`
- `src/game/input/game-input-router.ts`
- `src/game/input/game-input-ports.ts`
- `src/game/view/view-frame.ts` 周辺の pointer 配布

実施内容:

- `sync()` のカメラ確定後に `ShipConstruction.sync(camera)` を呼び、ghost と snap guide を現在の物理状態へ同期する。
- `handleInput()` の pointer 段で、建造中は `ShipConstruction.handlePointer()` を通常ビューの `handlePointer()` より先に呼ぶ。
- 建造中のクリックは候補配置または右クリック消費だけを行い、通常のピック、射撃、ターゲット変更、計画編集へ流さない。
- `gameInputMode()` の契約を実際の入力配布へ接続し、建造中はカメラと建造操作のみ有効にする。
- 建造中の ESC は既存の `OverlayManager.closeTopmostOnEscape()` を通して編集セッションだけを閉じる。独自の document listener は追加しない。
- `ShipConstruction.close()` 後に候補描画、パネル、force-current 状態が元へ戻ることを確認する。

完了条件:

- 有効候補をクリック／タップすると1回だけ配置される。
- 建造中に飛行、射撃、ワープ、ターゲット変更、通常ピックが発生しない。
- カメラ回転・ズームは継続して使える。
- ESC の多重入力やオーバーレイの重なりで、部品が二重配置されない。

### 4. 時間停止と建造状態の仕様整合

対象:

- `src/game/ship/ship-construction.ts`
- `src/game/display-window-manager.ts`
- `src/game/game-presentation.ts`
- `src/game/hud/panels/ship-construction-panel.ts`

実施内容:

- 建造開始時にシミュレーションを停止し、表示時刻を `simTime` に固定する。既存の pause／overlay 契約と競合しない narrow port を選ぶ。
- 建造終了または ESC 時に、建造開始前の表示窓・一時停止状態を復元する。
- 「建造終了」と「発進／分離」を分離する。建造終了は編集セッションと建造予約を閉じるだけにし、追加済み枝は接続されたまま残す。
- 建造中の部品を破棄する操作は「建造を破棄」として独立させ、確認後に追加部品だけを取り除く。
- 操縦不能な物資を分離する操作が別に存在する場合は、`launchConstruction()` をそちらだけから呼ぶ。確認文言も「完成して発進」から仕様に沿った表現へ直す。
- 建造パネルの完成条件表示を、部品数、構造妥当性、物資確認の要否と一致させる。

完了条件:

- 建造中に `simTime` が進まない。
- ESC／建造終了で建造枝が消えず、再開時に同じドラフトを編集できる。
- 破棄確認をキャンセルした場合、部品・ドラフト・接続状態が変わらない。
- 物資分離の確認をキャンセルした場合、船体は元の接続状態に残る。

### 5. UI配置・入力デバイス・アクセシビリティの整合

対象:

- `src/game/hud/hud-root.ts`
- `src/game/hud/style/ship-construction-style.ts`
- `src/game/hud/panels/ship-construction-panel.ts`
- 共通 widget 実装

実施内容:

- 建造パネルを仕様どおり右レールへ移動する。戦闘ビューでのみ表示し、建造中以外は畳む。
- モジュールカタログ、取り付け位置、配置、末尾撤去、建造終了、船体破棄の全操作をマウス・キーボード・タッチで実行できることを確認する。
- ボタンの無効状態を候補の有効性、撤去可能性、完成可能性と同期する。
- warning、完成時の役割、能力集計が狭い画面幅でも読めるよう CSS を調整する。
- 建造開始中に通常の右レール／左レールの折りたたみ操作が建造操作を妨げないことを確認する。

完了条件:

- UI仕様の右レール配置と一致する。
- タッチだけで開始から配置、撤去、終了、破棄、確認・取消まで到達できる。
- `aria-label`、`aria-disabled`、フォーカス移動が既存 widget 契約に沿う。

### 6. テストと検証

追加・更新するテスト:

- `tests/game/ship-construction.test.ts`
  - 建造開始条件
  - 軸方向・側面候補の変換
  - 側面スロット重複拒否
  - 追加・末尾撤去
  - ドラフト保存・再開
  - 建造終了で接続を保持
  - 破棄確認の承認・取消
  - 物資分離確認の承認・取消
- `tests/game/construction-input-routing.test.ts`
  - 実ルーター接続後の建造中入力優先順位
  - 通常のワールド操作・シミュレーション入力の遮断
- 必要に応じて `tests/render/ship-construction-ghost.test.ts`
  - 建造セッションの同期・非表示遷移
  - カメラ原点変更時の候補位置
- HUD／window wiring の DOM テスト
  - モジュール窓から建造開始 callback が呼ばれること
  - 建造パネルの表示・ボタン状態同期

検証コマンド:

- `npm run typecheck`
- `npm run test:game`
- `npm run test:render`
- UI配線変更が既存 HUD 契約へ影響した場合は関連する全テストを追加実行する。
- 実機の開始から配置・終了・再開・破棄を確認するときは、ユーザーが実行時確認を求めた段階で `npm run smoke:browser` を使う。

## 実装順と依存関係

```text
1. 生成・ライフサイクル
        ↓
2. 建造開始 UI 経路
        ↓
3. 毎フレーム同期・入力
        ↓
4. 時間停止・終了／分離の仕様整合
        ↓
5. UI配置・タッチ・アクセシビリティ
        ↓
6. テスト・検証
```

1〜3が建造UIを到達可能にするP0、4がゲーム仕様のP0、5がUI仕様のP1、6が完成判定に必要な検証である。
4の「建造終了で分離しない」は挙動を変えるため、既存の `vessel-assembly-dock-construction-plan_2026-09-14.md`
で意図されたMVPとの差分を実装前に確認する。

## 完成判定

- 新規ランで、艦のプロパティから健全な建造ドックを選んで建造を開始できる。
- 候補ゴーストの有効／無効表示が正しく、クリック／タップで追加できる。
- 追加・撤去・能力集計・役割表示が同じ `ShipAssembly` の状態を読む。
- 建造中はカメラと建造操作だけが有効で、シミュレーションと表示時刻が現在に固定される。
- 建造終了・ESC・破棄・物資確認の各分岐が仕様どおりである。
- `npm run typecheck`、変更層の回帰テストが通る。
- 実機確認を行った場合、開始から終了までの操作経路を記録してから計画を完了扱いにする。

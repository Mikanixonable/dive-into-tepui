# `game.ts` 依存境界・段階的リファクタリング計画

作成日: 2026-08-14

対象: `src/game/game.ts`、`map-picker.ts`、`docking.ts` と周辺の `Game` 参照

前提: 挙動、セーブ形式、公開 URL、更新順序を変更しない構造リファクタリングである。`memos/mikanixonable/dev.md` は変更しない。

## 結論

先の指摘は一部妥当である。

- `Game` が物理・描画・UI・入力の具体クラスを import すること自体は問題ではない。`Game` は現状、生成・配線とフレーム順序を所有する composition root でもあるためである。
- ただし `Game` を受け取る `MapPicker` と `Docking` は、必要な数個の機能ではなく `Game` 全体へ逆依存している。この結合は妥当な改善対象である。
- `HudPanels`、保存系も `Game` の読み取りに依存するが、いま一括して `GameSession` / 多数の Coordinator へ分解するのは過剰である。更新順・pause・保存の境界を同時に動かすことになり、得られる利益に対して回帰リスクが大きい。

したがって、まず `Game` をフレーム順序のオーケストレータとして残したまま、逆依存と構築順の循環だけを解消する。その後も変更理由が増え続ける場合にのみ、表示同期または保存読み取りモデルを追加で分離する。

## 調査結果

### `game.ts` の import

`game.ts` には 41 本の import がある。内訳は以下のとおりである。

| 種類 | 例 | 判断 |
| --- | --- | --- |
| セッションの中核状態 | `Ephemeris`、`EntityManager`、`Simulator`、`Stage` | `Game` が生成・進行を管理する現状では妥当 |
| 表示・操作の協調役 | `CameraSystem`、`PlanEditor`、`ViewManager`、`Targeter` | 同一フレームで順序を調停するため妥当 |
| 表示・入力アダプタ | `Hud`、`GameScene`、`Input`、`Sfx` | 最上位の組立地点が知るのは妥当 |
| 低レベルの補助 | `v3`、`focusPoint`、`KEY_MAPPING`、`SIM_EPOCH_*` | 粒度は細かいが、現段階で抽象化するほどの反復・交換可能性はない |

よって import 数や抽象化階層の不統一を、単独のリファクタリング理由にはしない。とくに `Ephemeris` / `Simulator` を汎用 interface に隠すこと、または import を barrel に寄せることは行わない。

### 実害のある逆依存

次の 7 モジュールが `Game` 型を直接参照している。

| 利用側 | `Game` から実際に使うもの | 評価 |
| --- | --- | --- |
| `MapPicker` | 操作対象、操作対象の変更、ステージ capability、フォーカス、時刻 | 分割対象。`Game` 全体は不要 |
| `Docking` | pause/resume、操作対象、操作対象の変更、ステージ設定 | 分割対象。`Game` 全体は不要 |
| `HudPanels` | HUD に表示する多数の読み取り値 | 読み取り境界。後続候補 |
| `SnapshotService` | セーブ対象の状態全体 | 読み取り境界。後続候補 |
| `AutoSave` | pause と stage 状態 | 小さい読み取り境界。後続候補 |
| `SaveBrowser` | pause/resume と stage 状態 | 小さい読み取り境界。後続候補 |
| `SnapshotControls` | stage 状態と snapshot 実行 | 後続候補 |

`MapPicker` は `Game` から `FrameControls`、`ActivePlayerController`、`Stage`、現在時刻を辿る。一方、`ActivePlayerController` は `MapPicker.close()` を呼ぶため、構築順も `MapPicker → ActivePlayerController → MapPicker` の形に固定されている。

`Docking` は `Game` からしか得ていない状態がなく、必要な所有者を直接渡せる。ここは低リスクで分離できる。

### 維持すべき実行順

以下はゲーム仕様として保持する。

1. 入力スナップショットを確定し、global input を優先順に配る。
2. pause 中でなければ player → stage → integrate → predict → effects → plan の順に進める。
3. 表示窓、環境、計画、pickable、カメラを更新してから pointer input を配る。
4. `sync()` ではカメラ行列、環境・entity、HUD・marker の順に同期し、marker collision を最後に解決する。
5. dock view 中は renderer を呼ばない。

現在の baseline では未解決の競合マーカーにより `npm run typecheck` が失敗する（`creative-stage.ts`、`stage-debug.ts`、`stage00.ts`）。この解消は本計画とは別変更として先に必要である。

## 実装計画

### Phase 0 — baseline と振る舞いの固定

1. 競合マーカーを別変更で解消する。本リファクタリングと混ぜない。
2. `Game.update()` / `sync()` の上記順序を、既存コメントとテストまたは検証チェックリストで固定する。
3. map 上の艦選択・削除、ドックへの収容/発進、pause、snapshot、dock view の手動確認を記録する。

受入条件: `npm run typecheck`、`npm run test:physics`、`npm run build`、`npm run smoke:browser` が通る baseline を得る。

### Phase 1 — `MapPicker` の `Game` 逆依存を解消する

1. `ActivePlayerController` から `MapPicker` 参照を外す。艦の削除時に閉じるべき選択 UI は `MapPicker.refresh()` / `sync()` が生存確認で掃除する責務へ移す。現在の `close()` が「全 UI を閉じる」のか「削除対象のみを閉じる」のかを characterization してから変更する。
2. `FrameControls` を `MapPicker` より先に生成する。必要な依存は `Ephemeris`、overview camera、display window であり、`MapPicker` を必要としない。
3. `ActivePlayerController` を `MapPicker` より先に生成し、`MapPicker` には controller を直接渡す。
4. `MapPicker` の `Game` 引数を削除し、次を直接渡す。
   - `ActivePlayerController`: `current` の参照と操作対象の変更
   - `Stage`: `executesPlans` と `authoring` の判定
   - `FrameControls`: フォーカス変更
   - 既存の `CameraSystem`、`EntityManager`、`Ephemeris` など
5. auto-warp の時刻には、すでに `refresh()` で保持している `lastSimTime` を使う。イベント処理時点の simulation time を引数で渡す必要があると判明した場合だけ、その値を個別引数として渡す。

受入条件:

- `map-picker.ts` が `Game` を import しない。
- 操作対象の切替・解除・死亡・削除後、カメラ、計画、ターゲット、property window が従来どおり更新される。
- creative stage の authoring と plan 実行可否が変わらない。

### Phase 2 — `Docking` の `Game` 逆依存を解消する

1. pause 状態と `pause()` / `resume()` の副作用を `SessionControl` に抽出する。これは `Simulator.lastSimDt`、SFX、現在の player command を扱う小さな所有者とし、汎用サービス集合にはしない。
2. `Game.pause()`、`Game.resume()`、`Game.isPaused` は互換性を保つため当面 `SessionControl` へ委譲する。
3. `Docking` には `SessionControl`、`ActivePlayerController`、`Stage`、既存の entity/camera/view 依存を直接渡す。
4. `Docking` から `Game` import を削除する。dock へ入る・出る・艦を建造する・収容して操作対象を引き継ぐ処理の順序は変えない。

受入条件:

- `docking.ts` が `Game` を import しない。
- dock view を開くと pause され、閉じると従来どおり resume する。
- 収容で操作対象が消えた場合の引継ぎと map view への遷移が維持される。

### Phase 3 — import 意図を明確化し、結果を評価する

1. `game.ts` で型としてのみ用いる import を `import type` へ分離する。候補は `Player`、`Stage` / `StageClass`、`GameSaveData`、`GameScene`、`Hud`、`Sfx`、`SettingsPanel`、`PerfMeter`、`FrameSections` である。実際の TypeScript の値使用を確認してから個別に行う。
2. `Game` に残る責務を「構築・所有」と「フレーム大順序」に限定できているか確認する。ここでは `Game` の具体 import 数や行数を目標にしない。
3. Phase 1–2 後も `Game` を変更する理由が HUD、保存、表示同期のどれかへ明確に偏る場合だけ、次の小変更を別計画として起票する。
   - HUD: `HudPanels.sync(game, ...)` を表示専用の read model に変更する。
   - 保存: `SnapshotService.capture(game, ...)` を `GameSnapshotSource` に変更する。
   - 表示同期: `sync()` の一部を presentation coordinator に抽出する。

この段階では `GameSession`、汎用 `GameContext`、DI container、event bus、全機能を一括移送する coordinator 群を導入しない。必要性が確認された境界だけを取り出す。

## 検証

各 phase で以下を実施する。

```sh
npm run typecheck
npm run test:physics
npm run build
npm run smoke:browser
```

加えて手動で確認する。

- map: 艦/基地/天体の選択、右クリックの property window、操作対象切替、艦削除。
- dock: 接近、enter/leave、建造、発進、収容、最後の操作対象を失う場合。
- lifecycle: pause 中もカメラと UI が更新され、simulation は進まないこと。
- save: 手動 snapshot、自動保存、save browser の開閉、既存 snapshot のロード。

## 完了条件

- `MapPicker` と `Docking` が `Game` 全体に依存しない。
- `Game` は一フレームの実行順とセッションの互換 API を維持する。
- HUD・保存・描画の全面再設計を、この変更へ混ぜない。
- baseline を含む検証が通り、セーブ schema と操作仕様に差分がない。

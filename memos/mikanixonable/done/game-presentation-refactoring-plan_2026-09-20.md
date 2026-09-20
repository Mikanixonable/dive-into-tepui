# GamePresentation リファクタリング計画

## 対象スナップショット

- 対象コミット: `6b3702b61`
- 対象: `src/game/game-presentation.ts`
- 現在の規模: 537 行。constructor 120 行、`sync` 101 行で、lint の `max-lines` / `max-lines-per-function` 警告が出る。
- 現在の作業ツリーにある `GamePresentation` 以外の未コミット変更は、この計画の対象に含めない。

## 目的

`GamePresentation` に同居しているランの構成・入力解釈・表示時刻とカメラの導出・表示同期・描画橋渡しを、責務とフレーム位相がコードの置き場から読める形へ分ける。`Run` から見たランのライフサイクルと、ゲームの観測可能な挙動は変えない。

## 決めたこと

- `src/run/run.ts` が持つ入力解釈 → 進行 → 進行後の導出 → 同期 → 描画という外側の位相順序は維持する。`GamePresentation` は当面、Run から呼ばれる façade とラン寿命の表示導出根として残す。
- 入力解釈は `src/game/runtime/game-input-phase.ts`、表示時刻・カメラ・予測後の候補更新は `src/game/runtime/display-phase.ts` へ移す。これらは既存の `Game`、`CameraSystem`、`ViewManager` などを明示的な依存として受け、値を寄せ集める `Context` / `Params` / `Options` 型は作らない。
- 表示同期は同期順自体が表示導出の責務なので、最初の段階では `GamePresentation` に残す。長い `sync` を「カメラと世界」「演出と対象」「窓・HUD・マーカー」の名前付き段へ分け、順序をコード上で確認できるようにする。
- constructor と `dispose` は、ラン寿命の部品を作り、逆順で破棄する所有者として `GamePresentation` に残す。行数だけを下げるために、単なる配線ラッパーや巨大な構成オブジェクトへ移さない。phase 抽出後も constructor が長い場合は、独立した寿命と責務を持つ所有グラフが本当にあるかを再判定する。
- `compile`、`render`、`perfCounts` は現在の責務が薄く、呼び出し側との橋渡しとして `GamePresentation` に残す。別モジュールへ移すのは、描画順や計測所有権を変更する設計上の理由が見つかった場合だけにする。

## 変えない挙動

- `Run.frame()` の位相順序を変えない。入力解釈の後に `game.advance()` が走り、その後に `resolveFrame()`、カメラ追従、進行後の導出、予測延長、表示候補更新、HUD/描画同期が走る。
- `dt` は進行へだけ渡し、表示導出・同期は `dt` を受け取らない。フレーム先頭の `nowMs` は入力・カメラ遷移・表示同期へ同じ値を渡す。
- `resolveFrame()` がビュー選択、表示窓、座標系の錨を確定し、`cameraSamples()` がその錨を使って進行側のカメラ追従材料を作る関係を保つ。
- `presentProgress()`、`trajectoryDemand()`、`update()` の順序と、計画・演出・カメラ・マップ候補の各 `FrameSections` 計測区間を保つ。
- 同期順を保つ。カメラ行列の確定、ラベル間引き、天体系/動的物体、建造表示、マーカー、演出・音、対象と航法ターゲット、プロパティ/計画/線、ビュー固有パネル、ステージ、HUD、マーカー重なり解決の依存順を変えない。
- 入力ポートの優先順位、オーバーレイの ESC、建造中のカメラ/建造操作だけを通す制限、タッチとポインタの候補判定を変えない。
- `Run.launch()` のウォームアップ順(`deriveAfterProgress` → `sync` → `compile` → `render`)、未同期時の `compile` の例外、未同期時の `render` の no-op、`dispose()` の逆順破棄、`perfCounts()` の返却項目を変えない。
- 仕様上の一時停止、決着後の進行、表示時刻とシミュレーション時刻の分離、建造中の表示制御を保存する。今回の計画では仕様変更や既存バグの修正を行わない。

## 達成目標

- `GamePresentation` から入力ルーター/パイロット入力の実装と、表示窓・カメラ・候補更新の実装がなくなり、対応するコードが `src/game/runtime/` の責務名から読める。
- `GamePresentation.sync()` は同期段の呼び出し順だけを示し、100 行以内になる。`sync` 内の前提順を説明するコメントは、分割後も各段の先頭に残す。
- `src/game/game-presentation.ts` は 500 行以内になる。constructor の警告が残る場合は、ラン寿命の所有者としての配線が一責務に収まっているかを確認し、行数だけを理由に新しいラッパーを作らない判断を最終報告へ残す。
- `Run` の公開呼び出し口を維持したまま、`rg` で旧処理が `GamePresentation` と新 phase の双方に重複していないことを確認できる。
- `npm run typecheck`、`npm run test:game`、`npm run check:boundaries`、変更ファイルへの ESLint、`git diff --check` が通る。

## 実施結果

- 入力解釈を `src/game/runtime/game-input-phase.ts` へ移し、`GamePresentation` の公開口は維持した。
- 表示窓・カメラ・進行後導出を `src/game/runtime/display-phase.ts` へ移し、`Run` の位相順と `FrameSections` の計測区間を維持した。
- `sync()` をカメラ、世界、演出/対象、パネル/マーカーの段へ分割した。
- `src/game/game-presentation.ts` は497行、`sync()` は100行未満。constructor は部品の生成・所有・逆順破棄を担う構成ルートとして残した。
- 実装コミット: `9db5493d7`、`0639d47f2`、`622bbc3b1`、`6271b72a2`。
- 検証: `npm run typecheck`、`npm run test:game`（296/296）、`npm run check:boundaries`、変更ファイルへの ESLint（error 0）、`git diff --check`。
- 実装基底のスナップショットは `1ebe43d4f`。既存の `Run`、`Input`/`TouchControls`、描画・計測・破棄の公開契約は変更していない。

## 見積り

- 手順 1: 入力 phase 1 ファイル + façade 委譲 + 回帰確認。実装 60〜120 分 + 検証 15〜30 分 = 75〜150 分。
- 手順 2: 表示導出 phase 1 ファイル + façade 委譲 + 時刻/順序確認。実装 60〜120 分 + 検証 15〜30 分 = 75〜150 分。
- 手順 3: `sync` の段分割と同期順レビュー。実装 45〜90 分 + 検証 15〜30 分 = 60〜120 分。
- 手順 4: 移動元の整理と最終検証。実装 30〜60 分 + 検証 30〜45 分 = 60〜105 分。
- 合計: `(75〜150) + (75〜150) + (60〜120) + (60〜105)` 分 = **270〜525 分(4.5〜8.75 時間)**。新しい統合テスト基盤や constructor の所有グラフ分割が必要になった場合は、この見積りを見直す。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `TouchControls` / `Input` / `ViewManager` の構築順を phase 抽出で変える | マップ・戦闘ビューのポインタ操作、長押し表示、カメラ入力が壊れる | 手順 1、`npm run test:game`、依存順レビュー |
| `Run.deriveAfterProgress()` の順序を phase の都合で並べ替える | 表示時刻、カメラ追従、予測、候補の同一フレーム整合が崩れる | 手順 2、`rg` による順序確認、ゲーム回帰 |
| `sync()` の天体系/動的物体/線/HUD/マーカーの順序を変える | 遮蔽判定、軌道線、建造ゴースト、マーカー重なり、HUD の表示が一フレーム遅れる | 手順 3、同期順レビュー、ゲーム回帰 |
| phase が `Game` や HUD の正本へ直接書き込む | R3/R8 の層境界を破り、入力や表示から進行状態を変更する | 手順 1〜3、`npm run check:boundaries` |
| 依存を隠すために `PresentationContext` のような寄せ集めを導入する | 依存方向と所有者が読めず、次の分割を困難にする | 手順 1〜4、型名検索、コードレビュー |
| `dispose()` を phase と root の両方で呼ぶ、または順序を変える | DOM リスナー、GPU 資源、マーカー、HUD パネルが残る/二重破棄される | 手順 4、dispose 順レビュー、typecheck |
| 作業ツリーの別変更を整理中に巻き戻す | ユーザーの別作業を失う | 全手順、`git status --short`、選択的 commit |

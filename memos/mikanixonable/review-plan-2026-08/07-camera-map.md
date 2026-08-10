# 章07: カメラ・マップ操作系のレビュー

単独実行可。他章に依存しない。

## 対象ファイル
- `src/game/camera/`: camera-system.ts / combat-camera-system.ts / chase-camera.ts / gunsight-camera.ts / overview-camera.ts / overview-camera-panel.ts / focus-markers.ts / focus-target.ts
- `src/game/map-picker.ts` / `map-pick.ts` / `nav-target.ts` / `view-manager.ts` / `targeter.ts`
- `src/game/marker/`: marker-manager.ts / grouped-markers.ts / lead-markers.ts / equator-node-markers.ts
- `src/game/input/input.ts` / `touch.ts`
- `src/physics/projection.ts` / `occlusion.ts`

## 手順
1. `git log --oneline HEAD~200..HEAD -- src/game/camera src/game/map-picker.ts src/game/marker src/game/input` で該当コミットを把握。
2. 観点:
   - **候補集合の一元性**: `MapPicker.pickables` が唯一のリスト(focus 解決・右クリック・object-list・property-window が全て同じフレームの同一配列を読む)。slice して別リストを持つ消費者は「メニューは開くが focus は Earth に飛ぶ」型バグの温床。
   - **クリック配線の優先順**: `PlanEditor.handleMapPointer` → `MapPicker.handleRightClick` の呼び順のみで優先を表現(相互参照なし)。`Input` の take* が first-come-first-served を守り、消費漏れ/二重消費がないか。ダブルクリックと単クリック2発の併存。
   - **near/far クランプ**: overview の near = shell×cos(対角半FOV)×margin、far のズーム追従クランプ — 式の実装と CLAUDE.md 記載の一致。ウィンドウリサイズ時の aspect/対角FOV 再計算。
   - **FocusTarget**: `'object'` の2フレーム欠落→Earth フォールバック、`'point'` の frame 乗り(回転フレームで点が動くか)。`clearFocusIf` が `'object'` のみ対象。
   - **マーカー規約**: 「各オブジェクトが自分のマーカーを自分の sync で」— `syncMarker` の分離公開が復活していないか。`hide` vs `remove` の使い分け(固定キー vs 増減キー)。`resolveCollisions` が最後に1回。
   - **quaternion カメラ**: ChaseCamera/OverviewCamera のドラッグ軸構成(現在basis)、`camFollowAttitude` トグル時の再解釈で視点ジャンプなし、破壊後のタンブル追従停止。
   - `headingRotationDeg` の `undefined` =「回さない・前回保持」規約の全呼び出し側整合。
3. macOS Command キー `releaseAll` 等、Input のエッジケース回り。

## 検証
- `npm run typecheck`
- `npm run test:physics`(projection.test.ts / occlusion.test.ts が含まれる)

## 出力
`findings/07-findings.md` にタグ付きで列挙。明白なバグ・規約違反は修正可。

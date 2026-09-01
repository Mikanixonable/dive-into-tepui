# 章09: ステージ・クリエイティブ・ドック系のレビュー

単独実行可。他章に依存しない。(save-browser は章04、汎用ウィジェットは章05の担当)

## 対象ファイル
- `src/game/stages/`: stage.ts / stage-dictionary.ts / stage0.ts / stage00.ts / stage1.ts / stage2.ts / stage-debug*.ts / creative-stage.ts / stage-utils/(logistics / score-counter / score-attack-timer / stage-status-panel)/ spawner/
- `src/game/creative/`: ship-placer-panel.ts / duplicate-form.ts / placement-validation.ts
- `src/game/docking.ts` / `src/game/hud/dock-view.ts` / `src/game/dynamic/dynamic-entity/base.ts`
- `src/game/launch-select.ts` / `game-mode.ts` / `unlock-manager.ts` / `main.ts`(resolveLaunchSelection)

## 手順
1. `git log --oneline HEAD~200..HEAD -- src/game/stages src/game/creative src/game/docking.ts src/game/hud/dock-view.ts` で該当コミットを把握。
2. 観点:
   - **phase 保護**: `recordPlayerLost`/`recordEnemyDeath` の `isPlaying` ガード(勝敗同フレーム競合で won→lost 上書きしない)。restart/`?stage=` の経路。
   - **Docking 遷移**: dock 時の `parkPlayer`(dispose しない)+`obj.visible=false`+アクティブ艦なら SFX 強制停止。launch の逆順(visible は syncPlayer 任せ)。`DockedShipEntry.parts` が参照共有・`hp/maxHp` がスナップショットという二重構造の書き戻し漏れ。
   - **dock-view 経済**: `SHOP_CATALOG` が `PLAYER_MASS`/`THROTTLE_LEVELS` 導出値か(literal 直書きの桁ズレ再発)。金額の負値ガード、buy/swap/repair/refuel/新造の debit と在庫の整合。修理が `refreshFromParts` を通るか。
   - **CreativeStage**: `placeObject` の4分岐と fallback 名、`CREATIVE_MAX_SHIPS`、preview の毎フレーム再導出(onChange なし)規約。duplicate の hyperbolic/検証失敗時のフォーム不通過。`isCreativeMode()` の `as any` キャスト — 型的にまともにできるなら `[refactor]`。
   - **Logistics**: 二重ゲート(`resupplyEnabled` × `canResupplyAmmo`)、ブロック中のタイマー非進行、scripted spawn のゲートバイパス。マーカーキーの詰め直し(欠番なし)。
   - **stage00 wave 機械 / stage-debug-load**: 決定論 seed、`checkWin` 恒偽が UnlockManager を汚さないか。
   - **launch 解決**: `?title=1` → URL ショートカット → active slot → title の優先順、`isResumableStage`(hiddenFromSelect/unlock 検査)。
3. dock-view は one-shot modal(innerHTML 再構築可)だが、`prompt()`/名前のエスケープと `pointer-events` は確認。

## 検証
- `npm run typecheck`

## 出力
`findings/09-findings.md` にタグ付きで列挙。明白なバグ・規約違反は修正可。経済バランスの疑義は報告のみ。

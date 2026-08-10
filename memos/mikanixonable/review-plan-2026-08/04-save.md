# 章04: セーブ系のレビュー

単独実行可。他章に依存しない。

## 対象ファイル
- `src/game/save/`: save-store.ts / save-slots.ts / snapshot-service.ts / autosave.ts / save-transfer.ts / legacy-save.ts / ephemeris-context.ts
- `src/game/save-data.ts`
- `src/game/hud/save-browser.ts`
- 各エンティティの `serialize()` / `static restore(...)`: `src/game/game-entity/*.ts`、`src/game/player/player.ts`、`src/game/stages/stage.ts`(`Stage.restore`)、`src/game/game.ts` の `Game.restore`

## 手順
1. `git log --oneline HEAD~200..HEAD -- src/game/save src/game/save-data.ts src/game/hud/save-browser.ts` で該当コミットを把握。
2. 観点:
   - **serialize/restore の往復性**: 各クラスで save→restore がフィールドを落とさないか(特に新設フィールド: `planExecution`、radiator wear、parts、`Ephemeris` phase offsets = `ephemeris-context.ts`)。restore 後の id 採番衝突(`EntityIdAllocator` の追い越し)。
   - **retention の一軸性**: `pinned` のみで保持判定。auto ring buffer(12)/pinned 上限(30、拒否であって追い出しでない)。クリップ時に `kind` を書き換えていないか。
   - **quota 失敗経路**: `addSnapshot` の retry-with-drop、`importSlot`/`duplicateSlot` の失敗時ロールバック。書き込み例外は素通し・読みは null という非対称が守られているか。
   - **restore の凍結バグ再発**: `phase !== 'playing'` の snapshot を書かない F5/autosave ガード。`SaveSlots.discardAfter`(restore 後の未来破棄)。
   - **save-transfer**: 異物 JSON の narrow(unknown から段階的)、version 不一致 snapshot の個別 drop、import が常に新規スロット+新規 id。
   - **save-browser**: `innerHTML` 直書き — `prompt()`/import 由来の名前が全てエスケープを通るか(XSS)。ダブルクリック load の active-slot ガード。
   - `save-data.ts` が型定義のみ(ロジック混入なし)か。
3. `SAVE_VERSION` を上げるべき構造変更が直近コミットに入っていないか(入っていて未更新なら `[bug]`)。

## 検証
- `npm run typecheck`
- `save-ephemeris-context.test.ts` があるため `npm run test:physics` も実行。

## 出力
`findings/04-findings.md` にタグ付きで列挙。エスケープ漏れ・往復欠落は修正可。フォーマット変更を要するものは報告のみ。

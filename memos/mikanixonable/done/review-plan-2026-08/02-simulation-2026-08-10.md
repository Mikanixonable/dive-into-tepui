# 章02: シミュレーション駆動系のレビュー

単独実行可。他章に依存しない。

## 対象ファイル
- `src/game/simulation/`: simulator.ts / attractors.ts / predictor.ts / collision.ts / contact.ts / hit.ts / entity-manager.ts / entity-id.ts / time-step.ts
- `src/physics/dynamic-trajectory.ts` / `state-queue.ts` / `deque.ts` / `spatial-grid.ts` / `trajectory-features.ts` / `sphere-contact.ts` / `collision-response.ts` / `dynamics.ts` / `attitude.ts`
- `src/physics/nbody/`(integrator / bodies / physics.worker — worker が実際に配線されているか確認)
- `src/game/game-entity/game-entity.ts`(stepActual / stepPredicted / resyncPrediction / displayState)

## 手順
1. `git log --oneline HEAD~200..HEAD -- src/game/simulation src/physics/dynamic-trajectory.ts src/physics/nbody` で該当コミットを把握。
2. 観点:
   - **substep 一貫性**: `Simulator.substep` が attractors を substep 中点で1回だけ組み立て、全エンティティが同一 classified 構造を読むか(相互重力の対称性要件)。イベント境界(`nextSimulationEventTime`)を跨ぐ substep 分割の off-by-one。
   - **Predictor**: `resyncPrediction` が `canGrow` 無関係に毎フレーム走るか。`resyncTolerance` の補間誤差スケーリング(4乗則)。`predictedAttractorsAt` が tip 時刻の `displayState` を読み、null の body を落としているか(stale 代入がないか)。round-robin cursor の配列縮小時の範囲外。
   - **collision/contact**: cell size 導出(最大半径×2+最大移動量)と swept TOI の整合。`contact.ts`(直近追加 259行)と `collision.ts` の責務重複・二重解決がないか。NaN ガード。
   - **DynamicTrajectory**: `reset` の `discardFrom` による「history は state より古い」不変条件、`samplesOldestFirst` メモ化の無効化漏れ、`at(t)` の境界(t === state.t / history.newest との間)。
   - **nbody/**: README 1行のみ・worker 22行 — 死にコード/未配線なら `[spec?]` として報告(勝手に消さない)。
   - `EntityIdAllocator`: restore で採番カウンタが既存 id を追い越すか。
3. update/sync 規約: simulation/ 内に THREE 依存が混入していないか。

## 検証
- `npm run typecheck`
- `npm run test:physics`(physics/ を触るため必須)

## 出力
`findings/02-findings.md` にタグ付きで列挙。明白なバグ・規約違反は修正可。未配線コードの削除は報告のみ。

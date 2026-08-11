# 章03: マヌーバ計画系のレビュー

単独実行可。他章に依存しない。

## 対象ファイル
- `src/game/plan/`: plan.ts / plan-path.ts / plan-arc.ts / plan-display.ts / plan-editor.ts / plan-guide.ts / node-gizmo.ts / plan-gizmo-3d.ts / plan-trajectory.ts / plan-executor.ts / plan-executor-math.ts
- 周辺: `src/game/display-time-manager.ts` / `display-time-panel.ts`、`src/game/sim-speed-manager.ts`(auto-warp)

## 手順
1. `git log --oneline HEAD~200..HEAD -- src/game/plan` で該当コミットを把握。
2. 観点:
   - **Plan 不変条件**: ノードは常に実行時刻順、編集は下流破棄(`retimeNode`/`applyNodeDv`/`removeNode`)。`nodeTimeRange` と `segmentDurationFrom` の一致。`dropNodesBefore`/`overwriteAnchor` の使い分け(powered は `overwriteAnchor`、instant は返り値 state 代入)が実装通りか。
   - **PlanExecutor 状態機械**: idle→slew→armed→burn→trim→idle の全遷移で `clearState` を通るか。`targetNode` の**参照**比較(t 比較でない)。approach window(`NODE_APPROACH_LEAD + burnDuration + turnTime`)の外で finish 判定が走らないか。`applyIgnitionAndCutoff` の `!ship.alive` / `!thrustGateOpen` ガード。cutoff の**符号付き射影**判定。
   - **PlanArc**: `tracksLiveAnchor` の再計算しきい値と、不連続 re-anchor(`state0` identity 変化かつ t 非前進)の即時再計算。`PLAN_ARC_MAX_STEPS` 到達時の truncate。`apsisCenter` が末尾セグメントのみか。
   - **PlanPath**: `finalSegmentSamples` が参照渡し(コピーで re-bake ガードを壊していないか)。`nearestSample` の2段 tie-break(arc 選択→`referenceT`)。occlusion 除外。
   - **plan-trajectory.ts / plan-gizmo-3d.ts**: CLAUDE.md に記載がない → 現行アーキテクチャ文書との齟齬を確認し、死にコードなら `[spec?]` で報告。
   - **表示規約**: 計画=破線、予測/解析=実線(`SampledLine`/`DashPattern`)。dash の px→m 変換が毎フレーム `setDash` 経由か。
3. `plan.ts`/`plan-executor*.ts` は `tsconfig.test.json` でコンパイルされる — DOM/THREE 依存の混入(import type 含む)がないか `npm run test:physics` で確認。

## 検証
- `npm run typecheck`
- `npm run test:physics`(plan.test.ts / plan-executor*.test.ts が含まれるため必須)

## 出力
`findings/03-findings.md` にタグ付きで列挙。明白なバグ・規約違反は修正可。

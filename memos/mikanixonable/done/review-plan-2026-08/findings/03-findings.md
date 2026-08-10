# 章03: マヌーバ計画系 レビュー結果

対象は計画書記載の `src/game/plan/` 全ファイルおよび `display-time-manager.ts` /
`display-time-panel.ts` / `sim-speed-manager.ts`。計画書が言及する `plan-trajectory.ts` は
現存しない(下記参照)。

## 検証結果
- `npm run typecheck`: pass
- `npm run test:physics`: 390/390 pass

## 所見

### [bug] plan-executor.ts:187-193 — `applyIgnitionAndCutoff` の cutoff 判定がゲート閉鎖中も無条件に走る
`burn`/`trim` フェーズの cutoff 判定:

```ts
// burn/trim: 射影が0を切ったら遮断。ゲートが閉じている間は推力だけ止め、フェーズは保持する。
const dir = this.burnDirWorld!;
if (burnCutoffProjection(node.v, ship.state.v, dir) <= 0) {
  this.finish(ship, node);
  return;
}
ship.thrust = this.thrustGateOpen ? scale(dir, this.pendingAccel) : null;
```

コメントは「ゲートが閉じている間は推力だけ止め、フェーズは保持する」と述べているが、直前の
`burnCutoffProjection(...) <= 0` チェック自体は `thrustGateOpen` を一切見ずに無条件で走る。
対して `update()` 側の並行ロジック(`updateBurnOutput`, 129-153行)は

```ts
this.phase = remaining < C.PLAN_EXECUTOR_TRIM_DV ? 'trim' : 'burn';
if (!this.thrustGateOpen) {
  ship.thrust = null;
  return;   // ここでは finish() を呼ばない
}
```

と、ゲートが閉じている間は `finish()` に到達しないよう明示的にガードしている。
`applyIgnitionAndCutoff` は `Stage.applySimulationEvents` から warp レベルに関わらず毎
substep 呼ばれる(`nextEventTime` が `null` を返すのは正確な境界ステップを抑制するだけで、
呼び出し自体は止まらない)。高 warp でゲートが閉じている最中(`thrustGateOpen === false`、
つまり `ship.thrust = null` で実際には燃焼していない)でも、`ship.state.v` は通常の軌道力学
(近地点通過による自然な増速など)で変化し続ける。その自然なドリフトだけで
`burnCutoffProjection` の符号がたまたま反転すると `finish()` が発火し、ノードが消費され
`overwriteAnchor` でアンカーが上書きされてしまう — 実際には意図した燃焼が一切実行されて
いないのに、ノード消化・残差Δv報告が起きる。ファイル自身のコメントが宣言している設計意図と
矛盾する、静かなバグ。`tests/physics/plan-executor.test.ts` の `closedGate` 系ケースは
`nextEventTime` のみを検証しており、燃焼中にゲートが閉じた状態で cutoff 判定へ到達する
経路はカバーされていない。

**修正案**: `if (!this.thrustGateOpen) { ship.thrust = null; return; }` を cutoff 判定より
前に置き、`update()` 側と同じ順序に揃える。

### [spec?] plan-gizmo-3d.ts が CLAUDE.md の `src/game/plan/` 節に一切記載がない
`PlanGizmo3D` は死にコードではなく、`plan-editor.ts`(23, 79, 116-117, 512, 565, 573, 591,
593行)から構築・シーン追加され、`syncGizmo` 毎に姿勢基底からの位置・回転・ドラッグ/ラッチ
連動の矢印伸縮まで駆動されている実働コード。`node-gizmo.ts`(2D DOM 操作面)と役割が重複する
概念(軸・ラベル・ドラッグ)を持つ「もう一つのギズモ」だが、CLAUDE.md の該当節は
`node-gizmo.ts` は詳述する一方 `plan-gizmo-3d.ts` には一言も触れていない。
CLAUDE.md 冒頭ルール「`src/` を変更したら同じ変更セットの中で文書も更新する」に対する
更新漏れとみられる。挙動には影響しないため報告のみ。

### [minor] plan-display.ts:42 — 存在しないファイル名へのコメント参照
```ts
// 衝突マーカーのキー(区間ごとに固定)。区間数は SEGMENT_COLORS(plan-trajectory.ts)と同じ
```
`plan-trajectory.ts` は `src/` のどこにも存在しない。`SEGMENT_COLORS` の実体は
`plan-path.ts:18`。計画書側にも同名の古いファイル名が残っている(`memos/mikanixonable/`
配下の複数の計画・完了メモ)ため、リファクタリング(`0e911aa`: 積分軌跡を
`DynamicTrajectory`、計画折れ線を `PlanPath` に整理)で `plan-trajectory.ts` →
`plan-path.ts` に改名された際、このコメントの追随だけが漏れたと見える。
CLAUDE.md の「改名は痕跡を残さない」ルールに軽微に抵触する。

### [minor] tsconfig.test.json の `include` に存在しないファイルパスが3件残っている
`src/physics/orbital.ts` / `src/physics/central-body.ts` / `src/physics/swept-sphere.ts`
などが `include` に列挙されているが、実ファイルは `elements.ts`/`attractor.ts`/
`sphere-contact.ts` 等に改名済みで一致しない。`include` はグロブ扱いのため不一致エントリは
`tsc` に無言で無視され、`npm run test:physics` は現状問題なく通る(`plan.ts`/
`plan-executor*.ts` はこれらのパスを直接 import していないため到達可能なグラフには影響
しない)。挙動への実害はないが、設定の意図(コンパイルルートとして固定する)が静かに死んで
いる状態なので整理を推奨。

### [minor/確認事項] 「接近猶予窓」の定義が `PlanGuide` と `PlanExecutor` で異なる
`PlanGuide.update`(手動飛行時の HUD 通知、plan-guide.ts:37)は単純に
`simTime < node.t - C.NODE_APPROACH_LEAD` で判定する一方、`PlanExecutor.update`
(自動実行、plan-executor.ts:108-110)は
`NODE_APPROACH_LEAD + burnDurationFor(dvMag, accel) + turnTimeFor(errRad, MAX_ANG_ACCEL)`
という拡張された窓を使う。`PlanExecutor` は実際に燃焼・転回時間を要するため窓を広げる必然性
があり意図的と考えられるが、計画書は「猶予窓」を単一概念として扱っている節があるため、
両者の相違が設計意図どおりか確認事項として記録する(挙動上の齟齬は見当たらない)。

### [minor] node-gizmo によるノード選択に occlusion 除外がない
`PlanPath.nearestSample`(plan-path.ts:197)と `PlanDisplay.syncApsisMarkers`
(plan-display.ts:268)はいずれも `isOccluded` で天体背後の候補を明示的に除外しているが、
`PlanEditor.pickNodeAt`(plan-editor.ts:272-285, `handleMapClick`/`handleNodeRightClick`の
双方で使用)は画面距離のみでピックし occlusion を見ない。ノードハンドルは2D DOM 要素で
サンプル点/アプシス点とは層が異なるため意図的な可能性が高いが、他箇所の occlusion 規律との
非一貫性として記録する。

## 確認したが問題なし(参考記録)

- **Plan 不変条件**: `addNode`/`retimeNode`/`applyNodeDv`/`removeNode` はすべて下流ノードを
  破棄する。`nodeTimeRange` と `PlanPath.buildSegments` はどちらも同じ `segmentDurationFrom`
  を呼んでおり、legal な時刻範囲と描画区間が食い違うことはない。`dropNodesBefore` の返り値
  契約(最後に破棄したノード = 新アンカー)は CLAUDE.md が記述する `'instant'` 側のテレポート
  実装と整合する。
- **PlanExecutor 状態機械**: `finding #1` を除き、すべての中断/リセット経路は `clearState`
  を通る。`targetNode` の比較は常に参照(`===`)で行われ `.t` 比較は使われていない。
  `update()` 側の接近猶予窓は finish/整列判定を正しくガードする。`applyIgnitionAndCutoff` は
  `!ship.alive` ガードを持つ(ただし `!thrustGateOpen` ガードは finding #1 の箇所で欠落)。
  `burnCutoffProjection` は符号付き射影(`dot(sub(targetV, currentV), burnDir)`)であり、
  raw magnitude ではないことを確認。
- **PlanArc**: `tracksLiveAnchor` の再計算しきい値は `segment length / PLAN_ARC_MAX_SAMPLES`
  (サンプル間隔)と正しく比較している。不連続 re-anchor 条件は
  `state0 !== this.key.state0 && state0.t <= this.key.state0.t` と厳密に一致。
  `PLAN_ARC_MAX_STEPS` 到達時は `truncated = true; break` で正常に打ち切られる(ハング・
  例外なし)。`apsisCenter` は `PlanPath.update` で末尾セグメントのみ非 `null`。
- **PlanPath**: `finalSegmentSamples` は `arc.samples` を素の参照のまま公開しており、
  `.slice()`/`.map()`/spread によるコピーは無い(re-bake ガードを壊していない)。
  `nearestSample` の2段 tie-break(画面最近接の arc をまず選び、そのタイ許容範囲内で
  `referenceT` により選ぶ)は仕様どおり。occlusion による除外もピック時に効いている。
- **表示規約**: `PlanArc` の `SampledLine` は常に `DashPattern` 付きで構築される(無条件に
  破線)。dash の px→m 変換は `PlanPath.sync` 内で毎フレーム再計算され `setDash` 経由で
  反映される(一度だけの焼き込みではない)。
- **コンパイル分離**: `plan.ts`/`plan-executor.ts`/`plan-executor-math.ts` に THREE/DOM 型の
  import(`import type` 含む)は無い。`test:physics`/`typecheck` とも成功。

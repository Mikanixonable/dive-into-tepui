# レビュー結果 対処タスク(優先度順)

全10章の findings(04・06は未提出)+ 追加調査2件(ラジエーター左右/右クリック優先順・ChaseCamera)の集約。
各タスクは独立して着手可。[P1] が最優先。

## P1 — コードの実バグ(修正する)

1. **[P1] plan-executor.ts:189 — ゲート閉鎖中も cutoff 判定が走る**(章03 [bug]、未修正)
   高warp中(`thrustGateOpen === false`、実際には燃焼していない)でも `burnCutoffProjection <= 0` が
   無条件に評価され、軌道力学による自然な速度変化だけで `finish()` が発火 → 燃焼ゼロのままノード消費+
   `overwriteAnchor`。修正: `if (!this.thrustGateOpen) { ship.thrust = null; return; }` を cutoff 判定の
   前に移し、`update()` 側(135行)と同じ順序に揃える。`tests/physics/plan-executor.test.ts` に
   「燃焼中ゲート閉鎖→cutoff 不発火」のケースを追加。

2. **[P1] chase-camera.ts — 破壊後タンブル追従停止のリグレッション復旧**(章07、調査で確定)
   `7a2310f`(クオータニオン化)で旧実装の `player.alive` ゲートが取りこぼされた(意図的変更の痕跡なし)。
   修正: 姿勢の折り込み(update 冒頭と書き戻しの両方)を `_camFollowAttitude && player.alive` に。
   死亡検知フレームで一度だけ `rot = qMul(player.att.q, rot)` の読み替えを挟み、視点ジャンプを防ぐ
   (`camFollowAttitude` セッターと同じ手法)。

3. **[P1] 作業ツリーの未コミット修正3件の確定**
   既に適用済み: belt-physics.ts の pitch/yaw クランプ入れ替え(章08 [bug])、dock-view.ts の艦名
   XSS エスケープ(章09 [bug])、tsconfig.test.json の死んだ include(章10)。
   `npm run typecheck` + `npm run test:physics` を通してコミットする。

## P2 — 目に見える不具合・UX(修正または判断)

4. **[P2] dom.ts — マーカーラベルの CSS が `#hud` リセットに負けて無効**(章05 [bug])
   `.mk .lbl`(183行)/`.mk-poi .lbl`(293行)/`.mk-base .lbl`(295行)の margin/padding が
   `#hud, #hud * { margin:0; padding:0 }` に特異性で負けている。`#hud .mk .lbl` 等 id スコープ化で修正。

5. **[P2/要判断] ノード右クリックメニューが到達不能になる条件**(章07 + 調査)
   現在の順序(MapPicker 先行)は `3a659a6` の意図的変更で正。ただしノードの 24.5px 以内に
   マーカー候補(遠点/近点・AN/DN・艦・天体ラベル)があると、ノードの削除/ワープメニューが
   **絶対に開けない**(`MAP_PICK_PX_SQ`=600≒24.5px < `NODE_PICK_PX`=30px の非対称も一因)。
   対処案の判断が要る: 選択中ノードだけ editor を先行させる/ノードを pickables に統合する等。

6. **[P2/要確認] [R] 手動リロードが満タンのマガジンを破棄する疑い**
   `DEVELOP/BELT_COUNT_BUG.md` が `player-fire.ts:185` を名指しする既存未解決メモ(章10で再確認)。
   再現確認のうえ修正。

## P3 — 文書の誤り(コードが正。文書を直す)

7. **[P3] CLAUDE.md のラジエーター左右が逆**(章09 + 調査で確定: +X=左舷。`f97aae2` にコードは追従済み)
   - CLAUDE.md:202「up/down is +X/-X, i.e. starboard/port」→ port/starboard、「ラジエーター右/左, 9/0」→ 左/右
   - CLAUDE.md:330「up(right/+X)/down(left/-X)」→ up(left)/down(right)
   - 波及: CLAUDE.md:354「belt … starboard (+X)」、DEVELOP/BELT.md:3「右舷(+X)」、
     BELT_COUNT_BUG.md:45「左舷側へ潜る」 — いずれも +X=左舷 で書き直し。

8. **[P3] 右クリック優先順の文書更新**(調査で確定: `3a659a6` の意図的変更、文書が旧)
   CLAUDE.md:108 / 170 / 174、DEVELOP/CALLSTACK.md:280-291 を現順序
   (MapPicker マーカー → PlanEditor ノード → 空域メニュー、の3段フォールスルー)に書き直す。

9. **[P3] CALLSTACK.md:195 — 姿勢積分刻み幅の記述が実装と不一致**(章02 [spec?])
   「players は simDt / それ以外は attDt=min(simDt,0.12)」の分離は撤廃済み(0.12 はコード上どこにもない)。
   現状(全エンティティ一律 subDt)に書き直し。CLAUDE.md の同前提の記述も併せて修正。

10. **[P3] CLAUDE.md 未記載モジュールの追記**(章03・08・10)
    - `physics/ephemeris-pack/` + `packed-absolute-ephemeris.ts` + `absolute-ephemeris.ts` +
      `astronomical-time` 系(二段構えの暦データ設計。OWNERSHIP/CALLSTACK/SPEC にも言及ゼロ — 最大の欠落)
    - `plan/plan-gizmo-3d.ts`(実働コード)、`physics/ring-optics.ts`、`render/radiator-hinge.ts`
    - `export-assets` 節に `RADIATOR_HINGE` の取得元を追記
    - radiator.ts 節の廃止済みシンボル(`hitRadius`/`sideHitBy`/`RADIATOR_TIP_DISTANCE`)を
      現行の `RadiatorFold` 接触方式に書き直し(章08 [spec?])
    - `plan-display.ts:42` のコメントが存在しない `plan-trajectory.ts` を参照(→ `plan-path.ts` に修正。
      これはコード内コメント1行の修正)

## P4 — レビューの穴埋め

11. **[P4] 章04(セーブ)・章06(天体表示)の findings が未提出**
    計画書(`04-save.md` / `06-celestial-display.md`)どおり再実行する。特に章04は
    serialize/restore 往復性・quota 失敗経路など save 系の追加が大きく、未レビューのまま放置しない。

## P5 — 低優先リファクタ・記録のみ

12. **[P5] ContextMenu.open の label/subLabel 無エスケープ innerHTML**(章05 — 現呼び出し元は静的文字列のみ。
    textContent 化しておくと将来の動的ラベルで安全)
13. **[P5] dom.ts に残る z-index(マーカー種別 0-4 / .dock-toggle:20 / svgOverlay:0)**
    — overlay-layer.ts の「z-index はここだけ」規約と矛盾(章05)。一本化するか規約側に例外を明記
14. **[P5] map-picker.ts `isCreativeMode()` の `as any`**(章09 — 循環 import 回避の設計判断が要る)
15. **[P5] deque.ts の4スペースインデント**(章02)
16. **[P5] `ChebyshevAbsoluteEphemeris`/`PackedAbsoluteEphemeris` の重複気味実装**(章01 — 報告のみ)
17. **[P5] `icrfToGameEci` の `-0` 回避分岐に理由コメントなし**(章01)
18. **[P5] refactoring_todo.md の完了項目棚卸し**(章10 — 責務判断を refactor-fixed へ移してから消す手順で)

## 備考

- 章01・02は確証ある [bug] ゼロ(検算・grep・テストで確認済み)。
- 「接近猶予窓」の PlanGuide/PlanExecutor 差(章03 [minor])と node-gizmo の occlusion 非対称
  (章03 [minor])は意図的とみられ、対処不要と判断。必要なら P5 扱い。
- P1-1/P1-2 と P3 の文書修正は同一変更セットで文書同期(develop-docs)を忘れないこと。

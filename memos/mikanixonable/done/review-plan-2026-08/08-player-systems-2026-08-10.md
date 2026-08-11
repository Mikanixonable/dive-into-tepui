# 章08: 自艦サブシステムのレビュー

単独実行可。他章に依存しない。

## 対象ファイル
- `src/game/player/`: player.ts / player-throttle.ts / player-fire.ts / thermal.ts / radiator.ts / power.ts / belt.ts / belt-physics.ts / thrust-effects.ts / rcs-effects.ts / reentry-effects.ts / player-markers.ts
- `src/game/game-entity/ship.ts` / `parts.ts` / `enemy.ts` / `bullet.ts`
- `src/render/ships.ts` / `radiator-hinge.ts`

## 手順
1. `git log --oneline HEAD~200..HEAD -- src/game/player src/game/game-entity/ship.ts src/game/game-entity/parts.ts` で該当コミットを把握。
2. 観点:
   - **parts = HP/性能の単一正**: 全ダメージが `applyDamageToParts` を通るか。`updateOverallHp` の「hull/cockpit 喪失で 0」規則のバイパス経路。`refreshFromParts` の呼び忘れ(dock 修理・restore・swap)。`Part.weight` 未読は既知(`[spec?]` 再確認のみ)。
   - **thermal**: `pendingHeat` バンク方式 — substep 回数にスケールしない不変条件。`addGunHeat`/`addImpactHeat` 以外に `hullTemp` 直書きがないか。radiator の `wear` 受け渡し(自己修復なし)、`solarLoad` の偶奇 fold 向き分割、`abs` vs `max(0,·)`(radiator/power の違いは意図的)。
   - **throttle**: 6キー独立 latch(performance.now 基準)、対向キー保持での latch 抑止、対向ペア同時押し=全軸停止+全 latch 解除。`canPlayerThrust` ゲート下で edge を消費しない規約。`stopThrust` が SFX/plume を触らない(thrust-effects が `ship.thrust` を読む)規約。
   - **fire**: `ConsumeResult` 状態機械(mag/barrel reload)、`[R]` は実際にリロード開始時のみ消費。ベルト feed のラップ(1→0 とリンク数減少の同期)。
   - **belt-physics**: 慣性力4項(並進・Euler・遠心・Coriolis)の符号、`BeltSection` プロキシの往復(collisionSections/applyCollisionSections)。
   - **effects の入力規約**: 演出は共有物理フィールド(`ship.thrust`/`ship.torque`)を読む — PlayerThrottle 固有状態を読む演出が復活していないか(refactor-fixed)。
   - **radiator-hinge**(render 新設): fold のネスト・符号(up=+X/down=−X)とモデル/物理の一致。`RADIATOR_TIP_DISTANCE` の導出がモデル定数から。
3. update/sync: effects の `update`(経時)と `sync`(表示)分離。`syncPlayer` の `displayState ?? state` 規約(スライダー中の VFX 位置)。

## 検証
- `npm run typecheck`
- physics/ を触った場合のみ `npm run test:physics`(attitude/belt は該当)

## 出力
`findings/08-findings.md` にタグ付きで列挙。明白なバグ・規約違反は修正可。バランス数値の疑義は報告のみ。

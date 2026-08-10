# 直近200コミット 広域レビュー計画(2026-08)

対象: `git diff HEAD~200..HEAD`(約 +25,000 行 / 281 ファイル)で追加・変更されたコードとその周辺。

各章は**相互依存なし**で、1章 = 1セッションで単独実行できる。並列に走らせてよい。

## 章一覧

| ファイル | 領域 |
|---|---|
| 01-physics-orbital.md | 軌道力学コア(elements / kepler-orbit / satellite-orbit / ephemeris / ephemeris-pack) |
| 02-simulation.md | シミュレーション駆動(simulator / attractors / predictor / collision / hit / dynamic-trajectory) |
| 03-plan.md | マヌーバ計画(plan / plan-path / plan-arc / plan-display / plan-editor / plan-executor) |
| 04-save.md | セーブ三階層(save/ 一式 + save-browser + entity serialize/restore) |
| 05-hud-widgets.md | HUD 汎用ウィジェット(property-window / object-picker / buttons / overlay-layer / ticks) |
| 06-celestial-display.md | 天体表示(celestial/ 一式、ring、point-field、body-visibility) |
| 07-camera-map.md | カメラとマップ(camera/ 一式、map-picker、frame-controls、nav-target、marker/) |
| 08-player-systems.md | 自艦サブシステム(player/ 一式: throttle / fire / thermal / radiator / belt / parts) |
| 09-stages-creative-dock.md | ステージ・クリエイティブ・ドック(stages/ / creative/ / docking / dock-view) |
| 10-tests-tools-docs.md | テスト・ツール・文書整合(tests/physics / tools/ / CLAUDE.md / DEVELOP/) |

## 全章共通ルール(各章にも再掲)

- 検証: `npm run typecheck` は必ず。`npm run test:physics` は `src/physics/` を触った章のみ。
- 修正してよいもの: 明白なバグ、規約違反(下記)、重複実装。挙動仕様の変更は**修正せず報告のみ**。
- 報告: 章ごとに `memos/hedalu244/review-plan-2026-08/findings/<章番号>-findings.md` へ、
  `[bug] / [spec?] / [refactor] / [comment]` のタグ付きで、`ファイル:行` と1行の根拠を添えて列挙。
- プロジェクト規約(`.claude/skills/refactor-fixed`、CLAUDE.md):
  - update/sync 分離(sync は dt を取らない・状態を進めない。update は THREE を触らない)
  - `physics/` は純関数・immutable(out引数/スクラッチバッファ禁止)、`game/const.ts` を読まない
  - `*Ctx` 引数オブジェクト禁止、クロージャ注入禁止
  - 改名の痕跡(旧名・「以前は」コメント)禁止
  - コメントは `/comment` 方針(責務外への言及禁止、呼出規約コメントの不足も指摘対象)
- `memos/mikanixonable/dev.md` は人間専用。読むだけで編集しない。

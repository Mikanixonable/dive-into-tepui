# 章10: テスト・ツール・文書整合のレビュー

単独実行可。他章に依存しない。**src/ は原則読み取りのみ**(文書とテストを直す章)。

## 対象
- `tests/physics/` 全体(直近200コミットで大量追加: n-body / satellite-orbit / plan-executor / ring / shape / point-field / laplace-satellites / irregular-satellites / small-bodies / packed-absolute-ephemeris / save-ephemeris-context / hud-layout / shortcut-hint ほか)
- `tools/ephemeris/`(cli.mjs / generate.py / fixture / validation JSON)、`tools/export-models.mjs` / `export-earth-texture.mjs`
- 文書: `CLAUDE.md` / `DEVELOP/OWNERSHIP.md` / `DEVELOP/CALLSTACK.md` / `DEVELOP/SPEC.md` / `.claude/skills/refactor-fixed/SKILL.md`
- `tsconfig.test.json` / `package.json` scripts

## 手順
1. `npm run typecheck && npm run test:physics` を先に実行し、現状の green を確認(落ちるならそれが最優先の報告)。
2. テストの観点:
   - **測定値 pin の妥当性**: pin されたバグ(理論値と大きく乖離する測定固定)がないか、margin が緩すぎて回帰を通す穴がないか。
   - 重複テスト・削除された旧テスト(orbital.test.ts / orbit-entity.test.ts 削除)のカバレッジ喪失 — 新テストが同じ性質を引き継いだか対応表を作る。
   - `tests/physics/index.ts` の登録漏れ(ファイルは在るが実行されないテスト)。
   - テストが DOM/THREE を引き込んでいないか(tsconfig.test.json のコンパイル対象閉包)。
3. tools の観点:
   - `tools/ephemeris/generate.py` の単位・座標系と `src/physics/ephemeris-pack/format.ts` の読みの一致(定数を二重定義していないか)。requirements.txt の再現性。
   - export-models / export-earth-texture が値を TS compiler API 経由で src/ から取る規約の維持。
4. 文書整合(最重要):
   - CLAUDE.md / DEVELOP/ の記述と実コードの齟齬を洗う。特に CLAUDE.md に**未記載の新設ファイル**(例: `plan-trajectory.ts` / `plan-gizmo-3d.ts` / `render/radiator-hinge.ts` / `physics/nbody/` / `physics/ephemeris-pack/` / `envaccel.ts` / `central-body.ts` / `ring-optics.ts` / `orbit-entity.ts` / `orbital.ts`(削除済のはずが記述残存?))と、**記載はあるが消えたもの**。
   - 齟齬は「DEVELOP/ を正、CLAUDE.md を直す」規則で修正してよい。旧名の全文検索(改名痕跡 0 件規則)。
   - `memos/hedalu244/refactoring_todo.md` の完了済み項目の消し込み(責務判断は refactor-fixed へ移してから)。

## 検証
- `npm run typecheck` / `npm run test:physics`

## 出力
`findings/10-findings.md`。文書修正・テスト登録漏れは直接修正可。src/ 側の疑義は該当章タグを付けて報告のみ(例: `[bug→章01]`)。

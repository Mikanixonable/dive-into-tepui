# 章01: 軌道力学コアのレビュー

単独実行可。他章に依存しない。

## 対象ファイル
- `src/physics/elements.ts` / `kepler-orbit.ts` / `planet-orbit.ts` / `satellite-orbit.ts`
- `src/physics/ephemeris.ts`(直近200コミットで +707 行 — 最重量)
- `src/physics/ephemeris-pack/`(format / evaluator / absolute-adapter / types)
- `src/physics/absolute-ephemeris.ts` / `packed-absolute-ephemeris.ts` / `ephemeris-catalog.ts` / `ephemeris-profile.ts`
- `src/physics/body-orientation.ts` / `ecliptic.ts` / `solar-system.ts` / `lagrange.ts` / `halo.ts`
- 周辺: `src/physics/attractor.ts` / `frame.ts` / `dynamics.ts` / `srp.ts` / `shadow.ts`

## 手順
1. `git log --oneline HEAD~200..HEAD -- src/physics/` で該当コミットを把握し、大きい順に diff を読む。
2. 観点:
   - **数値・単位の誤り**: deg/rad、km/m、Julian century、符号(RAAN 後退・近点前進の向き)。テストの pin 値が「測定値の固定」であって理論値でない箇所は、実装のバグを固定していないか疑う。
   - **キャッシュの正しさ**: `Ephemeris` の ring cache(4スロット、t 完全一致キー)。呼び出し側が返却配列を mutate していないか全参照を確認。`setPhaseOffsets` が全キャッシュ群を無効化しているか。
   - **ephemeris-pack**: フォーマットの境界条件(区間端の補間、時間範囲外アクセス)、`tools/ephemeris/generate.py` が出力する単位と evaluator の読みの一致。
   - **registry 汎化の破れ**: `'earth'`/`'sun'`/`'moon'` の文字列直書きが残っていないか(`grep -rn "'earth'\|'sun'\|'moon'" src/physics/` — 許されるのは `SOLAR_SYSTEM` の定義とテスト)。
   - **immutability**: `physics/` 内に out 引数・モジュールレベル scratch・`Math.random`/`Date.now` 直呼びがないか。
   - `hasUsableCollinearPoints` / `hasStableTriangularPoints` の判定式(Routh 比、clearance ratio)の妥当性。
3. コメント点検(`/comment` 方針): 10行超の関数の文脈コメント欠落、責務外言及。

## 検証
- `npm run typecheck`
- `npm run test:physics`(この章は必須)

## 出力
`findings/01-findings.md` に `[bug]/[spec?]/[refactor]/[comment]` タグ付きで列挙。明白なバグと規約違反は修正してよい。仕様疑義(例: 数値が文献とズレる)は報告のみ。

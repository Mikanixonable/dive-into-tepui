# 章10: テスト・ツール・文書整合のレビュー — findings

## 検証結果(手順1)

- `npm run typecheck` → **green**(エラーなし)
- `npm run test:physics` → **green**(390/390 passed)
- 本レビュー中に `tsconfig.test.json` を1件修正した後も再実行し、**390/390 passed** を確認済み。

現状 green であり、最優先の破壊的問題はない。

---

## 2. tests/physics/ の観点

### 2-1. `tests/physics/index.ts` の登録漏れ

`ls tests/physics/*.test.ts`(46ファイル)と `index.ts` の import/register を突き合わせた結果、
**登録漏れは無かった**。`ring-optics` という名前のテストケースが実行ログに出るが、これは独立ファイル
ではなく `ring.test.ts` 内に同居しているケース名であることを確認済み(`grep -c "ring-optics"
tests/physics/ring.test.ts` → 5件、`ring-optics.test.ts` というファイル自体は存在しない)。
`creative-placement-validation.test.ts` のみ副作用importの形(`import
'./creative-placement-validation.test'`)で他と書き方が異なるが、実行はされている。

### 2-2. 削除された旧テスト(orbital.test.ts / orbit-entity.test.ts)のカバレッジ

`git log --all --diff-filter=D` で調査したところ、両ファイルは commit `3a67afa`
「refactor: orbital.ts を状態・軌道要素・力学の3モジュールへ分ける」で削除されている。
分割後の `elements.ts` / `kinematic-state.ts` / `dynamics.ts` は、それぞれ
`elements.test.ts` / `kinematic-state.test.ts` / `dynamics.test.ts` として現存し、
CLAUDE.md記載の `npm run test:physics` カバレッジ文とも一致する。**カバレッジ喪失は確認できず**、
CLAUDE.md/DEVELOP側にも `orbital.test.ts`/`orbit-entity.test.ts` への言及は残っていない
(全文検索 0 件)。改名痕跡の問題なし。

### 2-3. `tsconfig.test.json` の DOM/THREE 混入チェックと `include` の死んだ参照(**修正済み**)

`tsconfig.test.json` の `compilerOptions.lib` は `["ES2022"]` のみで DOM 型は含まれておらず、
`--listFilesOnly` でコンパイル対象閉包を実際に列挙して確認したところ、`three/webgpu` や `document.`/
`window.` の実コードは含まれていなかった(`hud-layout.test.ts` にヒットしたのは
`// window.resize でビューポートが縮んだあと…` というコメントのみで実害なし)。

一方、`include` 配列に **実在しないファイルが3件** 残っていた:

- `src/physics/orbital.ts` — 上記2-2の分割で削除済み(`elements.ts`/`kinematic-state.ts`/`dynamics.ts`
  へ分割)。これらは `ephemeris.ts` からの import 連鎖で既に閉包に含まれているため、この明示エントリは
  完全な死物だった。
- `src/physics/central-body.ts` — 該当ファイルは存在せず、`find` でも他にヒットしない。おそらく
  `attractor.ts`(現行のAttractor/strongestAttractor実装)への改名の痕跡と推測されるが、確証はない。
  `attractor.ts` は import 連鎖で既に閉包に含まれている。
- `src/physics/swept-sphere.ts` — 実ファイルは `src/physics/sphere-contact.ts`
  (CLAUDE.md記載の `sphere-contact.ts`/`sweptSphereToi` と一致)。単純な誤記/改名痕跡。

これらは `tsc -p tsconfig.test.json` が「include の明示パスが存在しなくてもエラーにしない」という
挙動のため誰にも気づかれず残っていたと見られる(`--listFilesOnly` でも警告なし)。実害はなかったが
(いずれも既に他の import 経由でコンパイル対象に入っていた)、設定ファイルの意図を誤読させるため、
**本レビューで直接修正した**: 3エントリを削除し、`swept-sphere.ts` は正しいファイル名
`sphere-contact.ts` に差し替えた。修正後 `npm run test:physics` は 390/390 green を再確認済み。

### 2-4. 測定値pinの妥当性

全体をざっと確認した範囲では、CLAUDE.mdの `npm run test:physics` セクションに書かれている通り、
測定値pin(RK4ドリフト、J2レート、テーブル境界連続性など理論値が存在しない箇所)は「measured value
を緩いマージンで固定する」という明示方針が一貫して守られており、露骨に理論値と乖離した固定
(バグをpinしているような箇所)や、逆に緩すぎて回帰を検出できないようなマージンは、確認した主要な
テスト(n-body の運動量保存/極限収束、shape の外接球条件、ring-lod の単調性、irregular/laplace/
small-bodies satellites の歳差周期・軌道法線)については見当たらなかった。ただし全390ケースの
数値マージンを1件ずつ理論再導出する時間は取れておらず、**このチェックは網羅的ではない**
([要確認] 深掘りする場合は特に `n-body.test.ts` の質量→0極限の収束閾値と、
`plan-executor.test.ts`/`plan-executor-math.test.ts` のタイミング系マージンを優先的に見直すことを推奨)。

---

## 3. tools/ の観点

### 3-1. `tools/ephemeris/generate.py` と `src/physics/ephemeris-pack/format.ts` の単位・座標系

`generate.py` は jplephem から km / km/day を得たあと `spk_state()` 内で明示的に
`* 1000.0` / `* (1000.0 / DAY)` して m / m/s に変換しており、`format.ts` のコメント
「Version 1 uses barycentric ICRF/J2000 positions in metres and times expressed as seconds
from the J2000 ET epoch on the TDB scale」と一致する。定数の二重定義(GM値など)は見当たらず、
`BODIES` タプルのGM値はこのツール専用でsrc/側の`solar-system.ts`の値と直接比較する経路は
無い(意図的に独立したソース — SPKからの導出値であり、ツールの再現性のためのものと判断)。

`requirements.txt` の内容は確認したが、pin(`==`)の有無・バージョン再現性の精査までは
時間の都合上行っていない([要確認])。

### 3-2. export-models.mjs / export-earth-texture.mjs の「TS compiler API経由でsrc/から値を取る」規約

両ツールとも `typescript` パッケージの `transpileModule`/`createProgram` 相当のAPIで
`src/render/*.ts` を動的トランスパイル・importしており、規約は維持されている。

- `export-earth-texture.mjs` は `src/render/earth-color.ts` の `surfaceColor` を取得。
- `export-models.mjs` は `src/render/rcs-nozzles.ts` の `RCS_NOZZLES` に加え、
  **`src/render/radiator-hinge.ts` の `RADIATOR_HINGE` も同じ経路で取得している**
  (CLAUDE.mdの `export-assets` の節は `RCS_NOZZLES` のみ言及しており、
  `RADIATOR_HINGE` の記載が欠けている — 4-2で後述)。

規約自体(値をハードコードせずsrc/から取る)は守られており、劣化は無い。

---

## 4. 文書整合(最重要)

### 4-1. CLAUDE.mdに未記載の新設ファイル/モジュール

実ファイル一覧と照合した結果、以下は実装が存在し、かつ実際に他モジュールから使われている
(=デッドコードではない)にもかかわらず、CLAUDE.md本文に一切登場しない:

| ファイル | 用途 | 呼び出し元 |
| --- | --- | --- |
| `src/physics/ephemeris-pack/{format,evaluator,absolute-adapter,types,index}.ts` | チェビシェフ多項式で焼き込んだ長期(近未来〜西暦20000年級)暦データパックの読み込み・検証 | `src/physics/packed-absolute-ephemeris.ts`, `src/game/save/ephemeris-context.ts` |
| `src/physics/packed-absolute-ephemeris.ts` | 上記パックを`AbsoluteEphemeris`アダプタとして統合 | (テストで直接検証、`ephemeris-context.ts`から到達と推測) |
| `src/physics/ring-optics.ts` | 環のBeer-Lambert透過率・Henyey-Greenstein位相関数などの光学モデル(THREE非依存) | `src/render/ring.ts`, `src/game/celestial/ring-lod.ts` |
| `src/game/plan/plan-gizmo-3d.ts`(`PlanGizmo3D`) | 選択中ノードのΔvアーム6本を表す3D矢印ギズモ | `src/game/plan/plan-editor.ts` |
| `src/render/radiator-hinge.ts`(`RADIATOR_HINGE`) | 放熱板蛇腹のヒンジ機体座標系位置の単一情報源 | `src/render/ships.ts`, `src/game/player/radiator.ts`, `tools/export-models.mjs` |

加えて `tests/physics/index.ts` に登録されているテストファイル名から、CLAUDE.mdの
`npm run test:physics` 節が言及していない以下のサブシステムの存在が確認できる
(テスト自体は存在し実行されているが、CLAUDE.md/DEVELOP/*.md本文のどこにも該当する
アーキテクチャ解説が無い):

- `astronomical-time.test.ts` → JD/TDB/UTC変換・5桁グレゴリオ暦round-trip(対応する実装ファイルは
  未特定 — `src/physics/`配下で `astronomical-time` 相当のファイル名を持つものが見当たらず、
  `ephemeris-pack`か`chebyshev-ephemeris`関連に同居している可能性がある)
- `ephemeris-profile.test.ts` → 「現代」「西暦20000年付近」で異なる根拠データセットを切り替える
  `EphemerisProfile`機構
- `chebyshev-ephemeris.test.ts` → チェビシェフ級数評価器そのもの
- `absolute-ephemeris.test.ts` → ICRF→ECI変換を含む`AbsoluteEphemeris`
- `save-ephemeris-context.test.ts` → セーブデータの暦コンテキスト互換性判定

これらは `DEVELOP/OWNERSHIP.md`/`CALLSTACK.md`/`SPEC.md`/CLAUDE.mdのいずれにも
`ephemeris-pack`/`absolute-ephemeris`/`astronomical-time`という文字列が一件も出現しない
(`grep -c` で確認済み、全て0件)。**「近未来〜遠未来をまたぐ暦データの二段構え」という、
ゲームの時間軸を左右しうる比較的大きな設計が文書側に一切反映されていない状態**であり、
CLAUDE.mdのルール「`src/` を変更したら同じ変更セットの中で文書も更新する」に照らすと、
これを追加した変更セット(コミット群)がこのルールを守っていなかった可能性が高い。

→ この節の書き直しは分量・専門知識ともに本レビューの範囲を超えるため、**直接の大規模加筆は行わず、
上記の欠落を明確に記録するにとどめた**(指示にある「大規模な書き直しは避ける」に従う)。
`ephemeris-pack`/`absolute-ephemeris`/`astronomical-time`の設計意図を把握しているエージェント/
人間による別セッションでのCLAUDE.md加筆を推奨する。`[要確認]`

### 4-2. CLAUDE.mdの記載が古い/漏れている軽微な箇所(直接修正は見送り、記録のみ)

- `export-assets` の節が `export-models.mjs` について `RCS_NOZZLES` のみ言及しているが、
  実際は `src/render/radiator-hinge.ts` の `RADIATOR_HINGE` も同じ経路(TS compiler API)で
  取得している。CLAUDE.mdの一文追記で足りる軽微な差分だが、該当箇所が
  「Not part of `build`」の長い一段落中に埋め込まれており、文脈を壊さない追記が難しいため、
  今回は追記を見送り記録のみとした。`[要確認]`

### 4-3. CLAUDE.mdに記載があるが実際には存在しない/削除されたファイル

計画書に例示されていた `orbital.ts`(削除済のはずが記述残存?)については、CLAUDE.md本文を
全文検索した結果 **`orbital.ts`という文字列自体がCLAUDE.md中に存在しない**ことを確認した
(記述残存なし)。同様に `orbit-entity.ts`/`envaccel.ts`/`central-body.ts` もCLAUDE.md中に
0件。**CLAUDE.md本文には改名痕跡は見つからなかった**。

唯一の「記載はあるが古い」ケースは `tsconfig.test.json`(文書ではなく設定ファイル)側の
`orbital.ts`/`central-body.ts`/`swept-sphere.ts` であり、これは2-3で報告・修正済み。

### 4-4. DEVELOP/OWNERSHIP.md・CALLSTACK.md・SPEC.md の照合

時間の制約上、全文と実コードの一行単位の突き合わせは行っていないが、以下を確認した:

- 3ファイルとも `ephemeris-pack`/`absolute-ephemeris`/`astronomical-time`
  への言及が0件 — 4-1と同じ欠落がここにも及んでいる。
- `DEVELOP/README.md` の索引表とCLAUDE.mdの役割分担の記述(「DEVELOP/を正、CLAUDE.mdを直す」)
  は一致しており、索引自体に矛盾はない。
- `DEVELOP/BELT_COUNT_BUG.md`(未解決のベルト表示不整合バグ調査メモ)、
  `DEVELOP/EARTH_MOON_GRAPHICS_PROPOSAL.md`、`DEVELOP/PHYSICAL_RING_RENDERING_PROPOSAL.md`
  は本章の対象4文書(OWNERSHIP/CALLSTACK/SPEC/CLAUDE.md)ではなく、提案書・未解決バグメモという
  別種の文書のため本章では深掘りしていない。`BELT_COUNT_BUG.md`に記載の
  「[R]手動リロードが満タンのマガジンを破棄する」という具体的なバグ指摘は `player-fire.ts:185`
  を名指ししており、src/側の疑義として一応記録しておく `[bug→要確認]`(本章の担当外だが、
  既存の未解決文書として引き継がれている点は留意)。

### 4-5. `memos/hedalu244/refactoring_todo.md` の完了済み項目の消し込み

ファイルを読んだ限り、記載されている項目(render/physics境界、コメント不足、参照共有命名規則、
`PlanDisplay.sync`→`traj.update`のパターン違反、sfx/bgm分離、belt-physics変換、const.ts解体、
dt/simDt混在、plan-displayのcameraMode参照、touchControls/input/player責務整理)はいずれも
現在のCLAUDE.md本文の記述(例えば`plan-display.ts`が`planFrame`/`DisplayTimeManager`を参照する
形で説明されている、`sfx.ts`/`bgm-tracks.ts`が既に分離済みファイルとして記載されている等)と
照らして完了しているように見える項目がある可能性があるが、**todo項目1件ごとに現在のコードを
突き合わせて「完了/未完了」を確定する作業は本章の残り時間内では行えなかった**。誤って未完了項目を
消してしまうリスク(「その項目が下した責務配置の判断」を`.claude/skills/refactor-fixed/SKILL.md`
へ移してから消す、という手順を踏まずに消すと判断根拠が失われる)を避けるため、
**このファイルへの変更は行わなかった**。`[要確認]` 別途、todoリストの棚卸しに特化したセッションでの
対応を推奨する。

---

## 変更したファイル一覧

- `tsconfig.test.json` — `include`から存在しない`src/physics/orbital.ts`/`src/physics/central-body.ts`を削除し、
  `src/physics/swept-sphere.ts`を実在する`src/physics/sphere-contact.ts`に訂正。
- `findings/10-findings.md` — 本ファイル(新規作成)。

`src/`配下のファイルは一切変更していない。`CLAUDE.md`/`DEVELOP/*.md`/`memos/hedalu244/refactoring_todo.md`
についても、大規模な書き直しリスクを避けるため今回は変更せず、本findingsファイルに齟齬を記録するに
とどめた。

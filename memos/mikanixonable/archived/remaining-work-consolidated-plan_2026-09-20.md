# 残タスク統合・実装計画

> **状態更新 — 2026-09-23 再監査:** 本文の「進捗チェックリスト」は 2026-09-20 時点の計画記録であり、現在の残件一覧としては使わない。後続の実装・計画で状態が変わった項目を以下に整理する。

## 2026-09-23 再監査

- **B: render → game の ship 表示契約** — 完了。PR #94 で不変な船体描画契約と adapter を導入し、ship view からゲーム状態型への直接依存を除去した。境界検査にも反映済み。
- **C / Q: Cloud cell organization・temporal stability / LOD・shadow / scattering** — この文書からは継続しない。時間 LOD とベイク制限は後に撤去され、雲モデル全体の後続計画は `meteorological-cloud-model-plan-v2_2026-09-22.md` が引き継いでいる。
- **N: 命名整理と P0/P1 の所有境界** — PR #92 で ShipAssembly、DynamicSystem、入力・表示 phase、Celestial query、CombatShip 等の主要整理を実施済み。残存する広域リファクタリングは、この文書の旧 N をそのまま実行しない。
- **E: Earth surface** — PR #95 / #99 で色補正・配信・schema 契約・CI 検査が更新された。ただし、この文書が要求していた実ブラウザ capture を含む全完了条件を再検証していないため、完了とは断定しない。
- **L: lint 方針** — この再監査では完了判定をしていない。
- **V: Vessel production** — modular ship / dock / construction の MVP 以後は別計画で扱う。この文書を実装入口にしない。

したがって、**この文書は統合計画の履歴として残し、現行の作業順序の正本にはしない。** 雲は第二版計画、船体建造は専用の残課題文書、アーキテクチャ境界は `DEVELOP/ARCHITECTURE.md` と現行コードを参照する。


## 目的と扱い

`lint-violation-remediation-plan_2026-09-16.md` と
`remaining-tasks_2026-09-12.md` を、現行コードベースに照合して再分類した計画書。
このファイルを、2計画書から引き継ぐ残件の実装順・受入条件・レビュー結果の正本とする。
元の2文書は履歴として `done/` に移動する。

## 基準スナップショットと検査結果

- 調査日: 2026-09-20
- 対象コミット: `9105b47cc`
- 作業ブランチ: `workspace3`
- `npm run lint`: 成功（抑制ファイルによる成功）
- `npm run typecheck`: 成功
- `npm run check:boundaries`: 成功。既存の検査対象では違反0件
- `npm run test:game`: 成功
- `npm run test:render`: 成功（224/224）
- `npm run earth-surface:check`: 失敗。`.earth-surface/bundle/earth-surface.json` が旧schema 1で、現行契約のschema 3に合っていない

現行 `eslint-suppressions.json` の集計は次のとおり。旧計画に書かれた件数は基準が異なるため、実装開始時にこの集計を再取得する。

| ルール | 抑制件数 |
| --- | ---: |
| `@typescript-eslint/no-non-null-assertion` | 1055 |
| `@typescript-eslint/consistent-type-imports` | 384 |
| `@typescript-eslint/explicit-member-accessibility` | 317 |
| `no-restricted-syntax` | 124 |
| `@typescript-eslint/consistent-type-definitions` | 59 |
| `@typescript-eslint/no-unused-vars` | 71 |
| `@typescript-eslint/explicit-module-boundary-types` | 16 |
| `@typescript-eslint/parameter-properties` | 14 |
| `no-console` | 11 |
| その他 | 29 |

## 再分類

### 完了として閉じる項目

旧 `remaining-tasks` の次の項目は、現在のコードで実装済みと判断する。

1. 入力ルーター統合: rawな `Input.takeKey` / `takeKeys` の利用は `raw-game-input-adapter.ts` と入力実装・テストに限定され、ゲームループは `GameInputPhase` / `GameInputRouter` を経由している。
2. Gameのフレーム処理分割: `Game.advance`、予測延長、`GamePresentation`、`run.ts` の入力→前進→導出→同期→描画のフェーズに分かれている。
3. Cloudの共通入力・ライフサイクル境界: `ClimateData`、`CloudRenderInput`、`CloudFieldBinding` / `CloudFieldSampler`、`CloudPresentation` と field source のライフサイクルが存在する。

これらを再実装対象に戻さない。後続作業で回帰が起きた場合は、既存の `test:game`、`test:render`、境界検査の失敗として扱う。

### 引き継ぐ残件

| ID | 残件 | 現状判定 | 着手順 |
| --- | --- | --- | ---: |
| L | lint設定・抑制・実違反の再整理 | 設定と抑制が現行規範からずれている | 1 |
| B | render→gameの残存参照を除去し境界を固定 | ship viewに3ファイルの型参照が残る | 2 |
| E | Earth bundleとレビュー残件 | 実bundleが現行schema契約を満たさない | 3 |
| C | Cloud cell organization | 実装なし。共通入力境界の上に追加する | 4 |
| Q | Cloud temporal stability・品質・再生成コスト | fixtureと実測が不足 | 5 |
| N | 命名整理 | 構造変更後に限定的に実施 | 6 |
| V | Vessel customization / production | 仕様・所有・資源モデル未確定 | 判断ゲート後 |

## 実装計画

### L. lint方針の再基準化

対象は `eslint.config.mjs`、`package.json`、`eslint-suppressions.json`、および違反を直す範囲の
`src/`・`tests/`・`tools/`。

1. `src/`・`tests/` と `tools/` の設定を分離する。`tools/` にゲームコードと同じ規則を適用し続ける必要があるかを設定差分で明示する。
2. `no-non-null-assertion`、`no-explicit-any`、`no-console` は、現行 `DEVELOP/CODING-RULE.md` が一律禁止していないため強制エラーから外す。`!` は外部保証でない箇所だけを別バッチで意味監査する。
3. `explicit-module-boundary-types` は、すべての引数型を要求する設定として使わず、exportされた関数と public/protected method の戻り値型を検査する形へ置き換える。設定で表せない場合は小さいカスタム検査に分ける。
4. `_` 接頭辞の未使用引数を意図的なプレースホルダーとして許可し、未使用のローカル変数・本当に不要な引数は残す。
5. 設定確定後に抑制を再生成・pruneし、import、default export、`prefer-for-of`、`prefer-const`、不規則空白、不要代入、cause保持を機械的に確定できる単位で修正する。`no-restricted-syntax` は default export と `undefined` union を分けて判定する。
6. `explicit-member-accessibility` はクラス単位で `private` / `protected` / `public` を決める。全件を `public` にする修正は禁止する。
7. 残った戻り値型、未使用変数、非null assertionをコードの意味を確認しながら修正する。目標を「抑制0件」にはしない。

受入条件:

- 設定が現行規範と矛盾する一律禁止を強制しない。
- `npm run lint`、`npm run typecheck` が成功する。
- before/afterの抑制件数と、設定由来で除外した件数を記録できる。
- `npm run lint:fix:all` の全体一括適用ではなく、差分をレビュー可能な単位で修正されている。

### B. render→gameのship表示契約を分離する

現状、次の描画ファイルがゲーム層のship型を直接参照している。

- `src/render/dynamic/ship/ship-module-view.ts`
- `src/render/dynamic/ship/modular-ship-view.ts`
- `src/render/dynamic/ship/modular-ship-dynamic-view.ts`

実装方針:

1. `src/render/dynamic/ship/` 側に、描画に必要な不変の表示契約を定義する。module id、model id、kind、hp、deployed、transform、速度・姿勢など、実際に3ファイルが読む値だけを含める。`GameContext`、汎用Services、event busは作らない。
2. `src/game/ship/` または composition root に、`ShipAssembly` / `ShipModuleInstance` から表示契約へ変換するadapterを置く。描画側へゲームオブジェクトを渡さず、既存の `ModularShip.renderSource` と `run.ts` の接続点で一度だけ変換する。
3. 3つのviewから `src/game/ship/*` の型importを除去し、render viewはrender-owned contractだけを受け取る。Cloudは既存の共通field契約を別扱いとし、この変更で再設計しない。
4. `tools/check-boundaries.mjs` に `src/render/** -> src/game/**` の検査を追加する。例外を残す場合はCloudなど対象と理由をコード上に限定して記録し、ship viewの例外は残さない。

受入条件:

- `rg` で対象ship viewから `src/game` のimportが0件。
- 変換後もmoduleのモデル・transform・状態・動的効果が既存表示と同じ入力値になる。
- 境界検査、`npm run typecheck`、`npm run test:game`、`npm run test:render` が成功する。
- 既存のHUD/Input/Gameフレーム分割を巻き戻さず、Game全体を汎用contextへ置き換えない。

### E. Earth Surfaceのデータ契約とレビュー残件

対象は `tools/earth-surface/contract.mjs`、bundle生成・検査ツール、`.earth-surface/bundle/`、
`src/render/earth-surface-*`、earth関連テスト。

1. 現行runtime契約を正本として、schema 3、z5〜z7の完全coverage、期待tile数、template、manifest hashの生成経路を確定する。古いschema 1 bundleに合わせてruntimeを後退させない。
2. 検証済みのreal inputから8K base colorとz5〜z7 bundleを再生成し、出典・生成条件・hashをmanifestへ残す。入力データをコミットするかは既存のasset方針に従い、生成物だけを置く場合も再生成手順を計画書へ残す。
3. `earth-surface-material-binding.ts` の固定 `EARTH_TEXTURE.albedoScale` がmanifest/datasetのphotometry契約と一致するか確認し、データ由来の値を渡す設計へ直す。固定値で正しい場合はその根拠をテストで固定する。
4. `DeferredTexture` の失敗通知に加え、source交換・dispose時の読み込みabortが必要かを確認する。必要なら `fetch` + `AbortController` または同等のキャンセル可能なloaderにする。失敗後に古いmaterialが残らず、source交換後に新しいbindingだけが使われることをテストする。
5. fake fixtureのテストに加えて、Game/StageのcompositionからEarth system、surface source、materialまでを通す最小統合テストを確認する。実WebGPUのFloat16対応とブラウザ表示は、対応GPU・ブラウザでのcaptureを完了条件にする。

受入条件:

- `npm run earth-surface:check` が成功し、runtime schemaとbundle schemaが一致する。
- `npm run earth-surface:test`、earth関連Pythonテスト、`npm run typecheck` が成功する。
- 8K base、z5〜z7の完全coverage、base→detail遷移、source交換、失敗/abortの結果をfixtureまたはcaptureで確認できる。
- 実ブラウザcaptureを実施できない環境では「未実施」と記録し、完了扱いにしない。

### C/Q. Cloud cell organization、安定性、品質、再生成コスト

現行の `ClimateData`、`CloudRenderInput`、`CloudFieldBinding`、`CloudFieldSampler`、
`CloudPresentation` を拡張点として使う。既存の共通入力・field sourceのライフサイクルを作り直さない。

#### C1: 組織場のモデルと評価

1. 先にrender-lab用の固定seed・固定気象・固定LOD fixtureと統計出力を作り、被覆率、cell size、row strength/aspect、connectivityのbaselineを保存する。
2. `src/render/cloud/` に cell profile、organization field、cellular evaluatorを追加する。F1/F2または同等の評価方法、seed、時間、LODを明示的な入力にし、暗黙の乱数と表現ごとの別実装を作らない。
3. surface、atmosphere、shadowが同じ詳細fieldを参照できるよう、必要な値だけを既存のfield sampler契約へ追加する。巨大なcloud state bagは導入しない。
4. CPUレベルの決定性、統計、LOD境界のテストを追加し、render-labで画像・統計を確認する。

#### Q1: temporal stability / explicit LOD

1. 同じdisplay timeを異なるframe rate、seek、LOD遷移で評価する比較fixtureを作る。
2. Blue Noise、時間シード、LOD切替のどこでフレーム差が増えるかを計測し、補間・履歴・遷移期間のいずれかを選ぶ。見た目だけで合格にしない。
3. 同一入力の再現性と許容フレーム差をfixtureに記録する。閾値はbaselineを測ってから決め、任意の数値を先に置かない。

#### Q2: shadow / internal scattering / bake cost

1. 既存GPU timingのcloud行を使って、shadow、internal scattering、sample数、品質設定別のbaselineを取得する。
2. 時刻変更・天候変更・可視性変更で `CloudPresentation` のbakeとfield生成にかかる時間を測り、現在のgeneration cacheを基準に更新間隔、visibility停止、追加cacheの必要性を決める。
3. render-labの画像とGPU計測の両方で、品質低下・ちらつき・予算超過を判定する。実測前に固定の性能目標を捏造しない。

受入条件:

- `npm run test:render` が成功し、cell統計・決定性・LOD・temporal fixtureが再現可能。
- render-labの比較画像とGPU計測に、基準入力、変更内容、許容差が記録される。
- surface、atmosphere、shadowが同じgeneration/inputを読むことをテストまたは計測で確認できる。
- bake更新の変更は、再生成コストと可視性停止の測定結果に基づく。

### N. 命名整理

ship表示境界とCloud/Earthの構造変更後に、識別子ごとに呼び出し側と責務を確認して実施する。

- `Player.behave` / enemy側の `behave` は、実際の責務に合わせて `updateBehavior`、`decideAndAct` 等の具体名を選ぶ。機械的に同じ名前へ置換しない。
- `obj` は単なる走査用ローカルか、ドメイン上の保持メンバーかを分け、後者だけを意味のある名前へ変更する。
- `Ammo` は弾薬というドメイン用語の場合があるため、一括改名しない。曖昧な変数名だけを対象にする。

受入条件は、全参照の更新、`npm run typecheck`、変更した層の回帰テスト、lint抑制の増加がないこととする。

### V. Vessel customization / production（判断ゲート）

現行のmodular ship assembly・dock・construction UIのMVPは別計画で完了している。一方、現コードと既存計画には
`VesselBlueprint`、`VesselFrame`、production queue、Hangar Workbenchの実装契約はなく、shop、inventory、material消費、
build timeも未決定である。

したがって、直ちにコードへ着手しない。まず次を仕様として決める。

- blueprint/frameの責務と保存形式
- 所有権、資源、材料消費、製造時間、失敗・中断・再開
- dock/hangar UIと既存assemblyの接続点
- save/load、networkまたは将来同期の要否
- productionの受入条件とテスト用fixture

これが `DEVELOP/SPEC/` に承認済みの振舞いとして追加された後、専用の実装計画へ分割する。仕様がないまま既存のassembly MVPへ生産機能を混ぜない。

## 実施順と並行作業

1. Lの設定再基準化と抑制再集計。
2. Bのship表示契約と境界検査。
3. EのEarth bundle契約修正とレビュー残件。
4. C1のCloud組織場。
5. Q1/Q2のCloud安定性・品質・再生成計測。
6. Nの限定的な命名整理。
7. Vは仕様判断ゲートを通過した場合だけ別計画化。

Lの設定調整とEのデータ検証は同時に調査できるが、同じファイルを編集しない。B完了前にrenderの広域lint修正を混ぜず、C1は現在のCloud共通契約を再利用してB/Eと独立した差分にする。

## レビュー結果と除外事項

- 既に完了した入力、Gameフレーム、Cloud共通境界を再計画から除外した。
- `render -> game` は既存境界検査だけでは検出されないため、ship viewの3ファイルを具体的な移行対象として追加した。
- lintの「抑制0件」、非null assertion全廃、console全廃、全引数の型注釈は現行規範から導けないため目標にしない。
- Earthは旧schemaにruntimeを合わせず、現行schema 3の生成・検査経路を直す。
- Cloudは既存の共通field契約を再構築せず、組織場・安定性・計測をその上に積む。
- Vessel productionは、仕様・所有・資源・保存が未確定なので実装開始条件を満たしていない。
- `npm run test`、`npm run build`、実ブラウザ起動確認は、mainへ送る段階または実行時確認を明示的に求められた段階の検証であり、この計画の各ローカル実装の既定検証には含めない。

## 進捗チェックリスト

- [ ] L: lint設定を現行規範へ再基準化し、抑制を再集計
- [ ] B: ship表示契約へ移行し、render→game境界を検査
- [ ] E: Earth schema 3 bundle、material/abort、実表示ゲートを完了
- [ ] C1: Cloud cell organizationと共通samplerを実装
- [ ] Q1: Cloud temporal stability / LOD fixtureを実装
- [ ] Q2: Cloud shadow・内部散乱・bakeコストを実測して判断
- [ ] N: 構造変更後の限定的な命名整理
- [ ] V: Vessel productionの仕様判断ゲート

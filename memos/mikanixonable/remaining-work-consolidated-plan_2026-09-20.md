# 残タスク統合・実装計画

## 目的と扱い

`lint-violation-remediation-plan_2026-09-16.md` と
`remaining-tasks_2026-09-12.md` を、現行コードベースに照合して再分類した計画書。
このファイルを、2計画書から引き継ぐ残件の実装順・受入条件・レビュー結果の正本とする。
元の2文書は履歴として `done/` に移動する。

## 基準スナップショットと検査結果

- 再調査日: 2026-09-22
- 対象コミット: `bd085b8e9`
- 作業ブランチ: `workspace3`
- `npm run lint`: 失敗。`src/render/cloud/cloud-field.ts` と `src/render/cloud/cloud-view-field.ts` の
  `consistent-type-imports` が各1件、加えて抑制ファイルに未使用抑制が残っている
- `npm run typecheck`: 成功
- `npm run check:boundaries`: 成功。既存の検査対象では違反0件
- `npm run test:game`: 成功（308/308）
- `npm run test:render`: 成功（238/238）
- `npm run earth-surface:test`: 成功（contract / dev delivery / release config）
- `npm run earth-surface:check`: 失敗。`.earth-surface/bundle/earth-surface.json` が旧schema 1で、現行契約のschema 3に合っていない

現行 `eslint-suppressions.json` は306ファイル、383ルール項目、915件の抑制である。旧計画の集計とは
形式・基準が異なるため、L着手時にこの値をbeforeとして保存する。

| ルール | 抑制件数 |
| --- | ---: |
| `@typescript-eslint/consistent-type-imports` | 373 |
| `@typescript-eslint/explicit-member-accessibility` | 317 |
| `no-restricted-syntax` | 124 |
| `@typescript-eslint/consistent-type-definitions` | 56 |
| `@typescript-eslint/no-unused-vars` | 11 |
| `local/explicit-public-return-type` | 15 |
| `@typescript-eslint/parameter-properties` | 14 |
| `no-unused-vars` | 2 |
| `@typescript-eslint/array-type` | 3 |

## 再分類

### 完了または今回の残件から外す項目

旧 `remaining-tasks` の次の項目は、現在のコードで実装済みと判断する。

1. 入力ルーター統合: rawな `Input.takeKey` / `takeKeys` の利用は `raw-game-input-adapter.ts` と入力実装・テストに限定され、ゲームループは `GameInputPhase` / `GameInputRouter` を経由している。
2. Gameのフレーム処理分割: `Game.advance`、予測延長、`GamePresentation`、`run.ts` の入力→前進→導出→同期→描画のフェーズに分かれている。
3. Cloudの共通入力・ライフサイクル境界: `ClimateData`、`CloudRenderInput`、`CloudFieldBinding` / `CloudFieldSampler`、`CloudPresentation` と field source のライフサイクルが存在する。
4. Shipのrender表示境界: `ShipModuleRenderInput` / `ShipRenderAssembly` と
   `src/game/ship/ship-render-adapter.ts` が存在し、3つのship viewから `src/game/ship` の型参照は消えている。
   `npm run check:boundaries` も違反0件である。
5. 命名整理の初回監査: `behave` の残存参照はなく、`Ammo` は弾薬ドメインの語彙、`obj` はJSON payloadやThree.jsの走査変数に限定される。
   現時点で責務を誤認させる高信頼の一括改名候補はないため、Nを独立した残件として引き継がない。

これらを再実装対象に戻さない。後続作業で回帰が起きた場合は、既存の `test:game`、`test:render`、境界検査の失敗として扱う。

### 再調査後に引き継ぐ残件

| ID | 残件 | 現状判定 | 着手順 |
| --- | --- | --- | ---: |
| L | lint設定・抑制・実違反の再整理 | 現行lintは2件の実違反と未使用抑制で失敗 | 1 |
| E | Earth bundleのschema 3再生成と実表示ゲート | runtime/fixtureはschema 3、実bundleだけschema 1 | 2 |
| C | Cloud cell organizationの明示的な評価 | lifecycleとorganization forcingはあるが、cell evaluator/統計fixtureは未確定 | 3 |
| Q1 | Cloud temporal stability / explicit LOD | 時刻分解・キャッシュはあるが、normal/intermediate/extremeのruntime LODは未実装 | 4 |
| Q2 | Cloud品質・shadow・内部散乱・bakeコスト | timing/比較基盤はあるが、性能qualification未達・視覚レビューpending | 5 |
| V | Vessel customization / production | 仕様・所有・資源モデル未確定 | 判断ゲート後 |

## 実装計画

### L. lint方針の再基準化

対象は `eslint.config.mjs`、`package.json`、`eslint-suppressions.json`、および違反を直す範囲の
`src/`・`tests/`・`tools/`。

現行設定では、source/test と tools のTypeScriptルールは既に分離されている。`no-non-null-assertion`、
`no-explicit-any`、`no-console` は強制せず、`_` 接頭辞の未使用引数も許可している。旧計画にあった
`explicit-module-boundary-types` は現行設定にはなく、公開戻り値を確認する `local/explicit-public-return-type`
へ置き換わっている。したがって残りは設定の再設計ではなく、現行設定に対する違反と抑制の整合である。

1. `src/render/cloud/cloud-field.ts` と `src/render/cloud/cloud-view-field.ts` の type-only importを修正する。
2. 修正後に抑制を再集計・pruneし、未使用抑制が残らない状態へする。全体一括fixではなく変更単位で差分を確認する。
3. `consistent-type-imports`、`explicit-member-accessibility`、`no-restricted-syntax`、`local/explicit-public-return-type`
   など現行設定由来の残件を、責務を確認しながら減らす。全件public化、非null assertion全廃、抑制0件は目標にしない。

受入条件:

- 設定が現行規範と矛盾する一律禁止を強制しない。
- `npm run lint`、`npm run typecheck` が成功し、未使用抑制がない。
- before/afterの抑制件数と、設定由来で除外した件数を記録できる。
- `npm run lint:fix:all` の全体一括適用ではなく、差分をレビュー可能な単位で修正されている。

### B. render→gameのship表示契約を分離する（完了）

`src/render/dynamic/ship/ship-render-contract.ts` に描画所有の不変契約を定義し、
`src/game/ship/ship-render-adapter.ts` が `ShipAssembly` から一度だけ変換する構造へ移行済みである。
`ship-module-view.ts`、`modular-ship-view.ts`、`modular-ship-dynamic-view.ts` から
`src/game/ship` のimportは0件。`tools/check-boundaries.mjs` の装置境界検査も違反0件で、
`test:game` / `test:render` のship表示テストも通過している。

この項目は再実装しない。今後の回帰は境界検査または表示層テストの失敗として扱う。

### E. Earth Surfaceのデータ契約とレビュー残件

対象は `tools/earth-surface/contract.mjs`、bundle生成・検査ツール、`.earth-surface/bundle/`、
`src/render/earth-surface-*`、earth関連テスト。

1. 現行runtime契約を正本として、schema 3、z5〜z7の完全coverage、期待tile数、template、manifest hashの生成経路を維持する。古いschema 1 bundleに合わせてruntimeを後退させない。現行 `.earth-surface/bundle/` は schema 1、z0〜z7相当の43,690タイルであり、この検査に落ちる。
2. 検証済みのreal inputから8K base colorとz5〜z7の43,008タイルを再生成し、出典・生成条件・hashをschema 3 manifestへ残す。入力データをコミットするかは既存のasset方針に従い、生成物だけを置く場合も再生成手順を残す。
3. 完了確認済み。`earth-surface-factory.ts` が manifest の `colorCalibration.diffuseAlbedoScale`、`bondAlbedo`、`averageHue` を受け取り、固定 `EARTH_TEXTURE.albedoScale` を実bundleの値として使う構造ではない。legacy fallbackの固定値はschema 1/fallback用に限定されている。
4. 完了確認済み。material binding、tile queue、resident coordinatorに `AbortController` とsource交換/disposeの世代境界があり、失敗・abort・遅着・旧material解放をearth関連render testsで確認している。
5. fake fixtureに加えてGame/StageからEarth systemまでのテストは通過している。残るのはschema 3実bundleを接続した実ブラウザ/WebGPU captureであり、対応GPU・ブラウザでの確認が終わるまで完了扱いにしない。

受入条件:

- `npm run earth-surface:check` が成功し、runtime schemaとbundle schemaが一致する（現状はschema 1 bundleのため失敗）。
- `npm run earth-surface:test`、earth関連Pythonテスト、`npm run typecheck` が成功する。
- 8K base、z5〜z7の完全coverage、base→detail遷移はschema 3 bundleで確認し、source交換、失敗/abortは既存fixture/testで維持する。
- 実ブラウザcaptureを実施できない環境では「未実施」と記録し、完了扱いにしない。

### C/Q. Cloud cell organization、安定性、品質、再生成コスト

現行の `ClimateData`、`CloudRenderInput`、`CloudFieldBinding`、`CloudFieldSampler`、
`CloudPresentation` を拡張点として使う。既存の共通入力・field sourceのライフサイクルを作り直さない。

#### C1: 組織場のモデルと評価

現行コードには `cloudLifecycleAt` のcell lifecycle、`WeatherForcingField.organization`、
RGBA basis、vertical profile、world-space sub-gridが既にある。一方、これらを「cell organization」の
評価として固定する cell profile / cellular evaluator（F1/F2相当または同等の定義）と、row strength/aspect・
connectivityを保存する統計fixtureはまだない。共通fieldの再配線は残件ではない。

1. 固定seed・固定気象・固定LODの入力を決め、被覆率、cell size、row strength/aspect、connectivityのbaselineを保存する。
2. 既存のlifecycle/organization forcingで十分かを上記fixtureで評価し、不足する場合だけ `src/render/cloud/` にcell profileと評価器を追加する。seed、時間、LODを明示入力にし、暗黙の乱数と表現ごとの別実装を作らない。
3. `CloudRenderInput` / `CloudFieldBinding` が surface、atmosphere、shadow に同じfield・generation・stateを渡す現行配線をテストで固定する。巨大なcloud state bagは導入しない。
4. CPUレベルの決定性・統計・境界のテストを追加し、render-labの画像と統計を同じfixtureから確認する。

#### Q1: temporal stability / explicit LOD

現行コードには大きな時刻を分解する `weather-time.ts`、world-space transport、同一時刻・気候世代・
projection revisionの再利用cacheがある。しかし `normal` / `intermediate` / `extreme` をruntimeで分類する
explicit temporal LOD、target anchor、時間幅に応じた平均・low-passは確認できない。visual-review toolの
モード名だけではruntime実装の受入条件を満たさない。

1. 時間倍率から temporal LOD を決める契約をruntimeへ追加し、各LODの採用anchor・更新上限・時間幅の扱いを明示する。
2. 同じdisplay timeを異なるframe rate、seek、LOD遷移で評価し、Blue Noise、時間seed、LOD切替のどこでフレーム差が増えるかを計測する。
3. 補間・履歴・遷移期間・low-passのいずれを採るかを決め、同一入力の再現性と許容フレーム差をfixtureへ記録する。閾値はbaseline後に決める。

#### Q2: shadow / internal scattering / bake cost

GPU timingのcloud行、`cloud-lab:qualification`、visual-review runner、diagnostic metrics、48枚のvisual-review
画像は既に存在する。ただし qualification出力は現作業ツリーに確認できず、旧memoの基準コミット
(`0114373a7`)での代表環境測定はB0が60fps予算を使い切り `unqualified` だった。visual review manifestも
`humanReview.status=pending` であり、現行HEADのqualificationは未実施である。

1. 現行HEADでno-cloud / cloud-enabledの総GPU p95を再取得し、shadow、atmosphere、surface、bakeの行と品質設定を対応づける。GPU timestamp非対応時にCPU時間で代用しない。
2. 時刻変更・気候変更・可視性変更で `CloudPresentation` のbakeとfield生成を測り、generation cache、visibility停止、追加cacheの要否を実測で決める。
3. render-labの画像とGPU計測の両方で、品質低下・ちらつき・予算超過を判定する。性能合格と視覚合格を別々に記録し、未計測・pendingを完了扱いにしない。

受入条件:

- `npm run test:render` が成功し、cell統計・決定性・explicit LOD・temporal fixtureが再現可能。
- render-labの比較画像とGPU計測に、基準入力、変更内容、許容差、qualification状態が記録される。
- surface、atmosphere、shadowが同じgeneration/inputを読むことをテストまたは計測で確認できる（共通入力配線は現状実装済み）。
- bake更新の変更は、再生成コストと可視性停止の測定結果に基づく。性能または視覚レビューが未完了なら残件として残す。

### N. 命名整理（今回の残件から外す）

現行コードを横断して確認した結果、`behave` の残存参照はなく、`Ammo` は弾薬のドメイン語彙、
`obj` はJSON payloadやThree.jsの走査変数に限定される。構造変更に伴って必ず直すべき対象は見つからなかった。
新たな責務変更で曖昧な識別子が現れた場合だけ、その変更の受入条件に含める。

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
2. EのEarth schema 3 bundle再生成と実表示ゲート。
3. C1のCloud組織場の評価と不足分の実装。
4. Q1のCloud temporal LOD / stability。
5. Q2のCloud品質・性能・再生成計測。
6. Vは仕様判断ゲートを通過した場合だけ別計画化。

Lの設定調整とEのデータ検証は同時に調査できるが、同じファイルを編集しない。C1/Qは現在のCloud共通契約を再利用し、Eのbundle生成やLの全体修正と独立した差分にする。

## レビュー結果と除外事項

- 既に完了した入力、Gameフレーム、Cloud共通境界を再計画から除外した。
- `render -> game` のship view移行は完了し、現行の装置境界検査で0件を確認した。
- lintの「抑制0件」、非null assertion全廃、console全廃、全引数の型注釈は現行規範から導けないため目標にしない。
- Earthは旧schemaにruntimeを合わせず、現行schema 3の生成・検査経路を直す。
- Earthのmaterial校正、abort、source交換、遅着防止はコードとfixtureで実装済みで、実bundle再生成と実表示だけを残す。
- Cloudは既存の共通field契約を再構築せず、組織場の評価、explicit temporal LOD、性能/視覚qualificationをその上に積む。
- Cloudの現行render testsは238/238で通るが、これはperformance qualificationや人間視覚reviewの完了を意味しない。
- Vessel productionは、仕様・所有・資源・保存が未確定なので実装開始条件を満たしていない。
- `npm run test`、`npm run build`、実ブラウザ起動確認は、mainへ送る段階または実行時確認を明示的に求められた段階の検証であり、この計画の各ローカル実装の既定検証には含めない。

## 進捗チェックリスト

- [ ] L: lint設定を現行規範へ再基準化し、抑制を再集計
- [x] B: ship表示契約へ移行し、render→game境界を検査
- [ ] E: Earth schema 3 bundle再生成と実表示ゲートを完了（material/abortは完了）
- [ ] C1: Cloud cell organizationをfixtureで評価し、不足分を実装
- [ ] Q1: Cloud temporal stability / explicit LODを実装・検証
- [ ] Q2: Cloud shadow・内部散乱・bakeコストをqualificationまで実測
- [ ] V: Vessel productionの仕様判断ゲート

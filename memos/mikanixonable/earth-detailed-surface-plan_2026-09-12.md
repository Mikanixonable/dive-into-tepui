# Earth詳細地表 実データ表示運用・アルベド補正 実装計画

調査スナップショット: `b9449e87a`  
作成日: 2026-09-12

## 目的

Earth詳細地表について、実データの生成・配信・WebGPU表示・計測までを一続きの運用として成立させる。あわせて、詳細材質でも既存の地球テクスチャ既定値 `EARTH_TEXTURE.albedoScale` を適用し、詳細表示とフォールバック表示の明るさを揃える。

## 決めたこと

- 詳細地表の品質確認は、fixtureや合成結果ではなく、実データを読み込んだWebGPU経路で行う。
- 本番向けCIでは、入力データがない場合にPages用fixtureを黙って成果物にしない。fixtureは契約テスト専用として明示的に扱う。
- 配信確認は、manifestだけでなくtile-index、代表タイル、基底テクスチャ、気候マップ、CORS、Content-Typeまで検査する。
- アルベド補正値は `src/render/earth-surface-defaults.ts` の既定値を参照し、詳細材質側へ同じ値を渡す。別のリテラルは追加しない。
- 新しいグラフィック設定や品質段階は追加しない。今回のアルベド変更は既存仕様の適用漏れを直すものとする。

## 変えない挙動

- 詳細データの非同期ロード、低LODへの連続フォールバック、GPU非対応時の安全なフォールバック、世代管理・破棄処理は維持する。
- Earthのライティング、影、測光の経路は変更しない。材質の色ノードへの既定アルベド補正だけを追加する。
- schema 1の既存配信物を直ちに無効化しない。ただし新規リリースでは、現在のlegacy低ズーム制約とtile coverageを検査結果に明示する。

## 達成目標

- 実データのsource／bake／package／配信検証をCIから再現でき、fixture生成は本番成功として扱われない。
- `npm run earth-surface:capture` が実際のEarthSurfaceRuntimeとWebGPU材質を使って15ケースを撮影し、`unavailable` 固定ではなく各ケースのLOD、フォールバック率、待ち時間、GPU使用量、画像バッファを出力する。
- 詳細材質の色ノードに `0.9102` が一度だけ適用され、詳細表示と基底表示の補正方針が一致する。
- 型検査、関連回帰テスト、Earthデータ契約テスト、本番ビルドが通り、実ブラウザで全ケースのcapture成果物を確認できる。

## 手順

### 1. 実データのリリース契約と配信検証を閉じる

#### 目的

実データがどこから生成・取得され、どのdatasetIdでpackageされ、実際の配信先で読み出せるかをCIで判定できるようにする。

#### 変更が必要な箇所

- `tools/earth-surface/release-config.mjs`
  - 設定値の検証に加え、検証対象datasetIdとmanifestの一致、schema／coverage／必須ファイルの整合をリリース検査へ組み込む。
- `tools/earth-surface/check.mjs`
- `tools/earth-surface/package.mjs`
  - sourceからの生成物、package成果物、receipt／provenanceを同じdatasetIdで追跡できるようにし、実データ入力を要求するリリース経路を定義する。
- `tools/earth-surface/` に配信検査用スクリプトを追加する場合は、manifest、tile-index、代表タイル、基底テクスチャ、気候マップをHTTPで検査し、CORS・Content-Type・HTTP status・tile-index件数を検証する。
- `package.json`
  - source検証、package検証、配信検証を一つの明示的なリリースコマンドから実行できるようにする。
- `.github/workflows/build.yml`
  - 実データの取得または生成済みartifactの受け渡し、`earth-surface:check`、package、Pages成果物検査、配信先検査を順序づける。
  - `EARTH_SURFACE_PAGES_INPUT` が未設定のときにfixtureを本番成果物として成功させない。fixtureを使うジョブは契約テストとして別扱いにする。
  - R2等の外部アップロードをCIで行う場合は、datasetId・接頭辞・資格情報をSecrets／環境変数から受け取り、未設定時は公開処理を実行せず明確に失敗させる。

#### 達成条件と検証

- sourceから作った実データpackageについて、manifest、tile-index、asset count、receiptが同じdatasetIdを示す。
- 配信先のmanifestとtile-indexがHTTP 200で取得でき、tile-index記載の代表タイル、base color、base terrain、climate mapが取得できる。GitHub Pages originからCORSが許可される。
- 入力なし／fixtureのみのCI実行は、本番データ検証を通過しない。
- `npm run earth-surface:check -- --input <実データbundle>`、`npm run earth-surface:test`、新設する配信検査コマンド、`npm run build` を実行する。

### 2. 実データを使うWebGPU capture経路を実装する

#### 目的

非同期ロード後の詳細材質、z4〜z7のタイル、フォールバック、GPUリソースを実ブラウザで確認できる運用を作る。

#### 変更が必要な箇所

- `tools/render-lab/earth-surface-capture.ts`
  - 固定の `unavailable` 実装を、renderer付きのEarthSurfaceRuntime生成、実manifest読み込み、Earthメッシュへの材質接続、フレームごとのLOD同期、ロード完了待ち、15ケースの計測へ置き換える。
  - `src/render/earth-surface-metrics.ts` の契約に沿って、selectedZ、errorPx、frontier、fallbackRate、decode wait、GPU layers、page-table updates、転送量、GPU p95、color／normal／depth bufferを出力する。
- `tools/render-lab/main.ts`、`tools/render-lab/lab.ts`
  - capture APIへ実行中のrenderer、RenderTarget、GPU timer、フレーム進行、失敗理由を渡す。capture対象がfallbackのままの場合は成功扱いにしない。
- `tools/render-lab/cases.ts` および必要ならEarth詳細専用のlab初期化コード
  - 既存の `CelestialSurface.textured(EARTH_TEXTURE, ...)` による簡易Earthケースと、EarthSurfaceRuntimeによる詳細ケースを混同しない構成にする。
- `webpack.render-lab.config.js`、`tools/render-lab-earth-surface.mjs`
  - ローカルbundleまたは指定した配信URLをcapture実行時に確実に参照できるようにし、capture開始前にWebGPU・manifest・renderer初期化結果を検査する。
- `tests/render/earth-surface-capture.test.ts`
- `tools/earth-surface/test_capture.mjs`
  - `unavailable` 固定を前提にした検査を、入力不備時の明示的な失敗検査と、capture契約・15ケース・必須メトリクスの検査に分離する。Node上のテストで実GPUを要求せず、ブラウザcaptureの成果物検査で実機経路を検証する。

#### 達成条件と検証

- `npm run earth-surface:capture` が実データbundleまたは検証済み配信URLを読み込み、15ケースすべてにケース識別子、ロード結果、selectedZ、fallbackRate、画像バッファを出力する。
- `himalaya`の近距離・中距離・遠距離、赤道・高緯度・極、日付変更線、海岸、青色地表、氷、負標高、海底、schematic、LOD fallbackの各ケースが欠落しない。
- capture中に詳細材質が使用されたことを、status／resident z／GPU layer／tile frontierと画像で確認できる。配信失敗時は理由が保存され、正常表示として扱われない。
- capture結果の画像を目視し、詳細地表の色・地形陰影・海底／氷／高低差ケースに黒画面、未初期化、全面fallbackがないことを確認する。`render-lab:shot`だけでは実テクスチャ待ちを保証しないため、Earth専用captureの待機完了を使用する。

### 3. 詳細材質へ既定アルベド補正を適用する

#### 目的

詳細タイルと基底材質の色計算に、地球テクスチャの既定アルベド補正を同じ方針で適用する。

#### 変更が必要な箇所

- `src/render/earth-surface-material-node.ts`
  - 詳細タイル／base textureから得た最終色へ、呼び出し側から渡されたアルベド補正を一度だけ適用する。
- `src/render/earth-surface-material-binding.ts`
- `src/render/earth-surface-factory.ts`
  - `EARTH_TEXTURE.albedoScale` を詳細材質生成へ渡す。既定値の所有元は `src/render/earth-surface-defaults.ts` のままとする。
- `tests/render/earth-surface-material-node.test.ts`
- 必要なら `tests/render/earth-surface.test.ts`
  - `0.9102` が詳細色ノードへ反映されること、base texture経路にも同じ補正がかかること、fallbackとの二重補正が起きないことを検査する。

#### 達成条件と検証

- 詳細材質の最終色計算が `EARTH_TEXTURE.albedoScale` を参照している。
- fallback材質と詳細材質でアルベド補正の適用回数が一致する。
- `npm run typecheck` と `npm run test:render` を実行し、Earth経路を変更した場合は `npm run test:game` も実行する。

### 4. 統合検証と運用引き渡し

#### 目的

データ配信、ランタイム、材質、captureの各変更を同じリリース判定へつなぎ、次回以降も未完了状態へ戻らないようにする。

#### 変更が必要な箇所

- `.github/workflows/build.yml` と `package.json`
  - 関連検査の実行順と失敗条件を確定する。
- `tools/earth-surface/` の検査・capture成果物出力先
  - datasetId、manifestのハッシュ、capture結果、失敗理由をリリースartifactとして保存する。
- HUDの既存詳細地表診断表示（`src/game/hud/windows/debug-info-window.ts`）
  - 既存表示で、loading／ready／fallbackとreasonが実データcapture時にも識別できることを確認する。表示仕様を増やすのは、既存情報で原因追跡できない場合に限る。

#### 達成条件と検証

- `npm run typecheck`
- `npm run test:render`
- `npm run test:game`
- `npm run earth-surface:test`
- `npm run earth-surface:check -- --input <実データbundle>`
- `npm run build`
- 実ブラウザで `npm run earth-surface:capture` を実行し、15ケースのmetricsと画像を確認する。

## 見積り

| 作業 | 見積り | 算出根拠 |
| --- | ---: | --- |
| リリース契約・配信検証 | 3〜5時間 | 既存のcheck/package/release-config/CIを横断して、検査スクリプトとCI失敗条件を追加する作業。外部アップロード認証の接続確認を含む。 |
| WebGPU実データcapture | 5〜8時間 | capture API、render-lab初期化、非同期待機、メトリクス収集、15ケース、成果物検査の実装とブラウザ確認。 |
| 詳細材質アルベド補正 | 1〜2時間 | 材質生成の引数伝播、ノード適用、renderテスト追加、型検査。 |
| 統合検証 | 1〜2時間 | 関連テスト、build、実データcapture、画像とmetricsの確認。 |
| **合計** | **10〜17時間** | 上記作業の合計。R2等の認証・外部CI設定が未提供の場合は、設定待ち時間を除く。 |

## リスクと落とし穴

| リスク | 影響 | 露呈箇所・対策 |
| --- | --- | --- |
| schema 1のlegacy bundleとschema 2のcoverage条件が混在する | 高 | `earth-surface:check`、release検査、manifestのdatasetId／coverage。配信前に実際のtile-indexと期待件数を検査する。 |
| CIが実データを取得できずPages fixtureを成果物にする | 高 | `.github/workflows/build.yml`。fixtureを本番成功から分離し、実データartifactまたは明示的な外部配信検証を必須にする。 |
| 大容量bundleの保存・転送制限にかかる | 高 | Pages staging、CI artifact、R2接頭辞。サイズ上限を実データ前提に再確認し、package成果物と配信先を分離する。 |
| WebGPUの非同期ロード完了前にcaptureする | 高 | `earth-surface-capture.ts`、`tools/render-lab-earth-surface.mjs`。ready、tile frontier、GPU upload完了を待ち、timeoutとreasonを記録する。 |
| 詳細材質とfallback材質でアルベドを二重適用する | 中 | `earth-surface-material-node.ts` とbindingの単体テスト。補正の所有箇所を最終色ノードに限定する。 |
| 実データ配信の資格情報・アップロード先が未設定 | 高 | CIのSecret／環境変数検査。未設定時は公開処理をスキップして成功させず、設定が必要な状態を明示する。 |
| capture APIがfallback画像を正常結果として保存する | 高 | capture成果物のstatus、fallbackRate、resident zを必須化し、詳細表示未達を失敗扱いにする。 |
| 既存の世代管理・破棄処理をcapture用初期化で壊す | 中 | `tests/render/earth-surface*.test.ts` と `tests/game/earth-system.test.ts`。runtimeの再生成、失敗後fallback、disposeを回帰確認する。 |

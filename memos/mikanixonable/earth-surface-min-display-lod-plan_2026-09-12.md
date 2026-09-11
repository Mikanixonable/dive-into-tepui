# 地球詳細テクスチャの最小表示LODをz4へ変更する計画

作成日: 2026-09-12

## 目的

地球詳細テクスチャの表示対象をz4〜z7に限定し、z4を最小表示LODにする。詳細タイルがまだ取得できない間は、詳細配信物と同じデータセットから作った全球fallbackを表示し、z1〜z3の粗い詳細タイルを表示経路から廃止する。

## 決定事項

- 詳細LODの範囲はz4〜z7。z4は512枚、z4〜z7の完全配信は43,520枚。
- fallbackのbase colorはz4タイルのガターを除いたモザイクから生成する8,192×4,096 RGB JPEGとする。旧静的`src/assets/earth.jpg`を詳細配信へ混ぜない。同じデータセット由来に揃え、fallbackからz4へ切り替わる際の色差を抑える。
- base terrainは既存のESTB形式(z0の2枚を格納)を維持する。今回の変更で地形の最小表示段までをz4へ再生成することはしない。地形のz4化は別要件として切り出せる。
- 配信manifestはschemaVersion 2へ上げ、coverageへ`minZoom: 4`を追加する。古いz0〜z3配信物は起動時・配信検査時に受け付けない。

## 受け入れ条件

1. 初期の地球詳細LOD選択がz4の全球512区画から始まり、z3以下のタイルを要求・表示・ページ表へ公開しない。
2. z4からz5以降へのsplit、z4へのmerge、2:1隣接制約、親子fadeが既存の動作を保つ。
3. runtimeのmanifest/tile-index検査、GPUページ表、material samplingがz4未満の詳細キーを拒否する。一方、base terrainのESTB内部z0は引き続き読み込める。
4. generatorとparallel generatorがz4〜z7を生成し、z4から8,192×4,096のbase colorを作る。完全配信の期待枚数は43,520枚になる。
5. fixture、Pages staging、契約検査、render/gameの回帰テストが新しい契約に揃う。
6. `npm run typecheck`と変更層のテストが通る。可能なら`npm run earth-surface:capture`で見た目を確認し、WebGPU非対応環境ならその事実を記録する。

## 実装手順

### 1. 仕様と配信契約を更新

目的: z4最小という外部から観測できる挙動を仕様とmanifest契約へ固定する。

対象:

- `DEVELOP/SPEC/RENDERING.md`
- `src/game/celestial/solar-system/earth-surface-source.ts`
- `tools/earth-surface/contract.mjs`

検証: schema、coverage、base color寸法、完全配信枚数の既存検査をz4〜z7の値で確認する。

### 2. runtimeのLOD境界を変更

目的: 初期root、reset、split/merge、要求キュー、GPUページ表、shader-side samplingの全境界でz4未満を表示経路から除く。

対象:

- `src/render/earth-surface-tiles.ts`
- `src/render/earth-surface-request.ts`
- `src/render/earth-surface-gpu.ts`
- `src/render/earth-surface-material.ts`

検証: z4 rootの初期化、z4→z5 split、z5→z4 merge、z3拒否、base sentinelの保持をunit testで確認する。

### 3. bundle生成を変更

目的: 配信実体もruntimeのLOD契約と一致させ、z4の全球画像をbase fallbackへ使う。

対象:

- `tools/earth-surface/bake.py`
- `tools/earth-surface/bake_parallel.py`

検証: key列挙、期待枚数、base JPEG寸法、z0 ESTBの互換性、fixture writerの生成結果をPython testで確認する。既存の大容量raw入力を無断で再生成しない。

### 4. fixtureと回帰テストを更新

目的: テストが旧z0開始を暗黙に要求しないよう、runtime・契約・Pages・render/game fixtureをz4開始へ揃える。

対象:

- `tests/render/earth-surface-*.test.ts`
- `tests/game/earth-system.test.ts`
- `tools/earth-surface/test_*.mjs`
- `tools/earth-surface/test_*.py`

検証: `npm run typecheck`、`npm run test:render`、`npm run test:game`、関連Python/Node test。

### 5. 実行時確認と統合

目的: 見た目の切替と生成物検査を可能な範囲で確認し、実装branchをworkspace3へ統合してコミットする。

対象: `npm run earth-surface:capture`、`npm run earth-surface:check`、workspace3へのmerge。

検証: WebGPUが利用できない場合はcapture不能を明記する。workspace3の最終status、commit、変更テスト結果を確認する。

## 見積もり

コード・契約・テストの変更はおよそ15〜25ファイル、差分はおよそ250〜500行を見込む。根拠は、LOD状態機械4ファイル、manifest/生成契約4ファイル、fixture/テスト約10ファイルがz0前提を持つため。実データ再生成は別枠で、z4〜z7の43,520タイルと8K base colorを再生成するため、既存のraw入力容量・GDAL・処理時間に依存し、この作業中には入力を消去せず実行可能性だけを確認する。

## 問題点と対策

| 問題 | 対策 |
| --- | --- |
| z4の全球rootは512枚で、初期要求数・resident層数が増える | rootの要求は既存のpending上限と可視性評価に任せ、z4全枚を一度にGPUへ常駐させない。page tableは未取得区画をbase sentinelにする |
| 旧base colorは512×256でz4切替時に解像度・色が不連続 | z4 tileの内側から8K base colorを生成し、同じbundleのデータを使用する |
| base terrain形式はz0専用で今回のz4境界と異なる | ESTBをfallback地形として維持し、低レベルdecoderのz0受け入れを壊さない |
| 旧manifest/tile-indexが残るとz0〜z3が要求できる | manifest schemaを2へ上げ、minZoomを契約検査し、request source/GPU/materialでも防御する |
| 詳細bundleは巨大で再生成に時間・容量が必要 | 生成コードとテストを先に更新し、既存raw/bundleを破壊しない。実データ再生成は入力検査後に別途判断する |
| WebGPUが使えない環境では表示確認できない | typecheck・unit/contract testを通し、captureの環境エラーを検証結果として残す |

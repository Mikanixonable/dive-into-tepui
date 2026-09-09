# 雲実装フォローアップの実施記録と残課題

作成日: 2026-09-10  
実施前スナップショット: `6e970689`
実施後スナップショット: `106cb32d`

このメモは、CloudPresentation の疎結合化とは別に進めた雲描画フォローアップの実施記録と、次に扱う課題を保持する。仕様の正本ではなく、課題の優先順位と調査入口を保持するための開発メモである。

## 実施済み

### 1. 雲場のミップマップと明示LOD

`BakedField` のGPU mip生成、線形三線形フィルタ、実在する最大LODへのクランプを実装した。`CloudFieldSampler` は明示LOD、固定LOD診断、field texel幅を共有する。

関連コミット: `103c8883`, `4075e378`, `3b908fd7`

### 2. 不透明雲の連続体積化

`CloudVolume` を追加し、2Dの雲場を高度方向の連続profileへ展開した。不透明表面は累積光学深度の閾値をG-bufferの代表面とし、大気・影も同じ密度から積分する。現状は3D気象テクスチャではなく、方向場を高度へ連続押し出すモデルである。

関連コミット: `a9e16334`, `ede1f236`, `91e18e78`

### 3. 表面・大気・影の光学契約

`CloudShapeEvaluator` と `CloudVolume` に、R=積雲被覆率、G=積雲雲頂、B=巻雲柱光学深度の意味と、柱光学深度から密度へ変換する式を集約した。`rayMarch` の区間透過とfront-to-back積分で雲を一度だけ合成し、入口・出口の二重適用を行わない。

関連コミット: `f4d274d4`, `a9e16334`

### 4. 大気雲の支持区間と標本化

大気ray marchの雲支持高度を1〜16kmとして検出し、雲が有効な視線ではサンプルの最低50%を支持区間へ配分する適応的な距離写像を追加した。これにより地平線方向で15km級の雲層を大気全体の粗いサンプルが飛び越えにくくなる。

関連コミット: `7477e1c5`

### 5. LOD境界と不透明雲法線

球分割LODへシルエット誤差ベースのヒステリシスを追加した。さらに、fieldの補間セル境界が雲面法線へ帯状に現れないよう、法線用の差分幅とLODを画面footprintおよびfield 2 texelsへ揃えた。

関連コミット: `74062753`, `aaf6c5fc`, `98a6cc8e`, `a18d05a4`, `0a1a44f1`, `126610ec`, `9df4296d`, `13f4e88b`, `30f002d6`

検証結果

- `npm run typecheck` 成功
- `npm run test:render` 成功（113/113）
- `npm run test:game` 成功（201/201）
- `npm run render-lab:cloud-sampling` 成功（4条件のPNG・フレーム差分・GPU計測を生成）
- 暖機済みのEarth斜視ケースで、雲面のベース色を維持しつつ、旧来の等高線状法線模様が消えることを確認
- 最終コードレビューで、雲層内視点の支持区間、手動mipの実在レベルクランプ、体積化後の旧シェル命名・未使用経路を点検・修正
- 診断ツールの初期化待機条件を修正し、workspace3統合後の `cloud-sampling-compare` も4条件すべて成功
- render-labに残っていた旧シェル用の空の調整欄と命名を削除

`npm run render-lab:shot` はEarth系ケースの撮影までは成功するが、後段の未登録 `pdb-5i4r` ケースで既存のエラーにより終了する。これは今回の雲変更とは無関係である。

## 次に扱う課題（優先順位）

### 1. 高優先: Blue Noiseと明示LODの時間安定性

`cloud-sampling-compare` では、Blue Noise有効・明示LOD条件だけフレーム差分が大きくなる診断結果が残っている。静止画の帯抑制と、カメラ移動・雲時刻変化時のちらつきを分離し、時系列再利用またはサンプル配置を設計する。

入口: `src/render/pipeline/atmosphere-integrator.ts`、`src/render/ray-march.ts`、`src/render/blue-noise.ts`

### 2. 高優先: 3D気象場への拡張

現行の `CloudVolume` は2D方向fieldを高度profileへ押し出すため、同じ方向で高度の異なる雲塊や鉛直方向の空間相関は表せない。3D密度場、または低周波3D補正fieldを追加する設計が必要である。

入口: `src/render/cloud/cloud-volume.ts`、`src/render/cloud/generated-cloud-field.ts`、`src/render/cloud/weather-model.ts`

### 3. 中優先: 雲影と内部散乱の品質・負荷

現在の影は固定8タップ、表面は詳細度ごとに最大48段、大気は既存の品質予算を使う。光源方向・地平線・雲頂高度ごとの誤差を計測し、適応サンプルまたは段階的解像度でGPU負荷を制御する。また、複数の雲影casterを同時に扱う必要性を決める。

入口: `src/render/pipeline/shadow/cloud-shadow-renderer.ts`、`src/render/opaque-cloud-surface-renderer.ts`、`src/game/celestial/celestial-system.ts`

### 4. 中優先: 雲焼成の更新コスト

表示時刻が変わるたびに天気の中間場と雲場を焼き直す。雲天体数、時間倍率、解像度ごとのGPU時間を計測し、更新頻度・キャッシュ・解像度制御を決める。

入口: `src/render/cloud/generated-cloud-field.ts`、`src/render/cloud/weather-model.ts`、`src/game/celestial/celestial-system.ts`

### 5. 低優先: render-labの既存タンパク質ケース修復

`pdb-5i4r` がカタログまたはfixtureへ登録されておらず、全ケース撮影の終了コードを壊している。雲とは独立だが、将来の画像回帰を自動化する前に修復する。

## コードレビューで保留した設計課題

- `CloudLodMode` は診断用で、表面・大気・影が別々の入口から設定される。比較ツール以外からも使う場合は、雲のサンプリング設定を1つの値オブジェクトで配る。
- `CloudFieldSampler.fieldTexelWidth()` は全球正距円筒図法を前提にする。雲場を別投影へ広げる場合は、投影由来の物理texel幅をSamplerの外から注入する。
- CPUの契約テストはGPUの実際のmipmap生成・TSLのlevel sampling・法線の画像回帰を代替しない。GPU実機の回帰ケースを追加する。

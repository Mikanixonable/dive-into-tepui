# 雲実装の残課題と実施順

作成日: 2026-09-10  
基準スナップショット: `4a923c84`

このメモは、CloudPresentation の疎結合化とは別に、後続で計画的に扱う雲実装の課題を記録する。仕様の正本ではなく、課題の優先順位と調査入口を保持するための開発メモである。

## 優先順位

### 1. 雲場のミップマップと明示LODの整合

`BakedField` は雲場のミップマップを生成しない一方、`CloudFieldSampler`・大気雲・雲影はLODを指定してサンプリングしている。WebGPU backendごとの実際の扱いを確認し、遠距離のエイリアシング、粒状感、雲影との不一致を抑える。

入口: `src/render/cloud/baked-field.ts`、`src/render/cloud/cloud-field-sampler.ts`、`src/render/pipeline/cloud-atmosphere-renderer.ts`、`src/render/pipeline/shadow/cloud-shadow-renderer.ts`

### 2. 不透明雲を高さ場から体積へ移行

不透明雲は単一の雲頂面との交点を深度としているため、被覆率の等値線や同一方向の複数層を表現できない。3D密度場または同等の連続体積表現に移行する設計を立てる。

入口: `src/render/opaque-cloud-surface-renderer.ts`、`DEVELOP/SPEC/RENDERING.md`「雲の描画」

### 3. 表面・大気・影の光学量を同じ雲分布から導出

表面と影は `opaqueFraction`・粒ノイズを使うが、大気雲は被覆率を直接光学的厚みに変換している。雲境界、明るさ、影の位置が一致する光学モデルを定義してから共通入力を再編成する。

入口: `src/render/cloud/cloud-shape-evaluator.ts`、`src/render/pipeline/cloud-atmosphere-renderer.ts`、`src/render/pipeline/shadow/cloud-shadow-renderer.ts`

### 4. 大気雲の入口・出口の光学厚み

球殻の入口と出口へ同じ柱光学的厚みを適用している。`field.r` の意味を「鉛直柱全体」か「片側の表面寄与」か確定し、透過率と散乱の二重適用を避ける。

入口: `src/render/pipeline/atmosphere-cloud-layers.ts`、`src/render/pipeline/cloud-atmosphere-renderer.ts`

### 5. LOD境界と時間的安定性

不透明雲のLOD選択にヒステリシスがなく、見かけ直径が境界を往復すると球メッシュ・レイマーチ回数・深度が切り替わる。境界の実測と、切替によるポップ／ちらつきの抑制方法を決める。

入口: `src/render/opaque-cloud-surface-renderer.ts`、`src/render/screen-lod.ts`

### 6. 雲影の候補選定

雲影の候補が複数あっても `casters[0]` だけを採用している。複数天体を同時に扱う必要があるかを決め、必要なら選定または積算契約を設計する。

入口: `src/game/celestial/celestial-system.ts`、`src/render/pipeline/shadow/cloud-shadow-renderer.ts`

### 7. 大気積分のBlue Noiseと時間方向の安定性

大気積分にはスクリーン固定Blue Noiseが残っている。静止画の帯抑制と、カメラ移動・時間変化時のディザ／ちらつきを分けて計測し、必要なら時系列再利用または別の積分配置を検討する。

入口: `src/render/pipeline/atmosphere-integrator.ts`、`src/render/ray-march.ts`、`src/render/blue-noise.ts`

### 8. 雲場焼成のGPU負荷

表示時刻が変わるたびに天気の中間場と雲場を焼き直す。雲天体数、時間倍率、解像度ごとのGPU時間を計測し、更新頻度・キャッシュ・解像度制御を計画する。

入口: `src/render/cloud/generated-cloud-field.ts`、`src/render/cloud/weather-model.ts`、`src/game/celestial/celestial-system.ts`

## 実施方針

1. まずミップマップ／LODの実機検証を行い、サンプリング契約を確定する。
2. 次に雲の光学モデルを定義し、表面・大気・影の一致条件をテスト可能にする。
3. その後に体積表現の設計と実装を行う。体積化によって不要になる高さ場・殻・影の近似を整理する。
4. 最後にLOD安定化、複数影、焼成負荷を個別の計画として実施する。

今回の CloudPresentation 疎結合化では、上記の描画モデルと品質挙動は変更しない。

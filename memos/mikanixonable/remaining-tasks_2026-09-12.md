# 残タスク一覧

基準日: 2026-09-12  
基準スナップショット: `5d523ca96`  
対象: 現在のコードベースと、`memos/mikanixonable`直下に残した計画書

この一覧は、計画書の記載をそのまま引き継ぐのではなく、現行コードを確認して優先度を付け直したもの。
優先度は、P0が次の変更を阻害する構造上の課題、P1が次に着手すべき機能・品質課題、P2が改善課題、
P3が将来機能または大規模な整理を示す。

## P0

### 1. Game・HUD・Renderの依存境界を固定する

`src/game/hud/`が`Game`型を直接参照し、`Game`もHUDへ自身を渡している。さらに`src/render/`にも
ゲーム層を直接参照する実装が残っている。HUD向けread modelまたは狭いportを導入し、描画入力の契約を
ゲームのcomposition rootから切り離す。

参照: [game-wide-refactoring-plan](./game-wide-refactoring-plan_2026-09-11.md)、
[game-dependency-decoupling-plan](./suspended/game-dependency-decoupling-plan_2026-09-10.md)、
[codebase-coupling-review](./suspended/codebase-coupling-review_2026-09-08.md)

### 2. 入力ルーターをゲームループへ統合する

`src/game/input/game-input-router.ts`などの契約は存在するが、現行コードでは複数のUI・ゲーム機能が
`Input.takeKey`/`takeKeys`を直接呼んでいる。入力優先順を維持したままrouterへ集約し、raw inputの
利用箇所を減らす。

参照: [game-wide-refactoring-plan](./game-wide-refactoring-plan_2026-09-11.md)、
[game-dependency-decoupling-plan](./suspended/game-dependency-decoupling-plan_2026-09-10.md)

## P1

### 3. Gameのフレーム処理をCoordinator/Runtimeへ分割する

`Game.update()`、`sync()`、`render()`に入力配分・シミュレーション前進・表示更新が集中している。
`update → sync → render`の順序を変えず、Gameにはフェーズ順序と所有ライフサイクルを残す。

参照: [game-wide-refactoring-plan](./game-wide-refactoring-plan_2026-09-11.md)

### 4. Cloudの共通入力・ライフサイクル境界を作る

気候データ、雲場、Sampler、世代管理がまだ表現ごとに分散している。`ClimateData`、
`CloudRenderInput`、共有runtime/Samplerの順に導入し、地表・大気・雲影が同じ入力を読む構造にする。

参照: [cloud-climate-rendering-separation-plan](./cloud-climate-rendering-separation-plan_2026-09-11.md)、
[cloud-rendering-refactor-followups](./suspended/cloud-rendering-refactor-followups_2026-09-10.md)

### 5. CloudのTemporal Stabilityを改善する

Blue Noiseとexplicit LODの組み合わせでフレーム間差が大きい条件が残っている。まず比較fixtureで
ちらつきとフレーム差を固定し、時間方向の安定化とLOD遷移を実測する。

参照: [cloud-implementation-followups](./cloud-implementation-followups_2026-09-10.md)

### 6. Earth Surfaceのschema2 z4〜z7実bundleと実表示を確認する

runtimeのz4最小LODは完了したが、ローカルに確認できるbundleは旧schema1互換入力である。z4〜z7の
完全bundle、8K base color、実データmanifestを生成・検査し、可能な環境で実ブラウザ表示を確認する。

参照: [earth-surface-min-display-lod-plan](./done/earth-surface-min-display-lod-plan_2026-09-12.md)、
[earth-surface-review-findings](./earth-surface-review-findings_2026-09-10.md)

### 7. Cloud cell organizationを実装する

現行のCloudVolumeは主に2D場を高さ方向へ押し出す構造で、cell profile、organization field、
cellular evaluatorは未実装。共通入力境界を先に確定し、その後に地表・大気・雲影へ統合する。

参照: [cloud-cell-organization-plan](./cloud-cell-organization-plan_2026-09-11.md)、
[cloud-implementation-proposals](./suspended/cloud-implementation-proposals_2026-09-08.md)

## P2

### 8. Earth Surfaceレビュー残件を再確認する

ベースカラー補正、DeferredTextureの失敗・abort処理、source交換後のmaterial binding、
実WebGPUのFloat16対応を現行コードと実機で再確認する。z4最小LODの完了とは別の品質・堅牢性課題。

参照: [earth-surface-review-findings](./earth-surface-review-findings_2026-09-10.md)

### 9. Cloud shadow・内部散乱の品質と性能を改善する

雲影の安定性、内部散乱、サンプル数、GPU負荷をrender-labで測定し、品質設定と性能予算を決める。

参照: [cloud-implementation-followups](./cloud-implementation-followups_2026-09-10.md)、
[cloud-rendering-refactor-followups](./suspended/cloud-rendering-refactor-followups_2026-09-10.md)

### 10. Cloud bake・天候更新時の再生成コストを抑える

時刻変化や天候変化でのweather/intermediate/cloud field再生成を計測し、キャッシュ・更新間隔・
可視性による停止条件を決める。

参照: [cloud-implementation-followups](./cloud-implementation-followups_2026-09-10.md)、
[cloud-implementation-proposals](./suspended/cloud-implementation-proposals_2026-09-08.md)

## P3

### 11. 命名整理を構造変更後に行う

`DynamicEntity.obj`、`Player.behave`、`Ammo`などの候補を、依存境界と責務分割が固まった後に改名する。
先に一括改名すると、構造変更時の再変更が増える。

参照: [プラスチックワード命名調査・改善案](./suspended/プラスチックワード命名調査・改善案_2026-08-14.md)

### 12. Vesselカスタマイズ・生産機能を設計・実装する

`VesselBlueprint`、`VesselFrame`、生産キュー、ハンガーワークベンチは現行コードに未実装。
コア基盤の境界整理後に、機能要件と実装範囲を再確認して着手する。

参照: [vessel customization proposal](./suspended/vessel_customization_and_production_proposal.md)

## 今回完了として整理した計画

- [opaque-cloud-climate-source-fix-plan](./done/opaque-cloud-climate-source-fix-plan_2026-09-10.md)
- [earth-surface-min-display-lod-plan](./done/earth-surface-min-display-lod-plan_2026-09-12.md)

実ERA5データの精度、実データbundleの公開、実ブラウザの見た目確認は、上記の完了判定に含めていない。

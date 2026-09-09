# T3: Earth entityとruntime bootstrapを接続する

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

## 目的

Earthだけを新しいmanifest、request queue、resident coordinator、GPU materialへ接続し、ゲームの寿命管理とPages runtime設定を完成する。

## 実装範囲

1. EarthSurfaceが地球のメッシュ、material、Context、tiles、request queue、resident coordinator、
   GPU adapter、全球baseを所有するfactoryを作る。
2. Earthだけを新factoryへ差し替え、月・他天体はCelestialSurfaceのままにする。
3. manifest URLを正本にしてbootstrapする。manifestが無い、検証に失敗する、GPU能力が足りない場合はbase-onlyとする。
4. manifest、datasetId、hash、tile-index、base、気候mapの整合性を検証し、loading/ready/error/fallbackを区別する。
5. renderer.getDrawingBufferSize()をLODへ渡し、window.innerWidth/innerHeightをタイル判定へ使わない。
6. position、姿勢、半軸、bodyToView、drawing buffer確定後に、形状LOD、texture frontier、coordinator同期を同じframeで行う。
7. EarthSurfaceのsyncFrameごとにrequest leaseを破棄しない。leaseはhide、dispose、source swap、generation invalidation時だけ解放する。
8. タイルcacheは可視frontierとfade中だけをpinする。画面外の古いleafを無期限pinしない。
9. 非表示時は要求キャンセル、generation無効化、base公開、page table reset、不要GPU層解放、Context解放を行う。
10. setVisible(false)からsurface.hideまでの経路を接続し、再表示時に古い結果を公開しない。
11. 旧smoothness画像はmanifestが無い開発環境だけfallbackとして残し、実manifest経路ではroughnessを併用しない。
12. 旧T6-3のbuild/runtime接続もこのタスクで扱う。Pages subpathから相対manifest URLを構成し、URLをハードコードしない。

## 完了条件

- Earthだけが新経路を使い、月・他天体は回帰しない。
- 表示→非表示→再表示→disposeでHTTP、decode、resident、GPU層、page table、AbortControllerが解放される。
- 複数syncFrameで進行中requestが毎フレームabortされない。
- カメラ移動で128層を使い切らず、画面外tileが再利用できる。
- manifest欠損、hash不一致、異なるdatasetId、GPU能力不足がゲームを停止させずbaseへ戻る。

# T3: Earth entityへ本接続する

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

このファイルは、このタスクを実装するときに読む作業単位である。共通の固定前提は親計画の§2、
依存関係は§3を参照する。実装済みの契約は`done/`ではなくコードを原本とする。


**変更対象**: `src/render/earth-surface.ts`、`src/game/celestial/solar-system/earth-system.ts`、
`src/render/celestial-surface.ts`、`src/render/pipeline/render-pipeline.ts`、Earth/Render tests。

1. EarthSurfaceがContext、EarthSurfaceTiles、request queue、resident coordinator、GPU、material、全球baseを所有するfactoryを作る。
2. Earthだけを新factoryへ差し替え、月・他天体は`CelestialSurface`のままにする。manifestが無い場合はbase-onlyで動く。
3. `renderer.getDrawingBufferSize()`をLODへ渡し、`window.innerWidth/innerHeight`をタイル判定に使わない。
4. 位置・姿勢・半軸・`bodyToView`確定後に形状LOD、テクスチャfrontier、coordinator同期を同じframeで行う。
5. 非表示・表示復帰・disposeで、要求キャンセル→generation無効化→base公開→GPU層解放→Context解放の順を守る。
6. Earthの旧`smoothnessUrl`と実タイルのroughnessを併用せず、実manifestが無い開発環境だけ旧画像をfallbackに残す。

**検証**: `npm run test:render`、`npm run test:game`。表示→非表示→再表示→disposeでHTTP、decode、resident、GPU層、page table、AbortControllerが解放されることを確認する。

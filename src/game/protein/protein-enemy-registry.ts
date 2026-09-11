// タンパク質の敵1体ぶんの、意味論と判定形状の定義。アセットが揃った id から1つだけ組み、
// 以降は使い回す。
import {
  proteinAssetBundleFor, proteinAssetFor, type ProteinAssetId, type ProteinSemanticSource,
} from './protein-asset-loader';
import { buildProteinCollisionSpheres, type ProteinCollisionSphere } from './protein-sphere-collision';
import type { ProteinAssetDefinition, ProteinMotionAsset } from './protein-schema';

export interface ProteinEnemyDefinition {
  readonly assetId: ProteinAssetId;
  readonly asset: ProteinAssetDefinition;
  readonly motion: ProteinMotionAsset;
  /** 表示形態に依らない判定形状。アセットごとに1つで、個体は位置と姿勢だけを渡す。 */
  readonly collisionSpheres: readonly ProteinCollisionSphere[];
}

/** 判定形状を組み、意味論の定義と束ねた敵定義を作る。 */
export function createProteinEnemyDefinition(
  assetId: ProteinAssetId,
  source: ProteinSemanticSource,
): ProteinEnemyDefinition {
  return {
    assetId,
    asset: source.asset,
    motion: source.motion,
    collisionSpheres: buildProteinCollisionSpheres(source.backbone, source.asset.coordinateScale),
  };
}

// asset の fetch 完了(protein-asset-loader.requestProteinAsset が起こす)を待ってから作るため、
// 事前に全件は構築できない。id ごとに初回アクセス時に組み、以降は使い回す。
const proteinEnemyDefinitionCache = new Map<ProteinAssetId, ProteinEnemyDefinition>();

/** 任意の文字列から登録済みタンパク質敵定義を検索する。asset 未取得なら null。 */
export function proteinEnemyDefinitionFor(id: string): ProteinEnemyDefinition | null {
  if (!proteinAssetFor(id)) return null;
  const assetId = id as ProteinAssetId;
  const cached = proteinEnemyDefinitionCache.get(assetId);
  if (cached) return cached;
  const bundle = proteinAssetBundleFor(assetId);
  if (!bundle) return null;
  const definition = createProteinEnemyDefinition(assetId, bundle.semantic);
  proteinEnemyDefinitionCache.set(assetId, definition);
  return definition;
}

import * as THREE from 'three/webgpu';
import {
  buildProteinEnemyShip, replaceProteinEnemyShip, type ProteinRenderSource,
} from '../../render/protein-enemy-ship';
import { buildProteinCollisionRibbon } from '../../render/protein-ribbon';
import {
  proteinAssetBundleFor, proteinAssetFor, type ProteinAssetId,
} from './protein-asset-loader';
import type { ProteinAssetDefinition, ProteinMotionAsset } from './protein-schema';
import type { ProteinDisplaySettings } from './protein-display';

export interface ProteinEnemyDefinition {
  readonly assetId: ProteinAssetId;
  readonly asset: ProteinAssetDefinition;
  readonly motion: ProteinMotionAsset;
  readonly buildRenderObject: (display: ProteinDisplaySettings, motion?: import('../../render/protein-motion-material').ProteinMotionBinding) => THREE.Object3D;
  readonly recolorRenderObject: (target: THREE.Object3D, display: ProteinDisplaySettings, motion?: import('../../render/protein-motion-material').ProteinMotionBinding) => void;
  readonly buildCollisionObject: () => THREE.Object3D;
}

const PROTEIN_INTERNAL_RIBBON_COLOR = new THREE.Color(0xffffff);

/** 描画と固定衝突形状を共有 asset へ束ねた敵定義を作る。 */
export function createProteinEnemyDefinition(
  assetId: ProteinAssetId,
  source: ProteinRenderSource,
): ProteinEnemyDefinition {
  // 表示の再構築だけが設定へ追従し、衝突形状は専用プロファイルに固定する。
  return {
    assetId,
    asset: source.semantic,
    motion: source.motion,
    buildRenderObject: (display, motion) => buildProteinEnemyShip(source, display, motion),
    recolorRenderObject: (target, display, motion) => replaceProteinEnemyShip(
      target, buildProteinEnemyShip(source, display, motion),
    ),
    buildCollisionObject: () => buildProteinCollisionRibbon(
      source, 'chain', PROTEIN_INTERNAL_RIBBON_COLOR,
    ),
  };
}

// asset の fetch 完了(protein-asset-loader.startProteinAssetPreload)を待ってから作るため、
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
  const definition = createProteinEnemyDefinition(assetId, bundle);
  proteinEnemyDefinitionCache.set(assetId, definition);
  return definition;
}

import * as THREE from 'three/webgpu';
import {
  buildProteinEnemyShip, buildProteinRibbonShip, replaceProteinEnemyShip, type ProteinRenderSource,
} from '../../render/protein-enemy-ship';
import {
  PROTEIN_ASSET_IDS, proteinAssetBundleFor, proteinAssetFor, type ProteinAssetId,
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

function proteinRenderSourceFor(id: ProteinAssetId): ProteinRenderSource {
  const bundle = proteinAssetBundleFor(id);
  if (!bundle) throw new Error(`Unknown protein asset bundle: ${id}`);
  return bundle;
}

function createProteinEnemyDefinition(
  assetId: ProteinAssetId,
  source: ProteinRenderSource,
): ProteinEnemyDefinition {
  return {
    assetId,
    asset: source.semantic,
    motion: source.motion,
    buildRenderObject: (display, motion) => buildProteinEnemyShip(source, display, motion),
    recolorRenderObject: (target, display, motion) => replaceProteinEnemyShip(
      target, buildProteinEnemyShip(source, display, motion),
    ),
    buildCollisionObject: () => buildProteinRibbonShip(
      source, 'chain', PROTEIN_INTERNAL_RIBBON_COLOR,
    ),
  };
}

const PROTEIN_ENEMY_DEFINITIONS = Object.fromEntries(PROTEIN_ASSET_IDS.map((assetId) => [
  assetId,
  createProteinEnemyDefinition(assetId, proteinRenderSourceFor(assetId)),
])) as Readonly<Record<ProteinAssetId, ProteinEnemyDefinition>>;

export function proteinEnemyDefinitionFor(id: string): ProteinEnemyDefinition | null {
  if (!proteinAssetFor(id)) return null;
  return PROTEIN_ENEMY_DEFINITIONS[id as ProteinAssetId] ?? null;
}

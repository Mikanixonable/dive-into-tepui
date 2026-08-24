import * as THREE from 'three/webgpu';
import {
  buildPdb5i4rEnemyShip, buildPdb5i4rRibbonShip, recolorPdb5i4rEnemyShip,
} from '../../render/ships';
import {
  PDB5I4R_ASSET, proteinAssetFor, type ProteinAssetId,
} from './protein-asset-loader';
import type { ProteinAssetDefinition } from './protein-schema';
import type { ProteinDisplaySettings } from './protein-display';

export interface ProteinEnemyDefinition {
  readonly assetId: ProteinAssetId;
  readonly asset: ProteinAssetDefinition;
  readonly buildRenderObject: (display: ProteinDisplaySettings) => THREE.Object3D;
  readonly recolorRenderObject: (target: THREE.Object3D, display: ProteinDisplaySettings) => void;
  readonly buildCollisionObject: () => THREE.Object3D;
}

const PROTEIN_ENEMY_DEFINITIONS: Readonly<Record<ProteinAssetId, ProteinEnemyDefinition>> = {
  'pdb-5i4r': {
    assetId: 'pdb-5i4r',
    asset: PDB5I4R_ASSET,
    buildRenderObject: (display) => buildPdb5i4rEnemyShip(display),
    recolorRenderObject: (target, display) => recolorPdb5i4rEnemyShip(target, display),
    buildCollisionObject: () => buildPdb5i4rRibbonShip('chain'),
  },
};

export function proteinEnemyDefinitionFor(id: string): ProteinEnemyDefinition | null {
  if (!proteinAssetFor(id)) return null;
  return PROTEIN_ENEMY_DEFINITIONS[id as ProteinAssetId] ?? null;
}

import * as THREE from 'three/webgpu';
import {
  buildPdb5i4rEnemyShip, buildPdb5i4rRibbonShip, recolorPdb5i4rEnemyShip,
} from '../../render/ships';
import myoglobinBackbone from '../../assets/models/myoglobin1mbnBackbone.json';
import {
  buildProteinEnemyShip, buildProteinRibbonShip, replaceProteinEnemyShip, type ProteinRenderSource,
} from '../../render/protein-enemy-ship';
import {
  MYOGLOBIN_1MBN_ASSET, PDB5I4R_ASSET, proteinAssetFor, type ProteinAssetId,
} from './protein-asset-loader';
import { MYOGLOBIN_1MBN_DISPLAY_ASSET } from './protein-display-asset';
import type { ProteinAssetDefinition } from './protein-schema';
import type { ProteinDisplaySettings } from './protein-display';

export interface ProteinEnemyDefinition {
  readonly assetId: ProteinAssetId;
  readonly asset: ProteinAssetDefinition;
  readonly buildRenderObject: (display: ProteinDisplaySettings) => THREE.Object3D;
  readonly recolorRenderObject: (target: THREE.Object3D, display: ProteinDisplaySettings) => void;
  readonly buildCollisionObject: () => THREE.Object3D;
}

const MYOGLOBIN_RENDER_SOURCE: ProteinRenderSource = {
  semantic: MYOGLOBIN_1MBN_ASSET,
  backbone: myoglobinBackbone,
  structure: MYOGLOBIN_1MBN_DISPLAY_ASSET,
};

const PROTEIN_ENEMY_DEFINITIONS: Readonly<Record<ProteinAssetId, ProteinEnemyDefinition>> = {
  'pdb-5i4r': {
    assetId: 'pdb-5i4r',
    asset: PDB5I4R_ASSET,
    buildRenderObject: (display) => buildPdb5i4rEnemyShip(display),
    recolorRenderObject: (target, display) => recolorPdb5i4rEnemyShip(target, display),
    buildCollisionObject: () => buildPdb5i4rRibbonShip('chain'),
  },
  'pdb-1mbn-myoglobin': {
    assetId: 'pdb-1mbn-myoglobin',
    asset: MYOGLOBIN_1MBN_ASSET,
    buildRenderObject: (display) => buildProteinEnemyShip(MYOGLOBIN_RENDER_SOURCE, display),
    recolorRenderObject: (target, display) => replaceProteinEnemyShip(
      target, buildProteinEnemyShip(MYOGLOBIN_RENDER_SOURCE, display),
    ),
    buildCollisionObject: () => buildProteinRibbonShip(MYOGLOBIN_RENDER_SOURCE, 'chain'),
  },
};

export function proteinEnemyDefinitionFor(id: string): ProteinEnemyDefinition | null {
  if (!proteinAssetFor(id)) return null;
  return PROTEIN_ENEMY_DEFINITIONS[id as ProteinAssetId] ?? null;
}

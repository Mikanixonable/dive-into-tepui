import * as THREE from 'three/webgpu';
import { buildEnemyShip, buildStage0EnemyShip } from '../../render/ships';
import { type ProteinMotionBinding } from '../../render/protein-motion-material';
import { proteinEnemyDefinitionFor } from '../protein/protein-enemy-registry';
import {
  DEFAULT_PROTEIN_DISPLAY, isProteinDisplaySettings, type ProteinDisplaySettings,
} from '../protein/protein-display';
import { proteinAssetIdForEnemyKind, type EnemyKind } from './enemy-kind';

// enemyKind の種別に応じたメッシュを組む。
export function buildEnemyRenderObject(
  enemyKind: EnemyKind, accent: string | number, motionBinding?: ProteinMotionBinding,
): THREE.Object3D {
  if (enemyKind.kind === 'stage0') return buildStage0EnemyShip(accent, enemyKind.typeIndex);
  const proteinId = proteinAssetIdForEnemyKind(enemyKind);
  if (proteinId !== null) {
    const definition = proteinEnemyDefinitionFor(proteinId);
    if (!definition) throw new Error(`No protein enemy definition registered for ${proteinId}`);
    const display: ProteinDisplaySettings = enemyKind.kind === 'protein' && isProteinDisplaySettings(enemyKind.display)
      ? enemyKind.display
      : DEFAULT_PROTEIN_DISPLAY;
    return definition.buildRenderObject(display, motionBinding);
  }
  return buildEnemyShip(accent);
}

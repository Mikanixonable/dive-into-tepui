import * as THREE from 'three/webgpu';
import { buildEnemyShip, buildStage0EnemyShip } from '../../../render/ships';
import { type ProteinMotionBinding } from '../../../render/protein-motion-material';
import { proteinEnemyDefinitionFor } from '../../protein/protein-enemy-registry';
import {
  DEFAULT_PROTEIN_DISPLAY, isProteinDisplaySettings, type ProteinDisplaySettings,
} from '../../protein/protein-display';
import { proteinAssetIdForEnemyKind, type EnemyKind } from './enemy';

// 敵の見た目を組み立てる。
export function buildEnemyRenderObject(
  enemyKind: EnemyKind, accent: string | number, motionBinding?: ProteinMotionBinding,
): THREE.Object3D {
  if (enemyKind.kind === 'stage0') return buildStage0EnemyShip(accent, enemyKind.typeIndex);
  // タンパク質型はカタログの登録アセットから、実際のタンパク質構造モデルを組む。
  const proteinId = proteinAssetIdForEnemyKind(enemyKind);
  if (proteinId !== null) {
    const definition = proteinEnemyDefinitionFor(proteinId);
    if (!definition) throw new Error(`No protein enemy definition registered for ${proteinId}`);
    const display: ProteinDisplaySettings = enemyKind.kind === 'protein' && isProteinDisplaySettings(enemyKind.display)
      ? enemyKind.display
      : DEFAULT_PROTEIN_DISPLAY;
    return definition.buildRenderObject(display, motionBinding);
  }
  // それ以外(drifting)は従来型の艦体メッシュ。
  return buildEnemyShip(accent);
}

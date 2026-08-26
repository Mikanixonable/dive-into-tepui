import { v3, type Vec3 } from '../../physics/vec3';
import type { ProteinAssetId } from '../protein/protein-asset-loader';
import {
  isProteinDisplaySettings, proteinDisplayFromLegacyColorMode, type ProteinColorMode, type ProteinDisplaySettings,
} from '../protein/protein-display';

type LegacyPdb5i4rEnemyKind = {
  kind: 'pdb-5i4r';
  colorMode?: ProteinColorMode;
  display?: ProteinDisplaySettings;
};

export type EnemyKind =
  | { kind: 'drifting' }
  | { kind: 'stage0'; typeIndex: number }
  | { kind: 'protein'; assetId: ProteinAssetId; display?: ProteinDisplaySettings }
  | LegacyPdb5i4rEnemyKind;

export function proteinAssetIdForEnemyKind(enemyKind: EnemyKind): ProteinAssetId | null {
  if (enemyKind.kind === 'protein') return enemyKind.assetId;
  if (enemyKind.kind === 'pdb-5i4r') return 'pdb-5i4r';
  return null;
}

export function normalizeEnemyKind(enemyKind: EnemyKind): EnemyKind {
  if (enemyKind.kind !== 'pdb-5i4r') return enemyKind;
  return {
    kind: 'protein',
    assetId: 'pdb-5i4r',
    display: isProteinDisplaySettings(enemyKind.display)
      ? enemyKind.display
      : proteinDisplayFromLegacyColorMode(enemyKind.colorMode),
  };
}

// enemyKind ごとの主慣性モーメント。'drifting' は非対称にしてジャニベコフ効果(中間軸不安定性)
// を起こし、'stage0' は機首をプログレードへ向けたまま飛ぶので等方でよい。
export function inertiaForEnemyKind(enemyKind: EnemyKind): Vec3 {
  return enemyKind.kind === 'stage0' ? v3(1, 1, 1) : v3(1, 1.1, 1.05);
}

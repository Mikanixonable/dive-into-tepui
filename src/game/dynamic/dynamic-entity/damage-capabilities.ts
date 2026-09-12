import type { DynamicMotion } from '../dynamic-motion';
import type { Part } from './parts';
import type { ProteinCombatReadout } from '../../protein/protein-schema';

// 戦闘対象の共通ライフサイクルと、実装ごとのダメージモデルを分けるための能力契約。
export interface CombatEntity {
  readonly motion: DynamicMotion;
  readonly hp: number;
  readonly maxHp: number;
}

export interface PartDamageTarget extends CombatEntity {
  readonly parts: readonly Part[];
}

export interface ProteinCombatTarget extends CombatEntity {
  readonly combatReadout: ProteinCombatReadout;
}

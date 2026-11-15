import type { DynamicMotion } from '../dynamic-motion';
import type { Part } from './parts';

// 戦闘対象の共通ライフサイクルと、実装ごとのダメージモデルを分離するインターフェース定義。
interface CombatEntity {
  readonly motion: DynamicMotion;
  readonly hp: number;
  readonly maxHp: number;
}

export interface PartDamageTarget extends CombatEntity {
  readonly parts: readonly Part[];
}


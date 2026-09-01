// 敵クラスの一覧と、セーブの種別タグからの引き当て。
// enemy.ts へ畳むと enemy.ts → 具象 → enemy.ts の実行時循環になり、
// `class MetalEnemy extends Enemy` の評価時に Enemy が TDZ で落ちる。
import { type EnemyClass } from './enemy';
import { MetalEnemy } from './metal-enemy';
import { ProteinEnemy } from './protein-enemy';

export const ENEMY_CLASSES: readonly EnemyClass[] = [MetalEnemy, ProteinEnemy];

// セーブ由来の未検証文字列を含む種別タグから敵クラスを引く。該当が無ければ null。
export function findEnemyClass(kind: string): EnemyClass | null {
  return ENEMY_CLASSES.find((c) => c.kind === kind) ?? null;
}

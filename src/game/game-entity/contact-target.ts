// 剛体接触の相手の種別。判定を1箇所へ閉じ込め、相手が天体かどうかを肯定形で問えるようにする。
import type { Attractor } from '../../physics/attractor';
import type { GameEntity } from './game-entity';

// 接触の相手。ゲームオブジェクトか、解析天体か。
export type ContactTarget = GameEntity | Attractor;

// 相手が解析天体か。重力定数 mu を持つのは天体だけ。
export function isAttractor(target: ContactTarget): target is Attractor {
  return 'mu' in target;
}

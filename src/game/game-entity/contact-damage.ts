// 個体どうしの剛体接触が装甲へ与えるダメージの根拠となる量。物理の接近速度に、相手の種別ごとの
// 重みを掛ける。重みはゲームバランスの調整値であり、物理の質量からは導かない。
import { closingSpeed, type Contact } from './contact';
import type { GameEntity } from './game-entity';

// 受け手がこの接触で受けるダメージの根拠 [m/s]。0 を返す相手は無傷で済む。
export function contactDamageSpeed(other: GameEntity, contact: Contact): number {
  return closingSpeed(contact) * other.contactDamageWeight;
}

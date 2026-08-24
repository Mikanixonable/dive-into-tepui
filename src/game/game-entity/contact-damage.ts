// 個体どうしの剛体接触が装甲へ与えるダメージの根拠となる量。物理の接近速度に、相手の種別ごとの
// 重みを掛ける。重みはゲームバランスの調整値であり、物理の質量からは導かない。
import { closingSpeed, type Contact } from './contact';
import * as C from '../const';

interface ContactDamageSource {
  readonly contactDamageWeight: number;
}

// 受け手がこの接触で受けるダメージの根拠 [m/s]。0 を返す相手は無傷で済む。
export function contactDamageSpeed(other: ContactDamageSource, contact: Contact): number {
  return closingSpeed(contact) * other.contactDamageWeight;
}

// Shared by every collidable ship. Below the minimum speed there is no damage;
// damage reaches the full HP amount at the full closing speed with a linear ramp.
export function collisionDamageFraction(speed: number): number {
  const span = C.COLLISION_DAMAGE_FULL_CLOSING_SPEED - C.COLLISION_DAMAGE_MIN_CLOSING_SPEED;
  return Math.min(1, Math.max(0, (speed - C.COLLISION_DAMAGE_MIN_CLOSING_SPEED) / span));
}

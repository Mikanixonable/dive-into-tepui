// 個体どうしの剛体接触が装甲へ与えるダメージの根拠となる量。物理の接近速度に、相手の種別ごとの
// 重みを掛ける。重みはゲームバランスの調整値であり、物理の質量からは導かない。
import { closingSpeed, type Contact } from './contact';

// 接触の瞬間の接近速度(法線方向の相対速度)のしきい値 [m/s]。これ未満なら無傷、これ以上で
// パーツの最大 HP 分、間は線形。
export const COLLISION_DAMAGE_MIN_CLOSING_SPEED = 50;
export const COLLISION_DAMAGE_FULL_CLOSING_SPEED = 500;

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
  const span = COLLISION_DAMAGE_FULL_CLOSING_SPEED - COLLISION_DAMAGE_MIN_CLOSING_SPEED;
  return Math.min(1, Math.max(0, (speed - COLLISION_DAMAGE_MIN_CLOSING_SPEED) / span));
}

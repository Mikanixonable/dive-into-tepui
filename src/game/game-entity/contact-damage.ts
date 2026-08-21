// 剛体接触が装甲へ与えるダメージの根拠となる量。物理の接近速度に、相手の種別ごとの重みを掛ける。
// 重みはゲームバランスの調整値であり、物理の質量からは導かない。
import { closingSpeed, type Contact } from './contact';
import { isAttractor, type ContactTarget } from './contact-target';

// 天体の表面を相手にしたときの重み。
const ATTRACTOR_DAMAGE_WEIGHT = 1;

// 受け手がこの接触で受けるダメージの根拠 [m/s]。0 を返す相手は無傷で済む。
export function contactDamageSpeed(other: ContactTarget, contact: Contact): number {
  const weight = isAttractor(other) ? ATTRACTOR_DAMAGE_WEIGHT : other.contactDamageWeight;
  return closingSpeed(contact) * weight;
}

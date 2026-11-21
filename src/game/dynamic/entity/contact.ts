// 1回の接触を、受け手から見た形で記述する語彙。解決器(dynamic/)が組み、受け手の
// Motion の接触反応と contactDamageSpeed が読む。
import type { KinematicState } from '../../../physics/kinematic-state';
import { type Vec3, dot, sub } from '../../../math/vec3';

// self/other は受け手ごとに入れ替えて組み直す(normal も向きが反転する)ので、同じ解決結果から
// 自分用と相手用の2つを作る。
export interface Contact {
  readonly t: number; // 接触時刻 [sim s]
  readonly point: Vec3; // 接触点(ECI)
  readonly normal: Vec3; // self → other 向きの単位法線
  // compound 接触での self/other 側の module id。球・従来形状・地表接触は null/省略。
  readonly selfModuleId?: string | null;
  readonly otherModuleId?: string | null;
  readonly selfState: KinematicState; // 接触直前(反応前)の自分
  readonly otherState: KinematicState; // 接触直前(反応前)の相手
}

// 接触の瞬間に両者が近づいていた速さ [m/s]。離反していれば 0。normal は self → other 向きな
// ので、近づいている状態とは相対速度の法線成分が正であることを指す。
export function closingSpeed(contact: Contact): number {
  return Math.max(0, dot(sub(contact.selfState.v, contact.otherState.v), contact.normal));
}

// ── 接触ダメージの根拠 ──


// 接触の瞬間の接近速度(法線方向の相対速度)のしきい値 [m/s]。これ未満なら無傷、これ以上で
// パーツの最大 HP 分、間は線形。
const COLLISION_DAMAGE_MIN_CLOSING_SPEED = 50;
const COLLISION_DAMAGE_FULL_CLOSING_SPEED = 500;

interface ContactDamageSource {
  readonly contactDamageWeight: number;
}

// 受け手がこの接触で受けるダメージの根拠 [m/s]。0 を返す相手は無傷で済む。
export function contactDamageSpeed(other: ContactDamageSource, contact: Contact): number {
  return closingSpeed(contact) * other.contactDamageWeight;
}

// 接触速度に応じたダメージ割合 [0..1]。下限速度未満は 0、上限速度以上で 1、間は線形補間。
export function collisionDamageFraction(speed: number): number {
  const span = COLLISION_DAMAGE_FULL_CLOSING_SPEED - COLLISION_DAMAGE_MIN_CLOSING_SPEED;
  return Math.min(1, Math.max(0, (speed - COLLISION_DAMAGE_MIN_CLOSING_SPEED) / span));
}

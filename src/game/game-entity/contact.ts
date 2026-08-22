// 1回の接触を、受け手から見た形で記述する語彙。解決器(simulation/)が組み、受け手の
// collideWithEntity / collideWithCelestialBody と contactDamageSpeed が読む。
import { KinematicState } from '../../physics/kinematic-state';
import { Vec3, dot, sub } from '../../physics/vec3';

// self/other は受け手ごとに入れ替えて組み直す(normal も向きが反転する)ので、同じ解決結果から
// 自分用と相手用の2つを作る。
export interface Contact {
  readonly t: number; // 接触時刻 [sim s]
  readonly point: Vec3; // 接触点(ECI)
  readonly normal: Vec3; // self → other 向きの単位法線
  readonly selfState: KinematicState; // 接触直前(反応前)の自分
  readonly otherState: KinematicState; // 接触直前(反応前)の相手
  // 反発で自分が失う力学エネルギーを、自分の単位質量あたりで表した量 [J/kg]。質量 0 の
  // 個体でも有限。
  readonly specificEnergyLoss: number;
}

// 接触の瞬間に両者が近づいていた速さ [m/s]。離反していれば 0。normal は self → other 向きな
// ので、近づいている状態とは相対速度の法線成分が正であることを指す。
export function closingSpeed(contact: Contact): number {
  return Math.max(0, dot(sub(contact.selfState.v, contact.otherState.v), contact.normal));
}

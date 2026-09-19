import { createShipDefaultParts } from '../dynamic/dynamic-entity/ship-default-parts';
import type { Part } from '../dynamic/dynamic-entity/parts';
import { MUZZLE_SPEED } from '../dynamic/dynamic-entity/vessel';
import { THROTTLE_LEVELS } from './throttle';

// 自機の質量 [kg] と主慣性モーメント(相対値)。慣性は3軸を非対称にし、中間軸のピッチまわりに
// ジャニベコフ効果が起き、ロール軸(機体前後方向)は細長い形に見合って最小になるようにする。
export const PLAYER_MASS = 1000;
export const PLAYER_INERTIA_PITCH = 1.0;
export const PLAYER_INERTIA_YAW = 1.6;
export const PLAYER_INERTIA_ROLL = 0.5;
// RCS がヨー軸まわりに出す角加速度 [rad/s²]。
export const PLAYER_RCS_ANGULAR_ACCEL = 1.4;
// 推進器の推力 [N] とトルク(慣性と同じ相対値)。全開で推力段の最大の加速度を、RCS で上の角加速度を出す。
export const PLAYER_THRUST = PLAYER_MASS * Math.max(...THROTTLE_LEVELS);
export const PLAYER_TORQUE = PLAYER_RCS_ANGULAR_ACCEL * PLAYER_INERTIA_YAW;

// 総 HP maxHp を配分した、自機の既定の部品一式。
export function createPlayerParts(maxHp: number): Part[] {
  return createShipDefaultParts(maxHp, PLAYER_THRUST, PLAYER_TORQUE, MUZZLE_SPEED);
}

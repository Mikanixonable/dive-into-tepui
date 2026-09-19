import { createShipDefaultParts } from '../dynamic/dynamic-entity/ship-default-parts';
import type { Part } from '../dynamic/dynamic-entity/parts';
import { MUZZLE_SPEED } from '../dynamic/dynamic-entity/vessel';
import { THROTTLE_LEVELS } from './throttle';

// 自機の質量・慣性と初期部品はプレイヤー層のロードアウトとして所有する。
export const PLAYER_MASS = 1000;
export const PLAYER_INERTIA_PITCH = 1.0;
export const PLAYER_INERTIA_YAW = 1.6;
export const PLAYER_INERTIA_ROLL = 0.5;
// RCS がヨー軸まわりに出す角加速度 [rad/s²]。
export const PLAYER_RCS_ANGULAR_ACCEL = 1.4;
// 推進器の推力 [N] とトルク [N·m]。全開で推力段の最大の加速度を、RCS で上の角加速度を出す。
export const PLAYER_THRUST = PLAYER_MASS * Math.max(...THROTTLE_LEVELS);
export const PLAYER_TORQUE = PLAYER_RCS_ANGULAR_ACCEL * PLAYER_INERTIA_YAW;

// 総 HP maxHp を配分した、自機の既定の部品一式。
export function createPlayerParts(maxHp: number): Part[] {
  return createShipDefaultParts(maxHp, PLAYER_THRUST, PLAYER_TORQUE, MUZZLE_SPEED);
}

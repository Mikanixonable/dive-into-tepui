import { createShipDefaultParts } from '../dynamic/dynamic-entity/ship-default-parts';

// 自機の質量・慣性と初期部品はプレイヤー層のロードアウトとして所有する。
export const PLAYER_MASS = 1000;
export const PLAYER_INERTIA_PITCH = 1.0;
export const PLAYER_INERTIA_YAW = 1.6;
export const PLAYER_INERTIA_ROLL = 0.5;

export function createPlayerParts(maxHp: number) {
  return createShipDefaultParts(maxHp);
}

// 既定の設計が積む搭載要素の一覧。HP の配分比と、各部品の性能値をここで決める。
import * as C from '../const';
import { v3 } from '../../physics/vec3';
import type { AnyPart, BaseModulePart, DockPort, PartType } from '../game-entity/parts';
import { createPart } from '../game-entity/parts';

// 既定の基地モジュール。中腹のドッキングパレット上部に中央ハッチ、その四隅にスロットを持つ。
export function createDefaultBaseModule(maxHp: number): BaseModulePart {
  const up = v3(0, 1, 0);
  const slot = (x: number, z: number): DockPort => ({ localPos: v3(x, 21.0, z), localNormal: up });
  return createPart('base_module', {
    name: 'Base Module',
    maxHp,
    hp: maxHp,
    hatch: { localPos: v3(0, 21.0, 0), localNormal: up },
    dockSlots: [slot(-16.5, -16.5), slot(16.5, -16.5), slot(-16.5, 16.5), slot(16.5, 16.5)],
    capacity: C.BASE_MAX_VESSELS,
    hatchCaptureDist: 80,
    hatchCaptureAlignment: 0.5,
    slotCaptureDist: 50,
    slotCaptureAlignment: 0.5,
    captureRelSpeed: 20,
  });
}

// 既定パーツへの HP 配分比。合計 1 になるよう保つ(機体の maxHp をこの比で割り振る)。
// 放熱板・太陽電池パドルは機体の左右2枚ぶんなので、パーツも side ごとに1枚ずつ持つ。
const CREWED_HP_RATIO = {
  hull: 0.40, cockpit: 0.10, thruster: 0.08, rcsTank: 0.08,
  radiator: 0.05, solarPanel: 0.03, weapon: 0.08, armor: 0.10,
} as const;

// 無人の敵対機の HP 配分比。船体・主機・タンク・武装・装甲へ配る。合計 1 になるよう保つ。
const HOSTILE_HP_RATIO = {
  hull: 0.45, thruster: 0.12, rcsTank: 0.08, weapon: 0.15, armor: 0.20,
} as const;

// maxHp を CREWED_HP_RATIO で割り振った、有人機の既定の搭載要素一式。
export function crewedParts(maxHp: number): AnyPart[] {
  const R = CREWED_HP_RATIO;
  const share = (ratio: number): number => Math.max(1, Math.round(maxHp * ratio));
  const mk = <T extends PartType>(type: T, ratio: number, props: object): AnyPart =>
    createPart(type, { maxHp: share(ratio), hp: share(ratio), ...props } as never);
  return [
    mk('hull', R.hull, { name: 'Basic Hull' }),
    mk('cockpit', R.cockpit, { name: 'Cockpit' }),
    mk('thruster', R.thruster, {
      name: 'Standard RCS',
      torque: C.MAX_ANG_ACCEL * Math.max(C.PLAYER_INERTIA_PITCH, C.PLAYER_INERTIA_YAW, C.PLAYER_INERTIA_ROLL),
      // 既定パーツだけを積んだ機体が、全開で THROTTLE_LEVELS の最大値の加速度になる推力。
      thrust: C.PLAYER_MASS * C.THROTTLE_LEVELS[C.THROTTLE_LEVELS.length - 1]!,
      fuelConsumptionRate: 1,
    }),
    mk('rcs_tank', R.rcsTank, { name: 'Main RCS Tank', maxFuel: 1000, fuel: 1000 }),
    mk('radiator', R.radiator, { name: 'Heat Radiator L', coolingRate: 25 }),
    mk('radiator', R.radiator, { name: 'Heat Radiator R', coolingRate: 25 }),
    mk('solar_panel', R.solarPanel, { name: 'Solar Array L', powerGeneration: 50 }),
    mk('solar_panel', R.solarPanel, { name: 'Solar Array R', powerGeneration: 50 }),
    mk('weapon', R.weapon, {
      name: 'Gatling Gun', weaponType: 'gatling',
      fireRate: 1 / C.FIRE_INTERVAL, damage: C.ENEMY_BULLET_DAMAGE, muzzleVelocity: C.MUZZLE_SPEED,
    }),
    mk('armor', R.armor, { name: 'Light Armor', damageReduction: 0.2 }),
  ];
}

// maxHp を HOSTILE_HP_RATIO で割り振った、無人の敵対機の搭載要素一式。
export function hostileParts(maxHp: number): AnyPart[] {
  const R = HOSTILE_HP_RATIO;
  const share = (ratio: number): number => Math.max(1, Math.round(maxHp * ratio));
  const mk = <T extends PartType>(type: T, ratio: number, props: object): AnyPart =>
    createPart(type, { maxHp: share(ratio), hp: share(ratio), ...props } as never);
  return [
    mk('hull', R.hull, { name: 'Hostile Hull' }),
    mk('thruster', R.thruster, {
      name: 'Hostile Thruster',
      torque: C.MAX_ANG_ACCEL, thrust: 0, fuelConsumptionRate: 1,
    }),
    mk('rcs_tank', R.rcsTank, { name: 'Hostile Tank', maxFuel: 1000, fuel: 1000 }),
    mk('weapon', R.weapon, {
      name: 'Plasma Cannon', weaponType: 'cannon',
      fireRate: 1 / C.ENEMY_FIRE_INTERVAL, damage: C.PLAYER_BULLET_DAMAGE,
      muzzleVelocity: C.PLASMA_BULLET_SPEED,
    }),
    mk('armor', R.armor, { name: 'Hostile Armor', damageReduction: 0.2 }),
  ];
}

// 軌道基地の搭載要素一式。基地モジュールと管制室に加え、軌道保持用の小さな主機を積む。
export function baseParts(maxHp: number): AnyPart[] {
  const half = Math.round(maxHp * 0.5);
  return [
    createDefaultBaseModule(half),
    createPart('cockpit', { name: 'Control Room', maxHp: half, hp: half }),
    createPart('thruster', {
      name: 'Station Keeping Thruster', maxHp: 1, hp: 1,
      torque: C.BASE_TORQUE, thrust: C.BASE_THRUST, fuelConsumptionRate: C.BASE_FUEL_RATE,
    }),
    createPart('rcs_tank', {
      name: 'Station Tank', maxHp: 1, hp: 1, maxFuel: C.BASE_MAX_FUEL, fuel: C.BASE_MAX_FUEL,
    }),
  ];
}

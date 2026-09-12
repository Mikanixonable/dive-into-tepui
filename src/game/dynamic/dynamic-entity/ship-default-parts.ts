import { createPart, type Part } from './parts';

// 敵の金属船体にも使える汎用的な初期ロードアウト。自機固有の入力・状態は含めない。
const DEFAULT_PART_HP_RATIO = {
  hull: 0.40, cockpit: 0.10, thruster: 0.08, rcsTank: 0.08,
  radiator: 0.05, solarPanel: 0.03, weapon: 0.08, armor: 0.10,
} as const;
const SHIP_MASS = 1000;
const DEFAULT_TORQUE = 1.4 * 1.6;
const THRUST_LEVEL_MAX = 400;
const MUZZLE_SPEED = 1000;
const FIRE_INTERVAL = 0.06;

export function createShipDefaultParts(maxHp: number): Part[] {
  const share = (ratio: number): number => Math.max(1, Math.round(maxHp * ratio));
  const mk = <T extends Parameters<typeof createPart>[0]>(type: T, ratio: number, props: object) =>
    createPart(type, { maxHp: share(ratio), hp: share(ratio), ...props } as never);
  const R = DEFAULT_PART_HP_RATIO;
  return [
    mk('hull', R.hull, { name: 'Basic Hull' }),
    mk('cockpit', R.cockpit, { name: 'Cockpit' }),
    mk('thruster', R.thruster, {
      name: 'Standard RCS', torque: DEFAULT_TORQUE,
      thrust: SHIP_MASS * THRUST_LEVEL_MAX, fuelConsumptionRate: 1,
    }),
    mk('rcs_tank', R.rcsTank, { name: 'Main RCS Tank', maxFuel: 1000, fuel: 1000 }),
    mk('radiator', R.radiator, { name: 'Heat Radiator L', coolingRate: 42 }),
    mk('radiator', R.radiator, { name: 'Heat Radiator R', coolingRate: 42 }),
    mk('solar_panel', R.solarPanel, { name: 'Solar Array L', powerGeneration: 50 }),
    mk('solar_panel', R.solarPanel, { name: 'Solar Array R', powerGeneration: 50 }),
    mk('weapon', R.weapon, {
      name: 'Gatling Gun', weaponType: 'gatling', fireRate: 1 / FIRE_INTERVAL,
      damage: 1, muzzleVelocity: MUZZLE_SPEED,
    }),
    mk('armor', R.armor, { name: 'Light Armor', damageReduction: 0.2 }),
  ];
}

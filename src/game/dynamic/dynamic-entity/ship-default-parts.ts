import { createPart, type Part } from './parts';

// 艦の既定の部品一式。推進器と機関砲の性能は、積む側が渡す。

// 既定パーツへの HP 配分比。放熱板・太陽電池パドルを左右2枚ぶん数えて合計 1 になり、パーツ HP の
// 合計が maxHp と一致する。
const DEFAULT_PART_HP_RATIO = {
  hull: 0.40, cockpit: 0.10, thruster: 0.08, rcsTank: 0.08,
  radiator: 0.05, solarPanel: 0.03, weapon: 0.08, armor: 0.10,
} as const;
// 機関砲の射撃間隔 [s]。
const FIRE_INTERVAL = 0.06;

// 総 HP maxHp を配分した既定の部品一式。推進器は推力 thrust [N]・トルク torque [N·m]、機関砲は
// 初速 muzzleVelocity [m/s] を持つ。
export function createShipDefaultParts(
  maxHp: number, thrust: number, torque: number, muzzleVelocity: number,
): Part[] {
  // 各部品は総 HP の配分比ぶんを満タンで持つ
  const share = (ratio: number): number => maxHp * ratio;
  const mk = <T extends Parameters<typeof createPart>[0]>(type: T, ratio: number, props: object) =>
    createPart(type, { maxHp: share(ratio), hp: share(ratio), ...props } as never);
  const R = DEFAULT_PART_HP_RATIO;
  return [
    mk('hull', R.hull, { name: 'Basic Hull' }),
    mk('cockpit', R.cockpit, { name: 'Cockpit' }),
    mk('thruster', R.thruster, {
      name: 'Standard RCS', torque, thrust, fuelConsumptionRate: 1,
    }),
    mk('rcs_tank', R.rcsTank, { name: 'Main RCS Tank', maxFuel: 1000, fuel: 1000 }),
    mk('radiator', R.radiator, { name: 'Heat Radiator L', coolingRate: 42 }),
    mk('radiator', R.radiator, { name: 'Heat Radiator R', coolingRate: 42 }),
    mk('solar_panel', R.solarPanel, { name: 'Solar Array L', powerGeneration: 50 }),
    mk('solar_panel', R.solarPanel, { name: 'Solar Array R', powerGeneration: 50 }),
    mk('weapon', R.weapon, {
      name: 'Gatling Gun', weaponType: 'gatling', fireRate: 1 / FIRE_INTERVAL,
      damage: 1, muzzleVelocity,
    }),
    mk('armor', R.armor, { name: 'Light Armor', damageReduction: 0.2 }),
  ];
}

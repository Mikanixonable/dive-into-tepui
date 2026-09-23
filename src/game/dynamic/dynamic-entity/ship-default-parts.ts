import { createPart, type Part } from './parts';
import { SHIP_MODULE_CATALOG } from '../../ship/ship-module-catalog';

// 艦の既定の部品一式。推進器と機関砲の性能は、積む側が渡す。

// 既定パーツへの HP 配分比。放熱板・太陽電池パドルを左右2枚ぶん数えると比率は合計 1。
// 各パーツは整数かつ最低 1 HP へ丸めるため、小さい maxHp では生成後のパーツ HP 合計が maxHp を
// 上回りうる。機体の実際の最大 HP は、生成されたパーツの maxHp 合計を正本とする。
const DEFAULT_PART_HP_RATIO = {
  hull: 0.40, cockpit: 0.10, thruster: 0.08, rcsTank: 0.08,
  radiator: 0.05, solarPanel: 0.03, weapon: 0.08, armor: 0.10,
} as const;
const SHIP_MASS = 1000;
const THRUST_LEVEL_MAX = 400;

export function createShipDefaultParts(maxHp: number): Part[] {
  const rcs = SHIP_MODULE_CATALOG.require('rcs-standard').abilities;
  const tank = SHIP_MODULE_CATALOG.require('tank-combat-main').abilities;
  const radiator = SHIP_MODULE_CATALOG.require('radiator-standard').abilities;
  const solar = SHIP_MODULE_CATALOG.require('solar-panel-standard').abilities;
  const weapon = SHIP_MODULE_CATALOG.require('weapon-gatling').abilities;
  const armor = SHIP_MODULE_CATALOG.require('armor-standard').abilities;
  const share = (ratio: number): number => Math.max(1, Math.round(maxHp * ratio));
  const mk = <T extends Parameters<typeof createPart>[0]>(type: T, ratio: number, props: object) =>
    createPart(type, { maxHp: share(ratio), hp: share(ratio), ...props } as never);
  const R = DEFAULT_PART_HP_RATIO;
  return [
    mk('hull', R.hull, { name: 'Basic Hull' }),
    mk('cockpit', R.cockpit, { name: 'Cockpit' }),
    mk('thruster', R.thruster, {
      name: 'Standard RCS', torque: rcs.torque ?? 0,
      thrust: SHIP_MASS * THRUST_LEVEL_MAX, fuelConsumptionRate: 1,
    }),
    mk('rcs_tank', R.rcsTank, {
      name: 'Main RCS Tank', maxFuel: tank.fuelCapacity ?? 0, fuel: tank.fuelCapacity ?? 0,
    }),
    mk('radiator', R.radiator, { name: 'Heat Radiator L', coolingRate: radiator.radiationArea ?? 0 }),
    mk('radiator', R.radiator, { name: 'Heat Radiator R', coolingRate: radiator.radiationArea ?? 0 }),
    mk('solar_panel', R.solarPanel, { name: 'Solar Array L', powerGeneration: solar.powerGeneration ?? 0 }),
    mk('solar_panel', R.solarPanel, { name: 'Solar Array R', powerGeneration: solar.powerGeneration ?? 0 }),
    mk('weapon', R.weapon, {
      name: 'Gatling Gun', weaponType: 'gatling', fireRate: weapon.fireRate ?? 0,
      damage: weapon.weaponDamage ?? 0, muzzleVelocity: weapon.muzzleVelocity ?? 0,
    }),
    mk('armor', R.armor, { name: 'Light Armor', damageReduction: armor.armorReduction ?? 0 }),
  ];
}

import type { ShipModuleCatalog } from './ship-module-catalog';
import type { ShipAssemblyNode, ShipAssemblyTotals } from './ship-assembly-types';

export function shipAssemblyTotals(
  nodes: ReadonlyMap<string, ShipAssemblyNode>, catalog: ShipModuleCatalog,
): ShipAssemblyTotals {
  let hp = 0, maxHp = 0, thrust = 0, torque = 0, mainFuelConsumptionRate = 0;
  let mainFuel = 0, rcsFuel = 0, boosterFuel = 0;
  let maxMainFuel = 0, maxRcsFuel = 0, maxBoosterFuel = 0, maxMainFuelMass = 0;
  let power = 0, radiation = 0, fireRate = 0;
  let weaponDamage = 0, muzzleVelocityTotal = 0, weaponCount = 0, dryMass = 0, mass = 0, fullMass = 0;
  for (const node of nodes.values()) {
    const definition = catalog.require(node.instance.definitionId);
    const abilities = definition.abilities;
    const fuelMassPerUnit = abilities.fuelMassPerUnit ?? 1;
    dryMass += definition.dryMass;
    mass += definition.dryMass;
    fullMass += definition.dryMass;
    if (node.instance.kind === 'tank' || node.instance.kind === 'booster') {
      mass += node.instance.fuel * fuelMassPerUnit;
      fullMass += (abilities.fuelCapacity ?? 0) * fuelMassPerUnit;
    }
    hp += node.instance.hp;
    maxHp += definition.maxHp;
    if (node.instance.hp <= 0) continue;
    if (node.instance.kind !== 'booster') thrust += abilities.thrust ?? 0;
    torque += abilities.torque ?? 0;
    power += abilities.powerGeneration ?? 0;
    radiation += abilities.radiationArea ?? 0;
    const capacity = abilities.fuelCapacity ?? 0;
    if (node.instance.kind === 'tank') {
      if (node.instance.fuelKind === 'main') {
        mainFuel += node.instance.fuel;
        maxMainFuel += capacity;
        maxMainFuelMass += capacity * fuelMassPerUnit;
      } else { rcsFuel += node.instance.fuel; maxRcsFuel += capacity; }
    } else if (node.instance.kind === 'booster') {
      if (node.instance.ignited) thrust += abilities.thrust ?? 0;
      boosterFuel += node.instance.fuel;
      maxBoosterFuel += capacity;
    }
    if (node.instance.kind === 'thruster') {
      mainFuelConsumptionRate += abilities.fuelConsumptionRate ?? 0;
    }
    if (node.instance.kind === 'weapon') {
      weaponDamage = Math.max(weaponDamage, abilities.weaponDamage ?? 0);
      fireRate += abilities.fireRate ?? 0;
      if (abilities.muzzleVelocity !== undefined) {
        muzzleVelocityTotal += abilities.muzzleVelocity;
        weaponCount++;
      }
    }
  }
  return {
    hp, maxHp, thrust, torque, mainFuelConsumptionRate, mainFuel, rcsFuel, boosterFuel,
    maxMainFuel, maxRcsFuel, maxBoosterFuel,
    maxMainFuelMass, mainFuelMassPerUnit: maxMainFuel > 0 ? maxMainFuelMass / maxMainFuel : 1,
    power, radiation,
    weaponDamage, fireRate, muzzleVelocity: weaponCount === 0 ? 0 : muzzleVelocityTotal / weaponCount,
    dryMass, mass, fullMass,
  };
}

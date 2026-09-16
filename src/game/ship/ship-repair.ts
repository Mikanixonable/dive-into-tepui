import type { ShipAssembly } from './ship-assembly';

/** 健全かつ接続済みの dock/port から、統合船体の全 module HP を即時回復する。 */
export function repairDockedAssembly(assembly: ShipAssembly, dockId: string): number {
  const dock = assembly.module(dockId);
  if (dock === null || (dock.kind !== 'dock' && dock.kind !== 'docking_port')) {
    throw new Error(`not a docking module: ${dockId}`);
  }
  if (dock.hp <= 0) throw new Error(`docking module is destroyed: ${dockId}`);
  if (!assembly.isDockingPortOccupied(dockId)) throw new Error(`docking module is not connected: ${dockId}`);
  let repaired = 0;
  for (const module of assembly.modules) {
    const maxHp = assembly.definition(module.id)!.maxHp;
    repaired += Math.max(0, maxHp - module.hp);
    assembly.setHp(module.id, maxHp);
  }
  return repaired;
}

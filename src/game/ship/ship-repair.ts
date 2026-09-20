// 接舷済み船体を、指定接舷部から一括修理する。
import type { ShipAssembly } from './ship-assembly';

/** 健全かつ接続済みの dock から、統合船体の全 module HP を即時回復する。 */
export function repairDockedAssembly(assembly: ShipAssembly, dockId: string): number {
  const dock = assembly.module(dockId);
  if (dock?.kind !== 'dock') {
    throw new Error(`not a docking module: ${dockId}`);
  }
  if (dock.hp <= 0) throw new Error(`docking module is destroyed: ${dockId}`);
  if (!assembly.isDockingPortOccupied(dockId)) throw new Error(`docking module is not connected: ${dockId}`);
  let repaired = 0;
  for (const module of assembly.modules) {
    const definition = assembly.definition(module.id);
    if (definition === null) throw new Error(`missing ship module definition: ${module.id}`);
    const maxHp = definition.maxHp;
    repaired += Math.max(0, maxHp - module.hp);
    assembly.setHp(module.id, maxHp);
  }
  return repaired;
}

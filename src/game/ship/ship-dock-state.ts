import type { ShipAssembly } from './ship-assembly';

export type ShipDockStatus = 'empty' | 'building' | 'connected';

// 建造予約だけを明示状態として持ち、接舷状態は assembly の docking edge から導出する。
export class ShipDockState {
  private readonly building = new Set<string>();

  public status(assembly: ShipAssembly, moduleId: string): ShipDockStatus {
    if (assembly.isDockingPortOccupied(moduleId)) return 'connected';
    return this.building.has(moduleId) ? 'building' : 'empty';
  }

  public beginBuilding(assembly: ShipAssembly, moduleId: string): void {
    const module = assembly.module(moduleId);
    if (module === null || (module.kind !== 'dock' && module.kind !== 'docking_port')) {
      throw new Error(`not a docking module: ${moduleId}`);
    }
    if (module.hp <= 0) throw new Error(`docking module is destroyed: ${moduleId}`);
    if (this.status(assembly, moduleId) !== 'empty') throw new Error(`docking module is not empty: ${moduleId}`);
    this.building.add(moduleId);
  }

  public finishBuilding(moduleId: string): void { this.building.delete(moduleId); }
}

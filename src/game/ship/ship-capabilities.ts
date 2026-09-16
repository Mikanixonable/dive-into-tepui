import type { ShipAssembly, ShipRole } from './ship-assembly';
import type { FuelKind, ShipModuleKind } from './ship-module-definition';
import type { CockpitInstance, ShipModuleInstance } from './ship-module-instance';

// 操作・HUD・AI が ShipAssembly の構造を直接解釈しないための能力面。
// role や性能値は保持せず、その都度 module state から導出する。
export class ShipCapabilities {
  private operatingCockpitIdValue: string | null;

  public constructor(
    public readonly assembly: ShipAssembly,
    operatingCockpitId: string | null = null,
  ) {
    this.operatingCockpitIdValue = operatingCockpitId;
    this.reconcileOperatingCockpit();
  }

  public get role(): ShipRole { return this.assembly.role; }
  public get controllable(): boolean { return this.operatingCockpit !== null; }

  public get operatingCockpitId(): string | null {
    this.reconcileOperatingCockpit();
    return this.operatingCockpitIdValue;
  }

  public get operatingCockpit(): CockpitInstance | null {
    const id = this.operatingCockpitId;
    if (id === null) return null;
    const module = this.assembly.module(id);
    return module?.kind === 'cockpit' ? module : null;
  }

  public selectOperatingCockpit(id: string): boolean {
    const module = this.assembly.module(id);
    if (module?.kind !== 'cockpit' || module.hp <= 0) return false;
    this.operatingCockpitIdValue = id;
    return true;
  }

  // 選択中 cockpit が除去・全損したら、接続順で最初の健全 cockpit へだけ自動退避する。
  public reconcileOperatingCockpit(): string | null {
    const selected = this.operatingCockpitIdValue === null
      ? null : this.assembly.module(this.operatingCockpitIdValue);
    if (selected?.kind === 'cockpit' && selected.hp > 0) return selected.id;
    const fallback = this.modules('cockpit', true)[0];
    this.operatingCockpitIdValue = fallback?.id ?? null;
    return this.operatingCockpitIdValue;
  }

  public modules<K extends ShipModuleKind>(kind: K, healthyOnly = false): readonly Extract<ShipModuleInstance, { kind: K }>[] {
    return this.assembly.modules.filter(
      (module): module is Extract<ShipModuleInstance, { kind: K }> => (
        module.kind === kind && (!healthyOnly || module.hp > 0)
      ),
    );
  }

  public has(kind: ShipModuleKind, healthyOnly = true): boolean {
    return this.assembly.modules.some(module => module.kind === kind && (!healthyOnly || module.hp > 0));
  }

  public get totals() { return this.assembly.totals(); }
  public get totalThrust(): number { return this.totals.thrust; }
  public get totalTorque(): number { return this.totals.torque; }
  public get weaponDamage(): number { return this.totals.weaponDamage; }
  public get totalFireRate(): number { return this.totals.fireRate; }
  public get averageMuzzleVelocity(): number { return this.totals.muzzleVelocity; }
  public get totalCoolingRate(): number { return this.totals.radiation; }
  public get totalPowerGeneration(): number { return this.totals.power; }

  public fuel(kind: FuelKind): number {
    return kind === 'main' ? this.totals.mainFuel : this.totals.rcsFuel;
  }

  public maxFuel(kind: FuelKind): number {
    return kind === 'main' ? this.totals.maxMainFuel : this.totals.maxRcsFuel;
  }

  public consumeFuel(kind: FuelKind, amount: number): number {
    return this.assembly.consumeFuel(kind, amount);
  }

  public refuel(kind: FuelKind, amount: number): number {
    return this.assembly.refuel(kind, amount);
  }

  public toggleDeployable(kind: 'radiator' | 'solar_panel', index: number): boolean {
    const module = this.modules(kind, true)[index];
    if (module === undefined) return false;
    this.assembly.setDeployment(module.id, module.deployed >= 0.5 ? 0 : 1);
    return true;
  }
}

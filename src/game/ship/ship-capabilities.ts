// 船体構成から役割・操作可否・装備能力・資源量を導出する。
import { qRotate, type Quat } from '../../math/quat';
import { add, type Vec3 } from '../../math/vec3';
import type { ShipAssembly, ShipAssemblyTotals, ShipRole } from './ship-assembly';
import type { FuelKind, ShipModuleKind } from './ship-module-definition';
import type { CockpitInstance, ShipModuleInstance } from './ship-module-instance';

// 健全な武装モジュール1基ぶんの機能点(いずれも assembly 座標 [m])と姿勢。
export interface WeaponPorts {
  readonly moduleId: string;
  readonly muzzles: readonly Vec3[];
  readonly ejectionPort: Vec3;
  readonly linkExitPort: Vec3;
  // assembly 内でのモジュール姿勢。排莢・リンク排出の向きを機体座標へ写すのに使う。
  readonly rotation: Quat;
}

// 1つの砲口と、それを持つモジュールの排出点一式。
export interface WeaponMuzzle {
  readonly position: Vec3;
  readonly muzzleIndex: number;
  readonly weapon: WeaponPorts;
}

// 操作・HUD・AI に、現在の module state から導出した能力面を提供する。
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

  // 健全な武装モジュールの機能点を、assembly 座標 [m] でモジュールの並び順に返す。
  // 排出物は撃ったモジュール自身の口から出るので、砲口と排出点は同じ WeaponPorts から取る。
  public weaponPorts(): readonly WeaponPorts[] {
    const result: WeaponPorts[] = [];
    for (const weapon of this.modules('weapon', true)) {
      const definition = this.assembly.definition(weapon.id);
      const transform = this.assembly.worldTransformOf(weapon.id);
      if (definition === null || transform === null) continue;
      // 砲口と排出口は assembly 座標へ移し、排出方向に使う姿勢も同じ単位で残す。
      const at = (point: Vec3): Vec3 => add(transform.position, qRotate(transform.rotation, point));
      result.push({
        moduleId: weapon.id,
        muzzles: definition.muzzles.map(at),
        ejectionPort: at(definition.ejectionPort),
        linkExitPort: at(definition.linkExitPort),
        rotation: transform.rotation,
      });
    }
    return result;
  }

  // 全武装モジュールの砲口を、排出元のモジュール情報つきで列挙する。
  public weaponMuzzles(): readonly WeaponMuzzle[] {
    return this.weaponPorts().flatMap(
      weapon => weapon.muzzles.map((position, muzzleIndex) => ({ position, muzzleIndex, weapon })),
    );
  }

  public has(kind: ShipModuleKind, healthyOnly = true): boolean {
    return this.assembly.modules.some(module => module.kind === kind && (!healthyOnly || module.hp > 0));
  }

  public get totals(): ShipAssemblyTotals { return this.assembly.totals(); }
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

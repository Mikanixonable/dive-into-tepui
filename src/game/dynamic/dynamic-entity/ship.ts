import type { DynamicMotionFactory } from './dynamic-entity';
import type { DynamicView } from '../../../render/dynamic/dynamic-view';
import { Part } from './parts';
import type { RadiatorPart, SolarPanelPart } from './parts';
import { PartDamageModel } from './part-damage-model';
import { Vessel } from './vessel';

// 既存の利用者には部品式機体のモジュールから提供し続ける。
export {
  MAX_HULL_TEMP, MUZZLE_SPEED, SHIP_BCINV, SHIP_RADIATING_AREA_PER_MASS, SHIP_SRP_COEFF,
  shipMotionOptions,
} from './vessel';

// パーツ式の被弾モデルを持つ艦(自機・金属敵)。寿命・一般HP・マーカーは Vessel が持ち、
// ここでは部品構成と、部品から導かれる性能だけを扱う。
export abstract class Ship extends Vessel {
  private readonly partModel = new PartDamageModel();
  protected get parts(): readonly Part[] { return this.partModel.parts; }

  public constructor(
    name: string,
    hp: number,
    motionFactory: DynamicMotionFactory,
    view: DynamicView,
    id: string,
    initialParts?: readonly Part[],
  ) {
    super(name, hp, motionFactory, view, id);
    if (initialParts && initialParts.length > 0) this.replaceParts(initialParts);
  }

  public replaceParts(parts: readonly Part[]): void {
    this.partModel.replaceParts(parts);
    this.maxHp = this.partModel.maxHp;
    this.hp = this.partModel.overallHp();
  }

  public hasPart(part: Part): boolean { return this.partModel.hasPart(part); }

  protected setOverallHp(total: number): void {
    this.hp = this.partModel.setOverallHp(total);
  }

  protected applyCollisionDamage(closingSpeed: number, part?: Part): boolean {
    const result = this.partModel.applyCollisionDamage(closingSpeed, this.maxHp, part);
    this.hp = result.hp;
    return result.damaged;
  }

  protected applyDamageToParts(amount: number, part?: Part): void {
    this.hp = this.partModel.applyDamageToParts(amount, part);
  }

  protected selfRepair(amount: number): void {
    this.hp = this.partModel.selfRepair(amount);
  }

  public get totalTorque(): number { return this.partModel.totalTorque; }
  public get totalThrust(): number { return this.partModel.totalThrust; }
  public get totalFuelConsumptionRate(): number { return this.partModel.totalFuelConsumptionRate; }
  public get totalFuel(): number { return this.partModel.totalFuel; }
  public get totalMaxFuel(): number { return this.partModel.totalMaxFuel; }
  public consumeFuel(amount: number): number { return this.partModel.consumeFuel(amount); }
  public refuelFuel(amount: number): number { return this.partModel.refuelFuel(amount); }

  public get radiatorParts(): readonly (RadiatorPart | undefined)[] { return this.partModel.radiatorParts; }
  public get solarParts(): readonly (SolarPanelPart | undefined)[] { return this.partModel.solarParts; }
  public get totalCoolingRate(): number { return this.partModel.totalCoolingRate; }
  public get totalPowerGeneration(): number { return this.partModel.totalPowerGeneration; }
  public get weaponDamage(): number { return this.partModel.weaponDamage; }
  public get totalFireRate(): number { return this.partModel.totalFireRate; }
  public get averageMuzzleVelocity(): number { return this.partModel.averageMuzzleVelocity; }
}

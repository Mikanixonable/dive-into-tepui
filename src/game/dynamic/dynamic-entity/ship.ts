import type { DynamicMotionFactory } from './dynamic-entity';
import type { DynamicView } from '../../../render/dynamic/dynamic-view';
import type { Part, RadiatorPart, SerializedPart, SolarPanelPart } from './parts';
import { PartDamageModel } from './part-damage-model';
import { Vessel } from './vessel';

// 部品式の被弾モデルを持つ艦。部品構成と、部品から導かれる性能を扱う。
export abstract class Ship extends Vessel {
  private readonly partModel: PartDamageModel;
  protected get parts(): readonly Part[] { return this.partModel.parts; }

  // initialParts を渡すと、その構成の合計 HP が hp を上書きする。省略すると部品を持たず、
  // 装甲値は hp のまま動かない。
  public constructor(
    name: string,
    hp: number,
    motionFactory: DynamicMotionFactory,
    view: DynamicView,
    id: string,
    initialParts: readonly Part[] = [],
  ) {
    super(name, hp, motionFactory, view, id);
    this.partModel = new PartDamageModel(initialParts);
    if (initialParts.length === 0) return;
    this.setHealth(this.partModel.overallHp(), this.partModel.maxHp);
  }

  public hasPart(part: Part): boolean { return this.partModel.hasPart(part); }

  // 部品の一覧の直列化。
  protected serializeParts(): SerializedPart[] { return this.partModel.serialize(); }

  // 接近速度に応じたダメージを入れ、ダメージが出たかを返す。part を指定すると
  // その部品へ固定し、省略すると健全な部品へ無作為に割り振る。
  protected applyCollisionDamage(closingSpeed: number, part?: Part): boolean {
    const damaged = this.partModel.applyCollisionDamage(closingSpeed, this.maxHp, part);
    this.setHealth(this.partModel.overallHp());
    return damaged;
  }

  // 装甲の軽減を通したダメージを部品へ入れる。part の扱いは applyCollisionDamage と同じ。
  protected applyDamageToParts(amount: number, part?: Part): void {
    this.partModel.applyDamageToParts(amount, part);
    this.setHealth(this.partModel.overallHp());
  }

  // 損傷した部品へ amount を均等に配って回復させる。機上で直せない部品は対象から外れる。
  protected selfRepair(amount: number): void {
    this.partModel.selfRepair(amount);
    this.setHealth(this.partModel.overallHp());
  }

  public get totalTorque(): number { return this.partModel.totalTorque; }
  public get totalThrust(): number { return this.partModel.totalThrust; }
  public get totalFuelConsumptionRate(): number { return this.partModel.totalFuelConsumptionRate; }
  public get totalFuel(): number { return this.partModel.totalFuel; }
  public get totalMaxFuel(): number { return this.partModel.totalMaxFuel; }
  public consumeFuel(amount: number): void { this.partModel.consumeFuel(amount); }
  public refuelFuel(amount: number): void { this.partModel.refuelFuel(amount); }

  public get radiatorParts(): readonly (RadiatorPart | undefined)[] { return this.partModel.radiatorParts; }
  public get solarParts(): readonly (SolarPanelPart | undefined)[] { return this.partModel.solarParts; }
  public get totalCoolingRate(): number { return this.partModel.totalCoolingRate; }
  public get totalPowerGeneration(): number { return this.partModel.totalPowerGeneration; }
  public get weaponDamage(): number { return this.partModel.weaponDamage; }
  public get totalFireRate(): number { return this.partModel.totalFireRate; }
  public get averageMuzzleVelocity(): number { return this.partModel.averageMuzzleVelocity; }
}

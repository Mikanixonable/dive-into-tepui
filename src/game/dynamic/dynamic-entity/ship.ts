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

  // initialParts を渡すと、その構成の合計 HP が hp を上書きする。省略すると部品を持たず、
  // 装甲値は hp のまま動かない。
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

  // 部品構成を入れ替え、装甲値と残 HP を新しい構成から取り直す。換装の唯一の入口。
  public replaceParts(parts: readonly Part[]): void {
    this.partModel.replaceParts(parts);
    this.maxHp = this.partModel.maxHp;
    this.hp = this.partModel.overallHp();
  }

  public hasPart(part: Part): boolean { return this.partModel.hasPart(part); }

  // 接近速度に応じたダメージを入れ、ダメージが出たかを返す。part を指定すると
  // その部品へ固定し、省略すると健全な部品へ無作為に割り振る。
  protected applyCollisionDamage(closingSpeed: number, part?: Part): boolean {
    const result = this.partModel.applyCollisionDamage(closingSpeed, this.maxHp, part);
    this.hp = result.hp;
    return result.damaged;
  }

  // 装甲の軽減を通したダメージを部品へ入れる。part の扱いは applyCollisionDamage と同じ。
  protected applyDamageToParts(amount: number, part?: Part): void {
    this.hp = this.partModel.applyDamageToParts(amount, part);
  }

  // 損傷した部品へ amount を均等に配って回復させる。機上で直せない部品は対象から外れる。
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

import type { Vec3 } from '../../../math/vec3';
import type { DynamicView } from '../../../render/dynamic/dynamic-view';
import type { Part, AnyPart } from './parts';
import { PartDamageModel } from './part-damage-model';
import { Enemy, type EnemyPlacement } from './enemy';
import type { PartDamageTarget } from './damage-capabilities';
import { EnemyFireState } from './enemy-fire-controller';

// 部品式の被弾モデルを持つ敵に共通するもの。
export abstract class PartBasedEnemy extends Enemy implements PartDamageTarget {
  private readonly partModel: PartDamageModel;

  // parts の合計が、この敵の装甲値と残 HP の正本になる。
  protected constructor(
    placement: EnemyPlacement,
    view: DynamicView,
    inertia: Vec3,
    radius: number,
    id: string,
    parts: readonly Part[],
    alive?: boolean,
    fireState = new EnemyFireState(),
  ) {
    super(placement, view, inertia, radius, id, null, alive, fireState);
    this.partModel = new PartDamageModel(parts);
    this.setHealth(this.partModel.overallHp(), this.partModel.maxHp);
  }

  public get parts(): readonly Part[] { return this.partModel.parts; }

  // 部品の一覧の直列化。
  protected serializeParts(): AnyPart[] { return this.partModel.serialize(); }

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
}

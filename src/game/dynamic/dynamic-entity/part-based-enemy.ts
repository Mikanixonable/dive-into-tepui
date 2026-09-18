import type { Vec3 } from '../../../math/vec3';
import type { DynamicView } from '../../../render/dynamic/dynamic-view';
import type { Part } from './parts';
import { PartDamageModel } from './part-damage-model';
import { Enemy, type EnemyPlacement } from './enemy';
import type { EntityIdAllocators } from './entity-id';
import type { PartDamageTarget } from './damage-capabilities';

// 敵AIと部品式の被弾モデルを組み合わせるための薄い接続層。
// 共通の敵寿命は Enemy、部品の実体と性能は PartDamageModel が所有する。
export abstract class PartBasedEnemy extends Enemy implements PartDamageTarget {
  private readonly partModel: PartDamageModel;

  // parts の合計が、この敵の装甲値と残 HP の正本になる。
  protected constructor(
    placement: EnemyPlacement,
    view: DynamicView,
    inertia: Vec3,
    radius: number,
    idAllocators: EntityIdAllocators,
    parts: readonly Part[],
    alive?: boolean,
    burstLeft?: number | null,
    burstDelay?: number | null,
    lastFireSim?: number | null,
    lastBehaviorSim?: number | null,
  ) {
    super(
      placement, view, inertia, radius, idAllocators, null, alive,
      burstLeft, burstDelay, lastFireSim, lastBehaviorSim,
    );
    this.partModel = new PartDamageModel(parts);
    this.maxHp = this.partModel.maxHp;
    this.hp = this.partModel.overallHp();
  }

  public get parts(): readonly Part[] { return this.partModel.parts; }

  // 接近速度に応じたダメージを入れ、ダメージが出たかを返す。part を指定すると
  // その部品へ固定し、省略すると健全な部品へ無作為に割り振る。
  protected applyCollisionDamage(closingSpeed: number, part?: Part): boolean {
    const damaged = this.partModel.applyCollisionDamage(closingSpeed, this.maxHp, part);
    this.hp = this.partModel.overallHp();
    return damaged;
  }

  // 装甲の軽減を通したダメージを部品へ入れる。part の扱いは applyCollisionDamage と同じ。
  protected applyDamageToParts(amount: number, part?: Part): void {
    this.partModel.applyDamageToParts(amount, part);
    this.hp = this.partModel.overallHp();
  }
}

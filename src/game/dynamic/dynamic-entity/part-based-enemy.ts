import type { FlashEffects } from '../../vfx/flash-effects';
import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import type { Vec3 } from '../../../math/vec3';
import type { DynamicView } from '../../../render/dynamic/dynamic-view';
import type { Part } from './parts';
import { PartDamageModel } from './part-damage-model';
import { Enemy, type EnemyPlacement, type EnemyRestore } from './enemy';
import type { EnemyCollisionShape } from './enemy-motion';
import type { PartDamageTarget } from './damage-capabilities';

// 敵AIと部品式の被弾モデルを組み合わせるための薄い接続層。
// 共通の敵寿命は Enemy、部品の実体と性能は PartDamageModel が所有する。
export abstract class PartBasedEnemy extends Enemy implements PartDamageTarget {
  private readonly partModel = new PartDamageModel();

  public constructor(
    init: EnemyPlacement | EnemyRestore,
    view: DynamicView,
    inertia: Vec3,
    radius: number,
    worldSfx: WorldSfx,
    fx: FlashEffects,
    initialParts: readonly Part[],
    shape?: EnemyCollisionShape,
  ) {
    super(init, view, inertia, radius, worldSfx, fx, shape);
    this.partModel.replaceParts(initialParts);
    this.maxHp = this.partModel.maxHp;
    this.hp = this.partModel.overallHp();
  }

  public get parts(): readonly Part[] { return this.partModel.parts; }

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
}

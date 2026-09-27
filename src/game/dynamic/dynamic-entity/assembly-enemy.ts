import type * as THREE from 'three/webgpu';
import { add, sub, type Vec3 } from '../../../math/vec3';
import { qInvert, qRotate } from '../../../math/quat';
import {
  deserializeKinematicState, kinematicState, type KinematicState, type SerializedKinematicState,
} from '../../../physics/kinematic-state';
import { collisionDamageFraction } from './contact-damage';
import { generateAssemblyShape, type AssemblyShape } from '../../../render/assembly/assembly-shape';
import { AssemblyCollision } from '../../assembly/assembly-collision';
import {
  AssemblyCombatState, type SerializedAssemblyCombatState,
} from '../../assembly/assembly-combat-state';
import {
  Enemy, PLASMA_BULLET_DAMAGE, deserializeEnemyPlacement, driftingAttitude,
  type EnemyPlacement, type SerializedEnemy,
} from './enemy';
import type { EntityRegistry, SpawnGate } from '../entity-registry';
import type { RunEventSink } from '../../run-events';
import type { EntityIdAllocators } from './entity-id';
import type { FormationRole } from './entity-kind';
import { AssemblyEnemyView, type AssemblyVisualSource } from '../../../render/dynamic/dynamic-entity/assembly-enemy-view';
import type { DynamicEntity } from './dynamic-entity';
import type { EnemyCollisionShape } from './enemy-motion';
import type { DynamicViewFrame } from '../../../render/dynamic/dynamic-view';
import type { OrbitReference } from '../../orbit-reference';

// 新しく置く組み立て型の敵の要求。seed が個体の形状を決める。陣形に属さない個体は
// formationId と役割が null。
export interface AssemblyEnemyRequest {
  readonly name: string;
  readonly state: SerializedKinematicState;
  readonly seed: number;
  readonly accent: string | number;
  readonly orbitLineColor: string | number;
  readonly formationId: string | null;
  readonly formationRole: FormationRole | null;
}

export interface SerializedAssemblyEnemy extends SerializedEnemy {
  readonly kind: 'assembly-enemy';
  // 個体の形状を決める種。形状そのものは記録せず、seed から同じ形を組み直す。
  readonly seed: number;
  // 部品の HP と integrity の記録。
  readonly assembly: SerializedAssemblyCombatState;
}

// 組み立て型の敵(SPEC/ASSEMBLY.md)。seed から組み立てた部品の組み合わせを形とし、
// 部品ごとに破壊できる被弾モデル(AssemblyCombatState)が HP の正本。判定形状は部品の
// 中心線を覆う球列で、失われた部品は判定から外れる。
export class AssemblyEnemy extends Enemy {
  public static readonly kind = 'assembly-enemy';
  public declare readonly view: AssemblyEnemyView;
  // 外部資産を待つ必要がないので、ゲートは常に null。
  public static spawnGate(): SpawnGate | null { return null; }

  private readonly seed: number;
  private readonly shape: AssemblyShape;
  private readonly combat: AssemblyCombatState;
  private readonly collision: AssemblyCollision;

  // View を seed の形状から組み、接触は部品を覆う球列へ当てる。combat は被弾モデルで、
  // 省けば無傷から始める。id は採番器が配った識別子。
  private constructor(
    placement: EnemyPlacement,
    shape: AssemblyShape,
    id: string,
    scene?: THREE.Scene,
    combat = new AssemblyCombatState(shape),
    alive?: boolean,
    burstLeft?: number | null,
    burstDelay?: number | null,
    lastFireSim?: number | null,
    lastBehaviorSim?: number | null,
  ) {
    const collision = new AssemblyCollision(shape.parts);
    const collisionShape: EnemyCollisionShape = {
      testSphereCollision: (_self, sphereCenter, sphereRadius, selfState, selfAttitude) => (
        collision.testSphereCollision(sphereCenter, sphereRadius, selfState.r, selfAttitude.q)
      ),
      testSweptSphereCollision: (
        _self, previousSphereCenter, sphereCenter, sphereRadius, previousSelfState, selfState,
        previousSelfAttitude, selfAttitude,
      ) => collision.testSweptSphereCollision(
        previousSphereCenter, sphereCenter, sphereRadius,
        previousSelfState, selfState, previousSelfAttitude.q, selfAttitude.q,
      ),
    };
    super(
      placement, new AssemblyEnemyView(shape, placement.accent, scene),
      shape.inertia, shape.outerRadius, id, collisionShape,
      alive, burstLeft, burstDelay, lastFireSim, lastBehaviorSim,
    );
    this.seed = shape.seed;
    this.shape = shape;
    this.combat = combat;
    this.collision = collision;
    // 復元された被弾モデルの失われた部品は、判定形状からも除いておく。
    for (const part of shape.parts) {
      if (!combat.partAlive(part.index)) collision.excludePart(part.index);
    }
  }

  // request の敵を、無秩序に漂う姿勢で新しく置く。
  public static create(
    request: AssemblyEnemyRequest, idAllocators: EntityIdAllocators, scene?: THREE.Scene,
  ): AssemblyEnemy {
    const formationId = request.formationId;
    return new AssemblyEnemy(
      {
        name: request.name,
        state: deserializeKinematicState(request.state),
        ...driftingAttitude(),
        accent: request.accent,
        orbitLineColor: request.orbitLineColor,
        attackGroupId: formationId ?? undefined,
        waveId: null,
        formationId,
        formationRole: request.formationRole,
      },
      generateAssemblyShape(request.seed),
      idAllocators.entity.next(),
      scene,
    );
  }

  // 直列化した敵を復元する。形状は seed から組み直し、部品の HP は被弾モデルの記録から戻す。
  public static deserialize(
    serialized: SerializedAssemblyEnemy, registry: EntityRegistry, scene?: THREE.Scene,
  ): AssemblyEnemy {
    const shape = generateAssemblyShape(serialized.seed);
    return new AssemblyEnemy(
      deserializeEnemyPlacement(serialized),
      shape,
      registry.idAllocators.entity.next(serialized.id || undefined),
      scene,
      serialized.assembly
        ? AssemblyCombatState.deserialize(serialized.assembly, shape)
        : undefined,
      serialized.alive,
      // 射撃の途中経過と時刻
      serialized.fireController.burstLeft,
      serialized.fireController.burstDelay,
      serialized.fireController.lastFireSim,
      serialized.fireController.lastBehaviorSim,
    );
  }

  public override get hp(): number { return this.combat.integrity; }
  public override get maxHp(): number { return this.combat.maxIntegrity; }

  // 発射部が残っている間だけ撃てる。
  protected override canFire(): boolean {
    return this.combat.emitterAlive;
  }

  // 発射部の先端の ECI 位置。ローカル座標の先端を個体の位置・姿勢で写したもの。
  protected override muzzlePosition(): Vec3 {
    return add(this.motion.state.r, qRotate(this.motion.att.q, this.shape.emitterTip));
  }

  // 既定のプラズマ弾のダメージ。
  protected override plasmaDamage(): number {
    return PLASMA_BULLET_DAMAGE;
  }

  // 発射部から撃ったことを記録する。
  protected override fired(muzzleState: KinematicState, events: RunEventSink): void {
    events.record({ kind: 'assemblyEmitterFired', muzzleState });
  }

  // 被弾位置に最も近い生存部品へダメージを割り振る。部品が失われたら判定からも外し、
  // その位置で閃光を記録する。
  protected override applyBulletDamage(
    damage: number, impactPoint: Vec3, events: RunEventSink,
  ): void {
    // 着弾点を敵ローカル座標へ戻して部品を特定する
    const localPoint = qRotate(
      qInvert(this.motion.att.q), sub(impactPoint, this.motion.state.r),
    );
    const partIndex = this.collision.partAt(localPoint);
    const broken = this.combat.applyBulletDamage(damage, partIndex);
    if (broken === null) return;
    this.collision.excludePart(broken);
    const part = this.shape.parts[broken]!;
    const midpoint = part.centerline[Math.floor(part.centerline.length / 2)]!;
    events.record({
      kind: 'assemblyPartBroken',
      state: kinematicState<'eci'>(
        this.motion.state.t,
        add(this.motion.state.r, qRotate(this.motion.att.q, midpoint)),
        this.motion.state.v,
      ),
    });
  }

  // 接触は部品を選ばず integrity 全体を削る。
  protected override applyImpactDamage(damageSpeed: number): boolean {
    const damageFraction = collisionDamageFraction(damageSpeed);
    if (damageFraction <= 0) return false;
    this.combat.applyIntegrityDamage(this.maxHp * damageFraction);
    return true;
  }

  // 被弾で失われた部品を表示入力へ足す。
  protected override renderSource(
    viewFrame: DynamicViewFrame, active: boolean, orbitReference?: OrbitReference,
  ): AssemblyVisualSource {
    return {
      ...super.renderSource(viewFrame, active, orbitReference),
      aliveParts: this.shape.parts.map((part) => this.combat.partAlive(part.index)),
    };
  }

  // 敵に共通する直列化の項目へ、seed と被弾モデルの状態を足す。
  public override serialize(): SerializedAssemblyEnemy {
    return {
      ...this.serializeEnemyFields(),
      kind: AssemblyEnemy.kind,
      seed: this.seed,
      assembly: this.combat.serialize(),
    };
  }
}

// この個体が組み立て型の敵か。
export function isAssemblyEnemy(entity: DynamicEntity): entity is AssemblyEnemy {
  return entity instanceof AssemblyEnemy;
}

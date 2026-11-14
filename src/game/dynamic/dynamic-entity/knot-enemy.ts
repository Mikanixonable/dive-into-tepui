import type * as THREE from 'three/webgpu';
import { add, sub, v3, type Vec3 } from '../../../math/vec3';
import { qInvert, qRotate } from '../../../math/quat';
import {
  deserializeKinematicState, type SerializedKinematicState,
} from '../../../physics/kinematic-state';
import { collisionDamageFraction } from './contact-damage';
import {
  generateKnotShape, knotParamsFromSeed, type KnotParams, type KnotShape,
} from '../../knot/knot-shape';
import { KnotCollision } from '../../knot/knot-collision';
import { KnotCombatState, type SerializedKnotCombatState } from '../../knot/knot-combat-state';
import {
  Enemy, PLASMA_BULLET_DAMAGE, deserializeEnemyPlacement, driftingAttitude,
  type EnemyPlacement, type SerializedEnemy,
} from './enemy';
import { KnotEnemyView } from '../../../render/dynamic/dynamic-entity/knot-enemy-view';
import type { EntityRegistry, SpawnGate } from '../entity-registry';
import type { RunEventSink } from '../../run-events';
import type { EntityIdAllocators } from './entity-id';
import type { FormationRole } from './entity-kind';
import type { DynamicEntity } from './dynamic-entity';
import type { EnemyCollisionShape } from './enemy-motion';

// 新しく置く結節体の要求。seed が個体の形状を決める。params を渡せば、その明示
// パラメーターで組む(物語上の個体。GAME.md の配置が選ぶ)。陣形に属さない個体は
// formationId と役割が null。
export interface KnotEnemyRequest {
  readonly name: string;
  readonly state: SerializedKinematicState;
  readonly seed: number;
  readonly params?: KnotParams;
  readonly accent: string | number;
  readonly orbitLineColor: string | number;
  readonly formationId: string | null;
  readonly formationRole: FormationRole | null;
  // 編隊の指揮機の id。省けば指揮機を持たない。
  readonly commanderId?: string | null;
  // 個体の id。省けば採番器が発番する。
  readonly id?: string;
  // 4状態の意図を持つ敵かどうか。省けば意図を持たない。
  readonly tracksIntent?: boolean;
}

export interface SerializedKnotEnemy extends SerializedEnemy {
  readonly kind: 'knot-enemy';
  // 個体の形状を決めるパラメーター。形状そのものは記録せず、ここから組み直す。
  readonly params: KnotParams;
  // セグメント・ノード・中核の HP と索全体の耐久の記録。
  readonly knot: SerializedKnotCombatState;
}

// 結節体の敵(SPEC/KNOT.md)。索を編んだ結び目を体とし、被弾モデル
// (KnotCombatState)が HP の正本。判定形状は索・ノード・中核を覆う球列で、
// 中核は索の球列が手前にあれば弾を索が受けることで遮蔽される。このスライス
// では無武装 — 射撃は K4 で射撃役の結節ノードが担う。セグメントの断裂と
// ほどけの反映も戦闘スライス(K3)で足す。
export class KnotEnemy extends Enemy {
  public static readonly kind = 'knot-enemy';
  public declare readonly view: KnotEnemyView;
  // 外部資産を待つ必要がないので、ゲートは常に null。
  public static spawnGate(): SpawnGate | null { return null; }

  private readonly shape: KnotShape;
  private readonly combat: KnotCombatState;
  private readonly collision: KnotCollision;

  // View を形状から組み、接触は索と部位を覆う球列へ当てる。combat は被弾モデルで、
  // 省けば無傷から始める。id は採番器が配った識別子。
  private constructor(
    placement: EnemyPlacement,
    shape: KnotShape,
    id: string,
    scene?: THREE.Scene,
    combat = new KnotCombatState(shape),
    alive?: boolean,
    burstLeft?: number | null,
    burstDelay?: number | null,
    lastFireSim?: number | null,
    lastBehaviorSim?: number | null,
  ) {
    const collision = new KnotCollision(shape);
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
      placement, new KnotEnemyView(shape, placement.accent, scene),
      v3(shape.inertia[0], shape.inertia[1], shape.inertia[2]), shape.outerRadius, id, collisionShape,
      alive, burstLeft, burstDelay, lastFireSim, lastBehaviorSim,
    );
    this.shape = shape;
    this.combat = combat;
    this.collision = collision;
  }

  // request の敵を、無秩序に漂う姿勢で新しく置く。
  public static create(
    request: KnotEnemyRequest, idAllocators: EntityIdAllocators, scene?: THREE.Scene,
  ): KnotEnemy {
    const formationId = request.formationId;
    const shape = generateKnotShape(request.params ?? knotParamsFromSeed(request.seed));
    return new KnotEnemy(
      {
        name: request.name,
        state: deserializeKinematicState(request.state),
        ...driftingAttitude(),
        accent: request.accent,
        orbitLineColor: request.orbitLineColor,
        attackGroupId: formationId ?? undefined,
        id: request.id,
        waveId: null,
        formationId,
        formationRole: request.formationRole,
        commanderId: request.commanderId,
        tracksIntent: request.tracksIntent,
      },
      shape,
      idAllocators.entity.next(request.id),
      scene,
    );
  }

  // 直列化した敵を復元する。形状はパラメーターから組み直し、損傷は被弾モデルの
  // 記録から戻す。
  public static deserialize(
    serialized: SerializedKnotEnemy, registry: EntityRegistry, scene?: THREE.Scene,
  ): KnotEnemy {
    const shape = generateKnotShape(serialized.params);
    return new KnotEnemy(
      deserializeEnemyPlacement(serialized),
      shape,
      registry.idAllocators.entity.next(serialized.id || undefined),
      scene,
      serialized.knot
        ? KnotCombatState.deserialize(serialized.knot, shape)
        : undefined,
      serialized.alive,
      // 射撃の途中経過と時刻
      serialized.fireController.burstLeft,
      serialized.fireController.burstDelay,
      serialized.fireController.lastFireSim,
      serialized.fireController.lastBehaviorSim,
    );
  }

  // 撃破判定は被弾モデルへ委ねる — 中核の破壊と耐久の枯渇が撃破。ほどけの進み
  // 具合は HP の数ではなく状態(フェーズ)で読む(KNOT.md)。
  public override get hp(): number { return this.combat.destroyed ? 0 : this.combat.integrity; }
  public override get maxHp(): number { return this.combat.maxIntegrity; }

  // このスライスでは無武装。射撃は射撃役の結節ノードが担うようになってから開く。
  protected override canFire(): boolean {
    return false;
  }

  // 砲口は持たない。射撃が開くまでは呼ばれないが、基底の契約として駆動中核の
  // 位置を返す。
  protected override muzzlePosition(): Vec3 {
    const core = this.shape.core.position;
    return add(this.motion.state.r, qRotate(this.motion.att.q, v3(core[0], core[1], core[2])));
  }

  // 既定のプラズマ弾のダメージ。射撃を開くときに射撃役ノードの値として使う。
  protected override plasmaDamage(): number {
    return PLASMA_BULLET_DAMAGE;
  }

  // 無武装なので発砲の記録は無い。
  protected override fired(): void {}

  // 被弾位置に最も近い部位(セグメント・ノード・中核)へダメージを割り振る。
  // 部位の喪失に伴う断裂・判定からの除外は K3 で、ここでは HP だけが減る。
  protected override applyBulletDamage(
    damage: number, impactPoint: Vec3, _events: RunEventSink,
  ): void {
    const localPoint = qRotate(
      qInvert(this.motion.att.q), sub(impactPoint, this.motion.state.r),
    );
    this.combat.applyBulletDamage(damage, this.collision.targetAt(localPoint));
  }

  // 接触は部位を選ばず、索全体の耐久を削る。
  protected override applyImpactDamage(damageSpeed: number): boolean {
    const damageFraction = collisionDamageFraction(damageSpeed);
    if (damageFraction <= 0) return false;
    this.combat.applyIntegrityDamage(this.maxHp * damageFraction);
    return true;
  }

  // 敵に共通する直列化の項目へ、パラメーターと被弾モデルの状態を足す。
  public override serialize(): SerializedKnotEnemy {
    return {
      ...this.serializeEnemyFields(),
      kind: KnotEnemy.kind,
      params: this.shape.params,
      knot: this.combat.serialize(),
    };
  }
}

// この個体が結節体か。
export function isKnotEnemy(entity: DynamicEntity): entity is KnotEnemy {
  return entity instanceof KnotEnemy;
}

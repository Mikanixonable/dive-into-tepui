import type * as THREE from 'three/webgpu';
import {
  deserializeKinematicState, kinematicState, type KinematicState, type SerializedKinematicState,
} from '../../../physics/kinematic-state';
import { v3, type Vec3 } from '../../../math/vec3';
import { collisionDamageFraction } from './contact-damage';
import { proteinEnemyDefinitionFor } from '../../protein/protein-enemy-registry';
import { ProteinCombatState, type SerializedProteinCombatState } from '../../protein/protein-combat-state';
import { ProteinSphereCollisionGeometry } from '../../protein/protein-sphere-collision';
import {
  ENEMY_MODEL_SCALE, Enemy, PLASMA_BULLET_DAMAGE, deserializeEnemyPlacement, driftingAttitude,
  type EnemyPlacement, type SerializedEnemy,
} from './enemy';
import {
  proteinAssetGate, proteinRenderDefinitionFor, type ProteinAssetId,
} from '../../protein/protein-asset-loader';
import type { EntityRegistry, SpawnGate } from '../entity-registry';
import type { RunEventSink } from '../../run-events';
import type { EntityIdAllocators } from './entity-id';
import type { ProteinEnemyDefinition } from '../../protein/protein-enemy-registry';
import type { ProteinRenderDefinition } from '../../../render/protein/protein-render-definition';
import type { ProteinCombatReadout } from '../../protein/protein-schema';
import type { FormationRole } from './entity-kind';
import { ProteinEnemyView } from '../../../render/dynamic/dynamic-entity/protein-enemy-view';
import type { DynamicEntity } from './dynamic-entity';
import type { EnemyCollisionShape } from './enemy-motion';
import type { DynamicViewFrame } from '../../../render/dynamic/dynamic-view';
import type { ProteinVisualSource } from '../../../render/dynamic/dynamic-entity/protein-enemy-view';
import type { OrbitReference } from '../../orbit-reference';
import type { ProteinCombatTarget } from './damage-capabilities';
import type { EnemyProteinInspection } from '../../pickable/enemy-inspection';
import type { ProteinMotionMetrics } from '../../../render/dynamic/dynamic-entity/protein-enemy-view';

// タンパク質の構造は揺らぐが、判定形状は常に静止した1つに固定するので、慣性も1つでよい。
// 漂流機体と同じく非対称にして、ジャニベコフ効果(中間軸不安定性)で無秩序に回らせる。
const PROTEIN_INERTIA = v3(1, 1.1, 1.05);

// 新しく置くタンパク質の敵の要求。アセットが揃うまで実体化を待てるよう(SPEC/PROTEIN.md「出現」節)、
// 直列化できる値だけで表す。陣形に属する個体だけが formationId と役割を持ち、属さない個体は単体敵になる。
export interface ProteinEnemyRequest {
  readonly name: string;
  readonly state: SerializedKinematicState;
  readonly assetId: ProteinAssetId;
  readonly formationId: string | null;
  readonly formationRole: FormationRole | null;
}

// 同じ陣形に生存中のエネルギー役がいるかを答える。攻撃担当以外と、陣形に属さない敵
// (formationId なし)は常に true。
export function isFormationEnergyAvailable(
  formationRole: FormationRole | null,
  formationId: string | null,
  enemies: readonly {
    readonly motion: { readonly alive: boolean };
    readonly formationId: string | null;
    readonly formationRole: FormationRole | null;
  }[],
): boolean {
  if (formationRole !== 'attacker' || formationId === null) return true;
  return enemies.some((enemy) => (
    enemy.motion.alive && enemy.formationId === formationId && enemy.formationRole === 'energy'
  ));
}

// 登録済みのタンパク質敵定義を引く。取得できていなければ実体化できないので投げる。
function definitionFor(assetId: ProteinAssetId): ProteinEnemyDefinition {
  const definition = proteinEnemyDefinitionFor(assetId);
  if (!definition) throw new Error(`No protein enemy definition registered for ${assetId}`);
  return definition;
}

// 表示ツリーの組み立て手順。判定形状と同じく、アセットが揃っていなければ実体化できない。
function renderDefinitionFor(assetId: ProteinAssetId): ProteinRenderDefinition {
  const definition = proteinRenderDefinitionFor(assetId);
  if (!definition) throw new Error(`No protein render definition registered for ${assetId}`);
  return definition;
}

export interface SerializedProteinEnemy extends SerializedEnemy {
  readonly kind: 'protein-enemy';
  readonly assetId: ProteinAssetId;
  // 機能部位の HP・フェーズ・修飾。
  readonly protein: SerializedProteinCombatState;
}

// タンパク質の敵。機能部位ごとに破壊できる被弾モデル(ProteinCombatState)が HP の正本で、
// 判定形状は表示形態によらず、アセットが持つ球列に固定する。
export class ProteinEnemy extends Enemy implements ProteinCombatTarget {
  public static readonly kind = 'protein-enemy';
  public declare readonly view: ProteinEnemyView;
  // その体のアセットの取得を起こし、実体化してよいかを答える関門を返す。
  public static spawnGate(serialized: SerializedProteinEnemy): SpawnGate {
    return proteinAssetGate(serialized.assetId);
  }

  private readonly assetId: ProteinAssetId;

  // View を組み、definition のアセットが持つ球列へ判定形状を当てる。motionSeed は表示の揺らぎの軌跡を
  // 決める識別子、id は採番器が配った識別子、combat は被弾モデルで、省けば無傷から始める。
  private constructor(
    placement: EnemyPlacement,
    definition: ProteinEnemyDefinition,
    motionSeed: string,
    id: string,
    scene: THREE.Scene | undefined,
    private readonly combat = new ProteinCombatState(definition.asset),
    alive?: boolean,
    burstLeft?: number | null,
    burstDelay?: number | null,
    lastFireSim?: number | null,
    lastBehaviorSim?: number | null,
  ) {
    // 表示が原子模型へ切り替わっても、判定形状は常に同じ球列に固定する。
    const collision = new ProteinSphereCollisionGeometry(
      definition.collisionSpheres, ENEMY_MODEL_SCALE,
    );
    const proteinView = new ProteinEnemyView(
      renderDefinitionFor(definition.assetId), ENEMY_MODEL_SCALE, collision.outerRadius, motionSeed, scene,
    );
    const shape: EnemyCollisionShape = {
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
      placement, proteinView, PROTEIN_INERTIA, collision.outerRadius, id, shape,
      alive, burstLeft, burstDelay, lastFireSim, lastBehaviorSim,
    );
    this.assetId = definition.assetId;
  }

  // request の敵を、無秩序に漂う姿勢で新しく置く。名前には、陣形役割・識別番号などの識別子の前へ
  // タンパク質固有の名称を冠する。アセットが未取得なら投げるので、揃ってから呼ぶこと。
  public static create(
    request: ProteinEnemyRequest, idAllocators: EntityIdAllocators, scene?: THREE.Scene,
  ): ProteinEnemy {
    const definition = definitionFor(request.assetId);
    const formationId = request.formationId;
    return new ProteinEnemy(
      {
        name: `${definition.asset.displayName} ${request.name}`,
        state: deserializeKinematicState(request.state),
        ...driftingAttitude(),
        accent: 0xffffff,
        orbitLineColor: 0xffffff,
        // 陣形に属する個体は、陣形を攻撃グループとして同時発砲数を共有する。
        attackGroupId: formationId ?? undefined,
        waveId: null,
        formationId,
        formationRole: request.formationRole,
      },
      definition,
      // 表示の揺らぎの軌跡を決める識別子。
      request.name || request.assetId,
      idAllocators.entity.next(),
      scene,
    );
  }

  // 直列化した敵を復元する。HP は被弾モデルの記録から戻す。アセットが未取得なら投げるので、
  // spawnGate で準備完了を待ってから呼ぶこと。
  public static deserialize(
    serialized: SerializedProteinEnemy, registry: EntityRegistry, scene?: THREE.Scene,
  ): ProteinEnemy {
    const definition = definitionFor(serialized.assetId);
    const placement = deserializeEnemyPlacement(serialized);
    return new ProteinEnemy(
      placement,
      definition,
      serialized.id || serialized.name || serialized.assetId,
      registry.idAllocators.entity.next(placement.id),
      scene,
      serialized.protein ? ProteinCombatState.deserialize(serialized.protein, definition.asset) : undefined,
      serialized.alive,
      // 射撃の途中経過と時刻
      serialized.fireController.burstLeft,
      serialized.fireController.burstDelay,
      serialized.fireController.lastFireSim,
      serialized.fireController.lastBehaviorSim,
    );
  }

  public override get hp(): number { return this.combat.integrityHp; }
  public override get maxHp(): number { return this.combat.integrityMaxHp; }

  public get combatReadout(): ProteinCombatReadout { return this.combat.combatReadout(); }
  public get proteinMotionMetrics(): ProteinMotionMetrics { return this.view.motionMetrics; }

  // 機能部位の状態と、表示位置に置いた部位マーカーを答える面。
  public override get proteinInspection(): EnemyProteinInspection {
    return {
      combatReadout: () => this.combatReadout,
      siteMarkers: (displayPos, attitude) => this.view.siteMarkers(
        displayPos, attitude, this.combatReadout.sites,
      ),
    };
  }

  // 被弾モデルの構造フェーズを共通の表示入力へ足す。
  protected override renderSource(
    viewFrame: DynamicViewFrame, active: boolean, orbitReference: OrbitReference | undefined,
  ): ProteinVisualSource {
    return {
      ...super.renderSource(viewFrame, active, orbitReference),
      phase: this.combat.phase,
    };
  }

  // 陣形内に生存中のエネルギー役がいる間だけ、攻撃行動が有効になる。
  protected override canFire(enemies: readonly Enemy[]): boolean {
    const attackAction = this.combat.attackAction;
    if (attackAction === null) return false;
    const energyAvailable = isFormationEnergyAvailable(this.formationRole, this.formationId, enemies);
    return energyAvailable && this.combat.isActionEnabled(attackAction.id);
  }

  // 次に撃つ機能部位の ECI 位置。呼ぶたびに撃つ部位を順繰りに進める。銃口は静止座標で取り、
  // 表示の揺らぎ(残基変位)は乗せない。
  protected override muzzlePosition(): Vec3 {
    const site = this.combat.nextAttackSite();
    return this.view.siteWorldPositionById(site?.id ?? '', this.motion.state.r, this.motion.att.q);
  }

  // 修飾の倍率を掛けたプラズマ弾のダメージ。
  protected override plasmaDamage(): number {
    return this.combat.projectileDamage(PLASMA_BULLET_DAMAGE);
  }

  // 機能部位から撃ったことを記録する。
  protected override muzzleEffect(muzzleState: KinematicState, events: RunEventSink): void {
    events.record({ kind: 'proteinSiteFired', muzzleState });
  }

  // 被弾位置に最も近い機能部位へダメージを割り振る。
  protected override applyBulletDamage(
    damage: number, impactPoint: Vec3, events: RunEventSink,
  ): void {
    // 着弾点と各部位の位置を、同じ模型座標で比べる
    const localPoint = this.view.localImpactPoint(
      impactPoint, this.motion.state.r, this.motion.att.q,
    );
    const sitePositions = new Map(
      this.combat.combatReadout().sites.map((site) => [site.id, this.view.siteModelPositionById(site.id)] as const),
    );
    const result = this.combat.applyDamage(damage, localPoint, sitePositions);
    // 部位が止まるか構造フェーズが変わったら、着弾点の出来事として記録する
    if (result.siteDisabled || result.phaseChanged) {
      events.record({
        kind: 'proteinStateChanged',
        state: kinematicState<'eci'>(this.motion.state.t, impactPoint, this.motion.state.v),
        transition: result.phaseChanged ? result.phase : 'site-disabled',
      });
    }
  }

  // 接触は部位を選ばず integrity 全体を削る。
  protected override applyImpactDamage(damageSpeed: number): boolean {
    const damageFraction = collisionDamageFraction(damageSpeed);
    if (damageFraction <= 0) return false;
    this.combat.applyContactDamage(this.maxHp * damageFraction);
    return true;
  }

  // 敵に共通する直列化の項目へ、アセットと被弾モデルの状態を足す。
  public override serialize(): SerializedProteinEnemy {
    return {
      ...this.serializeEnemyFields(),
      kind: ProteinEnemy.kind,
      assetId: this.assetId,
      protein: this.combat.serialize(),
    };
  }
}

// この個体がタンパク質構造を持つ敵か。
export function isProteinEnemy(entity: DynamicEntity): entity is ProteinEnemy {
  return entity instanceof ProteinEnemy;
}

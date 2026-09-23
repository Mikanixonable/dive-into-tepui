import type * as THREE from 'three/webgpu';
import { v3, type Vec3 } from '../../../math/vec3';
import {
  ENEMY_MODEL_SCALE, PLASMA_BULLET_DAMAGE, deserializeEnemyPlacement,
  type EnemyPlacement, type SerializedEnemy,
} from './enemy';
import { PartBasedEnemy } from './part-based-enemy';
import { createShipDefaultParts } from './ship-default-parts';
import type { EntityIdAllocators } from './entity-id';
import type { EntityRegistry } from '../entity-registry';
import { deserializeParts, type Part, type AnyPart } from './parts';
import { MetalEnemyView, VariantMetalEnemyView } from '../../../render/dynamic/dynamic-entity/metal-enemy-view';
import { EnemyFireState } from './enemy-fire-controller';

// 各金属機体モデルを ENEMY_MODEL_SCALE 倍したときの外接球半径 [m]。アセットの bounds を写した
// 定数で、一致は描画テストが確かめる。
const DRIFTING_COLLISION_RADIUS = 67.1935257886386;
const TYPED_COLLISION_RADII = [
  93.8906797184146,
  91.58602476518524,
  86.22292463258124,
] as const;

// typeIndex の機体の接触半径 [m]。型番を持たない漂流機体は null で引く。
export function metalEnemyCollisionRadius(typeIndex: number | null): number {
  if (typeIndex === null) return DRIFTING_COLLISION_RADIUS;
  return TYPED_COLLISION_RADII[typeIndex] ?? TYPED_COLLISION_RADII[0];
}

// 機体テンプレートを持たない漂流機体は主慣性モーメントを非対称にして、ジャニベコフ効果
// (中間軸不安定性)で無秩序に回らせる。型番を持つ機体は生成時に機首をプログレードへ向けるが、
// その後の姿勢追従制御は行わない。初期角速度が 0 のため等方慣性でよい。
const DRIFTING_INERTIA = v3(1, 1.1, 1.05);
const TYPED_INERTIA = v3(1, 1, 1);

// 既定パーツへ HP を配分する基準値。各パーツを最低 1 HP に丸めるため、機体の総 HP ではない。
const METAL_ENEMY_PART_HP_SCALE = 6;

export interface SerializedMetalEnemy extends SerializedEnemy {
  readonly kind: 'metal-enemy';
  // 機体テンプレート番号。型番を持たない漂流機体は null。
  readonly typeIndex: number | null;
  readonly parts: readonly AnyPart[];
}

// 敵の配置に機体テンプレート番号を足したもの。typeIndex が null なら型番を持たない漂流機体。
type MetalEnemyPlacement = EnemyPlacement & { readonly typeIndex: number | null };

// 金属機体の敵。機体テンプレートが外形と接触半径を決め、被弾は艦と同じパーツ式の被弾モデルへ入る。
export class MetalEnemy extends PartBasedEnemy {
  public static readonly kind = 'metal-enemy';
  public static spawnGate(): null { return null; }

  private readonly typeIndex: number | null;

  // View の機体テンプレートと、それに対応する Motion の接触半径を同じ typeIndex で選ぶ。id は採番器が
  // 配った識別子。parts は機体の部品構成で、省けば既定の構成を満タンで積む。
  private constructor(
    placement: MetalEnemyPlacement,
    id: string,
    scene: THREE.Scene | undefined,
    // parts は被弾モデルの構成。weapon を含むが、敵 AI のプラズマ射撃能力とは独立している。
    parts: readonly Part[] = createShipDefaultParts(METAL_ENEMY_PART_HP_SCALE),
    alive?: boolean,
    fireState = new EnemyFireState(),
  ) {
    const { typeIndex, accent } = placement;
    // 型番の有無で見た目と慣性を選ぶ
    const metalView = typeIndex === null
      ? new MetalEnemyView(accent, ENEMY_MODEL_SCALE, scene)
      : new VariantMetalEnemyView(accent, typeIndex, ENEMY_MODEL_SCALE, scene);
    super(
      placement, metalView, typeIndex === null ? DRIFTING_INERTIA : TYPED_INERTIA,
      metalEnemyCollisionRadius(typeIndex), id, parts, alive, fireState,
    );
    this.typeIndex = typeIndex;
  }

  // placement に新しく置く。
  public static create(
    placement: MetalEnemyPlacement, idAllocators: EntityIdAllocators, scene?: THREE.Scene,
  ): MetalEnemy {
    return new MetalEnemy(placement, idAllocators.entity.next(placement.id), scene);
  }

  // 直列化した敵を復元する。
  public static deserialize(
    serialized: SerializedMetalEnemy, registry: EntityRegistry, scene?: THREE.Scene,
  ): MetalEnemy {
    const placement = { ...deserializeEnemyPlacement(serialized), typeIndex: serialized.typeIndex };
    return new MetalEnemy(
      placement,
      registry.idAllocators.entity.next(placement.id),
      scene,
      deserializeParts(serialized.parts),
      serialized.alive,
      EnemyFireState.deserialize(serialized.fireController),
    );
  }

  // 金属機体のプラズマ射撃は、被弾モデル内の weapon パーツの損傷状態に依存しない。
  protected override canFire(): boolean {
    return true;
  }

  // 機体の中心から撃つ。
  protected override muzzlePosition(): Vec3 {
    return this.motion.state.r;
  }

  // 既定のプラズマ弾のダメージ。
  protected override plasmaDamage(): number {
    return PLASMA_BULLET_DAMAGE;
  }

  protected override fired(): void {}

  // 被弾位置によらず、健全な部品へ無作為に割り振る。
  protected override applyBulletDamage(damage: number): void {
    this.applyDamageToParts(damage);
  }

  // 接近速度に応じたダメージを、健全な部品へ無作為に割り振る。
  protected override applyImpactDamage(damageSpeed: number): boolean {
    return this.applyCollisionDamage(damageSpeed);
  }

  // 敵に共通する直列化の項目へ、型番と部品を足す。
  public override serialize(): SerializedMetalEnemy {
    return {
      ...this.serializeEnemyFields(),
      kind: MetalEnemy.kind,
      typeIndex: this.typeIndex,
      parts: this.serializeParts(),
    };
  }
}

import type * as THREE from 'three/webgpu';
import { v3, type Vec3 } from '../../../math/vec3';
import { WorldSfx } from '../../../audio/sfx/world-sfx';
import { FlashEffects } from '../../vfx/flash-effects';
import { Enemy, PLASMA_BULLET_DAMAGE, type EnemyPlacement, type EnemyRestore } from './enemy';
import type { MetalEnemySaveData } from '../../save/save-data';
import { MetalEnemyView, Stage0MetalEnemyView } from './metal-enemy-view';
import { metalEnemyCollisionRadius } from './enemy-motion';

// 機体テンプレートを持たない漂流機体は主慣性モーメントを非対称にして、ジャニベコフ効果
// (中間軸不安定性)で無秩序に回らせる。型番を持つ機体は機首をプログレードへ向けたまま飛ぶので
// 等方でよい。
const DRIFTING_INERTIA = v3(1, 1.1, 1.05);
const TYPED_INERTIA = v3(1, 1, 1);

// 新規配置。typeIndex が null なら型番を持たない漂流機体、数値なら stage00 ウェーブ敵の
// 機体テンプレート番号。
type MetalEnemyPlacement = EnemyPlacement & { readonly typeIndex: number | null };

// 金属機体の敵。艦と同じパーツ式の被弾モデルを持つ。
export class MetalEnemy extends Enemy {
  public static readonly kind = 'metal-enemy';
  public static spawnGate(): null { return null; }

  private readonly typeIndex: number | null;

  // View の機体テンプレートと、それに対応する Motion の接触半径を同じ typeIndex で選ぶ。
  public constructor(
    init: MetalEnemyPlacement | EnemyRestore,
    worldSfx: WorldSfx,
    fx: FlashEffects,
    scene?: THREE.Scene,
  ) {
    const typeIndex = 'saved' in init ? (init.saved as MetalEnemySaveData).typeIndex : init.typeIndex;
    const accent = 'saved' in init ? init.saved.accent : init.accent;
    const metalView = typeIndex === null
      ? new MetalEnemyView(accent, scene)
      : new Stage0MetalEnemyView(accent, typeIndex, scene);
    super(
      init, metalView, typeIndex === null ? DRIFTING_INERTIA : TYPED_INERTIA,
      metalEnemyCollisionRadius(typeIndex), worldSfx, fx,
    );
    this.typeIndex = typeIndex;
    // 部品単位の HP までは保存していないので、既定パーツ構成のまま総 HP を按分して戻す。
    if ('saved' in init) this.setOverallHp(init.saved.health);
  }

  protected override canFire(): boolean {
    return true;
  }

  protected override muzzlePosition(): Vec3 {
    return this.motion.state.r;
  }

  protected override plasmaDamage(): number {
    return PLASMA_BULLET_DAMAGE;
  }

  protected override applyBulletDamage(damage: number): void {
    this.applyDamageToParts(damage);
  }

  protected override applyImpactDamage(damageSpeed: number): boolean {
    return this.applyCollisionDamage(damageSpeed);
  }

  public override serialize(): MetalEnemySaveData {
    return { ...this.serializeEnemyFields(), kind: MetalEnemy.kind, typeIndex: this.typeIndex };
  }
}

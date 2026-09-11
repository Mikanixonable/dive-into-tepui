import type * as THREE from 'three/webgpu';
import { KinematicState, kinematicState } from '../../../physics/kinematic-state';
import { v3, type Vec3 } from '../../../math/vec3';
import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import type { FlashEffects } from '../../vfx/flash-effects';
import { collisionDamageFraction } from './contact-damage';
import { proteinEnemyDefinitionFor } from '../../protein/protein-enemy-registry';
import { ProteinCombatState } from '../../protein/protein-combat-state';
import { ProteinSphereCollisionGeometry } from '../../protein/protein-sphere-collision';
import { proteinLocalImpactPoint, proteinSiteWorldPosition } from '../../../render/protein/protein-anchors';
import { DEFAULT_PROTEIN_DISPLAY, isProteinDisplaySettings } from '../../../render/protein/protein-display';
import { ENEMY_MODEL_SCALE, Enemy, PLASMA_BULLET_DAMAGE, type EnemyPlacement, type EnemyRestore } from './enemy';
import {
  proteinAssetGate, proteinRenderDefinitionFor, type ProteinAssetId,
} from '../../protein/protein-asset-loader';
import type { SpawnGate } from '../entity-registry';
import type { ProteinDisplaySettings } from '../../../render/protein/protein-display';
import type { ProteinEnemyDefinition } from '../../protein/protein-enemy-registry';
import type { ProteinRenderDefinition } from '../../../render/protein/protein-render-definition';
import type { ProteinHudSnapshot } from '../../protein/protein-schema';
import type { EnemySaveData, ProteinEnemySaveData } from '../../save/save-data';
import type { FormationRole } from './entity-kind';
import { ProteinEnemyView } from '../../../render/dynamic/dynamic-entity/protein-enemy-view';
import type { EnemyCollisionShape } from './enemy-motion';
import type { DynamicViewFrame } from '../../../render/dynamic/dynamic-view';
import type { ProteinVisualSource } from '../../../render/dynamic/dynamic-entity/protein-enemy-view';
import type { OrbitReference } from '../../orbit-reference';

// タンパク質の構造は揺らぐが、判定形状は常に静止した1つに固定するので、慣性も1つでよい。
// 漂流機体と同じく非対称にして、ジャニベコフ効果(中間軸不安定性)で無秩序に回らせる。
const PROTEIN_INERTIA = v3(1, 1.1, 1.05);

// 新規配置。表示形態と着色は生成時に決め、以後は Entity の設定として切り替える。
type ProteinEnemyPlacement = EnemyPlacement & {
  readonly assetId: ProteinAssetId;
  readonly display: ProteinDisplaySettings;
};

// 同じ陣形に生存中のエネルギー役がいるかを答える。攻撃担当以外と、陣形に属さない敵
// (formationId なし)は常に true。
export function isFormationEnergyAvailable(
  formationRole: FormationRole | undefined,
  formationId: string | undefined,
  enemies: readonly {
    readonly motion: { readonly alive: boolean };
    readonly formationId?: string;
    readonly formationRole?: FormationRole;
  }[],
): boolean {
  if (formationRole !== 'attacker' || formationId === undefined) return true;
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

// セーブ由来の未検証な表示設定を受け、現行の選択肢に無いものは既定へ倒す。
function displayOf(init: ProteinEnemyPlacement | EnemyRestore): ProteinDisplaySettings {
  const saved = 'saved' in init ? (init.saved as ProteinEnemySaveData).display : init.display;
  return isProteinDisplaySettings(saved) ? saved : DEFAULT_PROTEIN_DISPLAY;
}

// タンパク質の敵。機能部位ごとに破壊できる被弾モデル(ProteinCombatState)が HP の正本で、
// 判定形状は表示形態によらず、アセットが持つ球列に固定する。
export class ProteinEnemy extends Enemy {
  public static readonly kind = 'protein-enemy';
  public declare readonly view: ProteinEnemyView;
  // その体のアセットの取得を起こし、実体化してよいかを答える関門を返す。
  public static spawnGate(saved: EnemySaveData): SpawnGate {
    return proteinAssetGate((saved as ProteinEnemySaveData).assetId);
  }

  private readonly assetId: ProteinAssetId;
  private displaySettings: ProteinDisplaySettings;
  private readonly combat: ProteinCombatState;

  // 表示メッシュを組み、アセットが持つ球列へ判定形状を当てる。アセットが未取得なら投げるので、
  // EnemyClass.spawnGate で準備完了を待ってから構築すること。
  public constructor(
    init: ProteinEnemyPlacement | EnemyRestore,
    worldSfx: WorldSfx,
    fx: FlashEffects,
    scene?: THREE.Scene,
  ) {
    const assetId = 'saved' in init ? (init.saved as ProteinEnemySaveData).assetId : init.assetId;
    const definition = definitionFor(assetId);
    const display = displayOf(init);
    const id = ('saved' in init ? init.saved.id || init.saved.name : init.id ?? init.name) || assetId;
    const combat = new ProteinCombatState(
      definition.asset,
      'saved' in init ? (init.saved as ProteinEnemySaveData).protein : undefined,
    );
    // 表示が原子模型へ切り替わっても、判定形状は常に同じ球列に固定する。
    const collision = new ProteinSphereCollisionGeometry(
      definition.collisionSpheres, ENEMY_MODEL_SCALE,
    );
    const proteinView = new ProteinEnemyView(
      renderDefinitionFor(assetId), display, ENEMY_MODEL_SCALE, collision.outerRadius, id, scene,
    );
    const shape: EnemyCollisionShape = {
      testSphereCollision: (self, sphereCenter, sphereRadius, selfState) => (
        collision.testSphereCollision(sphereCenter, sphereRadius, selfState.r, self.att.q)
      ),
      testSweptSphereCollision: (
        self, previousSphereCenter, sphereCenter, sphereRadius, previousSelfState, selfState,
      ) => collision.testSweptSphereCollision(
        previousSphereCenter, sphereCenter, sphereRadius,
        previousSelfState, selfState, self.att.q,
      ),
    };
    // 新規生成のときだけ、タンパク質固有の名称を陣形役割・識別番号などの既存識別子の前へ冠する。
    super(
      'saved' in init ? init : { ...init, name: `${definition.asset.displayName} ${init.name}` },
      proteinView, PROTEIN_INERTIA, collision.outerRadius, worldSfx, fx, shape,
    );
    this.assetId = assetId;
    this.displaySettings = display;
    this.combat = combat;
  }

  // HP の正本は combat 側なので、艦の既定パーツは積まない。
  protected override initDefaultParts(): void {}

  public override get hp(): number { return this.combat.integrityHp; }
  public override set hp(_value: number) {}
  public override get maxHp(): number { return this.combat.integrityMaxHp; }
  public override set maxHp(_value: number) {}

  public get display(): ProteinDisplaySettings { return this.displaySettings; }

  // ステージ操作の表示形態・着色変更を反映する。
  public setDisplay(display: ProteinDisplaySettings): void {
    this.displaySettings = display;
  }

  public get hudSnapshot(): ProteinHudSnapshot { return this.combat.hudSnapshot(); }

  // 表示設定と、被弾モデルの構造フェーズを共通の表示入力へ足す。
  protected override renderSource(
    viewFrame: DynamicViewFrame, visible: boolean, active: boolean,
    orbitReference: OrbitReference | undefined,
  ): ProteinVisualSource {
    return {
      ...super.renderSource(viewFrame, visible, active, orbitReference),
      display: this.displaySettings,
      phase: this.combat.phase,
    };
  }

  // 陣形内に生存中のエネルギー役がいる間だけ、攻撃行動が有効になる。
  protected override canFire(enemies: readonly Enemy[]): boolean {
    const attackAction = this.combat.attackAction;
    if (attackAction === null) return false;
    const energyAvailable = isFormationEnergyAvailable(this.formationRole, this.formationId, enemies);
    return this.combat.isActionEnabled(attackAction.id, energyAvailable);
  }

  protected override muzzlePosition(): Vec3 {
    return proteinSiteWorldPosition(
      this.combat.nextAttackSite(), [], [], 0,
      this.combat.asset.coordinateScale, ENEMY_MODEL_SCALE,
      this.motion.state.r, this.motion.att.q,
    );
  }

  protected override plasmaDamage(): number {
    return this.combat.projectileDamage(PLASMA_BULLET_DAMAGE);
  }

  protected override muzzleEffect(muzzleState: KinematicState): void {
    this._fx.spawnMuzzleFlash(muzzleState);
  }

  // 被弾位置に最も近い機能部位へダメージを割り振る。部位の機能停止・フェーズ遷移は閃光で示す。
  protected override applyBulletDamage(damage: number, impactPoint: Vec3): void {
    const localPoint = proteinLocalImpactPoint(
      impactPoint, this.motion.state.r, this.motion.att.q, ENEMY_MODEL_SCALE,
    );
    const result = this.combat.applyDamage(damage, localPoint);
    if (result.siteDisabled || result.phaseChanged) {
      this._fx.spawnProteinStateFlash(
        kinematicState<'eci'>(this.motion.state.t, impactPoint, this.motion.state.v),
        result.phaseChanged ? result.phase : 'site-disabled',
      );
    }
  }

  // 接触は部位を選ばず integrity 全体を削る。
  protected override applyImpactDamage(damageSpeed: number): boolean {
    const damageFraction = collisionDamageFraction(damageSpeed);
    if (damageFraction <= 0) return false;
    this.combat.applyContactDamage(this.maxHp * damageFraction);
    return true;
  }

  public override serialize(): ProteinEnemySaveData {
    return {
      ...this.serializeEnemyFields(),
      kind: ProteinEnemy.kind,
      assetId: this.assetId,
      display: this.displaySettings,
      protein: this.combat.serialize(),
    };
  }
}

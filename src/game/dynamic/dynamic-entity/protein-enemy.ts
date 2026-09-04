import * as THREE from 'three/webgpu';
import { KinematicState, kinematicState } from '../../../physics/kinematic-state';
import { v3, type Vec3 } from '../../../math/vec3';
import { apparentSizePx, metersPerPixel, type Viewpoint } from '../../../math/projection';
import { WorldSfx } from '../../../audio/sfx/world-sfx';
import { EffectsSystem } from '../../vfx/effects-system';
import { collisionDamageFraction } from './contact-damage';
import { proteinEnemyDefinitionFor } from '../../protein/protein-enemy-registry';
import { proteinMotionModeDisplacements } from '../../protein/protein-motion-modes';
import { ProteinRuntime } from '../../protein/protein-runtime';
import { ProteinRibbonCollisionGeometry } from '../../protein/protein-ribbon-collision';
import { createProteinMotionBinding } from '../../../render/protein-motion-material';
import { disposeOwnedRenderResources } from '../../../render/dispose-owned-render-resources';
import { DEFAULT_PROTEIN_DISPLAY, isProteinDisplaySettings } from '../../protein/protein-display';
import {
  Enemy, ENEMY_SCALE, PLASMA_BULLET_DAMAGE,
  type EnemyPlacement, type EnemyRestore, type FormationRole,
} from './enemy';
import type { ProteinAssetId } from '../../protein/protein-asset-loader';
import type { ProteinDisplaySettings } from '../../protein/protein-display';
import type { ProteinEnemyDefinition } from '../../protein/protein-enemy-registry';
import type { ProteinHudSnapshot } from '../../protein/protein-schema';
import type { ProteinMotionLod } from '../../protein/protein-motion-controller';
import type { FloatingOrigin } from '../../camera/floating-origin';
import type { EnemySaveData, ProteinEnemySaveData } from '../../save/save-data';

// タンパク質の構造は揺らぐが、判定形状は常に静止したリボンに固定するので、慣性も1つでよい。
// 漂流機体と同じく非対称にして、ジャニベコフ効果(中間軸不安定性)で無秩序に回らせる。
const PROTEIN_INERTIA = v3(1, 1.1, 1.05);

// 新規配置。表示形態と着色は生成時に決め、以後は setDisplay で切り替える。
type ProteinEnemyPlacement = EnemyPlacement & {
  readonly assetId: ProteinAssetId;
  readonly display: ProteinDisplaySettings;
};

// HUD の部位マーカーが必要とする、1つの機能部位の投影元位置と表示情報。
type ProteinSiteMarker = {
  readonly id: string;
  readonly worldPos: Vec3;
  readonly abbreviation: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly disabled: boolean;
  readonly attackable: boolean;
};

// 同じ陣形に生存中のエネルギー役がいるかを答える。攻撃担当以外と、陣形に属さない敵
// (formationId なし)は常に true。
export function isFormationEnergyAvailable(
  formationRole: FormationRole | undefined,
  formationId: string | undefined,
  enemies: readonly { readonly alive: boolean; readonly formationId?: string; readonly formationRole?: FormationRole }[],
): boolean {
  if (formationRole !== 'attacker' || formationId === undefined) return true;
  return enemies.some((enemy) => (
    enemy.alive && enemy.formationId === formationId && enemy.formationRole === 'energy'
  ));
}

// 登録済みのタンパク質敵定義を引く。取得できていなければ実体化できないので投げる。
function definitionFor(assetId: ProteinAssetId): ProteinEnemyDefinition {
  const definition = proteinEnemyDefinitionFor(assetId);
  if (!definition) throw new Error(`No protein enemy definition registered for ${assetId}`);
  return definition;
}

// セーブ由来の未検証な表示設定を受け、現行の選択肢に無いものは既定へ倒す。
function displayOf(init: ProteinEnemyPlacement | EnemyRestore): ProteinDisplaySettings {
  const saved = 'saved' in init ? (init.saved as ProteinEnemySaveData).display : init.display;
  return isProteinDisplaySettings(saved) ? saved : DEFAULT_PROTEIN_DISPLAY;
}

// タンパク質の敵。機能部位ごとに破壊できる被弾モデル(ProteinCombatState)が HP の正本で、
// 判定形状は表示形態によらず静止したリボンに固定する。
export class ProteinEnemy extends Enemy {
  public static readonly kind = 'protein-enemy';
  public static pendingAssetId(saved: EnemySaveData): ProteinAssetId {
    return (saved as ProteinEnemySaveData).assetId;
  }

  private readonly assetId: ProteinAssetId;
  private readonly runtime: ProteinRuntime;
  private readonly ribbonCollision: ProteinRibbonCollisionGeometry;
  private displaySettings: ProteinDisplaySettings;

  // 表示メッシュとリボン衝突形状を組む。アセットが未取得なら投げるので、
  // EnemyClass.pendingAssetId で準備完了を待ってから構築すること。
  public constructor(
    init: ProteinEnemyPlacement | EnemyRestore,
    worldSfx: WorldSfx,
    fx: EffectsSystem,
    scene?: THREE.Scene,
  ) {
    const assetId = 'saved' in init ? (init.saved as ProteinEnemySaveData).assetId : init.assetId;
    const definition = definitionFor(assetId);
    const display = displayOf(init);
    const motionBinding = createProteinMotionBinding(
      definition.motion.residueCount,
      proteinMotionModeDisplacements(definition.motion),
      definition.motion.modes.length,
    );
    const renderObject = definition.buildRenderObject(display, motionBinding ?? undefined);
    renderObject.scale.setScalar(ENEMY_SCALE);
    // 表示が原子模型へ切り替わっても、判定形状は常に同じリボンに固定する。
    const collisionSource = definition.buildCollisionObject();
    const ribbonCollision = new ProteinRibbonCollisionGeometry(collisionSource, ENEMY_SCALE);
    disposeOwnedRenderResources(collisionSource);
    // 新規生成のときだけ、タンパク質固有の名称を陣形役割・識別番号などの既存識別子の前へ冠する。
    super(
      'saved' in init ? init : { ...init, name: `${definition.asset.displayName} ${init.name}` },
      renderObject, PROTEIN_INERTIA, ribbonCollision.outerRadius, worldSfx, fx, scene,
    );
    this.assetId = assetId;
    this.displaySettings = display;
    this.ribbonCollision = ribbonCollision;
    this.runtime = new ProteinRuntime(
      this.renderObject, definition.asset, definition.motion,
      'saved' in init ? (init.saved as ProteinEnemySaveData).protein : undefined,
      this.id, motionBinding,
    );
  }

  // HP の正本は combat 側なので、艦の既定パーツは積まない。
  protected override initDefaultParts(): void {}

  public override get hp(): number { return this.runtime.combat.integrityHp; }
  public override set hp(_value: number) {}
  public override get maxHp(): number { return this.runtime.combat.integrityMaxHp; }
  public override set maxHp(_value: number) {}

  public get display(): ProteinDisplaySettings { return this.displaySettings; }

  // ステージ操作の表示形態・着色変更を反映する。
  public setDisplay(display: ProteinDisplaySettings): void {
    this.displaySettings = display;
    this.runtime.clearVisuals();
    definitionFor(this.assetId).recolorRenderObject(this.renderObject, display, this.runtime.motionBinding ?? undefined);
    this.runtime.rebuildVisuals();
  }

  public get hudSnapshot(): ProteinHudSnapshot { return this.runtime.hudSnapshot; }

  // 負荷確認ウィンドウが読む、直近 sync() 時点のモーション計算量。
  public get motionMetrics(): { readonly cpuMs: number; readonly uploadBytes: number; readonly lod: ProteinMotionLod } {
    return { cpuMs: this.runtime.cpuMs, uploadBytes: this.runtime.uploadBytes, lod: this.runtime.lod };
  }

  // 各機能部位の投影元位置と HUD 表示情報を並べる。displayPos には markerItem と同じ
  // 表示時刻の位置(stateAt 経由)を渡すこと。
  public siteMarkers(displayPos: Vec3): readonly ProteinSiteMarker[] {
    return this.runtime.hudSnapshot.sites.map((site) => ({
      id: site.id,
      worldPos: this.runtime.siteWorldPositionById(site.id, displayPos, this.att.q),
      abbreviation: site.abbreviation,
      hp: site.hp,
      maxHp: site.maxHp,
      disabled: site.disabled,
      attackable: site.attackable,
    }));
  }

  // 表示物を displayTime の状態へ合わせる。viewer を渡すと投影サイズからゆらぎの LOD を決め、
  // proteinVibrationEnabled が false なら静止した構造で描く。
  public override sync(
    fo: FloatingOrigin, displayTime: number, viewer?: Viewpoint, proteinVibrationEnabled = true,
  ): void {
    super.sync(fo, displayTime);
    if (!this.renderObject.visible) return;
    const displayed = this.stateAt(displayTime);
    const projectedDiameterPx = viewer && displayed
      ? apparentSizePx(this.radius * 2, metersPerPixel(viewer, displayed.r, window.innerHeight))
      : Number.POSITIVE_INFINITY;
    // marker LOD(ゆらぎが見えない投影サイズ)まで落ちた敵は、ゆらぎの更新を止める。
    if (this.runtime.updateLod(projectedDiameterPx) !== 'marker') {
      this.runtime.updateVisual(displayTime, proteinVibrationEnabled);
    }
  }

  public override testCustomSphereCollision(sphereCenter: Vec3, sphereRadius: number, selfState: KinematicState) {
    return this.ribbonCollision.testSphereCollision(sphereCenter, sphereRadius, selfState.r, this.att.q);
  }

  public override testCustomSweptSphereCollision(
    previousSphereCenter: Vec3, sphereCenter: Vec3, sphereRadius: number,
    previousSelfState: KinematicState, selfState: KinematicState,
  ) {
    return this.ribbonCollision.testSweptSphereCollision(
      previousSphereCenter, sphereCenter, sphereRadius, previousSelfState, selfState, this.att.q,
    );
  }

  public override usesCustomSphereCollision(): boolean {
    return true;
  }

  // 陣形内に生存中のエネルギー役がいる間だけ、攻撃行動が有効になる。
  protected override canFire(enemies: readonly Enemy[]): boolean {
    const attackAction = this.runtime.combat.attackAction;
    if (attackAction === null) return false;
    const energyAvailable = isFormationEnergyAvailable(this.formationRole, this.formationId, enemies);
    return this.runtime.combat.isActionEnabled(attackAction.id, energyAvailable);
  }

  protected override muzzlePosition(): Vec3 {
    return this.runtime.nextAttackSiteWorldPosition(this.state.r, this.att.q);
  }

  protected override plasmaDamage(): number {
    return this.runtime.combat.projectileDamage(PLASMA_BULLET_DAMAGE);
  }

  protected override muzzleEffect(muzzleState: KinematicState): void {
    this._fx.spawnMuzzleFlash(muzzleState);
  }

  // 被弾位置に最も近い機能部位へダメージを割り振る。部位の機能停止・フェーズ遷移は閃光で示す。
  protected override applyBulletDamage(damage: number, impactPoint: Vec3): void {
    const localPoint = this.runtime.localImpactPoint(impactPoint, this.state.r, this.att.q);
    const result = this.runtime.combat.applyDamage(damage, localPoint);
    if (result.siteDisabled || result.phaseChanged) {
      this._fx.spawnProteinStateFlash(
        kinematicState<'eci'>(this.state.t, impactPoint, this.state.v),
        result.phaseChanged ? result.phase : 'site-disabled',
      );
    }
  }

  // 接触は部位を選ばず integrity 全体を削る。
  protected override applyImpactDamage(damageSpeed: number): boolean {
    const damageFraction = collisionDamageFraction(damageSpeed);
    if (damageFraction <= 0) return false;
    this.runtime.combat.applyContactDamage(this.maxHp * damageFraction);
    return true;
  }

  public override serialize(): ProteinEnemySaveData {
    return {
      ...super.serialize(),
      kind: ProteinEnemy.kind,
      assetId: this.assetId,
      display: this.displaySettings,
      protein: this.runtime.combat.serialize(),
    };
  }

  public override dispose(): void {
    this.runtime.dispose();
    super.dispose();
  }
}

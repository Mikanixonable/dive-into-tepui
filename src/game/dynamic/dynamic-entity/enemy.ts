import * as THREE from 'three/webgpu';
import type { ViewMode } from '../../view/view-mode';
import { Vessel } from './vessel';
import { DynamicEntity } from './dynamic-entity';
import type { Contact } from './contact';
import type { KinematicState } from '../../../physics/kinematic-state';
import { len, sub, Vec3, v3 } from '../../../math/vec3';
import type { FlashEffects } from '../../vfx/flash-effects';
import type { Player } from '../../player/player';
import { ENTITY_GLYPH, COLOR_MARKER_ENEMY } from '../../marker/marker-identity';
import type { Quat } from '../../../math/quat';
import type { GroupedMarkerItem } from '../../marker/grouped-markers';
import type { StageOutcome } from '../../stages/stage-outcome';
import { savedKinematicState, type EnemySaveData } from '../../save/save-data';
import { MARKER_PRIORITY } from '../../marker/marker-priority';
import type { CombatTarget } from './combat-target';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { DynamicEntityKind, FormationRole } from './entity-kind';
import type { EntityRegistry, SpawnGate } from '../entity-registry';
import type { EntityIdAllocators } from './entity-id';
import type { DynamicView } from '../../../render/dynamic/dynamic-view';
import type { DynamicMotion } from '../dynamic-motion';
import { EnemyMotion, type EnemyCollisionShape } from './enemy-motion';
import { EnemyInspection } from '../../pickable/enemy-inspection';
import type { EnemyProteinInspection } from '../../pickable/enemy-inspection';
import { EnemyFireController } from './enemy-fire-controller';
import { EnemyReactions } from './enemy-reactions';
import type { ProteinDisplayController } from './enemy-display-capabilities';

// 敵機アセットの座標を物理寸法へ直す倍率。機体モデル・撃破時の破片・爆発の大きさは、
// 全ての敵がこの1つの倍率を共有する。
export const ENEMY_MODEL_SCALE = 20;

export const ENEMY_MAX_HP = 6; // 敵機の総 HP

export const PLASMA_BULLET_DAMAGE = 1.25; // 自機がプラズマ弾で被弾した際のダメージ [HP]

// 軌道物体一覧で接近中として扱う、自艦との距離 [m]。
// スナップショットからの再開。復元の腕は全具象で共通でなければならない。
export interface EnemyRestore { readonly saved: EnemySaveData; readonly simTime: number }

// 新規配置。具象ごとに固有の項目(機体テンプレート番号・タンパク質アセット)を足して使う。
export interface EnemyPlacement {
  readonly name: string;
  readonly state: KinematicState;
  readonly q: Quat;
  readonly w: Vec3;
  readonly accent: string | number;
  readonly orbitLineColor: string | number;
  readonly attackGroupId?: string;
  readonly waveId?: number;
  readonly id?: string;
  readonly formationId?: string;
  readonly formationRole?: FormationRole;
}

// 敵クラスの静的側。セーブからの復元はここから読む。
export interface EnemyClass {
  // セーブへ書く具象タグ。
  readonly kind: EnemySaveData['kind'];
  // 復元に外部資源の取得が要るなら、それが揃ったかを答える述語。要らなければ null。
  spawnGate(saved: EnemySaveData): SpawnGate | null;
  new (
    init: EnemyRestore, fx: FlashEffects, idAllocators: EntityIdAllocators, scene?: THREE.Scene,
  ): Enemy;
}

// 敵に共通するもの — 識別・色・陣形所属、バースト射撃の AI、マーカー、被弾と撃破の演出、交戦圏
// 離脱・焼失・衝突の記録。機体が何でできているか(メッシュ・被弾モデル・判定形状)は具象が持つ。
export abstract class Enemy extends Vessel implements CombatTarget {
  public override readonly mapKind: DynamicEntityKind = 'enemy';
  public override readonly pickable = true;
  public readonly inspection = new EnemyInspection(this);
  public readonly objectPickable = this.inspection;
  public get proteinInspection(): EnemyProteinInspection | null { return null; }
  public get proteinDisplayController(): ProteinDisplayController | null { return null; }

  public readonly accent: string | number; // マーカー色。攻撃グループとは独立
  public readonly orbitLineColor: string | number;
  public readonly attackGroupId: string;
  public readonly waveId?: number; // 所属するウェーブの番号。ウェーブに属さない敵は undefined
  public readonly formationId?: string;
  public readonly formationRole?: FormationRole;

  private readonly fireController: EnemyFireController;
  private readonly reactions: EnemyReactions;

  public get fireEnabled(): boolean { return this.fireController.enabled; }
  public set fireEnabled(value: boolean) { this.fireController.enabled = value; }
  public get isBursting(): boolean { return this.fireController.isBursting; }

  // 具象が組み終えた機体(スケール適用済みのメッシュ・主慣性モーメント・接触半径)を受けて、
  // 敵に共通する識別・色・陣形所属を初期化する。復元時は保存済みの生死・バースト状態も戻す。
  protected constructor(
    init: EnemyPlacement | EnemyRestore,
    view: DynamicView,
    inertia: Vec3,
    radius: number,
    protected readonly _fx: FlashEffects,
    idAllocators: EntityIdAllocators,
    shape?: EnemyCollisionShape,
  ) {
    // 復元と新規配置を同じ形へ均してから基底へ渡す。
    const placed: EnemyPlacement = 'saved' in init
      ? {
        name: init.saved.name || '',
        state: savedKinematicState(init.saved, init.simTime),
        q: { ...init.saved.q },
        w: v3(init.saved.w.x, init.saved.w.y, init.saved.w.z),
        accent: init.saved.accent,
        orbitLineColor: init.saved.orbitLineColor,
        attackGroupId: init.saved.attackGroupId
          ?? init.saved.formationId
          ?? init.saved.id
          ?? init.saved.name,
        waveId: init.saved.waveId,
        id: init.saved.id || undefined,
        formationId: init.saved.formationId,
        formationRole: init.saved.formationRole,
      }
      : init;
    const attitude = { q: placed.q, w: placed.w, inertia };
    super(
      placed.name,
      ENEMY_MAX_HP,
      owner => new EnemyMotion(placed.state, attitude, radius, {
        receiveEntityContact: (other, contact, services) => (
          (owner as Enemy).receiveEntityContact(
            other, contact, services.activeStage, services.registry,
          )
        ),
        receiveSurfaceContact: (contact, services) => (
          (owner as Enemy).receiveSurfaceContact(contact, services.activeStage, services.registry)
        ),
        receiveBurnUp: services => (
          (owner as Enemy).receiveBurnUp(services.activeStage, services.registry)
        ),
      }, shape),
      view,
      idAllocators.entity.next(placed.id),
    );
    this.accent = placed.accent;
    this.orbitLineColor = placed.orbitLineColor;
    this.attackGroupId = placed.attackGroupId ?? placed.formationId ?? this.id;
    this.waveId = placed.waveId;
    this.formationId = placed.formationId;
    this.formationRole = placed.formationRole;
    this.fireController = new EnemyFireController({
      motion: this.motion,
      attackGroupId: this.attackGroupId,
      canFire: enemies => this.canFire(enemies),
      muzzlePosition: () => this.muzzlePosition(),
      plasmaDamage: () => this.plasmaDamage(),
      muzzleEffect: muzzleState => this.muzzleEffect(muzzleState),
    });
    this.reactions = new EnemyReactions({
      motion: this.motion,
      effects: this._fx,
      modelScale: ENEMY_MODEL_SCALE,
      applyBulletDamage: (damage, impactPoint) => this.applyBulletDamage(damage, impactPoint),
      applyImpactDamage: damageSpeed => this.applyImpactDamage(damageSpeed),
      hasHealth: () => this.hp > 0,
      recordDeath: (activeStage, simTime, cause) => activeStage.recordEnemyDeath(this, simTime, cause),
    });
    if ('saved' in init) {
      this.fireController.restore(init.saved.burstLeft, init.saved.burstDelay);
      this.motion.alive = init.saved.alive;
      this.trajectoryLineVisible = init.saved.showTrajectoryLine ?? false;
    }
  }

  // 自身のクラス。復元タグはここから読む。
  public get enemyClass(): EnemyClass {
    return this.constructor as unknown as EnemyClass;
  }

  // 射撃が今できるか。enemies は同じ陣形の生存状況を見るために渡す。
  protected abstract canFire(enemies: readonly Enemy[]): boolean;
  // プラズマ弾を撃ち出す位置。
  protected abstract muzzlePosition(): Vec3;
  // プラズマ弾1発のダメージ [HP]。
  protected abstract plasmaDamage(): number;
  // 弾の被弾ダメージを当てる。撃破判定は呼び出し側が hp で行う。
  protected abstract applyBulletDamage(damage: number, impactPoint: Vec3): void;
  // 接触ダメージを当て、ダメージが発生したかを返す。しきい値未満なら false。
  protected abstract applyImpactDamage(damageSpeed: number): boolean;

  // 個体色の CSS 表記。
  public get accentColor(): string {
    if (typeof this.accent === 'string') return this.accent;
    return '#' + this.accent.toString(16).padStart(6, '0');
  }

  // 画面マーカーと被選択判定が同じ個体を指すためのキー。表示名は敵どうしで重なりうるので id から作る。
  private get markerKey(): string { return `enemy-${this.id}`; }

  // 敵のマーカー表示項目を組み立てる。pos/vel には機体メッシュと同じ表示時刻の状態
  // (stateAt 経由)を渡すこと。
  public markerItem(viewerPos: Vec3 | null, pos: Vec3, vel: Vec3, view: ViewMode): GroupedMarkerItem {
    // 代表選出の優先度は、同じ種別の中では視点に近い個体ほど高くする
    const priority = viewerPos ? MARKER_PRIORITY.ENEMY - len(sub(pos, viewerPos)) / 1e9 : MARKER_PRIORITY.ENEMY;
    return {
      key: this.markerKey,
      kind: this.mapKind,
      cls: 'mk-enemy',
      sym: view === 'map' ? this.headingHpMarkerSvg(true) : this.hpMarkerSvg(),
      pos,
      vel,
      priority,
      name: this.name,
      // 敵本体と画面外方位マーカーは同じ色で統一する。
      bearing: {
        cls: 'mk-dir mk-bearing-triangle', sym: ENTITY_GLYPH.enemyShip, color: COLOR_MARKER_ENEMY,
        visible: true, clustered: false,
      },
      color: COLOR_MARKER_ENEMY,
      symMarkup: true,
    };
  }

  private receiveEntityContact(
    other: DynamicMotion, contact: Contact, activeStage: StageOutcome, registry: EntityRegistry,
  ): void {
    this.reactions.receiveEntityContact(other, contact, activeStage, registry);
  }

  private receiveSurfaceContact(
    contact: Contact, activeStage: StageOutcome, registry: EntityRegistry,
  ): void {
    this.reactions.receiveSurfaceContact(contact, activeStage, registry);
  }

  public despawn(simTime: number, activeStage: StageOutcome): void {
    this.reactions.despawn(simTime, activeStage);
  }

  private receiveBurnUp(activeStage: StageOutcome, registry: EntityRegistry): void {
    this.reactions.receiveBurnUp(activeStage, registry);
  }

  // 行動関数。射撃の時系列は EnemyFireController が所有する。
  public behave(
    simTime: number, player: Player, registry: EntityRegistry, enemies: readonly Enemy[],
    operable: boolean, celestialBodies: CelestialBodies,
  ): void {
    this.fireController.behave(simTime, player, registry, enemies, operable, celestialBodies);
  }

  // 発砲の演出。既定は空。
  protected muzzleEffect(_muzzleState: KinematicState): void {}

  // 敵に共通する保存項目。具象の serialize() がこれへ自分の項目を足す。
  protected serializeEnemyFields(): EnemySaveData {
    const fire = this.fireController.saveState;
    return {
      id: this.id,
      name: this.name,
      kind: this.enemyClass.kind,
      r: { ...this.motion.state.r },
      v: { ...this.motion.state.v },
      q: { ...this.motion.att.q },
      w: { ...this.motion.att.w },
      alive: this.motion.alive,
      health: this.hp,
      accent: this.accent,
      orbitLineColor: this.orbitLineColor,
      attackGroupId: this.attackGroupId,
      waveId: this.waveId,
      // 陣形所属は無所属の単体敵も多いため、値がある場合だけキーを持たせる。
      ...(this.formationId === undefined ? {} : { formationId: this.formationId }),
      ...(this.formationRole === undefined ? {} : { formationRole: this.formationRole }),
      burstLeft: fire.burstLeft,
      burstDelay: fire.burstDelay,
      showTrajectoryLine: this.trajectoryLineVisible,
    };
  }

}

// entity を敵へ絞り込む型ガード。
export function isEnemy(entity: DynamicEntity): entity is Enemy {
  return entity instanceof Enemy;
}

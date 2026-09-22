import type { ViewMode } from '../../view/view-mode';
import { CombatShipEntity } from './combat-ship-entity';
import type { DynamicEntity, SerializedDynamicEntityFields } from './dynamic-entity';
import type { Contact } from './contact';
import { deserializeKinematicState, type KinematicState } from '../../../physics/kinematic-state';
import { len, sub, v3, type Vec3 } from '../../../math/vec3';
import type { ModularShip } from '../../ship/modular-ship';
import { ENTITY_GLYPH, COLOR_MARKER_ENEMY } from '../../marker/marker-identity';
import { randomQuat, type Quat } from '../../../math/quat';
import { randSym } from '../../../math/random';
import type { GroupedMarkerItem } from '../../marker/grouped-markers';
import type { StageOutcome } from '../../stages/stage-outcome';
import { MARKER_PRIORITY } from '../../marker/marker-priority';
import type { CombatTarget } from './combat-target';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { DynamicEntityKind, FormationRole } from './entity-kind';
import type { EntityRegistry } from '../entity-registry';
import type { RunEventSink } from '../../run-events';
import type { DynamicEntityClass, SerializedDynamicEntity } from './entity-dictionary';
import type { DynamicView } from '../../../render/dynamic/dynamic-view';
import type { DynamicMotionThermal } from '../dynamic-motion';
import type { EntityContactParticipant } from '../dynamic-simulation-participant';
import { EnemyMotion, type EnemyCollisionShape } from './enemy-motion';
import { EnemyInspection } from '../../pickable/enemy-inspection';
import type { EnemyProteinInspection } from '../../pickable/enemy-inspection';
import { EnemyFireController, type SerializedEnemyFireController } from './enemy-fire-controller';
import { EnemyReactions } from './enemy-reactions';

// 敵機アセットの座標を物理寸法へ直す倍率。機体モデル・撃破時の破片・爆発の大きさは、
// 全ての敵がこの1つの倍率を共有する。
export const ENEMY_MODEL_SCALE = 20;

export const ENEMY_MAX_HP = 6; // 敵機の総 HP

export const PLASMA_BULLET_DAMAGE = 1.25; // 自機がプラズマ弾で被弾した際のダメージ [HP]

// 敵に共通する直列化の項目。具象の直列化した形がこれを継ぐ。
export interface SerializedEnemy extends SerializedDynamicEntityFields {
  readonly kind: 'metal-enemy' | 'protein-enemy';
  readonly name: string;
  readonly thermal: DynamicMotionThermal;
  // マーカーに使う個体色と、軌道線の色。
  readonly accent: string | number;
  readonly orbitLineColor: string | number;
  // 表示色とは独立した、同時発砲数を共有する攻撃グループ。
  readonly attackGroupId: string;
  // 所属するウェーブの番号。ウェーブに属さない敵は null。
  readonly waveId: number | null;
  // 陣形の識別子と役割。陣形に属さない敵は null。
  readonly formationId: string | null;
  readonly formationRole: FormationRole | null;
  readonly fireController: SerializedEnemyFireController;
}

// 敵の直列化した形が取る種別タグ。
const SERIALIZED_ENEMY_KINDS: Record<SerializedEnemy['kind'], true> = { 'metal-enemy': true, 'protein-enemy': true };

// 直列化した実体が敵のものか。
export function isSerializedEnemy(serialized: SerializedDynamicEntity): boolean {
  return Object.hasOwn(SERIALIZED_ENEMY_KINDS, serialized.kind);
}

// 敵を置く識別・色・陣形所属と運動状態。具象はこれに固有の項目を足して使う。id を省くと採番器が
// 発番し、thermal を省くと環境温度から始め、attackGroupId を省くと陣形か id を攻撃グループにする。
export interface EnemyPlacement {
  readonly name: string;
  readonly state: KinematicState;
  readonly q: Quat;
  readonly w: Vec3;
  readonly thermal?: DynamicMotionThermal;
  readonly accent: string | number;
  readonly orbitLineColor: string | number;
  readonly attackGroupId?: string;
  readonly id?: string;
  // 所属するウェーブの番号。ウェーブに属さない敵は null。
  readonly waveId: number | null;
  // 陣形の識別子と役割。陣形に属さない敵は null。
  readonly formationId: string | null;
  readonly formationRole: FormationRole | null;
}

// 自由回転で漂う敵に共通の初期姿勢: ランダムな姿勢・角速度を与える。
export function driftingAttitude(): { q: Quat; w: Vec3 } {
  return { q: randomQuat(), w: v3(randSym(0.12), randSym(0.12), randSym(0.12)) };
}

// 直列化した敵に共通する項目を、配置として読む。
export function deserializeEnemyPlacement(serialized: SerializedEnemy): EnemyPlacement {
  return {
    name: serialized.name || '',
    state: deserializeKinematicState(serialized),
    q: { ...serialized.q },
    w: v3(serialized.w.x, serialized.w.y, serialized.w.z),
    thermal: serialized.thermal,
    accent: serialized.accent,
    orbitLineColor: serialized.orbitLineColor,
    // 攻撃グループの無い記録は、陣形・id・名前の順に代える
    attackGroupId: serialized.attackGroupId ?? serialized.formationId ?? serialized.id ?? serialized.name,
    id: serialized.id || undefined,
    waveId: serialized.waveId ?? null,
    formationId: serialized.formationId ?? null,
    formationRole: serialized.formationRole ?? null,
  };
}

// 敵クラスの静的側。直列化のタグを敵の種別に絞る。
export interface EnemyClass extends DynamicEntityClass {
  readonly kind: SerializedEnemy['kind'];
}

// 敵エンティティ基底クラス。識別、マーカー表示、射撃AI、被弾・撃破演出、および交戦圏離脱・消滅記録を統括する。
// メッシュや当たり判定など具体的な機体構成は派生クラスが実装する。
export abstract class Enemy extends CombatShipEntity implements CombatTarget {
  public override readonly mapKind: DynamicEntityKind = 'enemy';
  public override readonly pickable = true;
  public readonly inspection = new EnemyInspection(this);
  public readonly objectPickable = this.inspection;
  public get proteinInspection(): EnemyProteinInspection | null { return null; }

  public readonly accent: string | number; // マーカー色。攻撃グループとは独立
  public readonly orbitLineColor: string | number;
  public readonly attackGroupId: string;
  public readonly waveId: number | null; // 所属するウェーブの番号。ウェーブに属さない敵は null
  public readonly formationId: string | null;
  public readonly formationRole: FormationRole | null;

  private readonly fireController: EnemyFireController;
  private readonly reactions: EnemyReactions;

  public get isBursting(): boolean { return this.fireController.isBursting; }

  // 具象が組み終えた機体(スケール適用済みのメッシュ・主慣性モーメント・接触半径・判定形状)を
  // placement に置く。id は採番器が配った識別子。alive は生死、burstLeft から後ろは射撃の途中経過と
  // 時刻で、省けば新しく置いたときの状態で始める。
  protected constructor(
    placement: EnemyPlacement,
    view: DynamicView,
    inertia: Vec3,
    radius: number,
    id: string,
    shape: EnemyCollisionShape | null,
    alive?: boolean,
    burstLeft?: number | null,
    burstDelay?: number | null,
    lastFireSim?: number | null,
    lastBehaviorSim?: number | null,
  ) {
    // 運動の接触・焼失をこの敵へ通知させる
    const attitude = { q: placement.q, w: placement.w, inertia };
    super(
      placement.name,
      ENEMY_MAX_HP,
      owner => new EnemyMotion(placement.state, attitude, radius, {
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
      }, shape, placement.thermal, alive),
      view,
      id,
    );
    // 色と所属
    this.accent = placement.accent;
    this.orbitLineColor = placement.orbitLineColor;
    this.attackGroupId = placement.attackGroupId ?? placement.formationId ?? this.id;
    this.waveId = placement.waveId;
    this.formationId = placement.formationId;
    this.formationRole = placement.formationRole;
    // 射撃と被弾の反応は、具象の機体を読む
    this.fireController = new EnemyFireController({
      motion: this.motion,
      attackGroupId: this.attackGroupId,
      canFire: enemies => this.canFire(enemies),
      muzzlePosition: () => this.muzzlePosition(),
      plasmaDamage: () => this.plasmaDamage(),
      fired: (muzzleState, events) => this.fired(muzzleState, events),
    }, burstLeft, burstDelay, lastFireSim, lastBehaviorSim);
    this.reactions = new EnemyReactions({
      motion: this.motion,
      modelScale: ENEMY_MODEL_SCALE,
      applyBulletDamage: (damage, impactPoint, events) => (
        this.applyBulletDamage(damage, impactPoint, events)
      ),
      applyImpactDamage: damageSpeed => this.applyImpactDamage(damageSpeed),
      hasHealth: () => this.hp > 0,
      recordDeath: (activeStage, simTime, cause) => activeStage.recordEnemyDeath(this, simTime, cause),
    });
  }

  // 自身のクラス。直列化のタグはここから読む。
  public get enemyClass(): EnemyClass {
    return this.constructor as unknown as EnemyClass;
  }

  // 射撃が今できるか。enemies は同じ陣形の生存状況を見るために渡す。
  protected abstract canFire(enemies: readonly Enemy[]): boolean;
  // プラズマ弾を撃ち出す位置。
  protected abstract muzzlePosition(): Vec3;
  // プラズマ弾1発のダメージ [HP]。
  protected abstract plasmaDamage(): number;
  // 弾の被弾ダメージを HP へ適用する。撃破判定は、適用後の残 HP に基づいて別途行われる。
  protected abstract applyBulletDamage(
    damage: number, impactPoint: Vec3, events: RunEventSink,
  ): void;
  // 衝突ダメージを適用し、ダメージが発生したかを返す。しきい値未満なら false。
  protected abstract applyImpactDamage(damageSpeed: number): boolean;
  // 1発撃ったことを受ける。muzzleState は砲口の位置と機体の速度。
  protected abstract fired(muzzleState: KinematicState, events: RunEventSink): void;

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

  // 他の個体と触れたときの帰結を受ける。
  private receiveEntityContact(
    other: EntityContactParticipant, contact: Contact, activeStage: StageOutcome, registry: EntityRegistry,
  ): void {
    this.reactions.receiveEntityContact(other, contact, activeStage, registry);
  }

  // 天体の固体表面へ触れたときの帰結を受ける。
  private receiveSurfaceContact(
    contact: Contact, activeStage: StageOutcome, registry: EntityRegistry,
  ): void {
    this.reactions.receiveSurfaceContact(contact, activeStage, registry);
  }

  // 交戦圏を離れて消す。撃破によらない喪失として activeStage へ記録する。
  public despawn(simTime: number, activeStage: StageOutcome): void {
    this.reactions.despawn(simTime, activeStage);
  }

  // 大気で焼失したときの帰結を受ける。
  private receiveBurnUp(activeStage: StageOutcome, registry: EntityRegistry): void {
    this.reactions.receiveBurnUp(activeStage, registry);
  }

  // simTime に1回行動し、条件が揃えば player を狙ったプラズマ弾を registry へ加える。mayFire が偽の
  // 間は撃たない。
  public updateBehavior(
    simTime: number, player: ModularShip, registry: EntityRegistry, enemies: readonly Enemy[],
    mayFire: boolean, celestialBodies: CelestialBodies,
  ): void {
    this.fireController.updateBehavior(simTime, player, registry, enemies, mayFire, celestialBodies);
  }

  // 敵に共通する直列化の項目。具象の serialize() がこれへ自分の項目を足す。
  protected serializeEnemyFields(): SerializedEnemy {
    return {
      ...this.serializeEntityFields(this.enemyClass.kind),
      name: this.name,
      thermal: this.motion.thermal,
      // 色と所属、射撃の途中経過
      accent: this.accent,
      orbitLineColor: this.orbitLineColor,
      attackGroupId: this.attackGroupId,
      waveId: this.waveId,
      formationId: this.formationId,
      formationRole: this.formationRole,
      fireController: this.fireController.serialize(),
    };
  }
}

// entity を敵へ絞り込む型ガード。
export function isEnemy(entity: DynamicEntity): entity is Enemy {
  return entity instanceof Enemy;
}

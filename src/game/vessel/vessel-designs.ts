// 既定の設計。機体が積む部品・船体メッシュ・質量特性・能力の有無を、設計ごとに1箇所へ束ねる。
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { v3 } from '../../physics/vec3';
import { buildBaseModel, buildEnemyShip, buildPlayerShip, buildStage0EnemyShip } from '../../render/ships';
import type { AnyPart } from '../game-entity/parts';
import { baseParts, crewedParts, hostileParts } from './vessel-parts';
import type { EnemyKind } from './enemy-ai';
import { inertiaForEnemyKind } from './enemy-ai';
import type { MassProperties } from './mass-properties';
import { massPropertiesOf } from './mass-properties';

export type VesselFaction = 'ally' | 'enemy';

// 1機ぶんの設計。Vessel はこれを受け取って組み立てる。
export interface VesselDesign {
  readonly faction: VesselFaction;
  readonly renderObject: THREE.Object3D;
  readonly parts: AnyPart[];
  readonly massProperties: MassProperties;
  // 剛体接触と被弾判定に使う外接半径 [m]。
  readonly radius: number;
  // 自然回復速度 [HP/s]。0 なら回復しない。
  readonly hpRegenRate: number;
  // 大気圏突入・地表到達の判定に足す高度の余裕 [m]。
  readonly reentryAltMargin: number;
  // 砲と給弾ベルトを積むか。
  readonly gunnery: boolean;
  // 熱・放熱・電力の収支を持つか。
  readonly lifeSupport: boolean;
  // 主機プルームと RCS パフの倍率。0 なら演出を出さない。
  readonly maneuverEffectScale: number;
  // 操作対象になったとき、軌道座標系の方向マーカーと照準を出すか。
  readonly directionMarkers: boolean;
}

// 有人の艦艇。コックピットと主機と砲を積み、熱・電力の収支を自前で持つ。
export function crewedShipDesign(): VesselDesign {
  return {
    faction: 'ally',
    renderObject: buildPlayerShip(),
    parts: crewedParts(C.PLAYER_MAX_HP),
    massProperties: massPropertiesOf(
      C.PLAYER_MASS, v3(C.PLAYER_INERTIA_PITCH, C.PLAYER_INERTIA_YAW, C.PLAYER_INERTIA_ROLL)),
    radius: C.PLAYER_HULL_RADIUS,
    hpRegenRate: C.HP_REGEN_RATE,
    reentryAltMargin: C.PLAYER_MIN_ALT,
    gunnery: true,
    lifeSupport: true,
    maneuverEffectScale: 1,
    directionMarkers: true,
  };
}

// 軌道基地。基地モジュールと管制室を積む。砲も熱収支も持たない。
export function orbitalBaseDesign(): VesselDesign {
  return {
    faction: 'ally',
    renderObject: buildBaseModel(),
    parts: baseParts(C.BASE_MAX_HP),
    massProperties: massPropertiesOf(3e6, v3(C.BASE_INERTIA_X, C.BASE_INERTIA_Y, C.BASE_INERTIA_Z)),
    radius: 330,
    hpRegenRate: 0,
    reentryAltMargin: C.PLAYER_MIN_ALT,
    gunnery: false,
    lifeSupport: false,
    maneuverEffectScale: 6,
    directionMarkers: false,
  };
}

// 敵対勢力の機体。見た目のスケールが大きいので、当たり半径はメッシュの外接球から取る。
export function hostileShipDesign(enemyKind: EnemyKind, accent: string | number): VesselDesign {
  const renderObject = enemyKind.kind === 'stage0'
    ? buildStage0EnemyShip(accent, enemyKind.typeIndex)
    : buildEnemyShip(accent);
  renderObject.scale.setScalar(C.ENEMY_SCALE);
  const bounds = new THREE.Box3().setFromObject(renderObject);
  return {
    faction: 'enemy',
    renderObject,
    parts: hostileParts(C.ENEMY_MAX_HP),
    massProperties: massPropertiesOf(10000, inertiaForEnemyKind(enemyKind)),
    radius: bounds.getBoundingSphere(new THREE.Sphere()).radius,
    hpRegenRate: 0,
    reentryAltMargin: C.REENTRY_ALT,
    gunnery: false,
    lifeSupport: false,
    maneuverEffectScale: 0,
    directionMarkers: false,
  };
}

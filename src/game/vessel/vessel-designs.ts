// 既定の設計。機体が積む部品・船体メッシュ・質量特性を1箇所で束ねる。搭載要素の一覧そのものは
// これから置き換わっていくので、ここは「どの設計が何を積むか」だけを述べる。
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { v3 } from '../../physics/vec3';
import { buildBaseModel, buildEnemyShip, buildPlayerShip, buildStage0EnemyShip } from '../../render/ships';
import type { AnyPart, PartType } from '../game-entity/parts';
import { createPart } from '../game-entity/parts';
import { createDefaultBaseModule } from './base-module';
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

// 既定パーツへの HP 配分比。合計 1 になるよう保つ(機体の maxHp をこの比で割り振る)。
// 放熱板・太陽電池パドルは機体の左右2枚ぶんなので、パーツも side ごとに1枚ずつ持つ。
const CREWED_HP_RATIO = {
  hull: 0.40, cockpit: 0.10, thruster: 0.08, rcsTank: 0.08,
  radiator: 0.05, solarPanel: 0.03, weapon: 0.08, armor: 0.10,
} as const;

// maxHp を CREWED_HP_RATIO で割り振った、有人機の既定の搭載要素一式。
function crewedParts(maxHp: number): AnyPart[] {
  const R = CREWED_HP_RATIO;
  const share = (ratio: number): number => Math.max(1, Math.round(maxHp * ratio));
  const mk = <T extends PartType>(type: T, ratio: number, props: object): AnyPart =>
    createPart(type, { maxHp: share(ratio), hp: share(ratio), ...props } as never);
  return [
    mk('hull', R.hull, { name: 'Basic Hull' }),
    mk('cockpit', R.cockpit, { name: 'Cockpit' }),
    mk('thruster', R.thruster, {
      name: 'Standard RCS',
      torque: C.MAX_ANG_ACCEL * Math.max(C.PLAYER_INERTIA_PITCH, C.PLAYER_INERTIA_YAW, C.PLAYER_INERTIA_ROLL),
      // 既定パーツだけを積んだ機体が、全開で THROTTLE_LEVELS の最大値の加速度になる推力。
      thrust: C.PLAYER_MASS * C.THROTTLE_LEVELS[C.THROTTLE_LEVELS.length - 1]!,
      fuelConsumptionRate: 1,
    }),
    mk('rcs_tank', R.rcsTank, { name: 'Main RCS Tank', maxFuel: 1000, fuel: 1000 }),
    mk('radiator', R.radiator, { name: 'Heat Radiator L', coolingRate: 25 }),
    mk('radiator', R.radiator, { name: 'Heat Radiator R', coolingRate: 25 }),
    mk('solar_panel', R.solarPanel, { name: 'Solar Array L', powerGeneration: 50 }),
    mk('solar_panel', R.solarPanel, { name: 'Solar Array R', powerGeneration: 50 }),
    mk('weapon', R.weapon, {
      name: 'Gatling Gun', weaponType: 'gatling',
      fireRate: 1 / C.FIRE_INTERVAL, damage: C.ENEMY_BULLET_DAMAGE, muzzleVelocity: C.MUZZLE_SPEED,
    }),
    mk('armor', R.armor, { name: 'Light Armor', damageReduction: 0.2 }),
  ];
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
  const module = createDefaultBaseModule(Math.round(C.BASE_MAX_HP * 0.5));
  const rest = Math.round(C.BASE_MAX_HP * 0.5);
  return {
    faction: 'ally',
    renderObject: buildBaseModel(),
    parts: [
      module,
      createPart('cockpit', { name: 'Control Room', maxHp: rest, hp: rest }),
      createPart('thruster', {
        name: 'Station Keeping Thruster', maxHp: 1, hp: 1,
        torque: C.BASE_TORQUE, thrust: C.BASE_THRUST, fuelConsumptionRate: C.BASE_FUEL_RATE,
      }),
      createPart('rcs_tank', { name: 'Station Tank', maxHp: 1, hp: 1, maxFuel: C.BASE_MAX_FUEL, fuel: C.BASE_MAX_FUEL }),
    ],
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
    parts: crewedParts(C.ENEMY_MAX_HP),
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

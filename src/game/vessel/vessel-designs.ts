// 既定の設計。機体が積む部品・船体メッシュ・質量特性・能力の有無を、設計ごとに1箇所へ束ねる。
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { v3 } from '../../physics/vec3';
import { buildBaseModel, buildEnemyShip, buildPlayerShip, buildStage0EnemyShip } from '../../render/ships';
import type { AnyPart } from '../game-entity/parts';
import { hostileParts, tuneActuators } from './vessel-parts';
import type { EnemyKind } from './enemy-ai';
import { inertiaForEnemyKind } from './enemy-ai';
import { principalMoments } from '../../physics/inertia-tensor';
import type { VesselAssembly } from './assembly';
import { crewedAssembly, orbitalBaseAssembly } from './vessel-assemblies';
import type { MassProperties } from './mass-properties';
import { deriveMassProperties, massPropertiesFrom, massPropertiesOf } from './mass-properties';

export type VesselFaction = 'ally' | 'enemy';

// 1機ぶんの設計。Vessel はこれを受け取って組み立てる。
export interface VesselDesign {
  readonly faction: VesselFaction;
  readonly renderObject: THREE.Object3D;
  // 形状ツリーと搭載要素の配置。質量特性を直接与えられた機体(§5-3)では null。
  readonly assembly: VesselAssembly | null;
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

// アセンブリから質量特性を導き、搭載要素一式と併せて返す。部品は配置されたものそのものなので、
// 設計が持つ一覧と形状が持つ一覧は同じ実体である。
function derivedFrom(assembly: VesselAssembly): { parts: AnyPart[]; massProperties: MassProperties } {
  return {
    parts: assembly.placements.map((placement) => placement.part),
    massProperties: massPropertiesFrom(deriveMassProperties(assembly)),
  };
}

// 有人の艦艇。コックピットと主機と砲を積み、熱・電力の収支を自前で持つ。
export function crewedShipDesign(): VesselDesign {
  const assembly = crewedAssembly(C.PLAYER_MAX_HP);
  return {
    faction: 'ally',
    renderObject: buildPlayerShip(),
    assembly,
    ...derivedFrom(assembly),
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
  const assembly = orbitalBaseAssembly(C.BASE_MAX_HP);
  return {
    faction: 'ally',
    renderObject: buildBaseModel(),
    assembly,
    ...derivedFrom(assembly),
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
  // 形状ツリーを持たない設計でも、アクチュエータの性能は質量特性から導く。形状から導く経路と
  // 揃えないと、フライホイールの最大トルクが単位の合わない定数のまま残る。
  const massProperties = massPropertiesOf(10000, inertiaForEnemyKind(enemyKind), v3(15, 15, 15));
  const parts = hostileParts(C.ENEMY_MAX_HP);
  tuneActuators(parts, massProperties.mass, principalMoments(massProperties.inertia).z);
  return {
    faction: 'enemy',
    renderObject,
    assembly: null,
    parts,
    massProperties,
    radius: bounds.getBoundingSphere(new THREE.Sphere()).radius,
    hpRegenRate: 0,
    reentryAltMargin: C.REENTRY_ALT,
    gunnery: false,
    lifeSupport: false,
    maneuverEffectScale: 0,
    directionMarkers: false,
  };
}

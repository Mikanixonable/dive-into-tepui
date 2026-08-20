// 既定の設計。機体が積む部品・船体メッシュ・質量特性・能力の有無を、設計ごとに1箇所へ束ねる。
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { v3 } from '../../physics/vec3';
import { buildEnemyShip, buildStage0EnemyShip } from '../../render/ships';
import { AssemblyRenderObject } from './assembly-render-object';
import { partFromSaveData, type AnyPart, type BaseModulePart, type PartType } from '../game-entity/parts';
import { hostileParts, tuneActuators } from './vessel-parts';
import type { EnemyKind } from './enemy-ai';
import { inertiaForEnemyKind } from './enemy-ai';
import { principalMoments } from '../../physics/inertia-tensor';
import type { VesselAssembly } from './assembly';
import { assemblyOf, type VesselBlueprint } from './blueprint';
import { circumradius } from './tree';
import { len } from '../../physics/vec3';
import { crewedAssembly, orbitalBaseAssembly } from './vessel-assemblies';
import type { MassProperties } from './mass-properties';
import { deriveMassProperties, massPropertiesFrom, massPropertiesOf, propellantStoreOf } from './mass-properties';
import { isAssemblySaveData } from '../save-data';

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
    massProperties: massPropertiesFrom(deriveMassProperties(assembly, propellantStoreOf(assembly))),
  };
}

// 有人の艦艇。コックピットと主機と砲を積み、熱・電力の収支を自前で持つ。
export function crewedShipDesign(): VesselDesign {
  const assembly = crewedAssembly(C.PLAYER_MAX_HP);
  return {
    faction: 'ally',
    renderObject: new AssemblyRenderObject(assembly).object,
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

// 保存 JSON の部品を runtime の Part へ戻す際に許可する判別子。未知の部品種別を createPart へ渡すと
// 既定値表を引けず、壊れた設計がその後の質量・描画計算で例外になるため、ここで拒否する。
const SAVED_PART_TYPES: ReadonlySet<PartType> = new Set([
  'hull', 'armor', 'weapon', 'engine', 'rcs_thruster', 'solar_panel', 'radiator',
  'combat_shield', 'heat_shield', 'communication', 'robot_arm', 'docking_port', 'container_coupling',
  'oxidizer_tank', 'reductant_tank', 'pressurant_tank', 'rcs_tank', 'water_tank',
  'battery', 'fuel_cell', 'rtg', 'cockpit', 'autopilot', 'magazine', 'ammunition',
  'plumbing', 'payload_bay', 'flywheel', 'magnetorquer', 'base_module', 'farm', 'life_support', 'dock',
]);

function validDockPort(value: unknown): value is { localPos: { x: number; y: number; z: number }; localNormal: { x: number; y: number; z: number } } {
  if (typeof value !== 'object' || value === null) return false;
  const port = value as { localPos?: unknown; localNormal?: unknown };
  const isVec3 = (v: unknown): boolean => {
    if (typeof v !== 'object' || v === null) return false;
    const vec = v as { x?: unknown; y?: unknown; z?: unknown };
    return typeof vec.x === 'number' && Number.isFinite(vec.x)
      && typeof vec.y === 'number' && Number.isFinite(vec.y)
      && typeof vec.z === 'number' && Number.isFinite(vec.z);
  };
  return isVec3(port.localPos) && isVec3(port.localNormal);
}

// 基地保存の assembly を、部品 id を保った runtime assembly へ変換する。失敗時は null を返し、呼び出し
// 側が既定基地へ戻せるようにする。Three.js の参照はここでも生成せず、入力は純粋な値だけである。
export function baseAssemblyFromSaveData(value: unknown): VesselAssembly | null {
  if (!isAssemblySaveData(value) || value.tree.nodes.length === 0) return null;
  const partIds = new Set<string>();
  try {
    const placements = value.placements.map((placement) => {
      if (!SAVED_PART_TYPES.has(placement.part.type)) throw new Error(`unknown part type ${placement.part.type}`);
      if (partIds.has(placement.part.id)) throw new Error(`duplicate part id ${placement.part.id}`);
      partIds.add(placement.part.id);
      const part = partFromSaveData(placement.part);
      if (placement.kind === 'external') return { ...placement, part };
      return { ...placement, part };
    });

    const baseModules = placements
      .map((placement) => placement.part)
      .filter((part): part is BaseModulePart => part.type === 'base_module' && part.hp > 0);
    if (baseModules.length === 0) return null;
    for (const module of baseModules) {
      if (!Number.isInteger(module.capacity) || module.capacity < 0
        || !Array.isArray(module.dockSlots) || !validDockPort(module.hatch)
        || module.dockSlots.some((slot) => !validDockPort(slot))) return null;
    }
    return { tree: value.tree, placements };
  } catch {
    return null;
  }
}

// 軌道基地。基地モジュールと管制室を積む。砲も熱収支も持たない。
export function orbitalBaseDesign(customAssembly?: VesselAssembly): VesselDesign {
  const assembly = customAssembly ?? orbitalBaseAssembly(C.BASE_MAX_HP);
  return {
    faction: 'ally',
    // Bases use the same assembly-driven renderer as ships.  Their fixed legacy
    // model remains available for older callers, but new base instances must
    // expose the individual assembly parts to the dock workbench.
    renderObject: new AssemblyRenderObject(assembly).object,
    assembly,
    ...derivedFrom(assembly),
    // 既存の基地衝突 LOD が持つ外接半径を下限にし、カスタム形状が大きくなった場合だけ拡張する。
    radius: Math.max(330, hullRadiusOf(assembly)),
    hpRegenRate: 0,
    reentryAltMargin: C.PLAYER_MIN_ALT,
    gunnery: false,
    lifeSupport: false,
    maneuverEffectScale: 6,
    directionMarkers: false,
  };
}

// 形状ツリーの外接半径 [m]。各ノードが自分の断面の外接円ぶんの広がりを持つ。
function hullRadiusOf(assembly: VesselAssembly): number {
  let radius = 0;
  for (const node of assembly.tree.nodes) {
    radius = Math.max(radius, len(node.pos) + circumradius(node.section));
  }
  return radius;
}

// 保存された設計から組む機体。積んでいる搭載要素が、そのまま積む系を決める。
export function blueprintDesign(bp: VesselBlueprint): VesselDesign {
  const assembly = assemblyOf(bp);
  const parts = assembly.placements.map((placement) => placement.part);
  const massProperties = massPropertiesFrom(deriveMassProperties(assembly, propellantStoreOf(assembly)));
  tuneActuators(parts, massProperties.mass, principalMoments(massProperties.inertia).z);
  return {
    faction: 'ally',
    renderObject: new AssemblyRenderObject(assembly).object,
    assembly,
    parts,
    massProperties,
    radius: hullRadiusOf(assembly),
    hpRegenRate: C.HP_REGEN_RATE,
    reentryAltMargin: C.PLAYER_MIN_ALT,
    gunnery: parts.some((part) => part.type === 'weapon'),
    lifeSupport: parts.some((part) => part.type === 'radiator'),
    maneuverEffectScale: 1,
    directionMarkers: parts.some((part) => part.type === 'cockpit'),
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

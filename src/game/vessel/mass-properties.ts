// 機体の質量特性。形状から導出するか、直接与えられるかのどちらかで決まる。
import { Vec3, add, dot, scale, sub, v3 } from '../../physics/vec3';
import type { InertiaTensor } from '../../physics/inertia-tensor';
import {
  ZERO_INERTIA, addInertia, diagonalInertia, rotateInertia, scaleInertia, translateInertia,
} from '../../physics/inertia-tensor';
import { loftCenterOfMass, loftInertia, loftProjectedArea, loftVolume } from '../../physics/hull-loft';
import { scaleCrossSection, sectionMoments } from '../../physics/section-moments';
import type { CrossSection } from '../../physics/section-moments';
import type { AnyPart } from '../game-entity/parts';
import type { PartPlacement, VesselAssembly } from './assembly';
import type { MountFrame, TreeEdge, VesselTree } from './tree';
import { circumradius, edgeFrame, inradius, mountFrame, nodeById } from './tree';
import type { InternalPlacement } from './internal-volume';
import { allocateInternalVolume } from './internal-volume';
import type { StructuralMaterial, StructuralMaterialId } from './hull-structure';
import {
  CABIN_PRESSURE, STRUCTURAL_MATERIALS, decouplerMass, trussLinearDensity, wallThickness,
} from './hull-structure';

export interface MassProperties {
  // 質量 [kg]。剛体接触の換算質量であり、推力から加速度を出す分母でもある。
  readonly mass: number;
  // 機体座標系での重心位置 [m]。
  readonly centerOfMass: Vec3;
  // 重心まわりの慣性テンソル [kg·m²]。3軸が非対称なら中間軸不安定性が現れる。
  readonly inertia: InertiaTensor;
  // 機体座標系の主軸3方向から見た投影面積 [m²]。抗力と輻射圧の断面積がここから決まる(§11-2)。
  // 展開できる外装要素は完全に展開した状態で数えてある。
  readonly principalAreas: Vec3;
  // そのうち、畳めば失われる分 [m²]。実行時の展開度を掛けて principalAreas から差し引くのは
  // 展開度を持つ側(Vessel)の仕事で、設計から導くこの値は姿勢にも運用にも依存しない。
  readonly deployableAreas: Vec3;
}

// 主慣性モーメントと投影面積を直接与えて、重心を原点に置いた質量特性を組む(§5-3)。
export function massPropertiesOf(mass: number, moments: Vec3, principalAreas: Vec3): MassProperties {
  return {
    mass, centerOfMass: v3(), inertia: diagonalInertia(moments), principalAreas, deployableAreas: v3(),
  };
}

// 形状から導いた値を、機体が持つ質量特性に直す。積んでいる推進剤も込みの総質量を採る。
export function massPropertiesFrom(derived: DerivedMassProperties): MassProperties {
  return {
    mass: derived.loadedMass,
    centerOfMass: derived.centerOfMass,
    inertia: derived.inertia,
    principalAreas: derived.principalAreas,
    deployableAreas: derived.deployableAreas,
  };
}

// 形状から導いた質量特性(§10-4)。慣性テンソルは重心まわりで、慣性乗積を含む。
export interface DerivedMassProperties {
  readonly dryMass: number; // 構造 + 搭載要素の乾燥質量 [kg]
  readonly loadedMass: number; // 推進剤と貨物を含む総質量 [kg]
  readonly centerOfMass: Vec3; // 船体ローカル座標
  readonly inertia: InertiaTensor; // 重心まわり
  readonly principalAreas: Vec3; // 主軸3方向の投影面積 [m²]。展開できる外装は展開した状態で数える
  readonly deployableAreas: Vec3; // そのうち畳めば失われる分 [m²]
}

// 搭載要素の id から、それが収める推進剤の質量 [kg] を引く表。
export type PropellantStore = ReadonlyMap<string, number>;

// 剛体を部分に分けて足し上げる累積器。慣性テンソルは船体ローカル座標の原点まわりで持ち、重心へ移すのは
// 最後に1回だけ行う — 各部分の重心まわりで足そうとすると、部分ごとに違う点まわりの値を混ぜてしまう。
interface Accumulator {
  mass: number;
  moment: Vec3; // Σ m·r
  inertia: InertiaTensor; // 原点まわり
}

function addPart(into: Accumulator, mass: number, center: Vec3, inertiaAboutCenter: InertiaTensor): void {
  if (!(mass > 0)) return;
  into.mass += mass;
  into.moment = add(into.moment, scale(center, mass));
  into.inertia = addInertia(into.inertia, translateInertia(inertiaAboutCenter, mass, center));
}

// アセンブリの乾燥質量・重心・重心まわりの慣性テンソル・主軸3方向の投影面積を導く。
// 構造は外皮の肉厚から、搭載要素はそれぞれの取り付け位置に置いた質点から、推進剤はそれを収める
// エッジの内容積の重心から寄与する。閉路のある構造でも、質量はエッジごとに1度だけ数えられる。
export function deriveMassProperties(
  assembly: VesselAssembly,
  propellant: PropellantStore = new Map(),
): DerivedMassProperties {
  const { tree, placements } = assembly;
  const internals = internalPlacements(placements);
  const allocations = allocateInternalVolume(tree, internals);
  const centroidByPartId = new Map(allocations.map((a) => [a.partId, a.centroid]));

  const accumulator: Accumulator = { mass: 0, moment: v3(), inertia: ZERO_INERTIA };
  const projections: EdgeProjection[] = [];

  // エッジは配列を1度だけ走るので、閉路があっても同じエッジが二度数えられることはない。
  for (const edge of tree.edges) {
    const frame = edgeFrame(tree, edge);
    if (edge.kind.kind === 'hull') {
      addHullShell(accumulator, tree, edge, frame, edgeMaterial(edge, internals), edgePressure(edge, internals));
      projections.push({
        axis: frame.z,
        areas: hullProjectedAreas(tree, edge, frame),
        center: midpointOf(frame, edge.length),
        extent: Math.max(circumradius(nodeById(tree, edge.a).section), circumradius(nodeById(tree, edge.b).section)),
      });
    } else if (edge.kind.kind === 'truss') {
      addTruss(accumulator, edge, edge.kind.sectionSize, frame);
      projections.push({
        axis: frame.z,
        areas: boxProjectedAreas(edge.kind.sectionSize, edge.length, frame),
        center: midpointOf(frame, edge.length),
        extent: edge.kind.sectionSize / 2,
      });
    } else {
      const area = sectionMoments(nodeById(tree, edge.a).section).area;
      addPart(accumulator, decouplerMass(area), midpointOf(frame, edge.length), ZERO_INERTIA);
    }
  }

  const plates: PlateProjection[] = [];
  for (const placement of placements) {
    addPart(accumulator, placement.part.weight, placementCenter(tree, placement, centroidByPartId), ZERO_INERTIA);
    const plate = externalPlate(tree, placement);
    if (plate) plates.push(plate);
  }

  const dryMass = accumulator.mass;
  for (const [partId, mass] of propellant) {
    const center = centroidByPartId.get(partId);
    if (!center) throw new Error(`propellant is stored in unplaced part "${partId}"`);
    addPart(accumulator, mass, center, ZERO_INERTIA);
  }

  const loadedMass = accumulator.mass;
  if (!(loadedMass > 0)) throw new Error('vessel assembly has no mass');
  const centerOfMass = scale(accumulator.moment, 1 / loadedMass);
  return {
    dryMass,
    loadedMass,
    centerOfMass,
    // 原点まわりの値を重心まわりへ戻す。平行軸の項を引くので質量の符号を反転させる。
    inertia: translateInertia(accumulator.inertia, -loadedMass, centerOfMass),
    principalAreas: combineProjectedAreas(projections, plates),
    deployableAreas: plateAreas(plates.filter((plate) => plate.deployable)),
  };
}

function internalPlacements(placements: readonly PartPlacement[]): readonly InternalPlacement[] {
  return placements
    .filter((p): p is Extract<PartPlacement, { kind: 'internal' }> => p.kind === 'internal')
    .map((p) => ({ part: p.part, edgeIds: p.edgeIds }));
}

function placementCenter(
  tree: VesselTree,
  placement: PartPlacement,
  centroidByPartId: ReadonlyMap<string, Vec3>,
): Vec3 {
  if (placement.kind === 'external') return mountFrame(tree, placement.mount).origin;
  const centroid = centroidByPartId.get(placement.part.id);
  if (!centroid) throw new Error(`part "${placement.part.id}" has no allocated volume`);
  return centroid;
}

// エッジの局所座標で表した点を船体ローカル座標へ移す。
function toHull(frame: MountFrame, local: Vec3): Vec3 {
  return add(
    frame.origin,
    add(add(scale(frame.x, local.x), scale(frame.y, local.y)), scale(frame.z, local.z)),
  );
}

function midpointOf(frame: MountFrame, length: number): Vec3 {
  return add(frame.origin, scale(frame.z, length / 2));
}

// エッジを収める区画の構造材。タンクが指定した材料に従い、指定のない区画はアルミ合金とする。
function edgeMaterial(edge: TreeEdge, internals: readonly InternalPlacement[]): StructuralMaterial {
  for (const placement of internals) {
    if (!placement.edgeIds.includes(edge.id)) continue;
    const { part } = placement;
    if (part.type === 'oxidizer_tank' || part.type === 'reductant_tank' || part.type === 'rcs_tank') {
      const material = STRUCTURAL_MATERIALS[part.material as StructuralMaterialId];
      if (material) return material;
    }
  }
  return STRUCTURAL_MATERIALS.aluminium;
}

// エッジを収める区画の内圧 [Pa]。収めた内装要素のうち最も高い内圧を要求するものが決める。
function edgePressure(edge: TreeEdge, internals: readonly InternalPlacement[]): number {
  let pressure = 0;
  for (const placement of internals) {
    if (!placement.edgeIds.includes(edge.id)) continue;
    pressure = Math.max(pressure, partPressure(placement.part));
  }
  return pressure;
}

function partPressure(part: AnyPart): number {
  switch (part.type) {
    case 'oxidizer_tank':
    case 'reductant_tank':
      return part.requiredPressure * 1e6;
    case 'pressurant_tank':
      return part.maxPressure * 1e6;
    case 'cockpit':
      return CABIN_PRESSURE;
    default:
      return 0;
  }
}

// 外皮の殻を、外側の立体から肉厚のぶん縮めた内側の立体を引いた差として足す。薄肉の極限で、質量は
// §10-3 の「側面積 × 肉厚 × 密度」に一致する。
function addHullShell(
  into: Accumulator,
  tree: VesselTree,
  edge: TreeEdge,
  frame: MountFrame,
  material: StructuralMaterial,
  pressure: number,
): void {
  const sectionA = nodeById(tree, edge.a).section;
  const sectionB = nodeById(tree, edge.b).section;
  const radius = Math.max(circumradius(sectionA), circumradius(sectionB));
  const thickness = wallThickness(pressure, radius, material);
  // 相似変形で内側の立体を作るので、縮小率は面に垂直な厚みが肉厚に等しくなる内接円半径で測る。
  // 外接円の側では肉厚がその比のぶん厚くなるが、要求を下回る面は生じない。
  const inner = Math.min(inradius(sectionA), inradius(sectionB));
  const shrink = Math.max(0, 1 - thickness / inner);
  const outer = solidOf(sectionA, sectionB, edge.length, material.density, frame);
  const cavity = shrink > 0
    ? solidOf(scaleCrossSection(sectionA, shrink), scaleCrossSection(sectionB, shrink),
      edge.length, material.density, frame)
    : { mass: 0, center: v3(), inertiaAboutOrigin: ZERO_INERTIA };

  const mass = outer.mass - cavity.mass;
  if (!(mass > 0)) return;
  const center = scale(sub(scale(outer.center, outer.mass), scale(cavity.center, cavity.mass)), 1 / mass);
  const aboutOrigin = addInertia(outer.inertiaAboutOrigin, scaleInertia(cavity.inertiaAboutOrigin, -1));
  addPart(into, mass, center, translateInertia(aboutOrigin, -mass, center));
}

// 一様な密度のロフト立体の、質量・船体ローカル座標での重心・船体ローカル原点まわりの慣性テンソル。
function solidOf(
  sectionA: CrossSection,
  sectionB: CrossSection,
  length: number,
  density: number,
  frame: MountFrame,
): { mass: number; center: Vec3; inertiaAboutOrigin: InertiaTensor } {
  const mass = density * loftVolume(sectionA, sectionB, length);
  const center = toHull(frame, loftCenterOfMass(sectionA, sectionB, length));
  const local = loftInertia(sectionA, sectionB, length, density);
  const aboutCenter = rotateInertia(local, frame.x, frame.y, frame.z);
  return { mass, center, inertiaAboutOrigin: translateInertia(aboutCenter, mass, center) };
}

// トラスを、断面の大きさと長さから求めた等価な細い角管として足す(§10-2)。
function addTruss(into: Accumulator, edge: TreeEdge, sectionSize: number, frame: MountFrame): void {
  const mass = trussLinearDensity(sectionSize, STRUCTURAL_MATERIALS.aluminium) * edge.length;
  const s2 = sectionSize * sectionSize;
  const transverse = (mass * (edge.length * edge.length + s2)) / 12;
  const local: InertiaTensor = {
    ixx: transverse, iyy: transverse, izz: (mass * s2) / 6, ixy: 0, ixz: 0, iyz: 0,
  };
  addPart(into, mass, midpointOf(frame, edge.length), rotateInertia(local, frame.x, frame.y, frame.z));
}

// エッジ1本ぶんの投影面積と、その像がどの向きから見て他と重なるかを決めるエッジ軸。
interface EdgeProjection {
  readonly axis: Vec3; // 船体ローカルでのエッジの軸方向(単位ベクトル)
  readonly areas: Vec3; // 主軸3方向から見た面積 [m²]
  readonly center: Vec3; // エッジの中点(船体ローカル)
  readonly extent: number; // 軸に垂直な向きの半径 [m]。像が横に重なるかの判定に使う
}

// 外装要素を、取り付け面の法線を持つ平板として表す。平板の投影面積は面積 × |法線·視線| で厳密。
interface PlateProjection {
  readonly normal: Vec3;
  readonly area: number;
  readonly deployable: boolean; // 実行時に畳めるか
}

// 評価方向とエッジ軸の内積がこの値以上なら、そのエッジの像は他の平行なエッジの像と重なりうるとみなす。
const PROJECTION_OVERLAP_COS = Math.SQRT1_2;

// エッジごとの投影面積と外装要素の平板を、主軸3方向それぞれの投影面積 [m²] へまとめる。
function combineProjectedAreas(
  projections: readonly EdgeProjection[], plates: readonly PlateProjection[],
): Vec3 {
  return v3(
    combineAlong(projections, plates, v3(1, 0, 0), (areas) => areas.x),
    combineAlong(projections, plates, v3(0, 1, 0), (areas) => areas.y),
    combineAlong(projections, plates, v3(0, 0, 1), (areas) => areas.z),
  );
}

// 1方向ぶんの畳み込み。投影面積は像の合併であって和ではないので、その向きから見て前後に重なる
// エッジ同士は足さずに最大値を採る。重なるのは「軸が視線と平行に近く」かつ「視線に垂直な面へ
// 落とした足跡が触れ合う」組に限る — 平行でも横へずれて並ぶ2本(左右へ伸びるブームなど)は
// 重ならないので和になる。足跡は中点を中心とする半径 extent の円として近似し、円が触れ合う
// ものを1つの束にまとめて束ごとに最大値を採り、束の間は足す。
// 外装要素の平板は、像の重なりを見ずにすべて足す — 平板は取り付け面から張り出しており、
// 船体の像に隠れる部分は張り出しに比べて小さい。
function combineAlong(
  projections: readonly EdgeProjection[],
  plates: readonly PlateProjection[],
  axis: Vec3,
  areaOf: (areas: Vec3) => number,
): number {
  const parallel: EdgeProjection[] = [];
  let total = 0;
  for (const projection of projections) {
    if (Math.abs(dot(projection.axis, axis)) >= PROJECTION_OVERLAP_COS) parallel.push(projection);
    else total += areaOf(projection.areas);
  }
  for (const group of groupByFootprint(parallel, axis)) {
    let maximum = 0;
    for (const projection of group) maximum = Math.max(maximum, areaOf(projection.areas));
    total += maximum;
  }
  for (const plate of plates) total += plate.area * Math.abs(dot(plate.normal, axis));
  return total;
}

// 足跡が触れ合うエッジ同士を1つの束にまとめる。触れ合う関係は推移的に扱う — 3本が数珠つなぎに
// 重なるとき、両端の2本が直接は触れていなくても像は1つながりになる。
function groupByFootprint(
  projections: readonly EdgeProjection[], axis: Vec3,
): readonly (readonly EdgeProjection[])[] {
  const groups: EdgeProjection[][] = [];
  for (const projection of projections) {
    const joined = groups.filter((group) => group.some((other) => footprintsTouch(projection, other, axis)));
    const merged = joined.length > 0 ? joined[0]! : [];
    if (joined.length === 0) groups.push(merged);
    merged.push(projection);
    for (const extra of joined.slice(1)) {
      merged.push(...extra);
      groups.splice(groups.indexOf(extra), 1);
    }
  }
  return groups;
}

// 視線に垂直な面へ落とした2つの足跡(中点を中心とする半径 extent の円)が触れ合うか。
function footprintsTouch(x: EdgeProjection, y: EdgeProjection, axis: Vec3): boolean {
  const delta = sub(y.center, x.center);
  const lateral = sub(delta, scale(axis, dot(delta, axis)));
  return Math.sqrt(dot(lateral, lateral)) < x.extent + y.extent;
}

// 平板だけを主軸3方向へ畳んだ面積 [m²]。
function plateAreas(plates: readonly PlateProjection[]): Vec3 {
  const along = (axis: Vec3): number =>
    plates.reduce((sum, plate) => sum + plate.area * Math.abs(dot(plate.normal, axis)), 0);
  return v3(along(v3(1, 0, 0)), along(v3(0, 1, 0)), along(v3(0, 0, 1)));
}

// 外装要素の平板。放熱板と太陽電池パドルは自分の面積を、熱シールドは覆う接続口の断面積を持つ。
// 面の向きは取り付け面の外向き法線とする。展開状態はここでは読まず、完全に展開した張り出しを採る。
// 畳めるのは放熱板だけとする — 太陽電池パドルは deployable を立てているが展開度を持つ系が無く、
// 実行時に畳む手段が存在しない。
function externalPlate(tree: VesselTree, placement: PartPlacement): PlateProjection | null {
  if (placement.kind !== 'external') return null;
  const { part } = placement;
  const normal = mountFrame(tree, placement.mount).z;
  if (part.type === 'solar_panel' || part.type === 'radiator') {
    return part.area > 0 ? { normal, area: part.area, deployable: part.type === 'radiator' } : null;
  }
  if (part.type === 'heat_shield' && placement.mount.kind === 'port') {
    const area = sectionMoments(nodeById(tree, placement.mount.nodeId).section).area;
    return area > 0 ? { normal, area, deployable: false } : null;
  }
  return null;
}

// hull エッジの、船体の x/y/z 各軸方向から見た投影面積 [m²]。
function hullProjectedAreas(tree: VesselTree, edge: TreeEdge, frame: MountFrame): Vec3 {
  const sectionA = nodeById(tree, edge.a).section;
  const sectionB = nodeById(tree, edge.b).section;
  const along = (axis: Vec3): number =>
    loftProjectedArea(sectionA, sectionB, edge.length, toEdgeLocal(frame, axis));
  return v3(along(v3(1, 0, 0)), along(v3(0, 1, 0)), along(v3(0, 0, 1)));
}

// 一辺 sectionSize、長さ length の角柱の投影面積。§11-2 の直方体に対する厳密式そのもの。
function boxProjectedAreas(sectionSize: number, length: number, frame: MountFrame): Vec3 {
  const side = sectionSize * length;
  const cap = sectionSize * sectionSize;
  const along = (axis: Vec3): number => {
    const local = toEdgeLocal(frame, axis);
    return Math.abs(local.x) * side + Math.abs(local.y) * side + Math.abs(local.z) * cap;
  };
  return v3(along(v3(1, 0, 0)), along(v3(0, 1, 0)), along(v3(0, 0, 1)));
}

function toEdgeLocal(frame: MountFrame, axis: Vec3): Vec3 {
  return v3(dot(axis, frame.x), dot(axis, frame.y), dot(axis, frame.z));
}

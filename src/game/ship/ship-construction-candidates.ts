// 建造の取り付け先のガイド(接続面の中心・外向き・半径)を ECI 座標へ写す純関数と、
// 画面座標へ写した候補をポインタ位置へ当てるピックの純関数。
import { pickRadiusSq } from '../../input/pointer-precision';
import { qRotate, type Quat } from '../../math/quat';
import { add, scale, sub, v3, type Vec3 } from '../../math/vec3';
import {
  sideMountRadius, sideSlotDirection, type ModuleOrientation,
} from './ship-assembly-transform';
import {
  heldRootDefinition, jointEndsOf, placementFor,
  type ConstructionPlacementResult, type ConstructionTargetInfo,
} from './ship-construction-rules';
import type { ShipAssembly } from './ship-assembly';
import type {
  ConstructionHeld, ConstructionSymmetry, ConstructionTarget,
} from './ship-construction-types';

// 取り付け先のガイド(接続面の中心・外向き・半径)を ECI へ写したもの。
export interface ConstructionTargetGuide {
  readonly target: ConstructionTarget;
  readonly label: string;
  readonly placement: ConstructionPlacementResult;
  readonly guideEci: Vec3; // ECI [m]
  readonly normalEci: Vec3; // ECI 単位ベクトル
  readonly guideRadius: number; // m
}

// 取り付け先のガイドを ECI へ写す。position は重心の ECI 位置 [m]、rotation は船体から
// ECI への回転、centerOffset は船体内重心 [m]。親が無い・根の定義が無いときは null。
export function constructionTargetGuide(
  assembly: ShipAssembly, anchorId: string, held: ConstructionHeld,
  info: ConstructionTargetInfo, orientation: ModuleOrientation, symmetry: ConstructionSymmetry,
  position: Vec3, rotation: Quat, centerOffset: Vec3,
): ConstructionTargetGuide | null {
  const placement = placementFor(assembly, anchorId, held, info.target, orientation, symmetry);
  const rootDefinition = heldRootDefinition(assembly, held);
  if (rootDefinition === null) return null;
  // 接続面の中心と外向きを船体座標で求める。継ぎ目のガイドは起点側のモジュールの面。
  let guidePosition: Vec3;
  let guideNormal: Vec3;
  let parentDiameter: number;
  if (info.target.kind === 'joint') {
    const ends = jointEndsOf(assembly, anchorId, info.target.connectionId);
    if (ends === null) return null;
    const nearWorld = assembly.worldTransformOf(ends.nearId);
    const nearDefinition = assembly.definition(ends.nearId);
    if (nearWorld === null || nearDefinition === null) return null;
    const s = ends.nearFace === 'front' ? 1 : -1;
    guidePosition = add(nearWorld.position, qRotate(nearWorld.rotation, v3(0, 0, s * nearDefinition.length / 2)));
    guideNormal = qRotate(nearWorld.rotation, v3(0, 0, s));
    parentDiameter = nearDefinition.diameter;
  } else {
    const parentWorld = assembly.worldTransformOf(info.target.parentId);
    const parentDefinition = assembly.definition(info.target.parentId);
    if (parentWorld === null || parentDefinition === null) return null;
    if (info.target.kind === 'axial-face') {
      const s = info.target.face === 'front' ? 1 : -1;
      guidePosition = add(parentWorld.position, qRotate(parentWorld.rotation, v3(0, 0, s * parentDefinition.length / 2)));
      guideNormal = qRotate(parentWorld.rotation, v3(0, 0, s));
    } else {
      const direction = sideSlotDirection(info.target.slot);
      guidePosition = add(parentWorld.position, qRotate(parentWorld.rotation, scale(direction, sideMountRadius(parentDefinition))));
      guideNormal = qRotate(parentWorld.rotation, direction);
    }
    parentDiameter = parentDefinition.diameter;
  }
  const root = sub(position, qRotate(rotation, centerOffset));
  return {
    target: info.target, label: info.label, placement,
    guideEci: add(root, qRotate(rotation, guidePosition)),
    normalEci: qRotate(rotation, guideNormal),
    guideRadius: Math.min(parentDiameter, rootDefinition.diameter) / 2,
  };
}

// 取り付け先が属するモジュールの id。軸方向の面・側面スロットは親モジュールに、
// 継ぎ目は両側のモジュールに属する。
export function constructionTargetModuleIds(
  assembly: ShipAssembly, target: ConstructionTarget,
): readonly string[] {
  switch (target.kind) {
    case 'axial-face':
    case 'side-slot':
      return [target.parentId];
    case 'joint': {
      const edge = assembly.graph.find(connection => connection.id === target.connectionId);
      return edge === undefined ? [] : [edge.parentId, edge.childId];
    }
  }
}

// 画面へ写した取り付け先候補の1点。x/y はポインタと同じ画面座標 [px]。
export interface ConstructionTargetScreenPoint {
  readonly id: string;
  // この候補が属するモジュールの id。継ぎ目の候補は両側の2つを持つ。
  readonly moduleIds: readonly string[];
  readonly x: number;
  readonly y: number;
  // カメラの手前にあるか。視点の背後にある候補は指せない。
  readonly front: boolean;
}

// 接続ノードを指す・当てるときの画面距離の2乗 [px^2]。マップの被選択物ピックと同じ閾値。
export const CONSTRUCTION_TARGET_PICK_RADIUS_SQ = pickRadiusSq(600, 1936);

// point に最も近い候補の id を返す。距離の2乗が radiusSquared を超える候補と、
// カメラの手前に無い候補は対象外。半径内に候補が無ければ null。
export function pickConstructionTargetAtScreenPoint(
  targets: readonly ConstructionTargetScreenPoint[],
  point: { readonly x: number; readonly y: number },
  radiusSquared: number,
): string | null {
  let best: string | null = null;
  let bestSq = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    if (!target.front) continue;
    const dx = target.x - point.x;
    const dy = target.y - point.y;
    const distSq = dx * dx + dy * dy;
    if (distSq <= radiusSquared && distSq < bestSq) {
      best = target.id;
      bestSq = distSq;
    }
  }
  return best;
}

// point に最も近い取り付け先候補の id。まずノードの画面位置へ半径内で最も近い候補を
// 選び、半径内に無ければ hitModule() が返すモジュールに属する候補のうち最も近いものを
// 半径の制限なしに選ぶ(モジュールの面を指しても候補へ吸着させる)。カメラの手前に
// 無い候補は対象外。hitModule() は半径内に候補が無いときだけ呼ぶ。
export function pickConstructionTarget(
  targets: readonly ConstructionTargetScreenPoint[],
  point: { readonly x: number; readonly y: number },
  radiusSquared: number,
  hitModule: () => string | null,
): string | null {
  const near = pickConstructionTargetAtScreenPoint(targets, point, radiusSquared);
  if (near !== null) return near;
  const moduleId = hitModule();
  if (moduleId === null) return null;
  let best: string | null = null;
  let bestSq = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    if (!target.front || !target.moduleIds.includes(moduleId)) continue;
    const dx = target.x - point.x;
    const dy = target.y - point.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestSq) {
      best = target.id;
      bestSq = distSq;
    }
  }
  return best;
}

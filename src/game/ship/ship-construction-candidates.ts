// 建造の取り付け先のガイド(接続面の中心・外向き・半径)を ECI 座標へ写す。
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

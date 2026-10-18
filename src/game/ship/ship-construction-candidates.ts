// 建造候補の配置をECI座標へ写し、接続ガイドの円盤と視線の交差を判定する。
import { LOCAL_FORWARD, qMul, qRotate, type Quat } from '../../math/quat';
import { add, dot, scale, sub, v3, type Vec3 } from '../../math/vec3';
import {
  sideMountRadius, sideSlotDirection, type ModuleOrientation,
} from './ship-assembly-transform';
import {
  heldRootDefinition, jointEndsOf, placementFor, placementForSlot,
  type ConstructionPlacement, type ConstructionPlacementResult, type ConstructionSlot,
  type ConstructionTargetInfo,
} from './ship-construction-rules';
import type { Ray } from '../../math/ray';
import type { ShipAssembly, ModuleTransform } from './ship-assembly';
import type { ShipModuleDefinition } from './ship-module-definition';
import type {
  ConstructionHeld, ConstructionSymmetry, ConstructionTarget,
} from './ship-construction-types';

export interface ConstructionCandidate {
  readonly slot: ConstructionSlot;
  readonly placement: ConstructionPlacement;
  readonly centerEci: Vec3; // ECI [m]
  readonly rotationEci: ModuleTransform['rotation'];
  readonly guideEci: Vec3; // ECI [m]
  readonly guideRadius: number; // m
}

// 親が存在しない候補はnullを返す。positionは重心のECI位置[m]、rotationは船体からECIへの回転、centerOffsetは船体内重心[m]。
export function constructionCandidate(
  assembly: ShipAssembly, slot: ConstructionSlot, definition: ShipModuleDefinition,
  position: Vec3, rotation: Quat, centerOffset: Vec3,
): ConstructionCandidate | null {
  const placement = placementForSlot(assembly, slot, definition);
  const parentDefinition = assembly.definition(slot.parentId);
  const parentWorld = assembly.worldTransformOf(slot.parentId);
  if (parentDefinition === null || parentWorld === null) return null;
  // 親の配置から候補の船体内姿勢を求める。
  const assemblyPosition = add(parentWorld.position, qRotate(parentWorld.rotation, placement.transform.position));
  const assemblyRotation = qMul(parentWorld.rotation, placement.transform.rotation);
  const root = sub(
    position,
    qRotate(rotation, centerOffset),
  );
  const centerEci = add(root, qRotate(rotation, assemblyPosition));
  const rotationEci = qMul(rotation, assemblyRotation);
  // 接続面の中心と向きをECIへ写す。
  const parentCenter = add(root, qRotate(rotation, parentWorld.position));
  const guideDirection = qRotate(qMul(rotation, parentWorld.rotation), slot.direction);
  const guideDistance = slot.kind === 'side' ? sideMountRadius(parentDefinition) : parentDefinition.length / 2;
  return {
    slot, placement, centerEci, rotationEci,
    guideEci: add(parentCenter, scale(guideDirection, guideDistance)),
    guideRadius: Math.min(parentDefinition.diameter, definition.diameter) / 2,
  };
}

// 新しい取り付け先のガイド(接続面の中心・外向き・半径)を ECI へ写したもの。
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

// 前方のガイド円盤に当たるかを返す。選択済みなら表示と同じ半径倍率を適用する。
export function hitsConstructionCandidate(ray: Ray, candidate: ConstructionCandidate, selected: boolean): boolean {
  const normal = qRotate(candidate.rotationEci, LOCAL_FORWARD);
  const denominator = dot(ray.dir, normal);
  if (Math.abs(denominator) < 1e-9) return false;
  const distance = dot(sub(candidate.guideEci, ray.origin), normal) / denominator;
  if (distance < 0) return false;
  // 円盤の平面上で、接続面中心からの距離を判定する。
  const hit = add(ray.origin, scale(ray.dir, distance));
  const offset = sub(hit, candidate.guideEci);
  const radialSq = dot(offset, offset) - dot(offset, normal) ** 2;
  const guideRadius = candidate.guideRadius * (selected ? 1.15 : 1);
  return radialSq <= guideRadius ** 2;
}

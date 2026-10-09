// 建造候補の配置をECI座標へ写し、接続ガイドの円盤と視線の交差を判定する。
import { LOCAL_FORWARD, qMul, qRotate, type Quat } from '../../math/quat';
import { add, dot, scale, sub, type Vec3 } from '../../math/vec3';
import { sideMountRadius } from './ship-assembly-transform';
import { placementForSlot, type ConstructionSlot, type ConstructionPlacement } from './ship-construction-rules';
import type { Ray } from '../../math/ray';
import type { ShipAssembly, ModuleTransform } from './ship-assembly';
import type { ShipModuleDefinition } from './ship-module-definition';

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

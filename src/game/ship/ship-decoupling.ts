// デカプラー位置で船体を分割し、質量比に応じた分離速度を求める。
import { LOCAL_FORWARD, qRotate } from '../../math/quat';
import { addScaled, type Vec3 } from '../../math/vec3';
import type { ModuleTransform, ShipAssembly } from './ship-assembly';
import { shipPhysicsShape } from './ship-physics-shape';

export const SHIP_DECOUPLING_SPEED = 8;
export const SHIP_DECOUPLING_COLLISION_GRACE = 0.5;

export interface ShipDecouplingSplit {
  readonly retained: ShipAssembly;
  readonly detached: ShipAssembly;
  readonly separationAxis: Vec3;
  readonly detachedRoot: ModuleTransform;
  readonly decouplerTransform: ModuleTransform;
}

// decoupler の外向き edge を切り、親側と子側を排他的な二つの assembly へ分ける。
export function splitAtDecoupler(assembly: ShipAssembly, decouplerId: string): ShipDecouplingSplit {
  const module = assembly.module(decouplerId);
  if (module?.kind !== 'decoupler') throw new Error(`not a decoupler module: ${decouplerId}`);
  if (module.hp <= 0) throw new Error(`decoupler is destroyed: ${decouplerId}`);
  const incoming = assembly.graph.filter(edge => edge.childId === decouplerId);
  const outgoing = assembly.graph.filter(edge => edge.parentId === decouplerId);
  if (incoming.length !== 1 || outgoing.length !== 1) {
    throw new Error(`decoupler must connect exactly two branches: ${decouplerId}`);
  }
  const outgoingEdge = outgoing[0];
  if (outgoingEdge === undefined) throw new Error(`missing decoupler branch: ${decouplerId}`);
  const transform = assembly.worldTransformOf(decouplerId);
  const detachedRoot = assembly.worldTransformOf(outgoingEdge.childId);
  if (transform === null) throw new Error(`missing decoupler transform: ${decouplerId}`);
  if (detachedRoot === null) throw new Error(`missing detached root transform: ${decouplerId}`);
  const working = assembly.clone();
  const [retained, detached] = working.splitAt(outgoingEdge.id);
  // 火工品は作動時に消費する。split 後は親側の葉なので安全に除去できる。
  retained.removeModule(decouplerId);
  return {
    retained, detached, separationAxis: qRotate(transform.rotation, LOCAL_FORWARD),
    detachedRoot, decouplerTransform: transform,
  };
}

// 共通速度から指定相対速度で離れる二体の速度。並進運動量を保存する。
export function separationImpulseVelocities(
  retainedVelocity: Vec3, detachedVelocity: Vec3, separationAxis: Vec3,
  retainedMass: number, detachedMass: number, relativeSpeed = SHIP_DECOUPLING_SPEED,
): { readonly retained: Vec3; readonly detached: Vec3 } {
  const totalMass = retainedMass + detachedMass;
  if (!(totalMass > 0) || !(relativeSpeed > 0)) {
    return { retained: { ...retainedVelocity }, detached: { ...detachedVelocity } };
  }
  return {
    retained: addScaled(retainedVelocity, separationAxis, -relativeSpeed * detachedMass / totalMass),
    detached: addScaled(detachedVelocity, separationAxis, relativeSpeed * retainedMass / totalMass),
  };
}

// 分割後の二 assembly から、資源を含む現在質量を返す。
export function decoupledMasses(split: ShipDecouplingSplit): { readonly retained: number; readonly detached: number } {
  const retained = shipPhysicsShape(split.retained);
  const detached = shipPhysicsShape(split.detached);
  if (retained === null || detached === null) throw new Error('decoupling produced an empty assembly');
  return { retained: retained.mass.totalMass, detached: detached.mass.totalMass };
}

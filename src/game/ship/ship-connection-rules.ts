// 接舷・分離・修理の可否判定と、その物理量の純粋な規則。
// 命令の適用は modular-ship-connection-operations が担う。
import { LOCAL_FORWARD, qMul, qRotate, type Quat } from '../../math/quat';
import { add, addScaled, dot, len, norm, scale, sub, type Vec3 } from '../../math/vec3';
import { pointVelocityAt } from '../../physics/attitude';
import type { ModularShip } from './modular-ship';
import { isDockingModule, type ModuleTransform, type ShipAssembly } from './ship-assembly';
import { applyTransformToDirection } from './ship-assembly-transform';
import { shipPhysicsShape } from './ship-physics-shape';

// 接舷部の world pose と、距離・向き・相対速度に基づく接舷可否を求める。

const DOCKING_MAX_DISTANCE = 3;
const DOCKING_MAX_ANGLE = 10 * Math.PI / 180;
const DOCKING_MAX_RELATIVE_SPEED = 1;

interface DockingPortPose {
  readonly point: Vec3;
  readonly axis: Vec3;
  readonly velocity: Vec3;
  readonly rotation: Quat;
}

interface DockingEligibility {
  readonly eligible: boolean;
  readonly distance: number;
  readonly angle: number;
  readonly relativeSpeed: number;
  readonly reasons: readonly string[];
}

/** module の外向き +Z 端面を world space の接舷点へ展開する。 */
function dockingPortPose(ship: ModularShip, moduleId: string): DockingPortPose | null {
  const module = ship.assembly.module(moduleId);
  const definition = ship.assembly.definition(moduleId);
  const transform = ship.assembly.worldTransformOf(moduleId);
  if (module === null || definition === null || transform === null || !isDockingModule(module)) return null;
  const rotation = qMul(ship.motion.att.q, transform.rotation);
  const axis = norm(qRotate(rotation, LOCAL_FORWARD));
  const center = ship.motion.assemblyToEci(transform.position);
  const point = add(center, scale(axis, definition.length / 2));
  const angularVelocity = qRotate(ship.motion.att.q, ship.motion.att.w);
  const velocity = pointVelocityAt(ship.motion.state.v, angularVelocity, sub(point, ship.motion.state.r));
  return { point, axis, velocity, rotation };
}

// 二つの接舷部を距離・正対角・接続点相対速度・能力条件で評価する。
export function dockingEligibility(
  first: ModularShip, firstPortId: string, second: ModularShip, secondPortId: string,
): DockingEligibility {
  const firstPort = first.assembly.module(firstPortId);
  const secondPort = second.assembly.module(secondPortId);
  const firstPose = dockingPortPose(first, firstPortId);
  const secondPose = dockingPortPose(second, secondPortId);
  const reasons: string[] = [];
  if (first === second) reasons.push('同じ船体には接舷できません');
  if (!first.motion.alive || !second.motion.alive) reasons.push('生存中の船体だけが接舷できます');
  if (!first.assembly.playerOwned || !second.assembly.playerOwned) reasons.push('player 所属の船体だけが接舷できます');
  if (firstPose === null || secondPose === null) reasons.push('接舷部ではありません');
  if ((firstPort !== null && firstPort.hp <= 0) || (secondPort !== null && secondPort.hp <= 0)) {
    reasons.push('接舷部が全損しています');
  }
  if (first.assembly.isPortConnected(firstPortId)
    || second.assembly.isPortConnected(secondPortId)) reasons.push('接舷部は使用中です');
  if (first.capabilities.modules('cockpit', true).length === 0
    && second.capabilities.modules('cockpit', true).length === 0) reasons.push('健全なコックピットがありません');
  const distance = firstPose && secondPose ? len(sub(firstPose.point, secondPose.point)) : Infinity;
  const facing = firstPose && secondPose ? Math.max(-1, Math.min(1, -dot(firstPose.axis, secondPose.axis))) : -1;
  const angle = Math.acos(facing);
  const relativeSpeed = firstPose && secondPose ? len(sub(firstPose.velocity, secondPose.velocity)) : Infinity;
  if (distance > DOCKING_MAX_DISTANCE) reasons.push('接舷部までの距離が遠すぎます');
  if (angle > DOCKING_MAX_ANGLE) reasons.push('接舷部の向きが合っていません');
  if (relativeSpeed > DOCKING_MAX_RELATIVE_SPEED) reasons.push('相対速度が大きすぎます');
  return { eligible: reasons.length === 0, distance, angle, relativeSpeed, reasons };
}

// デカプラー位置で船体を分割し、質量比に応じた分離速度を求める。

const SHIP_DECOUPLING_SPEED = 8;
export const SHIP_DECOUPLING_COLLISION_GRACE = 0.5;

interface ShipDecouplingSplit {
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
    retained, detached, separationAxis: applyTransformToDirection(transform, LOCAL_FORWARD),
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

// 接舷済み船体を、指定接舷部から一括修理する。

/** 健全かつ接続済みの dock から、統合船体の全 module HP を即時回復する。 */
export function repairDockedAssembly(assembly: ShipAssembly, dockId: string): number {
  const dock = assembly.module(dockId);
  if (dock?.kind !== 'dock') {
    throw new Error(`not a docking module: ${dockId}`);
  }
  if (dock.hp <= 0) throw new Error(`docking module is destroyed: ${dockId}`);
  if (!assembly.isDockingPortOccupied(dockId)) throw new Error(`docking module is not connected: ${dockId}`);
  let repaired = 0;
  for (const module of assembly.modules) {
    const definition = assembly.definition(module.id);
    if (definition === null) throw new Error(`missing ship module definition: ${module.id}`);
    const maxHp = definition.maxHp;
    repaired += Math.max(0, maxHp - module.hp);
    assembly.setHp(module.id, maxHp);
  }
  return repaired;
}


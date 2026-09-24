// 接舷部の world pose と、距離・向き・相対速度に基づく接舷可否を求める。
import { LOCAL_FORWARD, qMul, qRotate, type Quat } from '../../math/quat';
import { add, cross, dot, len, norm, scale, sub, type Vec3 } from '../../math/vec3';
import type { ModularShip } from './modular-ship';
import { isDockingModule } from './ship-assembly';

export const DOCKING_MAX_DISTANCE = 3;
export const DOCKING_MAX_ANGLE = 10 * Math.PI / 180;
export const DOCKING_MAX_RELATIVE_SPEED = 1;

export interface DockingPortPose {
  readonly point: Vec3;
  readonly axis: Vec3;
  readonly velocity: Vec3;
  readonly rotation: Quat;
}

export interface DockingEligibility {
  readonly eligible: boolean;
  readonly distance: number;
  readonly angle: number;
  readonly relativeSpeed: number;
  readonly reasons: readonly string[];
}

/** module の外向き +Z 端面を world space の接舷点へ展開する。 */
export function dockingPortPose(ship: ModularShip, moduleId: string): DockingPortPose | null {
  const module = ship.assembly.module(moduleId);
  const definition = ship.assembly.definition(moduleId);
  const transform = ship.assembly.worldTransformOf(moduleId);
  if (module === null || definition === null || transform === null || !isDockingModule(module)) return null;
  const root = sub(ship.motion.state.r, qRotate(ship.motion.att.q, ship.motion.centerOffset));
  const rotation = qMul(ship.motion.att.q, transform.rotation);
  const axis = norm(qRotate(rotation, LOCAL_FORWARD));
  const center = add(root, qRotate(ship.motion.att.q, transform.position));
  const point = add(center, scale(axis, definition.length / 2));
  const angularVelocity = qRotate(ship.motion.att.q, ship.motion.att.w);
  const velocity = add(ship.motion.state.v, cross(angularVelocity, sub(point, ship.motion.state.r)));
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

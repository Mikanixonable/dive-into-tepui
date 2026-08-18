// 設計から姿勢制御アクチュエータ一式を導く。RCSスラスタの取付位置と噴射方向は形状ツリーの
// 取付座標系から取るので、トラスの先に付けたスラスタは重心から遠いぶん大きなトルクを出す。
import type { ActuatorSet, ThrusterSpec } from '../../physics/attitude-control';
import { thrusterSpec } from '../../physics/attitude-control';
import { Vec3, scale, sub } from '../../physics/vec3';
import type { AnyPart } from '../game-entity/parts';
import type { VesselAssembly } from './assembly';
import { mountFrame } from './tree';

// 形状を持つ設計のアクチュエータ集合。centerOfMass は機体ローカル座標の重心で、スラスタの
// 位置はそこから測る — トルクの腕の長さは重心からの距離だからである。破壊された要素は数えない。
export function actuatorSetOf(assembly: VesselAssembly | null, parts: readonly AnyPart[], centerOfMass: Vec3): ActuatorSet {
  return {
    thrusters: assembly ? thrustersOf(assembly, centerOfMass) : [],
    wheel: wheelOf(parts),
    magnetorquer: magnetorquerOf(parts),
  };
}

// 外装として取り付けられた RCS スラスタを、取付座標系から位置と噴射方向へ解く。取付座標系の
// z は外向きの法線であり、ノズルはそちらへ噴くので、機体が受ける力はその逆を向く。
function thrustersOf(assembly: VesselAssembly, centerOfMass: Vec3): readonly ThrusterSpec[] {
  const out: ThrusterSpec[] = [];
  for (const placement of assembly.placements) {
    if (placement.kind !== 'external' || placement.part.type !== 'rcs_thruster') continue;
    if (placement.part.hp <= 0) continue;
    const frame = mountFrame(assembly.tree, placement.mount);
    out.push(thrusterSpec(sub(frame.origin, centerOfMass), scale(frame.z, -1), placement.part.thrust));
  }
  return out;
}

// 健全なフライホイールの合成。1基も積んでいなければ null。
function wheelOf(parts: readonly AnyPart[]): ActuatorSet['wheel'] {
  let maxTorque = 0;
  let maxAngularMomentum = 0;
  let powerDraw = 0;
  let found = false;
  for (const part of parts) {
    if (part.type !== 'flywheel' || part.hp <= 0) continue;
    found = true;
    maxTorque += part.maxTorque;
    maxAngularMomentum += part.maxAngularMomentum;
    powerDraw += part.powerDraw;
  }
  return found ? { maxTorque, maxAngularMomentum, powerDraw } : null;
}

// 健全な磁気トルカの合成。1基も積んでいなければ null。
function magnetorquerOf(parts: readonly AnyPart[]): ActuatorSet['magnetorquer'] {
  let maxMagneticMoment = 0;
  let powerDraw = 0;
  let found = false;
  for (const part of parts) {
    if (part.type !== 'magnetorquer' || part.hp <= 0) continue;
    found = true;
    maxMagneticMoment += part.maxMagneticMoment;
    powerDraw += part.powerDraw;
  }
  return found ? { maxMagneticMoment, powerDraw } : null;
}

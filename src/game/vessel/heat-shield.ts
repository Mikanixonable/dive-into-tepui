// 熱シールドが与える熱防御(§11-3)。加熱率と動圧の閾値は搭載した熱シールドから決まり、
// 遮蔽する立体角の内側から流れが来ているあいだだけ効く — 向きを外せば守られない。
import { Vec3, dot, norm } from '../../physics/vec3';
import type { HeatShieldPart } from '../game-entity/parts';
import * as C from '../const';
import type { PartPlacement } from './assembly';
import type { VesselTree } from './tree';
import { mountFrame } from './tree';

// 機体がいま受けている熱防御。何も積んでいない機体は遮蔽 0 で、素の閾値をそのまま持つ。
export interface HeatShielding {
  // 遮蔽される入熱の割合 [0,1]。残りが外殻へ入る。
  readonly shielded: number;
  // 耐えられる外殻温度 [K]。
  readonly tempLimit: number;
  // 耐えられる動圧 [Pa]。
  readonly dynPressureLimit: number;
}

export const UNSHIELDED: HeatShielding = {
  shielded: 0,
  tempLimit: C.MAX_HULL_TEMP,
  dynPressureLimit: C.MAX_DYN_PRESSURE,
};

// 立体角 Ω [sr] の円錐の半頂角 [rad]。Ω = 2π(1 − cosθ)。
export function shieldHalfAngle(solidAngle: number): number {
  const cos = 1 - solidAngle / (2 * Math.PI);
  return Math.acos(Math.max(-1, Math.min(1, cos)));
}

// 機体座標系で flowDir から流れが当たっているときの熱防御。flowDir は機体から見た対気速度の向きで、
// 熱シールドはその逆向き(流れの来る側)を向いていなければ効かない。アブレータが尽きたシールドは
// 機能を失い、遮蔽 0 として扱う。
export function heatShielding(
  tree: VesselTree,
  placements: readonly PartPlacement[],
  flowDir: Vec3,
): HeatShielding {
  const flow = norm(flowDir);
  if (!(dot(flow, flow) > 0.5)) return UNSHIELDED;
  let shielded = 0;
  for (const placement of placements) {
    if (placement.kind !== 'external' || placement.part.type !== 'heat_shield') continue;
    const shield = placement.part as HeatShieldPart;
    if (shield.hp <= 0 || shield.ablatorMass <= 0 || shield.solidAngle <= 0) continue;
    // 取り付け口の外向きが、そのシールドが守る向きである。
    const facing = mountFrame(tree, placement.mount).z;
    // 対気速度の向きへ突っ込んでいくのだから、流れが当たるのは flow を向いた面である。
    // 守る向きと対気速度のなす角が半頂角の内側なら、この流れは遮蔽されている。
    if (Math.acos(Math.max(-1, Math.min(1, dot(facing, flow)))) > shieldHalfAngle(shield.solidAngle)) continue;
    shielded = Math.max(shielded, Math.min(1, shield.solidAngle / C.HEAT_SHIELD_FULL_SOLID_ANGLE));
  }
  if (shielded <= 0) return UNSHIELDED;
  return {
    shielded,
    tempLimit: C.MAX_HULL_TEMP * (1 + shielded * (C.HEAT_SHIELD_TEMP_MULT - 1)),
    dynPressureLimit: C.MAX_DYN_PRESSURE * (1 + shielded * (C.HEAT_SHIELD_DYN_PRESSURE_MULT - 1)),
  };
}

// 遮蔽した入熱 [J] のぶんアブレータを削る。尽きたシールドは以後 heatShielding が数えない。
export function ablate(placements: readonly PartPlacement[], shieldedHeat: number): void {
  if (!(shieldedHeat > 0)) return;
  for (const placement of placements) {
    if (placement.kind !== 'external' || placement.part.type !== 'heat_shield') continue;
    const shield = placement.part as HeatShieldPart;
    if (shield.ablatorMass <= 0) continue;
    shield.ablatorMass = Math.max(0, shield.ablatorMass - shieldedHeat * shield.ablationPerHeat);
  }
}

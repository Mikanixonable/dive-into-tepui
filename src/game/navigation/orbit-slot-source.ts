// 「この軌道から軌道標識を作る」の記述を組む。艦・敵・基地・公転線の接触軌道要素、
// ガイド線の族メンバー、配置フォームのハロー/リサジュー指定から、台帳へ入れる
// 参照軌道の記述(orbit-slot.ts の OrbitSlotOrbit)を作る。
import {
  type OrbitalElements, meanMotionFromSemiMajor, timeSincePeriapsis,
} from '../../physics/elements';
import { cross, dot, norm, v3 } from '../../math/vec3';
import type { CollinearPoint } from '../../physics/lagrange';
import type { OrbitSlotFamilyOrbit, OrbitSlotOrbit } from './orbit-slot';

const DEG = Math.PI / 180;

// 接触軌道要素 el を標識の軌道要素記述へ写す。位相点は位相の基準(phaseRef)が指す
// 対象の現在位相に揃える。位相の基準を持たない(形だけの)要素・閉じない軌道では null。
export function orbitSlotFromContactElements(el: OrbitalElements): OrbitSlotOrbit | null {
  const phaseRef = el.phaseRef;
  if (phaseRef === null || !(el.e < 1)) return null;

  // 軌道面基底から昇交点赤経・近点引数を戻す。赤道面に一致する軌道では昇交点が
  // 定まらないので raan=0・昇交点=+X の規約に畳む(orbitPlaneBasis と同じ規約)。
  const Y = v3(0, 1, 0);
  const nodeCross = cross(Y, el.hHat);
  const node = norm(nodeCross);
  const hasNode = dot(nodeCross, nodeCross) > 1e-12;
  const raan = hasNode ? Math.atan2(-node.z, node.x) : 0;
  const argPeriapsis = hasNode
    ? Math.atan2(dot(cross(node, el.pHat), el.hHat), dot(node, el.pHat))
    : Math.atan2(-el.pHat.z, el.pHat.x);

  const meanAnomaly0 = meanMotionFromSemiMajor(el.a, el.center.def.mu)
    * timeSincePeriapsis(el, phaseRef.nu);
  return {
    kind: 'elements', bodyId: el.center.id, epoch: phaseRef.t,
    a: el.a, e: el.e, i: el.incDeg * DEG, raan, argPeriapsis, meanAnomaly0,
  };
}

// カタログの族メンバー(系・族 id・族内位置 s)を標識の記述へ写す。phase0 は位相点の
// 周期に対する経過割合。
export function orbitSlotFromCatalogMember(
  primaryId: string, secondaryId: string, familyId: string, s: number, phase0 = 0,
): OrbitSlotFamilyOrbit {
  return {
    kind: 'family', primaryId, secondaryId,
    familyDescriptor: { kind: 'catalog', familyId, s }, phase0,
  };
}

// 共線点まわりのハロー軌道(系・点・面外振幅 az [m])を標識の記述へ写す。
export function orbitSlotFromHalo(
  primaryId: string, secondaryId: string, point: CollinearPoint, az: number, phase0 = 0,
): OrbitSlotFamilyOrbit {
  return {
    kind: 'family', primaryId, secondaryId,
    familyDescriptor: { kind: 'halo', point, az }, phase0,
  };
}

// 共線点まわりのリサジュー軌道(系・点・面内振幅 ax・面外振幅 az [m]・面外位相 psi [rad])
// を標識の記述へ写す。
export function orbitSlotFromLissajous(
  primaryId: string, secondaryId: string, point: CollinearPoint,
  ax: number, az: number, psi: number, phase0 = 0,
): OrbitSlotFamilyOrbit {
  return {
    kind: 'family', primaryId, secondaryId,
    familyDescriptor: { kind: 'lissajous', point, ax, az, psi }, phase0,
  };
}

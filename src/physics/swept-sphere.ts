import { Vec3, v3 } from './vec3';

export interface SweptSphereHit {
  readonly toi: number; // frame区間内の衝突割合 0..1
  readonly normal: Vec3; // aからbへ向く接触法線
}

// 2球の中心がそれぞれ start→end を線形移動するとみなし、最初に表面が触れる時刻を返す。
// 開始時点で既にoverlapしている場合は離散overlap solverへ委譲するため null。
export function sweptSphereToi(
  aStart: Vec3,
  aEnd: Vec3,
  bStart: Vec3,
  bEnd: Vec3,
  radiusSum: number,
): SweptSphereHit | null {
  const px = bStart.x - aStart.x;
  const py = bStart.y - aStart.y;
  const pz = bStart.z - aStart.z;
  const dx = (bEnd.x - bStart.x) - (aEnd.x - aStart.x);
  const dy = (bEnd.y - bStart.y) - (aEnd.y - aStart.y);
  const dz = (bEnd.z - bStart.z) - (aEnd.z - aStart.z);
  const c = px * px + py * py + pz * pz - radiusSum * radiusSum;
  if (!(c > 0)) return null;
  const aa = dx * dx + dy * dy + dz * dz;
  if (!(aa > 1e-18)) return null;
  const bb = 2 * (px * dx + py * dy + pz * dz);
  const discriminant = bb * bb - 4 * aa * c;
  if (!(discriminant >= 0)) return null;
  const toi = (-bb - Math.sqrt(discriminant)) / (2 * aa);
  if (!(toi >= 0 && toi <= 1)) return null;
  const nx0 = px + dx * toi;
  const ny0 = py + dy * toi;
  const nz0 = pz + dz * toi;
  const nLen = Math.sqrt(nx0 * nx0 + ny0 * ny0 + nz0 * nz0);
  if (!(nLen > 1e-12)) return null;
  return { toi, normal: v3(nx0 / nLen, ny0 / nLen, nz0 / nLen) };
}

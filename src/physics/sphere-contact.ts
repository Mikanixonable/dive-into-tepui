// 球どうしの接触の幾何(掃引接触の時刻・法線、点が球の内側にあるかの判定)。
// 重力源かどうか・天体かどうかには関与しない純粋な幾何。
import { KinematicState } from './kinematic-state';
import { Vec3, len, sub, v3 } from './vec3';

export interface SphereContact {
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
): SphereContact | null {
  // 相対位置 p(t) = p0 + d·t (t∈[0,1]) が半径和 radiusSum の球に触れる最小の t を解く2次方程式。
  // 各早期returnは `!(x > 0)` 系の否定形で書く — NaN はどの比較でも false になるので、
  // 非有限な入力はこの形のときだけ自動的に null へ落ちる(`x <= 0` に書き換えると通り抜ける)。
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
  // 接触時刻における相対位置がそのまま接触法線の向きになる。
  const nx0 = px + dx * toi;
  const ny0 = py + dy * toi;
  const nz0 = pz + dz * toi;
  const nLen = Math.sqrt(nx0 * nx0 + ny0 * ny0 + nz0 * nz0);
  if (!(nLen > 1e-12)) return null;
  return { toi, normal: v3(nx0 / nLen, ny0 / nLen, nz0 / nLen) };
}

// point が bodies のいずれかの半径 + margin の球の内側にあれば、その球を返す。無ければ null。
export function containingBody<T extends { readonly radius: number; readonly state: KinematicState }>(
  point: Vec3,
  bodies: readonly T[],
  margin: number,
): T | null {
  for (const body of bodies) {
    if (len(sub(point, body.state.r)) < body.radius + margin) return body;
  }
  return null;
}
